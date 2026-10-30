-- Clean-install verification. Read-only apart from a temporary results table
-- and two blocked-request probes that raise before anything is queued.
--   psql "$DB_URL" -X -v ON_ERROR_STOP=1 -v expected_migrations=<n> -f verify-clean-install.sql
-- Prints one PASS/FAIL line per check and exits non-zero if any check fails.
\set ON_ERROR_STOP on
\pset footer off
\pset tuples_only on
\pset format unaligned

CREATE TEMP TABLE ci_check (seq serial, name text, ok boolean, detail text);

-- 1. Ledger and provenance -----------------------------------------------------
INSERT INTO ci_check (name, ok, detail)
SELECT 'ledger: every migration recorded', count(*) = :expected_migrations,
       format('%s ledger rows, %s migration files', count(*), :expected_migrations)
FROM supabase_migrations.schema_migrations;

INSERT INTO ci_check (name, ok, detail)
SELECT 'ledger: every row carries the executed statements',
       count(*) FILTER (WHERE statements IS NULL OR cardinality(statements) = 0) = 0,
       format('%s rows without statements', count(*) FILTER (WHERE statements IS NULL OR cardinality(statements) = 0))
FROM supabase_migrations.schema_migrations;

INSERT INTO ci_check (name, ok, detail)
SELECT 'provenance: one single-transaction install run recorded',
       count(*) = 1 AND bool_and(transaction_mode = 'single_transaction'),
       string_agg(source_commit || ' / ' || migration_count, ', ')
FROM platform_ops.clean_install_runs;

INSERT INTO ci_check (name, ok, detail)
SELECT 'provenance: 8 content overrides and 1 session emulation recorded',
       count(*) FILTER (WHERE treatment <> 'session_state_emulation') = 8
   AND count(*) FILTER (WHERE treatment = 'session_state_emulation') = 1,
       string_agg(version || ':' || treatment, ', ' ORDER BY version)
FROM platform_ops.clean_install_overrides;

-- 2. Scheduled jobs ----------------------------------------------------------------
INSERT INTO ci_check (name, ok, detail)
SELECT 'cron: no scheduled job is active', count(*) FILTER (WHERE active) = 0,
       format('%s jobs, %s active: %s', count(*), count(*) FILTER (WHERE active),
              coalesce(string_agg(jobname || '=' || CASE WHEN active THEN 'ACTIVE' ELSE 'inactive' END, ', ' ORDER BY jobname), 'none'))
FROM cron.job;

INSERT INTO ci_check (name, ok, detail)
SELECT 'cron: no job has ever run in this database', count(*) = 0, format('%s run records', count(*))
FROM cron.job_run_details;

INSERT INTO ci_check (name, ok, detail)
SELECT 'cron: no job command contains a URL', count(*) = 0,
       coalesce(string_agg(jobname, ', '), 'none')
FROM cron.job WHERE command ~* '(https?://|\.supabase\.co)';

-- 3. Original-project references ----------------------------------------------------
INSERT INTO ci_check (name, ok, detail)
SELECT 'references: no function body embeds a *.supabase.co address', count(*) = 0,
       coalesce(string_agg(p.oid::regprocedure::text, ', '), 'none')
FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
WHERE n.nspname NOT IN ('pg_catalog', 'information_schema')
  AND p.prosrc ~* '[a-z0-9-]+\.supabase\.co';

INSERT INTO ci_check (name, ok, detail)
SELECT 'references: original project ref absent from functions, views, defaults, jobs and settings',
       (SELECT count(*) FROM pg_proc WHERE prosrc ILIKE '%clrsckerimjturebulbk%') = 0
   AND (SELECT count(*) FROM pg_views WHERE definition ILIKE '%clrsckerimjturebulbk%') = 0
   AND (SELECT count(*) FROM pg_attrdef WHERE pg_get_expr(adbin, adrelid) ILIKE '%clrsckerimjturebulbk%') = 0
   AND (SELECT count(*) FROM cron.job WHERE command ILIKE '%clrsckerimjturebulbk%') = 0
   AND (SELECT count(*) FROM public.settings WHERE value::text ILIKE '%clrsckerimjturebulbk%') = 0,
       'checked pg_proc, pg_views, column defaults, cron.job, public.settings';

-- 4. Outbound requests --------------------------------------------------------------
INSERT INTO ci_check (name, ok, detail)
SELECT 'egress: allowlist trigger installed and enabled on net.http_request_queue',
       count(*) = 1, coalesce(string_agg(tgname || ' enabled=' || tgenabled::text, ', '), 'missing')
FROM pg_trigger WHERE tgrelid = 'net.http_request_queue'::regclass
  AND tgname = 'platform_ops_outbound_request_allowlist' AND tgenabled = 'O';

INSERT INTO ci_check (name, ok, detail)
SELECT 'egress: allowlist and runtime configuration are empty',
       (SELECT count(*) FROM platform_ops.outbound_request_allowlist) = 0
   AND (SELECT count(*) FROM platform_ops.runtime_config) = 0,
       format('allowlist=%s runtime_config=%s',
              (SELECT count(*) FROM platform_ops.outbound_request_allowlist),
              (SELECT count(*) FROM platform_ops.runtime_config));

