import { describe, it, expect } from 'vitest';
import {
  connectWiseBaseUrl,
  connectWiseHost,
  connectWiseAuthHeaders,
  connectWiseUrl,
  hasCompleteCredentials,
  ownershipFromCompany,
  configurationToAsset,
  configurationsToAssets,
  ticketSeverity,
  ticketToIncident,
  defaultTicketConditions,
  CW_SOURCE,
  type CWConfiguration,
  type ConnectWiseCredentials,
} from '../lib/connectwise';
import {
  planTicketIntake,
  diffTicket,
  folderFieldsFromTicket,
  folderUpdatesFromTicket,
  caseUpdateFromTicket,
} from '../lib/connectwise-tickets';
import { mergeAssetDrafts, assetMatchKeys } from '../lib/asset-import';
import { resolveVariables, secretVariants, UnknownFilterError } from '../lib/integration-expression';
import { resolveAsset } from '../lib/asset-overrides';
import type { Asset, Folder } from '../types';

const CREDS: ConnectWiseCredentials = {
  site: 'api-eu.myconnectwise.net',
  companyId: 'acme',
  publicKey: 'pub',
  privateKey: 'priv',
  clientId: 'cid',
};

// ── URL and credential assembly ─────────────────────────────────────

describe('connectWiseBaseUrl', () => {
  it('accepts a bare host', () => {
    expect(connectWiseBaseUrl('api-eu.myconnectwise.net'))
      .toBe('https://api-eu.myconnectwise.net/v4_6_release/apis/3.0');
  });

  it('accepts a full URL and a trailing slash without doubling the path', () => {
    expect(connectWiseBaseUrl('https://api-eu.myconnectwise.net/'))
      .toBe('https://api-eu.myconnectwise.net/v4_6_release/apis/3.0');
  });

  it('tolerates a site pasted with the API path already on it', () => {
    expect(connectWiseBaseUrl('https://cw.example.com/v4_6_release/apis/3.0'))
      .toBe('https://cw.example.com/v4_6_release/apis/3.0');
  });

  it('rejects an empty site rather than building a nonsense URL', () => {
    expect(() => connectWiseBaseUrl('   ')).toThrow();
  });

  it('exposes the host for the proxy allowlist', () => {
    expect(connectWiseHost('https://cw.example.com/')).toBe('cw.example.com');
  });
});

describe('connectWiseAuthHeaders', () => {
  it('builds the composite Basic credential ConnectWise expects', () => {
    const headers = connectWiseAuthHeaders(CREDS);
    expect(headers.Authorization).toBe(`Basic ${btoa('acme+pub:priv')}`);
    expect(headers.clientId).toBe('cid');
  });

  it('survives non-Latin1 characters that would break btoa', () => {
    const headers = connectWiseAuthHeaders({ ...CREDS, privateKey: 'pÿssword€' });
    expect(() => atob(headers.Authorization.replace('Basic ', ''))).not.toThrow();
  });
});

describe('hasCompleteCredentials', () => {
  it('requires every field, since a partial config fails at the API', () => {
    expect(hasCompleteCredentials(CREDS)).toBe(true);
    expect(hasCompleteCredentials({ ...CREDS, clientId: '' })).toBe(false);
    expect(hasCompleteCredentials({ ...CREDS, site: '  ' })).toBe(false);
    expect(hasCompleteCredentials(undefined)).toBe(false);
  });
});

describe('connectWiseUrl', () => {
  it('clamps pageSize to what ConnectWise accepts', () => {
    const url = new URL(connectWiseUrl(CREDS.site, '/company/configurations', { pageSize: 5000 }));
    expect(url.searchParams.get('pageSize')).toBe('1000');
  });

  it('omits absent parameters instead of sending empty ones', () => {
    const url = new URL(connectWiseUrl(CREDS.site, '/company/configurations', {}));
    expect(url.searchParams.has('conditions')).toBe(false);
    expect(url.searchParams.has('page')).toBe(false);
  });

  it('joins field lists', () => {
    const url = new URL(connectWiseUrl(CREDS.site, '/company/companies', { fields: ['id', 'name'] }));
    expect(url.searchParams.get('fields')).toBe('id,name');
  });
});

