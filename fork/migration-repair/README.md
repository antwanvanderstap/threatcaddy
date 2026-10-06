# Migration history repair (fork only)

Not part of any upstream change. A database first migrated by the pre-merge
`feat/asset-management` branch (SECOPS1, the local twin) has a migration history
upstream's `migrateDatabase` rejects: that branch rewrote the timestamps of
0000–0019 and had its own 0020 and 0021. The merged server refuses to start on
such a database ("Unsupported or modified migration history").

`repair.sql` runs once, in one transaction, before the first start of the merged
server. It checks the history is exactly the branch's (otherwise it changes
nothing), applies upstream 0020 in IF NOT EXISTS form, and rewrites the history
to upstream's 0000–0020. On start the server applies 0021–0025 itself.

```sh
# server stopped, database running, a fresh pg_dump taken first
docker compose exec -T db psql -U tc -d threatcaddy -v ON_ERROR_STOP=1 < fork/migration-repair/repair.sql
```

The merged server also needs two settings the branch did not:

- `BOT_MASTER_KEY`: 64 hex characters (`openssl rand -hex 32`), kept stable.
- `WEBHOOK_INGEST_OWNER_ID`: id of the active analyst or admin who owns ingested
  investigations (the rest of the team is added as editors).

Rehearsed 2026-10-06 on a copy of the twin's database, with case-log rows seeded:
repair, migrate, schema and sync contracts, server start, and the intake's
ingest / external-refs / case-updates calls all passed.

`repair.sql` is generated: `python3 fork/migration-repair/generate.py`.
