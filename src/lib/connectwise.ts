/**
 * ConnectWise Manage (PSA) mapping layer.
 *
 * Pure functions only — URL building, credential assembly, and translation
 * between the CW REST shapes and ThreatCaddy entities. Nothing here performs
 * I/O; the caller owns transport so requests can go through the extension
 * bridge or the team server proxy like every other outbound call.
 */

import type { Asset, AssetOwnerType, IncidentSeverity } from '../types';
import { normalizeMac, parseIPv4 } from './asset-correlation';

/** Every CW Manage deployment serves the REST API under this path. */
export const CW_API_PATH = '/v4_6_release/apis/3.0';

/** CW rejects page sizes above this. */
export const CW_MAX_PAGE_SIZE = 1000;

/** Source key recorded on synced assets, and the namespace for their ids. */
export const CW_SOURCE = 'connectwise';

// ---------------------------------------------------------------------------
// Credentials
// ---------------------------------------------------------------------------

export interface ConnectWiseCredentials {
  /** Site host, e.g. `api-eu.myconnectwise.net` or an on-prem hostname. */
  site: string;
  /** CW company identifier (the one you log in with, not the display name). */
  companyId: string;
  publicKey: string;
  privateKey: string;
  /** Required on every request since CW's 2019 API changes. */
  clientId: string;
}

/**
 * Canonical API base for a site.
 *
 * Accepts what people actually paste — a bare host, a URL with or without
 * scheme, with or without the version path already appended — and produces one
 * form, so a trailing slash cannot turn into a `//` that CW 404s on.
 */
export function connectWiseBaseUrl(site: string): string {
  let value = site.trim().replace(/\/+$/, '');
  if (!value) throw new Error('ConnectWise site is required');
  if (!/^https?:\/\//i.test(value)) value = `https://${value}`;

  // Tolerate a site pasted with the API path already on it.
  const withoutApi = value.replace(new RegExp(`${CW_API_PATH}$`, 'i'), '');
  return `${withoutApi.replace(/\/+$/, '')}${CW_API_PATH}`;
}

/** The host a template must allowlist in `requiredDomains` to reach this site. */
export function connectWiseHost(site: string): string {
  return new URL(connectWiseBaseUrl(site)).host;
}

/**
 * Headers for an authenticated CW request.
 *
 * CW uses HTTP Basic with a composite username of `company+publicKey`, which
 * is why this cannot be expressed as a plain config field — see the `base64`
 * template filter for the equivalent inside an integration template.
 */
export function connectWiseAuthHeaders(creds: ConnectWiseCredentials): Record<string, string> {
  const raw = `${creds.companyId}+${creds.publicKey}:${creds.privateKey}`;
  const bytes = new TextEncoder().encode(raw);
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);

  return {
    Authorization: `Basic ${btoa(binary)}`,
    clientId: creds.clientId,
    Accept: 'application/json',
  };
}

/** True when every field needed to make a call is present. */
export function hasCompleteCredentials(
  creds: Partial<ConnectWiseCredentials> | undefined,
): creds is ConnectWiseCredentials {
  if (!creds) return false;
  return Boolean(
    creds.site?.trim() &&
    creds.companyId?.trim() &&
    creds.publicKey?.trim() &&
    creds.privateKey?.trim() &&
    creds.clientId?.trim(),
  );
}

// ---------------------------------------------------------------------------
// Request building
// ---------------------------------------------------------------------------

export interface CWQuery {
  page?: number;
  pageSize?: number;
  /** CW conditions expression, e.g. `status/name="Active"`. */
  conditions?: string;
  /** Restrict returned fields — CW configurations are large. */
  fields?: string[];
  orderBy?: string;
  childConditions?: string;
}

/** Build a CW endpoint URL with query parameters applied. */
export function connectWiseUrl(site: string, path: string, query: CWQuery = {}): string {
  const url = new URL(`${connectWiseBaseUrl(site)}${path.startsWith('/') ? path : `/${path}`}`);
  const { page, pageSize, conditions, fields, orderBy, childConditions } = query;

  if (page != null) url.searchParams.set('page', String(page));
  if (pageSize != null) {
    // Asking for more than CW allows is answered with an error, not a clamp.
    url.searchParams.set('pageSize', String(Math.min(pageSize, CW_MAX_PAGE_SIZE)));
  }
  if (conditions) url.searchParams.set('conditions', conditions);
  if (childConditions) url.searchParams.set('childConditions', childConditions);
  if (fields?.length) url.searchParams.set('fields', fields.join(','));
  if (orderBy) url.searchParams.set('orderBy', orderBy);

  return url.toString();
}

// ---------------------------------------------------------------------------
// CW response shapes (partial — only what we read)
// ---------------------------------------------------------------------------

interface CWRef {
  id?: number;
  name?: string;
  identifier?: string;
}

