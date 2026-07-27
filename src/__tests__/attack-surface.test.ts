import { describe, it, expect } from 'vitest';
import {
  normalizeOperatingSystem,
  normalizeHardware,
  productsForAsset,
  toCPE,
  productKey,
} from '../lib/asset-products';
import { assessEol, EOL_DATASET, ENDING_SOON_DAYS } from '../lib/asset-eol';
import {
  buildAttackSurface,
  assessApplicability,
  parseThreatInput,
  parseCPE,
} from '../lib/attack-surface';
import type { Asset } from '../types';

const ASOF = Date.parse('2026-07-26T00:00:00Z');
const DAY = 86_400_000;

function makeAsset(p: Partial<Asset> & { id: string }): Asset {
  return {
    name: p.name ?? p.id,
    importedAt: 0, tags: [], trashed: false, archived: false,
    createdAt: 0, updatedAt: 0, ...p,
  };
}

// ── OS normalization ────────────────────────────────────────────────

describe('normalizeOperatingSystem', () => {
  it('parses Windows Server with edition and R2', () => {
    expect(normalizeOperatingSystem('Windows Server 2022 Standard')).toMatchObject({
      vendor: 'microsoft', product: 'windows_server_2022', edition: 'standard', displayName: 'Windows Server 2022',
    });
    expect(normalizeOperatingSystem('Windows Server 2012 R2 Datacenter')).toMatchObject({
      product: 'windows_server_2012_r2', edition: 'datacenter', displayName: 'Windows Server 2012 R2',
    });
    expect(normalizeOperatingSystem('Windows Server 2016')).toMatchObject({ product: 'windows_server_2016' });
  });

  it('folds client editions into one product', () => {
    for (const raw of ['Windows 10 Pro', 'Windows 10 Enterprise', 'Windows 10 Business', 'Windows 10']) {
      expect(normalizeOperatingSystem(raw)?.product).toBe('windows_10');
    }
  });

  it('retains the dot in Windows 8.1 to match CPE naming', () => {
    expect(normalizeOperatingSystem('Windows 8.1')?.product).toBe('windows_8.1');
    expect(normalizeOperatingSystem('Windows 8')?.product).toBe('windows_8');
  });

  it('parses ESXi with its version', () => {
    expect(normalizeOperatingSystem('VMware ESXi 6.7')).toMatchObject({
      vendor: 'vmware', product: 'esxi', version: '6.7',
    });
  });

  it('returns undefined rather than inventing a product', () => {
    expect(normalizeOperatingSystem('Windows (Other)')).toBeUndefined();
    expect(normalizeOperatingSystem('')).toBeUndefined();
    expect(normalizeOperatingSystem(undefined)).toBeUndefined();
  });
});

// ── Hardware normalization ──────────────────────────────────────────

describe('normalizeHardware', () => {
  it('normalizes vendor aliases', () => {
    expect(normalizeHardware('HP, Inc.', 'HP ProBook 450 G9')?.vendor).toBe('hp');
    expect(normalizeHardware('Hewlett Packard', 'HP ZBook 14')?.vendor).toBe('hp');
    expect(normalizeHardware('ExaGrid Systems, Inc.', 'EX40000E')?.vendor).toBe('exagrid');
  });

  it('infers the vendor from the model when the manufacturer is blank', () => {
    expect(normalizeHardware(undefined, 'UCS B200 M5')?.vendor).toBe('cisco');
    expect(normalizeHardware(undefined, 'N9K-C9364C')?.vendor).toBe('cisco');
    expect(normalizeHardware(undefined, 'HP EliteBook 840 G6')?.vendor).toBe('hp');
    expect(normalizeHardware('', 'OptiPlex 3050')?.vendor).toBe('dell');
  });

  it('rejects virtual machine models, which have no vendor advisories', () => {
    expect(normalizeHardware(undefined, 'VMware7,1')).toBeUndefined();
    expect(normalizeHardware(undefined, 'VMware Virtual Platform')).toBeUndefined();
    expect(normalizeHardware(undefined, 'VMware20,1')).toBeUndefined();
  });

  it('returns undefined when the vendor cannot be established', () => {
    expect(normalizeHardware(undefined, '80V5')).toBeUndefined();
    expect(normalizeHardware(undefined, undefined)).toBeUndefined();
  });
});

// ── Per-asset products ──────────────────────────────────────────────

describe('productsForAsset', () => {
  it('yields both OS and hardware products', () => {
    const products = productsForAsset(makeAsset({
      id: 'a', operatingSystem: 'Windows Server 2022 Standard',
      manufacturer: 'Cisco', model: 'UCS B200 M5',
    }));
    expect(products.map((p) => p.source)).toEqual(['os', 'hardware']);
  });

  it('prefers an explicit osVersion over the one parsed from the name', () => {
    const [os] = productsForAsset(makeAsset({ id: 'a', operatingSystem: 'Windows 11 Pro', osVersion: '24H2' }));
    expect(os.version).toBe('24H2');
  });

  it('yields nothing for a VM with an unrecognized OS', () => {
    expect(productsForAsset(makeAsset({ id: 'a', operatingSystem: 'Windows (Other)', model: 'VMware7,1' }))).toEqual([]);
  });
});

