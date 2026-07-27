import { describe, it, expect } from 'vitest';
import {
  resolveAsset,
  setOverride,
  clearOverride,
  overriddenFields,
  originalValue,
  divergentOverrides,
  isOverridableField,
  OVERRIDABLE_ASSET_FIELDS,
} from '../lib/asset-overrides';
import { parseAssetCSV } from '../lib/asset-import';
import { buildAssetIndex, correlateObservable } from '../lib/asset-correlation';
import { buildAttackSurface } from '../lib/attack-surface';
import { productsForAsset } from '../lib/asset-products';
import type { Asset } from '../types';

function makeAsset(p: Partial<Asset> & { id: string }): Asset {
  return {
    name: p.name ?? p.id,
    importedAt: 0, tags: [], trashed: false, archived: false,
    createdAt: 0, updatedAt: 0, ...p,
  };
}

// ── resolveAsset ────────────────────────────────────────────────────

describe('resolveAsset', () => {
  it('returns the same object when there is nothing to apply', () => {
    const asset = makeAsset({ id: 'a', operatingSystem: 'Windows 10 Pro' });
    expect(resolveAsset(asset)).toBe(asset);
    // An empty map is also a no-op, so memoized consumers do not re-render.
    const emptyOverrides = { ...asset, overrides: {} };
    expect(resolveAsset(emptyOverrides)).toBe(emptyOverrides);
  });

  it('layers a correction over the imported value', () => {
    const asset = makeAsset({
      id: 'a',
      operatingSystem: 'Windows (Other)',
      overrides: { operatingSystem: { value: 'VMware ESXi 7.0', updatedAt: 5 } },
    });
    expect(resolveAsset(asset).operatingSystem).toBe('VMware ESXi 7.0');
    // The imported value is preserved underneath, not destroyed.
    expect(asset.operatingSystem).toBe('Windows (Other)');
  });

  it('treats a null override as a deliberate clear', () => {
    const asset = makeAsset({
      id: 'a', primaryIp: '10.0.0.1',
      overrides: { primaryIp: { value: null, updatedAt: 5 } },
    });
    expect(resolveAsset(asset).primaryIp).toBeUndefined();
  });

  it('keeps derived address arrays in step with a corrected scalar', () => {
    const asset = makeAsset({
      id: 'a', primaryIp: '10.0.0.1', ipAddresses: ['10.0.0.1'],
      macAddress: '00-50-56-BD-DB-1A', macAddresses: ['00-50-56-BD-DB-1A'],
      overrides: {
        primaryIp: { value: '10.0.0.99', updatedAt: 5 },
        macAddress: { value: 'AA-BB-CC-DD-EE-FF', updatedAt: 5 },
      },
    });
    const resolved = resolveAsset(asset);
    expect(resolved.ipAddresses).toEqual(['10.0.0.99']);
    expect(resolved.macAddresses).toEqual(['AA-BB-CC-DD-EE-FF']);
  });

  it('empties the derived array when the scalar is cleared', () => {
    const asset = makeAsset({
      id: 'a', primaryIp: '10.0.0.1', ipAddresses: ['10.0.0.1'],
      overrides: { primaryIp: { value: null, updatedAt: 5 } },
    });
    expect(resolveAsset(asset).ipAddresses).toEqual([]);
  });
});

// ── setOverride / clearOverride ─────────────────────────────────────

describe('setOverride', () => {
  const base = makeAsset({ id: 'a', operatingSystem: 'Windows 10 Pro', hostname: 'host-a' });

  it('records the correction with provenance', () => {
    const overrides = setOverride(base, 'operatingSystem', 'Windows 11 Pro', {
      updatedBy: 'antwan', reason: 'Confirmed during IR', folderId: 'case-1', now: 1234,
    });
    expect(overrides!.operatingSystem).toEqual({
      value: 'Windows 11 Pro', updatedAt: 1234, updatedBy: 'antwan',
      reason: 'Confirmed during IR', folderId: 'case-1',
    });
  });

  it('drops the override when the value returns to the imported one', () => {
    const withOverride = { ...base, overrides: setOverride(base, 'hostname', 'other', { now: 1 }) };
    expect(overriddenFields(withOverride)).toEqual(['hostname']);
    const reverted = setOverride(withOverride, 'hostname', 'host-a', { now: 2 });
    expect(reverted).toBeUndefined();
  });

  it('stores an empty string as a null clear', () => {
    const overrides = setOverride(base, 'hostname', '   ', { now: 1 });
    expect(overrides!.hostname!.value).toBeNull();
  });

  it('trims whitespace around a value', () => {
    expect(setOverride(base, 'hostname', '  host-b  ', { now: 1 })!.hostname!.value).toBe('host-b');
  });

  it('can correct a field that was empty on import', () => {
    const blank = makeAsset({ id: 'b' });
    expect(setOverride(blank, 'operatingSystem', 'VMware ESXi 7.0', { now: 1 })!.operatingSystem!.value)
      .toBe('VMware ESXi 7.0');
  });

  it('leaves other corrections untouched', () => {
    const first = { ...base, overrides: setOverride(base, 'hostname', 'h2', { now: 1 }) };
    const second = setOverride(first, 'operatingSystem', 'Windows 11 Pro', { now: 2 });
    expect(Object.keys(second!).sort()).toEqual(['hostname', 'operatingSystem']);
  });
});

describe('clearOverride', () => {
  it('reverts a single field and collapses an emptied map to undefined', () => {
    const base = makeAsset({ id: 'a', hostname: 'host-a' });
    const withOverride = { ...base, overrides: setOverride(base, 'hostname', 'wrong', { now: 1 }) };
    expect(clearOverride(withOverride, 'hostname')).toBeUndefined();
  });

  it('is a no-op for a field with no correction', () => {
    const asset = makeAsset({ id: 'a' });
    expect(clearOverride(asset, 'hostname')).toBeUndefined();
  });
});