export interface CWConfiguration {
  id?: number;
  name?: string;
  type?: CWRef;
  status?: CWRef;
  company?: CWRef;
  site?: CWRef;
  contact?: CWRef;
  manufacturer?: CWRef;
  deviceIdentifier?: string;
  serialNumber?: string;
  modelNumber?: string;
  tagNumber?: string;
  ipAddress?: string;
  macAddress?: string;
  defaultGateway?: string;
  osType?: string;
  osInfo?: string;
  cpuSpeed?: string;
  ram?: string;
  notes?: string;
  vendorNotes?: string;
  activeFlag?: boolean;
  purchaseDate?: string;
  installationDate?: string;
  warrantyExpirationDate?: string;
  lastLoginName?: string;
  _info?: { lastUpdated?: string; updatedBy?: string };
}

export interface CWTicket {
  id?: number;
  summary?: string;
  initialDescription?: string;
  board?: CWRef;
  status?: CWRef;
  company?: CWRef;
  site?: CWRef;
  contact?: CWRef;
  owner?: CWRef;
  type?: CWRef;
  subType?: CWRef;
  priority?: CWRef & { sort?: number };
  severity?: string;
  impact?: string;
  dateEntered?: string;
  closedDate?: string;
  _info?: { lastUpdated?: string };
}

export interface CWCompany {
  id?: number;
  identifier?: string;
  name?: string;
  status?: CWRef;
}

// ---------------------------------------------------------------------------
// Ownership
// ---------------------------------------------------------------------------

export interface OwnershipRules {
  /**
   * CW company identifiers that are your own organization. Everything else is
   * a customer. Matched case-insensitively against `identifier` then `name`.
   */
  msspIdentifiers?: string[];
}

/**
 * Decide whose asset a configuration is from the CW company on the record.
 *
 * This is the thing a CSV export could never answer — the file had no
 * organization column at all, so ownership had to be declared per import. CW
 * carries the company per configuration, so it becomes derived fact.
 */
export function ownershipFromCompany(
  company: CWRef | undefined,
  rules: OwnershipRules = {},
): { owner: AssetOwnerType; customerName?: string } {
  const identifier = company?.identifier?.trim();
  const name = company?.name?.trim();
  if (!identifier && !name) return { owner: 'unknown' };

  const mssp = (rules.msspIdentifiers ?? []).map((s) => s.trim().toLowerCase()).filter(Boolean);
  const matchesMssp =
    (identifier && mssp.includes(identifier.toLowerCase())) ||
    (name && mssp.includes(name.toLowerCase()));

  if (matchesMssp) return { owner: 'mssp' };
  return { owner: 'customer', customerName: name || identifier };
}

// ---------------------------------------------------------------------------
// Configuration → Asset
// ---------------------------------------------------------------------------

function trimmed(value: string | undefined): string | undefined {
  const v = value?.trim();
  return v ? v : undefined;
}

function parseDate(value: string | undefined): number | undefined {
  if (!value) return undefined;
  const ms = Date.parse(value);
  return Number.isNaN(ms) ? undefined : ms;
}

/**
 * Join the two free-text note fields CW keeps separate.
 *
 * Both are analyst-visible context and losing either on sync would be a
 * regression against the CSV path, which had a single `notes` column.
 */
function mergeNotes(cfg: CWConfiguration): string | undefined {
  const parts = [trimmed(cfg.notes), trimmed(cfg.vendorNotes)].filter(Boolean);
  return parts.length ? parts.join('\n\n') : undefined;
}

export interface ConfigurationMapOptions {
  importedAt: number;
  createdBy?: string;
  ownership?: OwnershipRules;
}

/**
 * Map a CW configuration to an Asset draft.
 *
 * Returns undefined for a record with no name — CW allows it, and a nameless
 * asset cannot be identified, displayed or matched against an observable.
 */
