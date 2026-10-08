import { sql } from 'drizzle-orm';
import type { db } from '../db/index.js';

/**
 * The team queue: every investigation created by webhook ingest, whichever
 * connector sent it, is visible to every active user. Access stays per
 * investigation (investigation_members), so this only keeps those member
 * lists complete: admins and analysts join as editors, viewers as viewers,
 * and an existing owner row is never changed. Investigations people create
 * by hand are not part of the queue and stay private to their members.
 */
export const TEAM_QUEUE_TAG = 'auto-ingested';

/**
 * Adds missing team-queue memberships and aligns non-owner roles with each
 * user's server role. Scope it to one investigation (after an ingest), to one
 * user (after an account is created, enabled or changes role), or to neither
 * (startup catch-up). Idempotent; returns how many rows it wrote.
 */
export async function shareTeamQueue(
  database: Pick<typeof db, 'execute'>,
  scope: { folderId?: string; userId?: string } = {},
): Promise<number> {
  const rows = await database.execute(sql`
    INSERT INTO investigation_members (id, folder_id, user_id, role, joined_at)
    SELECT gen_random_uuid()::text, f.id, u.id,
           CASE WHEN u.role = 'viewer' THEN 'viewer' ELSE 'editor' END, now()
    FROM folders f CROSS JOIN users u
    WHERE f.deleted_at IS NULL
      AND f.tags ? ${TEAM_QUEUE_TAG}
      AND u.active
      AND u.email NOT LIKE '%@threatcaddy.internal'
      ${scope.folderId ? sql`AND f.id = ${scope.folderId}` : sql``}
      ${scope.userId ? sql`AND u.id = ${scope.userId}` : sql``}
    ON CONFLICT (folder_id, user_id) DO UPDATE SET role = excluded.role
      WHERE investigation_members.role <> 'owner' AND investigation_members.role <> excluded.role
    RETURNING folder_id`);
  return rows.length;
}
