-- Database integration tests: LLND Mate Free (10 invitations sent per month),
-- Test Test exemption, soft deletion, restoration and platform reporting.
--
-- Run only against a DISPOSABLE local database with every migration applied and
-- Issue #45's platform-operator migration installed (CI does this). Each check
-- raises on failure; psql runs with ON_ERROR_STOP.

\set ON_ERROR_STOP on
SET client_min_messages = notice;
SET request.jwt.claims = '{}';
SET request.headers = '{}';

CREATE SCHEMA IF NOT EXISTS mt;
CREATE OR REPLACE FUNCTION mt.ok(cond boolean, msg text) RETURNS void LANGUAGE plpgsql AS $$
BEGIN IF cond IS DISTINCT FROM true THEN RAISE EXCEPTION 'FAIL: %', msg; END IF; RAISE NOTICE 'PASS: %', msg; END $$;

-- Real signup path: auth.users insert -> handle_new_user -> RTO, admin membership, Free entitlement.
CREATE OR REPLACE FUNCTION mt.signup(p_email text, p_org text) RETURNS uuid LANGUAGE plpgsql AS $$
DECLARE uid uuid := gen_random_uuid(); org uuid;
BEGIN
  INSERT INTO auth.users (id, instance_id, aud, role, email, raw_user_meta_data, created_at, updated_at)
  VALUES (uid, '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', p_email,
          jsonb_build_object('organisation_name', p_org, 'full_name', p_org || ' admin'), now(), now());
  SELECT organisation_id INTO org FROM public.organisation_memberships WHERE user_id = uid;
  RETURN org;
END $$;
CREATE TABLE mt.orgs (name text PRIMARY KEY, id uuid);
CREATE TABLE mt.ids (k text PRIMARY KEY, id uuid);
CREATE OR REPLACE FUNCTION mt.org(p text) RETURNS uuid LANGUAGE sql AS $$ SELECT id FROM mt.orgs WHERE name = p $$;
CREATE OR REPLACE FUNCTION mt.id(p text) RETURNS uuid LANGUAGE sql AS $$ SELECT id FROM mt.ids WHERE k = p $$;
CREATE OR REPLACE FUNCTION mt.admin(p_org uuid) RETURNS uuid LANGUAGE sql AS $$ SELECT user_id FROM public.organisation_memberships WHERE organisation_id = p_org LIMIT 1 $$;

-- Act as a signed-in user for the rest of the current transaction.
CREATE OR REPLACE FUNCTION mt.act_as(p_user uuid, p_aal text DEFAULT 'aal1') RETURNS void LANGUAGE plpgsql AS $$
BEGIN
  PERFORM set_config('request.jwt.claims', json_build_object('sub', p_user, 'role', 'authenticated', 'aal', p_aal)::text, true);
  PERFORM set_config('request.jwt.claim.sub', p_user::text, true);
END $$;

-- Create an invitation as the RTO's own administrator through the API role (RLS + triggers).
CREATE OR REPLACE FUNCTION mt.invite(p_org uuid, p_name text DEFAULT 'Jordan Learner', p_email text DEFAULT 'learner@example.invalid') RETURNS uuid
LANGUAGE plpgsql AS $$
DECLARE new_id uuid := gen_random_uuid();
BEGIN
  PERFORM mt.act_as(mt.admin(p_org));
  SET LOCAL ROLE authenticated;
  INSERT INTO public.assessment_invitations (id, organisation_id, candidate_email, candidate_name, lln_token, digital_token, lln_status, digital_status, status)
  VALUES (new_id, p_org, p_email, p_name, gen_random_uuid(), gen_random_uuid(), 'pending', 'pending', 'sent');
  RESET ROLE;
  PERFORM set_config('request.jwt.claims', '{}', true);
  PERFORM set_config('request.jwt.claim.sub', '', true);
  RETURN new_id;
EXCEPTION WHEN OTHERS THEN
  RESET ROLE;
  PERFORM set_config('request.jwt.claims', '{}', true);
  PERFORM set_config('request.jwt.claim.sub', '', true);
  RAISE;
END $$;

