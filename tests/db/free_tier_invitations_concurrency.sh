#!/usr/bin/env bash
# Concurrency tests for LLND Mate Free invitation metering. Many simultaneous
# sessions against a DISPOSABLE local database that already ran
# tests/db/free_tier_invitations.test.sql (reuses its mt.* helpers).
#   DB_URL=postgresql://postgres:postgres@127.0.0.1:54322/postgres tests/db/free_tier_invitations_concurrency.sh
set -euo pipefail
: "${DB_URL:?DB_URL is required}"
case "$DB_URL" in *127.0.0.1*|*localhost*|*/var/tmp/*) ;; *) echo "refused: local database only" >&2; exit 1 ;; esac

WORK="$(mktemp -d)"
q() { psql "$DB_URL" -v ON_ERROR_STOP=1 -qAt -c "SET request.jwt.claims = '{}'; SET request.headers = '{}';" -c "$1"; }
fail() { echo "FAIL: $*" >&2; exit 1; }
pass() { echo "PASS: $*"; }
parallel() {
  local n="$1" sql="$2" tag="$3"
  for i in $(seq 1 "$n"); do
    ( psql "$DB_URL" -qAt -c "SET request.jwt.claims = '{}'; SET request.headers = '{}';" -c "${sql//:i/$i}" >"$WORK/$tag.$i.out" 2>"$WORK/$tag.$i.err" || true ) &
  done
  wait
}
errs() { cat "$WORK/$1".*.err 2>/dev/null | grep -c "$2" || true; }
unexpected() { cat "$WORK/$1".*.err 2>/dev/null | grep -E "^(ERROR|FATAL|PANIC)|deadlock" | grep -v -E "invitation_allowance_reached" || true; }
used() { q "SELECT mt.used(mt.org('$1'))"; }
net() { q "SELECT mt.ledger_net(mt.org('$1'))"; }

q "INSERT INTO mt.orgs VALUES
  ('p1', mt.signup('p1@example.invalid', 'Parallel 1')), ('p2', mt.signup('p2@example.invalid', 'Parallel 2')),
  ('p3', mt.signup('p3@example.invalid', 'Parallel 3')), ('p4', mt.signup('p4@example.invalid', 'Parallel 4')),
  ('p5', mt.signup('p5@example.invalid', 'Parallel 5'))" >/dev/null

# C1: 30 simultaneous invitations from an empty allowance -> exactly 10 accepted.
parallel 30 "SELECT mt.invite(mt.org('p1'), 'Learner :i', 'l:i@example.invalid')" c1
[[ -z "$(unexpected c1)" ]] || { unexpected c1; fail "C1 unexpected errors"; }
ok=$(q "SELECT count(*) FROM public.assessment_invitations WHERE organisation_id = mt.org('p1')")
[[ "$ok" == "10" && "$(used p1)" == "10" && "$(net p1)" == "10" && "$(errs c1 invitation_allowance_reached)" == "20" ]] \
  || fail "C1 expected 10 accepted / 20 refused, got $ok accepted, used=$(used p1) net=$(net p1) refused=$(errs c1 invitation_allowance_reached)"
pass "C1: 30 simultaneous invitations -> 10 accepted, 20 refused; counter = ledger = 10"

# C2: the same deletion submitted 12 times at once -> one refund.
q "INSERT INTO mt.ids SELECT 'p2_' || g, mt.invite(mt.org('p2')) FROM generate_series(1,10) g" >/dev/null
parallel 12 "SELECT mt.del(mt.org('p2'), mt.id('p2_1'))" c2
[[ -z "$(unexpected c2)" ]] || { unexpected c2; fail "C2 unexpected errors"; }
refunded=$(cat "$WORK"/c2.*.out | grep -c '"allowance_refunded": true' || true)
[[ "$(used p2)" == "9" && "$(net p2)" == "9" && "$refunded" == "1" ]] || fail "C2 expected 9 used / 1 refund, got used=$(used p2) refunds=$refunded"
pass "C2: 12 simultaneous deletions of one assessment -> 1 refund (9/10)"

# C3: bulk (multi-row) insert of 5 when 8 are used -> all-or-nothing refusal.
q "SELECT mt.invite(mt.org('p3')) FROM generate_series(1,8)" >/dev/null
out=$(psql "$DB_URL" -qAt -c "SET request.jwt.claims = '{}';" -c "INSERT INTO public.assessment_invitations (organisation_id, candidate_email, candidate_name)
  SELECT mt.org('p3'), 'bulk' || g || '@example.invalid', 'Bulk ' || g FROM generate_series(1,5) g" 2>&1 || true)
[[ "$out" == *invitation_allowance_reached* && "$(used p3)" == "8" ]] || fail "C3 expected refusal and 8 used, got: $out / used=$(used p3)"
q "INSERT INTO public.assessment_invitations (organisation_id, candidate_email, candidate_name) SELECT mt.org('p3'), 'bulk' || g || '@example.invalid', 'Bulk ' || g FROM generate_series(1,2) g" >/dev/null
[[ "$(used p3)" == "10" ]] || fail "C3 bulk of 2 should fit"
pass "C3: bulk insert of 5 at 8/10 refused as a whole (nothing partial); bulk of 2 accepted -> 10/10"

# C4: at 10/10, 20 invitations race 5 deletions -> never more than 10 active, counter = ledger.
q "INSERT INTO mt.ids SELECT 'p4_' || g, mt.invite(mt.org('p4')) FROM generate_series(1,10) g" >/dev/null
( parallel 5 "SELECT mt.del(mt.org('p4'), mt.id('p4_:i'))" c4d ) &
parallel 20 "SELECT mt.invite(mt.org('p4'), 'Racer :i', 'r:i@example.invalid')" c4i
wait
[[ -z "$(unexpected c4i)$(unexpected c4d)" ]] || { unexpected c4i; unexpected c4d; fail "C4 unexpected errors"; }
active=$(q "SELECT count(*) FROM public.organisation_invitation_ledger WHERE organisation_id = mt.org('p4') AND chargeable AND refunded_at IS NULL")
[[ "$(used p4)" == "$(net p4)" && "$active" -le 10 ]] || fail "C4 used=$(used p4) net=$(net p4) active=$active"
pass "C4: 20 invitations racing 5 deletions at 10/10 -> $active active (never above 10), counter = ledger, no deadlocks"

# C5: at 10/10, 25 simultaneous Test Test invitations -> all accepted, usage unchanged.
q "SELECT mt.invite(mt.org('p5')) FROM generate_series(1,10)" >/dev/null
parallel 25 "SELECT mt.invite(mt.org('p5'), 'Test Test', 'tester@example.invalid')" c5
[[ -z "$(unexpected c5)" && "$(errs c5 invitation_allowance_reached)" == "0" ]] || fail "C5 tests refused"
tests=$(q "SELECT count(*) FROM public.assessment_invitations WHERE organisation_id = mt.org('p5') AND is_test")
[[ "$tests" == "25" && "$(used p5)" == "10" ]] || fail "C5 expected 25 tests, 10 used; got $tests / $(used p5)"
pass "C5: 25 simultaneous Test Test invitations at 10/10 -> all accepted, usage stays 10"

rm -rf "$WORK"
echo "ALL INVITATION CONCURRENCY CHECKS PASSED"
