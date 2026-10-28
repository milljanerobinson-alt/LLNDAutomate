/* Issue #40 — Product Owner refinement (12 August 2026; scope confirmed
   28 October 2026): Administration and Technical data are organisation-scoped.

   Scope (existing features only; no new billing functionality):
   1. Qualifications and their LLN requirements, ACSF mapping evidence, unit
      evidence, attachments, reviews, mapping audit and mapping logs belong to
      one RTO organisation. Any active staff member of that RTO may read them;
      only Administration may change them.
   2. RTO configuration moves from the platform-wide `settings` table into
      `organisation_settings` (one row per organisation and key, allow-listed
      keys only, never secrets). Administration keys are managed by
      Administration; Technical keys by Technical or Administration. Writes go
      through set_organisation_setting().
   3. The platform `settings` table (Stripe/AI/email/aXcelerate secrets, cron
      secret, platform configuration) is no longer readable or writable from
      the browser, except the non-secret `environment` key. Edge Functions
      using the service role are unaffected.
   4. Subscriptions belong to one organisation; billing usage, billable
      learners and billing events are visible only to that organisation's
      Administration users. Billable completions are recorded against the
      candidate's own organisation's subscription instead of the newest
      subscription on the platform.
   5. Server-written Technical logs and queues (email queue, aXcelerate
      write-back queue and sync logs) take their organisation from the related
      invitation, so server jobs no longer fail the base Issue #40 trigger.
   6. Server-created candidates, enrolments and invitations (aXcelerate inbound
      sync) may name their owning organisation when several RTOs exist, and
      inserting a candidate no longer fails on the base trigger's reference to
      a student_id field that the students table does not have.
   7. Legacy "any admin/trainer" staff policies left on enrolments, candidate
      answers, audit trail, lifecycle history, notifications, portfolio uploads
      and Technical queues/logs are replaced with organisation-scoped ones.
      Candidate token policies are not touched.

   Server compatibility bridge (temporary, until aXcelerate/email server
   functions are made organisation-aware): Edge Functions still read
   org_branding, email_settings, notification_settings, reminder/overdue days
   and the aXcelerate watch list/auto-sync from `settings`. For the single
   organisation recorded in settings key `legacy_server_settings_organisation_id`
   (the legacy RTO), changes to those organisation_settings keys are mirrored
   into `settings`. Other organisations' values are stored and visible to them
   but are not yet used by those server functions.

   Legacy ownership: rows that existed before organisations are assigned to the
   legacy organisation. If exactly one organisation exists it is used.
   Otherwise the migration stops unless the operator first runs, in the same
   SQL session:  SELECT set_config('llnd.legacy_organisation_id', '<uuid>', false);

   Deployment: forward-only; requires 20260809092000_issue040_rto_workspace_access.
   Before applying to a shared environment take a Supabase backup/PITR recovery
   point and record the row counts listed in docs/security/issue-40-staging-migration.md.
*/

BEGIN;

-- ── 0. Preflight ───────────────────────────────────────────────────────────
DO $$
BEGIN
  IF to_regclass('public.organisations') IS NULL
     OR to_regclass('public.organisation_memberships') IS NULL
     OR to_regprocedure('public.current_organisation_id()') IS NULL
     OR to_regprocedure('public.has_workspace_access(text)') IS NULL
     OR NOT EXISTS (SELECT 1 FROM information_schema.columns
                    WHERE table_schema = 'public' AND table_name = 'user_workspace_access'
                      AND column_name = 'organisation_id') THEN
    RAISE EXCEPTION 'Issue #40 data scoping preflight: the base Issue #40 migration (20260809092000) is not installed';
  END IF;
END $$;

CREATE FUNCTION pg_temp.issue040_legacy_owner(p_what text, p_rows bigint, p_required boolean)
RETURNS uuid LANGUAGE plpgsql AS $$
DECLARE
  chosen uuid := nullif(current_setting('llnd.legacy_organisation_id', true), '')::uuid;
  org_count integer;
BEGIN
  IF p_rows = 0 THEN RETURN NULL; END IF;
  IF chosen IS NOT NULL THEN
    IF NOT EXISTS (SELECT 1 FROM public.organisations WHERE id = chosen) THEN
      RAISE EXCEPTION 'Issue #40 data scoping: llnd.legacy_organisation_id % does not exist', chosen;
    END IF;
    RETURN chosen;
  END IF;
  SELECT count(*) INTO org_count FROM public.organisations;
  IF org_count = 1 THEN RETURN (SELECT id FROM public.organisations); END IF;
  IF p_required THEN
    RAISE EXCEPTION 'Issue #40 data scoping: % existing % rows have no organisation and % organisations exist. Run SELECT set_config(''llnd.legacy_organisation_id'', ''<uuid>'', false); with the organisation that owns legacy data, then re-run this migration in the same session.',
      p_rows, p_what, org_count;
  END IF;
  RETURN NULL;