// ── Ownership ───────────────────────────────────────────────────────

describe('ownershipFromCompany', () => {
  it('marks configured identifiers as our own', () => {
    expect(ownershipFromCompany({ identifier: 'NUAGE', name: 'Nu-Age' }, { msspIdentifiers: ['nuage'] }))
      .toEqual({ owner: 'mssp' });
  });

  it('matches on company name as well as identifier', () => {
    expect(ownershipFromCompany({ name: 'Nu-Age' }, { msspIdentifiers: ['nu-age'] }))
      .toEqual({ owner: 'mssp' });
  });

  it('treats everything else as that customer', () => {
    expect(ownershipFromCompany({ identifier: 'ACME', name: 'Acme Corp' }, { msspIdentifiers: ['nuage'] }))
      .toEqual({ owner: 'customer', customerName: 'Acme Corp' });
  });

  it('falls back to the identifier when there is no display name', () => {
    expect(ownershipFromCompany({ identifier: 'ACME' })).toEqual({ owner: 'customer', customerName: 'ACME' });
  });

  it('is unknown rather than guessing when the record has no company', () => {
    expect(ownershipFromCompany(undefined)).toEqual({ owner: 'unknown' });
    expect(ownershipFromCompany({})).toEqual({ owner: 'unknown' });
  });
});

// ── Configuration mapping ───────────────────────────────────────────

const CONFIG: CWConfiguration = {
  id: 1173,
  name: 'SRV-DC01',
  deviceIdentifier: 'srv-dc01.acme.local',
  type: { name: 'Managed Server' },
  status: { name: 'Active' },
  company: { identifier: 'ACME', name: 'Acme Corp' },
  site: { name: 'HQ' },
  contact: { name: 'Jane Doe' },
  manufacturer: { name: 'Dell Inc.' },
  serialNumber: '5CD4321',
  modelNumber: 'PowerEdge R740',
  tagNumber: 'AT-99',
  ipAddress: '10.20.30.40',
  macAddress: '00:50:56:BD:DB:1A',
  osType: 'Microsoft Windows Server 2019 Standard',
  osInfo: '10.0.17763',
  notes: 'Primary DC',
  vendorNotes: 'Warranty via reseller',
  activeFlag: true,
  warrantyExpirationDate: '2027-03-01T00:00:00Z',
  _info: { lastUpdated: '2026-07-01T10:00:00Z' },
};

