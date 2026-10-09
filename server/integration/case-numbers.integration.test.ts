import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { scratchDatabase, type ScratchDatabase } from './database.js';
import { applyCurrentMigrations, currentMigrations } from './migrations.js';

describe('investigation numbers assigned by migration 0026', () => {
  let database: ScratchDatabase;
  beforeEach(async () => {
    database = await scratchDatabase();
    await applyCurrentMigrations(database);
  });
  afterEach(async () => { await database?.close(); });

  const add = async (id: string, customer: string | null, caseNumber: string | null = null) => {
    const [row] = await database.sql`INSERT INTO folders (id, name, customer_code, case_number, created_at, updated_at)
      VALUES (${id}, ${id}, ${customer}, ${caseNumber}, now(), now()) RETURNING case_number`;
    return row.case_number as string;
  };

  it('numbers investigations per customer, falling back to the server prefix', async () => {
    expect(await add('a', 'NAG')).toBe('NAG-0001');
    expect(await add('b', 'NAG')).toBe('NAG-0002');
    expect(await add('c', 'mjx')).toBe('MJX-0001');
    expect(await add('d', null)).toBe('SL-0001');
    await database.sql`INSERT INTO server_settings (key, value) VALUES ('case_number_prefix', 'nuage')`;
    expect(await add('e', '  ')).toBe('NUAGE-0001');
  });

  it('never takes a number from the writer and never changes one', async () => {
    expect(await add('a', 'NAG', 'NAG-9999')).toBe('NAG-0001');
    await database.sql`UPDATE folders SET case_number = 'X-1', customer_code = 'MJX', name = 'renamed' WHERE id = 'a'`;
    const [row] = await database.sql`SELECT case_number, customer_code, name FROM folders WHERE id = 'a'`;
    expect(row).toEqual({ case_number: 'NAG-0001', customer_code: 'MJX', name: 'renamed' });
  });

  it('keeps counting past four digits instead of truncating', async () => {
    await database.sql`INSERT INTO case_counters (prefix, last_number) VALUES ('NAG', 9999)`;
    expect(await add('a', 'NAG')).toBe('NAG-10000');
  });

  it('backfills investigations that existed before the migration, oldest first', async () => {
    await database.sql`ALTER TABLE folders DISABLE TRIGGER case_number_assign`;
    await database.sql`INSERT INTO folders (id, name, customer_code, created_at, updated_at) VALUES
      ('new', 'new', 'NAG', now(), now()), ('old', 'old', 'NAG', now() - interval '1 day', now()), ('none', 'none', null, now(), now())`;
    await database.sql`ALTER TABLE folders ENABLE TRIGGER case_number_assign`;
    const sql = await readFile(resolve(currentMigrations, '0026_case_numbers.sql'), 'utf8');
    const backfill = sql.split('--> statement-breakpoint').at(-1)!;
    await database.sql.unsafe(backfill);
    const rows = await database.sql`SELECT id, case_number FROM folders ORDER BY id`;
    expect(Object.fromEntries(rows.map(r => [r.id, r.case_number]))).toEqual({ new: 'NAG-0002', none: 'SL-0001', old: 'NAG-0001' });
  });
});
