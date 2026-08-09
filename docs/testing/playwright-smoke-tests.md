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

## Authentication

Authenticated flows are intentionally excluded. A later authenticated suite would
require safe, non-production test credentials supplied only through environment
variables, for example `E2E_TEST_EMAIL` and `E2E_TEST_PASSWORD`. Never commit these
values. Authenticated Cloudflare previews also require their preview hostnames in the
Supabase redirect allowlist (for example `https://*.llndautomate.pages.dev/**`).

## Possible CI follow-up

GitHub Actions is not configured by Issue #35. A later issue could add one small job
that installs Chromium and runs `npm run test:e2e` for pull requests, uploading
`test-results/` only on failure. Keep broader or authenticated suites opt-in to avoid
unnecessary Actions usage.
