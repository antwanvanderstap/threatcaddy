import type {
  Asset,
  AssetCorrelation,
  AssetCorrelationReport,
  AssetMatchField,
  AssetObservable,
} from '../types';
import { resolveAsset } from './asset-overrides';

// ---------------------------------------------------------------------------
// Normalization
// ---------------------------------------------------------------------------

/**
 * MAC addresses arrive in several shapes across tooling:
 *   ITGlue/ConnectWise: "00-50-56-BD-DC-CD"
 *   Stellar Cyber:      "10:60:4b:5c:b3:98"
 *   Cisco:              "0050.56bd.dccd"
 * Reduce all of them to bare lowercase hex so they compare equal.
 */
export function normalizeMac(value: string): string | undefined {
  const hex = value.toLowerCase().replace(/[^0-9a-f]/g, '');
  return hex.length === 12 ? hex : undefined;
}

/** Display form for a normalized MAC: "00:50:56:bd:dc:cd". */
export function formatMac(normalized: string): string {
  return normalized.match(/.{2}/g)?.join(':') ?? normalized;
}

/**
 * Hostnames appear as bare names ("PNY-MJX-DC1") or FQDNs
 * ("mjx-intex-pc.mjx.local"). Compare on the lowercase short name so an event's
 * FQDN still matches a CMDB record that only stored the NetBIOS name.
 */
export function normalizeHostname(value: string): string | undefined {
  const trimmed = value.trim().toLowerCase().replace(/\.$/, '');
  if (!trimmed) return undefined;
  const short = trimmed.split('.')[0];
  return short || undefined;
}

/** Serials are compared case-insensitively with separators stripped. */
export function normalizeSerial(value: string): string | undefined {
  const cleaned = value.trim().toLowerCase().replace(/[\s-]/g, '');
  // VMware BIOS UUIDs ("VMware-42 3d 35 a6...") are not unique hardware serials
  // in practice — many CMDB rows share one. Excluded to avoid false positives.
  if (!cleaned || cleaned.startsWith('vmware')) return undefined;
  return cleaned.length >= 4 ? cleaned : undefined;
}

const IPV4_RE = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/;

/** Returns the four octets of a valid IPv4 string, or undefined. */
export function parseIPv4(value: string): [number, number, number, number] | undefined {
  const match = IPV4_RE.exec(value.trim());
  if (!match) return undefined;
  const octets = match.slice(1, 5).map(Number) as [number, number, number, number];
  return octets.every((o) => o >= 0 && o <= 255) ? octets : undefined;
}

/** RFC1918 / link-local / loopback. Public addresses are out of CMDB scope. */
export function isInternalIPv4(value: string): boolean {
  const octets = parseIPv4(value);
  if (!octets) return false;
  const [a, b] = octets;
  if (a === 10) return true;
  if (a === 172 && b >= 16 && b <= 31) return true;
  if (a === 192 && b === 168) return true;
  if (a === 127) return true;
  if (a === 169 && b === 254) return true;
  return false;
}

/** Placeholder addresses that should never be treated as real observables. */
function isMeaninglessIp(value: string): boolean {
  return value === '0.0.0.0' || value === '255.255.255.255';
}

/** The containing /24, e.g. "10.10.100.36" -> "10.10.100.0/24". */
export function subnet24(value: string): string | undefined {
  const octets = parseIPv4(value);
  if (!octets) return undefined;
  return `${octets[0]}.${octets[1]}.${octets[2]}.0/24`;
}

// ---------------------------------------------------------------------------
// Index
// ---------------------------------------------------------------------------

/**
 * Precomputed lookup tables over the asset inventory. Building this once and
 * reusing it keeps correlation O(observables) instead of O(observables x assets),
 * which matters because a CMDB export is routinely tens of thousands of rows.
 */
export interface AssetIndex {
  byIp: Map<string, string[]>;
  byMac: Map<string, string[]>;
  byHostname: Map<string, string[]>;
  bySerial: Map<string, string[]>;
  byAssetTag: Map<string, string[]>;
  bySubnet: Map<string, string[]>;
  assetsById: Map<string, Asset>;
}

function push(map: Map<string, string[]>, key: string | undefined, id: string) {
  if (!key) return;
  const existing = map.get(key);
  if (existing) {
    if (!existing.includes(id)) existing.push(id);
  } else {
    map.set(key, [id]);
  }
}