describe('helpers', () => {
  it('reports the imported value behind a correction', () => {
    const asset = makeAsset({ id: 'a', primaryIp: '10.0.0.1' });
    expect(originalValue(asset, 'primaryIp')).toBe('10.0.0.1');
    expect(originalValue(asset, 'hostname')).toBeUndefined();
  });

  it('lists divergences for reporting back to the CMDB', () => {
    const base = makeAsset({ id: 'a', primaryIp: '10.0.0.1' });
    const asset = { ...base, overrides: setOverride(base, 'primaryIp', '10.0.0.9', { now: 1 }) };
    expect(divergentOverrides(asset)).toEqual([
      { field: 'primaryIp', override: expect.objectContaining({ value: '10.0.0.9' }), imported: '10.0.0.1' },
    ]);
  });

  it('guards the overridable field list', () => {
    expect(isOverridableField('operatingSystem')).toBe(true);
    expect(isOverridableField('id')).toBe(false);
    expect(isOverridableField('trashed')).toBe(false);
    expect(OVERRIDABLE_ASSET_FIELDS).not.toContain('id');
  });
});

// ── Survives re-import ──────────────────────────────────────────────

describe('corrections survive a CMDB re-import', () => {
  const HEADER = 'id,name,configuration_type_name,operating_system_name,primary_ip,mac_address';
  const ROW = '1,SRV-01,Managed Server,Windows (Other),10.0.0.5,00-50-56-BD-DB-1A';

  it('preserves overrides and analyst notes when the export is re-imported', () => {
    const first = parseAssetCSV(`${HEADER}\n${ROW}`, [], { now: 1000 });
    const asset = first.assets[0];

    const corrected: Asset = {
      ...asset,
      overrides: setOverride(asset, 'operatingSystem', 'VMware ESXi 7.0', { now: 1500, updatedBy: 'antwan' }),
      analystNotes: 'Confirmed hypervisor during INV-14.',
    };

    const second = parseAssetCSV(`${HEADER}\n${ROW}`, [corrected], { now: 2000 });
    expect(second.updated).toBe(1);
    const after = second.assets[0];

    expect(after.overrides?.operatingSystem?.value).toBe('VMware ESXi 7.0');
    expect(after.analystNotes).toBe('Confirmed hypervisor during INV-14.');
    // The base value still tracks the export.
    expect(after.operatingSystem).toBe('Windows (Other)');
    expect(resolveAsset(after).operatingSystem).toBe('VMware ESXi 7.0');
  });

  it('lets the correction stand even when the export changes the base value', () => {
    const first = parseAssetCSV(`${HEADER}\n${ROW}`, [], { now: 1000 });
    const asset = first.assets[0];
    const corrected: Asset = {
      ...asset,
      overrides: setOverride(asset, 'primaryIp', '10.0.0.99', { now: 1500 }),
    };

    const moved = ROW.replace('10.0.0.5', '10.0.0.7');
    const second = parseAssetCSV(`${HEADER}\n${moved}`, [corrected], { now: 2000 });
    const after = second.assets[0];

    expect(after.primaryIp).toBe('10.0.0.7');
    expect(resolveAsset(after).primaryIp).toBe('10.0.0.99');
    expect(divergentOverrides(after)[0].imported).toBe('10.0.0.7');
  });
});

// ── Corrections flow into matching ──────────────────────────────────

describe('corrections change matching results', () => {
  it('a corrected OS enters the attack surface', () => {
    const base = makeAsset({ id: 'a', operatingSystem: 'Windows (Other)' });
    expect(productsForAsset(base)).toEqual([]);

    const corrected = { ...base, overrides: setOverride(base, 'operatingSystem', 'VMware ESXi 6.7', { now: 1 }) };
    const products = productsForAsset(corrected);
    expect(products[0].product).toBe('esxi');

    const surface = buildAttackSurface([corrected], Date.parse('2026-07-26T00:00:00Z'));
    expect(surface.exposures[0].eol.status).toBe('eol');
    expect(surface.unidentifiedAssetIds).toEqual([]);
  });

  it('a corrected IP is what correlation matches on', () => {
    const base = makeAsset({ id: 'a', name: 'SRV', primaryIp: '10.0.0.1', ipAddresses: ['10.0.0.1'] });
    const corrected = { ...base, overrides: setOverride(base, 'primaryIp', '10.0.0.9', { now: 1 }) };
    const index = buildAssetIndex([corrected]);

    const hit = correlateObservable({ label: 'Source IP', kind: 'ip', value: '10.0.0.9' }, index);
    expect(hit?.tier).toBe('exact');
    expect(hit?.assetIds).toEqual(['a']);

    // The stale imported address no longer resolves to this asset.
    const stale = correlateObservable({ label: 'Source IP', kind: 'ip', value: '10.0.0.1' }, index);
    expect(stale?.tier).not.toBe('exact');
  });

  it('a corrected hostname is what correlation matches on', () => {
    const base = makeAsset({ id: 'a', name: 'OLD-NAME', hostname: 'old-name' });
    const corrected = { ...base, overrides: setOverride(base, 'hostname', 'true-name', { now: 1 }) };
    const index = buildAssetIndex([corrected]);
    const hit = correlateObservable({ label: 'Source Host', kind: 'hostname', value: 'true-name.corp.local' }, index);
    expect(hit?.tier).toBe('exact');
  });
});
