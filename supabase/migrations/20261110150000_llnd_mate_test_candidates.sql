-- LLND Mate: Create Test Candidate (Product Owner brief, 10 Nov 2026).
--
-- A Test Candidate is a server-created test identity, not an invitation. Creating
-- one uses no allowance. Assessments are sent to it through the existing
-- invitation form; each invitation linked to a test candidate is a permanent test
-- (free, excluded from usage, billing, reporting and integrations, as already
-- implemented for "Test Test" in 20261110090000).
--
-- Names are allocated on the server per RTO: "Test Test", "Test Test2",
-- "Test Test3", ... from a per-RTO counter that only ever increases, so numbers are
-- never reused after deletion and concurrent creation cannot duplicate a name.
-- Name and email are locked. The existing name rule (an invitation named exactly
-- "Test Test" is a test) is unchanged.
--
-- Depends on 20261110090000. Rollback: docs/billing/free-tier-metering.md.

-- ── 1. Test candidates and per-RTO sequence ──────────────────────────────
CREATE TABLE IF NOT EXISTS public.organisation_test_candidate_counters (
  organisation_id uuid PRIMARY KEY REFERENCES public.organisations(id) ON DELETE CASCADE,
  last_number integer NOT NULL DEFAULT 0 CHECK (last_number >= 0)
);

CREATE TABLE IF NOT EXISTS public.test_candidates (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organisation_id uuid NOT NULL REFERENCES public.organisations(id) ON DELETE CASCADE,
  sequence_number integer NOT NULL CHECK (sequence_number > 0),
  candidate_name text NOT NULL,
  email text NOT NULL CHECK (email ~ '^[^@[:space:]]+@[^@[:space:]]+\.[^@[:space:]]+$' AND length(email) <= 254),
  created_by uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  deleted_at timestamptz,
  deleted_by uuid,
  CONSTRAINT test_candidates_name_matches_sequence CHECK (
    candidate_name = CASE WHEN sequence_number = 1 THEN 'Test Test' ELSE 'Test Test' || sequence_number END),
  CONSTRAINT test_candidates_unique_number UNIQUE (organisation_id, sequence_number)
);
CREATE INDEX IF NOT EXISTS test_candidates_org ON public.test_candidates (organisation_id) WHERE deleted_at IS NULL;

ALTER TABLE public.organisation_test_candidate_counters ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.test_candidates ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.organisation_test_candidate_counters FROM PUBLIC, anon, authenticated;
REVOKE ALL ON TABLE public.test_candidates FROM PUBLIC, anon, authenticated;
GRANT SELECT ON TABLE public.test_candidates TO authenticated;
DROP POLICY IF EXISTS test_candidates_own_org_admin_select ON public.test_candidates;
CREATE POLICY test_candidates_own_org_admin_select ON public.test_candidates FOR SELECT TO authenticated
  USING (organisation_id = public.current_organisation_id() AND public.has_workspace_access('administration') AND deleted_at IS NULL);

CREATE OR REPLACE FUNCTION public.llnd_test_candidate_name(p_number integer)
RETURNS text LANGUAGE sql IMMUTABLE PARALLEL SAFE SET search_path = pg_catalog AS $$
  SELECT CASE WHEN p_number = 1 THEN 'Test Test' ELSE 'Test Test' || p_number END
$$;
REVOKE ALL ON FUNCTION public.llnd_test_candidate_name(integer) FROM PUBLIC;

-- ── 2. Link invitations to test candidates ───────────────────────────────
ALTER TABLE public.assessment_invitations
  ADD COLUMN IF NOT EXISTS test_candidate_id uuid REFERENCES public.test_candidates(id) ON DELETE RESTRICT;
CREATE INDEX IF NOT EXISTS assessment_invitations_test_candidate ON public.assessment_invitations (test_candidate_id) WHERE test_candidate_id IS NOT NULL;

-- BEFORE INSERT, runs before llnd_mate_issue_invitation (alphabetical): binds the
-- invitation to the test candidate's locked identity and removes any link to a real
-- learner or integration contact.
CREATE OR REPLACE FUNCTION public.llnd_mate_bind_test_candidate()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE tc public.test_candidates%ROWTYPE;
BEGIN
  IF NEW.test_candidate_id IS NULL THEN RETURN NEW; END IF;
  SELECT * INTO tc FROM public.test_candidates WHERE id = NEW.test_candidate_id;
  IF tc.id IS NULL OR tc.organisation_id IS DISTINCT FROM NEW.organisation_id OR tc.deleted_at IS NOT NULL THEN
    RAISE EXCEPTION 'test_candidate_unavailable' USING ERRCODE = 'P0001';
  END IF;
  NEW.candidate_name := tc.candidate_name;
  NEW.candidate_email := tc.email;
  NEW.student_id := NULL;
  NEW.axcelerate_contact_id := NULL;
  RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION public.llnd_mate_bind_test_candidate() FROM PUBLIC, anon, authenticated;
DROP TRIGGER IF EXISTS llnd_mate_bind_test_candidate ON public.assessment_invitations;
CREATE TRIGGER llnd_mate_bind_test_candidate BEFORE INSERT ON public.assessment_invitations
  FOR EACH ROW EXECUTE FUNCTION public.llnd_mate_bind_test_candidate();

-- Classification now also covers test-candidate invitations (rest unchanged).
CREATE OR REPLACE FUNCTION public.llnd_mate_issue_invitation()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE
  v_period date := public.llnd_usage_period_month(now());
  v_allowance integer;
  v_active integer;
