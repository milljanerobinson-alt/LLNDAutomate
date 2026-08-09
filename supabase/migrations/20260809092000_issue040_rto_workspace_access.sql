/* Issue #40 — RTO workspace access, tenancy and support-case foundation.

   The current aXcelerate implementation stores contact, enrolment and course IDs,
   but does not store a trainer/assessor relationship. Automated assignment is
   therefore intentionally disabled: support cases are created unassigned until
   Administration assigns them. The nullable provenance columns below are the
   integration boundary for a future verified aXcelerate relationship.
*/

BEGIN;

CREATE TABLE IF NOT EXISTS organisations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text NOT NULL DEFAULT 'My RTO',
  created_by uuid REFERENCES auth.users(id),
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS organisation_memberships (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organisation_id uuid NOT NULL REFERENCES organisations(id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('invited','active','inactive')),
  invited_email text,
  invited_by uuid REFERENCES auth.users(id),
  activated_at timestamptz,
  deactivated_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (organisation_id, user_id)
);

-- Issue #40 intentionally supports one RTO per user. Remove this invariant only
-- with a future explicit active-organisation design.
CREATE UNIQUE INDEX IF NOT EXISTS organisation_memberships_one_rto_per_user
  ON organisation_memberships(user_id);

CREATE TABLE IF NOT EXISTS staff_invitation_grants (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  invited_email text NOT NULL,
  full_name text NOT NULL DEFAULT '',
  organisation_id uuid NOT NULL REFERENCES organisations(id) ON DELETE CASCADE,
  approved_workspaces text[] NOT NULL,
  invited_by uuid NOT NULL REFERENCES auth.users(id),
  user_id uuid UNIQUE REFERENCES auth.users(id) ON DELETE SET NULL,
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','accepted','cancelled')),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  accepted_at timestamptz,
  UNIQUE (organisation_id, invited_email)
);
ALTER TABLE staff_invitation_grants ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE staff_invitation_grants FROM anon, authenticated;

ALTER TABLE profiles ADD COLUMN IF NOT EXISTS organisation_id uuid REFERENCES organisations(id);
ALTER TABLE profiles ADD COLUMN IF NOT EXISTS is_active boolean NOT NULL DEFAULT true;
ALTER TABLE user_workspace_access ADD COLUMN IF NOT EXISTS organisation_id uuid REFERENCES organisations(id);

-- Replace legacy workspace identifiers without removing historical rows.
ALTER TABLE user_workspace_access DROP CONSTRAINT IF EXISTS user_workspace_access_workspace_check;
UPDATE user_workspace_access SET workspace = CASE workspace
  WHEN 'assessment' THEN 'administration'
  WHEN 'trainer' THEN 'candidate_support'
  WHEN 'platform_admin' THEN 'technical'
  ELSE workspace END;
ALTER TABLE user_workspace_access ADD CONSTRAINT user_workspace_access_workspace_check
  CHECK (workspace IN ('administration','candidate_support','technical'));

-- Preflight the legacy single-RTO bridge. Existing data can be assigned only
-- when there is exactly one deterministic legacy organisation.
DO $$
DECLARE org_id uuid; org_count integer; orphan_access integer;
BEGIN
  SELECT count(*) INTO org_count FROM organisations;
  IF org_count > 1 THEN
    RAISE EXCEPTION 'Issue #40 preflight: multiple organisations exist; legacy ownership is ambiguous';
  END IF;
  SELECT count(*) INTO orphan_access FROM user_workspace_access w
    WHERE NOT EXISTS (SELECT 1 FROM profiles p WHERE p.id=w.user_id);
  IF orphan_access > 0 THEN
    RAISE EXCEPTION 'Issue #40 preflight: % orphan workspace access rows require reconciliation', orphan_access;
  END IF;
  SELECT id INTO org_id FROM organisations;
  IF org_count = 0 THEN
    INSERT INTO organisations (name, created_by)
    SELECT 'Existing RTO', id FROM profiles ORDER BY created_at LIMIT 1
    RETURNING id INTO org_id;
  END IF;
  UPDATE profiles SET organisation_id = org_id WHERE organisation_id IS NULL;
  UPDATE user_workspace_access uwa SET organisation_id = p.organisation_id
    FROM profiles p WHERE uwa.user_id = p.id AND uwa.organisation_id IS NULL;
  INSERT INTO organisation_memberships (organisation_id, user_id, status, activated_at)
    SELECT p.organisation_id, p.id, 'active', now() FROM profiles p
    WHERE p.organisation_id IS NOT NULL
    ON CONFLICT (organisation_id, user_id) DO NOTHING;

  -- Preserve the legacy administrator contract even if historical workspace
  -- rows are incomplete: current active administrators receive all three
  -- approved customer workspaces.
  INSERT INTO user_workspace_access (organisation_id,user_id,workspace,is_primary)
  SELECT p.organisation_id,p.id,w.workspace,(w.workspace='administration')
  FROM profiles p CROSS JOIN (VALUES ('administration'),('candidate_support'),('technical')) AS w(workspace)
  WHERE p.role='admin' AND p.organisation_id IS NOT NULL
  ON CONFLICT (user_id,workspace) DO UPDATE SET organisation_id=EXCLUDED.organisation_id;

  IF EXISTS (SELECT 1 FROM profiles) AND NOT EXISTS (
    SELECT 1 FROM organisation_memberships m
    JOIN profiles p ON p.id=m.user_id AND p.is_active
    JOIN user_workspace_access w ON w.user_id=m.user_id AND w.organisation_id=m.organisation_id
    WHERE m.organisation_id=org_id AND m.status='active' AND w.workspace='administration'
  ) THEN
    RAISE EXCEPTION 'Issue #40 preflight: migration would leave the RTO without an active Administration user';
  END IF;
END $$;

ALTER TABLE user_workspace_access ALTER COLUMN organisation_id SET NOT NULL;

CREATE OR REPLACE FUNCTION public.current_organisation_id()
RETURNS uuid LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public AS $$
  SELECT m.organisation_id FROM public.organisation_memberships m
  WHERE m.user_id = auth.uid() AND m.status = 'active'
$$;
REVOKE ALL ON FUNCTION public.current_organisation_id() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.current_organisation_id() TO authenticated;

CREATE OR REPLACE FUNCTION public.has_workspace_access(required_workspace text)
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public AS $$
  SELECT EXISTS (
    SELECT 1 FROM public.organisation_memberships m
    JOIN public.profiles p ON p.id = m.user_id AND p.is_active
    JOIN public.user_workspace_access w ON w.user_id = m.user_id
      AND w.organisation_id = m.organisation_id
    WHERE m.user_id = auth.uid() AND m.status = 'active'
      AND w.workspace = required_workspace
  )
