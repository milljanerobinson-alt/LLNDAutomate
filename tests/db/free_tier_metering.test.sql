-- Database integration tests: LLND Mate Free-tier metering and start restriction.
--
-- Run against a disposable local database that has every migration applied
-- (CI: local Supabase stack + clean-install bootstrap). Never run against a hosted
-- project. Each check raises on failure; psql runs with ON_ERROR_STOP.
--
-- Fixtures are created through the real signup path (an auth.users insert fires
-- handle_new_user, which creates the RTO, its admin membership and, through this
-- migration, the Free entitlement).

\set ON_ERROR_STOP on
SET client_min_messages = notice;
-- Valid empty request context for the whole session. Transaction-local overrides
-- below revert to these values (an unset custom setting would revert to '', which
-- some existing functions cannot parse as JSON).
SET request.jwt.claims = '{}';
SET request.headers = '{}';

CREATE SCHEMA IF NOT EXISTS metering_test;

CREATE OR REPLACE FUNCTION metering_test.ok(cond boolean, msg text) RETURNS void
LANGUAGE plpgsql AS $$
BEGIN
  IF cond IS DISTINCT FROM true THEN RAISE EXCEPTION 'FAIL: %', msg; END IF;
  RAISE NOTICE 'PASS: %', msg;
END $$;

-- Signs up an RTO admin through auth.users and returns the new organisation id.
CREATE OR REPLACE FUNCTION metering_test.signup(p_email text, p_org text) RETURNS uuid
LANGUAGE plpgsql AS $$
DECLARE uid uuid := gen_random_uuid(); org uuid;
BEGIN
  INSERT INTO auth.users (id, instance_id, aud, role, email, raw_user_meta_data, created_at, updated_at)
  VALUES (uid, '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', p_email,
          jsonb_build_object('organisation_name', p_org, 'full_name', p_org || ' admin'), now(), now());
  SELECT organisation_id INTO org FROM public.organisation_memberships WHERE user_id = uid;
  RETURN org;
END $$;

CREATE OR REPLACE FUNCTION metering_test.user_of(p_org uuid) RETURNS uuid
LANGUAGE sql AS $$ SELECT user_id FROM public.organisation_memberships WHERE organisation_id = p_org LIMIT 1 $$;

-- A pending assignment (both modules), as staff or an integration would create it.
CREATE OR REPLACE FUNCTION metering_test.assignment(p_org uuid, p_email text DEFAULT 'learner@example.invalid') RETURNS uuid
LANGUAGE plpgsql AS $$
DECLARE id uuid;
BEGIN
  INSERT INTO public.assessment_invitations (organisation_id, candidate_email, candidate_name,
    lln_token, digital_token, lln_status, digital_status, status)
  VALUES (p_org, p_email, 'Test Learner', gen_random_uuid(), gen_random_uuid(), 'pending', 'pending', 'sent')
  RETURNING assessment_invitations.id INTO id;
  RETURN id;
END $$;

CREATE OR REPLACE FUNCTION metering_test.used(p_org uuid) RETURNS integer
LANGUAGE sql AS $$
  SELECT coalesce((SELECT completed_count FROM public.organisation_usage_periods
    WHERE organisation_id = p_org AND period_month = public.llnd_usage_period_month(now())), 0)
$$;
CREATE OR REPLACE FUNCTION metering_test.ledger(p_org uuid) RETURNS integer
LANGUAGE sql AS $$
  SELECT count(*)::int FROM public.organisation_usage_completions
  WHERE organisation_id = p_org AND period_month = public.llnd_usage_period_month(now())
$$;

-- Learner (no login) acting through the token link, exactly as the browser does.
CREATE OR REPLACE FUNCTION metering_test.as_learner(p_invitation uuid, p_module text) RETURNS void
LANGUAGE plpgsql AS $$
DECLARE tok uuid;
BEGIN
  SELECT CASE p_module WHEN 'lln' THEN lln_token WHEN 'digital' THEN digital_token ELSE unique_token END
    INTO tok FROM public.assessment_invitations WHERE id = p_invitation;
  PERFORM set_config('request.headers', json_build_object('x-quiz-token', tok::text)::text, true);
  PERFORM set_config('request.jwt.claims', '{"role":"anon"}', true);
