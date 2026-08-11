/* Issue #40 — complete invitation activation only after password setup.

   The original confirmation trigger activated an invited membership as soon as
   the Auth action link confirmed the email. Account setup is not complete until
   the invited user establishes a password. This forward-only replacement keeps
   the same pending grant and membership, and activates atomically once both
   confirmed email and encrypted password are present.
*/

BEGIN;

CREATE OR REPLACE FUNCTION public.activate_confirmed_staff_invitation()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  grant_row public.staff_invitation_grants%ROWTYPE;
  ws text;
  position integer := 0;
BEGIN
  IF NEW.email_confirmed_at IS NULL
     OR NEW.encrypted_password IS NULL
     OR NEW.encrypted_password = '' THEN
    RETURN NEW;
  END IF;

  SELECT * INTO grant_row
  FROM public.staff_invitation_grants
  WHERE user_id=NEW.id
    AND invited_email=lower(NEW.email)
    AND status='pending'
  FOR UPDATE;
  IF NOT FOUND THEN RETURN NEW; END IF;

  UPDATE public.organisation_memberships
  SET status='active',activated_at=now(),deactivated_at=NULL
  WHERE organisation_id=grant_row.organisation_id
    AND user_id=NEW.id
    AND status='invited';
  IF NOT FOUND THEN RAISE EXCEPTION 'invited membership missing during activation'; END IF;

  UPDATE public.profiles
  SET is_active=true
  WHERE id=NEW.id AND organisation_id=grant_row.organisation_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'invited profile missing during activation'; END IF;

  DELETE FROM public.user_workspace_access WHERE user_id=NEW.id;
  FOREACH ws IN ARRAY grant_row.approved_workspaces LOOP
    position := position + 1;
    INSERT INTO public.user_workspace_access (organisation_id,user_id,workspace,is_primary)
    VALUES (grant_row.organisation_id,NEW.id,ws,position=1);
  END LOOP;

  UPDATE public.staff_invitation_grants
  SET status='accepted',accepted_at=now(),updated_at=now()
  WHERE id=grant_row.id AND status='pending';
  IF NOT FOUND THEN RAISE EXCEPTION 'pending invitation grant missing during activation'; END IF;

  RETURN NEW;
END;
$$;

REVOKE ALL ON FUNCTION public.activate_confirmed_staff_invitation() FROM PUBLIC, anon, authenticated, service_role;

DROP TRIGGER IF EXISTS issue040_activate_staff_invitation ON auth.users;
CREATE TRIGGER issue040_activate_staff_invitation
  AFTER UPDATE OF email_confirmed_at, encrypted_password ON auth.users
  FOR EACH ROW EXECUTE FUNCTION public.activate_confirmed_staff_invitation();

COMMIT;
