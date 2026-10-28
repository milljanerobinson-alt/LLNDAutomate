/* Issue #45 — platform-operator access and audited RTO support sessions.

   Product Owner decisions (28 October 2026): mandatory MFA; support sessions
   of up to 60 minutes with a mandatory reason and an end option; an RTO-visible
   support-access log without secrets or internal diagnostics; read-only RTO
   support initially; legacy admin-based EIOS access removed; a separate
   operator test account; secrets remain server-only.

   What this migration does:
   1. Operator grants live in platform_operators. No browser or API role can
      read or change them. grant_platform_operator / revoke_platform_operator
      can only be run by the database owner (Supabase SQL Editor), and every
      grant and revoke is written to platform_operator_audit. Holding all RTO
      workspaces never confers operator status.
   2. is_platform_operator() is true only for an active grant AND an MFA-verified
      session (JWT aal = 'aal2').
   3. Support sessions: start_operator_support_session(organisation, reason)
      (operator only; reason required; at most 60 minutes; one active session),
      end_operator_support_session(), and platform_operator_status() for the
      interface banner. All session events are written to operator_access_audit.
      Reading RTO data during a session happens only in the operator-support
      Edge Function: it confirms the session with the operator's own token,
      records the access through record_operator_access() (attributed from the
      token), then reads that one organisation's customer-safe data read-only.
      No browser or server role can write the grant or audit tables directly.
   4. list_platform_support_access(): Administration of an RTO sees platform
      support sessions for its own organisation (who, when, reason, kinds of
      information viewed). No secrets, no internal diagnostics.
   5. EIOS/platform tables (engineering families plus explicitly named EIOS
      tables) lose every existing policy - including the anon/authenticated
      "USING (true)" policies and legacy admin-role policies - and get one policy
      allowing only platform operators. anon loses all table privileges on them.
      EIOS views become security_invoker so the same rule applies through them.
      The EIOS OAuth consent page may still append its own consent record.
      LLND customer tables are not touched.

   Requires: the Issue #40 migrations, including 20261028130000.
   Before applying to a shared environment: run
   supabase/inspection/issue040_staging_inspection.sql, take a Supabase
   backup/PITR recovery point, and confirm the list of EIOS tables this migration
   will lock (issue045_eios_tables_preview() below can be run first, read-only).
   After applying, nobody - including the Product Owner - has EIOS access until
   grant_platform_operator() is run in the SQL Editor.
*/

BEGIN;

DO $$
BEGIN
  IF to_regprocedure('public.current_organisation_id()') IS NULL
     OR to_regprocedure('public.has_workspace_access(text)') IS NULL
     OR to_regclass('public.organisation_settings') IS NULL THEN
    RAISE EXCEPTION 'Issue #45 preflight: Issue #40 migrations (including 20261028130000) are not installed';
  END IF;
END $$;