$$;
REVOKE ALL ON FUNCTION public.has_workspace_access(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.has_workspace_access(text) TO authenticated;

ALTER TABLE organisations ENABLE ROW LEVEL SECURITY;
ALTER TABLE organisation_memberships ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS organisations_member_select ON organisations;
CREATE POLICY organisations_member_select ON organisations FOR SELECT TO authenticated
  USING (id = current_organisation_id());
DROP POLICY IF EXISTS organisations_admin_update ON organisations;
CREATE POLICY organisations_admin_update ON organisations FOR UPDATE TO authenticated
  USING (id = current_organisation_id() AND has_workspace_access('administration'))
  WITH CHECK (id = current_organisation_id() AND has_workspace_access('administration'));
DROP POLICY IF EXISTS memberships_org_select ON organisation_memberships;
CREATE POLICY memberships_org_select ON organisation_memberships FOR SELECT TO authenticated
  USING (organisation_id = current_organisation_id() AND
    (user_id = auth.uid() OR has_workspace_access('administration')));

DROP POLICY IF EXISTS select_own_workspace_access ON user_workspace_access;
DROP POLICY IF EXISTS insert_own_workspace_access ON user_workspace_access;
DROP POLICY IF EXISTS update_own_workspace_access ON user_workspace_access;
DROP POLICY IF EXISTS delete_own_workspace_access ON user_workspace_access;
CREATE POLICY workspace_access_org_select ON user_workspace_access FOR SELECT TO authenticated
  USING (organisation_id = current_organisation_id() AND
    (user_id = auth.uid() OR has_workspace_access('administration')));

-- Add tenant ownership to candidate-domain roots.
ALTER TABLE students ADD COLUMN IF NOT EXISTS organisation_id uuid REFERENCES organisations(id);
ALTER TABLE enrolments ADD COLUMN IF NOT EXISTS organisation_id uuid REFERENCES organisations(id);
ALTER TABLE assessment_invitations ADD COLUMN IF NOT EXISTS organisation_id uuid REFERENCES organisations(id);
DO $$
DECLARE bridge_org uuid; unresolved integer; candidate_rows bigint;
BEGIN
  SELECT (SELECT count(*) FROM students) + (SELECT count(*) FROM enrolments) +
    (SELECT count(*) FROM assessment_invitations) INTO candidate_rows;
  IF candidate_rows > 0 AND (SELECT count(*) FROM organisations) <> 1 THEN
    RAISE EXCEPTION 'Issue #40 backfill: existing candidate data requires exactly one legacy organisation';
  END IF;
  IF candidate_rows > 0 THEN SELECT id INTO STRICT bridge_org FROM organisations; END IF;
  UPDATE students SET organisation_id=bridge_org WHERE organisation_id IS NULL;
  UPDATE enrolments e SET organisation_id=s.organisation_id FROM students s
    WHERE e.student_id=s.id AND e.organisation_id IS NULL;
  UPDATE assessment_invitations i SET organisation_id=s.organisation_id FROM students s
    WHERE i.student_id=s.id AND i.organisation_id IS NULL;
  -- Legacy invitations may pre-date student linking. With exactly one verified
  -- legacy organisation their ownership is deterministic.
  UPDATE assessment_invitations SET organisation_id=bridge_org WHERE organisation_id IS NULL;
  SELECT count(*) INTO unresolved FROM students WHERE organisation_id IS NULL;
  unresolved := unresolved + (SELECT count(*) FROM enrolments WHERE organisation_id IS NULL);
  unresolved := unresolved + (SELECT count(*) FROM assessment_invitations WHERE organisation_id IS NULL);
  IF unresolved > 0 THEN
    RAISE EXCEPTION 'Issue #40 backfill: % candidate root rows have unresolved organisation ownership', unresolved;
  END IF;
END $$;

ALTER TABLE students ALTER COLUMN organisation_id SET NOT NULL;
ALTER TABLE enrolments ALTER COLUMN organisation_id SET NOT NULL;
ALTER TABLE assessment_invitations ALTER COLUMN organisation_id SET NOT NULL;

CREATE OR REPLACE FUNCTION public.set_candidate_organisation()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE resolved uuid; candidate uuid;
BEGIN
  resolved := public.current_organisation_id();
  IF TG_TABLE_NAME='enrolments' AND NEW.student_id IS NOT NULL THEN
    SELECT s.organisation_id INTO candidate FROM public.students s WHERE s.id=NEW.student_id;
  ELSIF TG_TABLE_NAME='assessment_invitations' AND NEW.student_id IS NOT NULL THEN
    SELECT s.organisation_id INTO candidate FROM public.students s WHERE s.id=NEW.student_id;
  END IF;
  IF candidate IS NOT NULL THEN
    IF resolved IS NOT NULL AND resolved<>candidate THEN RAISE EXCEPTION 'cross-organisation candidate write denied'; END IF;
    resolved := candidate;
  END IF;
  IF resolved IS NULL AND (SELECT count(*) FROM public.organisations)=1 THEN
    SELECT id INTO resolved FROM public.organisations;
  END IF;
  IF resolved IS NULL THEN RAISE EXCEPTION 'organisation ownership cannot be resolved safely'; END IF;
  IF NEW.organisation_id IS NOT NULL AND NEW.organisation_id<>resolved THEN
    RAISE EXCEPTION 'client-supplied organisation ownership does not match trusted context';
  END IF;
  NEW.organisation_id := resolved;
  RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION public.set_candidate_organisation() FROM PUBLIC;
DROP TRIGGER IF EXISTS issue040_student_org ON students;
CREATE TRIGGER issue040_student_org BEFORE INSERT ON students FOR EACH ROW EXECUTE FUNCTION public.set_candidate_organisation();
DROP TRIGGER IF EXISTS issue040_enrolment_org ON enrolments;
CREATE TRIGGER issue040_enrolment_org BEFORE INSERT ON enrolments FOR EACH ROW EXECUTE FUNCTION public.set_candidate_organisation();
DROP TRIGGER IF EXISTS issue040_invitation_org ON assessment_invitations;
CREATE TRIGGER issue040_invitation_org BEFORE INSERT ON assessment_invitations FOR EACH ROW EXECUTE FUNCTION public.set_candidate_organisation();

CREATE TABLE IF NOT EXISTS support_cases (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organisation_id uuid NOT NULL REFERENCES organisations(id) ON DELETE CASCADE,
  invitation_id uuid NOT NULL UNIQUE REFERENCES assessment_invitations(id) ON DELETE CASCADE,
  student_id uuid REFERENCES students(id) ON DELETE SET NULL,
  status text NOT NULL DEFAULT 'open' CHECK (status IN ('open','awaiting_review','resolved')),
  assigned_user_id uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  assignment_source text NOT NULL DEFAULT 'unassigned' CHECK (assignment_source IN ('unassigned','administration','axcelerate')),
  axcelerate_trainer_contact_id numeric,
  axcelerate_relationship_source text,
  assigned_by uuid REFERENCES auth.users(id),
  assigned_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE support_cases ENABLE ROW LEVEL SECURITY;

CREATE OR REPLACE FUNCTION public.can_access_support_case(case_org uuid, assignee uuid)
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public AS $$
  SELECT case_org = public.current_organisation_id() AND (
    public.has_workspace_access('administration') OR
    (public.has_workspace_access('candidate_support') AND (assignee = auth.uid() OR assignee IS NULL))
  )
$$;
REVOKE ALL ON FUNCTION public.can_access_support_case(uuid,uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.can_access_support_case(uuid,uuid) TO authenticated;

CREATE POLICY support_case_scoped_select ON support_cases FOR SELECT TO authenticated
  USING (can_access_support_case(organisation_id, assigned_user_id));
CREATE POLICY support_case_admin_insert ON support_cases FOR INSERT TO authenticated
  WITH CHECK (organisation_id = current_organisation_id() AND has_workspace_access('administration'));
CREATE POLICY support_case_admin_update ON support_cases FOR UPDATE TO authenticated
  USING (organisation_id = current_organisation_id() AND has_workspace_access('administration'))
  WITH CHECK (organisation_id = current_organisation_id() AND has_workspace_access('administration'));

CREATE OR REPLACE FUNCTION public.validate_support_case_assignment()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
BEGIN
  IF NEW.assigned_user_id IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM public.organisation_memberships m
    JOIN public.profiles p ON p.id = m.user_id AND p.is_active
    JOIN public.user_workspace_access w ON w.user_id = m.user_id AND w.organisation_id = m.organisation_id
    WHERE m.organisation_id = NEW.organisation_id AND m.user_id = NEW.assigned_user_id
      AND m.status = 'active' AND w.workspace = 'candidate_support'
  ) THEN
    RAISE EXCEPTION 'support assignee must be an active Candidate Support user in this organisation';
  END IF;
  IF NEW.assigned_user_id IS DISTINCT FROM OLD.assigned_user_id THEN
    NEW.assignment_source := CASE WHEN NEW.assigned_user_id IS NULL THEN 'unassigned' ELSE 'administration' END;
    NEW.assigned_by := auth.uid();
    NEW.assigned_at := CASE WHEN NEW.assigned_user_id IS NULL THEN NULL ELSE now() END;
  END IF;
  NEW.updated_at := now();
  RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION public.validate_support_case_assignment() FROM PUBLIC;
DROP TRIGGER IF EXISTS issue040_validate_support_assignment ON support_cases;
CREATE TRIGGER issue040_validate_support_assignment BEFORE UPDATE OF assigned_user_id ON support_cases
  FOR EACH ROW EXECUTE FUNCTION public.validate_support_case_assignment();

-- Reuse existing outcome logic: a support outcome creates an unassigned case.
CREATE OR REPLACE FUNCTION public.create_support_case_from_outcome()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
BEGIN
  IF NEW.course_recommendation IN ('suitable_with_support','not_yet_suitable')
     AND NEW.organisation_id IS NOT NULL THEN
    INSERT INTO public.support_cases (organisation_id, invitation_id, student_id)
    VALUES (NEW.organisation_id, NEW.id, NEW.student_id)
    ON CONFLICT (invitation_id) DO NOTHING;
  END IF;
  RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION public.create_support_case_from_outcome() FROM PUBLIC;
DROP TRIGGER IF EXISTS issue040_support_outcome ON assessment_invitations;
CREATE TRIGGER issue040_support_outcome AFTER INSERT OR UPDATE OF course_recommendation
  ON assessment_invitations FOR EACH ROW EXECUTE FUNCTION public.create_support_case_from_outcome();

-- Organisation-scoped candidate visibility. Candidate Support is mediated by
-- support_cases; Technical has no policy granting general candidate access.
DROP POLICY IF EXISTS students_select_staff ON students;
CREATE POLICY students_workspace_select ON students FOR SELECT TO authenticated USING (
  organisation_id = current_organisation_id() AND (
    has_workspace_access('administration') OR
    (has_workspace_access('candidate_support') AND EXISTS (
      SELECT 1 FROM support_cases sc WHERE sc.student_id = students.id
      AND can_access_support_case(sc.organisation_id, sc.assigned_user_id)
    ))
  )
);
DROP POLICY IF EXISTS invitations_select_staff ON assessment_invitations;
CREATE POLICY invitations_workspace_select ON assessment_invitations FOR SELECT TO authenticated USING (
  organisation_id = current_organisation_id() AND (
    has_workspace_access('administration') OR
    (has_workspace_access('candidate_support') AND EXISTS (
      SELECT 1 FROM support_cases sc WHERE sc.invitation_id = assessment_invitations.id
      AND can_access_support_case(sc.organisation_id, sc.assigned_user_id)
    ))
  )
);

-- Remove legacy role-wide staff access. Public token policies created by the
-- token-hardening migrations remain intact and continue to require the token
-- header used by unauthenticated assessment flows.
DROP POLICY IF EXISTS "profiles_select_staff" ON profiles;
DROP POLICY IF EXISTS "profiles_update_admin" ON profiles;
CREATE POLICY profiles_organisation_admin_select ON profiles FOR SELECT TO authenticated USING (
  id = auth.uid() OR (organisation_id = current_organisation_id() AND has_workspace_access('administration'))
);
CREATE POLICY profiles_organisation_admin_update ON profiles FOR UPDATE TO authenticated USING (
  organisation_id = current_organisation_id() AND has_workspace_access('administration')
) WITH CHECK (organisation_id = current_organisation_id() AND has_workspace_access('administration'));
-- Self-service profile edits cannot change role, tenant or activation state.
REVOKE UPDATE ON TABLE profiles FROM authenticated;
GRANT UPDATE (full_name,avatar_url) ON profiles TO authenticated;

DROP POLICY IF EXISTS "students_select_staff" ON students;
DROP POLICY IF EXISTS "students_insert_staff" ON students;
DROP POLICY IF EXISTS "students_update_staff" ON students;
DROP POLICY IF EXISTS "students_delete_staff" ON students;
CREATE POLICY students_admin_insert ON students FOR INSERT TO authenticated
  WITH CHECK (organisation_id = current_organisation_id() AND has_workspace_access('administration'));
CREATE POLICY students_admin_update ON students FOR UPDATE TO authenticated
  USING (organisation_id = current_organisation_id() AND has_workspace_access('administration'))
  WITH CHECK (organisation_id = current_organisation_id() AND has_workspace_access('administration'));
CREATE POLICY students_admin_delete ON students FOR DELETE TO authenticated
  USING (organisation_id = current_organisation_id() AND has_workspace_access('administration'));

DROP POLICY IF EXISTS "invitations_select_staff" ON assessment_invitations;
DROP POLICY IF EXISTS "invitations_insert_staff" ON assessment_invitations;
DROP POLICY IF EXISTS "invitations_update_staff" ON assessment_invitations;
DROP POLICY IF EXISTS "invitations_delete_staff" ON assessment_invitations;
CREATE POLICY invitations_admin_insert ON assessment_invitations FOR INSERT TO authenticated
  WITH CHECK (organisation_id = current_organisation_id() AND has_workspace_access('administration'));
CREATE POLICY invitations_admin_update ON assessment_invitations FOR UPDATE TO authenticated
  USING (organisation_id = current_organisation_id() AND has_workspace_access('administration'))
  WITH CHECK (organisation_id = current_organisation_id() AND has_workspace_access('administration'));
CREATE POLICY invitations_admin_delete ON assessment_invitations FOR DELETE TO authenticated
  USING (organisation_id = current_organisation_id() AND has_workspace_access('administration'));

-- RLS determines which token-owned row is writable; column privileges determine
-- what a no-login candidate may change. Ownership, tenant, creator, assignment,
-- contact and recommendation fields remain unavailable to anon.
REVOKE UPDATE ON TABLE assessment_invitations FROM anon;
GRANT UPDATE (
  status, opened_at, started_at, completed_at, progress_percent,
  identity_verified, identity_verification_method, identity_verified_at,
  lln_status, lln_acsf_outcomes, lln_completed_at,
  digital_status, digital_score, digital_completed_at
) ON assessment_invitations TO anon;
GRANT UPDATE ON assessment_invitations TO authenticated;

REVOKE UPDATE ON TABLE invitation_assessments FROM anon;
REVOKE INSERT ON TABLE invitation_assessments FROM anon;
GRANT UPDATE (
  individual_status, individual_score, individual_passed,
  individual_completed_at, acsf_outcomes
) ON invitation_assessments TO anon;
GRANT UPDATE ON invitation_assessments TO authenticated;

REVOKE UPDATE ON TABLE assessment_responses FROM anon;
GRANT UPDATE (answer, submitted_at) ON assessment_responses TO anon;
GRANT UPDATE ON assessment_responses TO authenticated;
REVOKE INSERT ON TABLE assessment_responses FROM anon;
GRANT INSERT (invitation_id,assessment_id,question_id,question_version,answer,submitted_at)
  ON assessment_responses TO anon;

REVOKE INSERT ON TABLE student_responses FROM anon;
GRANT INSERT (invitation_id,assessment_type,question_id,section,acsf_level_attempted,answer,is_correct,submitted_at)
  ON student_responses TO anon;

-- Column grants protect anon traffic. This trigger also protects the token path
-- when a browser happens to carry an authenticated session, because permissive
-- RLS policies are OR-combined and authenticated staff otherwise have broader
-- table privileges.
CREATE OR REPLACE FUNCTION public.enforce_candidate_token_update_boundary()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE allowed text[];
BEGIN
  IF coalesce(public.get_quiz_token(),'')='' THEN RETURN NEW; END IF;
  allowed := CASE TG_TABLE_NAME
    WHEN 'assessment_invitations' THEN ARRAY[
      'status','opened_at','started_at','completed_at','progress_percent',
      'identity_verified','identity_verification_method','identity_verified_at',
      'lln_status','lln_acsf_outcomes','lln_completed_at',
      'digital_status','digital_score','digital_completed_at'
    ]
    WHEN 'invitation_assessments' THEN ARRAY[
      'individual_status','individual_score','individual_passed','individual_completed_at','acsf_outcomes'
    ]
    WHEN 'assessment_responses' THEN ARRAY['answer','submitted_at']
    ELSE ARRAY[]::text[]
  END;
  IF (to_jsonb(NEW)-allowed) IS DISTINCT FROM (to_jsonb(OLD)-allowed) THEN
    RAISE EXCEPTION 'assessment token cannot modify tenant, ownership or structural fields';
  END IF;
  RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION public.enforce_candidate_token_update_boundary() FROM PUBLIC;
DROP TRIGGER IF EXISTS issue040_token_invitation_update_boundary ON assessment_invitations;
CREATE TRIGGER issue040_token_invitation_update_boundary BEFORE UPDATE ON assessment_invitations
  FOR EACH ROW EXECUTE FUNCTION public.enforce_candidate_token_update_boundary();
DROP TRIGGER IF EXISTS issue040_token_assessment_update_boundary ON invitation_assessments;
CREATE TRIGGER issue040_token_assessment_update_boundary BEFORE UPDATE ON invitation_assessments
  FOR EACH ROW EXECUTE FUNCTION public.enforce_candidate_token_update_boundary();
DROP TRIGGER IF EXISTS issue040_token_response_update_boundary ON assessment_responses;
CREATE TRIGGER issue040_token_response_update_boundary BEFORE UPDATE ON assessment_responses
  FOR EACH ROW EXECUTE FUNCTION public.enforce_candidate_token_update_boundary();

CREATE OR REPLACE FUNCTION public.validate_candidate_token_response_insert()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE token text:=public.get_quiz_token();
BEGIN
  IF token IS NULL OR token='' THEN RETURN NEW; END IF;
  IF TG_TABLE_NAME='assessment_responses' AND NOT EXISTS (
    SELECT 1 FROM public.invitation_assessments ia
    JOIN public.assessment_questions q ON q.id=NEW.question_id AND q.assessment_id=NEW.assessment_id
    WHERE ia.invitation_id=NEW.invitation_id AND ia.assessment_id=NEW.assessment_id
  ) THEN RAISE EXCEPTION 'assessment response does not belong to the token assessment';
  ELSIF TG_TABLE_NAME='student_responses' AND NOT EXISTS (
    SELECT 1 FROM public.assessment_invitations i WHERE i.id=NEW.invitation_id AND (
      i.unique_token::text=token OR
      (NEW.assessment_type='lln' AND i.lln_token::text=token) OR
      (NEW.assessment_type='digital' AND i.digital_token::text=token)
    )
  ) THEN RAISE EXCEPTION 'student response type does not match the assessment token';
  END IF;
  RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION public.validate_candidate_token_response_insert() FROM PUBLIC;
DROP TRIGGER IF EXISTS issue040_token_assessment_response_insert ON assessment_responses;
CREATE TRIGGER issue040_token_assessment_response_insert BEFORE INSERT ON assessment_responses
  FOR EACH ROW EXECUTE FUNCTION public.validate_candidate_token_response_insert();
DROP TRIGGER IF EXISTS issue040_token_student_response_insert ON student_responses;
CREATE TRIGGER issue040_token_student_response_insert BEFORE INSERT ON student_responses
  FOR EACH ROW EXECUTE FUNCTION public.validate_candidate_token_response_insert();

CREATE OR REPLACE FUNCTION public.can_manage_support_invitation(target_invitation uuid)
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public AS $$
  SELECT EXISTS (
    SELECT 1 FROM public.assessment_invitations i
    LEFT JOIN public.support_cases sc ON sc.invitation_id = i.id
    WHERE i.id = target_invitation AND i.organisation_id = public.current_organisation_id()
      AND (public.has_workspace_access('administration') OR
        (public.has_workspace_access('candidate_support') AND sc.id IS NOT NULL AND
          (sc.assigned_user_id = auth.uid() OR sc.assigned_user_id IS NULL)))
  )
$$;
REVOKE ALL ON FUNCTION public.can_manage_support_invitation(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.can_manage_support_invitation(uuid) TO authenticated;

DROP POLICY IF EXISTS "inv_assessments_select_staff" ON invitation_assessments;
CREATE POLICY inv_assessments_workspace_select ON invitation_assessments FOR SELECT TO authenticated
  USING (can_manage_support_invitation(invitation_id));
DROP POLICY IF EXISTS "inv_assessments_insert_staff" ON invitation_assessments;
DROP POLICY IF EXISTS "inv_assessments_update_staff" ON invitation_assessments;
DROP POLICY IF EXISTS "inv_assessments_delete_staff" ON invitation_assessments;
CREATE POLICY inv_assessments_admin_insert ON invitation_assessments FOR INSERT TO authenticated
  WITH CHECK (has_workspace_access('administration') AND can_manage_support_invitation(invitation_id));
CREATE POLICY inv_assessments_admin_update ON invitation_assessments FOR UPDATE TO authenticated
  USING (has_workspace_access('administration') AND can_manage_support_invitation(invitation_id))
  WITH CHECK (has_workspace_access('administration') AND can_manage_support_invitation(invitation_id));
CREATE POLICY inv_assessments_admin_delete ON invitation_assessments FOR DELETE TO authenticated
  USING (has_workspace_access('administration') AND can_manage_support_invitation(invitation_id));
DROP POLICY IF EXISTS "responses_select_staff" ON assessment_responses;
CREATE POLICY responses_workspace_select ON assessment_responses FOR SELECT TO authenticated
  USING (can_manage_support_invitation(invitation_id));
DROP POLICY IF EXISTS "responses_insert_staff" ON assessment_responses;
DROP POLICY IF EXISTS "responses_update_staff" ON assessment_responses;
DROP POLICY IF EXISTS "responses_delete_staff" ON assessment_responses;
CREATE POLICY responses_admin_insert ON assessment_responses FOR INSERT TO authenticated
  WITH CHECK (has_workspace_access('administration') AND can_manage_support_invitation(invitation_id));
CREATE POLICY responses_admin_update ON assessment_responses FOR UPDATE TO authenticated
  USING (has_workspace_access('administration') AND can_manage_support_invitation(invitation_id))
  WITH CHECK (has_workspace_access('administration') AND can_manage_support_invitation(invitation_id));
CREATE POLICY responses_admin_delete ON assessment_responses FOR DELETE TO authenticated
  USING (has_workspace_access('administration') AND can_manage_support_invitation(invitation_id));

DROP POLICY IF EXISTS support_plans_select_staff ON support_plans;
DROP POLICY IF EXISTS "support_plans_select_staff" ON support_plans;
CREATE POLICY support_plans_workspace_select ON support_plans FOR SELECT TO authenticated USING (
  EXISTS (SELECT 1 FROM assessment_invitations i WHERE i.id = support_plans.invitation_id
    AND i.organisation_id = current_organisation_id() AND (
      has_workspace_access('administration') OR EXISTS (
        SELECT 1 FROM support_cases sc WHERE sc.invitation_id = i.id
        AND can_access_support_case(sc.organisation_id, sc.assigned_user_id)
      )
    ))
);
DROP POLICY IF EXISTS "support_plans_insert_staff" ON support_plans;
DROP POLICY IF EXISTS "support_plans_update_staff" ON support_plans;
DROP POLICY IF EXISTS "support_plans_delete_staff" ON support_plans;
CREATE POLICY support_plans_workspace_insert ON support_plans FOR INSERT TO authenticated
  WITH CHECK (can_manage_support_invitation(invitation_id));
CREATE POLICY support_plans_workspace_update ON support_plans FOR UPDATE TO authenticated
  USING (can_manage_support_invitation(invitation_id)) WITH CHECK (can_manage_support_invitation(invitation_id));
CREATE POLICY support_plans_admin_delete ON support_plans FOR DELETE TO authenticated
  USING (has_workspace_access('administration') AND can_manage_support_invitation(invitation_id));
DROP POLICY IF EXISTS intervention_cases_select_staff ON intervention_cases;
DROP POLICY IF EXISTS "intervention_cases_select_staff" ON intervention_cases;
CREATE POLICY intervention_cases_workspace_select ON intervention_cases FOR SELECT TO authenticated USING (
  EXISTS (SELECT 1 FROM assessment_invitations i WHERE i.id = intervention_cases.invitation_id
    AND i.organisation_id = current_organisation_id() AND (
      has_workspace_access('administration') OR EXISTS (
        SELECT 1 FROM support_cases sc WHERE sc.invitation_id = i.id
        AND can_access_support_case(sc.organisation_id, sc.assigned_user_id)
      )
    ))
);
DROP POLICY IF EXISTS "intervention_cases_insert_staff" ON intervention_cases;
DROP POLICY IF EXISTS "intervention_cases_update_staff" ON intervention_cases;
DROP POLICY IF EXISTS "intervention_cases_delete_staff" ON intervention_cases;
CREATE POLICY intervention_cases_workspace_insert ON intervention_cases FOR INSERT TO authenticated
  WITH CHECK (can_manage_support_invitation(invitation_id));
CREATE POLICY intervention_cases_workspace_update ON intervention_cases FOR UPDATE TO authenticated
  USING (can_manage_support_invitation(invitation_id)) WITH CHECK (can_manage_support_invitation(invitation_id));
CREATE POLICY intervention_cases_admin_delete ON intervention_cases FOR DELETE TO authenticated
  USING (has_workspace_access('administration') AND can_manage_support_invitation(invitation_id));

CREATE OR REPLACE FUNCTION public.can_manage_intervention(target_case uuid)
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public AS $$
  SELECT EXISTS (SELECT 1 FROM public.intervention_cases c WHERE c.id = target_case
    AND public.can_manage_support_invitation(c.invitation_id))
$$;
REVOKE ALL ON FUNCTION public.can_manage_intervention(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.can_manage_intervention(uuid) TO authenticated;

DROP POLICY IF EXISTS "int_notes_select_staff" ON intervention_notes;
DROP POLICY IF EXISTS "int_notes_insert_staff" ON intervention_notes;
DROP POLICY IF EXISTS "int_notes_update_staff" ON intervention_notes;
DROP POLICY IF EXISTS "int_notes_delete_staff" ON intervention_notes;
CREATE POLICY int_notes_workspace_select ON intervention_notes FOR SELECT TO authenticated USING (can_manage_intervention(intervention_case_id));
CREATE POLICY int_notes_workspace_insert ON intervention_notes FOR INSERT TO authenticated WITH CHECK (can_manage_intervention(intervention_case_id));
CREATE POLICY int_notes_workspace_update ON intervention_notes FOR UPDATE TO authenticated USING (can_manage_intervention(intervention_case_id)) WITH CHECK (can_manage_intervention(intervention_case_id));
CREATE POLICY int_notes_admin_delete ON intervention_notes FOR DELETE TO authenticated USING (has_workspace_access('administration') AND can_manage_intervention(intervention_case_id));

DROP POLICY IF EXISTS "int_evidence_select_staff" ON intervention_evidence;
DROP POLICY IF EXISTS "int_evidence_insert_staff" ON intervention_evidence;
DROP POLICY IF EXISTS "int_evidence_delete_staff" ON intervention_evidence;
CREATE POLICY int_evidence_workspace_select ON intervention_evidence FOR SELECT TO authenticated USING (can_manage_intervention(intervention_case_id));
CREATE POLICY int_evidence_workspace_insert ON intervention_evidence FOR INSERT TO authenticated WITH CHECK (can_manage_intervention(intervention_case_id));
CREATE POLICY int_evidence_admin_delete ON intervention_evidence FOR DELETE TO authenticated USING (has_workspace_access('administration') AND can_manage_intervention(intervention_case_id));

DROP POLICY IF EXISTS "int_strategies_select_staff" ON intervention_support_strategies;
DROP POLICY IF EXISTS "int_strategies_insert_staff" ON intervention_support_strategies;
DROP POLICY IF EXISTS "int_strategies_update_staff" ON intervention_support_strategies;
DROP POLICY IF EXISTS "int_strategies_delete_staff" ON intervention_support_strategies;
CREATE POLICY int_strategies_workspace_select ON intervention_support_strategies FOR SELECT TO authenticated USING (can_manage_intervention(intervention_case_id));
CREATE POLICY int_strategies_workspace_insert ON intervention_support_strategies FOR INSERT TO authenticated WITH CHECK (can_manage_intervention(intervention_case_id));
CREATE POLICY int_strategies_workspace_update ON intervention_support_strategies FOR UPDATE TO authenticated USING (can_manage_intervention(intervention_case_id)) WITH CHECK (can_manage_intervention(intervention_case_id));
CREATE POLICY int_strategies_admin_delete ON intervention_support_strategies FOR DELETE TO authenticated USING (has_workspace_access('administration') AND can_manage_intervention(intervention_case_id));

DROP POLICY IF EXISTS "int_reassessments_select_staff" ON intervention_reassessments;
DROP POLICY IF EXISTS "int_reassessments_insert_staff" ON intervention_reassessments;
DROP POLICY IF EXISTS "int_reassessments_update_staff" ON intervention_reassessments;
DROP POLICY IF EXISTS "int_reassessments_delete_staff" ON intervention_reassessments;
CREATE POLICY int_reassessments_workspace_select ON intervention_reassessments FOR SELECT TO authenticated USING (can_manage_intervention(intervention_case_id));
CREATE POLICY int_reassessments_workspace_insert ON intervention_reassessments FOR INSERT TO authenticated WITH CHECK (can_manage_intervention(intervention_case_id));
CREATE POLICY int_reassessments_workspace_update ON intervention_reassessments FOR UPDATE TO authenticated USING (can_manage_intervention(intervention_case_id)) WITH CHECK (can_manage_intervention(intervention_case_id));
CREATE POLICY int_reassessments_admin_delete ON intervention_reassessments FOR DELETE TO authenticated USING (has_workspace_access('administration') AND can_manage_intervention(intervention_case_id));

-- Customer technical logs are accessible only with Technical permission.
DROP POLICY IF EXISTS "axcelerate_log_select_staff" ON axcelerate_sync_log;
CREATE POLICY axcelerate_log_technical_select ON axcelerate_sync_log FOR SELECT TO authenticated
  USING (has_workspace_access('technical'));
DROP POLICY IF EXISTS "inbound_sync_log_select_staff" ON axcelerate_inbound_sync_log;
CREATE POLICY inbound_sync_log_technical_select ON axcelerate_inbound_sync_log FOR SELECT TO authenticated
  USING (has_workspace_access('technical'));
DROP POLICY IF EXISTS "ax_wb_select_staff" ON axcelerate_writeback_queue;
CREATE POLICY ax_wb_technical_select ON axcelerate_writeback_queue FOR SELECT TO authenticated
  USING (has_workspace_access('technical'));
DROP POLICY IF EXISTS "eq_select_staff" ON email_queue;
CREATE POLICY email_queue_technical_select ON email_queue FOR SELECT TO authenticated
  USING (has_workspace_access('technical'));

-- All staff changes flow through this RPC so the final active Administration
-- user cannot be demoted or deactivated by a race-prone client-side check.
CREATE OR REPLACE FUNCTION public.update_organisation_member(
  target_user uuid, new_status text, new_workspaces text[]
) RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE org_id uuid; active_admins integer; removes_admin boolean;
BEGIN
  IF NOT public.has_workspace_access('administration') THEN RAISE EXCEPTION 'administration access required'; END IF;
  org_id := public.current_organisation_id();
  IF new_status NOT IN ('active','inactive') THEN RAISE EXCEPTION 'invalid status'; END IF;
  IF new_workspaces <@ ARRAY['administration','candidate_support','technical']::text[] IS NOT TRUE
     OR cardinality(new_workspaces) = 0 THEN RAISE EXCEPTION 'invalid workspaces'; END IF;
  IF NOT EXISTS (SELECT 1 FROM public.organisation_memberships WHERE organisation_id=org_id AND user_id=target_user) THEN
    RAISE EXCEPTION 'cross-organisation member access denied';
  END IF;
  removes_admin := new_status <> 'active' OR NOT ('administration' = ANY(new_workspaces));
  IF removes_admin AND EXISTS (SELECT 1 FROM public.user_workspace_access WHERE organisation_id=org_id AND user_id=target_user AND workspace='administration') THEN
    -- Serialize Administration changes for this organisation so two concurrent
    -- requests cannot both remove what they each observed as a non-final admin.
    PERFORM 1 FROM public.organisations WHERE id=org_id FOR UPDATE;
    SELECT count(DISTINCT m.user_id) INTO active_admins FROM public.organisation_memberships m
    JOIN public.user_workspace_access w ON w.user_id=m.user_id AND w.organisation_id=m.organisation_id
    JOIN public.profiles p ON p.id=m.user_id AND p.is_active
    WHERE m.organisation_id=org_id AND m.status='active' AND w.workspace='administration';
    IF active_admins <= 1 THEN RAISE EXCEPTION 'final Administration user cannot be removed, demoted or deactivated'; END IF;
  END IF;
  UPDATE public.organisation_memberships SET status=new_status,
    deactivated_at=CASE WHEN new_status='inactive' THEN now() ELSE NULL END,
    activated_at=CASE WHEN new_status='active' THEN coalesce(activated_at,now()) ELSE activated_at END
    WHERE organisation_id=org_id AND user_id=target_user;
  UPDATE public.profiles SET is_active=(new_status='active') WHERE id=target_user AND organisation_id=org_id;
  DELETE FROM public.user_workspace_access WHERE organisation_id=org_id AND user_id=target_user;
  INSERT INTO public.user_workspace_access (organisation_id,user_id,workspace,is_primary)
    SELECT org_id,target_user,w,(ordinality=1) FROM unnest(new_workspaces) WITH ORDINALITY AS x(w,ordinality);
END $$;
REVOKE ALL ON FUNCTION public.update_organisation_member(uuid,text,text[]) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.update_organisation_member(uuid,text,text[]) TO authenticated;

CREATE INDEX IF NOT EXISTS idx_memberships_org ON organisation_memberships(organisation_id,status);
CREATE INDEX IF NOT EXISTS idx_workspace_org_user ON user_workspace_access(organisation_id,user_id);
CREATE INDEX IF NOT EXISTS idx_support_cases_scope ON support_cases(organisation_id,assigned_user_id,status);

-- Tenant provenance for customer-visible technical diagnostics. Rows without
-- a tenant remain inaccessible rather than leaking across RTOs.
ALTER TABLE axcelerate_sync_log ADD COLUMN IF NOT EXISTS organisation_id uuid REFERENCES organisations(id);
ALTER TABLE axcelerate_inbound_sync_log ADD COLUMN IF NOT EXISTS organisation_id uuid REFERENCES organisations(id);
ALTER TABLE axcelerate_writeback_queue ADD COLUMN IF NOT EXISTS organisation_id uuid REFERENCES organisations(id);
ALTER TABLE email_queue ADD COLUMN IF NOT EXISTS organisation_id uuid REFERENCES organisations(id);
UPDATE axcelerate_sync_log l SET organisation_id=i.organisation_id FROM assessment_invitations i WHERE l.invitation_id=i.id AND l.organisation_id IS NULL;
UPDATE axcelerate_writeback_queue l SET organisation_id=i.organisation_id FROM assessment_invitations i WHERE l.invitation_id=i.id AND l.organisation_id IS NULL;
UPDATE email_queue l SET organisation_id=i.organisation_id FROM assessment_invitations i WHERE l.invitation_id=i.id AND l.organisation_id IS NULL;
UPDATE axcelerate_inbound_sync_log l SET organisation_id=s.organisation_id FROM students s WHERE l.axcelerate_contact_id=s.axcelerate_contact_id AND l.organisation_id IS NULL;
DO $$
DECLARE bridge_org uuid; unresolved bigint;
BEGIN
  SELECT
    (SELECT count(*) FROM axcelerate_sync_log WHERE organisation_id IS NULL) +
    (SELECT count(*) FROM axcelerate_inbound_sync_log WHERE organisation_id IS NULL) +
    (SELECT count(*) FROM axcelerate_writeback_queue WHERE organisation_id IS NULL) +
    (SELECT count(*) FROM email_queue WHERE organisation_id IS NULL)
  INTO unresolved;
  IF unresolved > 0 THEN
    IF (SELECT count(*) FROM organisations) <> 1 THEN
      RAISE EXCEPTION 'Issue #40 diagnostics backfill: % rows have ambiguous organisation ownership', unresolved;
    END IF;
    SELECT id INTO STRICT bridge_org FROM organisations;
    UPDATE axcelerate_sync_log SET organisation_id=bridge_org WHERE organisation_id IS NULL;
    UPDATE axcelerate_inbound_sync_log SET organisation_id=bridge_org WHERE organisation_id IS NULL;
    UPDATE axcelerate_writeback_queue SET organisation_id=bridge_org WHERE organisation_id IS NULL;
    UPDATE email_queue SET organisation_id=bridge_org WHERE organisation_id IS NULL;
  END IF;
END $$;

DROP POLICY IF EXISTS axcelerate_log_technical_select ON axcelerate_sync_log;
CREATE POLICY axcelerate_log_technical_select ON axcelerate_sync_log FOR SELECT TO authenticated
  USING (organisation_id=current_organisation_id() AND has_workspace_access('technical'));
DROP POLICY IF EXISTS inbound_sync_log_technical_select ON axcelerate_inbound_sync_log;
CREATE POLICY inbound_sync_log_technical_select ON axcelerate_inbound_sync_log FOR SELECT TO authenticated
  USING (organisation_id=current_organisation_id() AND has_workspace_access('technical'));
DROP POLICY IF EXISTS ax_wb_technical_select ON axcelerate_writeback_queue;
CREATE POLICY ax_wb_technical_select ON axcelerate_writeback_queue FOR SELECT TO authenticated
  USING (organisation_id=current_organisation_id() AND has_workspace_access('technical'));
DROP POLICY IF EXISTS email_queue_technical_select ON email_queue;
CREATE POLICY email_queue_technical_select ON email_queue FOR SELECT TO authenticated
  USING (organisation_id=current_organisation_id() AND has_workspace_access('technical'));

CREATE OR REPLACE FUNCTION public.set_diagnostic_organisation()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
BEGIN
  IF NEW.organisation_id IS NULL THEN
    NEW.organisation_id := public.current_organisation_id();
  END IF;
  IF NEW.organisation_id IS NULL THEN
    RAISE EXCEPTION 'diagnostic organisation cannot be resolved safely';
  END IF;
  RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION public.set_diagnostic_organisation() FROM PUBLIC;
DROP TRIGGER IF EXISTS issue040_ax_log_org ON axcelerate_sync_log;
CREATE TRIGGER issue040_ax_log_org BEFORE INSERT ON axcelerate_sync_log FOR EACH ROW EXECUTE FUNCTION public.set_diagnostic_organisation();
DROP TRIGGER IF EXISTS issue040_inbound_log_org ON axcelerate_inbound_sync_log;
CREATE TRIGGER issue040_inbound_log_org BEFORE INSERT ON axcelerate_inbound_sync_log FOR EACH ROW EXECUTE FUNCTION public.set_diagnostic_organisation();
DROP TRIGGER IF EXISTS issue040_writeback_org ON axcelerate_writeback_queue;
CREATE TRIGGER issue040_writeback_org BEFORE INSERT ON axcelerate_writeback_queue FOR EACH ROW EXECUTE FUNCTION public.set_diagnostic_organisation();
DROP TRIGGER IF EXISTS issue040_email_org ON email_queue;
CREATE TRIGGER issue040_email_org BEFORE INSERT ON email_queue FOR EACH ROW EXECUTE FUNCTION public.set_diagnostic_organisation();

-- The service-only preparation RPC is idempotent while a grant is pending. It
-- validates the inviter and stores tenant/workspace authority before Supabase
-- sends an email, so browser-supplied auth metadata is never authoritative.
CREATE OR REPLACE FUNCTION public.prepare_staff_invitation(
  p_email text, p_full_name text, p_organisation_id uuid,
  p_workspaces text[], p_inviter_id uuid
) RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE grant_id uuid; normal_email text;
BEGIN
  normal_email := lower(trim(p_email));
  IF normal_email='' OR normal_email NOT LIKE '%@%' THEN RAISE EXCEPTION 'invalid invitation email'; END IF;
  IF p_workspaces IS NULL OR cardinality(p_workspaces)=0
     OR p_workspaces <@ ARRAY['administration','candidate_support','technical']::text[] IS NOT TRUE
     OR cardinality(p_workspaces)<>(SELECT count(DISTINCT w) FROM unnest(p_workspaces) w) THEN
    RAISE EXCEPTION 'invalid invitation workspaces';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM public.organisation_memberships m
    JOIN public.profiles p ON p.id=m.user_id AND p.is_active
    JOIN public.user_workspace_access w ON w.user_id=m.user_id AND w.organisation_id=m.organisation_id
    WHERE m.user_id=p_inviter_id AND m.organisation_id=p_organisation_id
      AND m.status='active' AND w.workspace='administration'
  ) THEN RAISE EXCEPTION 'inviter does not have Administration access'; END IF;

  INSERT INTO public.staff_invitation_grants
    (invited_email,full_name,organisation_id,approved_workspaces,invited_by,status,updated_at)
  VALUES (normal_email,coalesce(p_full_name,''),p_organisation_id,p_workspaces,p_inviter_id,'pending',now())
  ON CONFLICT (organisation_id,invited_email) DO UPDATE SET
    full_name=EXCLUDED.full_name, approved_workspaces=EXCLUDED.approved_workspaces,
    invited_by=EXCLUDED.invited_by, updated_at=now()
  WHERE staff_invitation_grants.status='pending'
  RETURNING id INTO grant_id;
  IF grant_id IS NULL THEN RAISE EXCEPTION 'an accepted or cancelled invitation cannot be overwritten'; END IF;
  RETURN grant_id;
END $$;
REVOKE ALL ON FUNCTION public.prepare_staff_invitation(text,text,uuid,text[],uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.prepare_staff_invitation(text,text,uuid,text[],uuid) TO service_role;

-- Link is deliberately retryable after inviteUserByEmail. It cannot change the
-- grant's organisation/workspaces and establishes only inactive/invited state.
CREATE OR REPLACE FUNCTION public.link_staff_invitation(p_grant_id uuid,p_user_id uuid)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE grant_row public.staff_invitation_grants%ROWTYPE; auth_email text;
BEGIN
  SELECT * INTO grant_row FROM public.staff_invitation_grants WHERE id=p_grant_id FOR UPDATE;
  IF NOT FOUND OR grant_row.status='cancelled' THEN RAISE EXCEPTION 'pending invitation grant not found'; END IF;
  IF grant_row.status='accepted' AND grant_row.user_id=p_user_id THEN RETURN; END IF;
  IF grant_row.status<>'pending' THEN RAISE EXCEPTION 'invitation grant is not retryable'; END IF;
  SELECT lower(email) INTO auth_email FROM auth.users WHERE id=p_user_id AND invited_at IS NOT NULL;
  IF auth_email IS NULL OR auth_email<>grant_row.invited_email THEN RAISE EXCEPTION 'invited account does not match grant'; END IF;
  IF grant_row.user_id IS NOT NULL AND grant_row.user_id<>p_user_id THEN RAISE EXCEPTION 'invitation grant already linked'; END IF;
  UPDATE public.staff_invitation_grants SET user_id=p_user_id,updated_at=now() WHERE id=p_grant_id;
  INSERT INTO public.profiles (id,full_name,email,role,organisation_id,is_active)
  VALUES (p_user_id,grant_row.full_name,auth_email,'trainer',grant_row.organisation_id,false)
  ON CONFLICT (id) DO UPDATE SET full_name=EXCLUDED.full_name,email=EXCLUDED.email,
    role='trainer',organisation_id=EXCLUDED.organisation_id,is_active=false;
  INSERT INTO public.organisation_memberships
    (organisation_id,user_id,status,invited_email,invited_by,activated_at,deactivated_at)
  VALUES (grant_row.organisation_id,p_user_id,'invited',auth_email,grant_row.invited_by,NULL,NULL)
  ON CONFLICT (organisation_id,user_id) DO UPDATE SET status='invited',invited_email=EXCLUDED.invited_email,
    invited_by=EXCLUDED.invited_by,activated_at=NULL,deactivated_at=NULL;
  DELETE FROM public.user_workspace_access WHERE user_id=p_user_id;
END $$;
REVOKE ALL ON FUNCTION public.link_staff_invitation(uuid,uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.link_staff_invitation(uuid,uuid) TO service_role;

-- Direct signup always creates a new RTO and ignores any organisation/workspace
-- metadata. Invited users must match a server-created pending grant.
CREATE OR REPLACE FUNCTION public.handle_new_user()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE org_id uuid; grant_id uuid; ws text;
BEGIN
  IF NEW.invited_at IS NOT NULL THEN
    SELECT g.id INTO grant_id FROM public.staff_invitation_grants g
      WHERE g.id=nullif(NEW.raw_user_meta_data->>'invitation_grant_id','')::uuid
        AND g.invited_email=lower(NEW.email) AND g.status='pending'
      FOR UPDATE;
    IF grant_id IS NULL THEN RAISE EXCEPTION 'server-controlled invitation grant required'; END IF;
    PERFORM public.link_staff_invitation(grant_id,NEW.id);
    RETURN NEW;
  END IF;

  INSERT INTO public.organisations (name,created_by)
  VALUES (coalesce(nullif(NEW.raw_user_meta_data->>'organisation_name',''),'My RTO'),NEW.id)
  RETURNING id INTO org_id;
  INSERT INTO public.profiles (id,full_name,email,role,organisation_id,is_active)
  VALUES (NEW.id,coalesce(NEW.raw_user_meta_data->>'full_name',NEW.raw_user_meta_data->>'name',''),
    coalesce(NEW.email,''),'admin',org_id,true)
  ON CONFLICT (id) DO UPDATE SET organisation_id=org_id,is_active=true,role='admin';
  INSERT INTO public.organisation_memberships (organisation_id,user_id,status,invited_email,activated_at)
  VALUES (org_id,NEW.id,'active',NEW.email,now());
  FOREACH ws IN ARRAY ARRAY['administration','candidate_support','technical'] LOOP
    INSERT INTO public.user_workspace_access (organisation_id,user_id,workspace,is_primary)
    VALUES (org_id,NEW.id,ws,ws='administration')
    ON CONFLICT (user_id,workspace) DO UPDATE SET organisation_id=org_id,is_primary=EXCLUDED.is_primary;
  END LOOP;
  RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION public.handle_new_user() FROM PUBLIC;

-- Confirmation is the sole activation event. Membership, profile, workspace
-- grants and invitation audit state change in the auth.users transaction.
CREATE OR REPLACE FUNCTION public.activate_confirmed_staff_invitation()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE grant_row public.staff_invitation_grants%ROWTYPE; ws text; position integer:=0;
BEGIN
  IF OLD.email_confirmed_at IS NOT NULL OR NEW.email_confirmed_at IS NULL THEN RETURN NEW; END IF;
  SELECT * INTO grant_row FROM public.staff_invitation_grants
    WHERE user_id=NEW.id AND invited_email=lower(NEW.email) AND status='pending' FOR UPDATE;
  IF NOT FOUND THEN RETURN NEW; END IF;
  UPDATE public.organisation_memberships SET status='active',activated_at=now(),deactivated_at=NULL
    WHERE organisation_id=grant_row.organisation_id AND user_id=NEW.id AND status='invited';
  IF NOT FOUND THEN RAISE EXCEPTION 'invited membership missing during activation'; END IF;
  UPDATE public.profiles SET is_active=true WHERE id=NEW.id AND organisation_id=grant_row.organisation_id;
  DELETE FROM public.user_workspace_access WHERE user_id=NEW.id;
  FOREACH ws IN ARRAY grant_row.approved_workspaces LOOP
    position:=position+1;
    INSERT INTO public.user_workspace_access (organisation_id,user_id,workspace,is_primary)
    VALUES (grant_row.organisation_id,NEW.id,ws,position=1);
  END LOOP;
  UPDATE public.staff_invitation_grants SET status='accepted',accepted_at=now(),updated_at=now()
    WHERE id=grant_row.id;
  RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION public.activate_confirmed_staff_invitation() FROM PUBLIC;
DROP TRIGGER IF EXISTS issue040_activate_staff_invitation ON auth.users;
CREATE TRIGGER issue040_activate_staff_invitation
  AFTER UPDATE OF email_confirmed_at ON auth.users
  FOR EACH ROW EXECUTE FUNCTION public.activate_confirmed_staff_invitation();

-- Applying this file through the Supabase migration runner is all-or-nothing.
-- Before staging: take a Supabase backup/PITR recovery point and record counts
-- for profiles, memberships, workspace access, candidate roots and diagnostics.
-- Any exception above rolls the entire transaction back; compare the same
-- counts plus active Administration membership after success.
COMMIT;