END $$;

GRANT USAGE ON SCHEMA metering_test TO anon, authenticated;
GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA metering_test TO anon, authenticated;

-- Organisations used below
CREATE TABLE metering_test.orgs (name text PRIMARY KEY, id uuid);
INSERT INTO metering_test.orgs VALUES
  ('a', metering_test.signup('admin-a@example.invalid', 'RTO A')),
  ('b', metering_test.signup('admin-b@example.invalid', 'RTO B')),
  ('c', metering_test.signup('admin-c@example.invalid', 'RTO C'));
CREATE OR REPLACE FUNCTION metering_test.org(p text) RETURNS uuid LANGUAGE sql AS $$ SELECT id FROM metering_test.orgs WHERE name = p $$;
GRANT SELECT ON metering_test.orgs TO anon, authenticated;

-- ── Month boundary ───────────────────────────────────────────────────────
SELECT metering_test.ok(public.llnd_usage_period_month('2026-11-30T13:59:59Z') = '2026-11-01', '23:59:59 AEST on 30 Nov is still November');
SELECT metering_test.ok(public.llnd_usage_period_month('2026-11-30T14:00:00Z') = '2026-12-01', '00:00 AEST on 1 Dec starts December');
SELECT metering_test.ok(public.llnd_usage_period_month('2026-12-31T14:00:00Z') = '2027-01-01', 'year boundary in AEST');
SELECT metering_test.ok(public.llnd_usage_period_month('2027-01-15T00:00:00+11:00') = '2027-01-01', 'Sydney daylight-saving input maps to the same AEST month');
SELECT metering_test.ok(public.llnd_usage_period_starts_at('2026-12-01') = '2026-11-30T14:00:00Z', 'December period starts 14:00 UTC on 30 Nov');
SET TIME ZONE 'America/Los_Angeles';
SELECT metering_test.ok(public.llnd_usage_period_month('2026-11-30T14:00:00Z') = '2026-12-01', 'boundary does not depend on the session time zone');
RESET TIME ZONE;

-- ── Free entitlement on signup ───────────────────────────────────────────
SELECT metering_test.ok((SELECT count(*) FROM public.organisation_plan_entitlements e
  WHERE e.organisation_id = metering_test.org('a') AND e.plan_code = 'llnd_mate_free'
    AND e.monthly_completion_allowance = 10 AND e.source = 'signup') = 1, 'signup creates exactly one LLND Mate Free entitlement (10/month)');
DO $$ BEGIN
  BEGIN
    INSERT INTO public.organisation_plan_entitlements (organisation_id, plan_code, monthly_completion_allowance, source)
    VALUES (gen_random_uuid(), 'llnd_mate_plus', 20, 'signup');
    RAISE EXCEPTION 'FAIL: paid plan code accepted';
  EXCEPTION WHEN check_violation OR foreign_key_violation THEN
    RAISE NOTICE 'PASS: paid plan codes cannot be stored (no paid billing activation)';
  END;
END $$;

