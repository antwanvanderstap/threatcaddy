import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { scratchDatabase, type ScratchDatabase } from './database.js';
import { applySchemaPushFixture } from './migrations.js';
import { shareTeamQueue } from '../src/services/team-queue.js';

describe('team queue memberships in PostgreSQL', () => {
  let database: ScratchDatabase;
  beforeEach(async () => {
    database = await scratchDatabase();
    await applySchemaPushFixture(database);
    await database.sql`INSERT INTO users (id,email,display_name,password_hash,role,active) VALUES
      ('owner','owner@example.invalid','Owner','h','admin',true),
      ('analyst','analyst@example.invalid','Analyst','h','analyst',true),
      ('viewer','viewer@example.invalid','Viewer','h','viewer',true),
      ('gone','gone@example.invalid','Gone','h','analyst',false),
      ('system','system@threatcaddy.internal','System','h','admin',true)`;
    await database.sql`INSERT INTO folders (id,name,tags,created_by,updated_by,created_at,updated_at) VALUES
      ('queued','Ingested case','["connectwise","auto-ingested"]','owner','owner',now(),now()),
      ('deleted','Deleted ingested case','["auto-ingested"]','owner','owner',now(),now()),
      ('manual','Hand-made case','[]','analyst','analyst',now(),now())`;
    await database.sql`UPDATE folders SET deleted_at = now() WHERE id = 'deleted'`;
    await database.sql`INSERT INTO investigation_members (id,folder_id,user_id,role) VALUES
      ('m1','queued','owner','owner'), ('m2','queued','analyst','viewer'), ('m3','manual','analyst','owner')`;
  });
  afterEach(async () => { await database?.close(); });

  const members = async (folderId: string) => Object.fromEntries((await database.sql`
    SELECT user_id, role FROM investigation_members WHERE folder_id = ${folderId} ORDER BY user_id`).map(r => [r.user_id, r.role]));

  it('shares every live ingested case with every active person, by server role', async () => {
    expect(await shareTeamQueue(database.db)).toBe(2);
    // the owner keeps ownership, the analyst is raised to editor, the viewer reads
    expect(await members('queued')).toEqual({ analyst: 'editor', owner: 'owner', viewer: 'viewer' });
    expect(await members('deleted')).toEqual({});
    expect(await members('manual')).toEqual({ analyst: 'owner' });
    expect(await shareTeamQueue(database.db)).toBe(0);
  });

  it('scopes to one user when an account is created or changes role', async () => {
    await database.sql`INSERT INTO users (id,email,display_name,password_hash,role) VALUES ('late','late@example.invalid','Late','h','analyst')`;
    expect(await shareTeamQueue(database.db, { userId: 'late' })).toBe(1);
    expect((await members('queued')).late).toBe('editor');
    expect((await members('queued')).viewer).toBeUndefined();

    await database.sql`UPDATE users SET role = 'viewer' WHERE id = 'late'`;
    expect(await shareTeamQueue(database.db, { userId: 'late' })).toBe(1);
    expect((await members('queued')).late).toBe('viewer');
  });

  it('scopes to one investigation after an ingest', async () => {
    await database.sql`INSERT INTO folders (id,name,tags,created_by,updated_by,created_at,updated_at) VALUES
      ('fresh','New case','["auto-ingested"]','owner','owner',now(),now())`;
    await database.sql`INSERT INTO investigation_members (id,folder_id,user_id,role) VALUES ('m4','fresh','owner','owner')`;
    expect(await shareTeamQueue(database.db, { folderId: 'fresh' })).toBe(2);
    expect(await members('fresh')).toEqual({ analyst: 'editor', owner: 'owner', viewer: 'viewer' });
    expect(await members('queued')).toEqual({ analyst: 'viewer', owner: 'owner' });
  });
});
