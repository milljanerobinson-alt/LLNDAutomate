/*
# Clean-install outbound request guard

## Why this migration exists
A fresh database built from this repository must never send HTTP requests to
an environment it was not explicitly approved to call. Two historical
migrations (20260701201005 and 20260707060457) hard-code the original LLND
Supabase project address, and several historical migrations schedule pg_cron
jobs that call it through pg_net.

## Why the version is earlier than its authoring date
It was written on 2026-10-31 but is deliberately versioned 20260701200000 so
that it runs immediately before 20260701200735, the first migration that
enables pg_net and pg_cron. That ordering means the guard is in place before
any statement in the history can queue an outbound request. The original
paused project never receives this migration; its recovery history is
unchanged.

## What it does
1. Enables pg_net (same statement as 20260701200735, so that later statement
   becomes a no-op).
2. Creates the private platform_ops schema (no access for anon or
   authenticated users).
3. Creates platform_ops.outbound_request_allowlist, empty by default.
4. Adds a BEFORE INSERT trigger on net.http_request_queue. Every pg_net
   request (net.http_get / net.http_post / net.http_delete) passes through
   that table, so a request whose URL does not start with an approved prefix
   is rejected before it is queued. With the allowlist empty, all database
   outbound HTTP is blocked.
5. Creates platform_ops.clean_install_overrides and
   platform_ops.clean_install_runs, which the clean-install bootstrap fills in
   to record how a fresh database was built.

## What it does not do
- It does not change pg_cron. Scheduled jobs are kept inactive during a clean
  install by the single-transaction bootstrap
  (scripts/clean-install/bootstrap-database.sh) and left inactive afterwards
  by 20261031090000_clean_install_integration_defaults.sql.
- It does not block the synchronous `http` extension, which no migration
  enables. The clean-install verification fails if that extension is present.

## Approving an outbound destination later
Only a role that owns platform_ops (postgres) can insert into the allowlist.
Each row must carry a reason and an approver, for example:
  INSERT INTO platform_ops.outbound_request_allowlist (url_prefix, reason, approved_by)
  VALUES ('https://<staging-ref>.supabase.co/functions/v1/', '<approval ref>', '<name>');
*/

CREATE EXTENSION IF NOT EXISTS pg_net WITH SCHEMA extensions;

CREATE SCHEMA IF NOT EXISTS platform_ops;
REVOKE ALL ON SCHEMA platform_ops FROM PUBLIC;
REVOKE ALL ON SCHEMA platform_ops FROM anon, authenticated;
COMMENT ON SCHEMA platform_ops IS
  'Private platform operations controls: outbound request allowlist, runtime configuration and clean-install provenance. Not exposed to anon or authenticated users.';

CREATE TABLE IF NOT EXISTS platform_ops.outbound_request_allowlist (
  url_prefix  text PRIMARY KEY
              CHECK (url_prefix ~ '^https://[A-Za-z0-9.-]+(:[0-9]+)?/'),
  reason      text NOT NULL CHECK (length(btrim(reason)) > 0),
  approved_by text NOT NULL CHECK (length(btrim(approved_by)) > 0),
  approved_at timestamptz NOT NULL DEFAULT now()
);
COMMENT ON TABLE platform_ops.outbound_request_allowlist IS
  'Approved URL prefixes for database-initiated HTTP (pg_net). Empty by default: all database outbound HTTP is blocked.';

CREATE OR REPLACE FUNCTION platform_ops.enforce_outbound_request_allowlist()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
BEGIN
  IF NEW.url IS NULL OR NOT EXISTS (
    SELECT 1
    FROM platform_ops.outbound_request_allowlist a
    WHERE left(NEW.url, length(a.url_prefix)) = a.url_prefix
  ) THEN
    -- Only the host is reported: query strings can carry credentials.
    RAISE EXCEPTION 'Outbound HTTP request blocked: destination % is not on the approved allowlist',
      coalesce(substring(NEW.url FROM '^[A-Za-z]+://([^/?#]+)'), '(unparseable)')
      USING ERRCODE = 'insufficient_privilege',
            HINT = 'Database outbound HTTP is disabled until a destination is approved in platform_ops.outbound_request_allowlist.';
  END IF;
  RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION platform_ops.enforce_outbound_request_allowlist() FROM PUBLIC;
REVOKE ALL ON FUNCTION platform_ops.enforce_outbound_request_allowlist() FROM anon, authenticated, service_role;

DROP TRIGGER IF EXISTS platform_ops_outbound_request_allowlist ON net.http_request_queue;
CREATE TRIGGER platform_ops_outbound_request_allowlist
  BEFORE INSERT ON net.http_request_queue
  FOR EACH ROW EXECUTE FUNCTION platform_ops.enforce_outbound_request_allowlist();

CREATE TABLE IF NOT EXISTS platform_ops.clean_install_runs (
  id                 bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  source_commit      text NOT NULL,
  manifest_sha256    text NOT NULL,
  migration_count    integer NOT NULL CHECK (migration_count > 0),
  transaction_mode   text NOT NULL CHECK (transaction_mode = 'single_transaction'),
  completed_at       timestamptz NOT NULL DEFAULT now()
);
COMMENT ON TABLE platform_ops.clean_install_runs IS
  'One row per database built by the clean-install bootstrap: source commit, manifest checksum and migration count.';

CREATE TABLE IF NOT EXISTS platform_ops.clean_install_overrides (
  version            text PRIMARY KEY,
  migration_name     text NOT NULL,
  treatment          text NOT NULL CHECK (treatment IN (
                       'repaired_export_defect',
                       'schema_effects_only',
                       'environment_specific_data_not_replayed')),
  original_sha256    text NOT NULL,
  executed_sha256    text NOT NULL,
  reason             text NOT NULL,
  recorded_at        timestamptz NOT NULL DEFAULT now()
);
COMMENT ON TABLE platform_ops.clean_install_overrides IS
  'Historical migrations whose content was not executed verbatim in a clean install, with the treatment, checksums and reason (see supabase/clean-install/manifest.json).';

REVOKE ALL ON ALL TABLES IN SCHEMA platform_ops FROM PUBLIC;
REVOKE ALL ON ALL TABLES IN SCHEMA platform_ops FROM anon, authenticated;
