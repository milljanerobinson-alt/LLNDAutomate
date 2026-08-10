/* Issue #40 staging hardening — privileged invitation role transition and retry reconciliation.

   The legacy prevent_role_escalation trigger correctly blocks ordinary callers,
   but it also rejected the service-role-only link_staff_invitation RPC when an
   existing invited profile had to transition to the fixed staff role. This
   forward migration recognises only the exact inactive profile transition backed
   by a matching pending server-created grant. It also adds a service-only RPC to
   reconcile an auth invitation whose email was sent before the linking transaction
   failed, without trusting browser-provided user or tenant identifiers.
*/

BEGIN;

CREATE OR REPLACE FUNCTION public.check_profile_role_unchanged()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  authorised_invitation_transition boolean := false;
BEGIN
  IF NEW.role IS DISTINCT FROM OLD.role THEN
    SELECT EXISTS (
      SELECT 1
      FROM public.staff_invitation_grants grant_row
      JOIN auth.users invited_user ON invited_user.id = grant_row.user_id
      WHERE grant_row.user_id = NEW.id
        AND grant_row.status = 'pending'
        AND grant_row.invited_email = lower(NEW.email)
        AND grant_row.organisation_id = NEW.organisation_id
        AND invited_user.invited_at IS NOT NULL
        AND lower(invited_user.email) = grant_row.invited_email
        AND NEW.role = 'trainer'
        AND NEW.is_active = false
    ) INTO authorised_invitation_transition;

    IF NOT authorised_invitation_transition THEN
      PERFORM 1 FROM public.profiles WHERE id = auth.uid() AND role = 'admin';
      IF NOT FOUND THEN
        RAISE EXCEPTION 'Only admins can change user roles';
      END IF;
    END IF;
  END IF;
  RETURN NEW;
END;
$$;

-- This function is trigger-only. The trigger can invoke it without client EXECUTE.
REVOKE ALL ON FUNCTION public.check_profile_role_unchanged() FROM PUBLIC, anon, authenticated, service_role;

CREATE OR REPLACE FUNCTION public.reconcile_staff_invitation(p_grant_id uuid)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  grant_row public.staff_invitation_grants%ROWTYPE;
  matching_users uuid[];
  invited_user_id uuid;
BEGIN
  SELECT * INTO grant_row
  FROM public.staff_invitation_grants
  WHERE id = p_grant_id
  FOR UPDATE;

  IF NOT FOUND OR grant_row.status <> 'pending' THEN
    RAISE EXCEPTION 'pending invitation grant not found';
  END IF;

  SELECT array_agg(invited_user.id ORDER BY invited_user.created_at)
  INTO matching_users
  FROM auth.users invited_user
  WHERE lower(invited_user.email) = grant_row.invited_email
    AND invited_user.invited_at IS NOT NULL;

  IF coalesce(cardinality(matching_users), 0) <> 1 THEN
    RAISE EXCEPTION 'exactly one invited auth account must match the pending grant';
  END IF;

  invited_user_id := matching_users[1];
  IF grant_row.user_id IS NOT NULL AND grant_row.user_id <> invited_user_id THEN
    RAISE EXCEPTION 'invitation grant is linked to a different auth account';
  END IF;

  PERFORM public.link_staff_invitation(p_grant_id, invited_user_id);
  RETURN invited_user_id;
END;
$$;

REVOKE ALL ON FUNCTION public.reconcile_staff_invitation(uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.reconcile_staff_invitation(uuid) TO service_role;

COMMIT;
