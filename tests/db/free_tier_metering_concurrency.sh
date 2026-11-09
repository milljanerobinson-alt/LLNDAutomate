#!/usr/bin/env bash
# Concurrency tests for LLND Mate Free-tier metering.
#
# Runs many simultaneous database sessions against a DISPOSABLE local database that
# already has every migration applied and tests/db/free_tier_metering.test.sql run
# (it reuses the metering_test helpers). Never point this at a hosted project.
#
#   DB_URL=postgresql://postgres:postgres@127.0.0.1:54322/postgres tests/db/free_tier_metering_concurrency.sh
set -euo pipefail
: "${DB_URL:?DB_URL is required}"
case "$DB_URL" in
  *127.0.0.1*|*localhost*|*/var/tmp/*) ;;
  *) echo "refused: concurrency tests run only against a local database" >&2; exit 1 ;;
esac

WORK="$(mktemp -d)"
q() { psql "$DB_URL" -v ON_ERROR_STOP=1 -qAt -c "$1"; }
fail() { echo "FAIL: $*" >&2; exit 1; }
pass() { echo "PASS: $*"; }

# Runs one SQL statement in N parallel sessions (statement may use :i for the session number).
parallel() {
  local n="$1" sql="$2" tag="$3"
  for i in $(seq 1 "$n"); do
    ( psql "$DB_URL" -qAt -v i="$i" -c "${sql//:i/$i}" >"$WORK/$tag.$i.out" 2>"$WORK/$tag.$i.err" || echo "exit=$?" >>"$WORK/$tag.$i.err" ) &
  done
  wait
}
count_err() { cat "$WORK/$1".*.err 2>/dev/null | grep -c "$2" || true; }
unexpected_err() { cat "$WORK/$1".*.err 2>/dev/null | grep -E "^(ERROR|FATAL|PANIC)|deadlock" | grep -v "ERROR:  assessment_start_unavailable" || true; }

q "INSERT INTO metering_test.orgs VALUES
   ('d', metering_test.signup('admin-d@example.invalid', 'RTO D')),
   ('e', metering_test.signup('admin-e@example.invalid', 'RTO E')),
   ('f', metering_test.signup('admin-f@example.invalid', 'RTO F')),
   ('g', metering_test.signup('admin-g@example.invalid', 'RTO G')),
   ('h', metering_test.signup('admin-h@example.invalid', 'RTO H'))" >/dev/null
q "CREATE TABLE IF NOT EXISTS metering_test.slots (tag text, n int, id uuid, PRIMARY KEY (tag, n))"
used() { q "SELECT metering_test.used(metering_test.org('$1'))"; }
ledger() { q "SELECT metering_test.ledger(metering_test.org('$1'))"; }

# C1: 20 different started assignments complete at the same moment.
q "INSERT INTO metering_test.slots SELECT 'c1', g, metering_test.assignment(metering_test.org('d')) FROM generate_series(1,20) g" >/dev/null
q "UPDATE public.assessment_invitations SET lln_status='in_progress' WHERE id IN (SELECT id FROM metering_test.slots WHERE tag='c1' AND n <= 9)"
for n in $(seq 10 20); do q "UPDATE public.assessment_invitations SET lln_status='in_progress' WHERE id=(SELECT id FROM metering_test.slots WHERE tag='c1' AND n=$n)"; done
parallel 20 "UPDATE public.assessment_invitations SET lln_status='completed', status='completed' WHERE id=(SELECT id FROM metering_test.slots WHERE tag='c1' AND n=:i)" c1
[[ -z "$(unexpected_err c1)" ]] || { unexpected_err c1; fail "C1 unexpected errors"; }
[[ "$(used d)" == "20" && "$(ledger d)" == "20" ]] || fail "C1 expected 20/20, got counter=$(used d) ledger=$(ledger d)"
pass "C1: 20 simultaneous completions of started assignments -> counter 20, ledger 20 (no lost updates)"

# C2: one assignment, 16 simultaneous completion requests for both modules (retries and LLN+Digital races).
q "INSERT INTO metering_test.slots VALUES ('c2', 1, metering_test.assignment(metering_test.org('g')))" >/dev/null
q "UPDATE public.assessment_invitations SET lln_status='in_progress', digital_status='in_progress' WHERE id=(SELECT id FROM metering_test.slots WHERE tag='c2')"
parallel 16 "UPDATE public.assessment_invitations SET lln_status = CASE WHEN :i % 2 = 0 THEN 'completed' ELSE lln_status END, digital_status = CASE WHEN :i % 2 = 1 THEN 'completed' ELSE digital_status END WHERE id=(SELECT id FROM metering_test.slots WHERE tag='c2')" c2
[[ -z "$(unexpected_err c2)" ]] || { unexpected_err c2; fail "C2 unexpected errors"; }
[[ "$(used g)" == "1" && "$(ledger g)" == "1" ]] || fail "C2 expected 1, got counter=$(used g) ledger=$(ledger g)"
pass "C2: 16 simultaneous LLN/Digital completion requests for one assignment -> counted once"

# C3: RTO at 10/10, 30 learners try to start simultaneously -> all refused.
q "INSERT INTO metering_test.slots SELECT 'c3', g, metering_test.assignment(metering_test.org('f')) FROM generate_series(1,40) g" >/dev/null
for n in $(seq 1 10); do q "UPDATE public.assessment_invitations SET lln_status='in_progress' WHERE id=(SELECT id FROM metering_test.slots WHERE tag='c3' AND n=$n)"; q "UPDATE public.assessment_invitations SET lln_status='completed' WHERE id=(SELECT id FROM metering_test.slots WHERE tag='c3' AND n=$n)"; done
parallel 30 "UPDATE public.assessment_invitations SET lln_status='in_progress', status='in_progress' WHERE id=(SELECT id FROM metering_test.slots WHERE tag='c3' AND n=10+:i)" c3
[[ -z "$(unexpected_err c3)" ]] || { unexpected_err c3; fail "C3 unexpected errors"; }
refused="$(count_err c3 assessment_start_unavailable)"
started="$(q "SELECT count(*) FROM public.assessment_invitations WHERE id IN (SELECT id FROM metering_test.slots WHERE tag='c3' AND n>10) AND lln_status <> 'pending'")"
[[ "$refused" == "30" && "$started" == "0" ]] || fail "C3 expected 30 refused / 0 started, got $refused / $started"
pass "C3: at 10/10, 30 simultaneous new starts -> 30 refused, 0 started"

# C4: RTO at 9/10 with 1 learner in progress. 30 new starts race the 10th completion.
# Documents the approved rule: starts that commit before the 10th completion are allowed
# (no reservation). Invariants: no other errors, no deadlock, counter == ledger, and
# once the 10th completion has committed every further start is refused.
q "INSERT INTO metering_test.slots SELECT 'c4', g, metering_test.assignment(metering_test.org('e')) FROM generate_series(1,41) g" >/dev/null
for n in $(seq 1 9); do q "UPDATE public.assessment_invitations SET lln_status='in_progress' WHERE id=(SELECT id FROM metering_test.slots WHERE tag='c4' AND n=$n)"; q "UPDATE public.assessment_invitations SET lln_status='completed' WHERE id=(SELECT id FROM metering_test.slots WHERE tag='c4' AND n=$n)"; done
q "UPDATE public.assessment_invitations SET lln_status='in_progress' WHERE id=(SELECT id FROM metering_test.slots WHERE tag='c4' AND n=10)"
parallel 31 "UPDATE public.assessment_invitations SET lln_status = CASE WHEN :i = 1 THEN 'completed' ELSE 'in_progress' END WHERE id=(SELECT id FROM metering_test.slots WHERE tag='c4' AND n = CASE WHEN :i = 1 THEN 10 ELSE 9 + :i END)" c4
[[ -z "$(unexpected_err c4)" ]] || { unexpected_err c4; fail "C4 unexpected errors"; }
[[ "$(used e)" == "10" && "$(ledger e)" == "10" ]] || fail "C4 expected 10, got counter=$(used e) ledger=$(ledger e)"
allowed="$(q "SELECT count(*) FROM public.assessment_invitations WHERE id IN (SELECT id FROM metering_test.slots WHERE tag='c4' AND n BETWEEN 11 AND 40) AND lln_status='in_progress'")"
after="$(psql "$DB_URL" -qAt -c "UPDATE public.assessment_invitations SET lln_status='in_progress' WHERE id=(SELECT id FROM metering_test.slots WHERE tag='c4' AND n=41)" 2>&1 || true)"
[[ "$after" == *assessment_start_unavailable* ]] || fail "C4 start after the 10th completion was not refused"
pass "C4: 30 starts racing the 10th completion -> $allowed started before it committed, $(count_err c4 assessment_start_unavailable) refused; no deadlocks; counter == ledger; later start refused"
echo "C4_ALLOWED_BEFORE_LIMIT=$allowed"

# C5: the Product Owner's scenario, measured. 9 completed, then 100 learners all start
# before the 10th completion. Under the approved rule (no reservation) every start is
# allowed and every completion counts. This is the open decision, not a defect.
q "INSERT INTO metering_test.slots SELECT 'c5', g, metering_test.assignment(metering_test.org('h')) FROM generate_series(1,109) g" >/dev/null
q "DO \$\$ DECLARE r record; BEGIN
  FOR r IN SELECT id FROM metering_test.slots WHERE tag='c5' AND n <= 9 LOOP
    UPDATE public.assessment_invitations SET lln_status='in_progress' WHERE id=r.id;
    UPDATE public.assessment_invitations SET lln_status='completed' WHERE id=r.id;
  END LOOP; END \$\$"
parallel 100 "UPDATE public.assessment_invitations SET lln_status='in_progress' WHERE id=(SELECT id FROM metering_test.slots WHERE tag='c5' AND n=9+:i)" c5s
parallel 100 "UPDATE public.assessment_invitations SET lln_status='completed' WHERE id=(SELECT id FROM metering_test.slots WHERE tag='c5' AND n=9+:i)" c5c
[[ -z "$(unexpected_err c5s)$(unexpected_err c5c)" ]] || fail "C5 unexpected errors"
[[ "$(used h)" == "$(ledger h)" ]] || fail "C5 counter/ledger mismatch"
pass "C5: 9 completed, 100 simultaneous starts, then 100 completions -> $(used h) completions this month (counter == ledger)"
echo "C5_COMPLETIONS_WITH_APPROVED_RULE=$(used h)"

rm -rf "$WORK"
echo "ALL CONCURRENCY CHECKS PASSED"
