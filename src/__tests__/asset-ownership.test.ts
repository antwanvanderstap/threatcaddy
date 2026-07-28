import { describe, it, expect } from 'vitest';
import {
  ownerType,
  ownerKey,
  matchesOwnerFilter,
  filterByOwner,
  customerNames,
  summarizeOwners,
  normalizeOwnership,
} from '../lib/asset-ownership';
import { parseAssetCSV } from '../lib/asset-import';
import { buildAttackSurface } from '../lib/attack-surface';
import type { Asset } from '../types';

function makeAsset(p: Partial<Asset> & { id: string }): Asset {
  return {
    name: p.name ?? p.id,
    importedAt: 0, tags: [], trashed: false, archived: false,
    createdAt: 0, updatedAt: 0, ...p,
  };
}

describe('ownerType / ownerKey', () => {
  it('treats an absent owner as unknown rather than assuming the MSSP', () => {
    expect(ownerType(makeAsset({ id: 'a' }))).toBe('unknown');
  });

  it('keys customers by name so two customers never merge', () => {
    expect(ownerKey(makeAsset({ id: 'a', owner: 'customer', customerName: 'Acme' }))).toBe('customer:Acme');
    expect(ownerKey(makeAsset({ id: 'b', owner: 'customer', customerName: 'Globex' }))).toBe('customer:Globex');
    expect(ownerKey(makeAsset({ id: 'c', owner: 'mssp' }))).toBe('mssp');
  });

  it('keeps an unnamed customer distinct from a fully unlabelled asset', () => {
    expect(ownerKey(makeAsset({ id: 'a', owner: 'customer' }))).toBe('customer:(unnamed)');
    expect(ownerKey(makeAsset({ id: 'b' }))).toBe('unknown');
  });
});

describe('filtering', () => {
  const inventory = [
    makeAsset({ id: 'm1', owner: 'mssp' }),
    makeAsset({ id: 'c1', owner: 'customer', customerName: 'Acme' }),
    makeAsset({ id: 'c2', owner: 'customer', customerName: 'Globex' }),
    makeAsset({ id: 'u1' }),
  ];

  it('matches by owner type', () => {
    expect(filterByOwner(inventory, 'mssp').map((a) => a.id)).toEqual(['m1']);
    expect(filterByOwner(inventory, 'customer').map((a) => a.id)).toEqual(['c1', 'c2']);
    expect(filterByOwner(inventory, 'unknown').map((a) => a.id)).toEqual(['u1']);
  });

  it('matches a specific customer', () => {
    expect(filterByOwner(inventory, { customerName: 'Acme' }).map((a) => a.id)).toEqual(['c1']);
  });

  it('passes everything through when unfiltered', () => {
    expect(filterByOwner(inventory, 'all')).toHaveLength(4);
  });

  it('does not match a customer name against a non-customer asset', () => {
    const mssp = makeAsset({ id: 'x', owner: 'mssp', customerName: 'Acme' });
    expect(matchesOwnerFilter(mssp, { customerName: 'Acme' })).toBe(false);
  });

  it('lists distinct customer names, sorted', () => {
    expect(customerNames(inventory)).toEqual(['Acme', 'Globex']);
  });
});

describe('summarizeOwners', () => {
  it('counts by type and by customer', () => {
    const counts = summarizeOwners([
      makeAsset({ id: 'a', owner: 'mssp' }),
      makeAsset({ id: 'b', owner: 'customer', customerName: 'Acme' }),
      makeAsset({ id: 'c', owner: 'customer', customerName: 'Acme' }),
      makeAsset({ id: 'd', owner: 'customer' }),
      makeAsset({ id: 'e' }),
    ]);
    expect(counts).toEqual({
      mssp: 1, customer: 3, unknown: 1,
      byCustomer: { Acme: 2, '(unnamed)': 1 },
    });
  });

  it('handles an empty list', () => {
    expect(summarizeOwners([])).toEqual({ mssp: 0, customer: 0, unknown: 0, byCustomer: {} });
  });
});

