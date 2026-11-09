-- LLND Mate Free tier (revised): invitations-sent allowance, Test Test exemption,
-- soft deletion with refund, administrator restoration, platform reporting.
--
-- Supersedes the unapplied completion-based draft 20261109120000 (never applied to
-- any database outside local/CI tests; removed from the branch).
--
-- Approved rules (Product Owner, 10 Nov 2026):
--   * LLND Mate Free: 10 assessment assignments SENT per RTO per calendar month.
--     One assessment_invitations row = one assignment (LLN + Digital together = one).
--     Counted when the invitation row is created (the learner link is issued).
--     Resends do not create rows and do not count. Failed inserts roll back and do
--     not count. Once 10 active chargeable invitations exist for the month, further
--     chargeable invitations are refused. Invited learners can always start,
--     resume and finish.
--   * Test Test: an invitation whose learner name is exactly "Test Test" (after
--     normalisation) is a permanent, server-classified test. It never consumes the
--     Free allowance, never counts towards paid completions, its name and learner
--     link cannot be changed, and its flag cannot be changed. Tests are excluded
--     from support-case automation, integration write-back and legacy billing.
--   * Soft deletion by RTO administrators (typed "YES"), hidden from RTO and
--     learner access, data preserved, refund of the Free spot only when the
--     invitation was chargeable and sent in the current month, once.
--   * Restoration only by a platform operator (Issue #45 is_platform_operator),
--     idempotent, no new allowance use, no resend or side effects.
--   * Paid tiers stay completion-based (not active): completions are recorded per
--     assignment, excluding tests.
--
-- Month boundary: calendar month in AEST (fixed UTC+10). Still awaiting Product
-- Owner confirmation; one function to change.
--
-- Depends on Issue #40. Platform-operator functions require Issue #45
-- (public.is_platform_operator); without it they refuse every caller.
-- Rollback: docs/billing/free-tier-metering.md.

-- ── 1. Month boundary ────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.llnd_usage_period_month(ts timestamptz)
RETURNS date LANGUAGE sql IMMUTABLE PARALLEL SAFE SET search_path = pg_catalog AS $$
  SELECT date_trunc('month', (ts AT TIME ZONE 'UTC') + interval '10 hours')::date
$$;
CREATE OR REPLACE FUNCTION public.llnd_usage_period_starts_at(period_month date)
RETURNS timestamptz LANGUAGE sql IMMUTABLE PARALLEL SAFE SET search_path = pg_catalog AS $$
  SELECT (period_month::timestamp - interval '10 hours') AT TIME ZONE 'UTC'
$$;
REVOKE ALL ON FUNCTION public.llnd_usage_period_month(timestamptz) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.llnd_usage_period_starts_at(date) FROM PUBLIC;

-- ── 2. Reserved test identity ────────────────────────────────────────────
-- Exactly the two words "test" "test": Unicode NFKC, case-insensitive, invisible
-- (zero-width) characters removed, any run of whitespace (including non-breaking)
-- treated as one space. "Test Testerson", "Testa Test", "Test Test Smith",
-- "TestTest" and "Test-Test" are not tests.
CREATE OR REPLACE FUNCTION public.llnd_is_reserved_test_name(p_name text)
RETURNS boolean LANGUAGE sql IMMUTABLE PARALLEL SAFE SET search_path = pg_catalog AS $$
  SELECT coalesce(
    btrim(regexp_replace(
      regexp_replace(lower(normalize(coalesce(p_name, ''), NFKC)), '[\u200b-\u200d\u2060\ufeff\u00ad]', '', 'g'),
      '[[:space:]\u00a0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000]+', ' ', 'g')) = 'test test',
    false)
$$;
REVOKE ALL ON FUNCTION public.llnd_is_reserved_test_name(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.llnd_is_reserved_test_name(text) TO authenticated;

-- ── 3. Assignment columns ────────────────────────────────────────────────
ALTER TABLE public.assessment_invitations
  ADD COLUMN IF NOT EXISTS is_test boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS deleted_at timestamptz,
  ADD COLUMN IF NOT EXISTS deleted_by uuid,
  ADD COLUMN IF NOT EXISTS deleted_prior_status text,
  ADD COLUMN IF NOT EXISTS restored_at timestamptz,
  ADD COLUMN IF NOT EXISTS restored_by uuid;
COMMENT ON COLUMN public.assessment_invitations.is_test IS
  'Server-set at creation from the reserved name "Test Test". Immutable. Excluded from usage, billing, reporting, support automation and integrations.';
CREATE INDEX IF NOT EXISTS assessment_invitations_deleted_at ON public.assessment_invitations (organisation_id, deleted_at) WHERE deleted_at IS NOT NULL;

-- Existing rows: classify by name once (the flag is permanent from here on).
UPDATE public.assessment_invitations SET is_test = true
WHERE is_test = false AND public.llnd_is_reserved_test_name(candidate_name);

-- ── 4. Entitlements, usage ledgers, counters, audit ──────────────────────
CREATE TABLE IF NOT EXISTS public.organisation_plan_entitlements (
  organisation_id uuid PRIMARY KEY REFERENCES public.organisations(id) ON DELETE CASCADE,
  plan_code text NOT NULL CHECK (plan_code = 'llnd_mate_free'),
  monthly_invitation_allowance integer NOT NULL CHECK (monthly_invitation_allowance > 0),
  source text NOT NULL CHECK (source IN ('signup', 'migration_backfill')),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

-- One row per issued invitation (genuine or test), written in the same
-- transaction as the invitation. invitation_id has no foreign key so the record
-- survives anything that happens to the assignment.
CREATE TABLE IF NOT EXISTS public.organisation_invitation_ledger (
  invitation_id uuid PRIMARY KEY,
  organisation_id uuid NOT NULL REFERENCES public.organisations(id) ON DELETE CASCADE,
  period_month date NOT NULL CHECK (period_month = date_trunc('month', period_month)::date),
  is_test boolean NOT NULL,
  chargeable boolean NOT NULL,
  issued_at timestamptz NOT NULL DEFAULT now(),
  refunded_at timestamptz,
  CONSTRAINT invitation_ledger_test_not_chargeable CHECK (NOT (is_test AND chargeable)),
  CONSTRAINT invitation_ledger_refund_only_chargeable CHECK (refunded_at IS NULL OR chargeable)
);
CREATE INDEX IF NOT EXISTS organisation_invitation_ledger_org_period ON public.organisation_invitation_ledger (organisation_id, period_month);

-- Completed assignments (paid tiers are completion-based; not billed yet). Tests are never recorded.
CREATE TABLE IF NOT EXISTS public.organisation_usage_completions (
  invitation_id uuid PRIMARY KEY,
  organisation_id uuid NOT NULL REFERENCES public.organisations(id) ON DELETE CASCADE,
  period_month date NOT NULL CHECK (period_month = date_trunc('month', period_month)::date),
  first_completed_module text NOT NULL CHECK (first_completed_module IN ('lln', 'digital', 'assignment')),
  counted_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS organisation_usage_completions_org_period ON public.organisation_usage_completions (organisation_id, period_month);

-- Per RTO per month. Updated in the same statement as each invitation insert (so
-- multi-row and concurrent inserts see each other) and by refunds. The row is the
-- lock that serialises allowance decisions for one RTO and month.
CREATE TABLE IF NOT EXISTS public.organisation_usage_periods (
  organisation_id uuid NOT NULL REFERENCES public.organisations(id) ON DELETE CASCADE,
  period_month date NOT NULL CHECK (period_month = date_trunc('month', period_month)::date),
  chargeable_sent integer NOT NULL DEFAULT 0 CHECK (chargeable_sent >= 0),
  refunded integer NOT NULL DEFAULT 0 CHECK (refunded >= 0 AND refunded <= chargeable_sent),
  test_sent integer NOT NULL DEFAULT 0 CHECK (test_sent >= 0),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (organisation_id, period_month)
);

-- Append-only record of deletions and restorations.
CREATE TABLE IF NOT EXISTS public.assessment_assignment_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  invitation_id uuid NOT NULL,
  organisation_id uuid NOT NULL REFERENCES public.organisations(id) ON DELETE CASCADE,
  action text NOT NULL CHECK (action IN ('deleted', 'restored')),
  actor_user_id uuid,
  occurred_at timestamptz NOT NULL DEFAULT now(),
  prior_status text,
  allowance_refunded boolean NOT NULL DEFAULT false,
  note text
);
CREATE INDEX IF NOT EXISTS assessment_assignment_events_invitation ON public.assessment_assignment_events (invitation_id);

-- RLS: own-RTO administrators may read entitlements, ledgers, counters and events;
-- nobody may write them except the database's own functions.
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['organisation_plan_entitlements', 'organisation_invitation_ledger', 'organisation_usage_completions',
                           'organisation_usage_periods', 'assessment_assignment_events'] LOOP
    EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('REVOKE ALL ON TABLE public.%I FROM PUBLIC, anon, authenticated', t);
    EXECUTE format('GRANT SELECT ON TABLE public.%I TO authenticated', t);
    EXECUTE format('DROP POLICY IF EXISTS %I ON public.%I', t || '_own_org_admin_select', t);
    EXECUTE format('CREATE POLICY %I ON public.%I FOR SELECT TO authenticated USING (organisation_id = public.current_organisation_id() AND public.has_workspace_access(''administration''))',
                   t || '_own_org_admin_select', t);
  END LOOP;
END $$;

-- ── 5. Free entitlement for every RTO ────────────────────────────────────
CREATE OR REPLACE FUNCTION public.llnd_mate_grant_free_entitlement()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
BEGIN
  INSERT INTO public.organisation_plan_entitlements (organisation_id, plan_code, monthly_invitation_allowance, source)
  VALUES (NEW.id, 'llnd_mate_free', 10, 'signup') ON CONFLICT (organisation_id) DO NOTHING;
  RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION public.llnd_mate_grant_free_entitlement() FROM PUBLIC, anon, authenticated;
DROP TRIGGER IF EXISTS llnd_mate_free_entitlement ON public.organisations;
CREATE TRIGGER llnd_mate_free_entitlement AFTER INSERT ON public.organisations
  FOR EACH ROW EXECUTE FUNCTION public.llnd_mate_grant_free_entitlement();
INSERT INTO public.organisation_plan_entitlements (organisation_id, plan_code, monthly_invitation_allowance, source)
SELECT o.id, 'llnd_mate_free', 10, 'migration_backfill' FROM public.organisations o
ON CONFLICT (organisation_id) DO NOTHING;

-- ── 6. Issuing an invitation: classify, check allowance, count ───────────
-- BEFORE INSERT: runs after issue040_invitation_org (alphabetical order) has set
-- organisation_id. Ignores any client-supplied is_test / deletion values.
CREATE OR REPLACE FUNCTION public.llnd_mate_issue_invitation()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE
  v_period date := public.llnd_usage_period_month(now());
  v_allowance integer;
  v_active integer;
BEGIN
  NEW.is_test := public.llnd_is_reserved_test_name(NEW.candidate_name);
  NEW.deleted_at := NULL; NEW.deleted_by := NULL; NEW.deleted_prior_status := NULL;
  NEW.restored_at := NULL; NEW.restored_by := NULL;

  INSERT INTO public.organisation_usage_periods (organisation_id, period_month)
  VALUES (NEW.organisation_id, v_period) ON CONFLICT DO NOTHING;
  PERFORM 1 FROM public.organisation_usage_periods
  WHERE organisation_id = NEW.organisation_id AND period_month = v_period FOR UPDATE;

  IF NEW.is_test THEN
    UPDATE public.organisation_usage_periods SET test_sent = test_sent + 1, updated_at = now()
    WHERE organisation_id = NEW.organisation_id AND period_month = v_period;
    RETURN NEW;
  END IF;

  SELECT e.monthly_invitation_allowance INTO v_allowance
  FROM public.organisation_plan_entitlements e WHERE e.organisation_id = NEW.organisation_id;
  IF v_allowance IS NULL THEN
    RAISE EXCEPTION 'invitation_plan_unconfirmed' USING ERRCODE = 'P0001',
      HINT = 'This organisation has no confirmed LLND Mate plan.';
  END IF;
  SELECT chargeable_sent - refunded INTO v_active FROM public.organisation_usage_periods
  WHERE organisation_id = NEW.organisation_id AND period_month = v_period;
  IF v_active >= v_allowance THEN
    RAISE EXCEPTION 'invitation_allowance_reached' USING ERRCODE = 'P0001',
      HINT = format('The LLND Mate monthly allowance of %s invitations has been used.', v_allowance);
  END IF;
  UPDATE public.organisation_usage_periods SET chargeable_sent = chargeable_sent + 1, updated_at = now()
  WHERE organisation_id = NEW.organisation_id AND period_month = v_period;
  RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION public.llnd_mate_issue_invitation() FROM PUBLIC, anon, authenticated;
DROP TRIGGER IF EXISTS llnd_mate_issue_invitation ON public.assessment_invitations;
CREATE TRIGGER llnd_mate_issue_invitation BEFORE INSERT ON public.assessment_invitations
  FOR EACH ROW EXECUTE FUNCTION public.llnd_mate_issue_invitation();

CREATE OR REPLACE FUNCTION public.llnd_mate_record_invitation()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
BEGIN
  INSERT INTO public.organisation_invitation_ledger (invitation_id, organisation_id, period_month, is_test, chargeable)
  VALUES (NEW.id, NEW.organisation_id, public.llnd_usage_period_month(now()), NEW.is_test, NOT NEW.is_test);
  RETURN NULL;
END $$;
REVOKE ALL ON FUNCTION public.llnd_mate_record_invitation() FROM PUBLIC, anon, authenticated;
DROP TRIGGER IF EXISTS llnd_mate_record_invitation ON public.assessment_invitations;
CREATE TRIGGER llnd_mate_record_invitation AFTER INSERT ON public.assessment_invitations
  FOR EACH ROW EXECUTE FUNCTION public.llnd_mate_record_invitation();

-- ── 7. Locked fields ─────────────────────────────────────────────────────
-- SECURITY INVOKER on purpose: current_user is the API role (anon/authenticated)
-- for client writes, and the function owner inside the deletion/restoration RPCs.
CREATE OR REPLACE FUNCTION public.llnd_mate_protect_invitation_fields()
RETURNS trigger LANGUAGE plpgsql SET search_path = pg_catalog, public AS $$
BEGIN
  IF NEW.is_test IS DISTINCT FROM OLD.is_test THEN
    RAISE EXCEPTION 'test_classification_locked' USING ERRCODE = '42501';
  END IF;
  IF OLD.is_test AND (NEW.candidate_name IS DISTINCT FROM OLD.candidate_name
                      OR NEW.student_id IS DISTINCT FROM OLD.student_id
                      OR NEW.organisation_id IS DISTINCT FROM OLD.organisation_id) THEN
    RAISE EXCEPTION 'test_identity_locked' USING ERRCODE = '42501';
  END IF;
  IF current_user IN ('anon', 'authenticated') AND (
       NEW.deleted_at IS DISTINCT FROM OLD.deleted_at OR NEW.deleted_by IS DISTINCT FROM OLD.deleted_by
    OR NEW.deleted_prior_status IS DISTINCT FROM OLD.deleted_prior_status
    OR NEW.restored_at IS DISTINCT FROM OLD.restored_at OR NEW.restored_by IS DISTINCT FROM OLD.restored_by) THEN
    RAISE EXCEPTION 'deletion_fields_locked' USING ERRCODE = '42501';
  END IF;
  RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION public.llnd_mate_protect_invitation_fields() FROM PUBLIC;
DROP TRIGGER IF EXISTS llnd_mate_protect_invitation_fields ON public.assessment_invitations;
CREATE TRIGGER llnd_mate_protect_invitation_fields BEFORE UPDATE ON public.assessment_invitations
  FOR EACH ROW EXECUTE FUNCTION public.llnd_mate_protect_invitation_fields();

-- ── 8. Visibility of deleted assignments (restrictive RLS) ───────────────
-- Restrictive policies are ANDed with every existing policy, so deleted
-- assignments and their results disappear for RTO staff and learner links
-- without editing the existing policies. Hard deletion by API users is removed:
-- deletion is only through delete_assessment_assignment().
CREATE OR REPLACE FUNCTION public.llnd_invitation_active(p_invitation_id uuid)
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public AS $$
  SELECT p_invitation_id IS NULL OR NOT EXISTS (
    SELECT 1 FROM public.assessment_invitations i WHERE i.id = p_invitation_id AND i.deleted_at IS NOT NULL)
$$;
REVOKE ALL ON FUNCTION public.llnd_invitation_active(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.llnd_invitation_active(uuid) TO anon, authenticated;

DROP POLICY IF EXISTS llnd_mate_hide_deleted ON public.assessment_invitations;
CREATE POLICY llnd_mate_hide_deleted ON public.assessment_invitations AS RESTRICTIVE
  FOR ALL TO anon, authenticated USING (deleted_at IS NULL) WITH CHECK (deleted_at IS NULL);
DROP POLICY IF EXISTS llnd_mate_no_hard_delete ON public.assessment_invitations;
CREATE POLICY llnd_mate_no_hard_delete ON public.assessment_invitations AS RESTRICTIVE
  FOR DELETE TO anon, authenticated USING (false);

DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['invitation_assessments', 'assessment_responses', 'assessment_declarations',
                           'support_plans', 'intervention_cases', 'support_cases', 'email_queue',
                           'axcelerate_writeback_queue'] LOOP
    IF to_regclass('public.' || t) IS NOT NULL THEN
      EXECUTE format('DROP POLICY IF EXISTS llnd_mate_hide_deleted ON public.%I', t);
      EXECUTE format('CREATE POLICY llnd_mate_hide_deleted ON public.%I AS RESTRICTIVE FOR ALL TO anon, authenticated USING (public.llnd_invitation_active(invitation_id)) WITH CHECK (public.llnd_invitation_active(invitation_id))', t);
    END IF;
  END LOOP;
END $$;

-- ── 9. Side-effect guards for tests and deleted assignments ──────────────
-- Write-back to aXcelerate: never for tests or deleted assignments.
CREATE OR REPLACE FUNCTION public.llnd_mate_guard_writeback()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
BEGIN
  IF EXISTS (SELECT 1 FROM public.assessment_invitations i
             WHERE i.id = NEW.invitation_id AND (i.is_test OR i.deleted_at IS NOT NULL)) THEN
    RETURN NULL;  -- silently skipped: no external action for tests or deleted assignments
  END IF;
  RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION public.llnd_mate_guard_writeback() FROM PUBLIC, anon, authenticated;
DROP TRIGGER IF EXISTS llnd_mate_guard_writeback ON public.axcelerate_writeback_queue;
CREATE TRIGGER llnd_mate_guard_writeback BEFORE INSERT ON public.axcelerate_writeback_queue
  FOR EACH ROW EXECUTE FUNCTION public.llnd_mate_guard_writeback();

-- Emails: tests still receive invitations (the RTO experiences the learner
-- workflow); deleted assignments receive nothing further.
CREATE OR REPLACE FUNCTION public.llnd_mate_guard_email()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
BEGIN
  IF NOT public.llnd_invitation_active(NEW.invitation_id) THEN RETURN NULL; END IF;
  RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION public.llnd_mate_guard_email() FROM PUBLIC, anon, authenticated;
DROP TRIGGER IF EXISTS llnd_mate_guard_email ON public.email_queue;
CREATE TRIGGER llnd_mate_guard_email BEFORE INSERT ON public.email_queue
  FOR EACH ROW EXECUTE FUNCTION public.llnd_mate_guard_email();

-- Support-case automation: never for tests or deleted assignments.
CREATE OR REPLACE FUNCTION public.llnd_mate_guard_support_case()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
BEGIN
  IF EXISTS (SELECT 1 FROM public.assessment_invitations i
             WHERE i.id = NEW.invitation_id AND (i.is_test OR i.deleted_at IS NOT NULL)) THEN
    RETURN NULL;
  END IF;
  RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION public.llnd_mate_guard_support_case() FROM PUBLIC, anon, authenticated;
DROP TRIGGER IF EXISTS llnd_mate_guard_support_case ON public.support_cases;
CREATE TRIGGER llnd_mate_guard_support_case BEFORE INSERT ON public.support_cases
  FOR EACH ROW EXECUTE FUNCTION public.llnd_mate_guard_support_case();

-- Legacy completion billing (subscriptions / billable_learners): exclude tests
-- and deleted assignments. Same body as before otherwise.
CREATE OR REPLACE FUNCTION public.trigger_billing_on_assessment_complete()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, extensions AS $$
DECLARE
  v_email text;
  v_name  text;
  v_type  text;
  v_skip  boolean;
BEGIN
  IF NEW.individual_status = 'completed' AND (OLD.individual_status IS DISTINCT FROM 'completed') THEN
    SELECT ai.candidate_email, ai.candidate_name, (ai.is_test OR ai.deleted_at IS NOT NULL)
    INTO v_email, v_name, v_skip
    FROM assessment_invitations ai WHERE ai.id = NEW.invitation_id;
    IF coalesce(v_skip, false) THEN RETURN NEW; END IF;
    SELECT a.type INTO v_type FROM assessments a WHERE a.id = NEW.assessment_id;
    IF v_email IS NOT NULL AND v_type IS NOT NULL THEN
      PERFORM record_billable_completion(NEW.invitation_id, v_email, v_name, v_type);
    END IF;
  END IF;
  RETURN NEW;
END;
$$;
REVOKE EXECUTE ON FUNCTION public.trigger_billing_on_assessment_complete() FROM PUBLIC, anon, authenticated;

-- ── 10. Completions (paid-tier usage; tests excluded) ────────────────────
CREATE OR REPLACE FUNCTION public.llnd_mate_record_completion(p_invitation_id uuid, p_module text)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE v_org uuid; v_test boolean;
BEGIN
  SELECT organisation_id, is_test INTO v_org, v_test FROM public.assessment_invitations WHERE id = p_invitation_id;
  IF v_org IS NULL OR v_test THEN RETURN; END IF;
  INSERT INTO public.organisation_usage_completions (invitation_id, organisation_id, period_month, first_completed_module)
  VALUES (p_invitation_id, v_org, public.llnd_usage_period_month(now()), p_module)
  ON CONFLICT (invitation_id) DO NOTHING;
END $$;
REVOKE ALL ON FUNCTION public.llnd_mate_record_completion(uuid, text) FROM PUBLIC, anon, authenticated;

CREATE OR REPLACE FUNCTION public.llnd_mate_count_invitation_completion()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
BEGIN
  IF NEW.lln_status = 'completed' AND (TG_OP = 'INSERT' OR OLD.lln_status IS DISTINCT FROM 'completed') THEN
    PERFORM public.llnd_mate_record_completion(NEW.id, 'lln');
  ELSIF NEW.digital_status = 'completed' AND (TG_OP = 'INSERT' OR OLD.digital_status IS DISTINCT FROM 'completed') THEN
    PERFORM public.llnd_mate_record_completion(NEW.id, 'digital');
  ELSIF NEW.status = 'completed' AND (TG_OP = 'INSERT' OR OLD.status IS DISTINCT FROM 'completed') THEN
    PERFORM public.llnd_mate_record_completion(NEW.id, 'assignment');
  END IF;
  RETURN NULL;
END $$;
REVOKE ALL ON FUNCTION public.llnd_mate_count_invitation_completion() FROM PUBLIC, anon, authenticated;
DROP TRIGGER IF EXISTS llnd_mate_count_completion_update ON public.assessment_invitations;
CREATE TRIGGER llnd_mate_count_completion_update
  AFTER UPDATE OF lln_status, digital_status, status ON public.assessment_invitations FOR EACH ROW
  WHEN ((NEW.lln_status = 'completed' AND OLD.lln_status IS DISTINCT FROM 'completed')
     OR (NEW.digital_status = 'completed' AND OLD.digital_status IS DISTINCT FROM 'completed')
     OR (NEW.status = 'completed' AND OLD.status IS DISTINCT FROM 'completed'))
  EXECUTE FUNCTION public.llnd_mate_count_invitation_completion();

CREATE OR REPLACE FUNCTION public.llnd_mate_count_module_completion()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE v_type text;
BEGIN
  SELECT a.type INTO v_type FROM public.assessments a WHERE a.id = NEW.assessment_id;
  PERFORM public.llnd_mate_record_completion(NEW.invitation_id, CASE WHEN v_type IN ('lln', 'digital') THEN v_type ELSE 'assignment' END);
  RETURN NULL;
END $$;
REVOKE ALL ON FUNCTION public.llnd_mate_count_module_completion() FROM PUBLIC, anon, authenticated;
DROP TRIGGER IF EXISTS llnd_mate_count_module_completion_update ON public.invitation_assessments;
CREATE TRIGGER llnd_mate_count_module_completion_update
  AFTER UPDATE OF individual_status ON public.invitation_assessments FOR EACH ROW
  WHEN (NEW.individual_status = 'completed' AND OLD.individual_status IS DISTINCT FROM 'completed')
  EXECUTE FUNCTION public.llnd_mate_count_module_completion();

-- ── 11. Soft deletion (RTO administrators) ───────────────────────────────
CREATE OR REPLACE FUNCTION public.delete_assessment_assignment(p_invitation_id uuid, p_confirmation text)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE
  v_org uuid := public.current_organisation_id();
  inv public.assessment_invitations%ROWTYPE;
  v_prior text;
  v_period date := public.llnd_usage_period_month(now());
  v_refunded boolean := false;
BEGIN
  IF auth.uid() IS NULL OR v_org IS NULL OR NOT public.has_workspace_access('administration') THEN
    RAISE EXCEPTION 'not_authorised' USING ERRCODE = '42501';
  END IF;
  IF p_confirmation IS DISTINCT FROM 'YES' THEN
    RAISE EXCEPTION 'confirmation_required' USING ERRCODE = '22023', HINT = 'Type YES to confirm deletion.';
  END IF;

  SELECT * INTO inv FROM public.assessment_invitations WHERE id = p_invitation_id FOR UPDATE;
  IF inv.id IS NULL OR inv.organisation_id IS DISTINCT FROM v_org THEN
    RAISE EXCEPTION 'not_found' USING ERRCODE = 'P0002';
  END IF;
  IF inv.deleted_at IS NOT NULL THEN
    RETURN jsonb_build_object('status', 'already_deleted', 'allowance_refunded', false);
  END IF;

  v_prior := CASE
    WHEN inv.lln_status = 'completed' OR inv.digital_status = 'completed' OR inv.status = 'completed' THEN 'completed'
    WHEN inv.lln_status = 'in_progress' OR inv.digital_status = 'in_progress' OR inv.status = 'in_progress'
      OR EXISTS (SELECT 1 FROM public.invitation_assessments ia WHERE ia.invitation_id = inv.id AND ia.individual_status IN ('in_progress', 'completed'))
      THEN 'in_progress'
    ELSE 'not_started' END;

  UPDATE public.assessment_invitations
  SET deleted_at = now(), deleted_by = auth.uid(), deleted_prior_status = v_prior
  WHERE id = inv.id;

  -- Refund only a chargeable invitation issued in the current month, only once.
  PERFORM 1 FROM public.organisation_usage_periods
  WHERE organisation_id = v_org AND period_month = v_period FOR UPDATE;
  UPDATE public.organisation_invitation_ledger SET refunded_at = now()
  WHERE invitation_id = inv.id AND organisation_id = v_org AND chargeable AND refunded_at IS NULL AND period_month = v_period;
  IF FOUND THEN
    UPDATE public.organisation_usage_periods SET refunded = refunded + 1, updated_at = now()
    WHERE organisation_id = v_org AND period_month = v_period;
    v_refunded := true;
  END IF;

  -- No further emails or integration actions for this assignment.
  UPDATE public.email_queue SET status = 'cancelled' WHERE invitation_id = inv.id AND status = 'pending';
  UPDATE public.axcelerate_writeback_queue SET status = 'cancelled' WHERE invitation_id = inv.id AND status = 'pending';

  INSERT INTO public.assessment_assignment_events (invitation_id, organisation_id, action, actor_user_id, prior_status, allowance_refunded)
  VALUES (inv.id, v_org, 'deleted', auth.uid(), v_prior, v_refunded);

  RETURN jsonb_build_object('status', 'deleted', 'allowance_refunded', v_refunded);
END $$;
REVOKE ALL ON FUNCTION public.delete_assessment_assignment(uuid, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.delete_assessment_assignment(uuid, text) TO authenticated;

-- ── 12. Platform operator checks and restoration ─────────────────────────
-- Uses Issue #45's is_platform_operator() (active grant + MFA session). Without
-- #45 installed every caller is refused.
CREATE OR REPLACE FUNCTION public.llnd_is_platform_operator()
RETURNS boolean LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE v boolean;
BEGIN
  IF to_regprocedure('public.is_platform_operator()') IS NULL THEN RETURN false; END IF;
  EXECUTE 'SELECT public.is_platform_operator()' INTO v;
  RETURN coalesce(v, false);
END $$;
REVOKE ALL ON FUNCTION public.llnd_is_platform_operator() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.llnd_is_platform_operator() TO authenticated;

CREATE OR REPLACE FUNCTION public.restore_assessment_assignment(p_invitation_id uuid, p_note text DEFAULT NULL)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE inv public.assessment_invitations%ROWTYPE;
BEGIN
  IF auth.uid() IS NULL OR NOT public.llnd_is_platform_operator() THEN
    RAISE EXCEPTION 'not_authorised' USING ERRCODE = '42501';
  END IF;
  SELECT * INTO inv FROM public.assessment_invitations WHERE id = p_invitation_id FOR UPDATE;
  IF inv.id IS NULL THEN RAISE EXCEPTION 'not_found' USING ERRCODE = 'P0002'; END IF;
  IF inv.deleted_at IS NULL THEN
    RETURN jsonb_build_object('status', 'already_active');
  END IF;
  -- Only the deletion fields change: no allowance use, no resend, no workflows.
  UPDATE public.assessment_invitations
  SET deleted_at = NULL, deleted_by = NULL, deleted_prior_status = NULL, restored_at = now(), restored_by = auth.uid()
  WHERE id = inv.id;
  INSERT INTO public.assessment_assignment_events (invitation_id, organisation_id, action, actor_user_id, prior_status, note)
  VALUES (inv.id, inv.organisation_id, 'restored', auth.uid(), inv.deleted_prior_status, nullif(trim(p_note), ''));
  RETURN jsonb_build_object('status', 'restored');
END $$;
REVOKE ALL ON FUNCTION public.restore_assessment_assignment(uuid, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.restore_assessment_assignment(uuid, text) TO authenticated;

-- Invitations & Usage: one row per RTO, server-derived. Month figures use the
-- ledger; "gross" never decreases, "net" = gross minus same-month refunds.
CREATE OR REPLACE FUNCTION public.platform_invitation_usage(p_month date DEFAULT NULL, p_search text DEFAULT NULL)
RETURNS TABLE (
  organisation_id uuid, organisation_name text, plan_code text, monthly_allowance integer,
  total_invitations_sent bigint, month_invitations_sent bigint, month_net_usage bigint, month_remaining integer,
  month_test_invitations bigint, total_test_invitations bigint, deleted_invitations bigint,
  completed_assessments bigint, restored_assessments bigint, counter_consistent boolean)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE v_month date := coalesce(date_trunc('month', p_month)::date, public.llnd_usage_period_month(now()));
BEGIN
  IF auth.uid() IS NULL OR NOT public.llnd_is_platform_operator() THEN
    RAISE EXCEPTION 'not_authorised' USING ERRCODE = '42501';
  END IF;
  RETURN QUERY
  SELECT o.id, o.name, e.plan_code, e.monthly_invitation_allowance,
    (SELECT count(*) FROM public.organisation_invitation_ledger l WHERE l.organisation_id = o.id AND NOT l.is_test),
    (SELECT count(*) FROM public.organisation_invitation_ledger l WHERE l.organisation_id = o.id AND l.chargeable AND l.period_month = v_month),
    (SELECT count(*) FROM public.organisation_invitation_ledger l WHERE l.organisation_id = o.id AND l.chargeable AND l.period_month = v_month AND l.refunded_at IS NULL),
    CASE WHEN e.organisation_id IS NULL THEN NULL ELSE greatest(e.monthly_invitation_allowance - (
      SELECT count(*) FROM public.organisation_invitation_ledger l WHERE l.organisation_id = o.id AND l.chargeable AND l.period_month = v_month AND l.refunded_at IS NULL)::int, 0) END,
    (SELECT count(*) FROM public.organisation_invitation_ledger l WHERE l.organisation_id = o.id AND l.is_test AND l.period_month = v_month),
    (SELECT count(*) FROM public.organisation_invitation_ledger l WHERE l.organisation_id = o.id AND l.is_test),
    (SELECT count(*) FROM public.assessment_invitations i WHERE i.organisation_id = o.id AND i.deleted_at IS NOT NULL),
    (SELECT count(*) FROM public.organisation_usage_completions c WHERE c.organisation_id = o.id),
    (SELECT count(*) FROM public.assessment_invitations i WHERE i.organisation_id = o.id AND i.restored_at IS NOT NULL),
    coalesce((SELECT p.chargeable_sent - p.refunded FROM public.organisation_usage_periods p WHERE p.organisation_id = o.id AND p.period_month = v_month), 0)
      = (SELECT count(*) FROM public.organisation_invitation_ledger l WHERE l.organisation_id = o.id AND l.chargeable AND l.period_month = v_month AND l.refunded_at IS NULL)
  FROM public.organisations o
  LEFT JOIN public.organisation_plan_entitlements e ON e.organisation_id = o.id
  WHERE p_search IS NULL OR o.name ILIKE '%' || replace(replace(p_search, '%', '\%'), '_', '\_') || '%'
  ORDER BY o.name;
END $$;
REVOKE ALL ON FUNCTION public.platform_invitation_usage(date, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.platform_invitation_usage(date, text) TO authenticated;

-- Organisation detail: the last 12 months.
CREATE OR REPLACE FUNCTION public.platform_invitation_usage_history(p_organisation_id uuid)
RETURNS TABLE (period_month date, invitations_sent bigint, refunded bigint, net_usage bigint, test_invitations bigint, completed bigint)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, public AS $$
BEGIN
  IF auth.uid() IS NULL OR NOT public.llnd_is_platform_operator() THEN
    RAISE EXCEPTION 'not_authorised' USING ERRCODE = '42501';
  END IF;
  RETURN QUERY
  SELECT m.month::date,
    (SELECT count(*) FROM public.organisation_invitation_ledger l WHERE l.organisation_id = p_organisation_id AND l.chargeable AND l.period_month = m.month),
    (SELECT count(*) FROM public.organisation_invitation_ledger l WHERE l.organisation_id = p_organisation_id AND l.chargeable AND l.period_month = m.month AND l.refunded_at IS NOT NULL),
    (SELECT count(*) FROM public.organisation_invitation_ledger l WHERE l.organisation_id = p_organisation_id AND l.chargeable AND l.period_month = m.month AND l.refunded_at IS NULL),
    (SELECT count(*) FROM public.organisation_invitation_ledger l WHERE l.organisation_id = p_organisation_id AND l.is_test AND l.period_month = m.month),
    (SELECT count(*) FROM public.organisation_usage_completions c WHERE c.organisation_id = p_organisation_id AND c.period_month = m.month)
  FROM generate_series(public.llnd_usage_period_month(now()) - interval '11 months', public.llnd_usage_period_month(now()), interval '1 month') AS m(month)
  ORDER BY 1 DESC;
END $$;
REVOKE ALL ON FUNCTION public.platform_invitation_usage_history(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.platform_invitation_usage_history(uuid) TO authenticated;

-- Deleted assessments: identification and status only, no results or answers.
CREATE OR REPLACE FUNCTION public.platform_deleted_assessments(p_search text DEFAULT NULL, p_include_restored boolean DEFAULT false)
RETURNS TABLE (invitation_id uuid, organisation_id uuid, organisation_name text, learner_name text, learner_email text,
  is_test boolean, invited_at timestamptz, prior_status text, deleted_at timestamptz, deleted_by_email text,
  restoration_status text, restored_at timestamptz, restored_by_email text)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE v_pattern text := '%' || replace(replace(coalesce(p_search, ''), '%', '\%'), '_', '\_') || '%';
BEGIN
  IF auth.uid() IS NULL OR NOT public.llnd_is_platform_operator() THEN
    RAISE EXCEPTION 'not_authorised' USING ERRCODE = '42501';
  END IF;
  RETURN QUERY
  SELECT i.id, o.id, o.name, i.candidate_name, i.candidate_email, i.is_test, i.created_at,
    coalesce(i.deleted_prior_status, d.prior_status), coalesce(i.deleted_at, d.occurred_at),
    (SELECT u.email::text FROM auth.users u WHERE u.id = d.actor_user_id),
    CASE WHEN i.deleted_at IS NULL THEN 'restored' ELSE 'deleted' END,
    i.restored_at, (SELECT u.email::text FROM auth.users u WHERE u.id = i.restored_by)
  FROM public.assessment_invitations i
  JOIN public.organisations o ON o.id = i.organisation_id
  LEFT JOIN LATERAL (SELECT ev.* FROM public.assessment_assignment_events ev
                     WHERE ev.invitation_id = i.id AND ev.action = 'deleted' ORDER BY ev.occurred_at DESC LIMIT 1) d ON true
  WHERE (i.deleted_at IS NOT NULL OR (p_include_restored AND i.restored_at IS NOT NULL))
    AND (p_search IS NULL OR o.name ILIKE v_pattern OR i.candidate_name ILIKE v_pattern OR i.candidate_email ILIKE v_pattern)
  ORDER BY coalesce(i.deleted_at, d.occurred_at) DESC
  LIMIT 500;
END $$;
REVOKE ALL ON FUNCTION public.platform_deleted_assessments(text, boolean) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.platform_deleted_assessments(text, boolean) TO authenticated;

-- ── 13. RTO Plan & usage read model ──────────────────────────────────────
CREATE OR REPLACE FUNCTION public.get_my_plan_usage()
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE
  v_org uuid;
  v_ent public.organisation_plan_entitlements%ROWTYPE;
  v_period date := public.llnd_usage_period_month(now());
  v_counter integer; v_net integer; v_gross integer; v_refunded integer; v_tests integer;
BEGIN
  IF auth.uid() IS NULL THEN RAISE EXCEPTION 'not_authorised' USING ERRCODE = '42501'; END IF;
  v_org := public.current_organisation_id();
  IF v_org IS NULL OR NOT public.has_workspace_access('administration') THEN
    RAISE EXCEPTION 'not_authorised' USING ERRCODE = '42501';
  END IF;
  SELECT * INTO v_ent FROM public.organisation_plan_entitlements WHERE organisation_id = v_org;
  SELECT coalesce((SELECT chargeable_sent - refunded FROM public.organisation_usage_periods
                   WHERE organisation_id = v_org AND period_month = v_period), 0) INTO v_counter;
  SELECT count(*) FILTER (WHERE chargeable AND refunded_at IS NULL),
         count(*) FILTER (WHERE chargeable),
         count(*) FILTER (WHERE chargeable AND refunded_at IS NOT NULL),
         count(*) FILTER (WHERE is_test)
    INTO v_net, v_gross, v_refunded, v_tests
  FROM public.organisation_invitation_ledger WHERE organisation_id = v_org AND period_month = v_period;

  RETURN jsonb_build_object(
    'state', CASE WHEN v_ent.organisation_id IS NULL THEN 'no_entitlement' ELSE 'ok' END,
    'consistent', v_counter = v_net,
    'plan', CASE WHEN v_ent.organisation_id IS NULL THEN NULL ELSE jsonb_build_object(
      'code', v_ent.plan_code, 'name', 'LLND Mate', 'tier', 'Free', 'status', 'active',
      'monthly_allowance', v_ent.monthly_invitation_allowance, 'unit', 'invitations') END,
    'period', jsonb_build_object(
      'month', v_period,
      'starts_at', public.llnd_usage_period_starts_at(v_period),
      'resets_at', public.llnd_usage_period_starts_at((v_period + interval '1 month')::date),
      'reset_date', (v_period + interval '1 month')::date,
      'timezone', 'AEST (UTC+10)'),
    'usage', jsonb_build_object(
      'used', greatest(v_counter, v_net),
      'allowance', v_ent.monthly_invitation_allowance,
      'remaining', CASE WHEN v_ent.organisation_id IS NULL THEN NULL
                        ELSE greatest(v_ent.monthly_invitation_allowance - greatest(v_counter, v_net), 0) END,
      'sent_this_month', v_gross,
      'returned_by_deletion', v_refunded,
      'test_invitations', v_tests,
      'new_invitations_available', v_ent.organisation_id IS NOT NULL AND greatest(v_counter, v_net) < v_ent.monthly_invitation_allowance),
    'server_time', now());
END $$;
REVOKE ALL ON FUNCTION public.get_my_plan_usage() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.get_my_plan_usage() TO authenticated;
