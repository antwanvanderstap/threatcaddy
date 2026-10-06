/**
 * Webhook ingest endpoint — accepts alerts from SIEMs, SOAR platforms, and
 * other external systems. Creates attributed alerts and owned investigations.
 *
 * Auth: Bearer token or X-Webhook-Secret header (configured via WEBHOOK_INGEST_SECRET env var).
 * No JWT required — this is designed for machine-to-machine integration.
 *
 * POST /api/webhooks/ingest
 * {
 *   "source": "splunk",           // required — identifies the sending system
 *   "title": "Suspicious login",  // required — becomes investigation name
 *   "description": "...",         // optional — investigation description
 *   "severity": "high",           // optional — low/medium/high/critical
 *   "raw": { ... },               // optional — full raw alert payload
 *   "iocs": [                     // optional — IOCs to auto-create
 *     { "type": "ipv4", "value": "1.2.3.4" },
 *     { "type": "domain", "value": "evil.com" }
 *   ],
 *   "investigationId": "abc123",  // optional — add to existing investigation
 *   "tags": ["phishing"],         // optional — tags for the investigation
 *   "triggerAgents": true,         // retained for compatibility; server handoff is unavailable
 *   "externalRef": {               // optional — dedupe key: a second ingest with the
 *     "system": "connectwise",     //   same system+id appends to that investigation
 *     "id": "213046"               //   instead of opening a new one
 *   },
 *   "externalRefs": {              // optional — several refs at once (merged with
 *     "stellar": "109878",         //   externalRef). Matches an investigation holding
 *     "connectwise": "213046"      //   ANY of them; refs it lacks are added, so a ticket
 *   },                             //   naming a Stellar case links the two
 *   "detectedAt": "2026-10-02T…",  // optional — incident clock start (ISO or epoch ms; default: now)
 *   "caseUpdate": {                // optional — append an entry to the case log
 *     "type": "status",            //   status/finding/action/escalation/containment/handover
 *     "body": "Ticket moved to In Progress"
 *   },
 *   "alertNote": false             // optional — skip the alert note and IOCs
 *                                  //   (default: true), e.g. for a status-only update
 * }
 */

import { Hono } from 'hono';
import { nanoid } from 'nanoid';
import { db } from '../db/index.js';
import { folders, notes, standaloneIOCs, caseUpdates, users, investigationMembers } from '../db/schema.js';
import { eq, and, gt, inArray, isNull, isNotNull, ne, sql } from 'drizzle-orm';
import { logger } from '../lib/logger.js';
import { checkInvestigationAccess } from '../middleware/access.js';
import { HANDOFF_UNAVAILABLE } from '../bots/handoff-policy.js';
import { timingSafeEqual, createHmac } from 'node:crypto';

const app = new Hono();

const INGEST_SECRET = process.env.WEBHOOK_INGEST_SECRET || '';

// ─── Auth middleware ──────────────────────────────────────────────

app.use('*', async (c, next) => {
  if (!INGEST_SECRET) {
    return c.json({ error: 'Webhook ingest not configured. Set WEBHOOK_INGEST_SECRET env var.' }, 503);
  }

  // Accept Bearer token or X-Webhook-Secret header
  const authHeader = c.req.header('Authorization') || '';
  const secretHeader = c.req.header('X-Webhook-Secret') || '';
  const signatureHeader = c.req.header('X-Webhook-Signature') || '';

  let authenticated = false;

  // Bearer token
  if (authHeader.startsWith('Bearer ')) {
    const token = authHeader.slice(7);
    const tokenBuf = Buffer.from(token);
    const secretBuf = Buffer.from(INGEST_SECRET);
    if (tokenBuf.length === secretBuf.length && timingSafeEqual(tokenBuf, secretBuf)) {
      authenticated = true;
    }
  }

  // Raw secret header
  if (!authenticated && secretHeader) {
    const headerBuf = Buffer.from(secretHeader);
    const secretBuf = Buffer.from(INGEST_SECRET);
    if (headerBuf.length === secretBuf.length && timingSafeEqual(headerBuf, secretBuf)) {
      authenticated = true;
    }
  }

  // HMAC-SHA256 signature
  if (!authenticated && signatureHeader.startsWith('sha256=')) {
    const rawBody = await c.req.text();
    const expected = createHmac('sha256', INGEST_SECRET).update(rawBody).digest('hex');
    const provided = signatureHeader.slice(7);
    const expectedBuf = Buffer.from(expected);
    const providedBuf = Buffer.from(provided);
    if (expectedBuf.length === providedBuf.length && timingSafeEqual(expectedBuf, providedBuf)) {
      authenticated = true;
      // Store raw body for later parsing since we consumed it
      c.set('rawBody' as never, rawBody as never);
    }
  }

  if (!authenticated) {
    return c.json({ error: 'Invalid webhook secret' }, 401);
  }

  return next();
});

