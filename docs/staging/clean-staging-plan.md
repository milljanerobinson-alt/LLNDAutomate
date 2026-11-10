# Clean staging plan — LLND Mate (LLN & D Assess) December Free launch

> **Superseded (11 Nov 2026):** the Product Owner changed direction to the "LLND Mate — Project Consolidation & Recovery Plan" (build on the original LLND Automate baseline `e1b4cf3`). Kept for reference only; do not follow this plan.

Status: prepared on branch `feature/staging-readiness`. Nothing in this plan has been
applied to any hosted service. Every step marked **APPROVAL** needs the Product Owner's
explicit go-ahead before it is carried out.

## Decisions already made

- The original Supabase project `clrsckerimjturebulbk` ("LLND Project") is kept as a
  **read-only reference**. No migrations, no schema or configuration changes, no deletions.
  Its five scheduled jobs were switched off on 11 Nov 2026 during restoration.
- A **new, empty** Supabase project becomes the staging database for the current code.
- The staging migration/deployment hold stays in place until each step below is approved.

## Environments after this plan

| Environment | Supabase project | Front end | Purpose |
| --- | --- | --- | --- |
| Original (reference) | `clrsckerimjturebulbk` | Existing deployments only; no new builds may target it | Read-only review of the August application and data |
| Staging (new) | new project, Sydney, Free plan | Cloudflare Pages previews of approved branches | Pre-launch testing with synthetic data |
| Production (later) | decided separately before launch | `main` | December Free launch |

## Code prepared (branch `feature/staging-readiness`)

1. **Issue #45 merged into the stack** (one trivial conflict in `OrganisationPage.tsx`, both
   panels kept). The full migration set now includes `20261028140000_issue045_platform_operator_access.sql`.
2. **Preview build guard** — `deploy/supabase-environments.json` and
   `scripts/build-env-guard.mjs` (wired into `vite.config.ts`). On Cloudflare
   (`CF_PAGES=1`) a build fails unless its Supabase project is approved for that build kind:
   - previews may only use projects listed under `preview` (currently none, so every
     preview build fails until the staging project is approved and listed);
   - previews can never use a `protected` project (the original database);
   - production builds of `main` may only use projects listed under `production`.
   Local and CI builds are unaffected.
3. **Redirect-loop fix** — `src/App.tsx` `redirectTo()` and `src/lib/routeHash.ts`. A
   redirect to the route already showing now shows a "You don't have access to this
   workspace" screen with Sign out, instead of an endless loader. Database access rules
   are unchanged.
4. **Issue #45 database test** — `tests/db/platform_operator_access.test.sql`.

## Step-by-step staging setup

| # | Step | Who | Needs approval |
|---|------|-----|----------------|
| 1 | Review this plan, the branch and the CI rehearsal evidence | Product Owner | — |
| 2 | Decide the merge order and merge the stack into `main` (see "Merge order") | Product Owner, then Claude | **APPROVAL** (merge) |
| 3 | Free a Supabase Free-plan slot: pause the original LLND project again after your review (it stays resumable until Nov 2027), **or** upgrade to Pro | Product Owner | **APPROVAL** (hosted) |
| 4 | Create the new staging project (Sydney, Free) and record its ref | Product Owner or Claude | **APPROVAL** (hosted) |
| 5 | Dry-run the bootstrap against the approved commit (no database) | Claude | — |
| 6 | Run `bootstrap-database.sh --execute` against the **new, empty** project only (single transaction, all migrations incl. #45; refuses the original ref) | Claude | **APPROVAL** (hosted migration) |
| 7 | Run `verify-clean-install.sql` and the read-only checks; confirm all scheduled jobs inactive and no outbound URLs | Claude | — (read-only) |
| 8 | Configure Supabase Auth for staging: site URL, redirect allowlist (`https://*.llndautomate.pages.dev/**`), TOTP MFA on (needed for Issue #45 operators), email sender | Product Owner or Claude | **APPROVAL** (hosted) |
| 9 | Deploy only the Edge Functions LLND needs, with an explicit Verify JWT setting per function (see risks) | Claude | **APPROVAL** (deploy) |
| 10 | Cloudflare Pages: set the **Preview** environment variables to the staging project; keep **Production** unchanged; add the staging ref to `preview` in `deploy/supabase-environments.json` (code change, reviewed) | Product Owner (Cloudflare) + Claude (code) | **APPROVAL** (hosted + code) |
| 11 | Cloudflare Pages: remove or restrict (Cloudflare Access) existing preview deployments that point at the original database | Product Owner | **APPROVAL** (hosted) |
| 12 | Create synthetic staging accounts (two RTOs, the four permanent test identities, one operator granted from the SQL console) | Claude | **APPROVAL** (hosted data) |
| 13 | Run the staging verification: Issue #40/#45 Playwright suites, Free-tier and Test Candidate checks, two-RTO isolation | Claude | — (staging only) |
| 14 | Turn integrations on one at a time (email sender, aXcelerate demo, AI), each with its own allowlist entry and job | Product Owner | **APPROVAL** each |
| 15 | Update the launch-readiness dashboard: items move to "Staging verified" only with step-13 evidence | Claude | — |

## Merge order (do not merge yet)

The branches form one stack, plus Issue #45 on a side branch:

```
main (7f4a208)
 └ feature/issue-40-rto-workspace-access (+17)
    ├ feature/issue-45-platform-operator-access (+1)          ← side branch
    └ feature/assessment-result-validity (+3)
       └ feature/p1-integration-safety (+2)
          └ feature/clean-staging-migration-safety (+5)
             └ feature/llnd-assess-rebrand (+3)
                └ feature/llnd-mate-rebrand (+2)
                   └ feature/p0-free-tier-metering (+4, superseded content)
                      └ feature/p0-free-tier-invitations (+3)
                         └ feature/llnd-mate-test-candidates (+2)
                            └ feature/staging-readiness (+#45 merge, +fixes)
```

Recommended: review as one stacked pull request series and merge in the order shown,
#40 first, then #45, then the stack top-down. Because each branch contains the previous
one, merging `feature/staging-readiness` alone would bring everything in at once; the
ordered series keeps each review small. `feature/p0-free-tier-metering` is superseded by
`feature/p0-free-tier-invitations` but is its ancestor, so it is merged as part of the
stack, not separately.