describe('configurationToAsset', () => {
  const draft = configurationToAsset(CONFIG, { importedAt: 1000 })!;

  it('maps the identifying fields', () => {
    expect(draft.name).toBe('SRV-DC01');
    expect(draft.hostname).toBe('srv-dc01.acme.local');
    expect(draft.serialNumber).toBe('5CD4321');
    expect(draft.assetType).toBe('Managed Server');
    expect(draft.model).toBe('PowerEdge R740');
    expect(draft.manufacturer).toBe('Dell Inc.');
  });

  it('keeps OS product and build apart so version matching stays possible', () => {
    expect(draft.operatingSystem).toBe('Microsoft Windows Server 2019 Standard');
    expect(draft.osVersion).toBe('10.0.17763');
  });

  it('records the id under its source so it cannot collide with another CMDB', () => {
    expect(draft.externalIds).toEqual({ [CW_SOURCE]: '1173' });
    expect(draft.source).toBe(CW_SOURCE);
  });

  it('derives ownership from the company on the record', () => {
    expect(draft.owner).toBe('customer');
    expect(draft.customerName).toBe('Acme Corp');
  });

  it('keeps both note fields rather than losing one', () => {
    expect(draft.notes).toContain('Primary DC');
    expect(draft.notes).toContain('Warranty via reseller');
  });

  it('seeds the address arrays used by correlation', () => {
    expect(draft.ipAddresses).toEqual(['10.20.30.40']);
    expect(draft.macAddresses).toEqual(['00:50:56:BD:DB:1A']);
  });

  it('parses source dates', () => {
    expect(draft.warrantyExpiresAt).toBe(Date.parse('2027-03-01T00:00:00Z'));
    expect(draft.sourceUpdatedAt).toBe(Date.parse('2026-07-01T10:00:00Z'));
  });

  it('drops a malformed IP rather than storing something uncorrelatable', () => {
    const bad = configurationToAsset({ ...CONFIG, ipAddress: 'not-an-ip' }, { importedAt: 1 })!;
    expect(bad.primaryIp).toBeUndefined();
    expect(bad.ipAddresses).toEqual([]);
  });

  it('treats a retired configuration as archived in source', () => {
    const retired = configurationToAsset({ ...CONFIG, activeFlag: false }, { importedAt: 1 })!;
    expect(retired.archivedInSource).toBe(true);
  });

  it('refuses a nameless configuration, which cannot be identified', () => {
    expect(configurationToAsset({ id: 1 }, { importedAt: 1 })).toBeUndefined();
    expect(configurationToAsset({ id: 1, name: '   ' }, { importedAt: 1 })).toBeUndefined();
  });

  it('counts unusable records rather than dropping them silently', () => {
    const { drafts, unusable } = configurationsToAssets([CONFIG, { id: 2 }], { importedAt: 1 });
    expect(drafts).toHaveLength(1);
    expect(unusable).toBe(1);
  });
});

// ── Identity and merge ──────────────────────────────────────────────

function existingAsset(p: Partial<Asset> & { id: string; name: string }): Asset {
  return { importedAt: 0, tags: [], trashed: false, archived: false, createdAt: 0, updatedAt: 0, ...p };
}

describe('assetMatchKeys', () => {
  it('scopes external ids by source so two CMDBs cannot collide', () => {
    const keys = assetMatchKeys({ name: 'X', externalIds: { itglue: '5', connectwise: '5' } });
    expect(keys).toContain('ext:itglue:5');
    expect(keys).toContain('ext:connectwise:5');
  });

  it('still recognises records imported before ids were scoped', () => {
    expect(assetMatchKeys({ name: 'X', externalId: '42' })).toContain('ext:42');
  });

  it('never keys on a VMware BIOS UUID, which repeats across guests', () => {
    const keys = assetMatchKeys({ name: 'VM', serialNumber: 'VMware-42 3d 11' });
    expect(keys.some((k) => k.startsWith('sn:'))).toBe(false);
  });
});

