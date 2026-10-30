-- Two-RTO isolation check for a DISPOSABLE rehearsal database only.
-- Creates two fictional RTOs, staff and learners inside a transaction, checks
-- row level security from each RTO's point of view, then ROLLS BACK, so no
-- synthetic data remains. Never run against a hosted environment.
--   psql "$DB_URL" -X -v ON_ERROR_STOP=1 -f rehearsal-isolation-check.sql
\set ON_ERROR_STOP on
\pset footer off
\pset tuples_only on
\pset format unaligned

BEGIN;

CREATE TEMP TABLE iso_check (seq serial, name text, ok boolean, detail text);
GRANT ALL ON iso_check TO authenticated, anon;
GRANT ALL ON SEQUENCE iso_check_seq_seq TO authenticated, anon;

-- Fictional RTO administrators created through the normal self-signup path
-- (handle_new_user creates one organisation per signup).
INSERT INTO auth.users (id, instance_id, aud, role, email, encrypted_password, raw_app_meta_data, raw_user_meta_data, created_at, updated_at)
VALUES
  ('a0000000-0000-4000-8000-00000000000a', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated',
   'admin.rto-a@example.test', '', '{}', '{"organisation_name":"Wattle Ridge Training (TEST)","full_name":"RTO A Admin Test"}', now(), now()),
  ('b0000000-0000-4000-8000-00000000000b', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated',
   'admin.rto-b@example.test', '', '{}', '{"organisation_name":"Banksia Coast College (TEST)","full_name":"RTO B Admin Test"}', now(), now());

INSERT INTO iso_check (name, ok, detail)
SELECT 'fixture: two fictional RTOs created by self-signup', count(*) = 2, string_agg(name, ' | ' ORDER BY name)
FROM public.organisations;

INSERT INTO iso_check (name, ok, detail)
SELECT 'fixture: each admin holds all three workspaces in their own RTO only',
       count(*) = 6 AND count(DISTINCT (user_id, organisation_id)) = 2, format('%s workspace grants', count(*))
FROM public.user_workspace_access;

-- One fictional learner per RTO (inserted as the database owner with an explicit owner).
INSERT INTO public.students (id, first_name, last_name, email, organisation_id)
SELECT 'a1000000-0000-4000-8000-00000000000a', 'Avery', 'Testlearner', 'learner.a@example.test', o.id
FROM public.organisations o WHERE o.created_by = 'a0000000-0000-4000-8000-00000000000a';
INSERT INTO public.students (id, first_name, last_name, email, organisation_id)
SELECT 'b1000000-0000-4000-8000-00000000000b', 'Blake', 'Testlearner', 'learner.b@example.test', o.id
FROM public.organisations o WHERE o.created_by = 'b0000000-0000-4000-8000-00000000000b';

-- RTO A's view ----------------------------------------------------------------------
SET LOCAL ROLE authenticated;
SELECT set_config('request.jwt.claims', '{"sub":"a0000000-0000-4000-8000-00000000000a","role":"authenticated"}', true);

INSERT INTO iso_check (name, ok, detail)
SELECT 'RTO A sees only its own organisation', count(*) = 1 AND bool_and(name LIKE 'Wattle Ridge%'), string_agg(name, ', ')
FROM public.organisations;

INSERT INTO iso_check (name, ok, detail)
SELECT 'RTO A sees only its own learner', count(*) = 1 AND bool_and(id = 'a1000000-0000-4000-8000-00000000000a'), format('%s visible', count(*))
FROM public.students;

INSERT INTO iso_check (name, ok, detail)
SELECT 'RTO A cannot see RTO B memberships or workspace grants',
       (SELECT count(*) FROM public.organisation_memberships WHERE user_id = 'b0000000-0000-4000-8000-00000000000b') = 0
   AND (SELECT count(*) FROM public.user_workspace_access WHERE user_id = 'b0000000-0000-4000-8000-00000000000b') = 0,
       'cross-tenant staff rows hidden';

