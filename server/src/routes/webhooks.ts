/**
 * Webhook ingest endpoint — accepts alerts from SIEMs, SOAR platforms, and
 * other external systems. Auto-creates investigations and triggers agents.
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
 *   "triggerAgents": true,         // optional — auto-start agents (default: true)
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
 *   "alertNote": false             // optional — skip the alert note, IOCs and agents
 *                                  //   (default: true), e.g. for a status-only update
 * }
 *
 * Response `status` is `created`, `merged` (matched by ref, new refs added) or
 * `exists` (matched by ref, nothing new). `exists` writes no alert note, IOCs or
 * agent runs, so a poller can resend overlapping windows without duplicating;
 * an explicit caseUpdate is still appended.
 *
 * GET /api/webhooks/external-refs?system=connectwise[&all=1]
 *   Investigations carrying a ref for `system` (active only unless all=1):
 *   [{ investigationId, ref, status, severity, irPhase }]. Lets a status-sync
 *   script find what to poll without keeping its own mapping.
 *
 * GET /api/webhooks/case-updates?since=<ISO|ms>[&limit=500]
 *   Case-log entries written by people (createdBy set — script entries posted
 *   through ingest have none) that were created or edited after `since`,
 *   oldest first, with author and the investigation's external refs. Backs
 *   the case-log -> ConnectWise time-entry sync; `nextSince` is the cursor.
 *
 * New investigations are created as incidents (severity set, phase `triage`)
 * and shared as `editor` with every active admin and analyst — membership is
 * the only access path, so an unshared investigation would be invisible.
 */

import { Hono } from 'hono';
import { nanoid } from 'nanoid';
import { db } from '../db/index.js';
import { folders, notes, standaloneIOCs, botConfigs, caseUpdates, investigationMembers, users } from '../db/schema.js';
import { eq, and, gt, inArray, isNull, isNotNull, sql } from 'drizzle-orm';
import { logger } from '../lib/logger.js';
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

