import { Hono } from 'hono';
import { requireAuth, requireRole } from '../middleware/auth.js';
import { db } from '../db/index.js';
import { logActivity } from '../services/audit-service.js';
import {
  createIncidentType,
  createIncidentTypeSchema,
  deleteIncidentType,
  listIncidentTypes,
  updateIncidentType,
  updateIncidentTypeSchema,
} from '../services/incident-types.js';

// Team-wide incident types and their layouts: everyone reads, admins edit.
const app = new Hono();

// eslint-disable-next-line @typescript-eslint/no-explicit-any
app.use('*', requireAuth as any);

async function readJson(c: { req: { json: () => Promise<unknown> } }): Promise<unknown> {
  try { return await c.req.json(); } catch { return undefined; }
}

app.get('/', requireRole('admin', 'analyst', 'viewer'), async (c) => {
  return c.json({ types: await listIncidentTypes(db) });
});

app.post('/', requireRole('admin'), async (c) => {
  const user = c.get('user' as never) as { id: string };
  const parsed = createIncidentTypeSchema.safeParse(await readJson(c));
  if (!parsed.success) return c.json({ error: 'Invalid incident type', details: parsed.error.flatten() }, 400);
  const result = await createIncidentType(db, parsed.data, user.id);
  if ('error' in result) return c.json({ error: 'An incident type with this name already exists' }, 409);
  await logActivity({
    userId: user.id, category: 'incident-type', action: 'create',
    detail: `Created incident type "${result.type.name}"`, itemId: result.type.id, itemTitle: result.type.name,
  }).catch(() => {});
  return c.json({ type: result.type }, 201);
});

app.patch('/:id', requireRole('admin'), async (c) => {
  const user = c.get('user' as never) as { id: string };
  const parsed = updateIncidentTypeSchema.safeParse(await readJson(c));
  if (!parsed.success) return c.json({ error: 'Invalid incident type', details: parsed.error.flatten() }, 400);
  const result = await updateIncidentType(db, c.req.param('id'), parsed.data, user.id);
  if ('error' in result) {
    return result.error === 'not-found'
      ? c.json({ error: 'Incident type not found' }, 404)
      : c.json({ error: 'An incident type with this name already exists' }, 409);
  }
  await logActivity({
    userId: user.id, category: 'incident-type', action: 'update',
    detail: `Updated incident type "${result.type.name}" (${Object.keys(parsed.data).join(', ')})`,
    itemId: result.type.id, itemTitle: result.type.name,
  }).catch(() => {});
  return c.json({ type: result.type });
});

app.delete('/:id', requireRole('admin'), async (c) => {
  const user = c.get('user' as never) as { id: string };
  const result = await deleteIncidentType(db, c.req.param('id'));
  if ('error' in result) {
    return result.error === 'not-found'
      ? c.json({ error: 'Incident type not found' }, 404)
      : c.json({ error: `Incident type is used by ${result.count} investigation(s)`, count: result.count }, 409);
  }
  await logActivity({
    userId: user.id, category: 'incident-type', action: 'delete',
    detail: `Deleted incident type "${result.deleted.name}"`, itemId: result.deleted.id, itemTitle: result.deleted.name,
  }).catch(() => {});
  return c.json({ ok: true });
});

export default app;
