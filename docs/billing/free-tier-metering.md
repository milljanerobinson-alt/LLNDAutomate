# LLND Mate Free tier: invitations, Test Test, deletion and restoration

Migration: `supabase/migrations/20261110090000_llnd_mate_free_tier_invitations.sql`
Status: implemented and tested on local / CI databases only. **Not applied to any hosted project.**

This supersedes the completion-based draft `20261109120000_llnd_mate_free_tier_metering.sql`,
which was never applied outside local/CI tests and has been removed from the branch.

## Approved rules (Product Owner, 10 Nov 2026)

| Rule | How it is enforced |
|---|---|
| 10 assessment invitations sent per RTO per calendar month | BEFORE INSERT trigger on `assessment_invitations` locks the RTO's month row, refuses with `invitation_allowance_reached` when active chargeable invitations ≥ allowance, otherwise counts it |
| LLN + Digital in one invitation = 1; separate invitations = 2 | One `assessment_invitations` row = one invitation |
| Resending does not count | Resends add email queue rows, never invitation rows |
| Failed attempts do not count | Counting is inside the insert transaction; any failure rolls it back |
| Incomplete/abandoned count unless deleted | Usage is by invitation, not by progress |
| Invited learners can always start, resume and finish | No start restriction exists |
| Monthly reset | Calendar month in AEST (fixed UTC+10) from the database clock. **Time zone still awaiting confirmation** |
| Previous months stay accessible without using this month | Only the current month's counter is checked |
| Server-side, transactional, all pathways | Database trigger: browser, API, bulk (multi-row insert is all-or-nothing), aXcelerate sync and staff all go through it |

### Test Test

- Classified on insert by `llnd_is_reserved_test_name(candidate_name)`. The name must be exactly the two words "test" "test", after:
  - NFKC normalisation and ignoring case;
  - removing zero-width characters;
  - collapsing any whitespace (including non-breaking) to single spaces.
  - "Test Testerson", "Testa Test", "Test Test Smith", "TestTest" and "Test-Test" are genuine learners.
- The invitation model stores one full-name field (`candidate_name`), so "first name Test, last name Test" is detected as the full name "Test Test" on every pathway.
- `is_test` is set by the server and ignores any client value. Once set:
  - it cannot change in either direction;
  - a test's name, linked student and organisation cannot change (`test_identity_locked`);
  - renaming a genuine learner to "Test Test" later does not reclassify it or refund anything.
- Never counted against the LLND Mate allowance. Never recorded as a paid-tier completion or by legacy billing.
- No support case, no aXcelerate write-back, no portfolio upload, no student-record update, no automatic support plan.
- Excluded from the RTO dashboard statistics, compliance report and export, and the support-plans list.
- Test learners still receive their invitation email, can complete the assessment, and staff can review the results. These are labelled TEST.

### Test Candidates (migration `20261110150000_llnd_mate_test_candidates.sql`)

- **How the Candidates page sends assessments.** Each row is one `assessment_invitations` row. **New Invitation** creates the invitation (name, email, date of birth, qualification and LLN/Digital selection), links the chosen assessments and calls `send-email`. Row actions are Timeline, Edit, Send reminder and Delete. There is no candidate record separate from an invitation, and no "send to an existing candidate" action.
- **What was added.**
  - **Create Test Candidate** creates a server-side test identity (`test_candidates`). It is not an invitation and uses no allowance.
  - Its **Send assessment** action opens the existing New Invitation form with the name and email locked, so assessment selection, invitation creation and email delivery are the existing ones.
  - Test Candidates with no assessment yet are listed at the top of In progress. Once an assessment is sent, it appears as a normal TEST row.
- **Naming.**
  - `create_test_candidate(email)` takes the next number from a per-RTO counter (row-locked, only increases): "Test Test", "Test Test2", "Test Test3" and so on.
  - Names are unique per RTO (constraint) and never reused after deletion.
  - `preview_next_test_candidate_name()` shows the likely next name; the server's allocation is final.
- **Locking.**
  - An invitation with `test_candidate_id` is always a test. The server copies the Test Candidate's name and email, and clears any learner or aXcelerate contact link.
  - The link, name, email and test flag cannot be changed. A genuine invitation cannot be linked to a Test Candidate later.
  - `test_candidates` is read-only to clients and visible to own-RTO administrators only.
