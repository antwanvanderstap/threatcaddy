import type { AssetProduct } from './asset-products';

/**
 * End-of-life support dates for products we can normalize.
 *
 * This is a curated static dataset, not a live feed. Vendors do move these
 * dates (extensions, ESU programs, per-edition variation), so every record
 * carries a `verifiedAt` and the UI must present results as "check before you
 * act on this", never as authoritative. Records are intentionally conservative:
 * where an edition-specific date exists (LTSC, IoT), the mainstream date is
 * used and the divergence is called out in `note`.
 *
 * Keys are `AssetProduct.product`; `cycle` further narrows by version where a
 * product has several supported lines at once (ESXi 6.7 vs 8.0).
 */
export interface EolRecord {
  product: string;
  /** Matches AssetProduct.version. Omit when the product has a single line. */
  cycle?: string;
  /** Mainstream end of support, epoch ms. */
  eolDate: number;
  /** Paid/extended support end, where a program exists. */
  extendedSupportDate?: number;
  note?: string;
}

const D = (iso: string) => Date.parse(`${iso}T00:00:00Z`);

/** When this dataset was last reviewed against vendor lifecycle pages. */
export const EOL_DATASET_VERIFIED_AT = D('2026-07-26');

export const EOL_DATASET: EolRecord[] = [
  // ── Microsoft client ──────────────────────────────────────────────
  { product: 'windows_7', eolDate: D('2020-01-14'), extendedSupportDate: D('2023-01-10'), note: 'ESU program ended January 2023.' },
  { product: 'windows_8', eolDate: D('2016-01-12'), note: 'No ESU path; 8.1 was the required upgrade.' },
  { product: 'windows_8.1', eolDate: D('2023-01-10') },
  { product: 'windows_10', eolDate: D('2025-10-14'), extendedSupportDate: D('2028-10-10'), note: 'Consumer/Pro/Enterprise. LTSC editions have separate, later dates.' },
  { product: 'windows_11', eolDate: D('2031-10-14'), note: 'Per-release servicing applies; individual feature updates expire sooner.' },

  // ── Microsoft server ──────────────────────────────────────────────
  { product: 'windows_server_2008_r2', eolDate: D('2020-01-14'), extendedSupportDate: D('2023-01-10') },
  { product: 'windows_server_2012', eolDate: D('2023-10-10'), extendedSupportDate: D('2026-10-13') },
  { product: 'windows_server_2012_r2', eolDate: D('2023-10-10'), extendedSupportDate: D('2026-10-13') },
  { product: 'windows_server_2016', eolDate: D('2027-01-12') },
  { product: 'windows_server_2019', eolDate: D('2029-01-09') },
  { product: 'windows_server_2022', eolDate: D('2031-10-14') },

  // ── VMware ────────────────────────────────────────────────────────
  { product: 'esxi', cycle: '6.5', eolDate: D('2022-10-15') },
  { product: 'esxi', cycle: '6.7', eolDate: D('2022-10-15') },
  { product: 'esxi', cycle: '7.0', eolDate: D('2025-04-02') },
  { product: 'esxi', cycle: '8.0', eolDate: D('2027-10-11') },
];

export type EolStatus = 'supported' | 'ending-soon' | 'extended-only' | 'eol' | 'unknown';

export interface EolAssessment {
  status: EolStatus;
  record?: EolRecord;
  /** Days until (positive) or since (negative) the mainstream EOL date. */
  daysRemaining?: number;
}

/** Window before mainstream EOL at which a product is flagged as ending soon. */
export const ENDING_SOON_DAYS = 180;

const DAY_MS = 86_400_000;

function findRecord(product: AssetProduct): EolRecord | undefined {
  const candidates = EOL_DATASET.filter((r) => r.product === product.product);
  if (candidates.length === 0) return undefined;
  // Prefer an exact cycle match; fall back to the cycle-less record if one exists.
  if (product.version) {
    const exact = candidates.find((r) => r.cycle === product.version);
    if (exact) return exact;
  }
  return candidates.find((r) => !r.cycle);
}

/**
 * Assess a product's support status.
 *
 * `extended-only` is distinguished from `eol` deliberately: a Server 2012 R2
 * box under ESU is a very different remediation conversation from a Windows 7
 * box with no support path at all, and collapsing them loses that.
 */
export function assessEol(product: AssetProduct, asOf: number): EolAssessment {
  const record = findRecord(product);
  if (!record) return { status: 'unknown' };

  const daysRemaining = Math.floor((record.eolDate - asOf) / DAY_MS);

  if (asOf < record.eolDate) {
    return {
      status: daysRemaining <= ENDING_SOON_DAYS ? 'ending-soon' : 'supported',
      record,
      daysRemaining,
    };
  }

  if (record.extendedSupportDate && asOf < record.extendedSupportDate) {
    return { status: 'extended-only', record, daysRemaining };
  }

  return { status: 'eol', record, daysRemaining };
}

/** Severity ordering for sorting and rollups: worst first. */
export const EOL_STATUS_RANK: Record<EolStatus, number> = {
  eol: 0,
  'extended-only': 1,
  'ending-soon': 2,
  supported: 3,
  unknown: 4,
};