-- ── Counting rules ───────────────────────────────────────────────────────
DO $$
DECLARE a uuid := metering_test.org('a'); i1 uuid; i2 uuid; i3 uuid; i4 uuid;
BEGIN
  i1 := metering_test.assignment(a, 'same.learner@example.invalid');
  PERFORM metering_test.ok(metering_test.used(a) = 0, 'invitation sent: 0');
  UPDATE public.assessment_invitations SET status = 'opened', opened_at = now() WHERE id = i1;
  PERFORM metering_test.ok(metering_test.used(a) = 0, 'invitation opened: 0');
  UPDATE public.assessment_invitations SET status = 'in_progress', lln_status = 'in_progress' WHERE id = i1;
  PERFORM metering_test.ok(metering_test.used(a) = 0, 'started, not completed: 0');
  UPDATE public.assessment_invitations SET lln_status = 'completed', status = 'completed' WHERE id = i1;
  PERFORM metering_test.ok(metering_test.used(a) = 1, 'LLN completed: 1');
  UPDATE public.assessment_invitations SET digital_status = 'in_progress' WHERE id = i1;
  UPDATE public.assessment_invitations SET digital_status = 'completed' WHERE id = i1;
  PERFORM metering_test.ok(metering_test.used(a) = 1, 'LLN + Digital under the same assignment: still 1');
  UPDATE public.assessment_invitations SET lln_status = 'completed', digital_status = 'completed', status = 'completed' WHERE id = i1;
  PERFORM metering_test.ok(metering_test.used(a) = 1, 'replayed completion: still 1');

  i2 := metering_test.assignment(a);
  UPDATE public.assessment_invitations SET digital_status = 'in_progress' WHERE id = i2;
  UPDATE public.assessment_invitations SET digital_status = 'completed' WHERE id = i2;
  PERFORM metering_test.ok(metering_test.used(a) = 2, 'Digital only: +1');

  i3 := metering_test.assignment(a, 'same.learner@example.invalid');
  UPDATE public.assessment_invitations SET lln_status = 'in_progress' WHERE id = i3;
  UPDATE public.assessment_invitations SET lln_status = 'completed' WHERE id = i3;
  PERFORM metering_test.ok(metering_test.used(a) = 3, 'same learner, second legitimate assignment: counted separately');

  i4 := metering_test.assignment(a);
  UPDATE public.assessment_invitations SET lln_status = 'in_progress' WHERE id = i4;
  PERFORM metering_test.ok(metering_test.used(a) = 3, 'abandoned (started, never completed): not counted');

  PERFORM metering_test.ok(metering_test.used(a) = metering_test.ledger(a), 'counter equals ledger');
  PERFORM metering_test.ok((SELECT first_completed_module FROM public.organisation_usage_completions WHERE invitation_id = i2) = 'digital', 'ledger records the first completed module');
END $$;

-- Legacy combined quiz link: modules complete through invitation_assessments only.
DO $$
DECLARE a uuid := metering_test.org('a'); inv uuid; lln uuid; dig uuid; ia1 uuid; ia2 uuid; before integer;
BEGIN
  SELECT id INTO lln FROM public.assessments WHERE type = 'lln' ORDER BY created_at LIMIT 1;
  SELECT id INTO dig FROM public.assessments WHERE type = 'digital' ORDER BY created_at LIMIT 1;
  IF lln IS NULL OR dig IS NULL THEN
    INSERT INTO public.assessments (type, title, status) VALUES ('lln', 'Test LLN', 'active') RETURNING id INTO lln;
    INSERT INTO public.assessments (type, title, status) VALUES ('digital', 'Test Digital', 'active') RETURNING id INTO dig;
  END IF;
  INSERT INTO public.assessment_invitations (organisation_id, candidate_email, candidate_name, status)
  VALUES (a, 'legacy@example.invalid', 'Legacy Learner', 'sent') RETURNING id INTO inv;
  INSERT INTO public.invitation_assessments (invitation_id, assessment_id) VALUES (inv, lln) RETURNING id INTO ia1;
  INSERT INTO public.invitation_assessments (invitation_id, assessment_id) VALUES (inv, dig) RETURNING id INTO ia2;
  before := metering_test.used(a);
  UPDATE public.invitation_assessments SET individual_status = 'in_progress' WHERE id = ia1;
  PERFORM metering_test.ok(metering_test.used(a) = before, 'legacy link: module started, not counted');
  UPDATE public.invitation_assessments SET individual_status = 'completed' WHERE id = ia1;
  PERFORM metering_test.ok(metering_test.used(a) = before + 1, 'legacy link: module completed counts');
  UPDATE public.invitation_assessments SET individual_status = 'completed' WHERE id = ia2;
  UPDATE public.assessment_invitations SET status = 'completed' WHERE id = inv;
  PERFORM metering_test.ok(metering_test.used(a) = before + 1, 'legacy link: second module and overall completion do not add');
