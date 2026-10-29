-- Completion outcome "requirements_not_confirmed".
--
-- When a completed assessment can't be compared with an APPROVED course
-- requirement (mapping not approved or changed, no LLN requirements, Digital
-- pass mark missing, no scores), on-assessment-complete records
-- "requirements_not_confirmed" instead of guessing with a fallback level.
-- Like the other non-"suitable" outcomes, it opens an unassigned support
-- case so RTO staff review it. Nothing is reissued or enrolled.
--
-- Forward-only. Requires Issue #40 (create_support_case_from_outcome) and
-- the assessment-result-validity migration (mapping approvals).

BEGIN;

DO $$
BEGIN
  IF to_regprocedure('public.create_support_case_from_outcome()') IS NULL THEN
    RAISE EXCEPTION 'Preflight: Issue #40 support-case trigger function is missing';
  END IF;
  IF to_regclass('public.qualification_mapping_approvals') IS NULL THEN
    RAISE EXCEPTION 'Preflight: assessment-result-validity migration 20261029090000 is not installed';
  END IF;
END $$;

-- Replace whichever CHECK currently limits course_recommendation.
DO $$
DECLARE c record;
BEGIN
  FOR c IN
    SELECT con.conname FROM pg_constraint con
    WHERE con.conrelid = 'public.assessment_invitations'::regclass AND con.contype = 'c'
      AND pg_get_constraintdef(con.oid) ILIKE '%course_recommendation%'
  LOOP
    EXECUTE format('ALTER TABLE public.assessment_invitations DROP CONSTRAINT %I', c.conname);
  END LOOP;
END $$;
ALTER TABLE public.assessment_invitations ADD CONSTRAINT assessment_invitations_course_recommendation_check
  CHECK (course_recommendation IS NULL OR course_recommendation IN
         ('suitable', 'suitable_with_support', 'not_yet_suitable', 'requirements_not_confirmed'));

CREATE OR REPLACE FUNCTION public.create_support_case_from_outcome()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
BEGIN
  IF NEW.course_recommendation IN ('suitable_with_support','not_yet_suitable','requirements_not_confirmed')
     AND NEW.organisation_id IS NOT NULL THEN
    INSERT INTO public.support_cases (organisation_id, invitation_id, student_id)
    VALUES (NEW.organisation_id, NEW.id, NEW.student_id)
    ON CONFLICT (invitation_id) DO NOTHING;
  END IF;
  RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION public.create_support_case_from_outcome() FROM PUBLIC;

COMMIT;
