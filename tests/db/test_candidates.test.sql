-- Database integration tests: Create Test Candidate (server-allocated names, locked
-- identity, sending through the normal invitation path, exemptions, isolation).
-- Runs on a DISPOSABLE local database after tests/db/free_tier_invitations.test.sql
-- (reuses its mt.* helpers). Each check raises on failure.

\set ON_ERROR_STOP on
SET client_min_messages = notice;
SET request.jwt.claims = '{}';
SET request.headers = '{}';

-- Call an RPC as an RTO's administrator.
CREATE OR REPLACE FUNCTION mt.tc_create(p_org uuid, p_email text) RETURNS jsonb LANGUAGE plpgsql AS $$
DECLARE r jsonb;
BEGIN
  PERFORM mt.act_as(mt.admin(p_org));
  SET LOCAL ROLE authenticated;
  r := public.create_test_candidate(p_email);
  RESET ROLE; PERFORM set_config('request.jwt.claims', '{}', true); PERFORM set_config('request.jwt.claim.sub', '', true);
  RETURN r;
EXCEPTION WHEN OTHERS THEN
  RESET ROLE; PERFORM set_config('request.jwt.claims', '{}', true); PERFORM set_config('request.jwt.claim.sub', '', true);
  RAISE;
END $$;
CREATE OR REPLACE FUNCTION mt.tc_preview(p_org uuid) RETURNS text LANGUAGE plpgsql AS $$
DECLARE r text;
BEGIN
  PERFORM mt.act_as(mt.admin(p_org)); SET LOCAL ROLE authenticated;
  r := public.preview_next_test_candidate_name();
  RESET ROLE; PERFORM set_config('request.jwt.claims', '{}', true); PERFORM set_config('request.jwt.claim.sub', '', true);
  RETURN r;
END $$;
CREATE OR REPLACE FUNCTION mt.tc_delete(p_org uuid, p_id uuid, p_confirm text DEFAULT 'YES') RETURNS jsonb LANGUAGE plpgsql AS $$
DECLARE r jsonb;
BEGIN
  PERFORM mt.act_as(mt.admin(p_org)); SET LOCAL ROLE authenticated;
  r := public.delete_test_candidate(p_id, p_confirm);
  RESET ROLE; PERFORM set_config('request.jwt.claims', '{}', true); PERFORM set_config('request.jwt.claim.sub', '', true);
  RETURN r;
EXCEPTION WHEN OTHERS THEN
  RESET ROLE; PERFORM set_config('request.jwt.claims', '{}', true); PERFORM set_config('request.jwt.claim.sub', '', true);
  RAISE;
END $$;
-- Send an assessment to a test candidate exactly as the Candidates page does: a normal
-- invitation insert by the RTO administrator, with the test candidate's id. The client
-- deliberately sends a different name and email to prove the server ignores them.
CREATE OR REPLACE FUNCTION mt.tc_send(p_org uuid, p_tc uuid) RETURNS uuid LANGUAGE plpgsql AS $$
DECLARE new_id uuid := gen_random_uuid();
BEGIN
  PERFORM mt.act_as(mt.admin(p_org)); SET LOCAL ROLE authenticated;
  INSERT INTO public.assessment_invitations (id, organisation_id, candidate_email, candidate_name, test_candidate_id, lln_token, digital_token, lln_status, digital_status, status)
  VALUES (new_id, p_org, 'someone.real@example.invalid', 'Real Person', p_tc, gen_random_uuid(), gen_random_uuid(), 'pending', 'pending', 'sent');
  RESET ROLE; PERFORM set_config('request.jwt.claims', '{}', true); PERFORM set_config('request.jwt.claim.sub', '', true);
  RETURN new_id;
EXCEPTION WHEN OTHERS THEN
  RESET ROLE; PERFORM set_config('request.jwt.claims', '{}', true); PERFORM set_config('request.jwt.claim.sub', '', true);
  RAISE;
END $$;
GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA mt TO anon, authenticated;

INSERT INTO mt.orgs VALUES
  ('t1', mt.signup('t1@example.invalid', 'Test RTO One')),
  ('t2', mt.signup('t2@example.invalid', 'Test RTO Two'));