describe('toCPE / productKey', () => {
  it('builds an o-part CPE for an OS and h-part for hardware', () => {
    const os = normalizeOperatingSystem('Windows Server 2019 Standard')!;
    expect(toCPE(os)).toBe('cpe:2.3:o:microsoft:windows_server_2019:2019:*:*:*:standard:*:*:*');
    const hw = normalizeHardware('Cisco', 'UCS B200 M5')!;
    expect(toCPE(hw)).toMatch(/^cpe:2\.3:h:cisco:ucs_b200_m5:/);
  });

  it('keys by vendor, product and version', () => {
    expect(productKey(normalizeOperatingSystem('VMware ESXi 6.7')!)).toBe('vmware:esxi:6.7');
  });
});

// ── EOL ─────────────────────────────────────────────────────────────

describe('assessEol', () => {
  const os = (raw: string) => normalizeOperatingSystem(raw)!;

  it('reports products past both mainstream and extended support as eol', () => {
    const a = assessEol(os('Windows 7'), ASOF);
    expect(a.status).toBe('eol');
    expect(a.daysRemaining).toBeLessThan(0);
  });

  it('distinguishes extended-support-only from fully unsupported', () => {
    // Windows 10 mainstream ended 2025-10-14; ESU runs to 2028.
    expect(assessEol(os('Windows 10 Pro'), ASOF).status).toBe('extended-only');
    // Windows 7 ESU ended 2023.
    expect(assessEol(os('Windows 7'), ASOF).status).toBe('eol');
  });

  it('flags products approaching EOL', () => {
    const record = EOL_DATASET.find((r) => r.product === 'windows_server_2016')!;
    const justInside = record.eolDate - (ENDING_SOON_DAYS - 1) * DAY;
    expect(assessEol(os('Windows Server 2016'), justInside).status).toBe('ending-soon');
    const wellBefore = record.eolDate - (ENDING_SOON_DAYS + 60) * DAY;
    expect(assessEol(os('Windows Server 2016'), wellBefore).status).toBe('supported');
  });

  it('selects the EOL record matching the version cycle', () => {
    expect(assessEol(os('VMware ESXi 6.7'), ASOF).status).toBe('eol');
    expect(assessEol(os('VMware ESXi 8.0'), ASOF).status).toBe('supported');
  });

  it('returns unknown for products with no lifecycle record', () => {
    expect(assessEol(normalizeHardware('Cisco', 'UCS B200 M5')!, ASOF).status).toBe('unknown');
  });
});

// ── Attack surface rollup ───────────────────────────────────────────

describe('buildAttackSurface', () => {
  const inventory = [
    makeAsset({ id: 'w7', operatingSystem: 'Windows 7' }),
    makeAsset({ id: 'w10a', operatingSystem: 'Windows 10 Pro' }),
    makeAsset({ id: 'w10b', operatingSystem: 'Windows 10 Enterprise' }),
    makeAsset({ id: 'esxi', operatingSystem: 'VMware ESXi 6.7' }),
    makeAsset({ id: 'srv22', operatingSystem: 'Windows Server 2022 Standard' }),
    makeAsset({ id: 'blank', operatingSystem: 'Windows (Other)', model: 'VMware7,1' }),
    makeAsset({ id: 'gone', operatingSystem: 'Windows 7', trashed: true }),
  ];

  it('groups editions of the same product into one exposure', () => {
    const surface = buildAttackSurface(inventory, ASOF);
    const win10 = surface.exposures.find((e) => e.product.product === 'windows_10')!;
    expect(win10.assetIds.sort()).toEqual(['w10a', 'w10b']);
  });

  it('excludes trashed assets', () => {
    const surface = buildAttackSurface(inventory, ASOF);
    expect(surface.exposures.find((e) => e.product.product === 'windows_7')!.assetIds).toEqual(['w7']);
  });

  it('separates identified from unidentified assets', () => {
    const surface = buildAttackSurface(inventory, ASOF);
    expect(surface.unidentifiedAssetIds).toEqual(['blank']);
    expect(surface.coveredAssetIds).toHaveLength(5);
  });

  it('ranks worst support status first', () => {
    const surface = buildAttackSurface(inventory, ASOF);
    expect(surface.exposures[0].eol.status).toBe('eol');
    expect(surface.exposures.at(-1)!.eol.status).toBe('supported');
  });

  it('counts at-risk assets once even with several risky products', () => {
    const dual = [makeAsset({ id: 'x', operatingSystem: 'Windows 7', manufacturer: 'HP', model: 'HP EliteBook 840 G6' })];
    const surface = buildAttackSurface(dual, ASOF);
    expect(surface.atRiskAssetIds).toEqual(['x']);
  });

  it('handles an empty inventory', () => {
    const surface = buildAttackSurface([], ASOF);
    expect(surface.exposures).toEqual([]);
    expect(surface.atRiskAssetIds).toEqual([]);
  });
});

