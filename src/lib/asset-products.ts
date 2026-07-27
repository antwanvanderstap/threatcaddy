import type { Asset } from '../types';
import { resolveAsset } from './asset-overrides';

/**
 * A normalized product identity derived from an asset's free-text inventory
 * fields.
 *
 * CMDB exports describe the same product a dozen ways ("Windows Server 2022
 * Standard", "Windows Server 2022 Datacenter", "Windows (Other)"). Threat
 * intelligence describes it a different way again. This is the common ground
 * both sides get reduced to before any matching happens, so the applicability
 * engine never compares raw strings.
 *
 * Field names deliberately mirror CPE 2.3 components so that phase 3 (NVD/CVE
 * matching) can build a CPE from this without a second normalization pass.
 */
export interface AssetProduct {
  /** CPE-style vendor, lowercase underscore form: 'microsoft', 'vmware'. */
  vendor: string;
  /** CPE-style product: 'windows_10', 'windows_server_2022', 'esxi'. */
  product: string;
  /** Human-facing name: 'Windows Server 2022'. */
  displayName: string;
  /** Release/version when the source states one: '6.7', '2012_r2'. */
  version?: string;
  /** Edition qualifier: 'pro', 'standard', 'datacenter', 'home'. */
  edition?: string;
  /** Which asset field this was derived from. */
  source: 'os' | 'hardware' | 'firmware';
  /** The original string, kept for display and audit. */
  raw: string;
}

/** Lowercase, collapse punctuation and whitespace to single underscores. */
function slug(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '');
}

// ---------------------------------------------------------------------------
// Operating systems
// ---------------------------------------------------------------------------

const WINDOWS_SERVER_RE = /^windows\s+server\s+(\d{4})(?:\s+(r2))?\s*(standard|datacenter|essentials|foundation)?/i;
const WINDOWS_CLIENT_RE = /^windows\s+(\d{1,2}(?:\.\d)?)\s*(pro|professional|home|enterprise|business|education|ltsc)?/i;
const ESXI_RE = /^vmware\s+esxi\s+([\d.]+)/i;

/**
 * Normalize an `operatingSystem` string into a product identity.
 *
 * Returns undefined for values that carry no product signal ("Windows (Other)"),
 * because a false product identity is worse than an honest unknown: it would
 * silently place assets into an applicability bucket they may not belong in.
 */
export function normalizeOperatingSystem(raw: string | undefined): AssetProduct | undefined {
  if (!raw) return undefined;
  const value = raw.trim();
  if (!value) return undefined;

  const server = WINDOWS_SERVER_RE.exec(value);
  if (server) {
    const [, year, r2, edition] = server;
    const cycle = r2 ? `${year}_r2` : year;
    return {
      vendor: 'microsoft',
      product: `windows_server_${cycle}`,
      displayName: `Windows Server ${year}${r2 ? ' R2' : ''}`,
      version: cycle,
      edition: edition ? slug(edition) : undefined,
      source: 'os',
      raw: value,
    };
  }

  const client = WINDOWS_CLIENT_RE.exec(value);
  if (client) {
    const [, release, edition] = client;
    return {
      vendor: 'microsoft',
      // The dot is retained deliberately: CPE names this product
      // `windows_8.1`, and slugging it to `windows_8_1` would break both the
      // EOL lookup and any future NVD match.
      product: `windows_${release}`,
      displayName: `Windows ${release}`,
      version: release,
      edition: edition ? slug(edition) : undefined,
      source: 'os',
      raw: value,
    };
  }

  const esxi = ESXI_RE.exec(value);
  if (esxi) {
    return {
      vendor: 'vmware',
      product: 'esxi',
      displayName: `VMware ESXi ${esxi[1]}`,
      version: esxi[1],
      source: 'os',
      raw: value,
    };
  }

  // Unrecognized but non-empty: "Windows (Other)" and friends carry an edition
  // hint at best. Treat as unknown rather than inventing a product.
  return undefined;
}

// ---------------------------------------------------------------------------
// Hardware (vendor + model)
// ---------------------------------------------------------------------------

