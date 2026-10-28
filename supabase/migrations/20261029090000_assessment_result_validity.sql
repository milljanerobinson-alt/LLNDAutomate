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
  ADD COLUMN IF NOT EXISTS validity_checks jsonb NOT NULL DEFAULT '[]'::jsonb;

-- Existing rows keep validated_at NULL on purpose: the sync re-checks them
-- once, judged at their original decision time (created_at).

ALTER TABLE public.axcelerate_inbound_sync_log DROP CONSTRAINT IF EXISTS axcelerate_inbound_sync_log_status_check;
ALTER TABLE public.axcelerate_inbound_sync_log ADD CONSTRAINT axcelerate_inbound_sync_log_status_check
  CHECK (status IN ('pending', 'processing', 'skipped', 'created', 'failed', 'cancelled', 'review_required', 'error'));

ALTER TABLE public.axcelerate_inbound_sync_log DROP CONSTRAINT IF EXISTS axcelerate_inbound_sync_log_assessment_type_check;
ALTER TABLE public.axcelerate_inbound_sync_log ADD CONSTRAINT axcelerate_inbound_sync_log_assessment_type_check
  CHECK (assessment_type IN ('lln', 'digital', 'both', 'none', 'error'));

CREATE INDEX IF NOT EXISTS axcelerate_inbound_sync_log_org_status_idx
  ON public.axcelerate_inbound_sync_log (organisation_id, status);

COMMIT;
