/*
# Clean-install integration defaults

## Purpose
Make every environment built from this repository safe by default:
- No database function targets a hard-coded Supabase project address.
- Database-initiated calls to Edge Functions do nothing until a destination
  is configured and approved.
- Scheduled jobs are inactive until separately approved.
- Legacy EIOS GitHub RPCs that call api.github.com cannot be invoked by
  application users.

This migration does not alter LLND tables, policies or data, and it is never
applied to the original paused project.

## Changes
1. platform_ops.runtime_config (private): holds the approved Edge Functions
   base URL for this environment. Empty by default.
2. public.invoke_queue_processor(text) and public.invoke_scheduled_briefings()
   are redefined. Same names, signatures and SECURITY DEFINER behaviour as
   before, but:
   - the base URL comes from platform_ops.runtime_config, never from a
     hard-coded address or from the application-editable settings table;
   - when no base URL is configured they record a notice and return without
     making a request;
   - the request still passes the platform_ops outbound allowlist trigger
     (20260701200000), so a configured URL must also be explicitly approved.
3. Every pg_cron job owned by the migration role is set inactive. A job runs
   only after an approved, explicit cron.alter_job(..., active := true).
4. EXECUTE on the legacy EIOS GitHub RPCs (get_github_token and github_*) is
   revoked from PUBLIC, anon and authenticated.
5. Final assertion: the migration fails if any function in the public or
   platform_ops schemas still embeds a literal *.supabase.co address, or if any
   scheduled job is still active.

## Re-enabling later (requires separate Product Owner approval)
  INSERT INTO platform_ops.outbound_request_allowlist (url_prefix, reason, approved_by)
    VALUES ('https://<ref>.supabase.co/functions/v1/', '<approval>', '<name>');
  INSERT INTO platform_ops.runtime_config (key, value, updated_by)
    VALUES ('edge_functions_base_url', 'https://<ref>.supabase.co', '<name>');
  SELECT cron.alter_job(jobid, active := true) FROM cron.job WHERE jobname = '<job>';
*/

-- 1. Private runtime configuration -------------------------------------------
CREATE TABLE IF NOT EXISTS platform_ops.runtime_config (
  key        text PRIMARY KEY CHECK (key IN ('edge_functions_base_url')),
  value      text NOT NULL,
  updated_by text NOT NULL CHECK (length(btrim(updated_by)) > 0),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT runtime_config_base_url_shape CHECK (
    key <> 'edge_functions_base_url'
    OR value ~ '^https://[A-Za-z0-9.-]+(:[0-9]+)?$'
  )
);
REVOKE ALL ON TABLE platform_ops.runtime_config FROM PUBLIC;
REVOKE ALL ON TABLE platform_ops.runtime_config FROM anon, authenticated;
COMMENT ON TABLE platform_ops.runtime_config IS
  'Approved runtime configuration for database-initiated calls. Empty by default: queue and briefing invokers do nothing.';

CREATE OR REPLACE FUNCTION platform_ops.edge_functions_base_url()
RETURNS text
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
  SELECT rtrim(value, '/') FROM platform_ops.runtime_config
  WHERE key = 'edge_functions_base_url'
$$;
REVOKE ALL ON FUNCTION platform_ops.edge_functions_base_url() FROM PUBLIC;
REVOKE ALL ON FUNCTION platform_ops.edge_functions_base_url() FROM anon, authenticated, service_role;

-- 2. Configuration-driven invokers -------------------------------------------
CREATE OR REPLACE FUNCTION public.invoke_queue_processor(fn_slug text)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_base   text;
  v_secret text;
BEGIN
  IF fn_slug IS NULL OR fn_slug !~ '^[a-z0-9][a-z0-9-]{0,62}$' THEN
    RAISE EXCEPTION 'invalid Edge Function slug';
  END IF;

  v_base := platform_ops.edge_functions_base_url();
  IF v_base IS NULL THEN
    RAISE NOTICE 'invoke_queue_processor(%): skipped, no approved Edge Functions base URL is configured', fn_slug;
    RETURN;
  END IF;

  SELECT s.value #>> '{}' INTO v_secret FROM public.settings s WHERE s.key = 'cron_secret';
  IF v_secret IS NULL OR v_secret = '' THEN
    RAISE NOTICE 'invoke_queue_processor(%): skipped, cron secret is not set', fn_slug;
    RETURN;
  END IF;

  PERFORM net.http_post(
    url     := v_base || '/functions/v1/' || fn_slug,
    headers := jsonb_build_object(
      'Content-Type',  'application/json',
      'Authorization', 'Bearer ' || v_secret,
      'X-Cron-Secret', v_secret
    ),
    body    := '{}'::jsonb
  );
END;
$$;

CREATE OR REPLACE FUNCTION public.invoke_scheduled_briefings()
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
BEGIN
  -- Same configuration, allowlist and secret rules as the queue processor.
  PERFORM public.invoke_queue_processor('scheduled-briefing-runner');
END;
$$;

REVOKE EXECUTE ON FUNCTION public.invoke_queue_processor(text) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.invoke_queue_processor(text) FROM anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.invoke_scheduled_briefings() FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.invoke_scheduled_briefings() FROM anon, authenticated;

-- 3. Scheduled jobs inactive until approved ----------------------------------
DO $$
DECLARE
  j record;
BEGIN
  IF to_regclass('cron.job') IS NULL THEN
    RETURN;
  END IF;
  FOR j IN EXECUTE 'SELECT jobid, jobname FROM cron.job WHERE active AND username = current_user'
  LOOP
    PERFORM cron.alter_job(job_id := j.jobid, active := false);
    RAISE NOTICE 'scheduled job % set inactive (requires approval to enable)', j.jobname;
  END LOOP;
END;
$$;

-- 4. Legacy EIOS GitHub RPCs are not callable by application users -----------
DO $$
DECLARE
  f record;
BEGIN
  FOR f IN
    SELECT p.oid::regprocedure AS sig
    FROM pg_proc p
    JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'public'
      AND (p.proname = 'get_github_token' OR p.proname IN (
        'github_init_repo', 'github_create_tree', 'github_create_commit',
        'github_update_ref', 'github_get_branch', 'github_verify_repo'))
  LOOP
    EXECUTE format('REVOKE EXECUTE ON FUNCTION %s FROM PUBLIC', f.sig);
    EXECUTE format('REVOKE EXECUTE ON FUNCTION %s FROM anon, authenticated', f.sig);
  END LOOP;
END;
$$;

-- 5. Assertions ---------------------------------------------------------------
DO $$
DECLARE
  v_offenders text;
  v_active    integer;
BEGIN
  SELECT string_agg(p.oid::regprocedure::text, ', ' ORDER BY 1)
  INTO v_offenders
  FROM pg_proc p
  JOIN pg_namespace n ON n.oid = p.pronamespace
  WHERE n.nspname IN ('public', 'platform_ops')
    AND p.prosrc ~* '[a-z0-9-]+\.supabase\.co';
  IF v_offenders IS NOT NULL THEN
    RAISE EXCEPTION 'functions still embed a Supabase project address: %', v_offenders;
  END IF;

  IF to_regclass('cron.job') IS NOT NULL THEN
    EXECUTE 'SELECT count(*) FROM cron.job WHERE active' INTO v_active;
    IF v_active > 0 THEN
      RAISE EXCEPTION '% scheduled job(s) are still active', v_active;
    END IF;
  END IF;
END;
$$;