END $$;

-- ── 1. Shared helpers ──────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.is_active_organisation_staff()
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public AS $$
  SELECT public.has_workspace_access('administration')
      OR public.has_workspace_access('candidate_support')
      OR public.has_workspace_access('technical')
$$;
REVOKE ALL ON FUNCTION public.is_active_organisation_staff() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.is_active_organisation_staff() TO authenticated;

-- Ownership for organisation-scoped rows. End users can only write their own
-- organisation; trusted server contexts (no end-user JWT) must supply the
-- organisation unless exactly one organisation exists. Ownership never moves.
CREATE OR REPLACE FUNCTION public.set_owned_organisation()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE caller_org uuid;
BEGIN
  IF TG_OP = 'UPDATE' AND NEW.organisation_id IS DISTINCT FROM OLD.organisation_id THEN
    RAISE EXCEPTION 'organisation ownership cannot be changed';
  END IF;
  IF auth.uid() IS NOT NULL THEN
    caller_org := public.current_organisation_id();
    IF caller_org IS NULL THEN RAISE EXCEPTION 'active organisation membership required'; END IF;
    IF NEW.organisation_id IS NULL THEN
      NEW.organisation_id := caller_org;
    ELSIF NEW.organisation_id <> caller_org THEN
      RAISE EXCEPTION 'cross-organisation write denied';
    END IF;
  ELSIF NEW.organisation_id IS NULL THEN
    IF (SELECT count(*) FROM public.organisations) = 1 THEN
      NEW.organisation_id := (SELECT id FROM public.organisations);
    ELSE
      RAISE EXCEPTION 'organisation ownership must be supplied by the server';
    END IF;
  END IF;
  RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION public.set_owned_organisation() FROM PUBLIC, anon, authenticated;

-- Replace every existing policy on the in-scope tables (hosted policy names may
-- differ from repository history). subscription_plans is intentionally untouched.
DO $$
DECLARE r record;
BEGIN
  FOR r IN
    SELECT schemaname, tablename, policyname FROM pg_policies
    WHERE schemaname = 'public' AND tablename IN (
      'qualifications','qualification_lln_requirements','qualification_mapping_evidence',
      'qualification_mapping_logs','mapping_unit_evidence','mapping_evidence_attachments',
      'mapping_evidence_reviews','mapping_evidence_audit','settings',
      'subscriptions','billing_usage','billable_learners','billing_events')
  LOOP
    EXECUTE format('DROP POLICY %I ON %I.%I', r.policyname, r.schemaname, r.tablename);
  END LOOP;
END $$;

-- ── 2. Qualifications family ───────────────────────────────────────────────
ALTER TABLE public.qualifications ADD COLUMN IF NOT EXISTS organisation_id uuid REFERENCES public.organisations(id);
DO $$
DECLARE n bigint; owner_id uuid;
BEGIN
  SELECT count(*) INTO n FROM public.qualifications WHERE organisation_id IS NULL;
  owner_id := pg_temp.issue040_legacy_owner('qualification', n, true);
  UPDATE public.qualifications SET organisation_id = owner_id WHERE organisation_id IS NULL;
END $$;
ALTER TABLE public.qualifications ALTER COLUMN organisation_id SET NOT NULL;
CREATE INDEX IF NOT EXISTS idx_qualifications_org ON public.qualifications(organisation_id);
DROP TRIGGER IF EXISTS issue040_qualification_org ON public.qualifications;
CREATE TRIGGER issue040_qualification_org BEFORE INSERT OR UPDATE ON public.qualifications
  FOR EACH ROW EXECUTE FUNCTION public.set_owned_organisation();

CREATE OR REPLACE FUNCTION public.can_access_qualification(target_qualification uuid, for_write boolean)
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public AS $$
  SELECT EXISTS (
    SELECT 1 FROM public.qualifications q
    WHERE q.id = target_qualification AND q.organisation_id = public.current_organisation_id()
  ) AND CASE WHEN for_write THEN public.has_workspace_access('administration')
             ELSE public.is_active_organisation_staff() END
$$;
REVOKE ALL ON FUNCTION public.can_access_qualification(uuid, boolean) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.can_access_qualification(uuid, boolean) TO authenticated;

CREATE OR REPLACE FUNCTION public.can_access_mapping_evidence(target_evidence uuid, for_write boolean)
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public AS $$
  SELECT EXISTS (
    SELECT 1 FROM public.qualification_mapping_evidence e
    JOIN public.qualifications q ON q.id = e.qualification_id
    WHERE e.id = target_evidence AND q.organisation_id = public.current_organisation_id()
  ) AND CASE WHEN for_write THEN public.has_workspace_access('administration')
             ELSE public.is_active_organisation_staff() END