export function buildAssetIndex(rawAssets: Asset[]): AssetIndex {
  // Corrections must be indexed, not the stale imported values — otherwise an
  // analyst fixing a wrong IP would leave correlation matching the old one.
  const assets = rawAssets.map(resolveAsset);
  const index: AssetIndex = {
    byIp: new Map(),
    byMac: new Map(),
    byHostname: new Map(),
    bySerial: new Map(),
    byAssetTag: new Map(),
    bySubnet: new Map(),
    assetsById: new Map(),
  };

  for (const asset of assets) {
    if (asset.trashed) continue;
    index.assetsById.set(asset.id, asset);

    const ips = [asset.primaryIp, ...(asset.ipAddresses ?? [])];
    for (const ip of ips) {
      if (!ip || isMeaninglessIp(ip) || !parseIPv4(ip)) continue;
      push(index.byIp, ip.trim(), asset.id);
      push(index.bySubnet, subnet24(ip), asset.id);
    }

    for (const mac of [asset.macAddress, ...(asset.macAddresses ?? [])]) {
      if (mac) push(index.byMac, normalizeMac(mac), asset.id);
    }

    for (const name of [asset.hostname, asset.name]) {
      if (name) push(index.byHostname, normalizeHostname(name), asset.id);
    }

    if (asset.serialNumber) push(index.bySerial, normalizeSerial(asset.serialNumber), asset.id);
    if (asset.assetTag) push(index.byAssetTag, asset.assetTag.trim().toLowerCase(), asset.id);
  }

  return index;
}

// ---------------------------------------------------------------------------
// Correlation
// ---------------------------------------------------------------------------

function assetLabel(index: AssetIndex, ids: string[]): string {
  const names = ids.map((id) => index.assetsById.get(id)?.name ?? id);
  if (names.length <= 3) return names.join(', ');
  return `${names.slice(0, 3).join(', ')} +${names.length - 3} more`;
}

/**
 * Correlate one observable against the inventory.
 *
 * Tiers are evaluated strongest-first: an exact identifier match wins outright;
 * failing that an internal IP falls back to /24 proximity, which answers "do we
 * have any inventory near this address?"; an internal address with neither is
 * reported as a coverage gap rather than silently dropped. Public IPs and
 * unmatched non-IP observables yield no correlation at all — absence of a
 * public address from a CMDB is not a finding.
 */
export function correlateObservable(
  observable: AssetObservable,
  index: AssetIndex,
): AssetCorrelation | undefined {
  const raw = observable.value.trim();
  if (!raw) return undefined;

  const exact = (field: AssetMatchField, ids: string[], detail: string): AssetCorrelation => ({
    observable,
    tier: 'exact',
    matchedField: field,
    assetIds: ids,
    rationale: `${detail} matches ${assetLabel(index, ids)}`,
  });

  if (observable.kind === 'mac') {
    const key = normalizeMac(raw);
    if (!key) return undefined;
    const ids = index.byMac.get(key);
    // An unmatched MAC is not reported as a gap: the MAC a sensor observes is
    // often the intervening router's, not the endpoint's, so absence from the
    // CMDB is not by itself evidence of missing inventory.
    return ids ? exact('mac', ids, `MAC ${formatMac(key)}`) : undefined;
  }

  if (observable.kind === 'serial') {
    const key = normalizeSerial(raw);
    const ids = key ? index.bySerial.get(key) : undefined;
    if (ids) return exact('serial', ids, `Serial ${raw}`);
    const tagIds = index.byAssetTag.get(raw.trim().toLowerCase());
    return tagIds ? exact('assetTag', tagIds, `Asset tag ${raw}`) : undefined;
  }

  if (observable.kind === 'hostname') {
    const key = normalizeHostname(raw);
    const ids = key ? index.byHostname.get(key) : undefined;
    if (ids) return exact('hostname', ids, `Hostname ${raw}`);
    // An unmatched hostname is a genuine gap: the CMDB should know every host.
    return {
      observable,
      tier: 'gap',
      assetIds: [],
      rationale: `Hostname ${raw} has no matching configuration item`,
    };
  }

  // kind === 'ip'
  if (isMeaninglessIp(raw) || !parseIPv4(raw)) return undefined;

  const ipIds = index.byIp.get(raw);
  if (ipIds) return exact('ip', ipIds, `IP ${raw}`);

  if (!isInternalIPv4(raw)) return undefined;

  const cidr = subnet24(raw);
  const subnetIds = cidr ? index.bySubnet.get(cidr) : undefined;
  if (subnetIds && cidr) {
    return {
      observable,
      tier: 'subnet',
      matchedField: 'subnet',
      assetIds: subnetIds,
      subnet: cidr,
      rationale: `No asset owns ${raw}, but ${subnetIds.length} inventoried asset${subnetIds.length === 1 ? '' : 's'} share ${cidr} (${assetLabel(index, subnetIds)})`,
    };
  }

  return {
    observable,
    tier: 'gap',
    assetIds: [],
    subnet: cidr,
    rationale: `Internal address ${raw} is absent from the inventory${cidr ? ` and no asset is recorded in ${cidr}` : ''}`,
  };
}

