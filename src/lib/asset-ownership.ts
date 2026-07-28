import type { Asset, AssetOwnerType } from '../types';

export const ASSET_OWNER_TYPES: readonly AssetOwnerType[] = ['mssp', 'customer', 'unknown'];

/** Effective owner, treating an absent value as an explicit unknown. */
export function ownerType(asset: Asset): AssetOwnerType {
  return asset.owner ?? 'unknown';
}

/**
 * Stable grouping key. Customers are keyed by name so two customers never
 * collapse into one bucket, and an unnamed customer asset is kept distinct
 * from a fully unlabelled one — it is a different kind of incomplete.
 */
export function ownerKey(asset: Asset): string {
  const type = ownerType(asset);
  if (type !== 'customer') return type;
  const name = asset.customerName?.trim();
  return name ? `customer:${name}` : 'customer:(unnamed)';
}

/** Display label for an owner key produced by `ownerKey`. */
export function ownerKeyLabel(key: string, labels: { mssp: string; unknown: string; unnamed: string }): string {
  if (key === 'mssp') return labels.mssp;
  if (key === 'unknown') return labels.unknown;
  if (key === 'customer:(unnamed)') return labels.unnamed;
  return key.slice('customer:'.length);
}

/**
 * A selected owner scope. `all` disables filtering; `mssp`/`unknown` match the
 * type; anything else is a specific customer name.
 */
export type OwnerFilter = 'all' | 'mssp' | 'unknown' | 'customer' | { customerName: string };

export function matchesOwnerFilter(asset: Asset, filter: OwnerFilter): boolean {
  if (filter === 'all') return true;
  const type = ownerType(asset);
  if (typeof filter === 'object') {
    return type === 'customer' && (asset.customerName?.trim() ?? '') === filter.customerName;
  }
  return type === filter;
}

export function filterByOwner(assets: Asset[], filter: OwnerFilter): Asset[] {
  return filter === 'all' ? assets : assets.filter((a) => matchesOwnerFilter(a, filter));
}

/** Distinct customer names present in the inventory, sorted. */
export function customerNames(assets: Asset[]): string[] {
  const names = new Set<string>();
  for (const asset of assets) {
    if (ownerType(asset) !== 'customer') continue;
    const name = asset.customerName?.trim();
    if (name) names.add(name);
  }
  return [...names].sort((a, b) => a.localeCompare(b));
}

export interface OwnerCounts {
  mssp: number;
  customer: number;
  unknown: number;
  /** Per-customer counts, keyed by name. */
  byCustomer: Record<string, number>;
}

export function summarizeOwners(assets: Asset[]): OwnerCounts {
  const counts: OwnerCounts = { mssp: 0, customer: 0, unknown: 0, byCustomer: {} };
  for (const asset of assets) {
    const type = ownerType(asset);
    counts[type] += 1;
    if (type === 'customer') {
      const name = asset.customerName?.trim() || '(unnamed)';
      counts.byCustomer[name] = (counts.byCustomer[name] ?? 0) + 1;
    }
  }
  return counts;
}

/**
 * Normalize an ownership assignment.
 *
 * A customer name is only meaningful when the owner is a customer; clearing it
 * otherwise prevents a stale name lingering on an asset later reclassified as
 * the MSSP's own, where it would corrupt the per-customer rollups.
 */
export function normalizeOwnership(
  owner: AssetOwnerType,
  customerName?: string,
): Pick<Asset, 'owner' | 'customerName'> {
  if (owner !== 'customer') return { owner, customerName: undefined };
  return { owner, customerName: customerName?.trim() || undefined };
}
