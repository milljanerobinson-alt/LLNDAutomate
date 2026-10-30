# Clean-install migration baseline

How to build a new, empty LLND Automate database (for example the planned
clean staging project) from this repository safely and repeatably.

Status: prepared and rehearsed against a disposable local Supabase
PostgreSQL 17 database only. No hosted environment has been created or
changed. Running this against any hosted project needs separate Product
Owner approval.

## Why plain `supabase db push` is not enough for a first install

1. **Eight historical migrations cannot be replayed verbatim** on an empty
   database (see the table below). The Supabase CLI stops at the first
   failure, which is `20260712095937`, about halfway through the history and
   before any LLND workspace, validity or P1 migration runs.
2. **Historical migrations schedule pg_cron jobs and define functions that
   call the original Supabase project.** The CLI commits each file
   separately, so those jobs become live part-way through the install and can
   run before any later migration disables them.

## What makes the clean install safe

| Layer | Where | Effect |
|---|---|---|
| Single transaction | `scripts/clean-install/build-bootstrap.mjs` | Every migration, and its ledger row, is applied in one transaction. Nothing (cron jobs, queued HTTP requests) is visible to the pg_cron scheduler or the pg_net worker until COMMIT, and by then the jobs are inactive. No job can run during installation. |
| Outbound request guard | `supabase/migrations/20260701200000_clean_install_outbound_request_guard.sql` | Runs before the first migration that enables pg_net or pg_cron. A trigger on `net.http_request_queue` rejects any database HTTP request whose URL is not on `platform_ops.outbound_request_allowlist`. The allowlist is empty. |
| Integration defaults | `supabase/migrations/20261031090000_clean_install_integration_defaults.sql` | Replaces the two invokers that hard-code the original project with versions that read an approved base URL from `platform_ops.runtime_config` and do nothing when it is unset. Sets every cron job inactive, revokes the legacy GitHub RPCs from application users, and fails if any function still embeds a `*.supabase.co` address or any job is active. |
| Empty-target check | generated SQL | Refuses to run if the public schema has tables or the migration ledger has rows. |
| Denylist | `bootstrap-database.sh` and `manifest.json` | Refuses any connection string containing the original project ref. |
| Verification | `scripts/clean-install/verify-clean-install.sql` | PASS/FAIL checks: ledger, provenance, inactive jobs, no job runs, no original-project references, egress blocked, no data or credentials, required LLND tables, functions, triggers and RLS. |

## The eight historical migrations

Historical files are **never edited**. Their reviewed treatment lives in
`supabase/clean-install/manifest.json` and `supabase/clean-install/overrides/`.
The builder checks the SHA-256 of every historical file and override and
refuses to run if either has changed since review. The same applies to the
one session-state emulation described below.

| Version | File | Fresh-install failure | Treatment | Effect in a clean install |
|---|---|---|---|---|
| 20260712095937 | ewo009_1_memory_seed_canonical | FK: engineering records that no migration creates | environment-specific data not replayed | none (EIOS memory seed of the original) |
| 20260722093701 | ewo021r6r1_repair_ewo014_7e_lineage | FK: a specific original integrity alert | environment-specific data not replayed | none (repair of one original record) |
| 20260725073902 | ewo028_phase_closeout (070500) | FK: original EWO-017R.2R reconciliation | schema effects only | `correction` reconciliation type kept (also applied by 20260725073913) |
| 20260725073951 | ewo028_phase_closeout (070502) | FK: same as above | environment-specific data not replayed | none (duplicate closeout data) |
| 20260801092711 | ewo048_create_eios_platform_project | FK: original EIOS tenant | schema effects only | `tenant_member_can_read_projects()` and the `ecc_projects` SELECT policy kept |
| 20260802230228 | ewo049_restore_canonical_numbering_policy | syntax error: comment split after `;` | repaired export defect | all statements run; one comment line rejoined |
| 20260804050844 | ewo047r2_fix_project_id_type_cast | syntax error: comment split after `;` | repaired export defect | all statements run; one comment line rejoined |
| 20260804100038 | ewo047r4_restore_conversation_association | FK: original EWO-047 conversation | environment-specific data not replayed | none (one original association) |

