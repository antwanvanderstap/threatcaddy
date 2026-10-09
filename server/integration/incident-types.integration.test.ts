import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { scratchDatabase, type ScratchDatabase } from './database.js';
import { applyCurrentMigrations } from './migrations.js';
import {
  createIncidentType,
  createIncidentTypeSchema,
  deleteIncidentType,
  listIncidentTypes,
  updateIncidentType,
  updateIncidentTypeSchema,
} from '../src/services/incident-types.js';

describe('incident types (migration 0027)', () => {
  let database: ScratchDatabase;
  beforeEach(async () => {
    database = await scratchDatabase();
    await applyCurrentMigrations(database);
    await database.sql`INSERT INTO users (id,email,display_name,password_hash,role,active) VALUES
      ('admin','admin@example.invalid','Admin','h','admin',true)`;
  });
  afterEach(async () => { await database?.close(); });

  it('seeds the starting set in order, all on the default layout', async () => {
    const types = await listIncidentTypes(database.db);
    expect(types).toHaveLength(11);
    expect(types[0]).toMatchObject({ id: 'ransomware', name: 'Ransomware', attackTechniques: ['T1486', 'T1490'], layout: null, order: 10 });
    expect(types.at(-1)).toMatchObject({ id: 'policy-or-configuration', attackTechniques: [] });
  });

  it('creates a type with a slug id and appends it at the end', async () => {
    const input = createIncidentTypeSchema.parse({ name: 'Insider threat', attackTechniques: ['t1078.002', 'T1078.002'] });
    const result = await createIncidentType(database.db, input, 'admin');
    expect(result).toMatchObject({ type: { id: 'insider-threat', name: 'Insider threat', attackTechniques: ['T1078.002'], order: 120 } });
    const again = await createIncidentType(database.db, createIncidentTypeSchema.parse({ name: 'INSIDER THREAT' }), 'admin');
    expect(again).toEqual({ error: 'duplicate-name' });
  });

  it('saves a layout and rejects malformed ones', async () => {
    const layout = { tabs: [{ id: 'summary', title: 'Summary', sections: [
      { id: 'stix-observables', width: 'full' }, { id: 'field:affected-mailbox', width: 'half' },
    ] }] };
    const result = await updateIncidentType(database.db, 'phishing', updateIncidentTypeSchema.parse({ layout }), 'admin');
    expect(result).toMatchObject({ type: { id: 'phishing', layout } });
    const [row] = await database.sql`SELECT updated_by FROM incident_types WHERE id = 'phishing'`;
    expect(row.updated_by).toBe('admin');

    expect(updateIncidentTypeSchema.safeParse({ layout: { tabs: [] } }).success).toBe(false);
    expect(updateIncidentTypeSchema.safeParse({ layout: { tabs: [{ id: 'a', title: 'A', sections: [{ id: 'Bad Id', width: 'full' }] }] } }).success).toBe(false);
    expect(updateIncidentTypeSchema.safeParse({ layout: { tabs: [{ id: 'a', title: 'A', sections: [] }, { id: 'a', title: 'B', sections: [] }] } }).success).toBe(false);
    expect(updateIncidentTypeSchema.safeParse({ unknown: 1 }).success).toBe(false);
    expect(await updateIncidentType(database.db, 'nope', {}, 'admin')).toEqual({ error: 'not-found' });
    expect(await updateIncidentType(database.db, 'phishing', { name: 'ransomware' }, 'admin')).toEqual({ error: 'duplicate-name' });
  });

  it('refuses to delete a type live investigations use', async () => {
    await database.sql`INSERT INTO folders (id,name,incident_type,created_at,updated_at) VALUES
      ('live','Live','phishing',now(),now()), ('gone','Gone','reconnaissance',now(),now())`;
    await database.sql`UPDATE folders SET deleted_at = now() WHERE id = 'gone'`;
    expect(await deleteIncidentType(database.db, 'phishing')).toEqual({ error: 'in-use', count: 1 });
    expect(await deleteIncidentType(database.db, 'reconnaissance')).toMatchObject({ deleted: { id: 'reconnaissance' } });
    expect(await deleteIncidentType(database.db, 'reconnaissance')).toEqual({ error: 'not-found' });
  });
});
