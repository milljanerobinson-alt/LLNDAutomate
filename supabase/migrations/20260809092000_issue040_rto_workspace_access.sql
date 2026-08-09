/* Issue #40 — RTO workspace access, tenancy and support-case foundation.

   The current aXcelerate implementation stores contact, enrolment and course IDs,
   but does not store a trainer/assessor relationship. Automated assignment is
   therefore intentionally disabled: support cases are created unassigned until
   Administration assigns them. The nullable provenance columns below are the
   integration boundary for a future verified aXcelerate relationship.
*/

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

-- Establish one recoverable organisation for existing LLND staff. This is an
-- explicit migration bridge; new organisations are created by signup metadata.
DO $$
DECLARE org_id uuid;
BEGIN
  SELECT id INTO org_id FROM organisations ORDER BY created_at LIMIT 1;
  IF org_id IS NULL THEN
    INSERT INTO organisations (name, created_by)
    SELECT 'Existing RTO', id FROM profiles ORDER BY created_at LIMIT 1
    RETURNING id INTO org_id;
    IF org_id IS NULL THEN
      INSERT INTO organisations (name) VALUES ('Existing RTO') RETURNING id INTO org_id;
    END IF;
  END IF;
  UPDATE profiles SET organisation_id = org_id WHERE organisation_id IS NULL;
  UPDATE user_workspace_access uwa SET organisation_id = p.organisation_id
    FROM profiles p WHERE uwa.user_id = p.id AND uwa.organisation_id IS NULL;
  INSERT INTO organisation_memberships (organisation_id, user_id, status, activated_at)
    SELECT p.organisation_id, p.id, 'active', now() FROM profiles p
    WHERE p.organisation_id IS NOT NULL
    ON CONFLICT (organisation_id, user_id) DO NOTHING;
END $$;

ALTER TABLE user_workspace_access ALTER COLUMN organisation_id SET NOT NULL;

CREATE OR REPLACE FUNCTION current_organisation_id()
RETURNS uuid LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT organisation_id FROM organisation_memberships
  WHERE user_id = auth.uid() AND status = 'active' LIMIT 1
$$;

CREATE OR REPLACE FUNCTION has_workspace_access(required_workspace text)
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT EXISTS (
    SELECT 1 FROM organisation_memberships m
    JOIN profiles p ON p.id = m.user_id AND p.is_active
    JOIN user_workspace_access w ON w.user_id = m.user_id
      AND w.organisation_id = m.organisation_id
    WHERE m.user_id = auth.uid() AND m.status = 'active'
      AND w.workspace = required_workspace
  )
$$;

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
UPDATE students SET organisation_id = (SELECT id FROM organisations ORDER BY created_at LIMIT 1) WHERE organisation_id IS NULL;
UPDATE enrolments e SET organisation_id = s.organisation_id FROM students s
  WHERE e.student_id = s.id AND e.organisation_id IS NULL;
UPDATE assessment_invitations i SET organisation_id = s.organisation_id FROM students s
  WHERE i.student_id = s.id AND i.organisation_id IS NULL;

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

CREATE OR REPLACE FUNCTION can_access_support_case(case_org uuid, assignee uuid)
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT case_org = current_organisation_id() AND (
    has_workspace_access('administration') OR
    (has_workspace_access('candidate_support') AND (assignee = auth.uid() OR assignee IS NULL))
  )
$$;

CREATE POLICY support_case_scoped_select ON support_cases FOR SELECT TO authenticated
  USING (can_access_support_case(organisation_id, assigned_user_id));
CREATE POLICY support_case_admin_insert ON support_cases FOR INSERT TO authenticated
  WITH CHECK (organisation_id = current_organisation_id() AND has_workspace_access('administration'));
CREATE POLICY support_case_admin_update ON support_cases FOR UPDATE TO authenticated
  USING (organisation_id = current_organisation_id() AND has_workspace_access('administration'))
  WITH CHECK (organisation_id = current_organisation_id() AND has_workspace_access('administration'));

CREATE OR REPLACE FUNCTION validate_support_case_assignment()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  IF NEW.assigned_user_id IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM organisation_memberships m
    JOIN profiles p ON p.id = m.user_id AND p.is_active
    JOIN user_workspace_access w ON w.user_id = m.user_id AND w.organisation_id = m.organisation_id
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
DROP TRIGGER IF EXISTS issue040_validate_support_assignment ON support_cases;
CREATE TRIGGER issue040_validate_support_assignment BEFORE UPDATE OF assigned_user_id ON support_cases
  FOR EACH ROW EXECUTE FUNCTION validate_support_case_assignment();

