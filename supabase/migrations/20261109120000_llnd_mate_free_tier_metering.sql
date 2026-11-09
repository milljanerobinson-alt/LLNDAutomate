-- LLND Mate Free tier: entitlements, monthly completion metering and new-start restriction.
--
-- Approved rules (Product Owner, 9 Nov 2026):
--   * LLND Mate (free): 10 completed assessment assignments per RTO per calendar month.
--   * An assignment is one assessment_invitations row. LLN and Digital completed under
--     the same assignment count once. Invitations, reminders, starts without completion
--     and abandoned assessments do not count.
--   * Learners already in progress may finish after the allowance is reached.
--   * New assessment starts are restricted once the allowance is reached.
--   * Enforcement is per RTO (organisation), server-side, idempotent.
--
-- Month boundary: calendar month in AEST, a fixed UTC+10 offset with no daylight
-- saving (Product Owner preference, flagged for confirmation). Computed from the
-- database clock (now()), never from browser-supplied timestamps.
--
-- NOT included (needs Product Owner approval, see docs/billing/free-tier-metering.md):
--   * Any reservation of allowance at start time, active-assessment cap or reservation
--     timeout. Without one, assignments started before the allowance is reached can
--     all still finish and be counted, so a month can exceed 10 completions.
--   * Backfill of completions recorded before this migration.
--
-- Rollback: docs/billing/free-tier-metering.md ("Rollback").

-- ── 1. Month boundary helpers ─────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.llnd_usage_period_month(ts timestamptz)
RETURNS date LANGUAGE sql IMMUTABLE PARALLEL SAFE SET search_path = pg_catalog AS $$
  SELECT date_trunc('month', (ts AT TIME ZONE 'UTC') + interval '10 hours')::date
$$;
COMMENT ON FUNCTION public.llnd_usage_period_month(timestamptz) IS
  'LLND Mate usage month: first day of the calendar month in AEST (fixed UTC+10, no daylight saving).';

CREATE OR REPLACE FUNCTION public.llnd_usage_period_starts_at(period_month date)
RETURNS timestamptz LANGUAGE sql IMMUTABLE PARALLEL SAFE SET search_path = pg_catalog AS $$
  SELECT (period_month::timestamp - interval '10 hours') AT TIME ZONE 'UTC'
$$;

REVOKE ALL ON FUNCTION public.llnd_usage_period_month(timestamptz) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.llnd_usage_period_starts_at(date) FROM PUBLIC;

-- ── 2. Entitlements ───────────────────────────────────────────────────────
-- One row per RTO. Only the free plan can exist: paid plans need a later,
-- separately approved migration. No application role can write this table.
CREATE TABLE IF NOT EXISTS public.organisation_plan_entitlements (
  organisation_id uuid PRIMARY KEY REFERENCES public.organisations(id) ON DELETE CASCADE,
  plan_code text NOT NULL CHECK (plan_code = 'llnd_mate_free'),
  monthly_completion_allowance integer NOT NULL CHECK (monthly_completion_allowance > 0),
  source text NOT NULL CHECK (source IN ('signup', 'migration_backfill')),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
COMMENT ON TABLE public.organisation_plan_entitlements IS
  'Server-controlled plan entitlement per RTO. A missing row means no confirmed entitlement: new starts are refused and the Plan & usage page says so.';

-- ── 3. Usage ledger and period counters ──────────────────────────────────
-- The ledger is the record of truth: one row per counted assignment, ever.
-- invitation_id is UNIQUE (idempotency) and deliberately has no foreign key,
-- so deleting a completed assignment cannot give the allowance back.
CREATE TABLE IF NOT EXISTS public.organisation_usage_completions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organisation_id uuid NOT NULL REFERENCES public.organisations(id) ON DELETE CASCADE,
  invitation_id uuid NOT NULL,
  period_month date NOT NULL CHECK (period_month = date_trunc('month', period_month)::date),
  first_completed_module text NOT NULL CHECK (first_completed_module IN ('lln', 'digital', 'assignment')),
  counted_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT organisation_usage_completions_one_per_assignment UNIQUE (invitation_id)
);
CREATE INDEX IF NOT EXISTS organisation_usage_completions_org_period
  ON public.organisation_usage_completions (organisation_id, period_month);