describe('mergeAssetDrafts', () => {
  it('lands a ConnectWise record on the asset an ITGlue import already created', () => {
    const existing = existingAsset({
      id: 'a1', name: 'SRV-DC01', externalId: '4821', serialNumber: '5CD4321',
      analystNotes: 'Confirmed DC during IR-14',
    });
    const draft = configurationToAsset(CONFIG, { importedAt: 2000 })!;

    const result = mergeAssetDrafts([draft], [existing], { now: 2000, ownerFromSource: true });

    expect(result.created).toBe(0);
    expect(result.updated).toBe(1);
    expect(result.assets[0].id).toBe('a1');
  });

  it('keeps both source ids so either system can find the record next time', () => {
    const existing = existingAsset({
      id: 'a1', name: 'SRV-DC01', externalId: '4821',
      externalIds: { itglue: '4821' }, serialNumber: '5CD4321',
    });
    const draft = configurationToAsset(CONFIG, { importedAt: 2000 })!;
    const merged = mergeAssetDrafts([draft], [existing], { now: 2000, ownerFromSource: true }).assets[0];

    expect(merged.externalIds).toEqual({ itglue: '4821', connectwise: '1173' });
  });

  it('does not let a sync destroy an analyst correction', () => {
    const existing = existingAsset({
      id: 'a1', name: 'SRV-DC01', serialNumber: '5CD4321',
      operatingSystem: 'Windows Server 2016',
      overrides: {
        operatingSystem: { value: 'Windows Server 2019', updatedAt: 5, reason: 'Confirmed on host' },
      },
      analystNotes: 'Do not reboot without change approval',
    });
    const draft = configurationToAsset(CONFIG, { importedAt: 2000 })!;
    const merged = mergeAssetDrafts([draft], [existing], { now: 2000, ownerFromSource: true }).assets[0];

    expect(merged.analystNotes).toBe('Do not reboot without change approval');
    expect(resolveAsset(merged).operatingSystem).toBe('Windows Server 2019');
  });

  it('preserves investigation links and tags across a sync', () => {
    const existing = existingAsset({
      id: 'a1', name: 'SRV-DC01', serialNumber: '5CD4321',
      tags: ['crown-jewel'], linkedFolderIds: ['f1'], trashed: true, trashedAt: 9,
    });
    const draft = configurationToAsset(CONFIG, { importedAt: 2000 })!;
    const merged = mergeAssetDrafts([draft], [existing], { now: 2000, ownerFromSource: true }).assets[0];

    expect(merged.tags).toEqual(['crown-jewel']);
    expect(merged.linkedFolderIds).toEqual(['f1']);
    expect(merged.trashed).toBe(true);
  });

  it('lets a source that knows the company set ownership', () => {
    const existing = existingAsset({ id: 'a1', name: 'SRV-DC01', serialNumber: '5CD4321', owner: 'unknown' });
    const draft = configurationToAsset(CONFIG, { importedAt: 2000 })!;
    const merged = mergeAssetDrafts([draft], [existing], { now: 2000, ownerFromSource: true }).assets[0];

    expect(merged.owner).toBe('customer');
    expect(merged.customerName).toBe('Acme Corp');
  });

  it('leaves an existing owner alone when the batch declares none', () => {
    const existing = existingAsset({ id: 'a1', name: 'SRV-DC01', serialNumber: '5CD4321', owner: 'mssp' });
    const draft = { ...configurationToAsset(CONFIG, { importedAt: 2000 })!, owner: 'unknown' as const };
    const merged = mergeAssetDrafts([draft], [existing], { now: 2000 }).assets[0];

    expect(merged.owner).toBe('mssp');
  });

  it('writes one record when a page lists the same device twice', () => {
    const draft = configurationToAsset(CONFIG, { importedAt: 2000 })!;
    const result = mergeAssetDrafts([draft, { ...draft }], [], { now: 2000, ownerFromSource: true });

    expect(result.created).toBe(1);
    expect(result.skipped).toBe(1);
  });

  it('filters non-technical configuration types', () => {
    const licence = configurationToAsset(
      { ...CONFIG, id: 2, name: 'Office licence', type: { name: 'Account Information' } },
      { importedAt: 1 },
    )!;
    const result = mergeAssetDrafts([licence], [], { now: 1 });

    expect(result.created).toBe(0);
    expect(result.skippedNonTechnical).toBe(1);
  });
});

// ── Ticket severity ─────────────────────────────────────────────────

describe('ticketSeverity', () => {
  it('prefers the severity field, which means what we mean', () => {
    expect(ticketSeverity({ severity: 'High', priority: { sort: 4 } })).toBe('high');
  });

  it('falls back to impact', () => {
    expect(ticketSeverity({ impact: 'Critical' })).toBe('critical');
  });

  it('reads a severity word out of an arbitrary priority name', () => {
    expect(ticketSeverity({ priority: { name: 'Priority 1 - Critical' } })).toBe('critical');
  });

  it('uses priority sort when the name carries no severity word', () => {
    expect(ticketSeverity({ priority: { name: 'P2', sort: 2 } })).toBe('high');
    expect(ticketSeverity({ priority: { name: 'P4', sort: 4 } })).toBe('low');
  });

  it('is none when the ticket says nothing about urgency', () => {
    expect(ticketSeverity({})).toBe('none');
    expect(ticketSeverity({ priority: { name: 'Scheduled', sort: 9 } })).toBe('none');
  });
});

