/**
 * ConnectWise Manage transport.
 *
 * Owns paging and error shaping only; every field mapping lives in
 * `connectwise.ts` so it stays testable without a network.
 */

import { proxyFetch, type ServerProxyConfig } from './proxy-fetch';
import {
  connectWiseUrl,
  connectWiseAuthHeaders,
  CW_MAX_PAGE_SIZE,
  type ConnectWiseCredentials,
  type CWQuery,
  type CWConfiguration,
  type CWTicket,
  type CWCompany,
} from './connectwise';

export interface ConnectWiseRequestOptions {
  server?: ServerProxyConfig;
  signal?: AbortSignal;
}

/** An error carrying the HTTP status, so callers can tell auth from outage. */
export class ConnectWiseError extends Error {
  readonly status?: number;

  constructor(message: string, status?: number) {
    super(message);
    this.name = 'ConnectWiseError';
    this.status = status;
  }
}

/**
 * Turn a CW failure into something an analyst can act on.
 *
 * CW returns the same opaque 401 for a wrong private key, an expired API
 * member, and a missing clientId, so the message names all three rather than
 * pretending to know which.
 */
function describeFailure(status: number, body: unknown): ConnectWiseError {
  const detail =
    typeof body === 'object' && body !== null && 'message' in body
      ? String((body as { message: unknown }).message)
      : '';

  if (status === 401) {
    return new ConnectWiseError(
      `ConnectWise rejected the credentials (401). Check the public/private key pair, the company id, and that the API member is still enabled.${detail ? ` — ${detail}` : ''}`,
      status,
    );
  }
  if (status === 403) {
    return new ConnectWiseError(
      `ConnectWise refused the request (403). The API member is authenticated but lacks permission for this endpoint.${detail ? ` — ${detail}` : ''}`,
      status,
    );
  }
  if (status === 404) {
    return new ConnectWiseError(
      `ConnectWise endpoint not found (404). Check the site host is right for your region.${detail ? ` — ${detail}` : ''}`,
      status,
    );
  }
  return new ConnectWiseError(
    `ConnectWise request failed (${status})${detail ? `: ${detail}` : ''}`,
    status,
  );
}

/** One authenticated GET against the CW API. */
async function cwGet<T>(
  creds: ConnectWiseCredentials,
  path: string,
  query: CWQuery,
  opts: ConnectWiseRequestOptions,
): Promise<T> {
  const url = connectWiseUrl(creds.site, path, query);
  const resp = await proxyFetch(url, 'GET', connectWiseAuthHeaders(creds), null, {
    server: opts.server,
  });
  if (!resp.ok) throw describeFailure(resp.status, resp.data);

  // A proxy that hands back a JSON string rather than a parsed body is still a
  // success; parse it here so callers never see two shapes.
  if (typeof resp.data === 'string') {
    try {
      return JSON.parse(resp.data) as T;
    } catch {
      throw new ConnectWiseError('ConnectWise returned a response that was not JSON.');
    }
  }
  return resp.data as T;
}

export interface PagedFetchOptions extends ConnectWiseRequestOptions {
  pageSize?: number;
  /**
   * Hard ceiling on pages. A misconfigured condition can select a six-figure
   * row count, and an unbounded loop would hammer the PSA and the browser.
   */
  maxPages?: number;
  onPage?: (pageItems: unknown[], pageNumber: number, total: number) => void;
}

/**
 * Walk a CW collection endpoint to exhaustion.
 *
 * CW has no cursor and no total count — a short page is the only end-of-data
 * signal, so paging stops when a page comes back smaller than requested.
 */
async function cwGetAll<T>(
  creds: ConnectWiseCredentials,
  path: string,
  query: CWQuery,
  opts: PagedFetchOptions,
): Promise<{ items: T[]; truncated: boolean }> {
  const pageSize = Math.min(opts.pageSize ?? CW_MAX_PAGE_SIZE, CW_MAX_PAGE_SIZE);
  const maxPages = opts.maxPages ?? 100;
  const items: T[] = [];

  for (let page = 1; page <= maxPages; page++) {
    if (opts.signal?.aborted) throw new ConnectWiseError('Cancelled');

    const batch = await cwGet<T[]>(creds, path, { ...query, page, pageSize }, opts);
    if (!Array.isArray(batch)) {
      throw new ConnectWiseError('ConnectWise returned an unexpected response shape.');
    }

    items.push(...batch);
    opts.onPage?.(batch, page, items.length);

    if (batch.length < pageSize) return { items, truncated: false };
  }

  // Ran out of page budget with a full final page — more data exists.
  return { items, truncated: true };
}

// ---------------------------------------------------------------------------
// Endpoints
// ---------------------------------------------------------------------------

/** Cheapest authenticated call, used to validate a connection. */
export async function testConnection(
  creds: ConnectWiseCredentials,
  opts: ConnectWiseRequestOptions = {},
): Promise<{ ok: true; companyCount: number }> {
  const companies = await cwGet<CWCompany[]>(
    creds,
    '/company/companies',
    { pageSize: 1, fields: ['id', 'identifier', 'name'] },
    opts,
  );
  return { ok: true, companyCount: Array.isArray(companies) ? companies.length : 0 };
}

export function fetchConfigurations(
  creds: ConnectWiseCredentials,
  conditions: string | undefined,
  opts: PagedFetchOptions = {},
): Promise<{ items: CWConfiguration[]; truncated: boolean }> {
  return cwGetAll<CWConfiguration>(
    creds,
    '/company/configurations',
    // Ordering by id keeps paging stable; without it a record edited mid-sync
    // can shift between pages and be fetched twice or skipped entirely.
    { conditions: conditions?.trim() || undefined, orderBy: 'id asc' },
    opts,
  );
}

export function fetchTickets(
  creds: ConnectWiseCredentials,
  conditions: string | undefined,
  opts: PagedFetchOptions = {},
): Promise<{ items: CWTicket[]; truncated: boolean }> {
  return cwGetAll<CWTicket>(
    creds,
    '/service/tickets',
    { conditions: conditions?.trim() || undefined, orderBy: 'id asc' },
    opts,
  );
}

export function fetchCompanies(
  creds: ConnectWiseCredentials,
  opts: PagedFetchOptions = {},
): Promise<{ items: CWCompany[]; truncated: boolean }> {
  return cwGetAll<CWCompany>(
    creds,
    '/company/companies',
    { fields: ['id', 'identifier', 'name', 'status'], orderBy: 'name asc' },
    opts,
  );
}

/**
 * Look up configurations matching a hostname, IP or serial.
 *
 * Used for on-demand enrichment from an event observable, where the analyst
 * has one value and wants to know whether the CMDB has ever heard of it.
 */
export function lookupConfigurations(
  creds: ConnectWiseCredentials,
  observable: string,
  opts: ConnectWiseRequestOptions = {},
): Promise<CWConfiguration[]> {
  const value = observable.trim().replace(/"/g, '');
  if (!value) return Promise.resolve([]);

  // CW conditions have no OR across a `like`, so this ORs explicit clauses.
  const conditions = [
    `name like "%${value}%"`,
    `deviceIdentifier like "%${value}%"`,
    `ipAddress="${value}"`,
    `macAddress="${value}"`,
    `serialNumber="${value}"`,
  ].join(' or ');

  return cwGet<CWConfiguration[]>(
    creds,
    '/company/configurations',
    { conditions, pageSize: 25 },
    opts,
  );
}