END $$;

-- A failed transaction leaves no usage behind.
DO $$
DECLARE a uuid := metering_test.org('a'); i uuid := metering_test.assignment(a); before integer := metering_test.used(a);
BEGIN
  BEGIN
    UPDATE public.assessment_invitations SET lln_status = 'completed' WHERE id = i;
    RAISE EXCEPTION 'simulated failure after completion';
  EXCEPTION WHEN raise_exception THEN NULL;
  END;
  PERFORM metering_test.ok(metering_test.used(a) = before AND metering_test.ledger(a) = before, 'rolled-back completion is not counted');
  PERFORM metering_test.ok((SELECT lln_status FROM public.assessment_invitations WHERE id = i) = 'pending', 'rolled-back completion leaves the assignment pending');
END $$;

-- ── Learner token path (anon) ────────────────────────────────────────────
CREATE TABLE metering_test.ids (k text PRIMARY KEY, id uuid);
GRANT SELECT ON metering_test.ids TO anon, authenticated;
INSERT INTO metering_test.ids VALUES ('tok1', metering_test.assignment(metering_test.org('a')));

BEGIN;
SELECT metering_test.as_learner((SELECT id FROM metering_test.ids WHERE k = 'tok1'), 'lln');
SET LOCAL ROLE anon;
UPDATE public.assessment_invitations SET status = 'in_progress', lln_status = 'in_progress' WHERE id = (SELECT id FROM metering_test.ids WHERE k = 'tok1');
UPDATE public.assessment_invitations SET lln_status = 'completed', status = 'completed' WHERE id = (SELECT id FROM metering_test.ids WHERE k = 'tok1');
UPDATE public.assessment_invitations SET lln_status = 'completed' WHERE id = (SELECT id FROM metering_test.ids WHERE k = 'tok1');
COMMIT;
SELECT metering_test.ok((SELECT count(*) FROM public.organisation_usage_completions WHERE invitation_id = (SELECT id FROM metering_test.ids WHERE k = 'tok1')) = 1,
  'learner token path: start + completion + browser retry counts exactly once');

-- Direct API calls cannot write usage or entitlements, or call the internal functions.
DO $$
DECLARE r text; stmt text;
BEGIN
  FOREACH r IN ARRAY ARRAY['anon', 'authenticated'] LOOP
    FOREACH stmt IN ARRAY ARRAY[
      format('INSERT INTO public.organisation_usage_completions (organisation_id, invitation_id, period_month, first_completed_module) VALUES (%L, gen_random_uuid(), %L, ''lln'')', metering_test.org('b'), '2026-11-01'),
      format('UPDATE public.organisation_usage_periods SET completed_count = 0 WHERE organisation_id = %L', metering_test.org('a')),
      format('DELETE FROM public.organisation_usage_completions WHERE organisation_id = %L', metering_test.org('a')),
      format('UPDATE public.organisation_plan_entitlements SET monthly_completion_allowance = 1000 WHERE organisation_id = %L', metering_test.org('a')),
      format('INSERT INTO public.organisation_plan_entitlements (organisation_id, plan_code, monthly_completion_allowance, source) VALUES (%L, ''llnd_mate_free'', 1000, ''signup'')', gen_random_uuid()),
      format('SELECT public.llnd_mate_record_completion(%L, gen_random_uuid(), ''lln'')', metering_test.org('a')),
      format('SELECT public.llnd_mate_check_new_start(%L)', metering_test.org('a'))
    ] LOOP
      BEGIN
        EXECUTE format('SET LOCAL ROLE %I', r);
        EXECUTE stmt;
        RESET ROLE;
        RAISE EXCEPTION 'FAIL: % could run: %', r, stmt;
      EXCEPTION WHEN insufficient_privilege THEN
        RESET ROLE;
      END;
    END LOOP;
  END LOOP;
  RAISE NOTICE 'PASS: anon and authenticated cannot write usage, entitlements or call internal metering functions';
