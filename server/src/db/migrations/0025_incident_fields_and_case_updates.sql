-- Server-side incident response: the incident fields the client carries on
-- Folder (severity, IR phase, the incident clock, the commander and
-- externalRefs), plus the case_updates log, which syncs like evidence_items.
--
-- The schema statements are IF NOT EXISTS / exception-guarded: installations
-- that ran this change before it was renumbered after the durable sync cursor
-- already have these columns and the table, and only gain the sync capture.

-- ── Incident fields on folders ──────────────────────────────────────────
ALTER TABLE "folders" ADD COLUMN IF NOT EXISTS "severity" text;
--> statement-breakpoint
ALTER TABLE "folders" ADD COLUMN IF NOT EXISTS "ir_phase" text;
--> statement-breakpoint
ALTER TABLE "folders" ADD COLUMN IF NOT EXISTS "detected_at" timestamp with time zone;
--> statement-breakpoint
ALTER TABLE "folders" ADD COLUMN IF NOT EXISTS "contained_at" timestamp with time zone;
--> statement-breakpoint
ALTER TABLE "folders" ADD COLUMN IF NOT EXISTS "eradicated_at" timestamp with time zone;
--> statement-breakpoint
ALTER TABLE "folders" ADD COLUMN IF NOT EXISTS "recovered_at" timestamp with time zone;
--> statement-breakpoint
ALTER TABLE "folders" ADD COLUMN IF NOT EXISTS "incident_commander" text;
--> statement-breakpoint
ALTER TABLE "folders" ADD COLUMN IF NOT EXISTS "external_refs" jsonb DEFAULT '{}'::jsonb;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_folders_external_refs" ON "folders" USING gin ("external_refs");
--> statement-breakpoint

-- ── Case log ────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS "case_updates" (
	"id" text PRIMARY KEY NOT NULL,
	"folder_id" text NOT NULL,
	"type" text DEFAULT 'status' NOT NULL,
	"body" text DEFAULT '' NOT NULL,
	"phase" text,
	"author_name" text,
	"revisions" jsonb,
	"linked_note_ids" jsonb,
	"linked_task_ids" jsonb,
	"linked_ioc_ids" jsonb,
	"linked_asset_ids" jsonb,
	"deleted_at" timestamp with time zone,
	"created_by" text,
	"updated_by" text,
	"version" integer DEFAULT 1 NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	"updated_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
DO $$ BEGIN
	ALTER TABLE "case_updates" ADD CONSTRAINT "case_updates_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
	ALTER TABLE "case_updates" ADD CONSTRAINT "case_updates_updated_by_users_id_fk" FOREIGN KEY ("updated_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_case_updates_folder_id_created_at" ON "case_updates" USING btree ("folder_id","created_at");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_case_updates_updated_at" ON "case_updates" USING btree ("updated_at");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_case_updates_folder_id_updated_at" ON "case_updates" USING btree ("folder_id","updated_at");

--> statement-breakpoint
CREATE OR REPLACE FUNCTION sync_revision() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  previous_version integer;
  api_table text;
BEGIN
  IF TG_OP = 'INSERT' THEN
    api_table := CASE TG_TABLE_NAME
      WHEN 'timeline_events' THEN 'timelineEvents'
      WHEN 'standalone_iocs' THEN 'standaloneIOCs'
      WHEN 'chat_threads' THEN 'chatThreads'
      WHEN 'evidence_items' THEN 'evidenceItems'
      WHEN 'case_updates' THEN 'caseUpdates'
      ELSE TG_TABLE_NAME
    END;
    SELECT max((record->>'version')::integer) INTO previous_version
      FROM sync_changes WHERE table_name = api_table AND entity_id = NEW.id;
    NEW.version := COALESCE(previous_version, 0) + 1;
  ELSE
    NEW.version := OLD.version + 1;
  END IF;
  NEW.updated_at := clock_timestamp();
  RETURN NEW;
END;
$$;
--> statement-breakpoint
DO $$
DECLARE item record; next_cursor bigint;
BEGIN
  PERFORM cursor FROM sync_clock WHERE id = 1 FOR UPDATE;
  LOCK TABLE case_updates IN SHARE ROW EXCLUSIVE MODE;
  FOR item IN SELECT to_jsonb(t) AS data FROM case_updates t ORDER BY id LOOP
    UPDATE sync_clock SET cursor = cursor + 1 WHERE id = 1 RETURNING cursor INTO next_cursor;
    INSERT INTO sync_changes (cursor, table_name, entity_id, folder_id, op, record)
      VALUES (next_cursor, 'caseUpdates', item.data->>'id', item.data->>'folder_id',
        CASE WHEN item.data->>'deleted_at' IS NOT NULL THEN 'delete' ELSE 'put' END, item.data);
  END LOOP;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER sync_lock_writes BEFORE INSERT OR UPDATE OR DELETE ON case_updates FOR EACH STATEMENT EXECUTE FUNCTION sync_lock_writes();
--> statement-breakpoint
CREATE TRIGGER sync_revision BEFORE INSERT OR UPDATE ON case_updates FOR EACH ROW EXECUTE FUNCTION sync_revision();
--> statement-breakpoint
CREATE TRIGGER sync_record_change AFTER INSERT OR UPDATE OR DELETE ON case_updates FOR EACH ROW EXECUTE FUNCTION sync_record_change('caseUpdates');
