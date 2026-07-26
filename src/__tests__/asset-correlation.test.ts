import { describe, it, expect } from 'vitest';
import {
  buildAssetIndex,
  correlateObservable,
  correlateObservables,
  correlateEventRows,
  extractObservablesFromRow,
  normalizeMac,
  formatMac,
  normalizeHostname,
  normalizeSerial,
  parseIPv4,
  isInternalIPv4,
  subnet24,
} from '../lib/asset-correlation';
import type { Asset, AssetObservable } from '../types';

function makeAsset(partial: Partial<Asset> & { id: string; name: string }): Asset {
  return {
    importedAt: 0,
    tags: [],
    trashed: false,
    archived: false,
    createdAt: 0,
    updatedAt: 0,
    ...partial,
  };
}

const INVENTORY: Asset[] = [
  makeAsset({
    id: 'a1',
    name: 'VHQ-NAG-UAT01',
    primaryIp: '10.255.1.179',
    macAddress: '00-50-56-BD-DB-1A',
    serialNumber: '5CD43994SX',
    assetType: 'Managed Server',
  }),
  makeAsset({
    id: 'a2',
    name: 'NAG-JLAWRENCE',
    primaryIp: '10.10.100.20',
    macAddress: 'F4-4E-E3-01-FA-31',
  }),
  makeAsset({
    id: 'a3',
    name: 'NAMS-PSONI',
    primaryIp: '10.10.100.15',
    hostname: 'nams-psoni.nuageindustries.com',
  }),
  makeAsset({ id: 'a4', name: 'PNY-MJX-DC1', primaryIp: '10.20.0.5', assetTag: '0003178' }),
  makeAsset({ id: 'a5', name: 'TRASHED-HOST', primaryIp: '10.10.100.99', trashed: true }),
];

// ── Normalization ───────────────────────────────────────────────────

describe('normalization', () => {
  it('normalizes MACs across vendor formats to bare hex', () => {
    expect(normalizeMac('00-50-56-BD-DC-CD')).toBe('005056bddccd');
    expect(normalizeMac('00:50:56:bd:dc:cd')).toBe('005056bddccd');
    expect(normalizeMac('0050.56bd.dccd')).toBe('005056bddccd');
  });

  it('rejects malformed MACs', () => {
    expect(normalizeMac('00-50-56')).toBeUndefined();
    expect(normalizeMac('not a mac')).toBeUndefined();
    expect(normalizeMac('')).toBeUndefined();
  });

  it('formats a normalized MAC for display', () => {
    expect(formatMac('005056bddccd')).toBe('00:50:56:bd:dc:cd');
  });

  it('reduces FQDNs to the lowercase short name', () => {
    expect(normalizeHostname('mjx-intex-pc.mjx.local')).toBe('mjx-intex-pc');
    expect(normalizeHostname('PNY-MJX-DC1')).toBe('pny-mjx-dc1');
    expect(normalizeHostname('host.example.com.')).toBe('host');
    expect(normalizeHostname('  ')).toBeUndefined();
  });

  it('ignores VMware BIOS UUIDs, which are not unique serials', () => {
    expect(normalizeSerial('VMware-42 3d 35 a6 da 21 ba d7')).toBeUndefined();
    expect(normalizeSerial('5CD43994SX')).toBe('5cd43994sx');
    expect(normalizeSerial('ab')).toBeUndefined();
  });

  it('parses and classifies IPv4 addresses', () => {
    expect(parseIPv4('10.10.100.36')).toEqual([10, 10, 100, 36]);
    expect(parseIPv4('999.1.1.1')).toBeUndefined();
    expect(parseIPv4('not.an.ip.addr')).toBeUndefined();
    expect(isInternalIPv4('10.1.2.3')).toBe(true);
    expect(isInternalIPv4('172.20.206.32')).toBe(true);
    expect(isInternalIPv4('172.32.0.1')).toBe(false);
    expect(isInternalIPv4('192.168.1.1')).toBe(true);
    expect(isInternalIPv4('38.140.0.186')).toBe(false);
    expect(subnet24('10.10.100.36')).toBe('10.10.100.0/24');
  });
});

