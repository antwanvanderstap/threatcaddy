/**
 * Outbound HTTP transport shared by anything that talks to a third-party API.
 *
 * The SPA cannot reach most vendor APIs directly — CORS and CSP both stop it —
 * so requests go through the team server proxy (which can resolve DNS and so
 * catch rebinding) or the extension background script. Keeping one
 * implementation means the SSRF guard cannot be bypassed by adding a second
 * caller that forgets it.
 */

import { nanoid } from 'nanoid';
import { postMessageOrigin } from './utils';

export interface ProxyResponse {
  ok: boolean;
  status: number;
  statusText: string;
  data: unknown;
  headers: Record<string, string>;
}

export interface ServerProxyConfig {
  serverUrl: string;
  getAccessToken: () => Promise<string | null>;
}

/**
 * Reject non-HTTP schemes and obvious internal targets.
 *
 * Limitation: this is a client-side check on the literal hostname string.
 * It cannot perform DNS resolution, so a public hostname that resolves to
 * a private IP (DNS rebinding) will bypass this filter. When a team server
 * is available, callers should route requests through `POST /api/proxy-fetch`
 * which can enforce server-side DNS checks.
 */
export function validateHttpUrl(urlStr: string): URL {
  const url = new URL(urlStr);
  if (!['http:', 'https:'].includes(url.protocol)) {
    throw new Error(`Blocked URL scheme: ${url.protocol} — only HTTP/HTTPS allowed`);
  }
  const host = url.hostname;
  if (
    ['169.254.169.254', 'localhost', '127.0.0.1', '::1', '0.0.0.0'].includes(host) ||
    host === '::ffff:127.0.0.1' ||
    /^10\./.test(host) ||
    /^172\.(1[6-9]|2\d|3[01])\./.test(host) ||
    /^192\.168\./.test(host) ||
    host.endsWith('.local') ||
    host.endsWith('.internal')
  ) {
    throw new Error(`Blocked request to private/internal address: ${host}`);
  }
  return url;
}

/**
 * Proxy fetch via the team server (`POST /api/proxy-fetch`).
 * The server can perform DNS resolution to block private IPs.
 */
export async function serverProxyFetch(
  serverUrl: string,
  getAccessToken: () => Promise<string | null>,
  url: string,
  method: string,
  headers: Record<string, string>,
  body: string | null,
): Promise<ProxyResponse> {
  const token = await getAccessToken();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 60_000);
  const resp = await fetch(`${serverUrl}/api/proxy-fetch`, {
    method: 'POST',
    signal: controller.signal,
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: JSON.stringify({ url, method, headers, body }),
  });
  clearTimeout(timer);
  const result = await resp.json();
  if (!resp.ok) {
    throw new Error(result.error || `Server proxy error: ${resp.status}`);
  }
  return {
    ok: result.status >= 200 && result.status < 300,
    status: result.status,
    statusText: result.statusText || '',
    data: result.data,
    headers: result.headers || {},
  };
}

/**
 * Proxy fetch via the extension bridge (postMessage → bridge.js → background.js).
 * Returns a Response-like object. Used to bypass CSP/CORS in extension context.
 */
export function bridgeProxyFetch(
  url: string,
  method: string,
  headers: Record<string, string>,
  body: string | null,
  timeoutMs = 30_000,
): Promise<ProxyResponse> {
  return new Promise((resolve, reject) => {
    const requestId = nanoid();
    const timeout = setTimeout(() => {
      window.removeEventListener('message', handler);
      reject(new Error(`Bridge proxy fetch timed out (${Math.round(timeoutMs / 1000)}s)`));
    }, timeoutMs);

    function handler(event: MessageEvent) {
      if (event.source !== window || !event.data) return;
      if (event.data.type !== 'TC_PROXY_FETCH_RESULT') return;
      if (event.data.requestId !== requestId) return;
      window.removeEventListener('message', handler);
      clearTimeout(timeout);

      if (!event.data.success && event.data.error) {
        reject(new Error(event.data.error));
      } else {
        resolve({
          ok: event.data.status >= 200 && event.data.status < 300,
          status: event.data.status,
          statusText: event.data.statusText || '',
          data: event.data.data,
          headers: event.data.headers || {},
        });
      }
    }

    window.addEventListener('message', handler);
    window.postMessage({
      type: 'TC_PROXY_FETCH',
      requestId,
      url,
      method,
      headers,
      body,
    }, postMessageOrigin());
  });
}

/** Check if the extension bridge supports proxy_fetch. */
export function hasBridgeProxyFetch(): boolean {
  try {
    const caps = document.documentElement.dataset.tcBridgeCaps || '';
    return caps.split(',').includes('proxy_fetch');
  } catch {
    return false;
  }
}

/**
 * Push the set of hosts the extension is allowed to proxy to.
 *
 * The background script enforces this allowlist, so a host missing here is
 * refused even though the request is legitimate — every feature that proxies
 * must contribute its domains.
 */
export function setProxyAllowedDomains(domains: Iterable<string>): void {
  try {
    window.postMessage({ type: 'TC_SET_PROXY_DOMAINS', domains: [...new Set(domains)] }, postMessageOrigin());
  } catch { /* extension not present */ }
}

/**
 * Make a proxied request, preferring the server (which can defeat DNS
 * rebinding) and falling back to the extension bridge.
 *
 * Throws when neither transport is available rather than attempting a direct
 * fetch: a direct call would be blocked by CORS anyway, and reporting "no
 * transport" is more useful than a browser-level network error.
 */
export async function proxyFetch(
  url: string,
  method: string,
  headers: Record<string, string>,
  body: string | null,
  opts: { server?: ServerProxyConfig; timeoutMs?: number } = {},
): Promise<ProxyResponse> {
  validateHttpUrl(url);

  if (opts.server) {
    return serverProxyFetch(
      opts.server.serverUrl,
      opts.server.getAccessToken,
      url, method, headers, body,
    );
  }
  if (hasBridgeProxyFetch()) {
    return bridgeProxyFetch(url, method, headers, body, opts.timeoutMs);
  }
  throw new Error(
    'No proxy transport available. Install the ThreatCaddy extension or connect a team server to reach external APIs.',
  );
}