-- ── 1. Operator grants (owner-only process) ───────────────────────────────
CREATE TABLE IF NOT EXISTS public.platform_operators (
  user_id uuid PRIMARY KEY REFERENCES auth.users(id) ON DELETE RESTRICT,
  granted_at timestamptz NOT NULL DEFAULT now(),
  granted_by text NOT NULL,
  grant_reason text NOT NULL CHECK (length(trim(grant_reason)) >= 10),
  revoked_at timestamptz,
  revoked_by text,
  revoke_reason text
);
CREATE TABLE IF NOT EXISTS public.platform_operator_audit (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL,
  action text NOT NULL CHECK (action IN ('granted','revoked')),
  reason text NOT NULL,
  performed_by text NOT NULL,
  performed_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE public.platform_operators ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.platform_operator_audit ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.platform_operators, public.platform_operator_audit FROM PUBLIC, anon, authenticated, service_role;

CREATE OR REPLACE FUNCTION public.grant_platform_operator(p_email text, p_reason text)
RETURNS uuid LANGUAGE plpgsql SECURITY INVOKER SET search_path = pg_catalog, public AS $$
DECLARE target uuid;
BEGIN
  -- Owner-only: refuse any call that carries an end-user identity.
  IF auth.uid() IS NOT NULL THEN RAISE EXCEPTION 'platform operator grants are managed in the database console only'; END IF;
  IF p_reason IS NULL OR length(trim(p_reason)) < 10 THEN RAISE EXCEPTION 'a grant reason of at least 10 characters is required'; END IF;
  SELECT id INTO target FROM auth.users WHERE lower(email) = lower(trim(p_email));
  IF target IS NULL THEN RAISE EXCEPTION 'no user with that email'; END IF;
  INSERT INTO public.platform_operators (user_id, granted_by, grant_reason)
  VALUES (target, session_user, p_reason)
  ON CONFLICT (user_id) DO UPDATE SET granted_at = now(), granted_by = session_user,
    grant_reason = EXCLUDED.grant_reason, revoked_at = NULL, revoked_by = NULL, revoke_reason = NULL;
  INSERT INTO public.platform_operator_audit (user_id, action, reason, performed_by)
  VALUES (target, 'granted', p_reason, session_user);
  RETURN target;
END $$;

CREATE OR REPLACE FUNCTION public.revoke_platform_operator(p_email text, p_reason text)
RETURNS uuid LANGUAGE plpgsql SECURITY INVOKER SET search_path = pg_catalog, public AS $$
DECLARE target uuid;
BEGIN
  IF auth.uid() IS NOT NULL THEN RAISE EXCEPTION 'platform operator grants are managed in the database console only'; END IF;
  IF p_reason IS NULL OR length(trim(p_reason)) < 10 THEN RAISE EXCEPTION 'a revoke reason of at least 10 characters is required'; END IF;
  SELECT id INTO target FROM auth.users WHERE lower(email) = lower(trim(p_email));
  IF target IS NULL THEN RAISE EXCEPTION 'no user with that email'; END IF;
  UPDATE public.platform_operators SET revoked_at = now(), revoked_by = session_user, revoke_reason = p_reason
  WHERE user_id = target AND revoked_at IS NULL;
  IF NOT FOUND THEN RAISE EXCEPTION 'that user is not an active platform operator'; END IF;
  INSERT INTO public.platform_operator_audit (user_id, action, reason, performed_by)
  VALUES (target, 'revoked', p_reason, session_user);
  UPDATE public.operator_support_sessions SET ended_at = now(), end_reason = 'revoked'
  WHERE operator_user_id = target AND ended_at IS NULL;
  RETURN target;
END $$;

REVOKE ALL ON FUNCTION public.grant_platform_operator(text, text) FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.revoke_platform_operator(text, text) FROM PUBLIC, anon, authenticated, service_role;

-- ── 2. Operator check (grant + MFA) ───────────────────────────────────────
CREATE OR REPLACE FUNCTION public.is_platform_operator()
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public AS $$
  SELECT auth.uid() IS NOT NULL
     AND coalesce(auth.jwt() ->> 'aal', '') = 'aal2'
     AND EXISTS (SELECT 1 FROM public.platform_operators o
                 WHERE o.user_id = auth.uid() AND o.revoked_at IS NULL)
$$;
REVOKE ALL ON FUNCTION public.is_platform_operator() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.is_platform_operator() TO authenticated;

-- ── 3. Support sessions and access audit ──────────────────────────────────
CREATE TABLE IF NOT EXISTS public.operator_support_sessions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  operator_user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE RESTRICT,
  organisation_id uuid NOT NULL REFERENCES public.organisations(id) ON DELETE CASCADE,
  reason text NOT NULL CHECK (length(trim(reason)) >= 10),
  started_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL,
  ended_at timestamptz,
  end_reason text CHECK (end_reason IN ('ended','superseded','revoked')),
  CHECK (expires_at > started_at AND expires_at <= started_at + interval '60 minutes')
);
CREATE UNIQUE INDEX IF NOT EXISTS operator_one_open_session
  ON public.operator_support_sessions(operator_user_id) WHERE ended_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_operator_sessions_org ON public.operator_support_sessions(organisation_id, started_at DESC);

