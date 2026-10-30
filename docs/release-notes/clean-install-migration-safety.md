# Release notes: clean-install migration safety

Branch: `feature/clean-staging-migration-safety` (based on `feature/p1-integration-safety`).
Not deployed. No hosted database has been changed.

## What changes

- A new, empty database can now be built from the repository in one
  transaction (`scripts/clean-install/bootstrap-database.sh`). No scheduled
  job can run, and no outbound request can be sent, while it installs.
- Database-initiated HTTP (pg_net) is blocked unless a destination is on a
  private allowlist. The allowlist is empty by default.
- The queue and briefing invokers no longer contain the original project's
  address. They do nothing until an approved base URL is configured.
- All scheduled jobs are inactive until separately approved.
- Legacy EIOS GitHub RPCs cannot be called by application users.
- Eight historical migrations that cannot run on an empty database have a
  reviewed, checksummed clean-install treatment. The historical files are
  unchanged.

## Migrations

- `20260701200000_clean_install_outbound_request_guard.sql` (deliberately
  ordered before the first pg_net/pg_cron migration; never applied to the
  original project)
- `20261031090000_clean_install_integration_defaults.sql` (latest migration)

## Merge order

`#40 → validity → P1 → this branch`, with `#45` merged before this branch so
that `20261031090000` remains the latest migration.

## Not included

No LLND table, policy or business rule changes. No Edge Function changes.
