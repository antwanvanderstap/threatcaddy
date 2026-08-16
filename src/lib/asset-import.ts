import Papa from 'papaparse';
import { nanoid } from 'nanoid';
import type { Asset, AssetOwnerType } from '../types';
import { normalizeOwnership } from './asset-ownership';
import { normalizeMac, parseIPv4 } from './asset-correlation';

export const MAX_ASSET_ROWS = 50_000;

export interface AssetImportResult {
  assets: Asset[];
  created: number;
  updated: number;
  skipped: number;
  /** Rows skipped because their configuration type is not a technical asset. */
  skippedNonTechnical: number;
  errors: string[];
  truncated: boolean;
}

/**
 * Configuration types that describe contracts, credentials or non-computing
 * items rather than technical assets.
 *
 * These are excluded at import so they cannot inflate attack-surface totals or
 * appear as inventory coverage gaps — a software licence has no OS and cannot
 * be exploited. The count is reported separately rather than dropped silently,
 * so the analyst can see the export contained more rows than the inventory.
 */
export const NON_TECHNICAL_TYPES = new Set([
  'sw/hw certs, licenses & warranties',
  'account information',
  'other',
  'miscellaneous',
  'contract',
  'agreement',
  'licensing',
  'warranty',
]);

/** True when a configuration_type_name denotes a non-technical record. */
export function isNonTechnicalType(assetType: string | undefined): boolean {
  if (!assetType) return false;
  return NON_TECHNICAL_TYPES.has(assetType.trim().toLowerCase());
}

/**
 * Header aliases across the CMDB exports we support. Keys are the canonical
 * Asset field; values are lowercased source headers, most-specific first.
 * ITGlue and ConnectWise Manage both export the `configurations` shape; Datto
 * and Automate prefix their columns (`rmm_*`, `datto_*`) and are used as
 * fallbacks when the primary column is blank.
 */
const FIELD_ALIASES: Record<string, string[]> = {
  externalId: ['id', 'configuration_id', 'external_id'],
  name: ['name', 'configuration_name', 'friendly_name'],
  hostname: ['hostname', 'rmm_name', 'computer_name', 'device_name'],
  status: ['configuration_status_name', 'status', 'state'],
  assetType: ['configuration_type_name', 'type', 'device_type', 'rmm_device_type'],
  operatingSystem: ['operating_system_name', 'operating_system', 'os', 'rmm_operating_system', 'datto_operating_system'],
  osVersion: ['operating_system_version', 'os_version', 'os_build', 'version'],
  osNotes: ['operating_system_notes', 'os_notes'],
  firmwareVersion: ['firmware_version', 'firmware', 'dnet_firmware'],
  patchesApplied: ['rmm_patches_applied', 'patches_applied'],
  patchesTotal: ['rmm_patches_total', 'patches_total'],
  primaryIp: ['primary_ip', 'ip_address', 'ipv4', 'ip'],
  macAddress: ['mac_address', 'mac', 'physical_address'],
  serialNumber: ['serial_number', 'serial', 'rmm_serial_number', 'datto_appliance_serial_number'],
  assetTag: ['asset_tag', 'tag', 'barcode'],
  manufacturer: ['manufacturer_name', 'manufacturer', 'rmm_manufacturer_name', 'vendor'],
  model: ['model_name', 'model'],
  location: ['location_name', 'location', 'site', 'site_name'],
  contactName: ['contact_name', 'contact', 'assigned_to', 'user'],
  notes: ['notes', 'description', 'comment'],
  archivedInSource: ['archived'],
  warrantyExpiresAt: ['warranty_expires_at', 'warranty_expiration', 'warranty_end'],
  purchasedAt: ['purchased_at', 'purchase_date'],
  installedAt: ['installed_at', 'install_date'],
  sourceUpdatedAt: ['updated_at', 'last_updated', 'modified_at'],
};