CREATE TABLE IF NOT EXISTS public.operator_access_audit (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  session_id uuid REFERENCES public.operator_support_sessions(id) ON DELETE SET NULL,
  operator_user_id uuid NOT NULL,
  organisation_id uuid REFERENCES public.organisations(id) ON DELETE CASCADE,
  action text NOT NULL,
  resource text,
  record_count integer,
  rto_visible boolean NOT NULL DEFAULT true,
  occurred_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_operator_audit_org ON public.operator_access_audit(organisation_id, occurred_at DESC);
ALTER TABLE public.operator_support_sessions ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.operator_access_audit ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.operator_support_sessions, public.operator_access_audit FROM PUBLIC, anon, authenticated, service_role;

CREATE OR REPLACE FUNCTION public.active_operator_support_session()
RETURNS TABLE (session_id uuid, organisation_id uuid, organisation_name text, reason text, started_at timestamptz, expires_at timestamptz)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public AS $$
  SELECT s.id, s.organisation_id, o.name, s.reason, s.started_at, s.expires_at
  FROM public.operator_support_sessions s JOIN public.organisations o ON o.id = s.organisation_id
  WHERE public.is_platform_operator() AND s.operator_user_id = auth.uid()
    AND s.ended_at IS NULL AND s.expires_at > now()
$$;
REVOKE ALL ON FUNCTION public.active_operator_support_session() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.active_operator_support_session() TO authenticated;

CREATE OR REPLACE FUNCTION public.start_operator_support_session(p_organisation_id uuid, p_reason text, p_minutes integer DEFAULT 60)
RETURNS TABLE (session_id uuid, organisation_id uuid, organisation_name text, reason text, started_at timestamptz, expires_at timestamptz)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE new_id uuid; minutes integer := coalesce(p_minutes, 60);
BEGIN
  IF NOT public.is_platform_operator() THEN RAISE EXCEPTION 'platform operator access with MFA is required'; END IF;
  IF p_reason IS NULL OR length(trim(p_reason)) < 10 THEN RAISE EXCEPTION 'a support reason of at least 10 characters is required'; END IF;
  IF minutes < 5 OR minutes > 60 THEN RAISE EXCEPTION 'support sessions last between 5 and 60 minutes'; END IF;
  IF NOT EXISTS (SELECT 1 FROM public.organisations o WHERE o.id = p_organisation_id) THEN
    RAISE EXCEPTION 'organisation not found';
  END IF;
  -- Close any open (or lapsed) session first.
  UPDATE public.operator_support_sessions s SET ended_at = now(), end_reason = 'superseded'
  WHERE s.operator_user_id = auth.uid() AND s.ended_at IS NULL;
  INSERT INTO public.operator_support_sessions (operator_user_id, organisation_id, reason, expires_at)
  VALUES (auth.uid(), p_organisation_id, trim(p_reason), now() + make_interval(mins => minutes))
  RETURNING id INTO new_id;
  INSERT INTO public.operator_access_audit (session_id, operator_user_id, organisation_id, action, resource)
  VALUES (new_id, auth.uid(), p_organisation_id, 'session_started', NULL);
  RETURN QUERY SELECT * FROM public.active_operator_support_session();
END $$;
REVOKE ALL ON FUNCTION public.start_operator_support_session(uuid, text, integer) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.start_operator_support_session(uuid, text, integer) TO authenticated;

CREATE OR REPLACE FUNCTION public.end_operator_support_session()
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE s record;
BEGIN
  IF auth.uid() IS NULL THEN RAISE EXCEPTION 'sign-in required'; END IF;
  FOR s IN UPDATE public.operator_support_sessions x SET ended_at = now(), end_reason = 'ended'
           WHERE x.operator_user_id = auth.uid() AND x.ended_at IS NULL
           RETURNING x.id, x.organisation_id LOOP
    INSERT INTO public.operator_access_audit (session_id, operator_user_id, organisation_id, action, resource)
    VALUES (s.id, auth.uid(), s.organisation_id, 'session_ended', NULL);
  END LOOP;
END $$;
REVOKE ALL ON FUNCTION public.end_operator_support_session() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.end_operator_support_session() TO authenticated;

-- Called by the operator-support Edge Function with the operator's own JWT
-- before it returns any RTO information. The record is attributed from the
-- token (auth.uid()) and the active session, so it cannot name anyone else.
CREATE OR REPLACE FUNCTION public.record_operator_access(p_resource text, p_record_count integer DEFAULT NULL, p_rto_visible boolean DEFAULT true)
RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE s record;
BEGIN
  IF NOT public.is_platform_operator() THEN RAISE EXCEPTION 'platform operator access with MFA is required'; END IF;
  SELECT * INTO s FROM public.active_operator_support_session() LIMIT 1;
  IF s.session_id IS NULL THEN RAISE EXCEPTION 'no active support session'; END IF;
  IF p_resource IS NULL OR p_resource !~ '^[a-z_]{3,40}$' THEN RAISE EXCEPTION 'invalid resource name'; END IF;
  INSERT INTO public.operator_access_audit (session_id, operator_user_id, organisation_id, action, resource, record_count, rto_visible)
  VALUES (s.session_id, auth.uid(), s.organisation_id, 'viewed', p_resource, p_record_count, coalesce(p_rto_visible, true));
  RETURN s.organisation_id;
END $$;
REVOKE ALL ON FUNCTION public.record_operator_access(text, integer, boolean) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.record_operator_access(text, integer, boolean) TO authenticated;

-- Interface status: whether the caller holds a grant, whether MFA is
-- satisfied, and the active session. Reveals nothing about other users.
CREATE OR REPLACE FUNCTION public.platform_operator_status()
RETURNS jsonb LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public AS $$
  SELECT jsonb_build_object(
    'granted', EXISTS (SELECT 1 FROM public.platform_operators o WHERE o.user_id = auth.uid() AND o.revoked_at IS NULL),
    'mfa_verified', coalesce(auth.jwt() ->> 'aal', '') = 'aal2',
    'operator', public.is_platform_operator(),
    'session', (SELECT to_jsonb(a) FROM public.active_operator_support_session() a LIMIT 1))
$$;
REVOKE ALL ON FUNCTION public.platform_operator_status() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.platform_operator_status() TO authenticated;

-- Operators may see the organisation list to choose whom to support.
CREATE OR REPLACE FUNCTION public.list_organisations_for_support()
RETURNS TABLE (organisation_id uuid, organisation_name text, created_at timestamptz)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public AS $$
  SELECT o.id, o.name, o.created_at FROM public.organisations o
  WHERE public.is_platform_operator() ORDER BY o.name, o.created_at
$$;
REVOKE ALL ON FUNCTION public.list_organisations_for_support() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.list_organisations_for_support() TO authenticated;

-- ── 4. RTO-visible support-access log ─────────────────────────────────────
CREATE OR REPLACE FUNCTION public.list_platform_support_access()
RETURNS TABLE (session_id uuid, operator_name text, reason text, started_at timestamptz,
               ended_at timestamptz, information_viewed text[])
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public AS $$
  SELECT s.id,
         'LLND Automate platform support — ' || coalesce(nullif(p.full_name, ''), 'operator'),
         s.reason, s.started_at, coalesce(s.ended_at, least(s.expires_at, now())),
         coalesce((SELECT array_agg(DISTINCT a.resource ORDER BY a.resource)
                   FROM public.operator_access_audit a
                   WHERE a.session_id = s.id AND a.rto_visible AND a.resource IS NOT NULL), ARRAY[]::text[])
  FROM public.operator_support_sessions s
  LEFT JOIN public.profiles p ON p.id = s.operator_user_id
  WHERE s.organisation_id = public.current_organisation_id()
    AND public.has_workspace_access('administration')
  ORDER BY s.started_at DESC
$$;
REVOKE ALL ON FUNCTION public.list_platform_support_access() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.list_platform_support_access() TO authenticated;

-- ── 5. EIOS/platform tables: platform operators only ──────────────────────
CREATE OR REPLACE FUNCTION public.issue045_is_eios_relation(p_name text)
RETURNS boolean LANGUAGE sql IMMUTABLE SET search_path = pg_catalog AS $$
  SELECT p_name ~ '^(ecc_|eig_|eil_|eios_|eip_|eine_|elpm_|engineering_|ewo_|execution_|codex_|atd_|cc_|pis_|epre_|github_|supervised_|implementation_|integrity_|historical_|knowledge_|constitutional_|repository_|ai_|builder_|feature_|idea_|governed_|verification_|mcp_|oauth_|v_ewo_)'
      OR p_name IN ('protected_components','po_decisions','duplicate_intelligence_records',
                    'lifecycle_reconciliation_log','eaee_feature_evidence','eaee_audit_log','eaee_analyses',
                    'architecture_guardian_reviews','conversation_routing_diagnostics','draft_knowledge_packages',
                    'po_acceptance_governance_log','po_acceptance_governance_tokens','po_identity_principles')
$$;

-- Read-only preview of what section 5 will lock (run before applying).
CREATE OR REPLACE FUNCTION public.issue045_eios_tables_preview()
RETURNS TABLE (relation text, kind text, policies integer)
LANGUAGE sql STABLE SET search_path = pg_catalog, public AS $$
  SELECT c.relname::text, CASE c.relkind WHEN 'v' THEN 'view' WHEN 'm' THEN 'materialized view' ELSE 'table' END,
         (SELECT count(*)::int FROM pg_policies p WHERE p.schemaname = 'public' AND p.tablename = c.relname)
  FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
  WHERE n.nspname = 'public' AND c.relkind IN ('r','p','v','m') AND public.issue045_is_eios_relation(c.relname)
  ORDER BY 1
$$;
REVOKE ALL ON FUNCTION public.issue045_eios_tables_preview() FROM PUBLIC, anon, authenticated;

DO $$
DECLARE rel record; pol record;
BEGIN
  FOR rel IN
    SELECT c.relname, c.relkind FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'public' AND c.relkind IN ('r','p','v','m') AND public.issue045_is_eios_relation(c.relname)
  LOOP
    EXECUTE format('REVOKE ALL ON TABLE public.%I FROM anon', rel.relname);
    IF rel.relkind IN ('r','p') THEN
      FOR pol IN SELECT policyname FROM pg_policies WHERE schemaname = 'public' AND tablename = rel.relname LOOP
        EXECUTE format('DROP POLICY %I ON public.%I', pol.policyname, rel.relname);
      END LOOP;
      EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY', rel.relname);
      EXECUTE format('CREATE POLICY platform_operator_access ON public.%I FOR ALL TO authenticated USING ((SELECT public.is_platform_operator())) WITH CHECK ((SELECT public.is_platform_operator()))', rel.relname);
    ELSIF rel.relkind = 'v' THEN
      EXECUTE format('ALTER VIEW public.%I SET (security_invoker = true)', rel.relname);
    ELSE
      EXECUTE format('REVOKE ALL ON TABLE public.%I FROM authenticated', rel.relname);
    END IF;
  END LOOP;
END $$;

-- The EIOS OAuth consent page records each consent decision for the signed-in
-- user, who may not have completed MFA yet. Append-only; no read access.
DO $$
BEGIN
  IF to_regclass('public.atd_connect_inspection_log') IS NOT NULL THEN
    CREATE POLICY oauth_consent_self_insert ON public.atd_connect_inspection_log FOR INSERT TO authenticated
      WITH CHECK (request_source = 'oauth_consent' AND requesting_persona = auth.uid()::text);
  END IF;
END $$;

COMMIT;