INSERT INTO ci_check (name, ok, detail)
SELECT 'egress: no request was ever queued or answered',
       (SELECT count(*) FROM net.http_request_queue) = 0 AND (SELECT count(*) FROM net._http_response) = 0,
       format('queue=%s responses=%s', (SELECT count(*) FROM net.http_request_queue), (SELECT count(*) FROM net._http_response));

DO $$
DECLARE v_msg text := 'no exception';
BEGIN
  BEGIN
    PERFORM net.http_post(url := 'https://blocked-probe.invalid/clean-install', body := '{}'::jsonb);
  EXCEPTION WHEN insufficient_privilege THEN v_msg := SQLERRM;
  END;
  INSERT INTO ci_check (name, ok, detail)
  VALUES ('egress: direct net.http_post is rejected', v_msg LIKE 'Outbound HTTP request blocked%', v_msg);
END $$;

DO $$
DECLARE v_before bigint; v_after bigint;
BEGIN
  SELECT count(*) INTO v_before FROM net.http_request_queue;
  PERFORM public.invoke_queue_processor('process-email-queue');
  PERFORM public.invoke_scheduled_briefings();
  SELECT count(*) INTO v_after FROM net.http_request_queue;
  INSERT INTO ci_check (name, ok, detail)
  VALUES ('egress: queue and briefing invokers do nothing while unconfigured', v_after = v_before,
          format('queue before=%s after=%s', v_before, v_after));
END $$;

INSERT INTO ci_check (name, ok, detail)
SELECT 'extensions: synchronous http and dblink extensions are not installed', count(*) = 0,
       coalesce(string_agg(extname, ', '), 'none')
FROM pg_extension WHERE extname IN ('http', 'dblink', 'postgres_fdw');

-- 5. No imported data or credentials ---------------------------------------------
INSERT INTO ci_check (name, ok, detail)
SELECT 'data: no Auth users, learners, invitations or queued work',
       (SELECT count(*) FROM auth.users) = 0
   AND (SELECT count(*) FROM public.students) = 0
   AND (SELECT count(*) FROM public.assessment_invitations) = 0
   AND (SELECT count(*) FROM public.axcelerate_writeback_queue) = 0
   AND (SELECT count(*) FROM public.organisations) = 0,
       format('auth.users=%s students=%s invitations=%s writeback_queue=%s organisations=%s',
              (SELECT count(*) FROM auth.users), (SELECT count(*) FROM public.students),
              (SELECT count(*) FROM public.assessment_invitations),
              (SELECT count(*) FROM public.axcelerate_writeback_queue),
              (SELECT count(*) FROM public.organisations));

INSERT INTO ci_check (name, ok, detail)
SELECT 'data: no integration credentials in settings or Vault',
       (SELECT count(*) FROM public.settings
         WHERE key NOT IN ('cron_secret', 'legacy_server_settings_organisation_id')
           AND key ~* '(key|secret|token|password|credential|axcelerate|stripe|smtp|resend|openai|anthropic)') = 0
   AND (SELECT count(*) FROM vault.secrets) = 0,
       format('settings keys: %s; vault secrets: %s',
              (SELECT coalesce(string_agg(key, ', ' ORDER BY key), 'none') FROM public.settings),
              (SELECT count(*) FROM vault.secrets));

INSERT INTO ci_check (name, ok, detail)
SELECT 'security: legacy GitHub RPCs are not executable by anon or authenticated',
       count(*) FILTER (WHERE has_function_privilege('anon', p.oid, 'EXECUTE')
                           OR has_function_privilege('authenticated', p.oid, 'EXECUTE')) = 0,
       format('%s functions checked', count(*))
FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
WHERE n.nspname = 'public' AND (p.proname = 'get_github_token' OR p.proname LIKE 'github\_%');

INSERT INTO ci_check (name, ok, detail)
SELECT 'security: platform_ops is not accessible to anon or authenticated',
       NOT has_schema_privilege('anon', 'platform_ops', 'USAGE')
   AND NOT has_schema_privilege('authenticated', 'platform_ops', 'USAGE'),
       'schema usage revoked';

-- 6. Required LLND objects ------------------------------------------------------------
WITH required(t) AS (VALUES
  ('organisations'), ('organisation_memberships'), ('user_workspace_access'), ('staff_invitation_grants'),
  ('support_cases'), ('staff_deletion_audit'), ('organisation_settings'), ('qualification_mapping_approvals'),
  ('platform_operators'), ('platform_operator_audit'), ('operator_access_audit'), ('operator_support_sessions'),
  ('profiles'), ('students'), ('enrolments'), ('assessment_invitations'), ('invitation_assessments'),
  ('assessment_responses'), ('qualifications'), ('settings'), ('axcelerate_inbound_sync_log'),
  ('axcelerate_writeback_queue'))