-- Per-RTO, per-month counter. Maintained only by the counting trigger, in the same
-- transaction as the ledger insert. Its row is also the lock that serialises
-- start authorisation for one RTO and month.
CREATE TABLE IF NOT EXISTS public.organisation_usage_periods (
  organisation_id uuid NOT NULL REFERENCES public.organisations(id) ON DELETE CASCADE,
  period_month date NOT NULL CHECK (period_month = date_trunc('month', period_month)::date),
  completed_count integer NOT NULL DEFAULT 0 CHECK (completed_count >= 0),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (organisation_id, period_month)
);

-- ── 4. RLS and privileges ────────────────────────────────────────────────
ALTER TABLE public.organisation_plan_entitlements ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.organisation_usage_completions ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.organisation_usage_periods ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON TABLE public.organisation_plan_entitlements FROM PUBLIC, anon, authenticated;
REVOKE ALL ON TABLE public.organisation_usage_completions FROM PUBLIC, anon, authenticated;
REVOKE ALL ON TABLE public.organisation_usage_periods FROM PUBLIC, anon, authenticated;
GRANT SELECT ON TABLE public.organisation_plan_entitlements TO authenticated;
GRANT SELECT ON TABLE public.organisation_usage_completions TO authenticated;
GRANT SELECT ON TABLE public.organisation_usage_periods TO authenticated;

DROP POLICY IF EXISTS plan_entitlements_own_org_admin_select ON public.organisation_plan_entitlements;
CREATE POLICY plan_entitlements_own_org_admin_select ON public.organisation_plan_entitlements
  FOR SELECT TO authenticated
  USING (organisation_id = public.current_organisation_id() AND public.has_workspace_access('administration'));
DROP POLICY IF EXISTS usage_completions_own_org_admin_select ON public.organisation_usage_completions;
CREATE POLICY usage_completions_own_org_admin_select ON public.organisation_usage_completions
  FOR SELECT TO authenticated
  USING (organisation_id = public.current_organisation_id() AND public.has_workspace_access('administration'));
DROP POLICY IF EXISTS usage_periods_own_org_admin_select ON public.organisation_usage_periods;
CREATE POLICY usage_periods_own_org_admin_select ON public.organisation_usage_periods
  FOR SELECT TO authenticated
  USING (organisation_id = public.current_organisation_id() AND public.has_workspace_access('administration'));

-- ── 5. Free entitlement for every RTO ────────────────────────────────────
CREATE OR REPLACE FUNCTION public.llnd_mate_grant_free_entitlement()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
BEGIN
  INSERT INTO public.organisation_plan_entitlements (organisation_id, plan_code, monthly_completion_allowance, source)
  VALUES (NEW.id, 'llnd_mate_free', 10, 'signup')
  ON CONFLICT (organisation_id) DO NOTHING;
  RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION public.llnd_mate_grant_free_entitlement() FROM PUBLIC, anon, authenticated;
DROP TRIGGER IF EXISTS llnd_mate_free_entitlement ON public.organisations;
CREATE TRIGGER llnd_mate_free_entitlement AFTER INSERT ON public.organisations
  FOR EACH ROW EXECUTE FUNCTION public.llnd_mate_grant_free_entitlement();

-- Existing RTOs: free entitlement. Legacy subscription rows are not read or changed.
INSERT INTO public.organisation_plan_entitlements (organisation_id, plan_code, monthly_completion_allowance, source)
SELECT o.id, 'llnd_mate_free', 10, 'migration_backfill' FROM public.organisations o
ON CONFLICT (organisation_id) DO NOTHING;