WITH upd AS (
  UPDATE public.students SET last_name = 'Tampered' WHERE id = 'b1000000-0000-4000-8000-00000000000b' RETURNING 1
)
INSERT INTO iso_check (name, ok, detail)
SELECT 'RTO A cannot update RTO B learner', count(*) = 0, format('%s rows updated', count(*)) FROM upd;

DO $$
DECLARE v_owner uuid; v_msg text := 'insert accepted';
BEGIN
  BEGIN
    INSERT INTO public.students (id, first_name, last_name, organisation_id)
    VALUES ('a2000000-0000-4000-8000-00000000000a', 'Own', 'Tenant',
            (SELECT organisation_id FROM public.students WHERE id = 'a1000000-0000-4000-8000-00000000000a'));
  EXCEPTION WHEN OTHERS THEN v_msg := SQLERRM;
  END;
  SELECT organisation_id INTO v_owner FROM public.students WHERE id = 'a2000000-0000-4000-8000-00000000000a';
  INSERT INTO iso_check (name, ok, detail)
  VALUES ('RTO A administrator can add a learner to its own RTO', v_owner IS NOT NULL, v_msg);
END $$;

DO $$
DECLARE v_msg text := 'no error'; v_count integer;
BEGIN
  BEGIN
    INSERT INTO public.students (id, first_name, last_name, organisation_id)
    SELECT 'a3000000-0000-4000-8000-00000000000a', 'Wrong', 'Owner', o.id
    FROM public.organisations o WHERE o.created_by = 'b0000000-0000-4000-8000-00000000000b';
  EXCEPTION WHEN OTHERS THEN v_msg := SQLERRM;
  END;
  RESET ROLE;
  SELECT count(*) INTO v_count FROM public.students s JOIN public.organisations o ON o.id = s.organisation_id
  WHERE s.id = 'a3000000-0000-4000-8000-00000000000a' AND o.created_by = 'b0000000-0000-4000-8000-00000000000b';
  SET LOCAL ROLE authenticated;
  INSERT INTO iso_check (name, ok, detail)
  VALUES ('RTO A cannot create a learner owned by RTO B', v_count = 0, v_msg);
END $$;

-- RTO B's view ----------------------------------------------------------------------
SELECT set_config('request.jwt.claims', '{"sub":"b0000000-0000-4000-8000-00000000000b","role":"authenticated"}', true);

INSERT INTO iso_check (name, ok, detail)
SELECT 'RTO B sees only its own organisation', count(*) = 1 AND bool_and(name LIKE 'Banksia Coast%'), string_agg(name, ', ')
FROM public.organisations;

INSERT INTO iso_check (name, ok, detail)
SELECT 'RTO B sees only its own learner', count(*) = 1 AND bool_and(id = 'b1000000-0000-4000-8000-00000000000b'), format('%s visible', count(*))
FROM public.students;

-- Signed-out (anon) view -------------------------------------------------------------
RESET ROLE;
SET LOCAL ROLE anon;
SELECT set_config('request.jwt.claims', '{"role":"anon"}', true);
INSERT INTO iso_check (name, ok, detail)
SELECT 'anon sees no organisations or learners',
       (SELECT count(*) FROM public.organisations) = 0 AND (SELECT count(*) FROM public.students) = 0, 'anon read';

-- Platform operator status is never implied by holding all three workspaces -----------
RESET ROLE;
INSERT INTO iso_check (name, ok, detail)
SELECT 'holding all three workspaces does not make an admin a platform operator',
       (SELECT count(*) FROM public.platform_operators) = 0, format('%s platform operators', (SELECT count(*) FROM public.platform_operators));

SELECT CASE WHEN ok THEN 'PASS' ELSE 'FAIL' END || ' | ' || name || ' | ' || coalesce(detail, '')
FROM iso_check ORDER BY seq;

DO $$
DECLARE v_failed integer;
BEGIN
  SELECT count(*) INTO v_failed FROM iso_check WHERE NOT ok;
  IF v_failed > 0 THEN RAISE EXCEPTION 'isolation check failed: % check(s)', v_failed; END IF;
  RAISE NOTICE 'isolation check passed: % checks (all synthetic data rolled back)', (SELECT count(*) FROM iso_check);
END $$;

ROLLBACK;