// ── Index ───────────────────────────────────────────────────────────

describe('buildAssetIndex', () => {
  it('excludes trashed assets from every lookup table', () => {
    const index = buildAssetIndex(INVENTORY);
    expect(index.assetsById.has('a5')).toBe(false);
    expect(index.byIp.get('10.10.100.99')).toBeUndefined();
    expect(index.bySubnet.get('10.10.100.0/24')).toEqual(['a2', 'a3']);
  });

  it('indexes name and hostname under the same short-name key', () => {
    const index = buildAssetIndex(INVENTORY);
    expect(index.byHostname.get('nams-psoni')).toEqual(['a3']);
  });

  it('skips placeholder addresses', () => {
    const index = buildAssetIndex([makeAsset({ id: 'z', name: 'Z', primaryIp: '0.0.0.0' })]);
    expect(index.byIp.size).toBe(0);
  });
});

// ── Exact tier ──────────────────────────────────────────────────────

describe('exact matching', () => {
  const index = buildAssetIndex(INVENTORY);
  const observe = (kind: AssetObservable['kind'], value: string): AssetObservable =>
    ({ label: 'test', kind, value });

  it('matches on IP', () => {
    const result = correlateObservable(observe('ip', '10.255.1.179'), index);
    expect(result?.tier).toBe('exact');
    expect(result?.matchedField).toBe('ip');
    expect(result?.assetIds).toEqual(['a1']);
  });

  it('matches on MAC regardless of source formatting', () => {
    const result = correlateObservable(observe('mac', '00:50:56:bd:db:1a'), index);
    expect(result?.tier).toBe('exact');
    expect(result?.matchedField).toBe('mac');
    expect(result?.assetIds).toEqual(['a1']);
    expect(result?.rationale).toContain('VHQ-NAG-UAT01');
  });

  it('matches an event FQDN against a bare CMDB name', () => {
    const result = correlateObservable(observe('hostname', 'PNY-MJX-DC1.mjx.local'), index);
    expect(result?.tier).toBe('exact');
    expect(result?.matchedField).toBe('hostname');
    expect(result?.assetIds).toEqual(['a4']);
  });

  it('matches on serial, and falls back to asset tag', () => {
    expect(correlateObservable(observe('serial', '5cd43994sx'), index)?.matchedField).toBe('serial');
    expect(correlateObservable(observe('serial', '0003178'), index)?.matchedField).toBe('assetTag');
  });

  it('does not match an unmatched MAC as a gap', () => {
    expect(correlateObservable(observe('mac', 'aa:bb:cc:dd:ee:ff'), index)).toBeUndefined();
  });
});

// ── Subnet and gap tiers ────────────────────────────────────────────

describe('subnet and gap tiers', () => {
  const index = buildAssetIndex(INVENTORY);
  const observe = (kind: AssetObservable['kind'], value: string): AssetObservable =>
    ({ label: 'test', kind, value });

  it('reports /24 proximity when no asset owns the address', () => {
    const result = correlateObservable(observe('ip', '10.10.100.36'), index);
    expect(result?.tier).toBe('subnet');
    expect(result?.subnet).toBe('10.10.100.0/24');
    expect(result?.assetIds).toEqual(['a2', 'a3']);
    expect(result?.rationale).toContain('2 inventoried assets');
  });

  it('reports an internal address with no nearby inventory as a coverage gap', () => {
    const result = correlateObservable(observe('ip', '192.168.77.5'), index);
    expect(result?.tier).toBe('gap');
    expect(result?.assetIds).toEqual([]);
  });

  it('ignores public addresses entirely', () => {
    expect(correlateObservable(observe('ip', '38.140.0.186'), index)).toBeUndefined();
  });

  it('ignores placeholder addresses', () => {
    expect(correlateObservable(observe('ip', '0.0.0.0'), index)).toBeUndefined();
  });

  it('reports an unknown hostname as a coverage gap', () => {
    const result = correlateObservable(observe('hostname', 'mjx-intex-pc.mjx.local'), index);
    expect(result?.tier).toBe('gap');
    expect(result?.rationale).toContain('no matching configuration item');
  });
});

