import type { Asset, AssetFieldOverride, OverridableAssetField } from '../types';

/**
 * Runtime list of overridable fields, in the order the detail panel shows them.
 *
 * The `satisfies` clause ties this to the OverridableAssetField union, so
 * adding a field to one and not the other is a compile error rather than a
 * field that silently cannot be edited.
 */
export const OVERRIDABLE_ASSET_FIELDS = [
  'name',
  'hostname',
  'status',
  'assetType',
  'operatingSystem',
  'osVersion',
  'osNotes',
  'firmwareVersion',
  'primaryIp',
  'macAddress',
  'serialNumber',
  'assetTag',
  'manufacturer',
  'model',
  'location',
  'contactName',
  'notes',
] as const satisfies readonly OverridableAssetField[];

/** Fields whose corrections change correlation or attack-surface results. */
export const MATCH_AFFECTING_FIELDS: readonly OverridableAssetField[] = [
  'hostname', 'primaryIp', 'macAddress', 'serialNumber', 'assetTag',
  'operatingSystem', 'osVersion', 'manufacturer', 'model',
];

export function isOverridableField(field: string): field is OverridableAssetField {
  return (OVERRIDABLE_ASSET_FIELDS as readonly string[]).includes(field);
}

/**
 * Apply an asset's analyst overrides over its imported values.
 *
 * Every read path that displays or matches on asset data must go through this.
 * Reading the base fields directly silently ignores analyst corrections, which
 * is the exact failure this overlay exists to prevent.
 *
 * Returns the original object when there is nothing to apply, so callers can
 * rely on referential equality for memoization.
 */
export function resolveAsset(asset: Asset): Asset {
  const overrides = asset.overrides;
  if (!overrides) return asset;

  const entries = Object.entries(overrides) as [OverridableAssetField, AssetFieldOverride][];
  if (entries.length === 0) return asset;

  const resolved: Record<string, unknown> = { ...asset };
  for (const [field, override] of entries) {
    // null is a deliberate clear; undefined removes the field entirely so
    // downstream `if (asset.x)` checks behave as though it was never set.
    resolved[field] = override.value === null ? undefined : override.value;
  }
  // Derived arrays must follow the corrected scalar, or an override on
  // primaryIp would leave the stale address still indexed for correlation.
  const primaryIp = resolved.primaryIp as string | undefined;
  if (overrides.primaryIp) {
    resolved.ipAddresses = primaryIp ? [primaryIp] : [];
  }
  const macAddress = resolved.macAddress as string | undefined;
  if (overrides.macAddress) {
    resolved.macAddresses = macAddress ? [macAddress] : [];
  }
  return resolved as unknown as Asset;
}

/** Resolve a list, preserving order. */
export function resolveAssets(assets: Asset[]): Asset[] {
  return assets.map(resolveAsset);
}

/** The imported value a correction is layered over, for "was / now" display. */
export function originalValue(asset: Asset, field: OverridableAssetField): string | undefined {
  const value = asset[field];
  return value == null ? undefined : String(value);
}

/** Fields currently carrying a correction. */
export function overriddenFields(asset: Asset): OverridableAssetField[] {
  if (!asset.overrides) return [];
  return (Object.keys(asset.overrides) as OverridableAssetField[])
    .filter((field) => asset.overrides?.[field] !== undefined);
}

export interface SetOverrideOptions {
  updatedBy?: string;
  reason?: string;
  folderId?: string;
  now?: number;
}

/**
 * Build the overrides map resulting from correcting one field.
 *
 * Setting a field back to its imported value removes the override rather than
 * storing a redundant one, so the panel never shows a field as "corrected"
 * when it in fact agrees with the CMDB.
 */
export function setOverride(
  asset: Asset,
  field: OverridableAssetField,
  value: string | null,
  options: SetOverrideOptions = {},
): Asset['overrides'] {
  const next = { ...(asset.overrides ?? {}) };
  const trimmed = typeof value === 'string' ? value.trim() : value;
  const normalized = trimmed === '' ? null : trimmed;
  const imported = originalValue(asset, field);

  if ((normalized ?? undefined) === imported) {
    delete next[field];
    return Object.keys(next).length > 0 ? next : undefined;
  }

  next[field] = {
    value: normalized,
    updatedAt: options.now ?? Date.now(),
    updatedBy: options.updatedBy,
    reason: options.reason?.trim() || undefined,
    folderId: options.folderId,
  };
  return next;
}

/** Remove a correction, reverting the field to its imported value. */
export function clearOverride(asset: Asset, field: OverridableAssetField): Asset['overrides'] {
  if (!asset.overrides?.[field]) return asset.overrides;
  const next = { ...asset.overrides };
  delete next[field];
  return Object.keys(next).length > 0 ? next : undefined;
}

/**
 * Corrections that disagree with a freshly imported record.
 *
 * Surfacing these lets an analyst either push the fix upstream to the CMDB or
 * retire an override the source system has since caught up with.
 */
export function divergentOverrides(asset: Asset): {
  field: OverridableAssetField;
  override: AssetFieldOverride;
  imported?: string;
}[] {
  return overriddenFields(asset).map((field) => ({
    field,
    override: asset.overrides![field]!,
    imported: originalValue(asset, field),
  }));
}
