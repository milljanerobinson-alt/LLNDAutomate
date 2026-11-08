# Release notes: LLND Assess rebrand

Branch: `feature/llnd-assess-rebrand` (based on `feature/clean-staging-migration-safety`,
which already contains #40, assessment-result validity and P1).
Not deployed. No database, Supabase, Cloudflare, DNS, authentication or payment change.

## What changed for customers

- **Name:** LLND Automate is now **LLND Assess** across the website, staff screens,
  login, staff invitations, reports, learner emails and aXcelerate note text.
- **Homepage:** rebuilt around the approved headline
  "FREE Adaptive LLN & Digital Assessments for Australian RTOs", the offer
  "Start free with 10 adaptive assessments every month. Pay only when you need more.",
  and two calls to action: "Start Assessing for Free" (registration) and
  "See How It Works" (`#/how-it-works`).
- **Public pages:** How It Works, Features, Pricing, FAQ (`#/resources`), About and
  Contact were rewritten so that they describe only implemented behaviour.
- **Pricing:** static page with the approved Free / Plus / Automate structure.
  Plus and Automate are labelled "Coming soon" and cannot be selected.
- **Registration:** creates a free account. The paid-plan step, the "14-day free
  trial" wording and the trial subscription record were removed.
- **Page titles and metadata:** SEO title and description on the homepage,
  per-page titles, `lang="en-AU"`, Open Graph name, title and description.

## Content removed because it was not accurate or not working

- Three testimonials attributed to named people and RTOs, and the "RTOs love" section.
- The competitor comparison table and the claim "Learner deduplication: Charged twice".
- Old prices ($79, $129, $1.50 per learner), "Most Popular", the pricing calculator
  and "first 14 days free".
- "ASQA-compliant", "audit-ready evidence", "AI-generated reports" and "unlimited trainers and campuses".
- The contact form, which did not send messages; the unverified hello@llnd.com.au
  address; the LinkedIn link; and the newsletter box.
- Footer links to pages that do not exist: Security, Changelog, Blog, Careers,
  Documentation, Help Centre, API Reference, Status, Privacy Policy, Terms and Data Processing.
- Resources article cards that had no articles behind them. The route now shows the FAQ.

## Technical identifiers intentionally retained

| Identifier | Where | Why it stays |
|---|---|---|
| `#/llnd-automate/login` route | App.tsx, productContext.ts, links | Existing bookmarks, invitation and redirect links, and auth redirect logic |
| `'llnd-automate'` login context | LoginPage.tsx, App.tsx | Internal type used by login and OAuth separation tests |
| `llndautomate.pages.dev` | invite-rto-staff/origin-policy.ts, playwright.config.ts | Live Cloudflare Pages host; must not change |
| Repository, package and folder names (`LLNDAutomate`, `llndautomate`) | GitHub, Cloudflare | Renaming breaks builds and integrations |
| Database tables, columns, settings keys, storage keys | migrations | Data compatibility |
| `subscription_plans` rows (`lln_only`, `digital_only`, `lln_digital`) | database | Changing plans needs a migration (not authorised) |
| EIOS prompts mentioning LLND Automate | technical-director, command-centre-ai, generate-platform-audit, generate-engineering-briefing | Internal engineering tools, not customer-facing |
| `axcelerate-contact-webhook` status message | Edge function | Machine-to-machine response |
| Historical migrations and EIOS records | supabase/migrations, ECC pages | Audit history must not be rewritten |

## Dependencies and open items

- **Free allowance enforcement:** the 10-per-month allowance and the "new starts
  restricted" rule are described but not metered or enforced in code. A billing task is needed.
- **In-app Billing page:** still shows the legacy plans from `subscription_plans` with
  the old prices and trial. It needs a separate billing change and a migration.
- **Privacy Policy and Terms of Service:** none exist. Registration no longer links to them.
- **Contact channel:** no confirmed contact email. The Contact page says details are being finalised.
- **Domain:** llndassess.com is unconfirmed. There is no canonical URL or `og:url`, and
  email sender addresses, auth redirect URLs and Cloudflare are unchanged.
- **SEO:** routing is hash-based (`#/pricing`), so search engines index the root page only.
- **Edge Functions:** updated email and note text is in source only, and takes effect only
  when the functions are deployed under the staging plan.
- **#45:** this branch does not contain #45. Merging both may need small text conflict
  resolution in LoginPage and App.tsx.

## Authorised staging release (later)

1. Approve and merge, in order: #40 → validity → P1 → #45 → clean-staging-migration-safety → this branch.
2. Create the clean staging backend per `docs/staging/clean-install-migration-baseline.md`.
3. Set Cloudflare Pages **Preview** environment variables to the staging backend and
   build this branch as a preview.
4. Run `BASE_URL=<preview URL> npm run test:e2e` (website and product-boundary checks).
5. Deploy the updated Edge Functions to staging only, then review a test invitation email
   and aXcelerate note text with test data.
6. Product Owner review of the preview homepage on desktop and mobile.