/** Resolve a canonical field from a row using the alias list, first non-empty wins. */
function pick(row: Record<string, string>, field: string): string | undefined {
  for (const alias of FIELD_ALIASES[field] ?? []) {
    const value = row[alias];
    if (value !== undefined && value !== null && String(value).trim() !== '') {
      return String(value).trim();
    }
  }
  return undefined;
}

function parseDate(value: string | undefined): number | undefined {
  if (!value) return undefined;
  const ms = Date.parse(value);
  return Number.isNaN(ms) ? undefined : ms;
}

function parseInt10(value: string | undefined): number | undefined {
  if (!value) return undefined;
  const n = Number.parseInt(value, 10);
  return Number.isFinite(n) ? n : undefined;
}

function parseBool(value: string | undefined): boolean | undefined {
  if (!value) return undefined;
  const lower = value.toLowerCase();
  if (lower === 'yes' || lower === 'true' || lower === '1') return true;
  if (lower === 'no' || lower === 'false' || lower === '0') return false;
  return undefined;
}

/**
 * Build a stable identity key so re-importing an updated export patches the
 * existing record instead of duplicating it. Prefers the source system's own id;
 * falls back to serial, then MAC, then name+IP.
 */
export function assetIdentityKey(asset: Pick<Asset, 'externalId' | 'serialNumber' | 'macAddress' | 'name' | 'primaryIp'>): string {
  if (asset.externalId) return `ext:${asset.externalId}`;
  const serial = asset.serialNumber?.trim().toLowerCase();
  if (serial && !serial.startsWith('vmware')) return `sn:${serial}`;
  const mac = asset.macAddress ? normalizeMac(asset.macAddress) : undefined;
  if (mac) return `mac:${mac}`;
  return `name:${asset.name.trim().toLowerCase()}|${asset.primaryIp ?? ''}`;
}

type MatchableAsset = Pick<
  Asset,
  'externalId' | 'externalIds' | 'serialNumber' | 'macAddress' | 'name' | 'primaryIp'
>;

/**
 * Every key an asset can be recognised by, most trustworthy first.
 *
 * A single key is not enough once a second source system is involved: the same
 * server is configuration 4821 in ITGlue and 1173 in ConnectWise, so an
 * id-only match would import it twice. Falling back to serial, then MAC, lets
 * a ConnectWise sync land on the record the CSV import already created.
 *
 * Source-scoped ids (`ext:connectwise:1173`) never collide across systems. The
 * bare `ext:` key is retained for records imported before ids were scoped.
 */
export function assetMatchKeys(asset: MatchableAsset): string[] {
  const keys: string[] = [];

  for (const [source, id] of Object.entries(asset.externalIds ?? {})) {
    if (id) keys.push(`ext:${source}:${id}`);
  }
  if (asset.externalId) keys.push(`ext:${asset.externalId}`);

  const serial = asset.serialNumber?.trim().toLowerCase();
  // VMware BIOS UUIDs repeat across guests on a host, so they identify the
  // hypervisor rather than the VM and would merge unrelated machines.
  if (serial && !serial.startsWith('vmware')) keys.push(`sn:${serial}`);

  const mac = asset.macAddress ? normalizeMac(asset.macAddress) : undefined;
  if (mac) keys.push(`mac:${mac}`);

  keys.push(`name:${asset.name.trim().toLowerCase()}|${asset.primaryIp ?? ''}`);
  return keys;
}

export interface MergeAssetsOptions {
  now: number;
  includeNonTechnical?: boolean;
  /** Declared owner for this batch, when the source cannot supply one. */
  owner?: AssetOwnerType;
  customerName?: string;
  /**
   * Set when the source carries ownership per record (ConnectWise knows which
   * company each configuration belongs to). Each draft's own owner then wins
   * over any batch-level declaration.
   */
  ownerFromSource?: boolean;
}

export interface MergeAssetsResult {
  assets: Asset[];
  created: number;
  updated: number;
  skipped: number;
  skippedNonTechnical: number;
}

