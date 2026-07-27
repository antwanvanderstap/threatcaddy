import type { Asset } from '../types';
import {
  productsForAsset,
  productKey,
  toCPE,
  type AssetProduct,
} from './asset-products';
import { assessEol, EOL_STATUS_RANK, type EolAssessment, type EolStatus } from './asset-eol';

// ---------------------------------------------------------------------------
// Inventory rollup
// ---------------------------------------------------------------------------

export interface ProductExposure {
  key: string;
  product: AssetProduct;
  cpe: string;
  assetIds: string[];
  eol: EolAssessment;
}

export interface AttackSurface {
  /** One row per distinct product+version, worst support status first. */
  exposures: ProductExposure[];
  /** Assets contributing at least one recognized product. */
  coveredAssetIds: string[];
  /** Assets with no recognizable product — the blind spot in the inventory. */
  unidentifiedAssetIds: string[];
  counts: Record<EolStatus, number>;
  /** Assets running at least one product that is EOL or extended-support-only. */
  atRiskAssetIds: string[];
  asOf: number;
}

/**
 * Build the attack surface view of an inventory.
 *
 * Counts are per-asset, not per-product, for the risk figures: an asset running
 * two EOL products is one at-risk machine, not two. Per-product counts stay
 * available on each exposure row.
 */
export function buildAttackSurface(assets: Asset[], asOf: number): AttackSurface {
  const active = assets.filter((a) => !a.trashed && !a.archived);
  const byKey = new Map<string, ProductExposure>();
  const covered = new Set<string>();
  const atRisk = new Set<string>();

  for (const asset of active) {
    const products = productsForAsset(asset);
    if (products.length === 0) continue;
    covered.add(asset.id);

    for (const product of products) {
      const key = productKey(product);
      let exposure = byKey.get(key);
      if (!exposure) {
        exposure = {
          key,
          product,
          cpe: toCPE(product),
          assetIds: [],
          eol: assessEol(product, asOf),
        };
        byKey.set(key, exposure);
      }
      if (!exposure.assetIds.includes(asset.id)) exposure.assetIds.push(asset.id);
      if (exposure.eol.status === 'eol' || exposure.eol.status === 'extended-only') {
        atRisk.add(asset.id);
      }
    }
  }

  const exposures = [...byKey.values()].sort((a, b) => {
    const rank = EOL_STATUS_RANK[a.eol.status] - EOL_STATUS_RANK[b.eol.status];
    if (rank !== 0) return rank;
    return b.assetIds.length - a.assetIds.length;
  });

  const counts: Record<EolStatus, number> = {
    eol: 0, 'extended-only': 0, 'ending-soon': 0, supported: 0, unknown: 0,
  };
  for (const exposure of exposures) counts[exposure.eol.status] += exposure.assetIds.length;

  return {
    exposures,
    coveredAssetIds: [...covered],
    unidentifiedAssetIds: active.filter((a) => !covered.has(a.id)).map((a) => a.id),
    counts,
    atRiskAssetIds: [...atRisk],
    asOf,
  };
}

// ---------------------------------------------------------------------------
// Threat applicability
// ---------------------------------------------------------------------------

/**
 * A threat expressed in terms that can be matched against the inventory.
 *
 * Sources differ in precision, so every field is optional and the matcher
 * degrades gracefully: a CPE gives an exact answer, a vendor+product pair gives
 * a family-level answer, and free text gives a keyword answer that must be
 * treated as a lead rather than a finding.
 */
export interface ThreatDescriptor {
  /** Identifier for display: 'CVE-2026-58531', 'VMSA-2026-0012'. */
  id?: string;
  cpe?: string;
  vendor?: string;
  product?: string;
  /** Affected versions. Empty/absent means all versions of the product. */
  versions?: string[];
  /** Raw advisory title or description, used for keyword fallback. */
  text?: string;
}

export type ApplicabilityConfidence = 'exact' | 'product' | 'keyword';

export interface ApplicabilityMatch {
  assetId: string;
  product: AssetProduct;
  confidence: ApplicabilityConfidence;
  rationale: string;
}

export interface ApplicabilityReport {
  descriptor: ThreatDescriptor;
  matches: ApplicabilityMatch[];
  affectedAssetIds: string[];
  /** True when the descriptor carried nothing matchable. */
  indeterminate: boolean;
}

