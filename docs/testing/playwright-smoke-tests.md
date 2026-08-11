# Playwright staging smoke tests

The lightweight smoke suite checks the LLND/EIOS product boundary against Cloudflare
Pages in Chromium. It runs the same six unauthenticated tests at desktop (1440×900)
and mobile (390×844) viewports.

## Run on demand

Install the Chromium runtime once:

```bash
npx playwright install chromium
```

Run against the default staging site:

```bash
npm run test:e2e
```

Override the target for a Cloudflare preview or local server:

```bash
BASE_URL=https://preview.example.pages.dev npm run test:e2e
BASE_URL=http://localhost:5173 npm run test:e2e
```

The suite uses a compact line reporter. Screenshots and traces are retained only when
a test fails, under `test-results/`; successful runs do not retain browser artifacts.
It fails on uncaught page exceptions, browser console errors, and failed or HTTP-error
document, script, or stylesheet requests.

## Issue #40 authenticated staging gate

The authenticated suite is deliberately separate from the 12-test public smoke suite.
It must target the actual HTTPS Cloudflare branch preview and staging Supabase backend,
using dedicated test identities rather than the Product Owner account. Values are read
only from environment variables and must never be committed:

```text
BASE_URL
E2E_SUPABASE_URL
E2E_SUPABASE_ANON_KEY
E2E_SUPABASE_SERVICE_ROLE_KEY
E2E_ADMIN_EMAIL
E2E_ADMIN_PASSWORD
E2E_CANDIDATE_SUPPORT_EMAIL
E2E_CANDIDATE_SUPPORT_PASSWORD
E2E_TECHNICAL_EMAIL
E2E_TECHNICAL_PASSWORD
E2E_INVITE_EMAIL
E2E_INVITE_PASSWORD
```

The permanent staging convention is Admin Test (`milljanerobinson+admin@gmail.com`),
Candidate Support Test (`milljanerobinson+cs@gmail.com`) and Technical Test
(`milljanerobinson+tech@gmail.com`). The Administration identity has all three staff
workspaces; the limited identity has Candidate Support only; the Technical identity has
Technical only. `E2E_INVITE_EMAIL` must be a separate disposable `+e2e` address.
The service-role key remains in the Playwright Node process and is used only
to prepare/assert/remove the disposable fixture and generate a deterministic
Supabase invitation action link; it is never injected into the browser. The test
opens the real Auth verification endpoint and `/accept-invite` UI, sets the password
in the browser, and then verifies the same membership and exact workspace grant.
Generating the action link is the closest deterministic substitute for reading the
actual invitation from an external mailbox; the separate browser test still verifies
that the deployed `invite-rto-staff` OPTIONS and POST requests succeed.

Run the authenticated gate:

```bash
BASE_URL=https://<branch-preview>.llndautomate.pages.dev \
E2E_SUPABASE_URL=... \
E2E_SUPABASE_ANON_KEY=... \
E2E_SUPABASE_SERVICE_ROLE_KEY=... \
E2E_ADMIN_EMAIL=... E2E_ADMIN_PASSWORD=... \
E2E_CANDIDATE_SUPPORT_EMAIL=... E2E_CANDIDATE_SUPPORT_PASSWORD=... \
E2E_TECHNICAL_EMAIL=... E2E_TECHNICAL_PASSWORD=... \
E2E_INVITE_EMAIL=... E2E_INVITE_PASSWORD=... \
npm run test:e2e:authenticated
```

Issue #40 is not ready for Product Owner testing until focused/security tests and the
production build pass, followed by both `npm run test:e2e` and the authenticated command
above against the actual branch preview and staging backend.

## Possible CI follow-up

GitHub Actions is not configured by Issue #35. A later issue could add one small job
that installs Chromium and runs `npm run test:e2e` for pull requests, uploading
`test-results/` only on failure. Keep broader or authenticated suites opt-in to avoid
unnecessary Actions usage.
