/* Issue #40 — Product Owner refinement (12 August 2026): conditional permanent
   staff deletion.

   Rules implemented here:
   - Only an active Administration user of the same RTO may delete a staff user.
   - A user cannot delete their own account.
   - Only staff who are already deactivated ('inactive') or still invited may be
     deleted. Active staff must be deactivated first. Deactivated and invited
     staff cannot receive new support-case assignments, so this also stops new
     references appearing between the check and the delete.
   - The organisation must keep at least one other active Administration user.
   - Deletion is blocked while the user is referenced by any recorded history:
     every foreign key to auth.users or public.profiles (outside the auth
     schema), plus every public uuid/text column whose name identifies an actor
     or owner (user_id, *_user_id, *_by, actor_id, author_id, owner_id,
     trainer_id, assessor_id, reviewer_id, approver_id, staff_id, assigned_to),
     plus storage.objects ownership. The check runs against the live catalogue,
     so columns that exist only in the hosted database are also covered.
     Only the user's own identity rows are excluded: profiles.id,
     organisation_memberships.user_id, user_workspace_access.user_id and
     staff_invitation_grants.user_id.
   - Known limitation: identifiers stored inside jsonb payloads or uuid[] arrays
     are not scanned. No current LLND Automate workflow relies on these for
     staff provenance; review before adding one.
   - Each deletion is recorded in staff_deletion_audit, then the identity rows
     and the Supabase Auth user are removed in the same transaction. If any step
     fails (including the auth.users delete), nothing is removed.

   Deployment: forward-only. Apply after the four existing Issue #40 migrations.
   Before applying to a shared environment, take a Supabase backup/PITR recovery
   point and record staff and membership row counts. Do not edit the earlier
   Issue #40 migration files.
*/

BEGIN;