// ── Applicability ───────────────────────────────────────────────────

describe('assessApplicability', () => {
  const inventory = [
    makeAsset({ id: 's1', operatingSystem: 'Windows Server 2022 Standard' }),
    makeAsset({ id: 's2', operatingSystem: 'Windows Server 2022 Datacenter' }),
    makeAsset({ id: 'e67', operatingSystem: 'VMware ESXi 6.7' }),
    makeAsset({ id: 'e80', operatingSystem: 'VMware ESXi 8.0' }),
    makeAsset({ id: 'fw', manufacturer: 'Cisco', model: 'ASA 5525-X' }),
  ];

  it('matches a product family without a version constraint', () => {
    const report = assessApplicability({ vendor: 'microsoft', product: 'windows_server_2022' }, inventory);
    expect(report.affectedAssetIds.sort()).toEqual(['s1', 's2']);
    expect(report.matches[0].confidence).toBe('product');
  });

  it('respects a version constraint', () => {
    const report = assessApplicability({ vendor: 'vmware', product: 'esxi', versions: ['6.7'] }, inventory);
    expect(report.affectedAssetIds).toEqual(['e67']);
    expect(report.matches[0].confidence).toBe('exact');
  });

  it('treats a missing version constraint as all versions', () => {
    const report = assessApplicability({ vendor: 'vmware', product: 'esxi' }, inventory);
    expect(report.affectedAssetIds.sort()).toEqual(['e67', 'e80']);
  });

  it('matches version prefixes so 6.7 covers 6.7.0', () => {
    const detailed = [makeAsset({ id: 'p', operatingSystem: 'VMware ESXi 6.7', osVersion: '6.7.0' })];
    expect(assessApplicability({ product: 'esxi', versions: ['6.7'] }, detailed).affectedAssetIds).toEqual(['p']);
  });

  it('derives vendor and product from a CPE', () => {
    const report = assessApplicability({ cpe: 'cpe:2.3:o:vmware:esxi:6.7:*:*:*:*:*:*:*' }, inventory);
    expect(report.affectedAssetIds).toEqual(['e67']);
  });

  it('falls back to keyword matching and labels it as such', () => {
    const report = assessApplicability({ text: 'Cisco ASA remote code execution' }, inventory);
    expect(report.affectedAssetIds).toEqual(['fw']);
    expect(report.matches[0].confidence).toBe('keyword');
    expect(report.matches[0].rationale).toContain('verify');
  });

  it('reports indeterminate when nothing is matchable', () => {
    expect(assessApplicability({ id: 'CVE-2026-1' }, inventory).indeterminate).toBe(true);
    expect(assessApplicability({ text: 'a of the' }, inventory).indeterminate).toBe(true);
  });

  it('returns no matches for an unrelated product', () => {
    const report = assessApplicability({ vendor: 'oracle', product: 'database' }, inventory);
    expect(report.indeterminate).toBe(false);
    expect(report.affectedAssetIds).toEqual([]);
  });

  it('ignores trashed and archived assets', () => {
    const hidden = [
      makeAsset({ id: 'gone', operatingSystem: 'VMware ESXi 6.7', trashed: true }),
      makeAsset({ id: 'arch', operatingSystem: 'VMware ESXi 6.7', archived: true }),
    ];
    expect(assessApplicability({ product: 'esxi' }, hidden).affectedAssetIds).toEqual([]);
  });
});

// ── Input parsing ───────────────────────────────────────────────────

describe('parseThreatInput / parseCPE', () => {
  it('parses a CPE into components', () => {
    expect(parseCPE('cpe:2.3:o:microsoft:windows_10:22h2:*:*:*:pro:*:*:*'))
      .toEqual({ vendor: 'microsoft', product: 'windows_10', version: '22h2' });
    expect(parseCPE('cpe:2.3:o:vmware:esxi:*:*:*:*:*:*:*:*').version).toBeUndefined();
    expect(parseCPE('not a cpe')).toEqual({});
  });

  it('recognizes CPE input', () => {
    const d = parseThreatInput('cpe:2.3:o:vmware:esxi:6.7:*:*:*:*:*:*:*');
    expect(d.product).toBe('esxi');
    expect(d.versions).toEqual(['6.7']);
  });

  it('extracts a CVE id while keeping the text for matching', () => {
    const d = parseThreatInput('cve-2026-58531 SMB2 flaw in Windows Server 2022');
    expect(d.id).toBe('CVE-2026-58531');
    expect(d.text).toContain('Windows Server 2022');
  });

  it('handles empty input', () => {
    expect(parseThreatInput('   ')).toEqual({});
  });
});