describe('ticketToIncident', () => {
  it('leads the name with the ticket number so the case is findable from the PSA', () => {
    const draft = ticketToIncident({ id: 4821, summary: 'Ransomware on FS01', severity: 'Critical' })!;
    expect(draft.name).toBe('#4821 Ransomware on FS01');
    expect(draft.severity).toBe('critical');
    expect(draft.externalRef).toBe('4821');
  });

  it('refuses a ticket with no id, which could never be matched again', () => {
    expect(ticketToIncident({ summary: 'orphan' })).toBeUndefined();
  });

  it('carries the entry time so the clock measures the response', () => {
    const draft = ticketToIncident({ id: 1, dateEntered: '2026-07-01T08:00:00Z' })!;
    expect(draft.detectedAt).toBe(Date.parse('2026-07-01T08:00:00Z'));
  });
});

describe('defaultTicketConditions', () => {
  it('selects open tickets, optionally on one board', () => {
    expect(defaultTicketConditions()).toBe('closedFlag=false');
    expect(defaultTicketConditions('Security')).toBe('closedFlag=false and board/name="Security"');
  });

  it('strips quotes that would break the conditions expression', () => {
    expect(defaultTicketConditions('Sec"urity')).toBe('closedFlag=false and board/name="Security"');
  });
});

// ── Ticket intake planning ──────────────────────────────────────────

function folder(p: Partial<Folder> & { id: string; name: string }): Folder {
  return { order: 0, createdAt: 0, ...p };
}

describe('planTicketIntake', () => {
  const ticket = { id: 4821, summary: 'Ransomware on FS01', severity: 'Critical' };

  it('opens a case for a ticket nothing has seen', () => {
    const plan = planTicketIntake([ticket], []);
    expect(plan.toCreate).toBe(1);
    expect(plan.items[0].action).toBe('create');
  });

  it('is a no-op when nothing on the ticket moved', () => {
    const existing = folder({
      id: 'f1', name: '#4821 Ransomware on FS01', severity: 'critical',
      externalRefs: { [CW_SOURCE]: '4821' },
    });
    const plan = planTicketIntake([ticket], [existing]);

    expect(plan.unchanged).toBe(1);
    expect(plan.toUpdate).toBe(0);
  });

  it('reports a severity change on an already-synced ticket', () => {
    const existing = folder({
      id: 'f1', name: '#4821 Ransomware on FS01', severity: 'low',
      externalRefs: { [CW_SOURCE]: '4821' },
    });
    const plan = planTicketIntake([ticket], [existing]);

    expect(plan.toUpdate).toBe(1);
    expect(plan.items[0].changes).toContainEqual({ field: 'severity', from: 'low', to: 'critical' });
  });

  it('skips tickets below the severity floor rather than opening cases nobody triages', () => {
    const noisy = { id: 99, summary: 'Printer jam', priority: { name: 'P4', sort: 4 } };
    const plan = planTicketIntake([ticket, noisy], [], { minSeverity: 'high' });

    expect(plan.items).toHaveLength(1);
    expect(plan.items[0].ticketId).toBe('4821');
  });

  it('ignores a ticket that cannot be mapped', () => {
    expect(planTicketIntake([{ summary: 'no id' }], []).items).toHaveLength(0);
  });
});

