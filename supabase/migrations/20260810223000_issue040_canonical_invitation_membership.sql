/* Issue #40 — canonical invitation membership and pending-user recovery.

   Supabase Auth invitation creation can fire the auth.users AFTER INSERT trigger
   before invited_at is observable to that trigger. The prior handle_new_user
   therefore entered the direct-signup branch despite a server-created pending
   grant, creating an active membership in a new RTO. This migration makes the
   matching server grant the first and authoritative lifecycle discriminator.

   link_staff_invitation also repairs only that precisely identifiable historical
   side effect while retaining the same membership row and the one-RTO invariant.
*/

BEGIN;

CREATE OR REPLACE FUNCTION public.link_staff_invitation(p_grant_id uuid,p_user_id uuid)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  grant_row public.staff_invitation_grants%ROWTYPE;
  auth_email text;
  membership_row public.organisation_memberships%ROWTYPE;
  accidental_org uuid;
  accidental_org_is_recoverable boolean := false;
BEGIN
  SELECT * INTO grant_row
  FROM public.staff_invitation_grants
  WHERE id=p_grant_id
  FOR UPDATE;

  IF NOT FOUND OR grant_row.status='cancelled' THEN
    RAISE EXCEPTION 'pending invitation grant not found';
  END IF;
  IF grant_row.status='accepted' AND grant_row.user_id=p_user_id THEN
    RETURN;
  END IF;
  IF grant_row.status<>'pending' THEN
    RAISE EXCEPTION 'invitation grant is not retryable';
  END IF;

  SELECT lower(email) INTO auth_email
  FROM auth.users
  WHERE id=p_user_id
    AND (
      invited_at IS NOT NULL
      OR nullif(raw_user_meta_data->>'invitation_grant_id','')::uuid=p_grant_id
    );
  IF auth_email IS NULL OR auth_email<>grant_row.invited_email THEN
    RAISE EXCEPTION 'invited account does not match grant';
  END IF;
  IF grant_row.user_id IS NOT NULL AND grant_row.user_id<>p_user_id THEN
    RAISE EXCEPTION 'invitation grant already linked';
  END IF;

  SELECT * INTO membership_row
  FROM public.organisation_memberships
  WHERE user_id=p_user_id
  FOR UPDATE;

  IF FOUND AND membership_row.organisation_id<>grant_row.organisation_id THEN
    accidental_org := membership_row.organisation_id;
    SELECT EXISTS (
      SELECT 1
      FROM public.organisations o
      JOIN public.profiles p ON p.id=p_user_id AND p.organisation_id=o.id
      WHERE o.id=membership_row.organisation_id
        AND o.created_by=p_user_id
        AND membership_row.status='active'
        AND (SELECT count(*) FROM public.organisation_memberships m WHERE m.organisation_id=o.id)=1
        AND NOT EXISTS (SELECT 1 FROM public.students s WHERE s.organisation_id=o.id)
        AND NOT EXISTS (SELECT 1 FROM public.enrolments e WHERE e.organisation_id=o.id)
        AND NOT EXISTS (SELECT 1 FROM public.assessment_invitations i WHERE i.organisation_id=o.id)
        AND NOT EXISTS (SELECT 1 FROM public.support_cases c WHERE c.organisation_id=o.id)
    ) INTO accidental_org_is_recoverable;

    IF NOT accidental_org_is_recoverable THEN
      RAISE EXCEPTION 'invited account already belongs to another RTO';
    END IF;

    DELETE FROM public.user_workspace_access WHERE user_id=p_user_id;
    UPDATE public.organisation_memberships
    SET organisation_id=grant_row.organisation_id,
        status='invited', invited_email=auth_email, invited_by=grant_row.invited_by,
        activated_at=NULL, deactivated_at=NULL
    WHERE id=membership_row.id;
  ELSIF FOUND THEN
    UPDATE public.organisation_memberships
    SET status='invited', invited_email=auth_email, invited_by=grant_row.invited_by,
        activated_at=NULL, deactivated_at=NULL
    WHERE id=membership_row.id;
  ELSE
    INSERT INTO public.organisation_memberships
      (organisation_id,user_id,status,invited_email,invited_by,activated_at,deactivated_at)
    VALUES
      (grant_row.organisation_id,p_user_id,'invited',auth_email,grant_row.invited_by,NULL,NULL);
  END IF;

  UPDATE public.staff_invitation_grants
  SET user_id=p_user_id,updated_at=now()
  WHERE id=p_grant_id;

  INSERT INTO public.profiles (id,full_name,email,role,organisation_id,is_active)
  VALUES (p_user_id,grant_row.full_name,auth_email,'trainer',grant_row.organisation_id,false)
  ON CONFLICT (id) DO UPDATE SET
    full_name=EXCLUDED.full_name,email=EXCLUDED.email,role='trainer',
    organisation_id=EXCLUDED.organisation_id,is_active=false;

  DELETE FROM public.user_workspace_access WHERE user_id=p_user_id;

  -- Remove only the empty RTO created by the defective invitation/direct-signup
  -- branch. Any dependent or business data makes the recovery fail closed above.
  IF accidental_org IS NOT NULL THEN
    DELETE FROM public.organisations o
    WHERE o.id=accidental_org AND o.created_by=p_user_id
      AND NOT EXISTS (SELECT 1 FROM public.organisation_memberships m WHERE m.organisation_id=o.id);
  END IF;