-- Delete as the RTO's administrator through the RPC.
CREATE OR REPLACE FUNCTION mt.del(p_org uuid, p_inv uuid, p_confirm text DEFAULT 'YES') RETURNS jsonb LANGUAGE plpgsql AS $$
DECLARE r jsonb;
BEGIN
  PERFORM mt.act_as(mt.admin(p_org));
  SET LOCAL ROLE authenticated;
  r := public.delete_assessment_assignment(p_inv, p_confirm);
  RESET ROLE; PERFORM set_config('request.jwt.claims', '{}', true); PERFORM set_config('request.jwt.claim.sub', '', true);
  RETURN r;
EXCEPTION WHEN OTHERS THEN
  RESET ROLE; PERFORM set_config('request.jwt.claims', '{}', true); PERFORM set_config('request.jwt.claim.sub', '', true);
  RAISE;
END $$;

CREATE OR REPLACE FUNCTION mt.used(p_org uuid) RETURNS integer LANGUAGE sql AS $$
  SELECT coalesce((SELECT chargeable_sent - refunded FROM public.organisation_usage_periods
    WHERE organisation_id = p_org AND period_month = public.llnd_usage_period_month(now())), 0) $$;
CREATE OR REPLACE FUNCTION mt.ledger_net(p_org uuid) RETURNS integer LANGUAGE sql AS $$
  SELECT count(*)::int FROM public.organisation_invitation_ledger
  WHERE organisation_id = p_org AND period_month = public.llnd_usage_period_month(now()) AND chargeable AND refunded_at IS NULL $$;
CREATE OR REPLACE FUNCTION mt.refused(stmt text, expected text) RETURNS boolean LANGUAGE plpgsql AS $$
BEGIN
  EXECUTE stmt;
  RETURN false;
EXCEPTION WHEN OTHERS THEN
  RESET ROLE;
  IF SQLERRM <> expected THEN RAISE NOTICE 'unexpected error: % (wanted %)', SQLERRM, expected; RETURN false; END IF;
  RETURN true;
END $$;

GRANT USAGE ON SCHEMA mt TO anon, authenticated;
GRANT SELECT ON ALL TABLES IN SCHEMA mt TO anon, authenticated;
GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA mt TO anon, authenticated;

INSERT INTO mt.orgs VALUES
  ('a', mt.signup('admin-a@example.invalid', 'RTO A')),
  ('b', mt.signup('admin-b@example.invalid', 'RTO B')),
  ('c', mt.signup('admin-c@example.invalid', 'RTO C')),
  ('op', mt.signup('operator@example.invalid', 'Operator home RTO'));
SELECT public.grant_platform_operator('operator@example.invalid', 'metering integration test');
INSERT INTO mt.ids VALUES ('operator', mt.admin(mt.org('op')));

-- ── Reserved test identity ───────────────────────────────────────────────
SELECT mt.ok(public.llnd_is_reserved_test_name(n), 'is a test name: ' || quote_literal(n))
FROM unnest(ARRAY['Test Test', 'test test', 'TEST TEST', '  Test   Test  ', E'Test\tTest', E'Test\u00a0Test', E'Test\u200b Test', E'\uff34est \uff34est']) AS n;
SELECT mt.ok(NOT public.llnd_is_reserved_test_name(n), 'is NOT a test name: ' || quote_literal(coalesce(n, 'NULL')))
FROM unnest(ARRAY['Test Testerson', 'Testa Test', 'Test Test Smith', 'TestTest', 'Test-Test', 'Test', 'Tess Test', 'Testy McTest', '', NULL]) AS n;

-- ── 1. Ten genuine invitations accepted, the eleventh refused ────────────
DO $$
DECLARE a uuid := mt.org('a'); n int;
BEGIN
  FOR n IN 1..10 LOOP INSERT INTO mt.ids VALUES ('a' || n, mt.invite(a)); END LOOP;
  PERFORM mt.ok(mt.used(a) = 10 AND mt.ledger_net(a) = 10, '10 genuine invitations accepted (10/10)');
  PERFORM mt.ok(mt.refused(format('SELECT mt.invite(%L)', a), 'invitation_allowance_reached'), 'the 11th genuine invitation is refused');
  PERFORM mt.ok(mt.used(a) = 10, 'a refused invitation does not count');
  PERFORM mt.ok(mt.refused(format('INSERT INTO public.assessment_invitations (organisation_id, candidate_email, candidate_name) VALUES (%L, ''x@example.invalid'', ''Direct Insert'')', a), 'invitation_allowance_reached'),
    'direct insert (service or API path) is refused at the limit too');
END $$;

