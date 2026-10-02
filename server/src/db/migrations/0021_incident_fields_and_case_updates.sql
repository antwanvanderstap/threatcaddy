-- Server-side incident response: the incident fields the client has carried
-- on Folder since Dexie v36 (severity, IR phase, the incident clock, the
-- commander and externalRefs), plus the case_updates log.
--
-- Until now the server had no columns for these, so a synced folder silently
-- lost them and scripted intake had no external-ref dedupe key.
--
-- Every statement is IF NOT EXISTS / exception-guarded so this is safe to
-- re-run, and safe on databases already fixed up with `drizzle-kit push`.

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
