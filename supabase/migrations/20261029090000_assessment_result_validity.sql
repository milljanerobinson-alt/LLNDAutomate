-- Assessment-result validity and safe reuse.
--
-- 1. A per-RTO setting `assessment_result_validity` = {"lln_days": n|null,
--    "digital_days": n|null}, edited by Administration through the existing
--    set_organisation_setting RPC. There is no default: an unset period
--    means previous results are never accepted automatically.
-- 2. The inbound-sync log records what was checked, when the decision was
--    made, and the outcome signature used to avoid repeated aXcelerate notes.
--    Adds the 'review_required' status, plus 'error', which the sync already
--    writes for its fetch-failure backoff but the constraint never allowed.
--
-- 3. ACSF mapping approval with provenance and append-only history; a
--    training.gov.au change recorded for a qualification flags its mapping
--    for review. No time-based expiry.
-- 4. Candidate token path: completion times stamped by the database and
--    completed results immutable.
--
-- Forward-only. Requires the Issue #40 organisation-scoping migration.

BEGIN;

DO $$
BEGIN
  IF to_regclass('public.organisation_settings') IS NULL
     OR to_regprocedure('public.organisation_setting_category(text)') IS NULL THEN
    RAISE EXCEPTION 'Result validity preflight: Issue #40 migration 20261028130000 is not installed';
  END IF;
  IF to_regclass('public.axcelerate_inbound_sync_log') IS NULL THEN
    RAISE EXCEPTION 'Result validity preflight: axcelerate_inbound_sync_log is missing';
  END IF;
  IF to_regprocedure('public.can_access_qualification(uuid,boolean)') IS NULL
     OR to_regprocedure('public.get_quiz_token()') IS NULL THEN
    RAISE EXCEPTION 'Result validity preflight: Issue #40 qualification access or the token helper is missing';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'public'
                 AND table_name = 'qualifications' AND column_name = 'mapping_status') THEN
    RAISE EXCEPTION 'Result validity preflight: qualification mapping columns are missing';
  END IF;
END $$;

-- ── 1. Setting ────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.organisation_setting_category(p_key text)
RETURNS text LANGUAGE sql IMMUTABLE SET search_path = pg_catalog AS $$
  SELECT CASE
    WHEN p_key IN ('org_branding','email_settings','notification_settings','reminder_period_days',
                   'overdue_threshold_days','org_rto_number','org_state',
                   'assessment_result_validity') THEN 'administration'
    WHEN p_key IN ('axcelerate_contact_watch_list','axcelerate_auto_sync') THEN 'technical'
  END
$$;

CREATE OR REPLACE FUNCTION public.validate_assessment_result_validity(p_value jsonb)
RETURNS boolean LANGUAGE sql IMMUTABLE SET search_path = pg_catalog AS $$
  SELECT jsonb_typeof(p_value) = 'object'
     AND (SELECT bool_and(k IN ('lln_days','digital_days')) FROM jsonb_object_keys(p_value) k) IS NOT FALSE
     AND (NOT p_value ? 'lln_days' OR jsonb_typeof(p_value->'lln_days') = 'null'
          OR (jsonb_typeof(p_value->'lln_days') = 'number'
              AND (p_value->>'lln_days') ~ '^[0-9]+$'
              AND (p_value->>'lln_days')::int BETWEEN 1 AND 3650))
     AND (NOT p_value ? 'digital_days' OR jsonb_typeof(p_value->'digital_days') = 'null'
          OR (jsonb_typeof(p_value->'digital_days') = 'number'
              AND (p_value->>'digital_days') ~ '^[0-9]+$'
              AND (p_value->>'digital_days')::int BETWEEN 1 AND 3650))
$$;

CREATE OR REPLACE FUNCTION public.check_organisation_setting_value()
RETURNS trigger LANGUAGE plpgsql SET search_path = pg_catalog, public AS $$
BEGIN
  IF NEW.key = 'assessment_result_validity'
     AND NOT public.validate_assessment_result_validity(NEW.value) THEN
    RAISE EXCEPTION 'assessment_result_validity must be {"lln_days": 1-3650 or null, "digital_days": 1-3650 or null}';
  END IF;
  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS check_organisation_setting_value ON public.organisation_settings;
CREATE TRIGGER check_organisation_setting_value
  BEFORE INSERT OR UPDATE ON public.organisation_settings
  FOR EACH ROW EXECUTE FUNCTION public.check_organisation_setting_value();