/**
 * Merge freshly-mapped drafts into the existing inventory.
 *
 * Shared by every import path — CSV and ConnectWise both land here — because
 * the rule about which fields survive a re-import is the one piece of this
 * system that silently destroys analyst work when it drifts.
 */
export function mergeAssetDrafts(
  drafts: Array<Omit<Asset, 'id'>>,
  existing: Asset[],
  opts: MergeAssetsOptions,
): MergeAssetsResult {
  const importedAt = opts.now;

  // Index every existing asset under all of its keys so a draft carrying only
  // a serial can still find a record that was imported with an id.
  const existingByKey = new Map<string, Asset>();
  for (const asset of existing) {
    for (const key of assetMatchKeys(asset)) {
      if (!existingByKey.has(key)) existingByKey.set(key, asset);
    }
  }

  const result: Asset[] = [];
  const consumed = new Set<string>();
  let created = 0;
  let updated = 0;
  let skipped = 0;
  let skippedNonTechnical = 0;

  for (const draft of drafts) {
    if (!opts.includeNonTechnical && isNonTechnicalType(draft.assetType)) {
      skippedNonTechnical++;
      continue;
    }

    const keys = assetMatchKeys(draft);
    // Two drafts resolving to the same record means the export listed the
    // device twice; the first one wins rather than both being written.
    if (keys.some((k) => consumed.has(k))) {
      skipped++;
      continue;
    }

    const priorKey = keys.find((k) => existingByKey.has(k));
    const prior = priorKey ? existingByKey.get(priorKey) : undefined;

    if (prior) {
      // Claim every key of both records so a later draft cannot merge into the
      // same asset by a weaker key.
      for (const k of [...keys, ...assetMatchKeys(prior)]) consumed.add(k);

      result.push({
        ...prior,
        ...draft,
        id: prior.id,
        // Each source keeps its own id; overwriting would make the next sync
        // from the other system fail to recognise this record.
        externalIds: { ...prior.externalIds, ...draft.externalIds },
        externalId: prior.externalId ?? draft.externalId,
        tags: prior.tags,
        clsLevel: prior.clsLevel,
        linkedFolderIds: prior.linkedFolderIds ?? [],
        linkedIOCIds: prior.linkedIOCIds,
        // Analyst corrections survive re-import by design: the export is
        // authoritative for the base record, the overlay for what an
        // investigation established. Dropping these here would silently
        // discard investigation findings on the next CMDB sync.
        overrides: prior.overrides,
        analystNotes: prior.analystNotes,
        // An import that declares an owner is authoritative for it (you are
        // re-importing that organization's file), as is a source that carries
        // ownership per record. An import that does neither must leave an
        // existing assignment alone rather than resetting it to unknown.
        ...(opts.ownerFromSource
          ? { owner: draft.owner, customerName: draft.customerName }
          : opts.owner
            ? normalizeOwnership(opts.owner, opts.customerName)
            : { owner: prior.owner, customerName: prior.customerName }),
        trashed: prior.trashed,
        trashedAt: prior.trashedAt,
        archived: prior.archived,
        createdBy: prior.createdBy,
        createdAt: prior.createdAt,
        updatedAt: importedAt,
      });
      updated++;
    } else {
      for (const k of keys) consumed.add(k);
      result.push({ ...draft, id: nanoid() });
      created++;
    }
  }

  return { assets: result, created, updated, skipped, skippedNonTechnical };
}