/** Manufacturer strings vary by export; fold the common aliases together. */
const VENDOR_ALIASES: Record<string, string> = {
  hp: 'hp',
  'hp_inc': 'hp',
  'hewlett_packard': 'hp',
  'hewlett_packard_enterprise': 'hpe',
  hpe: 'hpe',
  cisco: 'cisco',
  ibm: 'ibm',
  dell: 'dell',
  lenovo: 'lenovo',
  microsoft: 'microsoft',
  vmware: 'vmware',
  apc: 'apc',
  netgear: 'netgear',
  ubiquiti: 'ubiquiti',
  exagrid: 'exagrid',
  'exagrid_systems_inc': 'exagrid',
  'trend_micro': 'trendmicro',
  quest: 'quest',
};

/**
 * Model strings that indicate a virtual machine rather than real hardware.
 * These must not become products — a vendor advisory for "VMware7,1" is
 * meaningless, and they would otherwise dominate the hardware inventory.
 */
const VIRTUAL_MODEL_RE = /^(vmware|virtual\s+platform|vmware\d+,\d+|vmware\s+virtual)/i;

export function normalizeHardware(
  manufacturer: string | undefined,
  model: string | undefined,
): AssetProduct | undefined {
  const modelValue = model?.trim();
  if (!modelValue || VIRTUAL_MODEL_RE.test(modelValue)) return undefined;

  const rawVendor = manufacturer?.trim();
  const vendorSlug = rawVendor ? slug(rawVendor) : '';
  const vendor = VENDOR_ALIASES[vendorSlug] ?? vendorSlug;

  // Many rows carry a model but no manufacturer. Infer the vendor from the
  // model prefix where it is unambiguous, otherwise leave it unknown.
  const inferred = vendor || inferVendorFromModel(modelValue);
  if (!inferred) return undefined;

  return {
    vendor: inferred,
    product: slug(modelValue),
    displayName: modelValue,
    source: 'hardware',
    raw: rawVendor ? `${rawVendor} ${modelValue}` : modelValue,
  };
}

function inferVendorFromModel(model: string): string | undefined {
  const lower = model.toLowerCase();
  if (/^hp\b|^hpe\b|probook|elitebook|zbook|elitedesk|proliant|laserjet/.test(lower)) return 'hp';
  if (/^ucs|^n9k|^asa|nexus|catalyst|^ws-c|^fpr|^asr|^apic/.test(lower)) return 'cisco';
  if (/^optiplex|^inspiron|^poweredge|^latitude/.test(lower)) return 'dell';
  if (/^thinkpad|^thinkcentre/.test(lower)) return 'lenovo';
  if (/^surface/.test(lower)) return 'microsoft';
  if (/^ex\d|exagrid/.test(lower)) return 'exagrid';
  if (/^ap\d{4}/.test(lower)) return 'apc';
  if (/flashsystem|^x3650/.test(lower)) return 'ibm';
  return undefined;
}

// ---------------------------------------------------------------------------
// Per-asset product set
// ---------------------------------------------------------------------------

/**
 * Every product identity an asset exposes. An asset can contribute more than
 * one: a physical server running Windows contributes both the OS and the
 * hardware model, and each attracts different advisories.
 */
export function productsForAsset(rawAsset: Asset): AssetProduct[] {
  // Resolved here rather than at each call site: this is the single entry point
  // for attack-surface and applicability matching, so an analyst correcting an
  // OS immediately improves both without any caller needing to remember.
  const asset = resolveAsset(rawAsset);
  const products: AssetProduct[] = [];

  const os = normalizeOperatingSystem(asset.operatingSystem);
  if (os) {
    // Prefer an explicit osVersion over the one parsed out of the OS name.
    products.push(asset.osVersion ? { ...os, version: asset.osVersion } : os);
  }

  const hardware = normalizeHardware(asset.manufacturer, asset.model);
  if (hardware) products.push(hardware);

  return products;
}

/**
 * Build a CPE 2.3 URI for a product. Used by phase 3 (NVD matching) and shown
 * in the UI so an analyst can paste it straight into a vulnerability database.
 *
 * `part` follows CPE convention: 'o' for operating systems, 'h' for hardware.
 */
export function toCPE(product: AssetProduct): string {
  const part = product.source === 'os' ? 'o' : 'h';
  const version = product.version ? slug(product.version) : '*';
  const edition = product.edition ?? '*';
  return `cpe:2.3:${part}:${product.vendor}:${product.product}:${version}:*:*:*:${edition}:*:*:*`;
}

/** Stable grouping key: one bucket per product+version pair. */
export function productKey(product: AssetProduct): string {
  return `${product.vendor}:${product.product}:${product.version ?? '*'}`;
}