$$;
REVOKE ALL ON FUNCTION public.can_access_mapping_evidence(uuid, boolean) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.can_access_mapping_evidence(uuid, boolean) TO authenticated;

CREATE POLICY qualifications_org_select ON public.qualifications FOR SELECT TO authenticated
  USING (organisation_id = public.current_organisation_id() AND public.is_active_organisation_staff());
CREATE POLICY qualifications_org_admin_insert ON public.qualifications FOR INSERT TO authenticated
  WITH CHECK (organisation_id = public.current_organisation_id() AND public.has_workspace_access('administration'));
CREATE POLICY qualifications_org_admin_update ON public.qualifications FOR UPDATE TO authenticated
  USING (organisation_id = public.current_organisation_id() AND public.has_workspace_access('administration'))
  WITH CHECK (organisation_id = public.current_organisation_id() AND public.has_workspace_access('administration'));
CREATE POLICY qualifications_org_admin_delete ON public.qualifications FOR DELETE TO authenticated
  USING (organisation_id = public.current_organisation_id() AND public.has_workspace_access('administration'));

-- Children scoped through their qualification.
DO $$
DECLARE tbl text;
BEGIN
  FOREACH tbl IN ARRAY ARRAY['qualification_lln_requirements','qualification_mapping_evidence'] LOOP
    EXECUTE format('CREATE POLICY %I ON public.%I FOR SELECT TO authenticated USING (public.can_access_qualification(qualification_id, false))', tbl || '_org_select', tbl);
    EXECUTE format('CREATE POLICY %I ON public.%I FOR INSERT TO authenticated WITH CHECK (public.can_access_qualification(qualification_id, true))', tbl || '_org_admin_insert', tbl);
    EXECUTE format('CREATE POLICY %I ON public.%I FOR UPDATE TO authenticated USING (public.can_access_qualification(qualification_id, true)) WITH CHECK (public.can_access_qualification(qualification_id, true))', tbl || '_org_admin_update', tbl);
    EXECUTE format('CREATE POLICY %I ON public.%I FOR DELETE TO authenticated USING (public.can_access_qualification(qualification_id, true))', tbl || '_org_admin_delete', tbl);
  END LOOP;
  FOREACH tbl IN ARRAY ARRAY['mapping_unit_evidence','mapping_evidence_attachments','mapping_evidence_reviews'] LOOP
    EXECUTE format('CREATE POLICY %I ON public.%I FOR SELECT TO authenticated USING (public.can_access_mapping_evidence(evidence_id, false))', tbl || '_org_select', tbl);
    EXECUTE format('CREATE POLICY %I ON public.%I FOR INSERT TO authenticated WITH CHECK (public.can_access_mapping_evidence(evidence_id, true))', tbl || '_org_admin_insert', tbl);
    EXECUTE format('CREATE POLICY %I ON public.%I FOR UPDATE TO authenticated USING (public.can_access_mapping_evidence(evidence_id, true)) WITH CHECK (public.can_access_mapping_evidence(evidence_id, true))', tbl || '_org_admin_update', tbl);
    EXECUTE format('CREATE POLICY %I ON public.%I FOR DELETE TO authenticated USING (public.can_access_mapping_evidence(evidence_id, true))', tbl || '_org_admin_delete', tbl);
  END LOOP;
END $$;

-- Mapping audit is append-only for clients.
CREATE POLICY mapping_evidence_audit_org_select ON public.mapping_evidence_audit FOR SELECT TO authenticated
  USING ((evidence_id IS NOT NULL AND public.can_access_mapping_evidence(evidence_id, false))
      OR (evidence_id IS NULL AND qualification_id IS NOT NULL AND public.can_access_qualification(qualification_id, false)));
CREATE POLICY mapping_evidence_audit_org_admin_insert ON public.mapping_evidence_audit FOR INSERT TO authenticated
  WITH CHECK ((evidence_id IS NOT NULL AND public.can_access_mapping_evidence(evidence_id, true))
      OR (evidence_id IS NULL AND qualification_id IS NOT NULL AND public.can_access_qualification(qualification_id, true)));

-- Mapping logs are written by server functions; clients read their own RTO's.
CREATE POLICY qualification_mapping_logs_org_select ON public.qualification_mapping_logs FOR SELECT TO authenticated
  USING (qualification_id IS NOT NULL AND public.can_access_qualification(qualification_id, false));

-- ── 3. Organisation settings ───────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.organisation_setting_category(p_key text)
RETURNS text LANGUAGE sql IMMUTABLE SET search_path = pg_catalog AS $$
  SELECT CASE
    WHEN p_key IN ('org_branding','email_settings','notification_settings','reminder_period_days',
                   'overdue_threshold_days','org_rto_number','org_state') THEN 'administration'
    WHEN p_key IN ('axcelerate_contact_watch_list','axcelerate_auto_sync') THEN 'technical'
  END