-- Reuse existing outcome logic: a support outcome creates an unassigned case.
CREATE OR REPLACE FUNCTION create_support_case_from_outcome()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  IF NEW.course_recommendation IN ('suitable_with_support','not_yet_suitable')
     AND NEW.organisation_id IS NOT NULL THEN
    INSERT INTO support_cases (organisation_id, invitation_id, student_id)
    VALUES (NEW.organisation_id, NEW.id, NEW.student_id)
    ON CONFLICT (invitation_id) DO NOTHING;
  END IF;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS issue040_support_outcome ON assessment_invitations;
CREATE TRIGGER issue040_support_outcome AFTER INSERT OR UPDATE OF course_recommendation
  ON assessment_invitations FOR EACH ROW EXECUTE FUNCTION create_support_case_from_outcome();

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

CREATE OR REPLACE FUNCTION can_manage_support_invitation(target_invitation uuid)
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT EXISTS (
    SELECT 1 FROM assessment_invitations i
    LEFT JOIN support_cases sc ON sc.invitation_id = i.id
    WHERE i.id = target_invitation AND i.organisation_id = current_organisation_id()
      AND (has_workspace_access('administration') OR
        (has_workspace_access('candidate_support') AND
          (sc.assigned_user_id = auth.uid() OR sc.assigned_user_id IS NULL)))
  )
$$;

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

CREATE OR REPLACE FUNCTION can_manage_intervention(target_case uuid)
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT EXISTS (SELECT 1 FROM intervention_cases c WHERE c.id = target_case
    AND can_manage_support_invitation(c.invitation_id))
$$;

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
CREATE OR REPLACE FUNCTION update_organisation_member(
  target_user uuid, new_status text, new_workspaces text[]
) RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE org_id uuid; active_admins integer; removes_admin boolean;
BEGIN
  IF NOT has_workspace_access('administration') THEN RAISE EXCEPTION 'administration access required'; END IF;
  org_id := current_organisation_id();
  IF new_status NOT IN ('active','inactive') THEN RAISE EXCEPTION 'invalid status'; END IF;
  IF new_workspaces <@ ARRAY['administration','candidate_support','technical']::text[] IS NOT TRUE
     OR cardinality(new_workspaces) = 0 THEN RAISE EXCEPTION 'invalid workspaces'; END IF;
  IF NOT EXISTS (SELECT 1 FROM organisation_memberships WHERE organisation_id=org_id AND user_id=target_user) THEN
    RAISE EXCEPTION 'cross-organisation member access denied';
  END IF;
  removes_admin := new_status <> 'active' OR NOT ('administration' = ANY(new_workspaces));
  IF removes_admin AND EXISTS (SELECT 1 FROM user_workspace_access WHERE organisation_id=org_id AND user_id=target_user AND workspace='administration') THEN
    -- Serialize Administration changes for this organisation so two concurrent
    -- requests cannot both remove what they each observed as a non-final admin.
    PERFORM 1 FROM organisations WHERE id=org_id FOR UPDATE;
    SELECT count(DISTINCT m.user_id) INTO active_admins FROM organisation_memberships m
    JOIN user_workspace_access w ON w.user_id=m.user_id AND w.organisation_id=m.organisation_id
    JOIN profiles p ON p.id=m.user_id AND p.is_active
    WHERE m.organisation_id=org_id AND m.status='active' AND w.workspace='administration';
    IF active_admins <= 1 THEN RAISE EXCEPTION 'final Administration user cannot be removed, demoted or deactivated'; END IF;
  END IF;
  UPDATE organisation_memberships SET status=new_status,
    deactivated_at=CASE WHEN new_status='inactive' THEN now() ELSE NULL END,
    activated_at=CASE WHEN new_status='active' THEN coalesce(activated_at,now()) ELSE activated_at END
    WHERE organisation_id=org_id AND user_id=target_user;
  UPDATE profiles SET is_active=(new_status='active') WHERE id=target_user AND organisation_id=org_id;
  DELETE FROM user_workspace_access WHERE organisation_id=org_id AND user_id=target_user;
  INSERT INTO user_workspace_access (organisation_id,user_id,workspace,is_primary)
    SELECT org_id,target_user,w,(ordinality=1) FROM unnest(new_workspaces) WITH ORDINALITY AS x(w,ordinality);