-- Resends and failed attempts do not count.
DO $$
DECLARE c uuid := mt.org('c'); i uuid; before int;
BEGIN
  i := mt.invite(c);
  before := mt.used(c);
  INSERT INTO public.email_queue (organisation_id, recipient_email, invitation_id, email_type, idempotency_key) VALUES ((SELECT organisation_id FROM public.assessment_invitations WHERE id = i), 'learner@example.invalid', i, 'invitation', gen_random_uuid()::text);
  INSERT INTO public.email_queue (organisation_id, recipient_email, invitation_id, email_type, idempotency_key) VALUES ((SELECT organisation_id FROM public.assessment_invitations WHERE id = i), 'learner@example.invalid', i, 'invitation', gen_random_uuid()::text);
  PERFORM mt.ok(mt.used(c) = before, 'resending an invitation does not use another spot');
  PERFORM mt.ok(mt.refused(format('INSERT INTO public.assessment_invitations (organisation_id, candidate_name) VALUES (%L, ''No Email'')', c), 'null value in column "candidate_email" of relation "assessment_invitations" violates not-null constraint')
    OR mt.used(c) = before, 'failed invitation insert is rolled back');
  PERFORM mt.ok(mt.used(c) = before AND mt.ledger_net(c) = before, 'a failed invitation attempt is not counted');
END $$;

-- ── Invited learners can start and finish after the limit ────────────────
DO $$
DECLARE i uuid := mt.id('a1');
BEGIN
  UPDATE public.assessment_invitations SET lln_status = 'in_progress', status = 'in_progress' WHERE id = i;
  UPDATE public.assessment_invitations SET lln_status = 'completed', status = 'completed' WHERE id = i;
  UPDATE public.assessment_invitations SET lln_status = 'in_progress' WHERE id = mt.id('a2');
  PERFORM mt.ok(mt.used(mt.org('a')) = 10, 'starting and completing invited assessments at 10/10 is allowed and does not change usage');
  PERFORM mt.ok((SELECT count(*) FROM public.organisation_usage_completions WHERE invitation_id = i) = 1, 'genuine completion recorded for paid-tier counting');
END $$;

-- ── 5. Test Test: unlimited, excluded ────────────────────────────────────
DO $$
DECLARE a uuid := mt.org('a'); n int; t uuid;
BEGIN
  FOR n IN 1..15 LOOP t := mt.invite(a, CASE n % 3 WHEN 0 THEN 'TEST  test' WHEN 1 THEN 'Test Test' ELSE ' test test ' END, 'rto.tester@example.invalid'); END LOOP;
  INSERT INTO mt.ids VALUES ('test1', t);
  PERFORM mt.ok(mt.used(a) = 10, '15 Test Test invitations at 10/10 accepted; usage still 10');
  PERFORM mt.ok((SELECT test_sent FROM public.organisation_usage_periods WHERE organisation_id = a AND period_month = public.llnd_usage_period_month(now())) = 15, 'test invitations tracked separately (15)');
  PERFORM mt.ok((SELECT is_test FROM public.assessment_invitations WHERE id = t), 'test flag set by the server');
  PERFORM mt.ok(mt.refused(format('SELECT mt.invite(%L, ''Test Testerson'')', a), 'invitation_allowance_reached'), '"Test Testerson" is a genuine learner and is refused at the limit');
END $$;

-- Client cannot claim the test flag for a genuine learner.
DO $$
DECLARE b uuid := mt.org('b'); i uuid := gen_random_uuid();
BEGIN
  PERFORM mt.act_as(mt.admin(b));
  SET LOCAL ROLE authenticated;
  INSERT INTO public.assessment_invitations (id, organisation_id, candidate_email, candidate_name, is_test)
  VALUES (i, b, 'real@example.invalid', 'Real Learner', true);
  RESET ROLE;
  PERFORM mt.ok(NOT (SELECT is_test FROM public.assessment_invitations WHERE id = i) AND mt.used(b) = 1, 'client-supplied is_test is ignored: genuine learner counted');
  INSERT INTO mt.ids VALUES ('b_genuine', i);
END $$;