- **Compatibility.** An invitation named exactly "Test Test" is still a test (approved rule). Typing "Test Test2" by hand creates a genuine, counted invitation: generated names are tests only through the button.
- **Deletion.** `delete_test_candidate(id, 'YES')` soft-deletes a Test Candidate. Assessments already sent to it are deleted through the existing assessment deletion, which changes no allowance for tests.

### Soft deletion (RTO administrators)

- `delete_assessment_assignment(id, confirmation)`:
  - requires the administration workspace, the caller's own RTO, and exactly `YES` (checked on the server);
  - locks the row; repeat calls return `already_deleted` with no refund;
  - records the status before deletion, who deleted it and when (plus an append-only event).
- Refund: only a chargeable invitation issued in the current month, and only once. Deleting last month's invitation or a test changes nothing.
- Hidden from RTO staff and learner links by **restrictive** RLS policies on the assignment and its results tables.
  - Tables covered: invitation_assessments, assessment_responses, assessment_declarations, support_plans, intervention_cases, support_cases, email_queue, axcelerate_writeback_queue.
  - Existing policies are not edited.
- Data is preserved for restoration. Hard delete through the API is removed.
- Pending emails and write-backs are cancelled; new ones are suppressed.
- The aXcelerate sync treats a deleted invitation as gone, as it did a hard-deleted one. It may create a fresh invitation, which counts.
- Retention: no automatic purge is implemented. A retention period is a pending decision.

### Restoration (platform operators)

- `restore_assessment_assignment(id, note)` requires Issue #45's `is_platform_operator()` (active grant + MFA session).
- Idempotent. Restores visibility of the original results and progress. Records who restored it and when.
- Uses no allowance and is allowed above 10. Sends nothing and starts no workflow. Keeps the test classification.
- The fee is arranged outside the product; no payment step exists.

### Platform reporting (platform operators)

- `platform_invitation_usage(month, search)` returns, per RTO:
  - total sent (gross, genuine);
  - sent in month (gross);
  - allowance used (net of same-month deletions);
  - remaining;
  - Test Test (month and all time);
  - deleted, completed (genuine) and restored counts;
  - a counter/ledger consistency flag.
- `platform_invitation_usage_history(org)` returns the last 12 months for one RTO.
- `platform_deleted_assessments(search, include_restored)` returns:
  - learner name and email, RTO;
  - status before deletion;
  - who deleted it and when;
  - restoration status.
  - It returns no answers or results.
- Screens: EIOS `#/operator/invitations-usage` and `#/operator/deleted-assessments`. When #45 is merged, wrap them in its PlatformOperatorGate.

## Data model

| Object | Purpose |
|---|---|
| `assessment_invitations.is_test, deleted_at, deleted_by, deleted_prior_status, restored_at, restored_by` | Classification and soft-deletion state |
| `organisation_plan_entitlements` | One row per RTO, plan `llnd_mate_free`, allowance 10 (CHECK: no other plan) |
| `organisation_invitation_ledger` | One row per issued invitation (PK invitation_id, no FK): month, is_test, chargeable, refunded_at |
| `organisation_usage_periods` | Per RTO-month counters (chargeable_sent, refunded, test_sent); the lock row |
| `organisation_usage_completions` | Genuine completed assignments (paid-tier usage, not billed yet) |
| `assessment_assignment_events` | Append-only deleted/restored audit |

## Security

- Writes:
  - no INSERT, UPDATE or DELETE on the new tables for anon or authenticated;
  - internal functions revoked from PUBLIC, anon and authenticated;
  - deletion fields cannot be written directly (`deletion_fields_locked`).
- Reads: own-RTO administrators only (RLS). `get_my_plan_usage()` takes no organisation id.
- Platform functions: all refuse unless `llnd_is_platform_operator()` is true. Without Issue #45 installed, that is always false.
- Concurrency:
  - the per-RTO-month row lock serialises issuing and refunds;
  - the counter is incremented in the BEFORE trigger, so multi-row inserts see each row;
  - the ledger primary key makes refunds and records idempotent.

## Billing path audit

