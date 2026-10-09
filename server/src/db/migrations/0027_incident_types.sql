-- Incident types: team-wide, admin-edited. Each type has a layout for the
-- investigation Summary view (NULL = the client's built-in default layout),
-- the ATT&CK techniques that classify it, and a default playbook. An
-- investigation points at its type with folders.incident_type.

CREATE TABLE IF NOT EXISTS "incident_types" (
  "id" text PRIMARY KEY NOT NULL,
  "name" text NOT NULL,
  "description" text DEFAULT '' NOT NULL,
  "color" text,
  "attack_techniques" jsonb DEFAULT '[]'::jsonb NOT NULL,
  "default_playbook_id" text,
  "layout" jsonb,
  "sort_order" integer DEFAULT 0 NOT NULL,
  "created_by" text,
  "updated_by" text,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE "incident_types" ADD CONSTRAINT "incident_types_created_by_users_id_fk"
    FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE "incident_types" ADD CONSTRAINT "incident_types_updated_by_users_id_fk"
    FOREIGN KEY ("updated_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "uq_incident_types_name" ON "incident_types" USING btree ("name");
--> statement-breakpoint
ALTER TABLE "folders" ADD COLUMN IF NOT EXISTS "incident_type" text;
--> statement-breakpoint
-- Starting set, a point for the SOC leads to adjust. All use the default layout.
INSERT INTO "incident_types" ("id", "name", "description", "attack_techniques", "sort_order") VALUES
  ('ransomware', 'Ransomware', 'Data encrypted or recovery inhibited for impact.', '["T1486","T1490"]', 10),
  ('data-exfiltration', 'Data exfiltration', 'Data moved out of the environment.', '["T1041","T1048","T1567"]', 20),
  ('business-email-compromise', 'Business email compromise', 'Mailbox abuse such as forwarding rules or internal spearphishing.', '["T1114.003","T1534"]', 30),
  ('account-compromise', 'Account compromise', 'Valid accounts used by an attacker, brute force or MFA fatigue.', '["T1078","T1110","T1621"]', 40),
  ('lateral-movement', 'Lateral movement', 'Movement between hosts with remote services or stolen authentication material.', '["T1021","T1550"]', 50),
  ('malware-execution', 'Malware execution', 'Malicious code run by a user, an interpreter or an autostart.', '["T1204","T1059","T1547"]', 60),
  ('command-and-control', 'Command and control', 'Communication with attacker infrastructure or tool transfer.', '["T1071","T1105"]', 70),
  ('phishing', 'Phishing', 'Phishing messages reported or detected.', '["T1566"]', 80),
  ('external-exploitation', 'External exploitation', 'Exploitation of public-facing applications or external remote services.', '["T1190","T1133"]', 90),
  ('reconnaissance', 'Reconnaissance', 'Scanning and service discovery.', '["T1595","T1046"]', 100),
  ('policy-or-configuration', 'Policy or configuration', 'Policy violations and configuration findings; not an attack technique.', '[]', 110)
ON CONFLICT DO NOTHING;