-- ── 6. Test completions excluded from paid counts and legacy billing ─────
DO $$
DECLARE t uuid := mt.id('test1'); lln uuid; ia uuid;
BEGIN
  SELECT id INTO lln FROM public.assessments WHERE type = 'lln' ORDER BY created_at LIMIT 1;
  INSERT INTO public.invitation_assessments (invitation_id, assessment_id) VALUES (t, lln) RETURNING id INTO ia;
  UPDATE public.assessment_invitations SET lln_status = 'in_progress' WHERE id = t;
  UPDATE public.assessment_invitations SET lln_status = 'completed', status = 'completed' WHERE id = t;
  UPDATE public.invitation_assessments SET individual_status = 'completed' WHERE id = ia;
  PERFORM mt.ok((SELECT count(*) FROM public.organisation_usage_completions WHERE invitation_id = t) = 0, 'test completion not recorded for paid tiers');
  PERFORM mt.ok((SELECT count(*) FROM public.billable_learners WHERE invitation_id = t) = 0, 'test completion not recorded by legacy billing');
  PERFORM mt.ok((SELECT lln_status FROM public.assessment_invitations WHERE id = t) = 'completed', 'test assessment can still be completed and reviewed');
END $$;

-- Test assessments: no support case, no aXcelerate write-back; emails still allowed.
DO $$
DECLARE t uuid := mt.id('test1');
BEGIN
  INSERT INTO public.support_cases (organisation_id, invitation_id) VALUES (mt.org('a'), t);
  PERFORM mt.ok((SELECT count(*) FROM public.support_cases WHERE invitation_id = t) = 0, 'support-case automation suppressed for tests');
  INSERT INTO public.axcelerate_writeback_queue (organisation_id, invitation_id, event_type, idempotency_key) VALUES ((SELECT organisation_id FROM public.assessment_invitations WHERE id = t), t, 'assessment_completed', 'k-' || t);
  PERFORM mt.ok((SELECT count(*) FROM public.axcelerate_writeback_queue WHERE invitation_id = t) = 0, 'aXcelerate write-back suppressed for tests');
  INSERT INTO public.email_queue (organisation_id, recipient_email, invitation_id, email_type, idempotency_key) VALUES ((SELECT organisation_id FROM public.assessment_invitations WHERE id = t), 'learner@example.invalid', t, 'invitation', 'e-' || t);
  PERFORM mt.ok((SELECT count(*) FROM public.email_queue WHERE invitation_id = t) = 1, 'test learners still receive their invitation email');
END $$;

-- ── 7. Locked test identity; no conversion either way ────────────────────
DO $$
DECLARE a uuid := mt.org('a'); t uuid := mt.id('test1'); g uuid := mt.id('a3'); stmt text;
BEGIN
  FOREACH stmt IN ARRAY ARRAY[
    format('SELECT mt.act_as(mt.admin(%L)); SET LOCAL ROLE authenticated; UPDATE public.assessment_invitations SET candidate_name = ''Real Person'' WHERE id = %L', a, t),
    format('SELECT mt.act_as(mt.admin(%L)); SET LOCAL ROLE authenticated; UPDATE public.assessment_invitations SET student_id = gen_random_uuid() WHERE id = %L', a, t)
  ] LOOP
    PERFORM mt.ok(mt.refused(stmt, 'test_identity_locked'), 'test identity cannot be changed: ' || left(split_part(stmt, 'SET ', 3), 40));
  END LOOP;
  PERFORM mt.ok(mt.refused(format('SELECT mt.act_as(mt.admin(%L)); SET LOCAL ROLE authenticated; UPDATE public.assessment_invitations SET is_test = false WHERE id = %L', a, t), 'test_classification_locked'), 'test flag cannot be removed');
  PERFORM mt.ok(mt.refused(format('SELECT mt.act_as(mt.admin(%L)); SET LOCAL ROLE authenticated; UPDATE public.assessment_invitations SET is_test = true WHERE id = %L', a, g), 'test_classification_locked'), 'genuine assignment cannot be made a test');
  PERFORM mt.ok(mt.refused(format('UPDATE public.assessment_invitations SET candidate_name = ''Someone Else'' WHERE id = %L', t), 'test_identity_locked'), 'test identity locked for service and integration writes too');
  -- Renaming a genuine learner to "Test Test" does not make it free.
  UPDATE public.assessment_invitations SET candidate_name = 'Test Test' WHERE id = g;
  PERFORM mt.ok(NOT (SELECT is_test FROM public.assessment_invitations WHERE id = g) AND mt.used(a) = 10, 'renaming a genuine learner to Test Test does not reclassify or refund');
END $$;