-- ── 2. Inbound-sync log ──────────────────────────────────────────────────
ALTER TABLE public.axcelerate_inbound_sync_log
  ADD COLUMN IF NOT EXISTS decision_at timestamptz,
  ADD COLUMN IF NOT EXISTS validated_at timestamptz,
  ADD COLUMN IF NOT EXISTS outcome_signature text,
  ADD COLUMN IF NOT EXISTS validity_fingerprint text,
  ADD COLUMN IF NOT EXISTS validity_checks jsonb NOT NULL DEFAULT '[]'::jsonb;

-- Existing rows keep validated_at NULL on purpose: the sync re-checks them
-- once, as at their original decision date, and holds any that don't pass
-- for review (never an automatic reassessment of an existing enrolment).
-- validity_fingerprint records the course, mapping approval and ACSF levels
-- a decision depended on; a change re-checks the decision.

ALTER TABLE public.axcelerate_inbound_sync_log DROP CONSTRAINT IF EXISTS axcelerate_inbound_sync_log_status_check;
ALTER TABLE public.axcelerate_inbound_sync_log ADD CONSTRAINT axcelerate_inbound_sync_log_status_check
  CHECK (status IN ('pending', 'processing', 'skipped', 'created', 'failed', 'cancelled', 'review_required', 'error'));

ALTER TABLE public.axcelerate_inbound_sync_log DROP CONSTRAINT IF EXISTS axcelerate_inbound_sync_log_assessment_type_check;
ALTER TABLE public.axcelerate_inbound_sync_log ADD CONSTRAINT axcelerate_inbound_sync_log_assessment_type_check
  CHECK (assessment_type IN ('lln', 'digital', 'both', 'none', 'error'));

CREATE INDEX IF NOT EXISTS axcelerate_inbound_sync_log_org_status_idx
  ON public.axcelerate_inbound_sync_log (organisation_id, status);

-- ── 3. ACSF mapping approval with provenance and history ─────────────────
-- An approval stays in force until a relevant training.gov.au change is
-- recorded for that qualification or its ACSF levels change. There is no
-- time-based expiry. History is append-only.
ALTER TABLE public.qualifications
  ADD COLUMN IF NOT EXISTS source_release text,
  ADD COLUMN IF NOT EXISTS source_checked_at timestamptz,
  ADD COLUMN IF NOT EXISTS source_check_status text NOT NULL DEFAULT 'unchecked',
  ADD COLUMN IF NOT EXISTS mapping_change_detected_at timestamptz,
  ADD COLUMN IF NOT EXISTS mapping_change_summary jsonb;
ALTER TABLE public.qualifications DROP CONSTRAINT IF EXISTS qualifications_source_check_status_check;
ALTER TABLE public.qualifications ADD CONSTRAINT qualifications_source_check_status_check
  CHECK (source_check_status IN ('unchecked', 'current', 'changed', 'unavailable'));