app.post('/ingest', async (c) => {
  let body: IngestPayload;
  try {
    // Use pre-read body from HMAC auth, or parse fresh
    const rawBody = c.get('rawBody' as never) as string | undefined;
    body = rawBody ? JSON.parse(rawBody) : await c.req.json<IngestPayload>();
  } catch {
    return c.json({ error: 'Invalid JSON body' }, 400);
  }

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

  const now = new Date();
  let folderId = body.investigationId;
  let created = false;
  let status: 'created' | 'merged' | 'exists' | 'appended' = 'appended';
  let phase: string | null = null;

  // Find or create investigation
  if (folderId) {
    if (typeof folderId !== 'string') return c.json({ error: 'investigationId must be a string' }, 400);
    const existing = await db.select({ id: folders.id, irPhase: folders.irPhase }).from(folders).where(eq(folders.id, folderId)).limit(1);
    if (existing.length === 0) {
      return c.json({ error: `Investigation not found` }, 404);
    }
    phase = existing[0].irPhase ?? null;
  } else {
    if (refEntries.length > 0) {
      const anyRef = sql.join(refEntries.map(([system, id]) => sql`${folders.externalRefs} ->> ${system} = ${id}`), sql` OR `);
      const existing = await db.select({ id: folders.id, irPhase: folders.irPhase, externalRefs: folders.externalRefs })
        .from(folders)
        .where(and(sql`(${anyRef})`, isNull(folders.deletedAt)))
        .orderBy(folders.createdAt)
        .limit(1);
      if (existing.length > 0) {
        folderId = existing[0].id;
        phase = existing[0].irPhase ?? null;
        const have = (existing[0].externalRefs ?? {}) as Record<string, string>;
        // Only fill systems the investigation has no ref for: an existing ref is
        // never overwritten, since other tooling already keys off it.
        const missing = Object.fromEntries(refEntries.filter(([system]) => have[system] === undefined));
        const clashes = refEntries.filter(([system, id]) => have[system] !== undefined && have[system] !== id);
        if (clashes.length > 0) {
          logger.warn('Webhook ingest: ref already set to a different id; kept existing', { folderId, clashes, have });
        }
        if (Object.keys(missing).length > 0) {
          await db.update(folders)
            .set({
              externalRefs: sql`coalesce(${folders.externalRefs}, '{}'::jsonb) || ${JSON.stringify(missing)}::jsonb`,
              version: sql`${folders.version} + 1`,
              updatedAt: now,
            })
            .where(eq(folders.id, folderId));
          status = 'merged';
        } else {
          status = 'exists';
        }
      }
    }

    if (!folderId) {
      folderId = nanoid();
      phase = 'triage';
      const severityIcon = severity === 'critical' ? '🚨' : severity === 'high' ? '⚠️' : severity === 'medium' ? '🔶' : '📋';
      await db.insert(folders).values({
        id: folderId,
        name: `${severityIcon} ${title}`.substring(0, 200),
        description: description || `Auto-created from ${source} alert`,
        status: 'active',
        tags: [...tags, `source:${source}`, 'auto-ingested'],
        severity,
        irPhase: 'triage',
        detectedAt: parseTimestamp(body.detectedAt) ?? now,
        externalRefs: refs,
        createdAt: now,
        updatedAt: now,
      });

      const team = await db.select({ id: users.id })
        .from(users)
        .where(and(eq(users.active, true), inArray(users.role, ['admin', 'analyst'])));
      if (team.length > 0) {
        await db.insert(investigationMembers)
          .values(team.map(u => ({ id: nanoid(), folderId: folderId!, userId: u.id, role: 'editor' as const, joinedAt: now })))
          .onConflictDoNothing();
      }

      created = true;
      status = 'created';
      logger.info('Webhook ingest: created investigation', { folderId, source, title, refs, members: team.length });
    }
  }

  let caseUpdateId: string | undefined;
  if (caseUpdate) {
    caseUpdateId = nanoid();
    await db.insert(caseUpdates).values({
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

  if (body.alertNote === false || status === 'exists') {
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

  await db.insert(notes).values({
    id: noteId,
    folderId,
    title: `[${source.toUpperCase()}] ${title}`.substring(0, 200),
    content: noteContent,
    tags: ['alert', `source:${source}`, `severity:${severity}`],
    pinned: severity === 'critical' || severity === 'high',
    trashed: false,
    archived: false,
    version: 1,
    createdAt: now,
    updatedAt: now,
  });

  // Batch-insert IOCs
  let iocCount = 0;
  if (body.iocs?.length) {
    const VALID_CONFIDENCES = new Set(['low', 'medium', 'high', 'confirmed']);
    const iocValues = body.iocs.slice(0, 100)
      .filter(ioc => typeof ioc.type === 'string' && typeof ioc.value === 'string' && ioc.type && ioc.value)
      .map(ioc => ({
        id: nanoid(),
        folderId: folderId!,
        type: sanitizeStr(ioc.type, 50),
        value: sanitizeStr(ioc.value, MAX_IOC_VALUE_LEN),
        confidence: (VALID_CONFIDENCES.has(ioc.confidence || '') ? ioc.confidence : 'medium') as 'low' | 'medium' | 'high' | 'confirmed',
        analystNotes: `Auto-extracted from ${source} alert`,
        tags: ['auto-ingested', `source:${source}`],
        iocStatus: 'new',
        trashed: false,
        archived: false,
        version: 1,
        createdAt: now,
        updatedAt: now,
      }));

    if (iocValues.length > 0) {
      await db.insert(standaloneIOCs).values(iocValues);
      iocCount = iocValues.length;
    }
  }

  // Trigger agents — find bots scoped to this investigation OR with global scope
  const triggerAgents = body.triggerAgents !== false;
  let agentsTriggered = 0;
  if (triggerAgents) {
    try {
      const { botManager } = await import('../bots/bot-manager.js');
      const bots = await db.select()
        .from(botConfigs)
        .where(and(eq(botConfigs.sourceType, 'caddy-agent'), eq(botConfigs.enabled, true)));

      const matchingBots = bots.filter(b =>
        b.scopeType === 'global' ||
        (Array.isArray(b.scopeFolderIds) && (b.scopeFolderIds as string[]).includes(folderId!))
      );

      // Actually trigger each matching bot
      for (const bot of matchingBots) {
        botManager.executeBot(bot.id, 'webhook', undefined, {
          source,
          title,
          severity,
          investigationId: folderId,
          alertNoteId: noteId,
        }).catch(err => {
          logger.error('Webhook ingest: bot execution failed', { botId: bot.id, error: String(err) });
        });
      }
      agentsTriggered = matchingBots.length;

      if (agentsTriggered > 0) {
        logger.info('Webhook ingest: triggered agents', { folderId, agents: agentsTriggered });
      }
    } catch (err) {
      logger.warn('Webhook ingest: failed to trigger agents', { error: String(err) });
    }
  }

  return c.json({
    ok: true,
    investigationId: folderId,
    created,
    status,
    noteId,
    caseUpdateId,
    iocs: iocCount,
    agentsTriggered,
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
