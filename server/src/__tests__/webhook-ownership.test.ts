import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
const teamQueue = vi.hoisted(() => ({ share: vi.fn(async () => 0) }));
vi.mock('../services/team-queue.js', () => ({ shareTeamQueue: teamQueue.share }));
import { Hono } from 'hono';

const mocks = vi.hoisted(() => {
  const oldSecret = process.env.WEBHOOK_INGEST_SECRET;
  const oldOwner = process.env.WEBHOOK_INGEST_OWNER_ID;
  process.env.WEBHOOK_INGEST_SECRET = 'synthetic-ingest-secret';
  return { oldSecret, oldOwner, results: [] as unknown[][], committed: [] as Array<{ table: unknown; values: Record<string, unknown> | unknown[] }>, updated: [] as Array<{ table: unknown; set: Record<string, unknown> }>, failTable: undefined as unknown, txOwner: {} as Record<string, unknown>, access: vi.fn(), transaction: vi.fn() };
});
vi.mock('../middleware/access.js', () => ({ checkInvestigationAccess: mocks.access }));
vi.mock('../lib/logger.js', () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } }));
vi.mock('../db/index.js', () => ({ db: {
  select: vi.fn(() => ({ from: () => ({ where: () => {
    const limit = async () => mocks.results.shift() ?? [];
    return { limit, orderBy: () => ({ limit }) };
  } }) })),
  insert: () => { throw new Error('Ingest writes must be inside one transaction'); },
  transaction: mocks.transaction,
} }));
import { caseUpdates, folders, investigationMembers, notes, standaloneIOCs } from '../db/schema.js';
import webhooks from '../routes/webhooks.js';
const app = new Hono().route('/webhooks', webhooks);
const request = (body: unknown = { source: 'synthetic', title: 'Owned alert', iocs: [{ type: 'domain', value: 'indicator.example.invalid' }] }) => app.request('/webhooks/ingest', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Webhook-Secret': 'synthetic-ingest-secret' }, body: JSON.stringify(body) });
const owner = { id: 'owner-a', active: true, role: 'analyst', email: 'owner@example.invalid' };

beforeEach(() => {
  vi.clearAllMocks(); mocks.results.length = 0; mocks.committed.length = 0; mocks.updated.length = 0; mocks.failTable = undefined;
  process.env.WEBHOOK_INGEST_OWNER_ID = owner.id; mocks.txOwner = owner;
  mocks.access.mockResolvedValue(true);
  mocks.transaction.mockImplementation(async callback => {
    const staged: typeof mocks.committed = [];
    const stagedUpdates: typeof mocks.updated = [];
    await callback({
      // Owner revalidation locks with FOR SHARE.
      select: () => ({ from: () => ({ where: () => ({ for: async () => [mocks.txOwner] }) }) }),
      insert: (table: unknown) => ({ values: (values: Record<string, unknown> | unknown[]) => {
        const write = (async () => {
          if (table === mocks.failTable) throw new Error('Synthetic membership failure');
          staged.push({ table, values });
        })();
        return Object.assign(write, { onConflictDoNothing: () => write });
      } }),
      update: (table: unknown) => ({ set: (set: Record<string, unknown>) => ({ where: async () => { stagedUpdates.push({ table, set }); } }) }),
    });
    mocks.committed.push(...staged);
    mocks.updated.push(...stagedUpdates);
  });
});
afterAll(() => {
  for (const [key, value] of [['WEBHOOK_INGEST_SECRET', mocks.oldSecret], ['WEBHOOK_INGEST_OWNER_ID', mocks.oldOwner]]) {
    if (value === undefined) delete process.env[key!]; else process.env[key!] = value;
  }
});

describe('webhook investigation ownership', () => {
  it('requires an explicitly configured owner before writing data', async () => {
    delete process.env.WEBHOOK_INGEST_OWNER_ID;
    expect((await request()).status).toBe(503);
    expect(mocks.transaction).not.toHaveBeenCalled();
  });

  it.each([{ ...owner, active: false }, { ...owner, role: 'viewer' }, { ...owner, email: 'bot@threatcaddy.internal' }])('rejects a noneligible configured principal', async principal => {
    mocks.results.push([principal]);
    expect((await request()).status).toBe(503);
    expect(mocks.committed).toEqual([]);
  });

  it('creates owner membership, attributed records and JSONB arrays in the same transaction', async () => {
    mocks.results.push([owner]);
    const response = await request();
    expect(response.status).toBe(200);
    const result = await response.json();
    expect(result).toMatchObject({ created: true, iocs: 1, agentsTriggered: 0, agentExecutionAvailable: false });
    expect(mocks.transaction).toHaveBeenCalledOnce();
    expect(mocks.committed.map(write => write.table)).toEqual([folders, investigationMembers, notes, standaloneIOCs]);
    expect(mocks.committed[0].values).toMatchObject({ id: result.investigationId, createdBy: owner.id, updatedBy: owner.id, tags: ['source:synthetic', 'auto-ingested'] });
    expect(mocks.committed[1].values).toMatchObject({ folderId: result.investigationId, userId: owner.id, role: 'owner' });
    expect(mocks.committed[2].values).toMatchObject({ folderId: result.investigationId, createdBy: owner.id, tags: ['alert', 'source:synthetic', 'severity:medium'] });
  });

  it('revalidates the configured owner under the write transaction before inserting records', async () => {
    mocks.results.push([owner]); mocks.txOwner = { ...owner, active: false };
    expect((await request()).status).toBe(503);
    expect(mocks.committed).toEqual([]);
  });

  it('does not retain a folder or alert if owner membership creation fails', async () => {
    mocks.results.push([owner]); mocks.failTable = investigationMembers;
    expect((await request()).status).toBe(500);
    expect(mocks.committed).toEqual([]);
  });

  it('requires the configured owner to have editor access for existing investigations', async () => {
    mocks.results.push([owner], [{ id: 'existing-private-folder' }]); mocks.access.mockResolvedValue(false);
    expect((await request({ source: 'synthetic', title: 'Alert', investigationId: 'existing-private-folder' })).status).toBe(403);
    expect(mocks.access).toHaveBeenCalledWith(owner.id, 'existing-private-folder', 'editor');
    expect(mocks.transaction).not.toHaveBeenCalled();
  });

  it('shares a created incident with the team queue inside the ingest transaction', async () => {
    mocks.results.push([owner]);
    const response = await request({ source: 'synthetic', title: 'Team alert', externalRef: { system: 'ticketing', id: '42' }, detectedAt: '2026-10-02T12:00:00Z' });
    expect(response.status).toBe(200);
    const { investigationId } = await response.json();
    expect(mocks.committed.map(write => write.table)).toEqual([folders, investigationMembers, notes]);
    expect(mocks.committed[0].values).toMatchObject({ severity: 'medium', irPhase: 'triage', externalRefs: { ticketing: '42' }, detectedAt: new Date('2026-10-02T12:00:00Z') });
    expect(teamQueue.share).toHaveBeenCalledOnce();
    expect(teamQueue.share).toHaveBeenCalledWith(expect.objectContaining({ insert: expect.any(Function) }), { folderId: investigationId });
  });
  it('names the investigation after the alert and numbers it under the customer', async () => {
    mocks.results.push([owner]);
    const response = await request({ source: 'connectwise', title: 'Account locked out', customer: { code: 'nag', name: 'The Nu-Age Group' }, externalRef: { system: 'connectwise', id: '214033' } });
    expect(response.status).toBe(200);
    expect(mocks.committed[0].values).toMatchObject({ name: 'Account locked out', customerCode: 'NAG' });
    expect(mocks.committed[2].values).toMatchObject({ title: 'Account locked out', tags: ['alert', 'source:connectwise', 'severity:medium', 'ref:connectwise:214033'] });
  });

  it('rejects a customer code that cannot prefix an investigation number', async () => {
    mocks.results.push([owner]);
    expect((await request({ source: 'synthetic', title: 'Alert', customer: { code: 'NAG-1' } })).status).toBe(400);
    expect(mocks.transaction).not.toHaveBeenCalled();
  });

  it('appends only the case log when an external ref was already ingested', async () => {
    mocks.results.push([owner], [{ id: 'inv-1', irPhase: 'containment', externalRefs: { ticketing: '42' } }]);
    const response = await request({ source: 'synthetic', title: 'Repeat', externalRef: { system: 'ticketing', id: '42' }, caseUpdate: { body: 'Ticket closed' } });
    const result = await response.json();
    expect(result).toMatchObject({ investigationId: 'inv-1', created: false, status: 'exists', iocs: 0 });
    expect(mocks.committed.map(write => write.table)).toEqual([caseUpdates]);
    expect(mocks.committed[0].values).toMatchObject({ folderId: 'inv-1', type: 'status', body: 'Ticket closed', phase: 'containment', authorName: 'synthetic' });
    // Unattributed on purpose: the case-updates feed lists analyst-written entries only.
    expect(mocks.committed[0].values).not.toHaveProperty('createdBy');
    expect(mocks.updated).toEqual([]);
    expect(teamQueue.share).not.toHaveBeenCalled();
  });

  it('adds refs an investigation lacks without overwriting one it has', async () => {
    mocks.results.push([owner], [{ id: 'inv-1', irPhase: 'triage', externalRefs: { siem: '9' } }]);
    const response = await request({ source: 'synthetic', title: 'Linked', externalRefs: { siem: '9', ticketing: '42' }, alertNote: false });
    expect(await response.json()).toMatchObject({ investigationId: 'inv-1', status: 'merged' });
    expect(mocks.updated).toHaveLength(1);
    expect(mocks.updated[0]).toMatchObject({ table: folders, set: { updatedBy: owner.id } });
    expect(mocks.committed).toEqual([]);
  });

  it('refuses a matched investigation the owner cannot edit', async () => {
    mocks.results.push([owner], [{ id: 'inv-1', irPhase: 'triage', externalRefs: { ticketing: '42' } }]);
    mocks.access.mockResolvedValue(false);
    expect((await request({ source: 'synthetic', title: 'Repeat', externalRef: { system: 'ticketing', id: '42' } })).status).toBe(403);
    expect(mocks.transaction).not.toHaveBeenCalled();
  });
});