/** Correlate a set of observables and roll the results up into a report. */
export function correlateObservables(
  observables: AssetObservable[],
  index: AssetIndex,
): AssetCorrelationReport {
  const correlations: AssetCorrelation[] = [];
  const seen = new Set<string>();

  for (const observable of observables) {
    const key = `${observable.kind}:${observable.value.trim().toLowerCase()}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const result = correlateObservable(observable, index);
    if (result) correlations.push(result);
  }

  // Strongest evidence first so the UI leads with confirmed hits.
  const rank = { exact: 0, subnet: 1, gap: 2 } as const;
  correlations.sort((a, b) => rank[a.tier] - rank[b.tier]);

  const matchedAssetIds = [
    ...new Set(correlations.filter((c) => c.tier !== 'gap').flatMap((c) => c.assetIds)),
  ];

  return {
    correlations,
    exactCount: correlations.filter((c) => c.tier === 'exact').length,
    subnetCount: correlations.filter((c) => c.tier === 'subnet').length,
    gapCount: correlations.filter((c) => c.tier === 'gap').length,
    matchedAssetIds,
  };
}

// ---------------------------------------------------------------------------
// Observable extraction from event rows
// ---------------------------------------------------------------------------

/**
 * Column headers that carry correlatable observables, mapped to their kind and
 * direction. Keys are lowercased header names as they appear in SIEM CSV
 * exports (Stellar Cyber naming, with common aliases).
 */
const OBSERVABLE_COLUMNS: Record<string, { kind: AssetObservable['kind']; role?: AssetObservable['role'] }> = {
  'source ip': { kind: 'ip', role: 'source' },
  'src ip': { kind: 'ip', role: 'source' },
  srcip: { kind: 'ip', role: 'source' },
  'source ip 2': { kind: 'ip', role: 'source' },
  'correlation source ip': { kind: 'ip', role: 'source' },
  'destination ip': { kind: 'ip', role: 'destination' },
  'dest ip': { kind: 'ip', role: 'destination' },
  dstip: { kind: 'ip', role: 'destination' },
  'correlation destination ip': { kind: 'ip', role: 'destination' },
  'host ip': { kind: 'ip' },
  ipaddress: { kind: 'ip' },
  'remote ip': { kind: 'ip' },
  'client address': { kind: 'ip' },
  'source mac': { kind: 'mac', role: 'source' },
  'destination mac': { kind: 'mac', role: 'destination' },
  mac: { kind: 'mac' },
  'source host': { kind: 'hostname', role: 'source' },
  'destination host': { kind: 'hostname', role: 'destination' },
  'host name': { kind: 'hostname' },
  hostname: { kind: 'hostname' },
  host: { kind: 'hostname' },
  'computer name': { kind: 'hostname' },
  asset: { kind: 'hostname' },
  device: { kind: 'hostname' },
  sn: { kind: 'serial' },
  'serial number': { kind: 'serial' },
};

/**
 * Pull correlatable observables out of one parsed event row.
 *
 * Only recognized columns are read. Scraping every field would drag in sensor
 * IPs, gateway addresses and vendor identifiers that correlate to nothing and
 * bury the real endpoints in noise.
 */
export function extractObservablesFromRow(row: Record<string, string>): AssetObservable[] {
  const observables: AssetObservable[] = [];

  for (const [header, rawValue] of Object.entries(row)) {
    const spec = OBSERVABLE_COLUMNS[header.trim().toLowerCase()];
    if (!spec) continue;
    const value = (rawValue ?? '').trim();
    if (!value) continue;

    // A few columns carry comma- or space-separated lists.
    for (const part of value.split(/[,;\s]+/)) {
      const candidate = part.trim();
      if (!candidate) continue;
      if (spec.kind === 'ip' && !parseIPv4(candidate)) continue;
      if (spec.kind === 'mac' && !normalizeMac(candidate)) continue;
      observables.push({ label: header.trim(), kind: spec.kind, value: candidate, role: spec.role });
    }
  }

  return observables;
}

/** Convenience: extract observables across many rows and correlate in one pass. */
export function correlateEventRows(
  rows: Record<string, string>[],
  assets: Asset[],
): AssetCorrelationReport {
  const index = buildAssetIndex(assets);
  const observables = rows.flatMap(extractObservablesFromRow);
  return correlateObservables(observables, index);
}
