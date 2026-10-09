import { and, asc, eq, isNull, ne, sql } from 'drizzle-orm';
import { nanoid } from 'nanoid';
import { z } from 'zod';
import type { db } from '../db/index.js';
import { folders, incidentTypes } from '../db/schema.js';

/**
 * Incident types and their Summary-view layouts. A layout is tabs of ordered
 * sections; a section id names a built-in section ("description",
 * "stix-observables") or, later, a registered field ("field:affected-mailbox").
 * Ids the client does not know are kept and skipped when rendering, so older
 * clients survive layouts made by newer ones.
 */

type Database = Pick<typeof db, 'select' | 'insert' | 'update' | 'delete'>;

const SECTION_ID = /^[a-z][a-z0-9-]{0,39}(?::[a-z0-9][a-z0-9_.-]{0,63})?$/;

export const layoutSchema = z.object({
  tabs: z.array(z.object({
    id: z.string().regex(/^[a-z0-9][a-z0-9-]{0,39}$/),
    title: z.string().trim().min(1).max(60),
    sections: z.array(z.object({
      id: z.string().regex(SECTION_ID),
      width: z.enum(['half', 'full']),
    }).strict()).max(40),
  }).strict()).min(1).max(12),
}).strict().superRefine((layout, ctx) => {
  const tabIds = new Set<string>();
  layout.tabs.forEach((tab, i) => {
    if (tabIds.has(tab.id)) ctx.addIssue({ code: 'custom', path: ['tabs', i, 'id'], message: 'Duplicate tab id' });
    tabIds.add(tab.id);
  });
});

const fields = {
  name: z.string().trim().min(1).max(80),
  description: z.string().max(2000),
  color: z.string().regex(/^#[0-9a-fA-F]{6}$/).nullable(),
  attackTechniques: z.array(z.string().trim().toUpperCase().regex(/^T\d{4}(?:\.\d{3})?$/)).max(100)
    .transform((ids) => [...new Set(ids)]),
  defaultPlaybookId: z.string().min(1).max(200).nullable(),
  layout: layoutSchema.nullable(),
  order: z.number().int().min(0).max(1_000_000),
};

export const createIncidentTypeSchema = z.object(fields).partial().required({ name: true }).strict();
export const updateIncidentTypeSchema = z.object(fields).partial().strict();

export type IncidentTypeInput = z.infer<typeof createIncidentTypeSchema>;
export type IncidentTypePatch = z.infer<typeof updateIncidentTypeSchema>;

export interface IncidentTypeDto {
  id: string;
  name: string;
  description: string;
  color: string | null;
  attackTechniques: string[];
  defaultPlaybookId: string | null;
  layout: z.infer<typeof layoutSchema> | null;
  order: number;
  createdAt: number;
  updatedAt: number;
}

function toDto(row: typeof incidentTypes.$inferSelect): IncidentTypeDto {
  return {
    id: row.id,
    name: row.name,
    description: row.description,
    color: row.color,
    attackTechniques: (row.attackTechniques ?? []) as string[],
    defaultPlaybookId: row.defaultPlaybookId,
    layout: (row.layout ?? null) as IncidentTypeDto['layout'],
    order: row.sortOrder,
    createdAt: row.createdAt.getTime(),
    updatedAt: row.updatedAt.getTime(),
  };
}

/** Readable, stable id from the name ("Business email compromise" → "business-email-compromise"). */
export function slugForName(name: string): string {
  const slug = name.normalize('NFKD').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60);
  return slug || 'type';
}

async function nameTaken(database: Database, name: string, exceptId?: string): Promise<boolean> {
  const sameName = sql`lower(${incidentTypes.name}) = lower(${name})`;
  const rows = await database.select({ id: incidentTypes.id }).from(incidentTypes)
    .where(exceptId ? and(sameName, ne(incidentTypes.id, exceptId)) : sameName).limit(1);
  return rows.length > 0;
}

export async function listIncidentTypes(database: Database): Promise<IncidentTypeDto[]> {
  const rows = await database.select().from(incidentTypes).orderBy(asc(incidentTypes.sortOrder), asc(incidentTypes.name));
  return rows.map(toDto);
}

export async function createIncidentType(
  database: Database, input: IncidentTypeInput, userId: string,
): Promise<{ type: IncidentTypeDto } | { error: 'duplicate-name' }> {
  if (await nameTaken(database, input.name)) return { error: 'duplicate-name' };
  let id = slugForName(input.name);
  const clash = await database.select({ id: incidentTypes.id }).from(incidentTypes).where(eq(incidentTypes.id, id)).limit(1);
  if (clash.length) id = `${id}-${nanoid(6).toLowerCase()}`;
  const order = input.order ?? (await database.select({ max: sql<number>`coalesce(max(${incidentTypes.sortOrder}), 0)` }).from(incidentTypes))[0].max + 10;
  const now = new Date();
  const [row] = await database.insert(incidentTypes).values({
    id,
    name: input.name,
    description: input.description ?? '',
    color: input.color ?? null,
    attackTechniques: input.attackTechniques ?? [],
    defaultPlaybookId: input.defaultPlaybookId ?? null,
    layout: input.layout ?? null,
    sortOrder: order,
    createdBy: userId,
    updatedBy: userId,
    createdAt: now,
    updatedAt: now,
  }).returning();
  return { type: toDto(row) };
}

export async function updateIncidentType(
  database: Database, id: string, patch: IncidentTypePatch, userId: string,
): Promise<{ type: IncidentTypeDto } | { error: 'not-found' | 'duplicate-name' }> {
  if (patch.name !== undefined && await nameTaken(database, patch.name, id)) return { error: 'duplicate-name' };
  const { order, ...rest } = patch;
  const [row] = await database.update(incidentTypes)
    .set({ ...rest, ...(order !== undefined ? { sortOrder: order } : {}), updatedBy: userId, updatedAt: new Date() })
    .where(eq(incidentTypes.id, id))
    .returning();
  return row ? { type: toDto(row) } : { error: 'not-found' };
}

/** A type that live investigations still use cannot be deleted. */
export async function deleteIncidentType(
  database: Database, id: string,
): Promise<{ deleted: IncidentTypeDto } | { error: 'not-found' } | { error: 'in-use'; count: number }> {
  const [{ count }] = await database.select({ count: sql<number>`count(*)::int` }).from(folders)
    .where(and(eq(folders.incidentType, id), isNull(folders.deletedAt)));
  if (count > 0) return { error: 'in-use', count };
  const [row] = await database.delete(incidentTypes).where(eq(incidentTypes.id, id)).returning();
  return row ? { deleted: toDto(row) } : { error: 'not-found' };
}