-- 4, 5. Sequential names per RTO, previewed and allocated by the server.
DO $$
DECLARE t1 uuid := mt.org('t1'); r jsonb; n int;
BEGIN
  PERFORM mt.ok(mt.tc_preview(t1) = 'Test Test', 'preview shows the first name: Test Test');
  r := mt.tc_create(t1, 'trainer@example.invalid');
  PERFORM mt.ok(r->>'candidate_name' = 'Test Test', 'first Test Candidate is "Test Test"');
  INSERT INTO mt.ids VALUES ('tc1', (r->>'id')::uuid);
  r := mt.tc_create(t1, 'trainer@example.invalid');
  PERFORM mt.ok(r->>'candidate_name' = 'Test Test2', 'second is "Test Test2"');
  INSERT INTO mt.ids VALUES ('tc2', (r->>'id')::uuid);
  r := mt.tc_create(t1, 'trainer@example.invalid');
  PERFORM mt.ok(r->>'candidate_name' = 'Test Test3' AND mt.tc_preview(t1) = 'Test Test4', 'third is "Test Test3"; preview then shows Test Test4');
  PERFORM mt.ok((SELECT count(*) FROM public.test_candidates WHERE organisation_id = t1 AND email = 'trainer@example.invalid') = 3,
    '8. the same email can be reused for several Test Candidates');
  PERFORM mt.ok((mt.tc_create(mt.org('t2'), 'x@example.invalid'))->>'candidate_name' = 'Test Test', 'sequences are independent for each RTO');
  PERFORM mt.ok(mt.used(t1) = 0 AND (SELECT count(*) FROM public.organisation_invitation_ledger WHERE organisation_id = t1) = 0,
    'creating a Test Candidate is not an invitation and uses no allowance');
END $$;