END $$;

-- ── Allowance reached: new starts refused, in-progress learners finish ───
DO $$
DECLARE b uuid := metering_test.org('b'); i uuid; n integer;
BEGIN
  -- one learner starts while there is room
  INSERT INTO metering_test.ids VALUES ('b_inprogress', metering_test.assignment(b));
  UPDATE public.assessment_invitations SET lln_status = 'in_progress', status = 'in_progress'
  WHERE id = (SELECT id FROM metering_test.ids WHERE k = 'b_inprogress');
  -- 10 completions
  FOR n IN 1..10 LOOP
    i := metering_test.assignment(b);
    UPDATE public.assessment_invitations SET lln_status = 'in_progress' WHERE id = i;
    UPDATE public.assessment_invitations SET lln_status = 'completed' WHERE id = i;
  END LOOP;
  PERFORM metering_test.ok(metering_test.used(b) = 10, 'RTO B reached 10 of 10');
  INSERT INTO metering_test.ids VALUES ('b_new', metering_test.assignment(b));
  PERFORM metering_test.ok(true, 'invitations can still be created at the limit (they do not count)');
END $$;

-- New starts refused on every path
DO $$
DECLARE i uuid := (SELECT id FROM metering_test.ids WHERE k = 'b_new'); stmt text; lln uuid; ia uuid;
BEGIN
  FOREACH stmt IN ARRAY ARRAY[
    format('UPDATE public.assessment_invitations SET lln_status = ''in_progress'', status = ''in_progress'' WHERE id = %L', i),
    format('UPDATE public.assessment_invitations SET digital_status = ''in_progress'' WHERE id = %L', i),
    format('UPDATE public.assessment_invitations SET lln_status = ''completed'' WHERE id = %L', i),
    format('UPDATE public.assessment_invitations SET status = ''in_progress'' WHERE id = %L', i),
    format('INSERT INTO public.assessment_invitations (organisation_id, candidate_email, candidate_name, lln_status) VALUES (%L, ''x@example.invalid'', ''X'', ''in_progress'')', metering_test.org('b'))
  ] LOOP
    BEGIN
      EXECUTE stmt;
      RAISE EXCEPTION 'FAIL: new start allowed at the limit: %', stmt;
    EXCEPTION WHEN raise_exception THEN
      IF SQLERRM <> 'assessment_start_unavailable' THEN RAISE; END IF;
    END;
  END LOOP;
  SELECT id INTO lln FROM public.assessments WHERE type = 'lln' ORDER BY created_at LIMIT 1;
  INSERT INTO public.invitation_assessments (invitation_id, assessment_id) VALUES (i, lln) RETURNING id INTO ia;
  BEGIN
    UPDATE public.invitation_assessments SET individual_status = 'in_progress' WHERE id = ia;
    RAISE EXCEPTION 'FAIL: legacy-link start allowed at the limit';
  EXCEPTION WHEN raise_exception THEN
    IF SQLERRM <> 'assessment_start_unavailable' THEN RAISE; END IF;
  END;
  PERFORM metering_test.ok((SELECT lln_status FROM public.assessment_invitations WHERE id = i) = 'pending', 'refused start leaves the assignment unchanged');
  RAISE NOTICE 'PASS: at the limit, new starts are refused on the LLN, Digital, direct-completion, status, insert and legacy paths';
END $$;

BEGIN;
SELECT metering_test.as_learner((SELECT id FROM metering_test.ids WHERE k = 'b_new'), 'lln');
SET LOCAL ROLE anon;
DO $$ BEGIN
  UPDATE public.assessment_invitations SET status = 'in_progress', lln_status = 'in_progress'
  WHERE id = (SELECT id FROM metering_test.ids WHERE k = 'b_new');
  RAISE EXCEPTION 'FAIL: learner token start allowed at the limit';