CREATE TABLE IF NOT EXISTS public.staff_deletion_audit (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organisation_id uuid NOT NULL REFERENCES public.organisations(id) ON DELETE CASCADE,
  deleted_user_id uuid NOT NULL,
  deleted_email text NOT NULL,
  deleted_full_name text NOT NULL DEFAULT '',
  prior_status text NOT NULL CHECK (prior_status IN ('invited','inactive')),
  prior_workspaces text[] NOT NULL DEFAULT ARRAY[]::text[],
  deleted_by uuid NOT NULL,
  deleted_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE public.staff_deletion_audit ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.staff_deletion_audit FROM PUBLIC, anon, authenticated;
GRANT SELECT ON TABLE public.staff_deletion_audit TO authenticated;
DROP POLICY IF EXISTS staff_deletion_audit_admin_select ON public.staff_deletion_audit;
CREATE POLICY staff_deletion_audit_admin_select ON public.staff_deletion_audit
  FOR SELECT TO authenticated
  USING (organisation_id = public.current_organisation_id()
         AND public.has_workspace_access('administration'));
CREATE INDEX IF NOT EXISTS idx_staff_deletion_audit_org
  ON public.staff_deletion_audit(organisation_id, deleted_at DESC);

-- Internal: every place the user is recorded, excluding their own identity rows.
CREATE OR REPLACE FUNCTION public.staff_provenance_references(p_user uuid)
RETURNS TABLE (ref_schema text, ref_table text, ref_column text)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  candidate record;
  is_referenced boolean;
BEGIN
  IF p_user IS NULL THEN RETURN; END IF;

  FOR candidate IN
    WITH fk_columns AS (
      SELECT n.nspname::text AS sch, c.relname::text AS tbl, a.attname::text AS col, a.atttypid AS typ
      FROM pg_constraint k
      JOIN pg_class c ON c.oid = k.conrelid
      JOIN pg_namespace n ON n.oid = c.relnamespace
      JOIN pg_attribute a ON a.attrelid = k.conrelid AND a.attnum = k.conkey[1]
      WHERE k.contype = 'f'
        AND cardinality(k.conkey) = 1
        AND k.confrelid IN ('auth.users'::regclass, 'public.profiles'::regclass)
        AND n.nspname <> 'auth'
    ),
    named_columns AS (
      SELECT n.nspname::text, c.relname::text, a.attname::text, a.atttypid
      FROM pg_attribute a
      JOIN pg_class c ON c.oid = a.attrelid
      JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE c.relkind IN ('r','p')
        AND a.attnum > 0
        AND NOT a.attisdropped
        AND a.atttypid IN ('uuid'::regtype::oid, 'text'::regtype::oid, 'character varying'::regtype::oid)
        AND (
          (n.nspname = 'public' AND a.attname ~ '^(user_id|actor_id|author_id|owner_id|trainer_id|assessor_id|reviewer_id|approver_id|staff_id|assigned_to|.+_user_id|.+_by|.+_actor_id|.+_owner_id)$')
          OR (n.nspname = 'storage' AND c.relname = 'objects' AND a.attname IN ('owner','owner_id'))
        )
    )
    SELECT DISTINCT u.sch, u.tbl, u.col, u.typ
    FROM (SELECT * FROM fk_columns UNION SELECT * FROM named_columns) AS u(sch, tbl, col, typ)
    WHERE (u.sch, u.tbl, u.col) NOT IN (VALUES
      ('public','profiles','id'),
      ('public','organisation_memberships','user_id'),
      ('public','user_workspace_access','user_id'),
      ('public','staff_invitation_grants','user_id'))
    ORDER BY u.sch, u.tbl, u.col
  LOOP
    IF candidate.typ = 'uuid'::regtype::oid THEN
      EXECUTE format('SELECT EXISTS (SELECT 1 FROM %I.%I WHERE %I = $1)', candidate.sch, candidate.tbl, candidate.col)
        INTO is_referenced USING p_user;
    ELSE
      EXECUTE format('SELECT EXISTS (SELECT 1 FROM %I.%I WHERE %I = $1)', candidate.sch, candidate.tbl, candidate.col)
        INTO is_referenced USING p_user::text;
    END IF;
    IF is_referenced THEN
      ref_schema := candidate.sch;
      ref_table := candidate.tbl;
      ref_column := candidate.col;
      RETURN NEXT;
    END IF;
  END LOOP;
END;
$$;
REVOKE ALL ON FUNCTION public.staff_provenance_references(uuid) FROM PUBLIC, anon, authenticated, service_role;

-- Internal: customer-safe description of a reference (no internal table names).
CREATE OR REPLACE FUNCTION public.staff_provenance_area(p_schema text, p_table text)
RETURNS text
LANGUAGE sql
IMMUTABLE
SET search_path = pg_catalog, public
AS $$
  SELECT CASE
    WHEN p_schema = 'storage' THEN 'Uploaded files'
    WHEN p_table = 'support_cases' THEN 'Support cases'
    WHEN p_table LIKE 'intervention%' THEN 'Interventions'
    WHEN p_table = 'support_plans' THEN 'Support plans'
    WHEN p_table IN ('assessment_invitations','invitation_assessments','assessment_responses','student_responses') THEN 'Assessment invitations and results'
    WHEN p_table IN ('assessments','assessment_version_history','assessment_questions','assessment_validation') THEN 'Assessment authoring history'
    WHEN p_table IN ('students','enrolments','student_lifecycle_events') THEN 'Candidate records'
    WHEN p_table = 'organisations' THEN 'Organisation creation record'
    WHEN p_table IN ('organisation_memberships','staff_invitation_grants') THEN 'Staff invitations sent by this user'
    WHEN p_table = 'staff_deletion_audit' THEN 'Staff deletions performed by this user'
    WHEN p_table LIKE '%audit%' OR p_table LIKE '%_log' THEN 'Audit and compliance records'
    ELSE 'Other recorded history'
  END
$$;
REVOKE ALL ON FUNCTION public.staff_provenance_area(text,text) FROM PUBLIC, anon, authenticated, service_role;

-- Administration: explain why a staff user cannot be deleted (empty = deletable
-- as far as recorded history is concerned).
CREATE OR REPLACE FUNCTION public.get_staff_deletion_blockers(target_user uuid)
RETURNS TABLE (record_area text)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  org_id uuid;
BEGIN
  IF NOT public.has_workspace_access('administration') THEN
    RAISE EXCEPTION 'administration access required';
  END IF;
  org_id := public.current_organisation_id();
  IF NOT EXISTS (
    SELECT 1 FROM public.organisation_memberships om
    WHERE om.organisation_id = org_id AND om.user_id = target_user
  ) THEN
    RAISE EXCEPTION 'cross-organisation member access denied';
  END IF;
  RETURN QUERY
    SELECT DISTINCT public.staff_provenance_area(r.ref_schema, r.ref_table)
    FROM public.staff_provenance_references(target_user) r
    ORDER BY 1;
END;
$$;
REVOKE ALL ON FUNCTION public.get_staff_deletion_blockers(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.get_staff_deletion_blockers(uuid) TO authenticated;

-- Administration: permanently delete a deactivated or invited staff user with
-- no recorded history.
CREATE OR REPLACE FUNCTION public.delete_organisation_member(target_user uuid)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  org_id uuid;
  target_membership public.organisation_memberships%ROWTYPE;
  target_profile public.profiles%ROWTYPE;
  other_active_admins integer;
  blocking_areas text;
  prior_access text[];
  target_email text;
BEGIN
  IF NOT public.has_workspace_access('administration') THEN
    RAISE EXCEPTION 'administration access required';
  END IF;
  org_id := public.current_organisation_id();
  IF target_user IS NULL OR target_user = auth.uid() THEN
    RAISE EXCEPTION 'you cannot delete your own staff account';
  END IF;

  -- Serialise with other Administration membership changes for this RTO.
  PERFORM 1 FROM public.organisations o WHERE o.id = org_id FOR UPDATE;

  SELECT * INTO target_membership
  FROM public.organisation_memberships om
  WHERE om.organisation_id = org_id AND om.user_id = target_user
  FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'cross-organisation member access denied';
  END IF;
  IF target_membership.status NOT IN ('inactive','invited') THEN
    RAISE EXCEPTION 'deactivate this staff user before deleting them';
  END IF;

  SELECT count(DISTINCT om.user_id) INTO other_active_admins
  FROM public.organisation_memberships om
  JOIN public.user_workspace_access w ON w.user_id = om.user_id AND w.organisation_id = om.organisation_id
  JOIN public.profiles p ON p.id = om.user_id AND p.is_active
  WHERE om.organisation_id = org_id AND om.status = 'active'
    AND w.workspace = 'administration' AND om.user_id <> target_user;
  IF other_active_admins < 1 THEN
    RAISE EXCEPTION 'final Administration user cannot be removed, demoted or deactivated';
  END IF;

  SELECT string_agg(DISTINCT public.staff_provenance_area(r.ref_schema, r.ref_table), ', ')
  INTO blocking_areas
  FROM public.staff_provenance_references(target_user) r;
  IF blocking_areas IS NOT NULL THEN
    RAISE EXCEPTION 'This staff user cannot be permanently deleted because they are recorded in: %. Keep them deactivated instead.', blocking_areas;
  END IF;

  SELECT * INTO target_profile FROM public.profiles p WHERE p.id = target_user;
  target_email := lower(coalesce(target_profile.email, target_membership.invited_email, ''));

  IF target_membership.status = 'invited' THEN
    SELECT g.approved_workspaces INTO prior_access
    FROM public.staff_invitation_grants g
    WHERE g.organisation_id = org_id AND g.user_id = target_user;
  ELSE
    SELECT array_agg(w.workspace ORDER BY CASE w.workspace
      WHEN 'administration' THEN 1 WHEN 'candidate_support' THEN 2 ELSE 3 END)
    INTO prior_access
    FROM public.user_workspace_access w
    WHERE w.organisation_id = org_id AND w.user_id = target_user;
  END IF;

  INSERT INTO public.staff_deletion_audit
    (organisation_id, deleted_user_id, deleted_email, deleted_full_name,
     prior_status, prior_workspaces, deleted_by)
  VALUES
    (org_id, target_user, target_email, coalesce(target_profile.full_name, ''),
     target_membership.status, coalesce(prior_access, ARRAY[]::text[]), auth.uid());

  -- Remove the deleted person's own invitation grants so they can be invited
  -- again later. Grants they sent to others block deletion above.
  DELETE FROM public.staff_invitation_grants g
  WHERE g.user_id = target_user
     OR (g.organisation_id = org_id AND target_email <> '' AND g.invited_email = target_email);
  DELETE FROM public.user_workspace_access w WHERE w.user_id = target_user;
  DELETE FROM public.organisation_memberships om WHERE om.user_id = target_user;
  DELETE FROM public.profiles p WHERE p.id = target_user;
  DELETE FROM auth.users u WHERE u.id = target_user;
END;
$$;
REVOKE ALL ON FUNCTION public.delete_organisation_member(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.delete_organisation_member(uuid) TO authenticated;

COMMIT;