describe('ticket field projection', () => {
  it('records the source ticket so a second pull updates rather than duplicates', () => {
    const draft = ticketToIncident({ id: 7, summary: 'x', severity: 'High' })!;
    expect(folderFieldsFromTicket(draft).externalRefs).toEqual({ [CW_SOURCE]: '7' });
  });

  it('closes the case when the ticket closed', () => {
    const draft = ticketToIncident({ id: 7, summary: 'x', closedDate: '2026-07-02T00:00:00Z' })!;
    const fields = folderFieldsFromTicket(draft);
    expect(fields.status).toBe('closed');
    expect(fields.closedAt).toBe(Date.parse('2026-07-02T00:00:00Z'));
  });

  it('only applies the fields that actually changed', () => {
    const draft = ticketToIncident({ id: 7, summary: 'renamed', severity: 'High' })!;
    const updates = folderUpdatesFromTicket(draft, [{ field: 'name', from: 'old', to: 'new' }]);

    expect(updates.name).toBe('#7 renamed');
    expect(updates.severity).toBeUndefined();
  });

  it('reopens a case when the ticket reopened', () => {
    const draft = ticketToIncident({ id: 7, summary: 'x' })!;
    const updates = folderUpdatesFromTicket(draft, [{ field: 'status', from: 'closed', to: 'active' }]);
    expect(updates.status).toBe('active');
  });
});

describe('caseUpdateFromTicket', () => {
  it('attributes the entry to ConnectWise, not the analyst who ran the sync', () => {
    const draft = ticketToIncident({ id: 7, summary: 'x', severity: 'High', board: { name: 'Security' } })!;
    const update = caseUpdateFromTicket(
      { ticketId: '7', draft, action: 'create', changes: [] }, 'f1', 1000,
    );

    expect(update.authorName).toBe('ConnectWise');
    expect(update.type).toBe('status');
    expect(update.body).toContain('#7');
    expect(update.body).toContain('Security');
  });

  it('spells out what changed on an update', () => {
    const draft = ticketToIncident({ id: 7, summary: 'x', severity: 'Critical' })!;
    const update = caseUpdateFromTicket(
      {
        ticketId: '7', draft, action: 'update',
        changes: [{ field: 'severity', from: 'low', to: 'critical' }],
      },
      'f1', 1000,
    );

    expect(update.body).toContain('severity low → critical');
  });
});

describe('diffTicket', () => {
  it('treats an untriaged investigation as severity none', () => {
    const draft = ticketToIncident({ id: 7, summary: 'x' })!;
    expect(diffTicket(draft, folder({ id: 'f', name: '#7 x' }))).toEqual([]);
  });
});

// ── Template filters ────────────────────────────────────────────────

describe('template filters', () => {
  const ctx = { config: { companyId: 'acme', publicKey: 'pub', privateKey: 'priv' }, vars: {} };

  it('builds the ConnectWise Basic credential a plain path cannot express', () => {
    const composite = resolveVariables('{{config.companyId}}+{{config.publicKey}}:{{config.privateKey}}', ctx);
    const header = resolveVariables('Basic {{vars.basic | base64}}', { ...ctx, vars: { basic: composite } });

    expect(header).toBe(`Basic ${btoa('acme+pub:priv')}`);
  });

  it('leaves a bare path exactly as it behaved before filters existed', () => {
    expect(resolveVariables('{{config.companyId}}', ctx)).toBe('acme');
    expect(resolveVariables('{{missing.path}}', ctx)).toBe('');
  });

  it('chains filters left to right', () => {
    expect(resolveVariables('{{config.companyId | upper | urlencode}}', ctx)).toBe('ACME');
  });

  it('throws on a mis-spelled filter rather than sending the raw value', () => {
    expect(() => resolveVariables('{{config.privateKey | base46}}', ctx)).toThrow(UnknownFilterError);
  });

  it('encodes non-Latin1 input that would break btoa', () => {
    expect(() => resolveVariables('{{config.k | base64}}', { config: { k: '€uro' } })).not.toThrow();
  });
});

describe('secretVariants', () => {
  it('includes the encodings a secret reaches the log in', () => {
    const variants = secretVariants('priv');
    expect(variants).toContain(btoa('priv'));
  });

  it('omits variants identical to the raw secret, which is redacted anyway', () => {
    expect(secretVariants('abc')).not.toContain('abc');
  });
});