// ─── Ingest endpoint ─────────────────────────────────────────────

interface IngestPayload {
  source: string;
  title: string;
  description?: string;
  severity?: 'low' | 'medium' | 'high' | 'critical';
  raw?: Record<string, unknown>;
  iocs?: Array<{ type: string; value: string; confidence?: string }>;
  investigationId?: string;
  tags?: string[];
  triggerAgents?: boolean;
  externalRef?: { system: string; id: string };
  externalRefs?: Record<string, string>;
  detectedAt?: string | number;
  caseUpdate?: { type?: string; body: string };
  alertNote?: boolean;
}

const VALID_SEVERITIES = new Set(['low', 'medium', 'high', 'critical']);
const VALID_CASE_UPDATE_TYPES = new Set(['status', 'finding', 'action', 'escalation', 'containment', 'handover']);
const MAX_EXTERNAL_REF_LEN = 100;
const MAX_CASE_UPDATE_LEN = 20_000;
const MAX_EXTERNAL_REFS = 10;

/** Parse an ISO string or epoch-ms number; undefined when absent or invalid. */
function parseTimestamp(v: unknown): Date | undefined {
  if (typeof v !== 'string' && typeof v !== 'number') return undefined;
  const d = new Date(v);
  return isNaN(d.getTime()) ? undefined : d;
}
const MAX_TITLE_LEN = 200;
const MAX_SOURCE_LEN = 50;
const MAX_IOC_VALUE_LEN = 500;

/** Sanitize a string: trim, enforce max length, strip control chars. */
function sanitizeStr(s: unknown, maxLen: number): string {
  if (typeof s !== 'string') return '';
  // eslint-disable-next-line no-control-regex
  return s.trim().replace(/[\x00-\x1f]/g, '').substring(0, maxLen);
}

class IngestAuthorizationError extends Error {
  constructor(message: string, readonly status: 403 | 503) { super(message); }
}