export function configurationToAsset(
  cfg: CWConfiguration,
  opts: ConfigurationMapOptions,
): Omit<Asset, 'id'> | undefined {
  const name = trimmed(cfg.name);
  if (!name) return undefined;

  const ipRaw = trimmed(cfg.ipAddress);
  const primaryIp = ipRaw && parseIPv4(ipRaw) ? ipRaw : undefined;

  const macRaw = trimmed(cfg.macAddress);
  const macAddress = macRaw && normalizeMac(macRaw) ? macRaw : undefined;

  const now = opts.importedAt;
  const externalId = cfg.id != null ? String(cfg.id) : undefined;

  return {
    externalId,
    externalIds: externalId ? { [CW_SOURCE]: externalId } : undefined,
    name,
    // CW has no dedicated hostname column; deviceIdentifier is what the agent
    // reports and is the closest equivalent.
    hostname: trimmed(cfg.deviceIdentifier),
    status: trimmed(cfg.status?.name),
    assetType: trimmed(cfg.type?.name),
    // osType carries the product ("Microsoft Windows Server 2019 Standard"),
    // osInfo the build. Keeping them apart is what lets the attack-surface
    // matcher reach version precision instead of stopping at OS family.
    operatingSystem: trimmed(cfg.osType),
    osVersion: trimmed(cfg.osInfo),
    primaryIp,
    ipAddresses: primaryIp ? [primaryIp] : [],
    macAddress,
    macAddresses: macAddress ? [macAddress] : [],
    serialNumber: trimmed(cfg.serialNumber),
    assetTag: trimmed(cfg.tagNumber),
    manufacturer: trimmed(cfg.manufacturer?.name),
    model: trimmed(cfg.modelNumber),
    location: trimmed(cfg.site?.name),
    contactName: trimmed(cfg.contact?.name),
    notes: mergeNotes(cfg),
    // CW models retirement as activeFlag rather than an archive column.
    archivedInSource: cfg.activeFlag === false ? true : undefined,
    warrantyExpiresAt: parseDate(cfg.warrantyExpirationDate),
    purchasedAt: parseDate(cfg.purchaseDate),
    installedAt: parseDate(cfg.installationDate),
    sourceUpdatedAt: parseDate(cfg._info?.lastUpdated),
    ...ownershipFromCompany(cfg.company, opts.ownership),
    source: CW_SOURCE,
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

/** Map a page of configurations, dropping the unusable ones. */
export function configurationsToAssets(
  configurations: CWConfiguration[],
  opts: ConfigurationMapOptions,
): { drafts: Array<Omit<Asset, 'id'>>; unusable: number } {
  const drafts: Array<Omit<Asset, 'id'>> = [];
  let unusable = 0;
  for (const cfg of configurations) {
    const draft = configurationToAsset(cfg, opts);
    if (draft) drafts.push(draft);
    else unusable++;
  }
  return { drafts, unusable };
}

// ---------------------------------------------------------------------------
// Ticket → incident
// ---------------------------------------------------------------------------

/**
 * CW's own severity words, when the board sets them.
 */
const SEVERITY_WORDS: Record<string, IncidentSeverity> = {
  critical: 'critical',
  high: 'high',
  medium: 'medium',
  low: 'low',
};

/**
 * Map a CW ticket to an incident severity.
 *
 * CW exposes three overlapping notions of urgency and boards use them
 * inconsistently: `severity`/`impact` free text, and a `priority` whose name is
 * arbitrary per deployment but whose `sort` is ordered. Severity is preferred
 * because it is the field that means what we mean; priority sort is the
 * fallback because it is the one that is always populated.
 */
export function ticketSeverity(ticket: CWTicket): IncidentSeverity {
  const severity = ticket.severity?.trim().toLowerCase();
  if (severity && SEVERITY_WORDS[severity]) return SEVERITY_WORDS[severity];

  const impact = ticket.impact?.trim().toLowerCase();
  if (impact && SEVERITY_WORDS[impact]) return SEVERITY_WORDS[impact];

  const priorityName = ticket.priority?.name?.trim().toLowerCase() ?? '';
  for (const [word, mapped] of Object.entries(SEVERITY_WORDS)) {
    if (priorityName.includes(word)) return mapped;
  }

  // `sort` is 1-based with 1 most urgent. Anything beyond the fourth band is
  // routine work rather than an incident.
  const sort = ticket.priority?.sort;
  if (sort === 1) return 'critical';
  if (sort === 2) return 'high';
  if (sort === 3) return 'medium';
  if (sort === 4) return 'low';

  return 'none';
}

export interface TicketIncidentDraft {
  name: string;
  description?: string;
  severity: IncidentSeverity;
  detectedAt?: number;
  closedAt?: number;
  externalRef: string;
  companyName?: string;
  boardName?: string;
  incidentCommander?: string;
}

/**
 * Map a CW ticket to the investigation fields it can supply.
 *
 * Deliberately returns a draft rather than a Folder: whether a ticket becomes
 * a new investigation or an update on an existing one is the caller's call,
 * and only the caller knows what is already open.
 */
export function ticketToIncident(ticket: CWTicket): TicketIncidentDraft | undefined {
  const id = ticket.id;
  if (id == null) return undefined;

  const summary = trimmed(ticket.summary) ?? `ConnectWise ticket #${id}`;
  const company = trimmed(ticket.company?.name);

  return {
    // The ticket number leads so the case is findable from a PSA conversation.
    name: `#${id} ${summary}`,
    description: trimmed(ticket.initialDescription),
    severity: ticketSeverity(ticket),
    detectedAt: parseDate(ticket.dateEntered),
    closedAt: parseDate(ticket.closedDate),
    externalRef: String(id),
    companyName: company,
    boardName: trimmed(ticket.board?.name),
    incidentCommander: trimmed(ticket.owner?.name),
  };
}

/**
 * CW conditions expression selecting security-relevant open tickets.
 *
 * Left as a default rather than hardcoded — every deployment names its boards
 * differently, so this is a starting point the user is expected to edit.
 */
export function defaultTicketConditions(boardName?: string): string {
  const clauses = ['closedFlag=false'];
  if (boardName?.trim()) clauses.push(`board/name="${boardName.trim().replace(/"/g, '')}"`);
  return clauses.join(' and ');
}