END $$;
REVOKE ALL ON FUNCTION update_organisation_member(uuid,text,text[]) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION update_organisation_member(uuid,text,text[]) TO authenticated;

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
UPDATE axcelerate_sync_log SET organisation_id=(SELECT id FROM organisations ORDER BY created_at LIMIT 1) WHERE organisation_id IS NULL;
UPDATE axcelerate_inbound_sync_log SET organisation_id=(SELECT id FROM organisations ORDER BY created_at LIMIT 1) WHERE organisation_id IS NULL;
UPDATE axcelerate_writeback_queue SET organisation_id=(SELECT id FROM organisations ORDER BY created_at LIMIT 1) WHERE organisation_id IS NULL;
UPDATE email_queue SET organisation_id=(SELECT id FROM organisations ORDER BY created_at LIMIT 1) WHERE organisation_id IS NULL;

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

CREATE OR REPLACE FUNCTION set_diagnostic_organisation()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  IF NEW.organisation_id IS NULL THEN
    NEW.organisation_id := current_organisation_id();
  END IF;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS issue040_ax_log_org ON axcelerate_sync_log;
CREATE TRIGGER issue040_ax_log_org BEFORE INSERT ON axcelerate_sync_log FOR EACH ROW EXECUTE FUNCTION set_diagnostic_organisation();
DROP TRIGGER IF EXISTS issue040_inbound_log_org ON axcelerate_inbound_sync_log;
CREATE TRIGGER issue040_inbound_log_org BEFORE INSERT ON axcelerate_inbound_sync_log FOR EACH ROW EXECUTE FUNCTION set_diagnostic_organisation();
DROP TRIGGER IF EXISTS issue040_writeback_org ON axcelerate_writeback_queue;
CREATE TRIGGER issue040_writeback_org BEFORE INSERT ON axcelerate_writeback_queue FOR EACH ROW EXECUTE FUNCTION set_diagnostic_organisation();
DROP TRIGGER IF EXISTS issue040_email_org ON email_queue;
CREATE TRIGGER issue040_email_org BEFORE INSERT ON email_queue FOR EACH ROW EXECUTE FUNCTION set_diagnostic_organisation();

-- Signup/invitation activation. A direct organisation creator receives all
-- workspaces; an invited user receives exactly the permissions supplied by the
-- server-side invitation function.
CREATE OR REPLACE FUNCTION public.handle_new_user()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE org_id uuid; requested text[]; ws text; profile_role text;
BEGIN
  org_id := nullif(NEW.raw_user_meta_data->>'organisation_id','')::uuid;
  IF org_id IS NULL THEN
    INSERT INTO organisations (name, created_by)
    VALUES (coalesce(nullif(NEW.raw_user_meta_data->>'organisation_name',''),'My RTO'), NEW.id)
    RETURNING id INTO org_id;
    requested := ARRAY['administration','candidate_support','technical'];
    profile_role := 'admin';
  ELSE
    SELECT coalesce(array_agg(value), ARRAY[]::text[]) INTO requested
    FROM jsonb_array_elements_text(coalesce(NEW.raw_user_meta_data->'workspaces','[]'::jsonb));
    profile_role := 'trainer';
  END IF;
  INSERT INTO profiles (id,full_name,email,role,organisation_id,is_active)
  VALUES (NEW.id,coalesce(NEW.raw_user_meta_data->>'full_name',NEW.raw_user_meta_data->>'name',''),
    coalesce(NEW.email,''),profile_role,org_id,true)
  ON CONFLICT (id) DO UPDATE SET organisation_id=org_id,is_active=true,role=profile_role;
  INSERT INTO organisation_memberships (organisation_id,user_id,status,invited_email,activated_at)
  VALUES (org_id,NEW.id,'active',NEW.email,now())
  ON CONFLICT (organisation_id,user_id) DO UPDATE SET status='active',activated_at=now(),deactivated_at=NULL;
  DELETE FROM user_workspace_access WHERE organisation_id=org_id AND user_id=NEW.id;
  FOREACH ws IN ARRAY requested LOOP
    IF ws IN ('administration','candidate_support','technical') THEN
      INSERT INTO user_workspace_access (organisation_id,user_id,workspace,is_primary)
      VALUES (org_id,NEW.id,ws,ws=requested[1]) ON CONFLICT (user_id,workspace) DO UPDATE
        SET organisation_id=org_id,is_primary=EXCLUDED.is_primary;
    END IF;
  END LOOP;
  RETURN NEW;
END $$;
