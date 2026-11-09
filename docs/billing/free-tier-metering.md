# LLND Mate Free tier: entitlements, metering and start restriction

Migration: `supabase/migrations/20261109120000_llnd_mate_free_tier_metering.sql`
Status: implemented and tested on a local / CI database only. **Not applied to any hosted project.**

## How it works

| Piece | What it is |
|---|---|
| Assignment | One `assessment_invitations` row. Its `id` is the stable assignment identifier. |
| Entitlement | `organisation_plan_entitlements`: one row per RTO, plan `llnd_mate_free`, allowance 10. Created by a trigger when an organisation is created (signup) and backfilled for existing RTOs. Only the free plan code is allowed (CHECK). No application role can write it. |
| Usage ledger | `organisation_usage_completions`: one row per counted assignment, `UNIQUE (invitation_id)`. This is the record of truth. No foreign key to the assignment, so deleting a completed assignment does not return the allowance. |
| Period counter | `organisation_usage_periods`: per RTO per month. Updated only in the same transaction as a ledger insert. Its row is also the lock that serialises start checks for one RTO and month. |
| Month | Calendar month in AEST, fixed UTC+10 with no daylight saving (`llnd_usage_period_month`). Uses the database clock, never browser timestamps. Resets 00:00 AEST on the 1st (14:00 UTC on the last day of the previous month). |
| Counting | AFTER triggers on `assessment_invitations` (`lln_status`, `digital_status` or `status` becomes `completed`) and on `invitation_assessments` (`individual_status` becomes `completed`, used by the legacy combined link `#/quiz/<token>`). Every path calls `llnd_mate_record_completion`, which inserts into the ledger `ON CONFLICT DO NOTHING` and increments the counter only when a row was inserted. |
| Start restriction | BEFORE triggers on both tables. A **new start** is the first time an assignment leaves "not started" (any module `in_progress` or `completed`, or overall `status` `in_progress`/`completed`), including inserts already in that state and a direct jump to `completed`. A new start is refused when the RTO has no entitlement or its completed count for the month has reached the allowance. Assignments that have already started are never checked, so learners in progress finish and the second module of a combined assignment can start. |
| Read model | `get_my_plan_usage()`: takes no arguments; the RTO comes from the caller's active membership and the administration workspace. Returns plan, period, completed, allowance, remaining, in-progress count, `new_starts_available` and a `consistent` flag (counter equals ledger). |

### Rules as implemented

| Event | Counted? |
|---|---|
| Invitation created, sent, reminded, opened | No |
| Started, not completed (abandoned) | No (shown separately as "in progress") |
| LLN completed | Yes, once |
| Digital completed | Yes, once |
| LLN and Digital under the same assignment | Once in total |
| Completion retried or replayed | No additional count |
| Same learner, a second separate assignment | Yes, counted separately |
| Completion inside a transaction that fails | No (rolled back with it) |

A completion counts in the month it is completed, even if the learner started in the
previous month.

## Security

- **Server-authoritative:** all counting and start checks run in database triggers,
  so they apply to the browser, Edge Functions, staff screens and direct API calls alike.
- **Idempotent:** `UNIQUE (invitation_id)` on the ledger. Concurrent completions for
  the same assignment wait on the unique index and then do nothing.
- **Concurrency:** the start check locks the RTO's period row `FOR UPDATE`, and so does
  every counter increment. Starts and completions for one RTO and month are therefore
  serialised and cannot read a stale count. The lock order is the same everywhere
  (assignment row, then period row), so they cannot deadlock.
- **RTO isolation:** the tables use RLS so admins can SELECT only their own RTO, with no
  INSERT, UPDATE or DELETE for `anon` or `authenticated`. Internal functions are revoked
  from PUBLIC, anon and authenticated. The read RPC takes no organisation argument.
- **Learner privacy:** a refused start raises the generic `assessment_start_unavailable`,
  with no plan, usage or organisation details.

## Open decision: concurrent starts

Without a reservation, assignments that start before the allowance is reached can all
finish and be counted. This is measured in test C5: 9 completed, then 100 simultaneous
starts, gives 109 completions. Closing this needs a new business rule, presented to the
Product Owner on 9 Nov 2026 and **not implemented**:

1. Reserve a place at start, with an expiry for abandoned starts and/or staff release (recommended).
2. Cap simultaneous unfinished starts.
3. Accept the overrun and monitor it.