app.post('/ingest', async (c) => {
  let body: IngestPayload;
  try {
    // Use pre-read body from HMAC auth, or parse fresh
    const rawBody = c.get('rawBody' as never) as string | undefined;
    body = rawBody ? JSON.parse(rawBody) : await c.req.json<IngestPayload>();
  } catch {
    return c.json({ error: 'Invalid JSON body' }, 400);
  }

  if (!body || typeof body !== 'object' || Array.isArray(body)) return c.json({ error: 'Invalid ingest payload' }, 400);
  if (body.iocs !== undefined && !Array.isArray(body.iocs)) return c.json({ error: 'iocs must be an array' }, 400);

  // Strict type + length validation
  const source = sanitizeStr(body.source, MAX_SOURCE_LEN);
  const title = sanitizeStr(body.title, MAX_TITLE_LEN);
  if (!source || !title) {
    return c.json({ error: 'source (string, max 50) and title (string, max 200) are required' }, 400);
  }
  const severity = VALID_SEVERITIES.has(String(body.severity || '')) ? String(body.severity) as 'low' | 'medium' | 'high' | 'critical' : 'medium';
  const description = sanitizeStr(body.description, 5000);
  const tags = Array.isArray(body.tags) ? body.tags.filter((t): t is string => typeof t === 'string' && t.length < 100).slice(0, 20) : [];

  const refs: Record<string, string> = {};
  if (body.externalRef !== undefined) {
    const system = sanitizeStr(body.externalRef?.system, MAX_SOURCE_LEN);
    const id = sanitizeStr(body.externalRef?.id, MAX_EXTERNAL_REF_LEN);
    if (!system || !id) {
      return c.json({ error: 'externalRef requires string system (max 50) and id (max 100)' }, 400);
    }
    refs[system] = id;
  }
  if (body.externalRefs !== undefined) {
    if (!body.externalRefs || typeof body.externalRefs !== 'object' || Array.isArray(body.externalRefs)) {
      return c.json({ error: 'externalRefs must be an object of system -> id' }, 400);
    }
    const entries = Object.entries(body.externalRefs);
    if (entries.length > MAX_EXTERNAL_REFS) return c.json({ error: `externalRefs allows at most ${MAX_EXTERNAL_REFS} entries` }, 400);
    for (const [rawSystem, rawId] of entries) {
      const system = sanitizeStr(rawSystem, MAX_SOURCE_LEN);
      const id = sanitizeStr(typeof rawId === 'number' ? String(rawId) : rawId, MAX_EXTERNAL_REF_LEN);
      if (!system || !id) return c.json({ error: 'externalRefs entries need a system (max 50) and string id (max 100)' }, 400);
      refs[system] = id;
    }
  }
  const refEntries = Object.entries(refs);

  let caseUpdate: { type: string; body: string } | undefined;
  if (body.caseUpdate !== undefined) {
    const updateBody = typeof body.caseUpdate?.body === 'string' ? body.caseUpdate.body.trim().substring(0, MAX_CASE_UPDATE_LEN) : '';
    if (!updateBody) return c.json({ error: 'caseUpdate.body (string) is required' }, 400);
    const type = String(body.caseUpdate.type || 'status');
    if (!VALID_CASE_UPDATE_TYPES.has(type)) return c.json({ error: `caseUpdate.type must be one of ${[...VALID_CASE_UPDATE_TYPES].join(', ')}` }, 400);
    caseUpdate = { type, body: updateBody };
  }

  const ownerId = process.env.WEBHOOK_INGEST_OWNER_ID;
  if (!ownerId) return c.json({ error: 'Webhook ingest requires WEBHOOK_INGEST_OWNER_ID for an active analyst or administrator' }, 503);
  const [owner] = await db.select({ id: users.id, active: users.active, role: users.role, email: users.email })
    .from(users).where(eq(users.id, ownerId)).limit(1);
  if (!owner || !owner.active || !['admin', 'analyst'].includes(owner.role) || owner.email.endsWith('@threatcaddy.internal')) {
    return c.json({ error: 'Configured ingestion owner is not an active analyst or administrator' }, 503);
  }
  const now = new Date();
  if (body.investigationId !== undefined && typeof body.investigationId !== 'string') return c.json({ error: 'investigationId must be a string' }, 400);
  let folderId = body.investigationId || '';
  let phase: string | null = null;
  // Refs this ingest adds to an investigation that matched on another ref.
  let missingRefs: Record<string, string> = {};
  let status: 'created' | 'merged' | 'exists' | 'appended' = 'appended';
  if (folderId) {
    const existing = await db.select({ id: folders.id, irPhase: folders.irPhase }).from(folders).where(eq(folders.id, folderId)).limit(1);
    if (!existing.length) return c.json({ error: 'Investigation not found' }, 404);
    phase = existing[0].irPhase ?? null;
  } else if (refEntries.length > 0) {
    const anyRef = sql.join(refEntries.map(([system, id]) => sql`${folders.externalRefs} ->> ${system} = ${id}`), sql` OR `);
    const [existing] = await db.select({ id: folders.id, irPhase: folders.irPhase, externalRefs: folders.externalRefs })
      .from(folders)
      .where(and(sql`(${anyRef})`, isNull(folders.deletedAt)))
      .orderBy(folders.createdAt)
      .limit(1);
    if (existing) {
      folderId = existing.id;
      phase = existing.irPhase ?? null;
      const have = (existing.externalRefs ?? {}) as Record<string, string>;
      // Only fill systems the investigation has no ref for: an existing ref is
      // never overwritten, since other tooling already keys off it.
      missingRefs = Object.fromEntries(refEntries.filter(([system]) => have[system] === undefined));
      const clashes = refEntries.filter(([system, id]) => have[system] !== undefined && have[system] !== id);
      if (clashes.length > 0) {
        logger.warn('Webhook ingest: ref already set to a different id; kept existing', { folderId, clashes, have });
      }
      status = Object.keys(missingRefs).length > 0 ? 'merged' : 'exists';
    }
  }
  const created = !folderId;
  if (created) {
    folderId = nanoid();
    phase = 'triage';
    status = 'created';
  } else if (!await checkInvestigationAccess(ownerId, folderId, 'editor')) {
    return c.json({ error: 'Configured ingestion owner cannot edit this investigation' }, 403);
  }
  // A repeat of something already ingested adds nothing but its case-log entry.
  const writeAlert = body.alertNote !== false && status !== 'exists';

  // Create alert note
  const noteId = nanoid();
  const noteContent = [
    `# Alert: ${title}`,
    '',
    `**Source:** ${source}`,
    `**Severity:** ${severity}`,
    description ? `\n${description}` : '',
    '',
    body.raw ? `## Raw Alert Data\n\`\`\`json\n${JSON.stringify(body.raw, null, 2).substring(0, 5000)}\n\`\`\`` : '',
  ].filter(Boolean).join('\n');

  let iocCount = 0;
  let caseUpdateId: string | undefined;
  try {
    await db.transaction(async tx => {
      const [currentOwner] = await tx.select({ active: users.active, role: users.role, email: users.email })
        .from(users).where(eq(users.id, ownerId)).for('share');
      if (!currentOwner || !currentOwner.active || !['admin', 'analyst'].includes(currentOwner.role)
          || currentOwner.email.endsWith('@threatcaddy.internal')) throw new IngestAuthorizationError('Configured ingestion owner is no longer eligible', 503);
      if (!created && !await checkInvestigationAccess(ownerId, folderId, 'editor', tx)) throw new IngestAuthorizationError('Configured ingestion owner can no longer edit this investigation', 403);
      if (created) {
        const severityIcon = severity === 'critical' ? '🚨' : severity === 'high' ? '⚠️' : severity === 'medium' ? '🔶' : '📋';
        await tx.insert(folders).values({
          id: folderId, name: `${severityIcon} ${title}`.substring(0, 200),
          description: description || `Auto-created from ${source} alert`, status: 'active',
          tags: [...tags, `source:${source}`, 'auto-ingested'],
          severity,
          irPhase: 'triage',
          detectedAt: parseTimestamp(body.detectedAt) ?? now,
          externalRefs: refs,
          createdBy: ownerId, updatedBy: ownerId, createdAt: now, updatedAt: now,
        });
        await tx.insert(investigationMembers).values({ id: nanoid(), folderId, userId: ownerId, role: 'owner', joinedAt: now });
        // Ingested incidents are the team's queue: every active analyst and
        // administrator can work them, not only the configured owner.
        const team = await tx.select({ id: users.id, email: users.email }).from(users)
          .where(and(eq(users.active, true), inArray(users.role, ['admin', 'analyst']), ne(users.id, ownerId)));
        const humans = team.filter(u => !u.email.endsWith('@threatcaddy.internal'));
        if (humans.length > 0) {
          await tx.insert(investigationMembers)
            .values(humans.map(u => ({ id: nanoid(), folderId, userId: u.id, role: 'editor' as const, joinedAt: now })))
            .onConflictDoNothing();
        }
      } else if (Object.keys(missingRefs).length > 0) {
        await tx.update(folders)
          .set({
            externalRefs: sql`coalesce(${folders.externalRefs}, '{}'::jsonb) || ${JSON.stringify(missingRefs)}::jsonb`,
            version: sql`${folders.version} + 1`,
            updatedBy: ownerId,
            updatedAt: now,
          })
          .where(eq(folders.id, folderId));
      }
      if (caseUpdate) {
        caseUpdateId = nanoid();
        // Attributed to the sending system, not to a user: the case-updates
        // feed below lists only analyst-written entries (createdBy set), so an
        // integration never reads back what it wrote itself.
        await tx.insert(caseUpdates).values({
          id: caseUpdateId,
          folderId,
          type: caseUpdate.type as 'status',
          body: caseUpdate.body,
          phase,
          authorName: source,
          createdAt: now,
          updatedAt: now,
        });
      }
      if (!writeAlert) return;
      await tx.insert(notes).values({
        id: noteId,
        folderId,
        title: `[${source.toUpperCase()}] ${title}`.substring(0, 200),
        content: noteContent,
        tags: ['alert', `source:${source}`, `severity:${severity}`],
        createdBy: ownerId, updatedBy: ownerId,
        pinned: severity === 'critical' || severity === 'high',
        trashed: false,
        archived: false,
        version: 1,
        createdAt: now,
        updatedAt: now,
      });

      // Batch-insert IOCs
      if (body.iocs?.length) {
        const VALID_CONFIDENCES = new Set(['low', 'medium', 'high', 'confirmed']);
        const iocValues = body.iocs.slice(0, 100)
          .filter(ioc => ioc && typeof ioc.type === 'string' && typeof ioc.value === 'string' && ioc.type && ioc.value)
          .map(ioc => ({
            id: nanoid(),
            folderId: folderId!,
            type: sanitizeStr(ioc.type, 50),
            value: sanitizeStr(ioc.value, MAX_IOC_VALUE_LEN),
            confidence: (VALID_CONFIDENCES.has(ioc.confidence || '') ? ioc.confidence : 'medium') as 'low' | 'medium' | 'high' | 'confirmed',
            analystNotes: `Auto-extracted from ${source} alert`,
            tags: ['auto-ingested', `source:${source}`],
            createdBy: ownerId, updatedBy: ownerId,
            iocStatus: 'new',
            trashed: false,
            archived: false,
            version: 1,
            createdAt: now,
            updatedAt: now,
          }));

        if (iocValues.length > 0) {
          await tx.insert(standaloneIOCs).values(iocValues);
          iocCount = iocValues.length;
        }
      }

    });
  } catch (error) {
    if (error instanceof IngestAuthorizationError) return c.json({ error: error.message }, error.status);
    throw error;
  }
  if (created) logger.info('Webhook ingest: created owned investigation', { folderId, source, refs });
  // Handoff execution is deliberately unavailable until policy parity is implemented.
  const agentsTriggered = 0;

  if (!writeAlert) {
    return c.json({
      ok: true,
      investigationId: folderId,
      created,
      status,
      caseUpdateId,
      iocs: 0,
      agentsTriggered: 0,
      message: status === 'exists'
        ? (caseUpdateId ? 'Already ingested; case log updated.' : 'Already ingested; nothing new.')
        : created ? 'Investigation created.' : 'Case log updated.',
    });
  }

  return c.json({
    ok: true,
    investigationId: folderId,
    created,
    status,
    caseUpdateId,
    noteId,
    iocs: iocCount,
    agentsTriggered,
    agentExecutionAvailable: false,
    ...(body.triggerAgents !== false ? { agentExecutionReason: HANDOFF_UNAVAILABLE } : {}),
    message: created
      ? `Investigation created with ${iocCount} IOCs. ${agentsTriggered} agents triggered.`
      : `Alert added to existing investigation. ${iocCount} IOCs created. ${agentsTriggered} agents triggered.`,
  });
});