| Path | Finding | Action |
|---|---|---|
| `trigger_billing_on_assessment_complete` → `record_billable_completion` (legacy `billable_learners`/`billing_usage`) | Would bill test and deleted completions | **Corrected**: tests and deleted assignments skipped (same body otherwise) |
| `record_billable_completion` | Already scoped to the invitation's own organisation by Issue #40 (`20261028130000`) | No change |
| Unrouted `BillingPage.tsx` | Client-side writes to `subscriptions` if the RLS allows it | Not routed. LLND Mate entitlements now live in `organisation_plan_entitlements`, which no client can write. Review `subscriptions` RLS when retiring legacy billing |
| `organisation_usage_completions` | Paid-tier source | Excludes tests by construction |
| Stripe | Not referenced | No change |

## Pending decisions

1. Month boundary: fixed AEST (UTC+10) as preferred. It resets at 01:00 local time in daylight-saving states.
2. Retention period for soft-deleted assessments (no purge implemented).
3. Existing RTOs receive the free entitlement; existing "Test Test" invitations are classified as tests by the migration.
4. No historical usage backfill: usage starts at zero when applied.
5. The aXcelerate sync recreating an invitation after a deletion counts as a new invitation, and is refused when the allowance is used.
6. An RTO could send a "Test Test" invitation to a real learner's email and use it informally. Mitigations: TEST label, and exclusion from reports, exports and integrations.

## Tests

- `tests/db/free_tier_invitations.test.sql`: 86 checks, run against the full migration chain plus Issue #45 in CI.
- `tests/db/free_tier_invitations_concurrency.sh` (parallel sessions):
  - C1: 30 simultaneous invitations → 10;
  - C2: 12 simultaneous deletions → 1 refund;
  - C3: bulk all-or-nothing;
  - C4: invitations racing deletions → never above 10;
  - C5: 25 simultaneous Test Test invitations at the limit.

## Before hosted staging verification

1. Approve and create the clean staging project (staging hold to be lifted for it only).
2. Merge in order: #40 → validity → P1 → **#45** → clean-staging → rebrand → this branch.
   - Resolve the small App.tsx/productContext.ts conflicts with #45's operator routes.
   - Wrap the two operator screens in PlatformOperatorGate.
3. Apply migrations to staging via the clean-install bootstrap. Confirm verification passes, including the #45 objects.
4. Grant a staging operator (`grant_platform_operator`) and enrol MFA.
5. Deploy Edge Functions to staging only: on-assessment-complete, upload-axcelerate-portfolio, axcelerate-inbound-sync.
6. On staging with synthetic data:
   - send 10 invitations, then confirm the 11th is refused;
   - delete a started and a completed assessment and confirm the spots return;
   - confirm a deleted learner link fails;
   - send Test Test invitations at the limit;
   - restore as the operator;
   - check the operator usage figures;
   - confirm no aXcelerate actions for tests or deleted assignments;
   - check a month rollover, by date simulation or by waiting.

## Rollback

The migration adds columns, tables, functions, triggers and policies, and replaces the body of
`trigger_billing_on_assessment_complete`. Rollback (after approval):

1. Drop the triggers:
   - on assessment_invitations: `llnd_mate_issue_invitation`, `llnd_mate_record_invitation`, `llnd_mate_protect_invitation_fields`, `llnd_mate_count_completion_update`;
   - `llnd_mate_count_module_completion_update` on invitation_assessments;
   - the guards on axcelerate_writeback_queue, email_queue and support_cases;
   - `llnd_mate_free_entitlement` on organisations.
2. Drop the `llnd_mate_hide_deleted` and `llnd_mate_no_hard_delete` policies. **Soft-deleted rows then reappear**: restore or purge them first, as approved.
3. Restore the previous `trigger_billing_on_assessment_complete` body (from 20260629091944).
4. Drop the new functions.
5. Keep the new tables and columns for audit unless their removal is approved.
6. Test Candidates (20261110150000), rolled back first:
   - drop trigger `llnd_mate_bind_test_candidate`;
   - restore the 20261110090000 bodies of `llnd_mate_issue_invitation` and `llnd_mate_protect_invitation_fields`;
   - drop `create_test_candidate`, `preview_next_test_candidate_name`, `delete_test_candidate` and `llnd_test_candidate_name`;
   - keep `test_candidates`, the counters and `test_candidate_id` for audit unless removal is approved.