/** Map one parsed CSV row to an Asset draft. Returns undefined for unusable rows. */
export function rowToAsset(
  row: Record<string, string>,
  opts: { source?: string; importedAt: number; createdBy?: string; owner?: AssetOwnerType; customerName?: string },
): Omit<Asset, 'id'> | undefined {
  const name = pick(row, 'name');
  if (!name) return undefined;

  const primaryIpRaw = pick(row, 'primaryIp');
  const primaryIp = primaryIpRaw && parseIPv4(primaryIpRaw) ? primaryIpRaw : undefined;

  const macRaw = pick(row, 'macAddress');
  const macAddress = macRaw && normalizeMac(macRaw) ? macRaw : undefined;

  const now = opts.importedAt;

  return {
    externalId: pick(row, 'externalId'),
    name,
    hostname: pick(row, 'hostname'),
    status: pick(row, 'status'),
    assetType: pick(row, 'assetType'),
    operatingSystem: pick(row, 'operatingSystem'),
    osVersion: pick(row, 'osVersion'),
    osNotes: pick(row, 'osNotes'),
    firmwareVersion: pick(row, 'firmwareVersion'),
    patchesApplied: parseInt10(pick(row, 'patchesApplied')),
    patchesTotal: parseInt10(pick(row, 'patchesTotal')),
    primaryIp,
    ipAddresses: primaryIp ? [primaryIp] : [],
    macAddress,
    macAddresses: macAddress ? [macAddress] : [],
    serialNumber: pick(row, 'serialNumber'),
    assetTag: pick(row, 'assetTag'),
    manufacturer: pick(row, 'manufacturer'),
    model: pick(row, 'model'),
    location: pick(row, 'location'),
    contactName: pick(row, 'contactName'),
    notes: pick(row, 'notes'),
    archivedInSource: parseBool(pick(row, 'archivedInSource')),
    warrantyExpiresAt: parseDate(pick(row, 'warrantyExpiresAt')),
    purchasedAt: parseDate(pick(row, 'purchasedAt')),
    installedAt: parseDate(pick(row, 'installedAt')),
    sourceUpdatedAt: parseDate(pick(row, 'sourceUpdatedAt')),
    ...normalizeOwnership(opts.owner ?? 'unknown', opts.customerName),
    source: opts.source,
    importedAt: now,
    linkedFolderIds: [],
    tags: [],
    trashed: false,
    archived: false,
    createdBy: opts.createdBy,
    createdAt: now,
    updatedAt: now,
  };
}

/**
 * Parse a CMDB CSV export into Asset records, merging against any existing
 * inventory so a re-import updates in place.
 */
export function parseAssetCSV(
  text: string,
  existing: Asset[] = [],
  opts: {
    source?: string;
    createdBy?: string;
    now?: number;
    includeNonTechnical?: boolean;
    /** Declared owner for this file. A CMDB export is per-organization, so
     *  ownership is stated at import rather than read from a column. */
    owner?: AssetOwnerType;
    customerName?: string;
  } = {},
): AssetImportResult {
  const errors: string[] = [];
  const importedAt = opts.now ?? Date.now();

  const parsed = Papa.parse<Record<string, string>>(text, {
    header: true,
    skipEmptyLines: true,
    transformHeader: (header) => header.trim().toLowerCase(),
  });

  if (parsed.errors.length > 0) {
    // Papa reports per-row recoverable issues; surface a bounded sample.
    for (const err of parsed.errors.slice(0, 5)) {
      errors.push(`Row ${err.row ?? '?'}: ${err.message}`);
    }
  }

  const allRows = parsed.data ?? [];
  const truncated = allRows.length > MAX_ASSET_ROWS;
  const rows = truncated ? allRows.slice(0, MAX_ASSET_ROWS) : allRows;

  const drafts: Array<Omit<Asset, 'id'>> = [];
  let unusable = 0;

  for (const row of rows) {
    const draft = rowToAsset(row, {
      source: opts.source,
      importedAt,
      createdBy: opts.createdBy,
      owner: opts.owner,
      customerName: opts.customerName,
    });
    if (!draft) {
      unusable++;
      continue;
    }
    drafts.push(draft);
  }

  const merged = mergeAssetDrafts(drafts, existing, {
    now: importedAt,
    includeNonTechnical: opts.includeNonTechnical,
    owner: opts.owner,
    customerName: opts.customerName,
  });

  return {
    ...merged,
    skipped: merged.skipped + unusable,
    errors,
    truncated,
  };
}