$$;
REVOKE ALL ON FUNCTION public.organisation_setting_category(text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.organisation_setting_category(text) TO authenticated;

CREATE TABLE IF NOT EXISTS public.organisation_settings (
  organisation_id uuid NOT NULL REFERENCES public.organisations(id) ON DELETE CASCADE,
  key text NOT NULL CHECK (public.organisation_setting_category(key) IS NOT NULL),
  value jsonb NOT NULL DEFAULT '{}'::jsonb,
  updated_by uuid,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (organisation_id, key)
);
ALTER TABLE public.organisation_settings ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.organisation_settings FROM PUBLIC, anon, authenticated;
GRANT SELECT ON TABLE public.organisation_settings TO authenticated;
DROP POLICY IF EXISTS organisation_settings_scoped_select ON public.organisation_settings;
CREATE POLICY organisation_settings_scoped_select ON public.organisation_settings FOR SELECT TO authenticated
  USING (organisation_id = public.current_organisation_id() AND (
    public.has_workspace_access('administration')
    OR (public.organisation_setting_category(key) = 'technical' AND public.has_workspace_access('technical'))));

CREATE OR REPLACE FUNCTION public.set_organisation_setting(p_key text, p_value jsonb)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE org_id uuid; category text;
BEGIN
  category := public.organisation_setting_category(p_key);
  IF category IS NULL THEN RAISE EXCEPTION 'unknown organisation setting %', p_key; END IF;
  IF NOT (public.has_workspace_access('administration')
          OR (category = 'technical' AND public.has_workspace_access('technical'))) THEN
    RAISE EXCEPTION 'workspace permission required for setting %', p_key;
  END IF;
  org_id := public.current_organisation_id();
  INSERT INTO public.organisation_settings (organisation_id, key, value, updated_by, updated_at)
  VALUES (org_id, p_key, coalesce(p_value, 'null'::jsonb), auth.uid(), now())
  ON CONFLICT (organisation_id, key) DO UPDATE
    SET value = EXCLUDED.value, updated_by = EXCLUDED.updated_by, updated_at = now();
END $$;
REVOKE ALL ON FUNCTION public.set_organisation_setting(text, jsonb) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.set_organisation_setting(text, jsonb) TO authenticated;

-- Copy existing RTO configuration from the platform table to the legacy RTO.
DO $$
DECLARE n bigint; owner_id uuid;
BEGIN
  SELECT count(*) INTO n FROM public.settings WHERE public.organisation_setting_category(key) IS NOT NULL;
  owner_id := pg_temp.issue040_legacy_owner('RTO configuration setting', n, true);
  IF owner_id IS NOT NULL THEN
    INSERT INTO public.organisation_settings (organisation_id, key, value, updated_at)
    SELECT owner_id, s.key, s.value, coalesce(s.updated_at, now())
    FROM public.settings s WHERE public.organisation_setting_category(s.key) IS NOT NULL
    ON CONFLICT (organisation_id, key) DO NOTHING;
    INSERT INTO public.settings (key, value, updated_at)
    VALUES ('legacy_server_settings_organisation_id', to_jsonb(owner_id::text), now())
    ON CONFLICT (key) DO NOTHING;
  END IF;
END $$;

-- Temporary bridge: keep server functions' copy current for the legacy RTO.
CREATE OR REPLACE FUNCTION public.mirror_legacy_organisation_setting()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE legacy_org uuid;
BEGIN
  SELECT nullif(value #>> '{}', '')::uuid INTO legacy_org
  FROM public.settings WHERE key = 'legacy_server_settings_organisation_id';
  IF legacy_org IS NULL THEN RETURN NULL; END IF;
  IF TG_OP = 'DELETE' THEN
    IF OLD.organisation_id = legacy_org THEN DELETE FROM public.settings WHERE key = OLD.key; END IF;
  ELSIF NEW.organisation_id = legacy_org THEN
    INSERT INTO public.settings (key, value, updated_at) VALUES (NEW.key, NEW.value, now())
    ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now();
  END IF;
  RETURN NULL;
END $$;
REVOKE ALL ON FUNCTION public.mirror_legacy_organisation_setting() FROM PUBLIC, anon, authenticated;
DROP TRIGGER IF EXISTS issue040_mirror_legacy_setting ON public.organisation_settings;
CREATE TRIGGER issue040_mirror_legacy_setting AFTER INSERT OR UPDATE OR DELETE ON public.organisation_settings
  FOR EACH ROW EXECUTE FUNCTION public.mirror_legacy_organisation_setting();

-- ── 4. Platform settings: server-only except `environment` ────────────────
ALTER TABLE public.settings ENABLE ROW LEVEL SECURITY;
REVOKE INSERT, UPDATE, DELETE, TRUNCATE ON TABLE public.settings FROM anon, authenticated;
CREATE POLICY settings_public_environment_select ON public.settings FOR SELECT TO authenticated
  USING (key = 'environment');

-- ── 5. Billing ─────────────────────────────────────────────────────────────
ALTER TABLE public.subscriptions ADD COLUMN IF NOT EXISTS organisation_id uuid REFERENCES public.organisations(id);
DO $$
DECLARE n bigint; owner_id uuid;
BEGIN
  SELECT count(*) INTO n FROM public.subscriptions WHERE organisation_id IS NULL;
  owner_id := pg_temp.issue040_legacy_owner('subscription', n, true);
  UPDATE public.subscriptions SET organisation_id = owner_id WHERE organisation_id IS NULL;
END $$;
ALTER TABLE public.subscriptions ALTER COLUMN organisation_id SET NOT NULL;
CREATE INDEX IF NOT EXISTS idx_subscriptions_org ON public.subscriptions(organisation_id, created_at DESC);
DROP TRIGGER IF EXISTS issue040_subscription_org ON public.subscriptions;
CREATE TRIGGER issue040_subscription_org BEFORE INSERT OR UPDATE ON public.subscriptions
  FOR EACH ROW EXECUTE FUNCTION public.set_owned_organisation();

CREATE POLICY subscriptions_org_admin_select ON public.subscriptions FOR SELECT TO authenticated
  USING (organisation_id = public.current_organisation_id() AND public.has_workspace_access('administration'));
CREATE POLICY subscriptions_org_admin_insert ON public.subscriptions FOR INSERT TO authenticated
  WITH CHECK (organisation_id = public.current_organisation_id() AND public.has_workspace_access('administration'));
CREATE POLICY subscriptions_org_admin_update ON public.subscriptions FOR UPDATE TO authenticated
  USING (organisation_id = public.current_organisation_id() AND public.has_workspace_access('administration'))
  WITH CHECK (organisation_id = public.current_organisation_id() AND public.has_workspace_access('administration'));

CREATE OR REPLACE FUNCTION public.can_read_subscription(target_subscription uuid)
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public AS $$
  SELECT EXISTS (
    SELECT 1 FROM public.subscriptions s
    WHERE s.id = target_subscription AND s.organisation_id = public.current_organisation_id()
  ) AND public.has_workspace_access('administration')
$$;
REVOKE ALL ON FUNCTION public.can_read_subscription(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.can_read_subscription(uuid) TO authenticated;

CREATE POLICY billing_usage_org_admin_select ON public.billing_usage FOR SELECT TO authenticated
  USING (public.can_read_subscription(subscription_id));
CREATE POLICY billable_learners_org_admin_select ON public.billable_learners FOR SELECT TO authenticated
  USING (EXISTS (SELECT 1 FROM public.billing_usage u
                 WHERE u.id = billing_period_id AND public.can_read_subscription(u.subscription_id)));

ALTER TABLE public.billing_events ADD COLUMN IF NOT EXISTS organisation_id uuid REFERENCES public.organisations(id);
DO $$
DECLARE n bigint; owner_id uuid;
BEGIN
  SELECT count(*) INTO n FROM public.billing_events WHERE organisation_id IS NULL;
  -- Not required: unattributable historical events stay platform-only (invisible to RTOs).
  owner_id := pg_temp.issue040_legacy_owner('billing event', n, false);
  IF owner_id IS NOT NULL THEN
    UPDATE public.billing_events SET organisation_id = owner_id WHERE organisation_id IS NULL;
  END IF;
END $$;
CREATE INDEX IF NOT EXISTS idx_billing_events_org ON public.billing_events(organisation_id, created_at DESC);
CREATE POLICY billing_events_org_admin_select ON public.billing_events FOR SELECT TO authenticated
  USING (organisation_id = public.current_organisation_id() AND public.has_workspace_access('administration'));

-- Bill the candidate's own organisation (previously: newest subscription on the platform).
CREATE OR REPLACE FUNCTION public.record_billable_completion(
  p_invitation_id uuid,
  p_learner_email text,
  p_learner_name text,
  p_assessment_type text
) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, extensions AS $$
DECLARE
  v_org_id uuid;
  v_sub_id uuid;
  v_period_id uuid;
  v_learner_exists boolean;
BEGIN
  SELECT ai.organisation_id INTO v_org_id FROM assessment_invitations ai WHERE ai.id = p_invitation_id;
  IF v_org_id IS NULL THEN RETURN; END IF;

  SELECT id INTO v_sub_id
  FROM subscriptions
  WHERE organisation_id = v_org_id AND status IN ('trialing', 'active', 'past_due')
  ORDER BY created_at DESC
  LIMIT 1;
  IF v_sub_id IS NULL THEN RETURN; END IF;

  v_period_id := get_or_create_billing_period(v_sub_id);
  IF v_period_id IS NULL THEN RETURN; END IF;

  SELECT EXISTS(
    SELECT 1 FROM billable_learners
    WHERE billing_period_id = v_period_id AND learner_email = lower(p_learner_email)
  ) INTO v_learner_exists;

  IF v_learner_exists THEN
    UPDATE billable_learners SET
      completed_lln     = completed_lln     OR (p_assessment_type = 'lln'),
      completed_digital = completed_digital OR (p_assessment_type = 'digital')
    WHERE billing_period_id = v_period_id AND learner_email = lower(p_learner_email);
  ELSE
    INSERT INTO billable_learners
      (billing_period_id, invitation_id, learner_email, learner_name, completed_lln, completed_digital)
    VALUES (
      v_period_id, p_invitation_id, lower(p_learner_email), p_learner_name,
      p_assessment_type = 'lln', p_assessment_type = 'digital'
    );
    UPDATE billing_usage SET completed_learners = completed_learners + 1, updated_at = now() WHERE id = v_period_id;
  END IF;
END;
$$;
REVOKE EXECUTE ON FUNCTION public.record_billable_completion(uuid, text, text, text) FROM PUBLIC, anon, authenticated;

-- ── 6. Technical logs and queues: owning organisation for server writes ────
-- The base Issue #40 trigger took the organisation only from the signed-in
-- user. Server jobs (completion processing, email queue, aXcelerate sync) have
-- no signed-in user, so their inserts into these tables were refused. A row
-- for an invitation now belongs to that invitation's organisation; a server
-- row without an invitation (aXcelerate inbound activity) belongs to the RTO
-- that owns the platform aXcelerate integration, or the only RTO.
CREATE OR REPLACE FUNCTION public.set_diagnostic_organisation()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE
  invitation_ref text := to_jsonb(NEW) ->> 'invitation_id';
  invitation_org uuid;
  caller_org uuid;
BEGIN
  IF invitation_ref IS NOT NULL THEN
    SELECT i.organisation_id INTO invitation_org
    FROM public.assessment_invitations i WHERE i.id = invitation_ref::uuid;
  END IF;
  IF auth.uid() IS NOT NULL THEN
    caller_org := public.current_organisation_id();
    IF caller_org IS NULL THEN RAISE EXCEPTION 'active organisation membership required'; END IF;
  END IF;

  NEW.organisation_id := coalesce(NEW.organisation_id, invitation_org, caller_org);
  IF NEW.organisation_id IS NULL AND auth.uid() IS NULL THEN
    SELECT nullif(s.value #>> '{}', '')::uuid INTO NEW.organisation_id
    FROM public.settings s WHERE s.key = 'legacy_server_settings_organisation_id';
    IF NEW.organisation_id IS NULL AND (SELECT count(*) FROM public.organisations) = 1 THEN
      NEW.organisation_id := (SELECT id FROM public.organisations);
    END IF;
  END IF;

  IF NEW.organisation_id IS NULL THEN
    RAISE EXCEPTION 'diagnostic organisation cannot be resolved safely';
  END IF;
  IF invitation_org IS NOT NULL AND NEW.organisation_id <> invitation_org THEN
    RAISE EXCEPTION 'diagnostic organisation does not match the invitation';
  END IF;
  IF caller_org IS NOT NULL AND NEW.organisation_id <> caller_org THEN
    RAISE EXCEPTION 'cross-organisation diagnostic write denied';
  END IF;
  RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION public.set_diagnostic_organisation() FROM PUBLIC, anon, authenticated;

-- ── 7. Candidate rows: allow a trusted server to name the organisation ──────
-- The base Issue #40 trigger refused every server-created candidate,
-- enrolment or invitation once more than one RTO existed, even when the
-- server supplied the owning organisation (aXcelerate inbound sync). Rules
-- now: a signed-in user always writes their own RTO; a row linked to a
-- candidate belongs to that candidate's RTO; a trusted server context (no
-- end-user JWT) may supply the organisation; otherwise the only RTO; else refuse.
CREATE OR REPLACE FUNCTION public.set_candidate_organisation()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE resolved uuid; candidate uuid;
BEGIN
  IF auth.uid() IS NOT NULL THEN
    resolved := public.current_organisation_id();
    IF resolved IS NULL THEN RAISE EXCEPTION 'active organisation membership required'; END IF;
  END IF;
  -- Nested on purpose: students rows have no student_id field, and PL/pgSQL
  -- evaluates every field in a combined condition (the base trigger's combined
  -- form raised "record new has no field student_id" on every students insert).
  IF TG_TABLE_NAME IN ('enrolments','assessment_invitations') THEN
    IF NEW.student_id IS NOT NULL THEN
      SELECT s.organisation_id INTO candidate FROM public.students s WHERE s.id = NEW.student_id;
    END IF;
  END IF;
  IF candidate IS NOT NULL THEN
    IF resolved IS NOT NULL AND resolved <> candidate THEN RAISE EXCEPTION 'cross-organisation candidate write denied'; END IF;
    resolved := candidate;
  END IF;
  IF resolved IS NULL AND auth.uid() IS NULL AND NEW.organisation_id IS NOT NULL THEN
    IF NOT EXISTS (SELECT 1 FROM public.organisations o WHERE o.id = NEW.organisation_id) THEN
      RAISE EXCEPTION 'organisation ownership cannot be resolved safely';
    END IF;
    resolved := NEW.organisation_id;
  END IF;
  IF resolved IS NULL AND (SELECT count(*) FROM public.organisations) = 1 THEN
    SELECT id INTO resolved FROM public.organisations;
  END IF;
  IF resolved IS NULL THEN RAISE EXCEPTION 'organisation ownership cannot be resolved safely'; END IF;
  IF NEW.organisation_id IS NOT NULL AND NEW.organisation_id <> resolved THEN
    RAISE EXCEPTION 'client-supplied organisation ownership does not match trusted context';
  END IF;
  NEW.organisation_id := resolved;
  RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION public.set_candidate_organisation() FROM PUBLIC, anon, authenticated;

-- ── 8. Remaining candidate records: remove legacy role-wide staff access ────
-- Policies are permissive (OR-combined), so legacy "any admin/trainer" staff
-- policies left on these tables let every RTO read or change every other RTO's
-- enrolments, candidate answers, audit trail, lifecycle history, notifications,
-- portfolio uploads and Technical queues/logs. Drop only staff policies that
-- test the legacy profile role; candidate token policies (anon / x-quiz-token)
-- and the Issue #40 workspace policies are kept.
DO $$
DECLARE r record;
BEGIN
  FOR r IN
    SELECT schemaname, tablename, policyname FROM pg_policies
    WHERE schemaname = 'public'
      AND tablename IN ('enrolments','audit_trail','student_lifecycle_events','student_responses',
                        'notifications','axcelerate_portfolio_uploads','axcelerate_sync_log',
                        'axcelerate_inbound_sync_log','axcelerate_writeback_queue','email_queue')
      AND 'authenticated' = ANY(roles)
      AND (coalesce(qual, '') || ' ' || coalesce(with_check, '')) ~ '(get_my_role\(\)|\mp\.role\M|profiles\.role\M|\mrole\s*=\s*ANY)'
  LOOP
    EXECUTE format('DROP POLICY %I ON %I.%I', r.policyname, r.schemaname, r.tablename);
  END LOOP;
END $$;

-- Enrolments: Administration of the owning RTO; Candidate Support only for
-- candidates with an accessible support case (same rule as students).
CREATE POLICY enrolments_workspace_select ON public.enrolments FOR SELECT TO authenticated USING (
  organisation_id = public.current_organisation_id() AND (
    public.has_workspace_access('administration') OR
    (public.has_workspace_access('candidate_support') AND EXISTS (
      SELECT 1 FROM public.support_cases sc WHERE sc.student_id = enrolments.student_id
      AND public.can_access_support_case(sc.organisation_id, sc.assigned_user_id)))));
CREATE POLICY enrolments_admin_insert ON public.enrolments FOR INSERT TO authenticated
  WITH CHECK (organisation_id = public.current_organisation_id() AND public.has_workspace_access('administration'));
CREATE POLICY enrolments_admin_update ON public.enrolments FOR UPDATE TO authenticated
  USING (organisation_id = public.current_organisation_id() AND public.has_workspace_access('administration'))
  WITH CHECK (organisation_id = public.current_organisation_id() AND public.has_workspace_access('administration'));
CREATE POLICY enrolments_admin_delete ON public.enrolments FOR DELETE TO authenticated
  USING (organisation_id = public.current_organisation_id() AND public.has_workspace_access('administration'));

-- Invitation-linked records follow the invitation's visibility
-- (can_manage_support_invitation: Administration of the RTO, or Candidate
-- Support for an accessible support case).
CREATE POLICY student_responses_workspace_select ON public.student_responses FOR SELECT TO authenticated
  USING (public.can_manage_support_invitation(invitation_id));
CREATE POLICY notifications_workspace_select ON public.notifications FOR SELECT TO authenticated
  USING (invitation_id IS NOT NULL AND public.can_manage_support_invitation(invitation_id));
CREATE POLICY notifications_workspace_insert ON public.notifications FOR INSERT TO authenticated
  WITH CHECK (invitation_id IS NOT NULL AND public.can_manage_support_invitation(invitation_id));
CREATE POLICY audit_trail_workspace_select ON public.audit_trail FOR SELECT TO authenticated
  USING (invitation_id IS NOT NULL AND public.can_manage_support_invitation(invitation_id));
CREATE POLICY audit_trail_staff_insert ON public.audit_trail FOR INSERT TO authenticated
  WITH CHECK (public.is_active_organisation_staff()
              AND (invitation_id IS NULL OR public.can_manage_support_invitation(invitation_id)));

CREATE OR REPLACE FUNCTION public.can_access_lifecycle_event(target_student uuid, target_invitation uuid, for_write boolean)
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public AS $$
  SELECT CASE
    WHEN target_invitation IS NOT NULL AND NOT for_write THEN public.can_manage_support_invitation(target_invitation)
    ELSE EXISTS (
      SELECT 1 FROM public.students s
      WHERE s.id = target_student AND s.organisation_id = public.current_organisation_id()
    ) AND public.has_workspace_access('administration')
  END
$$;
REVOKE ALL ON FUNCTION public.can_access_lifecycle_event(uuid, uuid, boolean) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.can_access_lifecycle_event(uuid, uuid, boolean) TO authenticated;
CREATE POLICY lifecycle_workspace_select ON public.student_lifecycle_events FOR SELECT TO authenticated
  USING (public.can_access_lifecycle_event(student_id, invitation_id, false));
CREATE POLICY lifecycle_admin_insert ON public.student_lifecycle_events FOR INSERT TO authenticated
  WITH CHECK (public.can_access_lifecycle_event(student_id, invitation_id, true));
CREATE POLICY lifecycle_admin_delete ON public.student_lifecycle_events FOR DELETE TO authenticated
  USING (public.can_access_lifecycle_event(student_id, invitation_id, true));

-- Portfolio uploads are integration records: Technical or Administration of
-- the owning RTO, through the invitation.
CREATE OR REPLACE FUNCTION public.can_access_integration_invitation(target_invitation uuid)
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public AS $$
  SELECT EXISTS (
    SELECT 1 FROM public.assessment_invitations i
    WHERE i.id = target_invitation AND i.organisation_id = public.current_organisation_id()
  ) AND (public.has_workspace_access('technical') OR public.has_workspace_access('administration'))
$$;
REVOKE ALL ON FUNCTION public.can_access_integration_invitation(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.can_access_integration_invitation(uuid) TO authenticated;
CREATE POLICY portfolio_uploads_workspace_select ON public.axcelerate_portfolio_uploads FOR SELECT TO authenticated
  USING (public.can_access_integration_invitation(invitation_id));
CREATE POLICY portfolio_uploads_workspace_insert ON public.axcelerate_portfolio_uploads FOR INSERT TO authenticated
  WITH CHECK (public.can_access_integration_invitation(invitation_id));
CREATE POLICY portfolio_uploads_workspace_update ON public.axcelerate_portfolio_uploads FOR UPDATE TO authenticated
  USING (public.can_access_integration_invitation(invitation_id))
  WITH CHECK (public.can_access_integration_invitation(invitation_id));

-- Technical queues and logs: staff writes only within their own RTO. Reads
-- keep the Issue #40 Technical-only policies.
DO $$
DECLARE tbl text;
BEGIN
  FOREACH tbl IN ARRAY ARRAY['axcelerate_sync_log','axcelerate_inbound_sync_log','axcelerate_writeback_queue','email_queue'] LOOP
    EXECUTE format('CREATE POLICY %I ON public.%I FOR INSERT TO authenticated WITH CHECK (organisation_id = public.current_organisation_id() AND (public.has_workspace_access(''technical'') OR public.has_workspace_access(''administration'')))', tbl || '_org_staff_insert', tbl);
    EXECUTE format('CREATE POLICY %I ON public.%I FOR UPDATE TO authenticated USING (organisation_id = public.current_organisation_id() AND (public.has_workspace_access(''technical'') OR public.has_workspace_access(''administration''))) WITH CHECK (organisation_id = public.current_organisation_id())', tbl || '_org_staff_update', tbl);
  END LOOP;
END $$;
CREATE POLICY axcelerate_inbound_sync_log_org_staff_delete ON public.axcelerate_inbound_sync_log FOR DELETE TO authenticated
  USING (organisation_id = public.current_organisation_id()
         AND (public.has_workspace_access('technical') OR public.has_workspace_access('administration')));

-- Existing Administration candidate actions upsert reminders and write-back
-- jobs and clear inbound-log entries. PostgreSQL requires the caller to be able
-- to read a row it upserts (ON CONFLICT) or deletes, so Administration may read
-- its own RTO's rows. Navigation is unchanged: Email Activity and the aXcelerate
-- Log stay in the Technical Workspace.
DO $$
DECLARE tbl text;
BEGIN
  FOREACH tbl IN ARRAY ARRAY['axcelerate_inbound_sync_log','axcelerate_writeback_queue','email_queue'] LOOP
    EXECUTE format('CREATE POLICY %I ON public.%I FOR SELECT TO authenticated USING (organisation_id = public.current_organisation_id() AND public.has_workspace_access(''administration''))', tbl || '_org_admin_select', tbl);
  END LOOP;
END $$;

COMMIT;