CREATE TABLE IF NOT EXISTS public.qualification_mapping_approvals (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organisation_id uuid NOT NULL REFERENCES public.organisations(id),
  qualification_id uuid NOT NULL REFERENCES public.qualifications(id) ON DELETE CASCADE,
  decision text NOT NULL CHECK (decision IN ('approved', 'migrated_approval', 'review_required')),
  requirements_snapshot jsonb NOT NULL DEFAULT '[]'::jsonb,
  mapping_version integer,
  source_code text,
  source_release text,
  change_details jsonb NOT NULL DEFAULT '{}'::jsonb,
  reason text,
  decided_by uuid,
  decided_by_name text,
  decided_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS qualification_mapping_approvals_qual_idx
  ON public.qualification_mapping_approvals (qualification_id, decided_at DESC);
ALTER TABLE public.qualification_mapping_approvals ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.qualification_mapping_approvals FROM PUBLIC, anon, authenticated;
GRANT SELECT ON TABLE public.qualification_mapping_approvals TO authenticated;
DROP POLICY IF EXISTS qualification_mapping_approvals_org_select ON public.qualification_mapping_approvals;
CREATE POLICY qualification_mapping_approvals_org_select ON public.qualification_mapping_approvals
  FOR SELECT TO authenticated
  USING (organisation_id = public.current_organisation_id() AND public.can_access_qualification(qualification_id, false));

CREATE OR REPLACE FUNCTION public.qualification_requirements_snapshot(p_qualification_id uuid)
RETURNS jsonb LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public AS $$
  SELECT coalesce(jsonb_agg(jsonb_build_object('acsf_skill', r.acsf_skill, 'domain', r.domain,
                                                'minimum_acsf_level', r.minimum_acsf_level)
                            ORDER BY lower(coalesce(r.acsf_skill, r.domain)), r.minimum_acsf_level), '[]'::jsonb)
  FROM public.qualification_lln_requirements r WHERE r.qualification_id = p_qualification_id
$$;
REVOKE ALL ON FUNCTION public.qualification_requirements_snapshot(uuid) FROM PUBLIC, anon, authenticated;

-- Administration approves the CURRENT ACSF levels for one of its own
-- qualifications. Clears a recorded training.gov.au change; keeps history.
CREATE OR REPLACE FUNCTION public.approve_qualification_mapping(p_qualification_id uuid, p_source_release text, p_note text)
RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE q record; snap jsonb; reviewer text; new_id uuid;
BEGIN
  IF NOT public.can_access_qualification(p_qualification_id, true) THEN
    RAISE EXCEPTION 'Administration access to this qualification is required';
  END IF;
  SELECT * INTO q FROM public.qualifications WHERE id = p_qualification_id;
  snap := public.qualification_requirements_snapshot(p_qualification_id);
  IF jsonb_array_length(snap) = 0 THEN
    RAISE EXCEPTION 'set the ACSF levels before approving this mapping';
  END IF;
  SELECT coalesce(nullif(p.full_name, ''), p.email, 'RTO staff') INTO reviewer FROM public.profiles p WHERE p.id = auth.uid();
  INSERT INTO public.qualification_mapping_approvals
    (organisation_id, qualification_id, decision, requirements_snapshot, mapping_version,
     source_code, source_release, change_details, reason, decided_by, decided_by_name)
  VALUES (q.organisation_id, q.id, 'approved', snap, q.mapping_version, q.code,
          coalesce(nullif(trim(p_source_release), ''), q.source_release),
          coalesce(q.mapping_change_summary, '{}'::jsonb), nullif(trim(p_note), ''), auth.uid(), reviewer)
  RETURNING id INTO new_id;
  PERFORM set_config('llnd.mapping_source_update', 'on', true);
  UPDATE public.qualifications SET
    reviewed_at = now(), reviewed_by = reviewer,
    source_release = coalesce(nullif(trim(p_source_release), ''), source_release),
    mapping_change_detected_at = NULL, mapping_change_summary = NULL,
    source_check_status = CASE WHEN source_check_status = 'changed' THEN 'unchecked' ELSE source_check_status END,
    mapping_status = CASE WHEN mapping_status IN ('review_required', 'mapping_required')
                          THEN CASE WHEN mapping_source = 'custom' THEN 'custom_mapping' ELSE 'default_mapping_applied' END
                          ELSE mapping_status END,
    needs_review = false, review_reason = NULL
  WHERE id = p_qualification_id;
  PERFORM set_config('llnd.mapping_source_update', 'off', true);
  RETURN new_id;
END $$;
REVOKE ALL ON FUNCTION public.approve_qualification_mapping(uuid, text, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.approve_qualification_mapping(uuid, text, text) TO authenticated;

-- Server-only: records the outcome of a training.gov.au check for ONE
-- qualification. 'changed' flags the mapping for review (approval no longer
-- applies; levels untouched). 'unavailable' records the failed check and
-- never clears a flag or marks the qualification current.
CREATE OR REPLACE FUNCTION public.record_qualification_source_check(p_qualification_id uuid, p_status text, p_details jsonb)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE q record;
BEGIN
  IF p_status NOT IN ('current', 'changed', 'unavailable') THEN RAISE EXCEPTION 'unknown source check status %', p_status; END IF;
  SELECT * INTO q FROM public.qualifications WHERE id = p_qualification_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'qualification not found'; END IF;
  PERFORM set_config('llnd.mapping_source_update', 'on', true);
  IF p_status = 'changed' THEN
    UPDATE public.qualifications SET source_check_status = 'changed', source_checked_at = now(),
      mapping_change_detected_at = coalesce(mapping_change_detected_at, now()),
      mapping_change_summary = coalesce(p_details, '{}'::jsonb)
    WHERE id = p_qualification_id;
    INSERT INTO public.qualification_mapping_approvals
      (organisation_id, qualification_id, decision, requirements_snapshot, mapping_version, source_code,
       source_release, change_details, reason, decided_by_name)
    VALUES (q.organisation_id, q.id, 'review_required', public.qualification_requirements_snapshot(q.id),
            q.mapping_version, q.code, q.source_release, coalesce(p_details, '{}'::jsonb),
            'training.gov.au change detected', 'LLND Automate (training.gov.au check)');
  ELSIF p_status = 'current' THEN
    UPDATE public.qualifications SET source_checked_at = now(),
      source_check_status = CASE WHEN mapping_change_detected_at IS NULL THEN 'current' ELSE 'changed' END
    WHERE id = p_qualification_id;
  ELSE
    UPDATE public.qualifications SET source_checked_at = now(),
      source_check_status = CASE WHEN mapping_change_detected_at IS NULL THEN 'unavailable' ELSE 'changed' END
    WHERE id = p_qualification_id;
  END IF;
  PERFORM set_config('llnd.mapping_source_update', 'off', true);
END $$;
REVOKE ALL ON FUNCTION public.record_qualification_source_check(uuid, text, jsonb) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.record_qualification_source_check(uuid, text, jsonb) TO service_role;

-- Staff can't clear a recorded change or fake a source check by editing the
-- qualification directly; only the two functions above change these columns.
CREATE OR REPLACE FUNCTION public.protect_qualification_source_columns()
RETURNS trigger LANGUAGE plpgsql SET search_path = pg_catalog, public AS $$
BEGIN
  IF auth.uid() IS NOT NULL AND coalesce(current_setting('llnd.mapping_source_update', true), 'off') <> 'on'
     AND (NEW.source_check_status IS DISTINCT FROM OLD.source_check_status
          OR NEW.source_checked_at IS DISTINCT FROM OLD.source_checked_at
          OR NEW.mapping_change_detected_at IS DISTINCT FROM OLD.mapping_change_detected_at
          OR NEW.mapping_change_summary IS DISTINCT FROM OLD.mapping_change_summary) THEN
    RAISE EXCEPTION 'training.gov.au check fields are recorded by LLND Automate; approve the mapping to clear a change';
  END IF;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS protect_qualification_source_columns ON public.qualifications;
CREATE TRIGGER protect_qualification_source_columns BEFORE UPDATE ON public.qualifications
  FOR EACH ROW EXECUTE FUNCTION public.protect_qualification_source_columns();

-- Existing reviewed mappings keep their approval (provenance recorded).
INSERT INTO public.qualification_mapping_approvals
  (organisation_id, qualification_id, decision, requirements_snapshot, mapping_version, source_code,
   reason, decided_by_name, decided_at)
SELECT q.organisation_id, q.id, 'migrated_approval', public.qualification_requirements_snapshot(q.id),
       q.mapping_version, q.code, 'Approval carried over from the existing reviewed date',
       q.reviewed_by, q.reviewed_at
FROM public.qualifications q
WHERE q.reviewed_at IS NOT NULL AND q.organisation_id IS NOT NULL
  AND q.mapping_status IN ('default_mapping_applied', 'custom_mapping')
  AND jsonb_array_length(public.qualification_requirements_snapshot(q.id)) > 0
  AND NOT EXISTS (SELECT 1 FROM public.qualification_mapping_approvals a WHERE a.qualification_id = q.id);

-- ── 4. Result integrity on the candidate token path ──────────────────────
-- Completion times are stamped by the database, not the browser, and a
-- completed module's result can't be changed through the token link.
CREATE OR REPLACE FUNCTION public.protect_assessment_result_integrity()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
BEGIN
  IF coalesce(public.get_quiz_token(), '') = '' THEN RETURN NEW; END IF;
  IF OLD.lln_status = 'completed' AND (NEW.lln_status IS DISTINCT FROM OLD.lln_status
       OR NEW.lln_acsf_outcomes IS DISTINCT FROM OLD.lln_acsf_outcomes
       OR NEW.lln_completed_at IS DISTINCT FROM OLD.lln_completed_at) THEN
    RAISE EXCEPTION 'a completed LLN result cannot be changed';
  END IF;
  IF OLD.digital_status = 'completed' AND (NEW.digital_status IS DISTINCT FROM OLD.digital_status
       OR NEW.digital_score IS DISTINCT FROM OLD.digital_score
       OR NEW.digital_completed_at IS DISTINCT FROM OLD.digital_completed_at) THEN
    RAISE EXCEPTION 'a completed Digital result cannot be changed';
  END IF;
  IF NEW.lln_status = 'completed' AND OLD.lln_status IS DISTINCT FROM 'completed' THEN NEW.lln_completed_at := now(); END IF;
  IF NEW.digital_status = 'completed' AND OLD.digital_status IS DISTINCT FROM 'completed' THEN NEW.digital_completed_at := now(); END IF;
  IF NEW.lln_status IS DISTINCT FROM 'completed' THEN NEW.lln_completed_at := OLD.lln_completed_at; END IF;
  IF NEW.digital_status IS DISTINCT FROM 'completed' THEN NEW.digital_completed_at := OLD.digital_completed_at; END IF;
  IF NEW.status = 'completed' AND OLD.status IS DISTINCT FROM 'completed' THEN NEW.completed_at := now(); END IF;
  RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION public.protect_assessment_result_integrity() FROM PUBLIC;
DROP TRIGGER IF EXISTS protect_assessment_result_integrity ON public.assessment_invitations;
CREATE TRIGGER protect_assessment_result_integrity BEFORE UPDATE ON public.assessment_invitations
  FOR EACH ROW EXECUTE FUNCTION public.protect_assessment_result_integrity();

COMMIT;
