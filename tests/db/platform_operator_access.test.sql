-- Database integration tests: Issue #45 platform-operator access on the full stack.
-- Runs on a DISPOSABLE local database after tests/db/free_tier_invitations.test.sql
-- (reuses its mt.* helpers and synthetic RTOs). Each check raises on failure.

\set ON_ERROR_STOP on
SET client_min_messages = notice;
SET request.jwt.claims = '{}';
SET request.headers = '{}';

-- Evaluate an expression as a signed-in user (API role, given MFA level); returns text.
CREATE OR REPLACE FUNCTION mt.as_user(p_user uuid, p_aal text, p_expr text) RETURNS text LANGUAGE plpgsql AS $$
DECLARE r text;
BEGIN
  PERFORM mt.act_as(p_user, p_aal);
  SET LOCAL ROLE authenticated;
  EXECUTE 'SELECT (' || p_expr || ')::text' INTO r;
  RESET ROLE; PERFORM set_config('request.jwt.claims', '{}', true); PERFORM set_config('request.jwt.claim.sub', '', true);
  RETURN r;
EXCEPTION WHEN OTHERS THEN
  RESET ROLE; PERFORM set_config('request.jwt.claims', '{}', true); PERFORM set_config('request.jwt.claim.sub', '', true);
  RETURN 'ERROR: ' || SQLERRM;
END $$;
GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA mt TO anon, authenticated;

DO $$
DECLARE
  rto_admin uuid := mt.admin(mt.org('a'));
  op uuid := mt.admin(mt.org('op'));
  r text;
  sess jsonb;
BEGIN
  -- An RTO administrator (holds every RTO workspace) is never a platform operator.
  PERFORM mt.ok((SELECT count(DISTINCT workspace) FROM public.user_workspace_access WHERE user_id = rto_admin) >= 3,
                'synthetic RTO administrator holds all three RTO workspaces');
  PERFORM mt.ok(mt.as_user(rto_admin, 'aal1', 'public.is_platform_operator()') = 'false', 'RTO administrator is not an operator (aal1)');
  PERFORM mt.ok(mt.as_user(rto_admin, 'aal2', 'public.is_platform_operator()') = 'false', 'RTO administrator is not an operator even with MFA');
  PERFORM mt.ok(mt.as_user(rto_admin, 'aal2', '(SELECT count(*) FROM public.list_organisations_for_support())') = '0',
                'RTO administrator cannot list organisations for support');
  r := mt.as_user(rto_admin, 'aal2', format('public.start_operator_support_session(%L::uuid, %L)', mt.org('b'), 'trying to reach another RTO'));
  PERFORM mt.ok(r LIKE 'ERROR: platform operator access with MFA is required%', 'RTO administrator cannot start a support session');

  -- Grants are console-only: refused from any signed-in API session.
  r := mt.as_user(rto_admin, 'aal2', format('public.grant_platform_operator(%L, %L)', 'admin-a@example.invalid', 'self-grant attempt from the API'));
  PERFORM mt.ok(r LIKE 'ERROR:%', 'grant_platform_operator is refused from the API');

  -- Console grant (no signed-in user), then MFA is still required.
  PERFORM public.grant_platform_operator('operator@example.invalid', 'synthetic operator for the staging rehearsal');
  PERFORM mt.ok(mt.as_user(op, 'aal1', 'public.is_platform_operator()') = 'false', 'granted operator without MFA is not an operator');
  PERFORM mt.ok(mt.as_user(op, 'aal1', '(SELECT count(*) FROM public.list_organisations_for_support())') = '0', 'no organisation list without MFA');
  PERFORM mt.ok(mt.as_user(op, 'aal2', 'public.is_platform_operator()') = 'true', 'granted operator with MFA is an operator');
  PERFORM mt.ok(mt.as_user(op, 'aal2', '(SELECT count(*) FROM public.list_organisations_for_support())')::int >= 4, 'operator with MFA can list organisations');

  -- Support sessions need a reason and are time-limited.
  r := mt.as_user(op, 'aal2', format('public.start_operator_support_session(%L::uuid, %L)', mt.org('b'), 'short'));
  PERFORM mt.ok(r LIKE 'ERROR: a support reason of at least 10 characters is required%', 'support session needs a real reason');
  r := mt.as_user(op, 'aal2', format('public.start_operator_support_session(%L::uuid, %L, 120)', mt.org('b'), 'checking a reported problem'));
  PERFORM mt.ok(r LIKE 'ERROR: support sessions last between 5 and 60 minutes%', 'support sessions are capped at 60 minutes');
  r := mt.as_user(op, 'aal2', format('public.start_operator_support_session(%L::uuid, %L, 15)', mt.org('b'), 'checking a reported problem'));
  PERFORM mt.ok(r NOT LIKE 'ERROR:%', 'operator with MFA can start a support session: ' || r);
  PERFORM mt.ok(mt.as_user(op, 'aal2', '(public.active_operator_support_session()).organisation_id') = mt.org('b')::text,
                'active support session is scoped to the chosen RTO');
  r := mt.as_user(op, 'aal2', 'public.end_operator_support_session()');
  PERFORM mt.ok(r NOT LIKE 'ERROR:%', 'operator can end the support session');

  -- Revocation takes effect immediately.
  PERFORM public.revoke_platform_operator('operator@example.invalid', 'rehearsal finished, removing access');
  PERFORM mt.ok(mt.as_user(op, 'aal2', 'public.is_platform_operator()') = 'false', 'revoked operator loses access even with MFA');

  -- The LLND Mate wrapper follows Issue #45 exactly.
  PERFORM mt.ok(mt.as_user(op, 'aal2', 'public.llnd_is_platform_operator()') = 'false', 'llnd_is_platform_operator follows revocation');
  PERFORM mt.ok(NOT has_function_privilege('anon', 'public.is_platform_operator()', 'EXECUTE'), 'anonymous callers cannot check operator status');

  RAISE NOTICE 'ALL PLATFORM OPERATOR CHECKS PASSED';
END $$;