/** Split a CPE 2.3 URI into its vendor/product/version components. */
export function parseCPE(cpe: string): { vendor?: string; product?: string; version?: string } {
  const parts = cpe.split(':');
  if (parts[0] !== 'cpe' || parts[1] !== '2.3') return {};
  const clean = (value: string | undefined) =>
    value && value !== '*' && value !== '-' ? value.toLowerCase() : undefined;
  return { vendor: clean(parts[3]), product: clean(parts[4]), version: clean(parts[5]) };
}

function versionMatches(assetVersion: string | undefined, threatVersions: string[] | undefined): boolean {
  // No version constraint means every version of the product is affected.
  if (!threatVersions || threatVersions.length === 0) return true;
  if (!assetVersion) return false;
  const normalized = assetVersion.toLowerCase();
  return threatVersions.some((v) => {
    const t = v.toLowerCase();
    // Prefix match so "6.7" covers "6.7.0 build 12345".
    return normalized === t || normalized.startsWith(`${t}.`) || t.startsWith(`${normalized}.`);
  });
}

/**
 * Determine which assets a threat applies to.
 *
 * Matching is tiered by how much the descriptor actually pins down, and the
 * tier is reported rather than hidden — a keyword hit on an advisory title is
 * a lead to verify, not a confirmed exposure, and the UI must be able to say so.
 */
export function assessApplicability(
  descriptor: ThreatDescriptor,
  assets: Asset[],
  options: { keywordMinLength?: number } = {},
): ApplicabilityReport {
  const active = assets.filter((a) => !a.trashed && !a.archived);
  const fromCpe = descriptor.cpe ? parseCPE(descriptor.cpe) : {};
  const vendor = (descriptor.vendor ?? fromCpe.vendor)?.toLowerCase();
  const product = (descriptor.product ?? fromCpe.product)?.toLowerCase();
  const versions = descriptor.versions ?? (fromCpe.version ? [fromCpe.version] : undefined);

  const keywordMinLength = options.keywordMinLength ?? 4;
  const keywords = descriptor.text
    ? [...new Set(
        descriptor.text
          .toLowerCase()
          .split(/[^a-z0-9.]+/)
          .filter((w) => w.length >= keywordMinLength),
      )]
    : [];

  const hasStructured = Boolean(vendor || product);
  if (!hasStructured && keywords.length === 0) {
    return { descriptor, matches: [], affectedAssetIds: [], indeterminate: true };
  }

  const matches: ApplicabilityMatch[] = [];

  for (const asset of active) {
    for (const assetProduct of productsForAsset(asset)) {
      if (hasStructured) {
        const vendorOk = !vendor || assetProduct.vendor === vendor;
        const productOk = !product || assetProduct.product === product;
        if (vendorOk && productOk) {
          if (!versionMatches(assetProduct.version, versions)) continue;
          const exact = Boolean(product) && versions !== undefined && versions.length > 0;
          matches.push({
            assetId: asset.id,
            product: assetProduct,
            confidence: exact ? 'exact' : 'product',
            rationale: exact
              ? `${assetProduct.displayName} matches ${product} ${versions?.join(', ')}`
              : `Runs ${assetProduct.displayName}, in the affected ${vendor ?? product} product family`,
          });
          continue;
        }
      }

      if (keywords.length > 0) {
        const haystack = `${assetProduct.displayName} ${assetProduct.raw}`.toLowerCase();
        const hit = keywords.find((k) => haystack.includes(k));
        if (hit) {
          matches.push({
            assetId: asset.id,
            product: assetProduct,
            confidence: 'keyword',
            rationale: `Advisory text mentions "${hit}", which appears in ${assetProduct.displayName} — verify before acting`,
          });
        }
      }
    }
  }

  const rank: Record<ApplicabilityConfidence, number> = { exact: 0, product: 1, keyword: 2 };
  matches.sort((a, b) => rank[a.confidence] - rank[b.confidence]);

  return {
    descriptor,
    matches,
    affectedAssetIds: [...new Set(matches.map((m) => m.assetId))],
    indeterminate: false,
  };
}

/**
 * Parse an analyst's free-text threat input into a descriptor.
 *
 * Accepts a bare CPE, a "vendor product version" triple, or prose. Recognizing
 * a CVE id alone does not identify a product — it is captured for display, and
 * the remaining text still drives matching.
 */
export function parseThreatInput(input: string): ThreatDescriptor {
  const text = input.trim();
  if (!text) return {};

  if (text.toLowerCase().startsWith('cpe:2.3:')) {
    const parsed = parseCPE(text);
    return { cpe: text, ...parsed, versions: parsed.version ? [parsed.version] : undefined };
  }

  const cve = /CVE-\d{4}-\d{4,}/i.exec(text);
  return { id: cve?.[0].toUpperCase(), text };
}