describe('normalizeOwnership', () => {
  it('keeps a customer name only for customer-owned assets', () => {
    expect(normalizeOwnership('customer', ' Acme ')).toEqual({ owner: 'customer', customerName: 'Acme' });
    // A stale name on a reclassified asset would corrupt per-customer rollups.
    expect(normalizeOwnership('mssp', 'Acme')).toEqual({ owner: 'mssp', customerName: undefined });
    expect(normalizeOwnership('unknown', 'Acme')).toEqual({ owner: 'unknown', customerName: undefined });
  });

  it('drops a blank customer name', () => {
    expect(normalizeOwnership('customer', '   ')).toEqual({ owner: 'customer', customerName: undefined });
  });
});

// ── Import ──────────────────────────────────────────────────────────

describe('ownership at import', () => {
  const HEADER = 'id,name,configuration_type_name,operating_system_name';
  const ROW = '1,SRV-01,Managed Server,Windows Server 2022 Standard';

  it('labels every row with the declared owner', () => {
    const result = parseAssetCSV(`${HEADER}\n${ROW}`, [], {
      now: 1, owner: 'customer', customerName: 'Acme',
    });
    expect(result.assets[0].owner).toBe('customer');
    expect(result.assets[0].customerName).toBe('Acme');
  });

  it('defaults to unknown when the import declares nothing', () => {
    const result = parseAssetCSV(`${HEADER}\n${ROW}`, [], { now: 1 });
    expect(result.assets[0].owner).toBe('unknown');
  });

  it('preserves an existing assignment when the re-import declares none', () => {
    const first = parseAssetCSV(`${HEADER}\n${ROW}`, [], { now: 1, owner: 'customer', customerName: 'Acme' });
    const second = parseAssetCSV(`${HEADER}\n${ROW}`, first.assets, { now: 2 });
    expect(second.assets[0].owner).toBe('customer');
    expect(second.assets[0].customerName).toBe('Acme');
  });

  it('lets a declaring re-import reassign ownership', () => {
    const first = parseAssetCSV(`${HEADER}\n${ROW}`, [], { now: 1, owner: 'customer', customerName: 'Acme' });
    const second = parseAssetCSV(`${HEADER}\n${ROW}`, first.assets, { now: 2, owner: 'mssp' });
    expect(second.assets[0].owner).toBe('mssp');
    expect(second.assets[0].customerName).toBeUndefined();
  });
});

// ── Attack surface rollup ───────────────────────────────────────────

describe('attack surface owner rollups', () => {
  const ASOF = Date.parse('2026-07-26T00:00:00Z');

  it('reports who is exposed per product and overall', () => {
    const surface = buildAttackSurface([
      makeAsset({ id: 'a', operatingSystem: 'VMware ESXi 6.7', owner: 'mssp' }),
      makeAsset({ id: 'b', operatingSystem: 'VMware ESXi 6.7', owner: 'customer', customerName: 'Acme' }),
      makeAsset({ id: 'c', operatingSystem: 'VMware ESXi 6.7', owner: 'customer', customerName: 'Acme' }),
      makeAsset({ id: 'd', operatingSystem: 'Windows Server 2022 Standard', owner: 'customer', customerName: 'Globex' }),
    ], ASOF);

    const esxi = surface.exposures.find((e) => e.product.product === 'esxi')!;
    expect(esxi.owners).toEqual({ mssp: 1, customer: 2, unknown: 0, byCustomer: { Acme: 2 } });

    // Only the EOL product is at risk, so Globex is absent from the split.
    expect(surface.atRiskOwners).toEqual({ mssp: 1, customer: 2, unknown: 0, byCustomer: { Acme: 2 } });
  });

  it('counts an unlabelled at-risk asset as unknown', () => {
    const surface = buildAttackSurface([
      makeAsset({ id: 'a', operatingSystem: 'Windows 7' }),
    ], ASOF);
    expect(surface.atRiskOwners.unknown).toBe(1);
  });
});