Why not replay the data: the referenced parent records were created at
runtime in the original project and are not in any migration. Replaying the
rest would also write Product Owner acceptance, closeout and audit records
for work that never happened in the new environment, which would falsify its
audit history. No LLND table, function or policy is touched by the omitted
statements, and no later migration depends on them (every later migration
applies in the rehearsal).

Why the two syntax errors are repairs, not edits: both files show the same
mechanical defect, a `--` comment line split after its semicolon, which
cannot have run as written. Only those two files in the history show it. The
override rejoins the one line and runs everything else verbatim.

## One session-state emulation

`20260725230259_ewo030r3_correct_unauthorised_acceptance` runs verbatim, but
only if the database session behaves as it did on the original project.
Its EWO status change passes the lifecycle trigger only because
`current_setting('app.bypass_lifecycle_validation', true)` is NULL in a fresh
session, and `NULL != 'true'` skips validation. The original project applied
each migration in its own session. In one long install session (single
transaction or plain CLI) earlier files have already defined that setting, so
validation runs and the file fails. The rehearsal shows the plain CLI fails
here too.

The bootstrap sets `app.bypass_lifecycle_validation = true` for that one file
(transaction-local, reset before the next file), which reproduces the
original outcome. This is the only NULL-sensitive session check in the
history (a test enforces that). The setting line is part of the executed text
recorded in the ledger, and the treatment is recorded in
`platform_ops.clean_install_overrides` as `session_state_emulation`.

## How it is recorded

- `supabase_migrations.schema_migrations`: one row per migration file,
  written in the same transaction, with the **executed** text in
  `statements`. For the eight overrides this is the override text, and for
  files that wrapped themselves in `BEGIN;`/`COMMIT;` those two lines are
  shown as removed comments. The CLI compares versions only, so later
  `supabase db push` runs work normally.
- `platform_ops.clean_install_overrides`: version, treatment, original
  SHA-256, executed SHA-256 and reason for each of the eight overrides and
  the one session-state emulation.
- `platform_ops.clean_install_runs`: source commit, manifest SHA-256 and
  migration count of the install.

## Procedure (after approval only)

```bash
# 1. From a clean checkout of the approved commit (all of #40, #45, validity,
#    P1 and this branch merged in order):
scripts/clean-install/bootstrap-database.sh --source-commit "$(git rev-parse HEAD)"      # dry run: builds and checks only
# 2. Against the NEW, EMPTY project only:
scripts/clean-install/bootstrap-database.sh --db-url "$STAGING_DB_URL" --execute          # applies + verifies
# 3. All later migrations:
supabase db push --db-url "$STAGING_DB_URL"
```

Use a direct or session-pooler connection (not the transaction pooler) for
step 2, because it is one long transaction.

## Turning integrations on later (each needs separate approval)

```sql
INSERT INTO platform_ops.outbound_request_allowlist (url_prefix, reason, approved_by)
  VALUES ('https://<staging-ref>.supabase.co/functions/v1/', '<approval>', '<name>');
INSERT INTO platform_ops.runtime_config (key, value, updated_by)
  VALUES ('edge_functions_base_url', 'https://<staging-ref>.supabase.co', '<name>');
SELECT cron.alter_job(jobid, active := true) FROM cron.job WHERE jobname = '<job>';
```

## Known limitations

- The outbound guard is a trigger on a pg_net table. If Supabase upgrades
  pg_net in a way that recreates that table, the trigger could be lost. The
  invokers still do nothing without `runtime_config`, but re-run
  `verify-clean-install.sql` after any platform upgrade.
- The guard covers pg_net only. The synchronous `http` extension is not
  enabled by any migration; verification fails if it appears.
- The local Supabase image matches hosted roles and privileges (the
  `postgres` role is not a superuser in either), but the single long
  transaction has not been run on hosted infrastructure.
- A plain `supabase db reset` from the repository still stops at
  `20260712095937`. Use the bootstrap for any empty database, local or hosted.