app.get('/external-refs', async (c) => {
  const system = sanitizeStr(c.req.query('system'), MAX_SOURCE_LEN);
  if (!system) return c.json({ error: 'system query parameter is required' }, 400);
  const includeAll = c.req.query('all') === '1';

  const rows = await db.select({
    investigationId: folders.id,
    ref: sql<string>`${folders.externalRefs} ->> ${system}`,
    status: folders.status,
    severity: folders.severity,
    irPhase: folders.irPhase,
  })
    .from(folders)
    .where(and(
      sql`${folders.externalRefs} ? ${system}`,
      isNull(folders.deletedAt),
      ...(includeAll ? [] : [eq(folders.status, 'active')]),
    ))
    .limit(5000);

  return c.json({ system, count: rows.length, items: rows });
});

app.get('/case-updates', async (c) => {
  const since = parseTimestamp(c.req.query('since')) ?? new Date(0);
  const limit = Math.min(Math.max(parseInt(c.req.query('limit') || '500', 10) || 500, 1), 1000);

  const rows = await db.select({
    id: caseUpdates.id,
    investigationId: caseUpdates.folderId,
    type: caseUpdates.type,
    body: caseUpdates.body,
    createdAt: caseUpdates.createdAt,
    updatedAt: caseUpdates.updatedAt,
    deletedAt: caseUpdates.deletedAt,
    authorName: caseUpdates.authorName,
    authorEmail: users.email,
    authorDisplayName: users.displayName,
    investigationName: folders.name,
    investigationStatus: folders.status,
    externalRefs: folders.externalRefs,
  })
    .from(caseUpdates)
    .innerJoin(folders, eq(folders.id, caseUpdates.folderId))
    .leftJoin(users, eq(users.id, caseUpdates.createdBy))
    .where(and(gt(caseUpdates.updatedAt, since), isNotNull(caseUpdates.createdBy)))
    .orderBy(caseUpdates.updatedAt, caseUpdates.id)
    .limit(limit);

  const last = rows[rows.length - 1];
  return c.json({
    count: rows.length,
    items: rows,
    nextSince: last ? last.updatedAt.toISOString() : since.toISOString(),
    more: rows.length === limit,
  });
});

export default app;