// ── Aggregation ─────────────────────────────────────────────────────

describe('correlateObservables', () => {
  const index = buildAssetIndex(INVENTORY);

  it('deduplicates repeated observables and ranks strongest first', () => {
    const report = correlateObservables([
      { label: 'Source IP', kind: 'ip', value: '10.10.100.36' },
      { label: 'Dup', kind: 'ip', value: '10.10.100.36' },
      { label: 'Destination IP', kind: 'ip', value: '10.255.1.179' },
      { label: 'Source Host', kind: 'hostname', value: 'unknown-host' },
    ], index);

    expect(report.correlations.map((c) => c.tier)).toEqual(['exact', 'subnet', 'gap']);
    expect(report.exactCount).toBe(1);
    expect(report.subnetCount).toBe(1);
    expect(report.gapCount).toBe(1);
    expect(report.matchedAssetIds).toEqual(['a1', 'a2', 'a3']);
  });

  it('returns an empty report for an empty inventory', () => {
    const empty = buildAssetIndex([]);
    const report = correlateObservables([{ label: 'Source IP', kind: 'ip', value: '10.0.0.1' }], empty);
    expect(report.exactCount).toBe(0);
    expect(report.gapCount).toBe(1);
    expect(report.matchedAssetIds).toEqual([]);
  });
});

// ── Row extraction ──────────────────────────────────────────────────

describe('extractObservablesFromRow', () => {
  it('reads only recognized observable columns', () => {
    const observables = extractObservablesFromRow({
      'Source IP': '10.10.100.36',
      'Destination IP': '10.10.100.37',
      'Source Mac': '10:60:4b:5c:b3:98',
      'Source Host': 'mjx-intex-pc.mjx.local',
      'Sensor Gateway': '38.140.0.186',
      'Alert Score': '80',
    });

    expect(observables).toHaveLength(4);
    expect(observables.find((o) => o.label === 'Source IP')?.role).toBe('source');
    expect(observables.find((o) => o.label === 'Destination IP')?.role).toBe('destination');
    expect(observables.some((o) => o.value === '38.140.0.186')).toBe(false);
    expect(observables.some((o) => o.value === '80')).toBe(false);
  });

  it('is case-insensitive on headers and skips blanks', () => {
    const observables = extractObservablesFromRow({ 'source ip': '10.0.0.1', 'Destination IP': '' });
    expect(observables).toHaveLength(1);
  });

  it('rejects values that do not parse as their declared kind', () => {
    const observables = extractObservablesFromRow({ 'Source IP': 'unassigned location', 'Source Mac': 'n/a' });
    expect(observables).toHaveLength(0);
  });
});

// ── End-to-end ──────────────────────────────────────────────────────

describe('correlateEventRows', () => {
  it('correlates a Stellar Cyber style exploit row against the inventory', () => {
    const report = correlateEventRows([{
      'Source IP': '10.10.100.36',
      'Destination IP': '10.10.100.37',
      'Source Host': 'mjx-intex-pc.mjx.local',
      'Destination Host': 'PNY-MJX-DC1',
      'Source Mac': '10:60:4b:5c:b3:98',
    }], INVENTORY);

    // Neither endpoint is inventoried, but both sit in a subnet we do cover,
    // and the destination host name matches a known configuration item.
    expect(report.exactCount).toBe(1);
    expect(report.subnetCount).toBe(2);
    expect(report.gapCount).toBe(1);
    expect(report.correlations[0].observable.value).toBe('PNY-MJX-DC1');
  });
});