-- Validation and confirmation.
DO $$
DECLARE t1 uuid := mt.org('t1');
BEGIN
  PERFORM mt.ok(mt.refused(format('SELECT mt.tc_create(%L, ''not-an-email'')', t1), 'invalid_email'), 'invalid email refused');
  PERFORM mt.ok(mt.refused(format('SELECT mt.tc_create(%L, '''')', t1), 'invalid_email'), 'empty email refused');
  PERFORM mt.ok(mt.tc_preview(t1) = 'Test Test4', 'refused attempts do not use a number');
END $$;

-- 7. Deletion does not free a number.
DO $$
DECLARE t1 uuid := mt.org('t1'); r jsonb; tc3 uuid;
BEGIN
  SELECT id INTO tc3 FROM public.test_candidates WHERE organisation_id = t1 AND sequence_number = 3;
  PERFORM mt.ok(mt.refused(format('SELECT mt.tc_delete(%L, %L, ''yes'')', t1, tc3), 'confirmation_required'), 'deleting a Test Candidate needs exactly YES');
  r := mt.tc_delete(t1, tc3);
  PERFORM mt.ok(r->>'status' = 'deleted' AND (mt.tc_delete(t1, tc3))->>'status' = 'already_deleted', 'Test Candidate soft-deleted once');
  r := mt.tc_create(t1, 'trainer@example.invalid');
  PERFORM mt.ok(r->>'candidate_name' = 'Test Test4', 'after deleting Test Test3 the next is Test Test4 (numbers never reused)');
END $$;

-- 9. A genuine candidate with the same email is not touched.
DO $$
DECLARE t1 uuid := mt.org('t1'); g uuid; before jsonb;
BEGIN
  g := mt.invite(t1, 'Alex Genuine', 'trainer@example.invalid');
  SELECT to_jsonb(i) - 'updated_at' INTO before FROM public.assessment_invitations i WHERE id = g;
  PERFORM mt.tc_create(t1, 'trainer@example.invalid');
  PERFORM mt.tc_send(t1, mt.id('tc1'));
  PERFORM mt.ok((SELECT to_jsonb(i) - 'updated_at' FROM public.assessment_invitations i WHERE id = g) = before
            AND NOT (SELECT is_test FROM public.assessment_invitations WHERE id = g), 'genuine candidate with the same email is unchanged and still genuine');
  PERFORM mt.ok(mt.used(t1) = 1, 'genuine invitation counted once; test invitation not counted');
  INSERT INTO mt.ids VALUES ('t1_genuine', g);
END $$;

-- 12. Sending through the normal invitation path; server binds the locked identity.
DO $$
DECLARE t1 uuid := mt.org('t1'); i uuid; r record;
BEGIN
  i := mt.tc_send(t1, mt.id('tc2'));
  SELECT * INTO r FROM public.assessment_invitations WHERE id = i;
  PERFORM mt.ok(r.is_test AND r.candidate_name = 'Test Test2' AND r.candidate_email = 'trainer@example.invalid' AND r.student_id IS NULL,
    'invitation to a Test Candidate: is_test, name and email taken from the Test Candidate (client values ignored)');
  INSERT INTO mt.ids VALUES ('tc2_inv', i);
  i := mt.tc_send(t1, mt.id('tc2'));
  PERFORM mt.ok((SELECT count(*) FROM public.assessment_invitations WHERE test_candidate_id = mt.id('tc2')) = 2, 'more assessments can be sent to the same Test Candidate');
END $$;

-- 13, 14. At 10/10 Test Candidate invitations still go out and change nothing.
DO $$
DECLARE t1 uuid := mt.org('t1'); n int; before_tests int;
BEGIN
  FOR n IN 1..9 LOOP PERFORM mt.invite(t1); END LOOP;
  PERFORM mt.ok(mt.used(t1) = 10, 'RTO at 10/10');
  PERFORM mt.ok(mt.refused(format('SELECT mt.invite(%L)', t1), 'invitation_allowance_reached'), 'genuine invitation refused at 10/10');
  SELECT test_sent INTO before_tests FROM public.organisation_usage_periods WHERE organisation_id = t1 AND period_month = public.llnd_usage_period_month(now());
  PERFORM mt.tc_send(t1, mt.id('tc1'));
  PERFORM mt.ok(mt.used(t1) = 10 AND (SELECT test_sent FROM public.organisation_usage_periods WHERE organisation_id = t1 AND period_month = public.llnd_usage_period_month(now())) = before_tests + 1,
    'Test Candidate invitation sent at 10/10; Free usage unchanged; counted as a test invitation');
END $$;

-- 15, 16. Completion: no paid usage, no legacy billing, no write-back or support case.
DO $$
DECLARE i uuid := mt.id('tc2_inv'); lln uuid; ia uuid;
BEGIN
  SELECT id INTO lln FROM public.assessments WHERE type = 'lln' ORDER BY created_at LIMIT 1;
  INSERT INTO public.invitation_assessments (invitation_id, assessment_id) VALUES (i, lln) RETURNING id INTO ia;
  UPDATE public.assessment_invitations SET lln_status = 'in_progress' WHERE id = i;
  UPDATE public.assessment_invitations SET lln_status = 'completed', status = 'completed' WHERE id = i;
  UPDATE public.invitation_assessments SET individual_status = 'completed' WHERE id = ia;
  INSERT INTO public.axcelerate_writeback_queue (organisation_id, invitation_id, event_type, idempotency_key) VALUES (mt.org('t1'), i, 'assessment_completed', 'tcw-' || i);
  INSERT INTO public.support_cases (organisation_id, invitation_id) VALUES (mt.org('t1'), i);
  PERFORM mt.ok((SELECT count(*) FROM public.organisation_usage_completions WHERE invitation_id = i) = 0
            AND (SELECT count(*) FROM public.billable_learners WHERE invitation_id = i) = 0, 'Test Candidate completion excluded from paid and legacy billing');
  PERFORM mt.ok((SELECT count(*) FROM public.axcelerate_writeback_queue WHERE invitation_id = i) = 0
            AND (SELECT count(*) FROM public.support_cases WHERE invitation_id = i) = 0, 'no aXcelerate write-back or support case for a Test Candidate');
  PERFORM mt.ok((SELECT lln_status FROM public.assessment_invitations WHERE id = i) = 'completed', 'Test Candidate assessment completes normally for review');
END $$;

-- 10. Names, email, link and classification cannot be edited; no conversion either way.
DO $$
DECLARE t1 uuid := mt.org('t1'); i uuid := mt.id('tc2_inv'); g uuid := mt.id('t1_genuine'); stmt text;
BEGIN
  FOREACH stmt IN ARRAY ARRAY[
    format('SELECT mt.act_as(mt.admin(%L)); SET LOCAL ROLE authenticated; UPDATE public.assessment_invitations SET candidate_name = ''Real Person'' WHERE id = %L', t1, i),
    format('SELECT mt.act_as(mt.admin(%L)); SET LOCAL ROLE authenticated; UPDATE public.assessment_invitations SET candidate_email = ''real@example.invalid'' WHERE id = %L', t1, i),
    format('SELECT mt.act_as(mt.admin(%L)); SET LOCAL ROLE authenticated; UPDATE public.assessment_invitations SET test_candidate_id = NULL WHERE id = %L', t1, i),
    format('SELECT mt.act_as(mt.admin(%L)); SET LOCAL ROLE authenticated; UPDATE public.assessment_invitations SET test_candidate_id = %L WHERE id = %L', t1, mt.id('tc1'), g)
  ] LOOP
    PERFORM mt.ok(mt.refused(stmt, 'test_identity_locked'), 'locked: ' || left(split_part(stmt, 'UPDATE public.assessment_invitations SET ', 2), 45));
  END LOOP;
  PERFORM mt.ok(mt.refused(format('SELECT mt.act_as(mt.admin(%L)); SET LOCAL ROLE authenticated; UPDATE public.assessment_invitations SET is_test = false WHERE id = %L', t1, i), 'test_classification_locked'), 'test flag cannot be removed');
  PERFORM mt.ok(mt.refused(format('SELECT mt.act_as(mt.admin(%L)); SET LOCAL ROLE authenticated; UPDATE public.test_candidates SET candidate_name = ''Real Person'' WHERE id = %L', t1, mt.id('tc1')), 'permission denied for table test_candidates'),
    'Test Candidate name cannot be edited directly');
  PERFORM mt.ok(mt.refused(format('SELECT mt.act_as(mt.admin(%L)); SET LOCAL ROLE authenticated; INSERT INTO public.test_candidates (organisation_id, sequence_number, candidate_name, email) VALUES (%L, 99, ''Test Test99'', ''a@b.co'')', t1, t1), 'permission denied for table test_candidates'),
    'Test Candidates cannot be inserted directly (no client-chosen names or numbers)');
END $$;

-- 17. RTO isolation and permissions.
DO $$
DECLARE t1 uuid := mt.org('t1'); t2 uuid := mt.org('t2'); n int;
BEGIN
  PERFORM mt.ok(mt.refused(format('SELECT mt.tc_send(%L, %L)', t2, mt.id('tc1')), 'test_candidate_unavailable'), 'RTO Two cannot send to RTO One''s Test Candidate');
  PERFORM mt.ok(mt.refused(format('SELECT mt.tc_delete(%L, %L)', t2, mt.id('tc1')), 'not_found'), 'RTO Two cannot delete RTO One''s Test Candidate');
  PERFORM mt.act_as(mt.admin(t2)); SET LOCAL ROLE authenticated;
  SELECT count(*) INTO n FROM public.test_candidates WHERE organisation_id = t1;
  RESET ROLE;
  PERFORM mt.ok(n = 0, 'RTO Two cannot see RTO One''s Test Candidates');
  PERFORM mt.ok(mt.refused(format('SELECT mt.tc_send(%L, %L)', t1, (SELECT id FROM public.test_candidates WHERE organisation_id = t1 AND sequence_number = 3)), 'test_candidate_unavailable'),
    'cannot send to a deleted Test Candidate');
  PERFORM mt.ok(mt.refused('SET LOCAL ROLE anon; SELECT public.create_test_candidate(''a@b.co'')', 'permission denied for function create_test_candidate'), 'anon cannot create Test Candidates');
END $$;

-- Test Candidate assessments: soft delete through the existing workflow changes no usage.
DO $$
DECLARE t1 uuid := mt.org('t1'); r jsonb;
BEGIN
  r := mt.del(t1, mt.id('tc2_inv'));
  PERFORM mt.ok(r->>'status' = 'deleted' AND NOT (r->>'allowance_refunded')::boolean AND mt.used(t1) = 10, 'deleting a Test Candidate assessment changes no allowance');
END $$;

-- Existing name-based tests stay compatible.
DO $$
DECLARE t2 uuid := mt.org('t2'); i uuid := mt.invite(t2, 'Test Test', 'old@example.invalid'); manual uuid;
BEGIN
  PERFORM mt.ok((SELECT is_test AND test_candidate_id IS NULL FROM public.assessment_invitations WHERE id = i), 'invitations named "Test Test" without a Test Candidate are still tests');
  manual := mt.invite(t2, 'Test Test5', 'manual@example.invalid');
  PERFORM mt.ok(NOT (SELECT is_test FROM public.assessment_invitations WHERE id = manual),
    'typing "Test Test5" by hand creates a genuine (counted) invitation: generated names are only tests through the button');
END $$;

SELECT 'ALL TEST CANDIDATE CHECKS PASSED' AS result;
