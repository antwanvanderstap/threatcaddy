-- Backfills schema changes that were added to src/db/schema.ts without a
-- corresponding migration: the AgentCaddy tables (agent_actions,
-- agent_heartbeats), LLM usage/key tables (llm_usage, user_llm_keys),
-- bot_configs deployment provenance, and cls_level classification columns.
--
-- Without this, a freshly migrated database is missing bot_configs.source_type
-- and botManager.init() throws on startup, crash-looping the server.
--
-- Every statement is IF NOT EXISTS / exception-guarded so this is safe to
-- re-run, and safe on databases already fixed up with `drizzle-kit push`.

-- ── AgentCaddy: proposed/executed agent actions ────────────────────────
CREATE TABLE IF NOT EXISTS "agent_actions" (
	"id" text PRIMARY KEY NOT NULL,
	"investigation_id" text NOT NULL,
	"bot_config_id" text,
	"deployment_source_id" text,
	"thread_id" text,
	"tool_name" text NOT NULL,
	"tool_input" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"rationale" text DEFAULT '' NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"result_summary" text,
	"severity" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"executed_at" timestamp with time zone,
	"reviewed_at" timestamp with time zone,
	"reviewed_by" text,
	"version" integer DEFAULT 1 NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint

-- ── AgentCaddy: server-side handoff heartbeats ─────────────────────────
CREATE TABLE IF NOT EXISTS "agent_heartbeats" (
	"folder_id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"last_beat" timestamp with time zone DEFAULT now() NOT NULL,
	"server_takeover_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint

-- ── LLM token/cost accounting ──────────────────────────────────────────
CREATE TABLE IF NOT EXISTS "llm_usage" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"provider" text NOT NULL,
	"model" text NOT NULL,
	"input_tokens" integer DEFAULT 0 NOT NULL,
	"output_tokens" integer DEFAULT 0 NOT NULL,
	"estimated_cost_micros" integer DEFAULT 0 NOT NULL,
	"latency_ms" integer,
	"thread_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint

-- ── Per-user BYO LLM API keys (encrypted at rest) ──────────────────────
CREATE TABLE IF NOT EXISTS "user_llm_keys" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"provider" text NOT NULL,
	"encrypted_key" text NOT NULL,
	"label" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint

DO $$ BEGIN
	ALTER TABLE "user_llm_keys" ADD CONSTRAINT "unique_user_provider" UNIQUE("user_id","provider");
EXCEPTION WHEN duplicate_table OR duplicate_object THEN null;
END $$;
--> statement-breakpoint

-- ── New columns on existing tables ─────────────────────────────────────
-- bot_configs.source_type is the column whose absence crash-loops the server.
ALTER TABLE "bot_configs" ADD COLUMN IF NOT EXISTS "source_type" text DEFAULT 'manual' NOT NULL;
--> statement-breakpoint
ALTER TABLE "bot_configs" ADD COLUMN IF NOT EXISTS "source_deployment_id" text;
--> statement-breakpoint
ALTER TABLE "whiteboards" ADD COLUMN IF NOT EXISTS "cls_level" text;
--> statement-breakpoint
ALTER TABLE "chat_threads" ADD COLUMN IF NOT EXISTS "cls_level" text;
--> statement-breakpoint
ALTER TABLE "posts" ADD COLUMN IF NOT EXISTS "cls_level" text;
--> statement-breakpoint

-- ── Foreign keys for the new tables ────────────────────────────────────
DO $$ BEGIN
	ALTER TABLE "agent_actions" ADD CONSTRAINT "agent_actions_bot_config_id_bot_configs_id_fk" FOREIGN KEY ("bot_config_id") REFERENCES "public"."bot_configs"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
	ALTER TABLE "agent_heartbeats" ADD CONSTRAINT "agent_heartbeats_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
	ALTER TABLE "llm_usage" ADD CONSTRAINT "llm_usage_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
	ALTER TABLE "user_llm_keys" ADD CONSTRAINT "user_llm_keys_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint

-- ── FK the earlier hand-written migrations omitted ─────────────────────
DO $$ BEGIN
	ALTER TABLE "investigation_members" ADD CONSTRAINT "investigation_members_folder_id_folders_id_fk" FOREIGN KEY ("folder_id") REFERENCES "public"."folders"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint

-- ── Align constraint names with Drizzle's convention ───────────────────
-- Migrations 0000-0019 were hand-written and kept Postgres' default *_fkey
-- names, so drizzle-kit saw every one as drift. Renaming them here keeps
-- future `drizzle-kit push`/`generate` diffs clean. Semantics are unchanged.
ALTER TABLE "tasks" DROP CONSTRAINT IF EXISTS "tasks_assignee_id_fkey";
--> statement-breakpoint
DO $$ BEGIN
	ALTER TABLE "tasks" ADD CONSTRAINT "tasks_assignee_id_users_id_fk" FOREIGN KEY ("assignee_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
ALTER TABLE "backups" DROP CONSTRAINT IF EXISTS "backups_user_id_fkey";
--> statement-breakpoint
DO $$ BEGIN
	ALTER TABLE "backups" ADD CONSTRAINT "backups_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
ALTER TABLE "bot_configs" DROP CONSTRAINT IF EXISTS "bot_configs_user_id_fkey";
--> statement-breakpoint
DO $$ BEGIN
	ALTER TABLE "bot_configs" ADD CONSTRAINT "bot_configs_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
ALTER TABLE "bot_configs" DROP CONSTRAINT IF EXISTS "bot_configs_created_by_fkey";
--> statement-breakpoint
DO $$ BEGIN
	ALTER TABLE "bot_configs" ADD CONSTRAINT "bot_configs_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
ALTER TABLE "bot_runs" DROP CONSTRAINT IF EXISTS "bot_runs_bot_config_id_fkey";
--> statement-breakpoint
DO $$ BEGIN
	ALTER TABLE "bot_runs" ADD CONSTRAINT "bot_runs_bot_config_id_bot_configs_id_fk" FOREIGN KEY ("bot_config_id") REFERENCES "public"."bot_configs"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
ALTER TABLE "integration_templates" DROP CONSTRAINT IF EXISTS "integration_templates_shared_by_fkey";
--> statement-breakpoint
DO $$ BEGIN
	ALTER TABLE "integration_templates" ADD CONSTRAINT "integration_templates_shared_by_users_id_fk" FOREIGN KEY ("shared_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
ALTER TABLE "standalone_iocs" DROP CONSTRAINT IF EXISTS "standalone_iocs_assignee_id_fkey";
--> statement-breakpoint
DO $$ BEGIN
	ALTER TABLE "standalone_iocs" ADD CONSTRAINT "standalone_iocs_assignee_id_users_id_fk" FOREIGN KEY ("assignee_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
ALTER TABLE "saved_searches" DROP CONSTRAINT IF EXISTS "saved_searches_user_id_fkey";
--> statement-breakpoint
DO $$ BEGIN
	ALTER TABLE "saved_searches" ADD CONSTRAINT "saved_searches_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
ALTER TABLE "admin_users" DROP CONSTRAINT IF EXISTS "admin_users_username_key";
--> statement-breakpoint
DO $$ BEGIN
	ALTER TABLE "admin_users" ADD CONSTRAINT "admin_users_username_unique" UNIQUE("username");
EXCEPTION WHEN duplicate_table OR duplicate_object THEN null;
END $$;
--> statement-breakpoint

-- ── Indexes ────────────────────────────────────────────────────────────
CREATE INDEX IF NOT EXISTS "idx_agent_actions_investigation" ON "agent_actions" USING btree ("investigation_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_agent_actions_status" ON "agent_actions" USING btree ("status");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_agent_actions_inv_status" ON "agent_actions" USING btree ("investigation_id","status");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_llm_usage_user_id" ON "llm_usage" USING btree ("user_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_llm_usage_created_at" ON "llm_usage" USING btree ("created_at");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_llm_usage_provider" ON "llm_usage" USING btree ("provider");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_bot_configs_source_type" ON "bot_configs" USING btree ("source_type");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_bot_runs_config_created" ON "bot_runs" USING btree ("bot_config_id","created_at");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_notes_folder_id_updated_at" ON "notes" USING btree ("folder_id","updated_at");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_whiteboards_folder_id_updated_at" ON "whiteboards" USING btree ("folder_id","updated_at");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_chat_threads_folder_id_updated_at" ON "chat_threads" USING btree ("folder_id","updated_at");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_tasks_folder_id_updated_at" ON "tasks" USING btree ("folder_id","updated_at");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_standalone_iocs_folder_id_updated_at" ON "standalone_iocs" USING btree ("folder_id","updated_at");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_timeline_events_folder_id_updated_at" ON "timeline_events" USING btree ("folder_id","updated_at");