EXCEPTION WHEN raise_exception THEN
  IF SQLERRM <> 'assessment_start_unavailable' THEN RAISE; END IF;
  RAISE NOTICE 'PASS: learner token start refused with a generic message (no plan or usage details)';
END $$;
ROLLBACK;

DO $$
DECLARE b uuid := metering_test.org('b'); i uuid := (SELECT id FROM metering_test.ids WHERE k = 'b_inprogress');
BEGIN
  UPDATE public.assessment_invitations SET lln_status = 'completed' WHERE id = i;
  PERFORM metering_test.ok(true, 'learner already in progress can finish after the limit');
  UPDATE public.assessment_invitations SET digital_status = 'in_progress' WHERE id = i;
  UPDATE public.assessment_invitations SET digital_status = 'completed', status = 'completed' WHERE id = i;
  PERFORM metering_test.ok(true, 'second module of an already-started assignment can start and finish');
  PERFORM metering_test.ok(metering_test.used(b) = 11, 'in-progress completion after the limit is counted (11): approved rule, no reservation');
  PERFORM metering_test.ok(metering_test.used(b) = metering_test.ledger(b), 'counter equals ledger for RTO B');
END $$;

-- RTO isolation: B's limit does not affect A or C.
DO $$
DECLARE i uuid := metering_test.assignment(metering_test.org('c'));
BEGIN
  UPDATE public.assessment_invitations SET lln_status = 'in_progress' WHERE id = i;
  PERFORM metering_test.ok(true, 'another RTO can still start while RTO B is at its limit');
END $$;

-- Previous months do not count toward the current month.
DO $$
DECLARE c uuid := metering_test.org('c'); prev date := (public.llnd_usage_period_month(now()) - interval '1 month')::date; i uuid;
BEGIN
  INSERT INTO public.organisation_usage_periods (organisation_id, period_month, completed_count) VALUES (c, prev, 10);
  i := metering_test.assignment(c);
  UPDATE public.assessment_invitations SET lln_status = 'in_progress' WHERE id = i;
  PERFORM metering_test.ok(metering_test.used(c) = 0, 'last month at 10/10 does not restrict this month (monthly reset)');
END $$;

-- Missing entitlement: refused, never treated as Free.
DO $$
DECLARE c uuid := metering_test.org('c'); i uuid := metering_test.assignment(c);
BEGIN
  DELETE FROM public.organisation_plan_entitlements WHERE organisation_id = c;
  BEGIN
    UPDATE public.assessment_invitations SET lln_status = 'in_progress' WHERE id = i;
    RAISE EXCEPTION 'FAIL: start allowed without an entitlement';
  EXCEPTION WHEN raise_exception THEN
    IF SQLERRM <> 'assessment_start_unavailable' THEN RAISE; END IF;
  END;
  PERFORM metering_test.ok(true, 'no entitlement: new starts refused');
END $$;

-- ── Plan & usage read model and RTO isolation ────────────────────────────
CREATE OR REPLACE FUNCTION metering_test.usage_as(p_org text) RETURNS jsonb
LANGUAGE plpgsql AS $$
DECLARE r jsonb;
BEGIN
  PERFORM set_config('request.jwt.claims', json_build_object('sub', metering_test.user_of(metering_test.org(p_org)), 'role', 'authenticated')::text, true);
  PERFORM set_config('request.jwt.claim.sub', metering_test.user_of(metering_test.org(p_org))::text, true);
  SET LOCAL ROLE authenticated;
  r := public.get_my_plan_usage();
  RESET ROLE;
  RETURN r;
END $$;