END;
$$;

REVOKE ALL ON FUNCTION public.link_staff_invitation(uuid,uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.link_staff_invitation(uuid,uuid) TO service_role;

CREATE OR REPLACE FUNCTION public.handle_new_user()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  org_id uuid;
  grant_id uuid;
  ws text;
BEGIN
  -- A matching pending server grant is authoritative even when invited_at has
  -- not yet been populated at this point in Supabase Auth's insert lifecycle.
  SELECT g.id INTO grant_id
  FROM public.staff_invitation_grants g
  WHERE g.id=nullif(NEW.raw_user_meta_data->>'invitation_grant_id','')::uuid
    AND g.invited_email=lower(NEW.email)
    AND g.status='pending'
  FOR UPDATE;

  IF grant_id IS NOT NULL THEN
    PERFORM public.link_staff_invitation(grant_id,NEW.id);
    RETURN NEW;
  END IF;

  -- An Auth invitation without the matching server grant must never fall
  -- through to direct signup and create a tenant.
  IF NEW.invited_at IS NOT NULL THEN
    RAISE EXCEPTION 'server-controlled invitation grant required';
  END IF;

  -- Legitimate self-signup remains separate and always creates a new RTO.
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
END;
$$;

REVOKE ALL ON FUNCTION public.handle_new_user() FROM PUBLIC, anon, authenticated, service_role;

CREATE OR REPLACE FUNCTION public.list_organisation_staff()
RETURNS TABLE (
  membership_id uuid,
  user_id uuid,
  status text,
  invited_email text,
  full_name text,
  email text,
  is_active boolean,
  workspaces text[],
  pending_workspaces text[]
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
  SELECT m.id, m.user_id, m.status, m.invited_email,
    coalesce(p.full_name,''), coalesce(p.email,m.invited_email,''), coalesce(p.is_active,false),
    coalesce((SELECT array_agg(w.workspace ORDER BY CASE w.workspace
      WHEN 'administration' THEN 1 WHEN 'candidate_support' THEN 2 ELSE 3 END)
      FROM public.user_workspace_access w
      WHERE w.user_id=m.user_id AND w.organisation_id=m.organisation_id),ARRAY[]::text[]),
    coalesce((SELECT g.approved_workspaces FROM public.staff_invitation_grants g
      WHERE g.organisation_id=m.organisation_id AND g.user_id=m.user_id AND g.status='pending'),ARRAY[]::text[])
  FROM public.organisation_memberships m
  LEFT JOIN public.profiles p ON p.id=m.user_id
  WHERE m.organisation_id=public.current_organisation_id()
    AND public.has_workspace_access('administration')
  ORDER BY m.created_at, m.id
$$;

REVOKE ALL ON FUNCTION public.list_organisation_staff() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.list_organisation_staff() TO authenticated;

COMMIT;
