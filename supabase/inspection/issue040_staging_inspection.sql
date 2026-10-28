-- Issue #40 — READ-ONLY staging inspection (schema, migration ledger, counts).
--
-- Run in the Supabase SQL Editor for the staging project, then copy the single
-- JSON value from the result and send it back.
--
-- Safety:
--   * Only SELECTs. Nothing is created, changed or deleted.
--   * No setting VALUES, tokens, passwords, emails or names of people are read.
--     It returns setting KEY names, organisation names, object names and counts.
--   * Works whether or not the earlier Issue #40 migrations are installed:
--     missing tables/functions are reported as missing instead of erroring.
WITH
t(name) AS (VALUES
  ('organisations'),('organisation_memberships'),('user_workspace_access'),('staff_invitation_grants'),
  ('support_cases'),('staff_deletion_audit'),('organisation_settings'),('organisation_secrets'),
  ('profiles'),('students'),('enrolments'),('assessment_invitations'),
  ('qualifications'),('qualification_lln_requirements'),('qualification_mapping_evidence'),
  ('qualification_mapping_logs'),('mapping_unit_evidence'),('mapping_evidence_attachments'),
  ('mapping_evidence_reviews'),('mapping_evidence_audit'),
  ('settings'),('subscription_plans'),('subscriptions'),('billing_usage'),('billable_learners'),('billing_events'),
  ('axcelerate_sync_log'),('axcelerate_inbound_sync_log'),('axcelerate_writeback_queue'),('email_queue'),
  ('audit_trail'),('intervention_cases'),('support_plans')
),
tables AS (
  SELECT t.name,
         to_regclass('public.' || t.name) IS NOT NULL AS present,
         CASE WHEN to_regclass('public.' || t.name) IS NOT NULL THEN
           (xpath('/row/c/text()', query_to_xml(format('SELECT count(*) AS c FROM public.%I', t.name), false, true, '')))[1]::text::bigint
         END AS row_count,
         EXISTS (SELECT 1 FROM information_schema.columns c
                 WHERE c.table_schema = 'public' AND c.table_name = t.name AND c.column_name = 'organisation_id') AS has_organisation_id,
         (SELECT relrowsecurity FROM pg_class WHERE oid = to_regclass('public.' || t.name)) AS rls_enabled
  FROM t
),
f(name) AS (VALUES
  ('current_organisation_id'),('has_workspace_access'),('update_organisation_member'),('list_organisation_staff'),
  ('prepare_staff_invitation'),('link_staff_invitation'),('reconcile_staff_invitation'),
  ('activate_confirmed_staff_invitation'),('handle_new_user'),('check_profile_role_unchanged'),
  ('set_candidate_organisation'),('set_diagnostic_organisation'),('can_access_support_case'),
  ('staff_provenance_references'),('get_staff_deletion_blockers'),('delete_organisation_member'),
  ('get_my_role')
),
functions AS (
  SELECT f.name,
         count(p.oid) AS overloads,
         bool_or(p.prosecdef) AS security_definer,
         max(pg_get_userbyid(p.proowner)) AS owner,
         max(md5(p.prosrc)) AS body_md5
  FROM f LEFT JOIN pg_proc p ON p.proname = f.name AND p.pronamespace = 'public'::regnamespace
  GROUP BY f.name
),
policies AS (
  SELECT tablename, policyname, cmd, roles::text AS roles,
         left(regexp_replace(coalesce(qual, '') || ' | ' || coalesce(with_check, ''), '\s+', ' ', 'g'), 300) AS rule
  FROM pg_policies
  WHERE schemaname = 'public'
    AND tablename IN (SELECT name FROM t)
),
ledger AS (
  SELECT CASE WHEN to_regclass('supabase_migrations.schema_migrations') IS NOT NULL THEN
    (xpath('/row/j/text()', query_to_xml($q$
      SELECT json_build_object(
        'total', count(*),
        'latest_25', (SELECT json_agg(v ORDER BY v DESC) FROM (SELECT version AS v FROM supabase_migrations.schema_migrations ORDER BY version DESC LIMIT 25) x),
        'issue040_versions', (SELECT json_agg(version ORDER BY version) FROM supabase_migrations.schema_migrations
                              WHERE version IN ('20260809092000','20260810170000','20260810223000','20260811040000','20261028120000','20261028130000'))
      )::text AS j FROM supabase_migrations.schema_migrations
    $q$, false, true, '')))[1]::text::json
  END AS j
),
dyn AS (
  SELECT
    CASE WHEN to_regclass('public.settings') IS NOT NULL THEN
      (xpath('/row/j/text()', query_to_xml('SELECT coalesce(json_agg(key ORDER BY key), ''[]'')::text AS j FROM public.settings', false, true, '')))[1]::text::json END AS settings_keys,
    CASE WHEN to_regclass('public.organisations') IS NOT NULL THEN
      (xpath('/row/j/text()', query_to_xml($q$SELECT coalesce(json_agg(json_build_object('id', id, 'name', name, 'created_at', created_at) ORDER BY created_at), '[]')::text AS j FROM public.organisations$q$, false, true, '')))[1]::text::json END AS organisations,
    CASE WHEN to_regclass('public.organisation_memberships') IS NOT NULL AND to_regclass('public.user_workspace_access') IS NOT NULL THEN
      (xpath('/row/j/text()', query_to_xml($q$
        SELECT coalesce(json_agg(r), '[]')::text AS j FROM (
          SELECT m.organisation_id, m.status, count(DISTINCT m.user_id) AS members,
                 count(DISTINCT m.user_id) FILTER (WHERE w.workspace = 'administration') AS with_administration,
                 count(DISTINCT m.user_id) FILTER (WHERE w.workspace = 'candidate_support') AS with_candidate_support,
                 count(DISTINCT m.user_id) FILTER (WHERE w.workspace = 'technical') AS with_technical
          FROM public.organisation_memberships m
          LEFT JOIN public.user_workspace_access w ON w.user_id = m.user_id
          GROUP BY m.organisation_id, m.status ORDER BY 1, 2) r
      $q$, false, true, '')))[1]::text::json END AS memberships,
    (xpath('/row/j/text()', query_to_xml($q$SELECT coalesce(json_agg(r), '[]')::text AS j FROM (SELECT to_jsonb(p)->>'role' AS role, to_jsonb(p)->>'is_active' AS is_active, count(*) AS n FROM public.profiles p GROUP BY 1, 2 ORDER BY 1, 2) r$q$, false, true, '')))[1]::text::json AS profiles_by_role,
    CASE WHEN to_regclass('public.staff_invitation_grants') IS NOT NULL THEN
      (xpath('/row/j/text()', query_to_xml($q$SELECT coalesce(json_agg(r), '[]')::text AS j FROM (SELECT status, count(*) AS n FROM public.staff_invitation_grants GROUP BY 1) r$q$, false, true, '')))[1]::text::json END AS invitation_grants
),
auth_triggers AS (
  SELECT json_agg(json_build_object('trigger', tgname, 'function', tgfoid::regproc::text, 'enabled', tgenabled) ORDER BY tgname) AS j
  FROM pg_trigger WHERE tgrelid = 'auth.users'::regclass AND NOT tgisinternal
),
user_fks AS (
  SELECT json_agg(json_build_object('table', conrelid::regclass::text, 'column', a.attname,
           'on_delete', CASE confdeltype WHEN 'a' THEN 'no action' WHEN 'r' THEN 'restrict' WHEN 'c' THEN 'cascade' WHEN 'n' THEN 'set null' WHEN 'd' THEN 'set default' END)
         ORDER BY conrelid::regclass::text, a.attname) AS j
  FROM pg_constraint k
  JOIN pg_attribute a ON a.attrelid = k.conrelid AND a.attnum = k.conkey[1]
  WHERE k.contype = 'f' AND k.confrelid IN ('auth.users'::regclass, to_regclass('public.profiles'))
    AND k.conrelid::regclass::text NOT LIKE 'auth.%'
)
SELECT json_build_object(
  'inspected_at', now(),
  'postgres_version', current_setting('server_version'),
  'migration_ledger', (SELECT j FROM ledger),
  'tables', (SELECT json_agg(json_build_object('table', name, 'present', present, 'rows', row_count,
                     'has_organisation_id', has_organisation_id, 'rls', rls_enabled) ORDER BY name) FROM tables),
  'functions', (SELECT json_agg(json_build_object('function', name, 'present', overloads > 0, 'overloads', overloads,
                     'security_definer', security_definer, 'owner', owner, 'body_md5', body_md5) ORDER BY name) FROM functions),
  'policies', (SELECT json_agg(json_build_object('table', tablename, 'policy', policyname, 'cmd', cmd, 'roles', roles, 'rule', rule)
                     ORDER BY tablename, policyname) FROM policies),
  'auth_users_triggers', (SELECT j FROM auth_triggers),
  'foreign_keys_to_users', (SELECT j FROM user_fks),
  'postgres_can_delete_auth_users', has_table_privilege('postgres', 'auth.users', 'DELETE'),
  'candidate_table_columns', (SELECT json_object_agg(table_name, cols) FROM (
      SELECT table_name, json_agg(column_name ORDER BY ordinal_position) AS cols
      FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name IN ('students','enrolments','assessment_invitations')
      GROUP BY table_name) c),
  'settings_key_names', (SELECT settings_keys FROM dyn),
  'organisations', (SELECT organisations FROM dyn),
  'memberships', (SELECT memberships FROM dyn),
  'profiles_by_role', (SELECT profiles_by_role FROM dyn),
  'invitation_grants', (SELECT invitation_grants FROM dyn)
) AS issue040_inspection;