BEGIN;
DO $$
DECLARE a jsonb := metering_test.usage_as('a'); b jsonb := metering_test.usage_as('b'); c jsonb := metering_test.usage_as('c');
BEGIN
  PERFORM metering_test.ok(a->>'state' = 'ok' AND a->'plan'->>'name' = 'LLND Mate' AND a->'plan'->>'tier' = 'Free', 'RTO A sees LLND Mate Free');
  PERFORM metering_test.ok((a->'usage'->>'completed')::int = metering_test.used(metering_test.org('a')), 'RTO A sees its own count');
  PERFORM metering_test.ok((a->'usage'->>'allowance')::int = 10 AND (a->'usage'->>'remaining')::int = 10 - metering_test.used(metering_test.org('a')), 'remaining = allowance - used');
  PERFORM metering_test.ok((a->'usage'->>'in_progress')::int >= 1, 'in-progress (abandoned) assignments are reported separately, not as completions');
  PERFORM metering_test.ok((a->>'consistent')::boolean, 'consistent flag true');
  PERFORM metering_test.ok((a->'period'->>'reset_date')::date = (public.llnd_usage_period_month(now()) + interval '1 month')::date, 'reset date is the first day of next AEST month');
  PERFORM metering_test.ok((b->'usage'->>'completed')::int = 11 AND (b->'usage'->>'remaining')::int = 0 AND (b->'usage'->>'new_starts_available')::boolean = false, 'RTO B sees 11 used, 0 remaining, new starts unavailable');
  PERFORM metering_test.ok(c->>'state' = 'no_entitlement' AND c->'plan' = 'null'::jsonb AND c->'usage'->'remaining' = 'null'::jsonb, 'RTO C without entitlement: no plan and no remaining figure');
END $$;
ROLLBACK;

-- RLS: an RTO admin reading the tables directly sees only their own RTO.
BEGIN;
SELECT set_config('request.jwt.claims', json_build_object('sub', metering_test.user_of(metering_test.org('a')), 'role', 'authenticated')::text, true);
SELECT set_config('request.jwt.claim.sub', metering_test.user_of(metering_test.org('a'))::text, true);
SET LOCAL ROLE authenticated;
SELECT metering_test.ok((SELECT count(*) FROM public.organisation_usage_completions WHERE organisation_id <> metering_test.org('a')) = 0, 'RLS: RTO A cannot read other RTOs'' usage ledger');
SELECT metering_test.ok((SELECT count(*) FROM public.organisation_usage_periods WHERE organisation_id <> metering_test.org('a')) = 0, 'RLS: RTO A cannot read other RTOs'' counters');
SELECT metering_test.ok((SELECT count(*) FROM public.organisation_plan_entitlements WHERE organisation_id <> metering_test.org('a')) = 0, 'RLS: RTO A cannot read other RTOs'' entitlements');
ROLLBACK;

-- Unauthenticated and non-member callers are refused.
BEGIN;
SET LOCAL ROLE anon;
DO $$ BEGIN
  PERFORM public.get_my_plan_usage();
  RAISE EXCEPTION 'FAIL: anon could read plan usage';
EXCEPTION WHEN insufficient_privilege THEN RAISE NOTICE 'PASS: anon cannot call get_my_plan_usage';
END $$;
ROLLBACK;
BEGIN;
SELECT set_config('request.jwt.claims', json_build_object('sub', gen_random_uuid(), 'role', 'authenticated')::text, true);
SELECT set_config('request.jwt.claim.sub', (current_setting('request.jwt.claims')::jsonb->>'sub'), true);
SET LOCAL ROLE authenticated;
DO $$ BEGIN
  PERFORM public.get_my_plan_usage();
  RAISE EXCEPTION 'FAIL: non-member could read plan usage';
EXCEPTION WHEN insufficient_privilege THEN RAISE NOTICE 'PASS: signed-in user with no RTO membership is refused';
END $$;
ROLLBACK;

-- Data inconsistency is reported, never hidden.
BEGIN;
UPDATE public.organisation_usage_periods SET completed_count = completed_count + 5
WHERE organisation_id = metering_test.org('a') AND period_month = public.llnd_usage_period_month(now());
DO $$
DECLARE a jsonb := metering_test.usage_as('a');
BEGIN
  PERFORM metering_test.ok((a->>'consistent')::boolean = false, 'counter/ledger mismatch is reported as inconsistent');
END $$;
ROLLBACK;

SELECT 'ALL METERING CHECKS PASSED' AS result;
