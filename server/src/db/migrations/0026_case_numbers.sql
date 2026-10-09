-- Investigation numbers: every investigation gets a readable number per
-- customer ("NAG-0042"), assigned by the database so that every way a folder
-- is created (client sync push, webhook ingest, admin tools) numbers it once
-- and in order. Without a customer the prefix is the server setting
-- case_number_prefix (default "SL"). A number never changes after creation.

ALTER TABLE "folders" ADD COLUMN IF NOT EXISTS "customer_code" text;
--> statement-breakpoint
ALTER TABLE "folders" ADD COLUMN IF NOT EXISTS "case_number" text;
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "uq_folders_case_number" ON "folders" USING btree ("case_number");
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "case_counters" (
  "prefix" text PRIMARY KEY NOT NULL,
  "last_number" integer NOT NULL DEFAULT 0
);
--> statement-breakpoint
CREATE OR REPLACE FUNCTION case_number_next(customer text) RETURNS text
LANGUAGE plpgsql AS $$
DECLARE
  -- v_ names: a variable called prefix would be ambiguous with the column.
  v_prefix text;
  v_number integer;
BEGIN
  v_prefix := upper(coalesce(
    nullif(btrim(customer), ''),
    (SELECT nullif(btrim(value), '') FROM server_settings WHERE key = 'case_number_prefix'),
    'SL'));
  INSERT INTO case_counters AS c (prefix, last_number) VALUES (v_prefix, 1)
    ON CONFLICT (prefix) DO UPDATE SET last_number = c.last_number + 1
    RETURNING c.last_number INTO v_number;
  -- lpad would cut 10000 to "1000": past four digits the number just grows.
  RETURN v_prefix || '-' || CASE WHEN v_number < 10000 THEN lpad(v_number::text, 4, '0') ELSE v_number::text END;
END $$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION case_number_assign() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    -- Clients never choose a number; a pushed value is replaced.
    NEW.case_number := case_number_next(NEW.customer_code);
  ELSE
    NEW.case_number := OLD.case_number;
  END IF;
  RETURN NEW;
END $$;
--> statement-breakpoint
DROP TRIGGER IF EXISTS "case_number_assign" ON "folders";
--> statement-breakpoint
CREATE TRIGGER "case_number_assign" BEFORE INSERT OR UPDATE ON "folders"
  FOR EACH ROW EXECUTE FUNCTION case_number_assign();
--> statement-breakpoint
DO $$
DECLARE r record;
BEGIN
  -- Number existing investigations in creation order. The update trigger keeps
  -- old numbers, so it is bypassed for this one-time backfill only.
  ALTER TABLE "folders" DISABLE TRIGGER "case_number_assign";
  FOR r IN SELECT id, customer_code FROM folders WHERE case_number IS NULL ORDER BY created_at, id LOOP
    UPDATE folders SET case_number = case_number_next(r.customer_code) WHERE id = r.id;
  END LOOP;
  ALTER TABLE "folders" ENABLE TRIGGER "case_number_assign";
END $$;