-- ── 6. Assignment state ──────────────────────────────────────────────────
-- An assignment (assessment_invitations row) has started once any of these leaves
-- its not-started value: lln_status, digital_status (separate LLN/Digital links),
-- status ('in_progress'/'completed'), or any invitation_assessments.individual_status
-- (the legacy combined quiz link #/quiz/<token> writes only those).
CREATE OR REPLACE FUNCTION public.llnd_assignment_started(lln_status text, digital_status text)
RETURNS boolean LANGUAGE sql IMMUTABLE PARALLEL SAFE SET search_path = pg_catalog AS $$
  SELECT coalesce(lln_status, 'pending') IN ('in_progress', 'completed')
      OR coalesce(digital_status, 'pending') IN ('in_progress', 'completed')
$$;
REVOKE ALL ON FUNCTION public.llnd_assignment_started(text, text) FROM PUBLIC;

CREATE OR REPLACE FUNCTION public.llnd_assignment_row_started(
  p_invitation_id uuid, p_lln text, p_digital text, p_status text, p_exclude_module uuid)
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public AS $$
  SELECT public.llnd_assignment_started(p_lln, p_digital)
      OR coalesce(p_status, 'sent') IN ('in_progress', 'completed')
      OR EXISTS (SELECT 1 FROM public.invitation_assessments ia
                 WHERE ia.invitation_id = p_invitation_id
                   AND ia.id IS DISTINCT FROM p_exclude_module
                   AND ia.individual_status IN ('in_progress', 'completed'))
$$;
REVOKE ALL ON FUNCTION public.llnd_assignment_row_started(uuid, text, text, text, uuid) FROM PUBLIC, anon, authenticated;

-- ── 7. New-start authorisation ───────────────────────────────────────────
-- Runs only when an assignment moves from not started to started (including a
-- direct jump to completed). Already-started assignments, including the second
-- module of a combined assignment, are never checked, so learners in progress can
-- finish. The RTO's period row is locked FOR UPDATE, so the check and concurrent
-- completions for the same RTO and month are serialised.
-- The error text is deliberately generic: it reaches the learner's browser and
-- must not reveal plan or usage details.
CREATE OR REPLACE FUNCTION public.llnd_mate_check_new_start(p_organisation_id uuid)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE
  v_allowance integer;
  v_period date := public.llnd_usage_period_month(now());
  v_completed integer;
BEGIN
  SELECT e.monthly_completion_allowance INTO v_allowance
  FROM public.organisation_plan_entitlements e WHERE e.organisation_id = p_organisation_id;
  IF v_allowance IS NULL THEN
    RAISE EXCEPTION 'assessment_start_unavailable' USING ERRCODE = 'P0001';
  END IF;
  INSERT INTO public.organisation_usage_periods (organisation_id, period_month)
  VALUES (p_organisation_id, v_period) ON CONFLICT DO NOTHING;
  SELECT p.completed_count INTO v_completed FROM public.organisation_usage_periods p
  WHERE p.organisation_id = p_organisation_id AND p.period_month = v_period
  FOR UPDATE;
  IF v_completed >= v_allowance THEN
    RAISE EXCEPTION 'assessment_start_unavailable' USING ERRCODE = 'P0001';
  END IF;
END $$;
REVOKE ALL ON FUNCTION public.llnd_mate_check_new_start(uuid) FROM PUBLIC, anon, authenticated;

CREATE OR REPLACE FUNCTION public.llnd_mate_authorise_invitation_start()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
BEGIN
  IF TG_OP = 'UPDATE' AND public.llnd_assignment_row_started(OLD.id, OLD.lln_status, OLD.digital_status, OLD.status, NULL) THEN
    RETURN NEW;
  END IF;
  IF public.llnd_assignment_row_started(NEW.id, NEW.lln_status, NEW.digital_status, NEW.status, NULL) THEN
    PERFORM public.llnd_mate_check_new_start(NEW.organisation_id);
  END IF;
  RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION public.llnd_mate_authorise_invitation_start() FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS llnd_mate_authorise_start_update ON public.assessment_invitations;
CREATE TRIGGER llnd_mate_authorise_start_update
  BEFORE UPDATE OF lln_status, digital_status, status ON public.assessment_invitations
  FOR EACH ROW EXECUTE FUNCTION public.llnd_mate_authorise_invitation_start();
DROP TRIGGER IF EXISTS llnd_mate_authorise_start_insert ON public.assessment_invitations;
CREATE TRIGGER llnd_mate_authorise_start_insert
  BEFORE INSERT ON public.assessment_invitations
  FOR EACH ROW EXECUTE FUNCTION public.llnd_mate_authorise_invitation_start();

CREATE OR REPLACE FUNCTION public.llnd_mate_authorise_module_start()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE inv record;
BEGIN
  IF coalesce(NEW.individual_status, 'pending') NOT IN ('in_progress', 'completed') THEN RETURN NEW; END IF;
  IF TG_OP = 'UPDATE' AND coalesce(OLD.individual_status, 'pending') IN ('in_progress', 'completed') THEN RETURN NEW; END IF;
  SELECT i.id, i.organisation_id, i.lln_status, i.digital_status, i.status INTO inv
  FROM public.assessment_invitations i WHERE i.id = NEW.invitation_id;
  IF inv.id IS NULL THEN RETURN NEW; END IF;
  IF NOT public.llnd_assignment_row_started(inv.id, inv.lln_status, inv.digital_status, inv.status, NEW.id) THEN
    PERFORM public.llnd_mate_check_new_start(inv.organisation_id);
  END IF;
  RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION public.llnd_mate_authorise_module_start() FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS llnd_mate_authorise_module_start_update ON public.invitation_assessments;
CREATE TRIGGER llnd_mate_authorise_module_start_update
  BEFORE UPDATE OF individual_status ON public.invitation_assessments
  FOR EACH ROW EXECUTE FUNCTION public.llnd_mate_authorise_module_start();
DROP TRIGGER IF EXISTS llnd_mate_authorise_module_start_insert ON public.invitation_assessments;
CREATE TRIGGER llnd_mate_authorise_module_start_insert
  BEFORE INSERT ON public.invitation_assessments
  FOR EACH ROW EXECUTE FUNCTION public.llnd_mate_authorise_module_start();

-- ── 8. Completion counting (idempotent, same transaction as the completion) ──
CREATE OR REPLACE FUNCTION public.llnd_mate_record_completion(
  p_organisation_id uuid, p_invitation_id uuid, p_module text)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE
  v_period date := public.llnd_usage_period_month(now());
  v_inserted integer;
BEGIN
  INSERT INTO public.organisation_usage_completions (organisation_id, invitation_id, period_month, first_completed_module)
  VALUES (p_organisation_id, p_invitation_id, v_period, p_module)
  ON CONFLICT ON CONSTRAINT organisation_usage_completions_one_per_assignment DO NOTHING;
  GET DIAGNOSTICS v_inserted = ROW_COUNT;
  IF v_inserted = 1 THEN
    INSERT INTO public.organisation_usage_periods AS p (organisation_id, period_month, completed_count)
    VALUES (p_organisation_id, v_period, 1)
    ON CONFLICT (organisation_id, period_month)
    DO UPDATE SET completed_count = p.completed_count + 1, updated_at = now();
  END IF;
END $$;
REVOKE ALL ON FUNCTION public.llnd_mate_record_completion(uuid, uuid, text) FROM PUBLIC, anon, authenticated;

CREATE OR REPLACE FUNCTION public.llnd_mate_count_invitation_completion()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE v_module text;
BEGIN
  IF NEW.lln_status = 'completed' AND (TG_OP = 'INSERT' OR OLD.lln_status IS DISTINCT FROM 'completed') THEN
    v_module := 'lln';
  ELSIF NEW.digital_status = 'completed' AND (TG_OP = 'INSERT' OR OLD.digital_status IS DISTINCT FROM 'completed') THEN
    v_module := 'digital';
  ELSIF NEW.status = 'completed' AND (TG_OP = 'INSERT' OR OLD.status IS DISTINCT FROM 'completed') THEN
    v_module := 'assignment';
  ELSE
    RETURN NULL;
  END IF;
  PERFORM public.llnd_mate_record_completion(NEW.organisation_id, NEW.id, v_module);
  RETURN NULL;
END $$;
REVOKE ALL ON FUNCTION public.llnd_mate_count_invitation_completion() FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS llnd_mate_count_completion_update ON public.assessment_invitations;
CREATE TRIGGER llnd_mate_count_completion_update
  AFTER UPDATE OF lln_status, digital_status, status ON public.assessment_invitations
  FOR EACH ROW
  WHEN ((NEW.lln_status = 'completed' AND OLD.lln_status IS DISTINCT FROM 'completed')
     OR (NEW.digital_status = 'completed' AND OLD.digital_status IS DISTINCT FROM 'completed')
     OR (NEW.status = 'completed' AND OLD.status IS DISTINCT FROM 'completed'))
  EXECUTE FUNCTION public.llnd_mate_count_invitation_completion();
DROP TRIGGER IF EXISTS llnd_mate_count_completion_insert ON public.assessment_invitations;
CREATE TRIGGER llnd_mate_count_completion_insert
  AFTER INSERT ON public.assessment_invitations
  FOR EACH ROW
  WHEN (NEW.lln_status = 'completed' OR NEW.digital_status = 'completed' OR NEW.status = 'completed')
  EXECUTE FUNCTION public.llnd_mate_count_invitation_completion();

CREATE OR REPLACE FUNCTION public.llnd_mate_count_module_completion()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE v_org uuid; v_type text;
BEGIN
  SELECT i.organisation_id INTO v_org FROM public.assessment_invitations i WHERE i.id = NEW.invitation_id;
  IF v_org IS NULL THEN RETURN NULL; END IF;
  SELECT a.type INTO v_type FROM public.assessments a WHERE a.id = NEW.assessment_id;
  PERFORM public.llnd_mate_record_completion(v_org, NEW.invitation_id,
    CASE WHEN v_type IN ('lln', 'digital') THEN v_type ELSE 'assignment' END);
  RETURN NULL;
END $$;
REVOKE ALL ON FUNCTION public.llnd_mate_count_module_completion() FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS llnd_mate_count_module_completion_update ON public.invitation_assessments;
CREATE TRIGGER llnd_mate_count_module_completion_update
  AFTER UPDATE OF individual_status ON public.invitation_assessments
  FOR EACH ROW
  WHEN (NEW.individual_status = 'completed' AND OLD.individual_status IS DISTINCT FROM 'completed')
  EXECUTE FUNCTION public.llnd_mate_count_module_completion();
DROP TRIGGER IF EXISTS llnd_mate_count_module_completion_insert ON public.invitation_assessments;
CREATE TRIGGER llnd_mate_count_module_completion_insert
  AFTER INSERT ON public.invitation_assessments
  FOR EACH ROW
  WHEN (NEW.individual_status = 'completed')
  EXECUTE FUNCTION public.llnd_mate_count_module_completion();

-- ── 9. Plan & usage read model for RTO administrators ────────────────────
-- Takes no organisation argument: the RTO comes from the caller's active
-- membership, so a browser cannot ask for another RTO's usage.
CREATE OR REPLACE FUNCTION public.get_my_plan_usage()
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE
  v_org uuid;
  v_ent public.organisation_plan_entitlements%ROWTYPE;
  v_period date := public.llnd_usage_period_month(now());
  v_counter integer;
  v_ledger integer;
  v_in_progress integer;
  v_used integer;
BEGIN
  IF auth.uid() IS NULL THEN
    RAISE EXCEPTION 'not_authorised' USING ERRCODE = '42501';
  END IF;
  v_org := public.current_organisation_id();
  IF v_org IS NULL OR NOT public.has_workspace_access('administration') THEN
    RAISE EXCEPTION 'not_authorised' USING ERRCODE = '42501';
  END IF;

  SELECT * INTO v_ent FROM public.organisation_plan_entitlements WHERE organisation_id = v_org;

  SELECT coalesce((SELECT completed_count FROM public.organisation_usage_periods
                   WHERE organisation_id = v_org AND period_month = v_period), 0) INTO v_counter;
  SELECT count(*) INTO v_ledger FROM public.organisation_usage_completions
  WHERE organisation_id = v_org AND period_month = v_period;
  SELECT count(*) INTO v_in_progress FROM public.assessment_invitations i
  WHERE i.organisation_id = v_org
    AND public.llnd_assignment_row_started(i.id, i.lln_status, i.digital_status, i.status, NULL)
    AND NOT EXISTS (SELECT 1 FROM public.organisation_usage_completions c WHERE c.invitation_id = i.id);
  v_used := greatest(v_counter, v_ledger);

  RETURN jsonb_build_object(
    'state', CASE WHEN v_ent.organisation_id IS NULL THEN 'no_entitlement' ELSE 'ok' END,
    'consistent', v_counter = v_ledger,
    'plan', CASE WHEN v_ent.organisation_id IS NULL THEN NULL ELSE jsonb_build_object(
      'code', v_ent.plan_code, 'name', 'LLND Mate', 'tier', 'Free', 'status', 'active',
      'monthly_allowance', v_ent.monthly_completion_allowance) END,
    'period', jsonb_build_object(
      'month', v_period,
      'starts_at', public.llnd_usage_period_starts_at(v_period),
      'resets_at', public.llnd_usage_period_starts_at((v_period + interval '1 month')::date),
      'reset_date', (v_period + interval '1 month')::date,
      'timezone', 'AEST (UTC+10)'),
    'usage', jsonb_build_object(
      'completed', v_used,
      'allowance', v_ent.monthly_completion_allowance,
      'remaining', CASE WHEN v_ent.organisation_id IS NULL THEN NULL
                        ELSE greatest(v_ent.monthly_completion_allowance - v_used, 0) END,
      'in_progress', v_in_progress,
      'new_starts_available', v_ent.organisation_id IS NOT NULL AND v_used < v_ent.monthly_completion_allowance),
    'server_time', now()
  );
END $$;
REVOKE ALL ON FUNCTION public.get_my_plan_usage() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.get_my_plan_usage() TO authenticated;
