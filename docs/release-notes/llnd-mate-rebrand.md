# Release notes: LLND Mate final rebrand

Branch: `feature/llnd-mate-rebrand`, based on `feature/llnd-assess-rebrand` (fc4549e), which already
contains #40, P0 assessment-result validity, P1 integration safety and clean-staging migration safety.
#45 (`feature/issue-45-platform-operator-access`) is not included and is untouched.
Not merged or deployed. No database, Supabase, Cloudflare, DNS, authentication or payment change.

## Product family

| Tier | Official name | Price (approved planning decision) | Status on the website |
|---|---|---|---|
| Free | **LLND Mate** | A$0/month, 10 completed assessment assignments per RTO per calendar month, no overages | Available now |
| Plus | **LLND Mate Plus** | A$15/month incl. 20, then A$0.75 per additional completed assignment | Coming soon |
| Premium | **LLND Automate** | A$35/month incl. 20, then A$0.85 per additional completed assignment; premium integration automation planned | Coming soon |

LLND Mate is also the umbrella brand (header, footer, emails, reports, aXcelerate notes).
LLND Assess is retired as a customer-facing name. "LLND Mate Automate" is never used.

## What changed for customers

- **Name:** LLND Assess → LLND Mate on the website, login, registration, staff invitation acceptance,
  workspace headers, results, support plans, compliance and validation reports, learner emails,
  staff notifications and aXcelerate notes and portfolio report text.
- **Homepage:** headline "FREE LLN & Digital Assessments for Australian RTOs"; supporting message
  "Smarter, shorter adaptive LLN assessments, practical digital skills checks, and clear learner
  support insights."; offer "Start free with 10 assessments every month. Pay only when you need more."
  Layout, design and CTAs are unchanged.
- **Accuracy:** "adaptive" now applies only to LLN everywhere (headline, SEO description, login panel,
  footer). The Digital assessment is described as a fixed set of practical questions.
- **Pricing:** cards and comparison table use the full tier names, explain that paid base fees include
  20 completed assignments a month with additional completions at A$0.75 / A$0.85, and that LLN + Digital
  under the same assignment count as one. LLND Mate Plus and LLND Automate are "Coming soon" and
  "Not yet available to purchase".
- **SEO / Open Graph:** title "FREE LLN & Digital Assessments for RTOs | LLND Mate"; description
  "Start free with 10 assessments every month. Adaptive LLN assessments, practical digital skills
  checks and clear learner support insights for Australian RTOs." (engineering wording, needs Product
  Owner approval); `og:site_name` and `application-name` = LLND Mate.
- **Login:** "Start a free trial" link (missed in the previous rebrand) → "Create a free account".

## Billing discrepancy: signed-in Billing page

**Finding.** The signed-in Billing page (`src/pages/BillingPage.tsx`) read the retired plans
(`lln_only`, `digital_only`, `lln_digital`: $79 / $129, 14-day trial) from `subscription_plans`, and
let staff create, change, cancel and reactivate `subscriptions` rows directly from the browser.
Subscriptions do not gate access, and the LLND Mate allowance is not metered, so the page described
entitlements that do not exist.

**Correction made (display only, reversible).** The `billing` workspace route now renders a new
static page, `src/pages/PlanStatusPage.tsx` ("Plan & usage"). It reads and writes nothing, shows the
approved LLND Mate / LLND Mate Plus / LLND Automate structure and counting rules, and says plainly that
online plan management and usage counts are not available yet and that nothing on the page changes the
organisation's access. It deliberately does not state which plan an organisation is on or how many
completions it has used, because neither is tracked yet.

**Not changed.** `BillingPage.tsx` stays in the repository (unrouted). The `subscription_plans`,
`subscriptions`, `billing_usage` and `billing_events` tables and rows are untouched. To revert, route
`billing` back to `<BillingPage />` in `src/App.tsx`.

**Still needed (separate approval).** A migration to retire or replace the legacy plan rows, a decision
on existing legacy trial subscriptions, and real usage metering before any page shows a plan or usage.

## Technical identifiers intentionally retained

Unchanged from the previous rebrand (see `llnd-assess-rebrand.md`): `#/llnd-automate/login` and the
`'llnd-automate'` login context, `llndautomate.pages.dev`, repository/package names, database tables,
settings and storage keys, `subscription_plans` rows, internal EIOS/ECC text mentioning "LLND Automate",
the aXcelerate webhook status message, historical migrations and records. Note that "LLND Automate"
is now also a live customer-facing tier name, so these internal identifiers now coincide with it.

Also retained: the `llnd-assess-ui` / `llnd-assess-launch-draft` storage keys in the readiness
dashboard (renaming would lose saved browser drafts), and the `platform.billing` route-registry entry
(EIOS platform workspace).

## Open items

- LLND Mate 10-completion monthly allowance not counted or enforced (critical launch blocker).
- Legacy billing records and trial subscriptions still in the database.
- Privacy Policy, Terms of Service and a confirmed contact channel do not exist.
- Domain for LLND Mate not decided (llndassess.com was the earlier proposal); no canonical URL or `og:url`.
- Updated email and aXcelerate note text takes effect only when Edge Functions are deployed.
- Hash routing: search engines index the root page only.

## Authorised staging release (later)

1. Approve and merge, in order: #40 → validity → P1 → #45 → clean-staging-migration-safety →
   llnd-assess-rebrand → this branch (or this branch alone, which contains all but #45).
2. Create the clean staging backend per `docs/staging/clean-install-migration-baseline.md`.
3. Build this branch as a Cloudflare Pages **Preview** pointed at staging.
4. Run `BASE_URL=<preview URL> npm run test:e2e`.
5. Deploy updated Edge Functions to staging only; review one invitation, reminder and completion email
   and one aXcelerate note with synthetic data.
6. Sign in as a staging RTO admin and check the Plan & usage page, workspace header and reports.
7. Product Owner review on desktop and mobile.