-- ── 2, 3, 4. Deletion returns the spot once ──────────────────────────────
DO $$
DECLARE a uuid := mt.org('a'); r jsonb;
BEGIN
  PERFORM mt.ok(mt.refused(format('SELECT mt.del(%L, %L, ''yes'')', a, mt.id('a2')), 'confirmation_required'), 'deletion requires exactly YES (lowercase refused)');
  PERFORM mt.ok(mt.refused(format('SELECT mt.del(%L, %L, '''')', a, mt.id('a2')), 'confirmation_required'), 'deletion requires exactly YES (empty refused)');
  PERFORM mt.ok(mt.refused(format('SELECT mt.del(%L, %L, NULL)', a, mt.id('a2')), 'confirmation_required'), 'deletion requires exactly YES (missing refused)');
  r := mt.del(a, mt.id('a2'));  -- started (in progress)
  PERFORM mt.ok(r->>'status' = 'deleted' AND (r->>'allowance_refunded')::boolean AND mt.used(a) = 9, 'deleting a started assessment returns its spot (9/10)');
  r := mt.del(a, mt.id('a1'));  -- completed
  PERFORM mt.ok((r->>'allowance_refunded')::boolean AND mt.used(a) = 8, 'deleting a completed assessment returns its spot (8/10)');
  r := mt.del(a, mt.id('a1'));
  PERFORM mt.ok(r->>'status' = 'already_deleted' AND NOT (r->>'allowance_refunded')::boolean AND mt.used(a) = 8, 'repeated deletion cannot refund twice');
  PERFORM mt.ok(mt.used(a) = mt.ledger_net(a), 'counter equals ledger after deletions');
  r := mt.del(a, mt.id('test1'));
  PERFORM mt.ok(NOT (r->>'allowance_refunded')::boolean AND mt.used(a) = 8, 'deleting a Test Test assessment does not change usage');
  PERFORM mt.ok((SELECT deleted_prior_status FROM public.assessment_invitations WHERE id = mt.id('a1')) = 'completed'
            AND (SELECT deleted_prior_status FROM public.assessment_invitations WHERE id = mt.id('a2')) = 'in_progress', 'status before deletion recorded');
  PERFORM mt.ok((SELECT deleted_by FROM public.assessment_invitations WHERE id = mt.id('a1')) = mt.admin(a)
            AND (SELECT count(*) FROM public.assessment_assignment_events WHERE invitation_id = mt.id('a1') AND action = 'deleted') = 1, 'who deleted and when recorded once');
END $$;

-- Gross vs net: 15 sent, 5 deleted in the same month -> gross 15, net 10.
DO $$
DECLARE c uuid := mt.signup('admin-g@example.invalid', 'RTO Gross'); n int; ids uuid[] := '{}';
BEGIN
  INSERT INTO mt.orgs VALUES ('g', c);
  FOR n IN 1..10 LOOP ids := ids || mt.invite(c); END LOOP;
  FOR n IN 1..5 LOOP PERFORM mt.del(c, ids[n]); END LOOP;
  FOR n IN 1..5 LOOP PERFORM mt.invite(c); END LOOP;
  PERFORM mt.ok(mt.used(c) = 10, 'after 15 sent and 5 deleted the RTO is at 10/10');
  PERFORM mt.ok(mt.refused(format('SELECT mt.invite(%L)', c), 'invitation_allowance_reached'), 'and the next genuine invitation is refused');
END $$;

-- ── 8. Old-month deletion does not grant a current-month spot ────────────
DO $$
DECLARE b uuid := mt.org('b'); old uuid := mt.invite(b); prev date := (public.llnd_usage_period_month(now()) - interval '1 month')::date; r jsonb; before int;
BEGIN
  -- Move this invitation's issue into last month, as if sent then.
  UPDATE public.organisation_invitation_ledger SET period_month = prev, issued_at = now() - interval '35 days' WHERE invitation_id = old;
  UPDATE public.organisation_usage_periods SET chargeable_sent = chargeable_sent - 1 WHERE organisation_id = b AND period_month = public.llnd_usage_period_month(now());
  INSERT INTO public.organisation_usage_periods (organisation_id, period_month, chargeable_sent) VALUES (b, prev, 1)
  ON CONFLICT (organisation_id, period_month) DO UPDATE SET chargeable_sent = organisation_usage_periods.chargeable_sent + 1;
  before := mt.used(b);
  r := mt.del(b, old);
  PERFORM mt.ok(r->>'status' = 'deleted' AND NOT (r->>'allowance_refunded')::boolean AND mt.used(b) = before, 'deleting last month''s invitation gives no extra spot this month');
  PERFORM mt.ok((SELECT refunded FROM public.organisation_usage_periods WHERE organisation_id = b AND period_month = prev) = 0, 'last month''s usage is not changed either');
  INSERT INTO mt.ids VALUES ('b_old', old);
END $$;

-- Monthly reset: last month at 10/10 does not restrict this month.
DO $$
DECLARE c uuid := mt.org('c'); prev date := (public.llnd_usage_period_month(now()) - interval '1 month')::date;
BEGIN
  INSERT INTO public.organisation_usage_periods (organisation_id, period_month, chargeable_sent) VALUES (c, prev, 10)
  ON CONFLICT (organisation_id, period_month) DO UPDATE SET chargeable_sent = 10;
  PERFORM mt.invite(c);
  PERFORM mt.ok(true, 'an RTO full last month can invite this month (allowance resets monthly)');
END $$;

-- ── 11. Deleted learner links cannot access the assessment ───────────────
DO $$
DECLARE i uuid := mt.id('a2'); tok uuid; n int;
BEGIN
  SELECT lln_token INTO tok FROM public.assessment_invitations WHERE id = i;
  PERFORM set_config('request.headers', json_build_object('x-quiz-token', tok::text)::text, true);
  PERFORM set_config('request.jwt.claims', '{"role":"anon"}', true);
  SET LOCAL ROLE anon;
  SELECT count(*) INTO n FROM public.assessment_invitations WHERE id = i;
  UPDATE public.assessment_invitations SET lln_status = 'completed' WHERE id = i;
  GET DIAGNOSTICS n = ROW_COUNT;
  RESET ROLE;
  PERFORM mt.ok(n = 0, 'deleted assignment: learner link can neither read nor update it');
  PERFORM mt.ok((SELECT lln_status FROM public.assessment_invitations WHERE id = i) = 'in_progress', 'learner progress preserved unchanged for restoration');
  PERFORM set_config('request.headers', '{}', true); PERFORM set_config('request.jwt.claims', '{}', true);
END $$;

-- Deleted assignments disappear for RTO staff; hard delete and deletion fields are locked.
DO $$
DECLARE a uuid := mt.org('a'); n int;
BEGIN
  PERFORM mt.act_as(mt.admin(a));
  SET LOCAL ROLE authenticated;
  SELECT count(*) INTO n FROM public.assessment_invitations WHERE id IN (mt.id('a1'), mt.id('a2'));
  RESET ROLE;
  PERFORM mt.ok(n = 0, 'deleted assignments are hidden from the RTO');
  PERFORM mt.act_as(mt.admin(a));
  SET LOCAL ROLE authenticated;
  DELETE FROM public.assessment_invitations WHERE id = mt.id('a5');
  GET DIAGNOSTICS n = ROW_COUNT;
  RESET ROLE;
  PERFORM mt.ok(n = 0 AND EXISTS (SELECT 1 FROM public.assessment_invitations WHERE id = mt.id('a5')), 'hard delete through the API removes nothing');
  PERFORM mt.ok(mt.refused(format('SELECT mt.act_as(mt.admin(%L)); SET LOCAL ROLE authenticated; UPDATE public.assessment_invitations SET deleted_at = now() WHERE id = %L', a, mt.id('a6')), 'deletion_fields_locked'),
    'deletion fields cannot be written directly (no deletion without the RPC and its refund rules)');
END $$;

-- Pending emails and write-backs are cancelled on deletion; new ones are suppressed.
DO $$
DECLARE c uuid := mt.org('c'); i uuid := mt.invite(c);
BEGIN
  INSERT INTO public.email_queue (organisation_id, recipient_email, invitation_id, email_type, idempotency_key) VALUES ((SELECT organisation_id FROM public.assessment_invitations WHERE id = i), 'learner@example.invalid', i, 'reminder_1', 'r-' || i);
  INSERT INTO public.axcelerate_writeback_queue (organisation_id, invitation_id, event_type, idempotency_key) VALUES ((SELECT organisation_id FROM public.assessment_invitations WHERE id = i), i, 'invitation_sent', 'w-' || i);
  PERFORM mt.del(c, i);
  PERFORM mt.ok((SELECT status FROM public.email_queue WHERE invitation_id = i) = 'cancelled', 'pending reminder cancelled on deletion');
  PERFORM mt.ok((SELECT status FROM public.axcelerate_writeback_queue WHERE invitation_id = i) = 'cancelled', 'pending aXcelerate write-back cancelled on deletion');
  INSERT INTO public.email_queue (organisation_id, recipient_email, invitation_id, email_type, idempotency_key) VALUES ((SELECT organisation_id FROM public.assessment_invitations WHERE id = i), 'learner@example.invalid', i, 'reminder_2', 'r2-' || i);
  INSERT INTO public.axcelerate_writeback_queue (organisation_id, invitation_id, event_type, idempotency_key) VALUES ((SELECT organisation_id FROM public.assessment_invitations WHERE id = i), i, 'assessment_completed', 'w2-' || i);
  INSERT INTO public.support_cases (organisation_id, invitation_id) VALUES (c, i);
  PERFORM mt.ok((SELECT count(*) FROM public.email_queue WHERE invitation_id = i) = 1
            AND (SELECT count(*) FROM public.axcelerate_writeback_queue WHERE invitation_id = i) = 1
            AND (SELECT count(*) FROM public.support_cases WHERE invitation_id = i) = 0, 'no new email, write-back or support case for a deleted assignment');
END $$;

-- ── 12. Cross-RTO access denied ──────────────────────────────────────────
DO $$
DECLARE a uuid := mt.org('a'); b uuid := mt.org('b'); n int;
BEGIN
  PERFORM mt.ok(mt.refused(format('SELECT mt.del(%L, %L)', b, mt.id('a6')), 'not_found'), 'RTO B cannot delete RTO A''s assessment');
  PERFORM mt.act_as(mt.admin(b));
  SET LOCAL ROLE authenticated;
  SELECT count(*) INTO n FROM public.organisation_invitation_ledger WHERE organisation_id <> b;
  RESET ROLE;
  PERFORM mt.ok(n = 0, 'RTO B cannot read other RTOs'' invitation ledger');
  PERFORM mt.ok(mt.refused(format('SELECT mt.act_as(mt.admin(%L), ''aal2''); SET LOCAL ROLE authenticated; SELECT public.restore_assessment_assignment(%L)', a, mt.id('a1')), 'not_authorised'),
    'an RTO administrator (even with MFA) cannot restore');
  PERFORM mt.ok(mt.refused(format('SELECT mt.act_as(mt.admin(%L), ''aal2''); SET LOCAL ROLE authenticated; SELECT count(*) FROM public.platform_invitation_usage()', a), 'not_authorised'),
    'an RTO administrator cannot see cross-RTO usage');
  PERFORM mt.ok(mt.refused(format('SELECT mt.act_as(%L, ''aal1''); SET LOCAL ROLE authenticated; SELECT count(*) FROM public.platform_deleted_assessments()', mt.id('operator')), 'not_authorised'),
    'a platform operator without an MFA session is refused');
  PERFORM mt.ok(mt.refused('SET LOCAL ROLE anon; SELECT public.get_my_plan_usage()', 'permission denied for function get_my_plan_usage'), 'anon cannot read plan usage');
END $$;

-- ── 9, 10. Restoration ───────────────────────────────────────────────────
DO $$
DECLARE a uuid := mt.org('a'); i uuid := mt.id('a1'); r jsonb; before int := mt.used(a); n int;
BEGIN
  PERFORM mt.act_as(mt.id('operator'), 'aal2');
  SET LOCAL ROLE authenticated;
  r := public.restore_assessment_assignment(i, 'Fee arranged, ticket 123');
  RESET ROLE;
  PERFORM mt.ok(r->>'status' = 'restored' AND mt.used(a) = before, 'restoring does not consume another spot');
  PERFORM mt.act_as(mt.id('operator'), 'aal2');
  SET LOCAL ROLE authenticated;
  r := public.restore_assessment_assignment(i);
  RESET ROLE;
  PERFORM mt.ok(r->>'status' = 'already_active' AND (SELECT count(*) FROM public.assessment_assignment_events WHERE invitation_id = i AND action = 'restored') = 1, 'restoration is idempotent');
  PERFORM mt.ok((SELECT lln_status = 'completed' AND status = 'completed' AND restored_by = mt.id('operator') AND deleted_at IS NULL FROM public.assessment_invitations WHERE id = i),
    'restored assessment keeps its original results and records who restored it');
  PERFORM mt.act_as(mt.admin(a));
  SET LOCAL ROLE authenticated;
  SELECT count(*) INTO n FROM public.assessment_invitations WHERE id = i;
  RESET ROLE;
  PERFORM mt.ok(n = 1, 'restored assessment is visible to the RTO again');
  PERFORM mt.act_as(mt.id('operator'), 'aal2');
  SET LOCAL ROLE authenticated;
  r := public.restore_assessment_assignment(mt.id('test1'));
  RESET ROLE;
  PERFORM mt.ok((SELECT is_test FROM public.assessment_invitations WHERE id = mt.id('test1')), 'restoration preserves the test classification');
  PERFORM mt.ok((SELECT count(*) FROM public.email_queue WHERE invitation_id = i AND status = 'pending') = 0
            AND (SELECT count(*) FROM public.axcelerate_writeback_queue WHERE invitation_id = i) = 0, 'restoration sends nothing and triggers no integration');
END $$;

-- Restoring past the allowance is allowed.
DO $$
DECLARE g uuid := mt.org('g'); victim uuid; r jsonb;
BEGIN
  SELECT invitation_id INTO victim FROM public.organisation_invitation_ledger WHERE organisation_id = g AND refunded_at IS NOT NULL LIMIT 1;
  PERFORM mt.act_as(mt.id('operator'), 'aal2');
  SET LOCAL ROLE authenticated;
  r := public.restore_assessment_assignment(victim);
  RESET ROLE;
  PERFORM mt.ok(r->>'status' = 'restored' AND mt.used(g) = 10, 'restoration allowed even with 10 active (now 11 visible, usage stays 10)');
END $$;

-- ── 13. Platform statistics ──────────────────────────────────────────────
DO $$
DECLARE r record; d record;
BEGIN
  PERFORM mt.act_as(mt.id('operator'), 'aal2');
  SET LOCAL ROLE authenticated;
  SELECT * INTO r FROM public.platform_invitation_usage(NULL, 'RTO Gross');
  SELECT * INTO d FROM public.platform_invitation_usage(NULL, 'RTO A');
  RESET ROLE;
  PERFORM mt.ok(r.month_invitations_sent = 15 AND r.month_net_usage = 10 AND r.month_remaining = 0 AND r.total_invitations_sent = 15,
    'platform: RTO Gross shows 15 sent (gross), 10/10 net usage, 0 remaining');
  PERFORM mt.ok(r.deleted_invitations = 4 AND r.restored_assessments = 1 AND r.counter_consistent, 'platform: deleted and restored counts, counters consistent');
  PERFORM mt.ok(d.month_test_invitations = 15 AND d.month_net_usage = 8 AND d.completed_assessments >= 1, 'platform: RTO A tests separate (15), net 8, completed counted');
END $$;
DO $$
DECLARE n int; c int;
BEGIN
  PERFORM mt.act_as(mt.id('operator'), 'aal2');
  SET LOCAL ROLE authenticated;
  SELECT count(*), count(*) FILTER (WHERE prior_status = 'in_progress') INTO n, c FROM public.platform_deleted_assessments('RTO A');
  RESET ROLE;
  PERFORM mt.ok(n >= 1 AND c >= 1, 'platform: deleted assessments searchable by RTO with status before deletion');
END $$;

-- ── RTO Plan & usage read model ──────────────────────────────────────────
DO $$
DECLARE r jsonb;
BEGIN
  PERFORM mt.act_as(mt.admin(mt.org('a')));
  SET LOCAL ROLE authenticated;
  r := public.get_my_plan_usage();
  RESET ROLE;
  PERFORM mt.ok(r->>'state' = 'ok' AND (r->>'consistent')::boolean AND r->'plan'->>'unit' = 'invitations', 'Plan & usage: ok, consistent, invitation-based');
  PERFORM mt.ok((r->'usage'->>'used')::int = 8 AND (r->'usage'->>'remaining')::int = 2 AND (r->'usage'->>'sent_this_month')::int = 10
            AND (r->'usage'->>'returned_by_deletion')::int = 2 AND (r->'usage'->>'test_invitations')::int = 15, 'Plan & usage: used 8, remaining 2, sent 10, returned 2, tests 15');
END $$;

SELECT 'ALL INVITATION METERING CHECKS PASSED' AS result;