BEGIN
  NEW.is_test := NEW.test_candidate_id IS NOT NULL OR public.llnd_is_reserved_test_name(NEW.candidate_name);
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

-- Locked fields now also cover the test-candidate link and a linked test's email.
CREATE OR REPLACE FUNCTION public.llnd_mate_protect_invitation_fields()
RETURNS trigger LANGUAGE plpgsql SET search_path = pg_catalog, public AS $$
BEGIN
  IF NEW.is_test IS DISTINCT FROM OLD.is_test THEN
    RAISE EXCEPTION 'test_classification_locked' USING ERRCODE = '42501';
  END IF;
  IF NEW.test_candidate_id IS DISTINCT FROM OLD.test_candidate_id THEN
    RAISE EXCEPTION 'test_identity_locked' USING ERRCODE = '42501';
  END IF;
  IF OLD.is_test AND (NEW.candidate_name IS DISTINCT FROM OLD.candidate_name
                      OR NEW.student_id IS DISTINCT FROM OLD.student_id
                      OR NEW.organisation_id IS DISTINCT FROM OLD.organisation_id
                      OR (OLD.test_candidate_id IS NOT NULL AND NEW.candidate_email IS DISTINCT FROM OLD.candidate_email)) THEN
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

-- ── 3. RPCs for RTO administrators ───────────────────────────────────────
CREATE OR REPLACE FUNCTION public.preview_next_test_candidate_name()
RETURNS text LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE v_org uuid := public.current_organisation_id(); v_last integer;
BEGIN
  IF auth.uid() IS NULL OR v_org IS NULL OR NOT public.has_workspace_access('administration') THEN
    RAISE EXCEPTION 'not_authorised' USING ERRCODE = '42501';
  END IF;
  SELECT last_number INTO v_last FROM public.organisation_test_candidate_counters WHERE organisation_id = v_org;
  RETURN public.llnd_test_candidate_name(coalesce(v_last, 0) + 1);
END $$;
REVOKE ALL ON FUNCTION public.preview_next_test_candidate_name() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.preview_next_test_candidate_name() TO authenticated;

CREATE OR REPLACE FUNCTION public.create_test_candidate(p_email text)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE
  v_org uuid := public.current_organisation_id();
  v_email text := btrim(coalesce(p_email, ''));
  v_number integer;
  v_row public.test_candidates%ROWTYPE;
BEGIN
  IF auth.uid() IS NULL OR v_org IS NULL OR NOT public.has_workspace_access('administration') THEN
    RAISE EXCEPTION 'not_authorised' USING ERRCODE = '42501';
  END IF;
  IF v_email !~ '^[^@[:space:]]+@[^@[:space:]]+\.[^@[:space:]]+$' OR length(v_email) > 254 THEN
    RAISE EXCEPTION 'invalid_email' USING ERRCODE = '22023', HINT = 'Enter a valid email address.';
  END IF;
  -- The counter row lock serialises concurrent creation for this RTO; numbers only increase.
  INSERT INTO public.organisation_test_candidate_counters (organisation_id) VALUES (v_org) ON CONFLICT DO NOTHING;
  UPDATE public.organisation_test_candidate_counters SET last_number = last_number + 1
  WHERE organisation_id = v_org RETURNING last_number INTO v_number;
  INSERT INTO public.test_candidates (organisation_id, sequence_number, candidate_name, email, created_by)
  VALUES (v_org, v_number, public.llnd_test_candidate_name(v_number), v_email, auth.uid())
  RETURNING * INTO v_row;
  RETURN jsonb_build_object('id', v_row.id, 'candidate_name', v_row.candidate_name, 'email', v_row.email, 'sequence_number', v_row.sequence_number);
END $$;
REVOKE ALL ON FUNCTION public.create_test_candidate(text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.create_test_candidate(text) TO authenticated;

-- Soft-deletes a test candidate (same typed YES rule). Its number is never reused.
-- Assessments already sent to it are deleted separately through
-- delete_assessment_assignment and are unaffected here.
CREATE OR REPLACE FUNCTION public.delete_test_candidate(p_test_candidate_id uuid, p_confirmation text)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE v_org uuid := public.current_organisation_id(); v_row public.test_candidates%ROWTYPE;
BEGIN
  IF auth.uid() IS NULL OR v_org IS NULL OR NOT public.has_workspace_access('administration') THEN
    RAISE EXCEPTION 'not_authorised' USING ERRCODE = '42501';
  END IF;
  IF p_confirmation IS DISTINCT FROM 'YES' THEN
    RAISE EXCEPTION 'confirmation_required' USING ERRCODE = '22023', HINT = 'Type YES to confirm deletion.';
  END IF;
  SELECT * INTO v_row FROM public.test_candidates WHERE id = p_test_candidate_id FOR UPDATE;
  IF v_row.id IS NULL OR v_row.organisation_id IS DISTINCT FROM v_org THEN
    RAISE EXCEPTION 'not_found' USING ERRCODE = 'P0002';
  END IF;
  IF v_row.deleted_at IS NOT NULL THEN RETURN jsonb_build_object('status', 'already_deleted'); END IF;
  UPDATE public.test_candidates SET deleted_at = now(), deleted_by = auth.uid() WHERE id = v_row.id;
  RETURN jsonb_build_object('status', 'deleted');
END $$;
REVOKE ALL ON FUNCTION public.delete_test_candidate(uuid, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.delete_test_candidate(uuid, text) TO authenticated;
