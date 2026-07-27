import Papa from 'papaparse';
import { nanoid } from 'nanoid';
import type { Asset } from '../types';
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

/** Map one parsed CSV row to an Asset draft. Returns undefined for unusable rows. */
export function rowToAsset(
  row: Record<string, string>,
  opts: { source?: string; importedAt: number; createdBy?: string },
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
  opts: { source?: string; createdBy?: string; now?: number; includeNonTechnical?: boolean } = {},
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

  const existingByKey = new Map<string, Asset>();
  for (const asset of existing) existingByKey.set(assetIdentityKey(asset), asset);

  const result: Asset[] = [];
  const seenKeys = new Set<string>();
  let created = 0;
  let updated = 0;
  let skipped = 0;
  let skippedNonTechnical = 0;

  for (const row of rows) {
    const draft = rowToAsset(row, { source: opts.source, importedAt, createdBy: opts.createdBy });
    if (!draft) {
      skipped++;
      continue;
    }

    if (!opts.includeNonTechnical && isNonTechnicalType(draft.assetType)) {
      skippedNonTechnical++;
      continue;
    }

    const key = assetIdentityKey(draft);
    if (seenKeys.has(key)) {
      skipped++;
      continue;
    }
    seenKeys.add(key);

    const prior = existingByKey.get(key);
    if (prior) {
      // Preserve analyst-owned fields; the CMDB export is authoritative only
      // for the inventory facts it actually carries.
      result.push({
        ...prior,
        ...draft,
        id: prior.id,
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
        trashed: prior.trashed,
        trashedAt: prior.trashedAt,
        archived: prior.archived,
        createdBy: prior.createdBy,
        createdAt: prior.createdAt,
        updatedAt: importedAt,
      });
      updated++;
    } else {
      result.push({ ...draft, id: nanoid() });
      created++;
    }
  }

  return { assets: result, created, updated, skipped, skippedNonTechnical, errors, truncated };
}