INSERT INTO ci_check (name, ok, detail)
SELECT 'llnd: required tables exist with row level security enabled',
       count(*) FILTER (WHERE c.oid IS NULL OR NOT c.relrowsecurity) = 0,
       coalesce(string_agg(r.t || CASE WHEN c.oid IS NULL THEN ' MISSING' ELSE ' RLS OFF' END, ', ')
                FILTER (WHERE c.oid IS NULL OR NOT c.relrowsecurity), format('%s tables ok', count(*)))
FROM required r
LEFT JOIN pg_class c ON c.relname = r.t AND c.relnamespace = 'public'::regnamespace AND c.relkind = 'r';

WITH required(f) AS (VALUES
  ('current_organisation_id'), ('has_workspace_access'), ('can_access_qualification'), ('can_access_support_case'),
  ('set_organisation_setting'), ('handle_new_user'), ('link_staff_invitation'), ('delete_organisation_member'),
  ('create_support_case_from_outcome'), ('approve_qualification_mapping'), ('record_qualification_source_check'),
  ('protect_assessment_result_integrity'), ('protect_qualification_source_columns'),
  ('is_platform_operator'), ('grant_platform_operator'), ('start_operator_support_session'),
  ('invoke_queue_processor'), ('invoke_scheduled_briefings'))
INSERT INTO ci_check (name, ok, detail)
SELECT 'llnd: required functions exist',
       count(*) FILTER (WHERE NOT EXISTS (SELECT 1 FROM pg_proc p WHERE p.proname = r.f
                          AND p.pronamespace = 'public'::regnamespace)) = 0,
       coalesce(string_agg(r.f || ' MISSING', ', ') FILTER (WHERE NOT EXISTS (
                 SELECT 1 FROM pg_proc p WHERE p.proname = r.f AND p.pronamespace = 'public'::regnamespace)),
                format('%s functions ok', count(*)))
FROM required r;

WITH required(tg) AS (VALUES
  ('issue040_support_outcome'), ('issue040_student_org'), ('issue040_qualification_org'),
  ('protect_assessment_result_integrity'), ('protect_qualification_source_columns'),
  ('check_organisation_setting_value'))
INSERT INTO ci_check (name, ok, detail)
SELECT 'llnd: required triggers exist and are enabled',
       count(*) FILTER (WHERE NOT EXISTS (SELECT 1 FROM pg_trigger t WHERE t.tgname = r.tg AND t.tgenabled <> 'D')) = 0,
       coalesce(string_agg(r.tg || ' MISSING', ', ') FILTER (WHERE NOT EXISTS (
                 SELECT 1 FROM pg_trigger t WHERE t.tgname = r.tg AND t.tgenabled <> 'D')), format('%s triggers ok', count(*)))
FROM required r;

INSERT INTO ci_check (name, ok, detail)
SELECT 'llnd: new Auth users are routed through handle_new_user',
       count(*) >= 1, coalesce(string_agg(tgname, ', '), 'missing')
FROM pg_trigger WHERE tgrelid = 'auth.users'::regclass AND tgfoid = 'public.handle_new_user()'::regprocedure;

INSERT INTO ci_check (name, ok, detail)
SELECT 'llnd: P1 outcome requirements_not_confirmed is allowed',
       count(*) = 1, coalesce(string_agg(conname, ', '), 'missing')
FROM pg_constraint
WHERE conrelid = 'public.assessment_invitations'::regclass AND contype = 'c'
  AND pg_get_constraintdef(oid) LIKE '%requirements_not_confirmed%';

INSERT INTO ci_check (name, ok, detail)
SELECT 'llnd: validity columns on the inbound sync log', count(*) = 5,
       string_agg(attname, ', ' ORDER BY attname)
FROM pg_attribute
WHERE attrelid = 'public.axcelerate_inbound_sync_log'::regclass AND NOT attisdropped
  AND attname IN ('decision_at', 'validated_at', 'outcome_signature', 'validity_fingerprint', 'validity_checks');

INSERT INTO ci_check (name, ok, detail)
SELECT 'llnd: row level security policies present on tenant tables', count(*) >= 20,
       format('%s policies on organisation-scoped tables', count(*))
FROM pg_policies
WHERE schemaname = 'public' AND tablename IN ('organisations', 'organisation_memberships', 'user_workspace_access',
  'students', 'enrolments', 'assessment_invitations', 'support_cases', 'qualifications', 'organisation_settings',
  'qualification_mapping_approvals', 'platform_operators', 'profiles');

-- Report ----------------------------------------------------------------------------
SELECT CASE WHEN ok THEN 'PASS' ELSE 'FAIL' END || ' | ' || name || ' | ' || coalesce(detail, '')
FROM ci_check ORDER BY seq;

DO $$
DECLARE v_failed integer;
BEGIN
  SELECT count(*) INTO v_failed FROM ci_check WHERE NOT ok;
  IF v_failed > 0 THEN
    RAISE EXCEPTION 'clean-install verification failed: % check(s)', v_failed;
  END IF;
  RAISE NOTICE 'clean-install verification passed: % checks', (SELECT count(*) FROM ci_check);
END $$;