## Other decisions to confirm

- **Time zone:** fixed AEST (UTC+10) as preferred. In Sydney, Melbourne, Canberra and
  Hobart summer time, the reset happens at 01:00 local time on the 1st.
- **Existing RTOs:** the migration gives every existing organisation the free
  entitlement. Legacy `subscriptions` and `subscription_plans` are not read or changed.
- **Historical completions are not backfilled:** usage starts at zero when the migration
  is applied, so in the month it goes live an RTO's earlier completions do not count.
  If a backfill is wanted, run this report first and review it (read-only):
  ```sql
  SELECT organisation_id, public.llnd_usage_period_month(coalesce(lln_completed_at, digital_completed_at, completed_at)) AS month, count(*)
  FROM public.assessment_invitations
  WHERE lln_status = 'completed' OR digital_status = 'completed' OR status = 'completed'
  GROUP BY 1, 2 ORDER BY 1, 2;
  ```
  Historical `*_completed_at` values were browser-supplied before the result-validity
  migration, so they are not fully reliable.
- **Staff resetting a completed assignment:** it stays counted; re-completing it does
  not count again.

## Tests

- `tests/db/free_tier_metering.test.sql` covers:
  - entitlement creation; counting rules; legacy link; idempotency;
  - failed transactions; the learner token path;
  - direct-API write attempts; the limit on every start path;
  - in-progress finish; RTO isolation (RLS and RPC); monthly reset;
  - missing entitlement; inconsistency reporting.
- `tests/db/free_tier_metering_concurrency.sh` runs parallel sessions:
  - C1: 20 simultaneous completions;
  - C2: 16 simultaneous retries for one assignment;
  - C3: 30 simultaneous starts at the limit;
  - C4: starts racing the 10th completion;
  - C5: the 100-learner scenario.
- CI runs both against a local Supabase stack built with the clean-install bootstrap.

## Rollback

The migration only adds objects. To remove it from a database (after approval):

```sql
DROP TRIGGER IF EXISTS llnd_mate_authorise_start_update ON public.assessment_invitations;
DROP TRIGGER IF EXISTS llnd_mate_authorise_start_insert ON public.assessment_invitations;
DROP TRIGGER IF EXISTS llnd_mate_count_completion_update ON public.assessment_invitations;
DROP TRIGGER IF EXISTS llnd_mate_count_completion_insert ON public.assessment_invitations;
DROP TRIGGER IF EXISTS llnd_mate_authorise_module_start_update ON public.invitation_assessments;
DROP TRIGGER IF EXISTS llnd_mate_authorise_module_start_insert ON public.invitation_assessments;
DROP TRIGGER IF EXISTS llnd_mate_count_module_completion_update ON public.invitation_assessments;
DROP TRIGGER IF EXISTS llnd_mate_count_module_completion_insert ON public.invitation_assessments;
DROP TRIGGER IF EXISTS llnd_mate_free_entitlement ON public.organisations;
DROP FUNCTION IF EXISTS public.get_my_plan_usage();
DROP FUNCTION IF EXISTS public.llnd_mate_count_module_completion();
DROP FUNCTION IF EXISTS public.llnd_mate_count_invitation_completion();
DROP FUNCTION IF EXISTS public.llnd_mate_record_completion(uuid, uuid, text);
DROP FUNCTION IF EXISTS public.llnd_mate_authorise_module_start();
DROP FUNCTION IF EXISTS public.llnd_mate_authorise_invitation_start();
DROP FUNCTION IF EXISTS public.llnd_mate_check_new_start(uuid);
DROP FUNCTION IF EXISTS public.llnd_assignment_row_started(uuid, text, text, text, uuid);
DROP FUNCTION IF EXISTS public.llnd_assignment_started(text, text);
DROP FUNCTION IF EXISTS public.llnd_mate_grant_free_entitlement();
-- Keep the tables for audit unless their removal is separately approved:
-- DROP TABLE public.organisation_usage_periods, public.organisation_usage_completions, public.organisation_plan_entitlements;
DROP FUNCTION IF EXISTS public.llnd_usage_period_starts_at(date);
DROP FUNCTION IF EXISTS public.llnd_usage_period_month(timestamptz);
```

Removing the triggers stops counting and enforcement immediately. Assessment data is
not changed either way.
