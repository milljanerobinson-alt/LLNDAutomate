# Cloudflare Pages staging environment

Tracking issue: #32 — LLND Automate staging environment on Cloudflare Pages.

This runbook configures a non-production staging project only. Do not attach a custom
domain or reuse these settings as a production deployment model.

## Repository compatibility

- Framework: Vite / React
- Build command: `npm run build`
- Output directory: `dist`
- Root directory: repository root
- Staging deployment branch: `main`
- Preview deployments: enabled for all non-production branches and pull requests
- SPA routing: preserve `public/_redirects`; Vite copies it into `dist/_redirects`

The current redirects are:

```text
/oauth/consent  /eios#/oauth/consent  302
/*  /index.html  200
```

The first rule preserves the EIOS OAuth consent boundary. The second provides the
Cloudflare Pages SPA fallback required for direct navigation.

## Cloudflare Pages project settings

Create one Cloudflare Pages project through GitHub integration:

1. Select the `milljanerobinson-alt/LLNDAutomate` repository.
2. Select Vite as the framework preset.
3. Set the production branch to `main`. In this project, the Cloudflare
   "production branch" is the **non-production staging source**.
4. Set the build command to `npm run build`.
5. Set the build output directory to `dist`.
6. Leave the root directory at the repository root.
7. Enable automatic deployments for `main`.
8. Enable preview deployments for all other branches and pull requests.
9. Keep the generated `*.pages.dev` hostname.
10. Do not add a custom domain and do not add a Cloudflare Access restriction if
    previews must be publicly reachable for automated browser testing.

A push merged into `main` updates the stable staging URL. Feature branches and pull
requests receive immutable deployment URLs and, where Cloudflare provides them,
branch aliases under the same `pages.dev` project.

A dedicated staging branch is not needed yet. Consider one later only if `main`
begins representing a separately controlled production release line.

## Environment variables

Configure these in Cloudflare Pages for both the staging/production environment
(`main`) and preview environment:

| Variable | Classification | Notes |
| --- | --- | --- |
| `VITE_SUPABASE_URL` | Public Vite/client configuration | Supabase project URL embedded in the browser bundle. |
| `VITE_SUPABASE_ANON_KEY` | Public Vite/client configuration | Supabase publishable/anon key embedded in the browser bundle; database protection must rely on RLS and grants. |

Do not configure or expose these server/test-only values in Cloudflare Pages:

- `SUPABASE_SERVICE_ROLE_KEY`
- Any Supabase secret key
- Any database password
- GitHub tokens, OAuth client secrets, or provider credentials

The repository also contains test-only references to `SUPABASE_URL`,
`SUPABASE_ANON_KEY`, and `DRY_RUN`. They are not required by the browser
deployment. Never rename a service-role key with a `VITE_` prefix.

Do not commit environment values to Git. Cloudflare values must be entered in the
Pages project settings.

## Supabase Auth configuration

The live staging configuration in Supabase Dashboard → Authentication → URL
Configuration is:

- **Site URL:** `https://llndautomate.pages.dev/`
- **Redirect URL:** `https://llndautomate.pages.dev/**`
- **Local redirect retained:** `http://localhost:5173/**`

Do not remove existing authorised URLs until their consumers are confirmed retired.
Before authenticated preview testing is introduced, add a redirect pattern for Cloudflare
preview subdomains such as `https://*.llndautomate.pages.dev/**`.

The application derives OAuth and password-recovery destinations from
`window.location.origin` and the active product boundary:

- LLND Automate: `https://llndautomate.pages.dev/`
- EIOS: `https://llndautomate.pages.dev/eios`

For Google or Apple sign-in, the provider console callback normally remains the
Supabase callback URL
`https://<supabase-project-ref>.supabase.co/auth/v1/callback`. Confirm it is still
registered; do not substitute the Pages URL for the provider callback.

Supabase OAuth-server consent continues to enter at `/oauth/consent`, which
Cloudflare redirects to the EIOS hash route.

## Live staging record

- Staging URL: `https://llndautomate.pages.dev`
- GitHub repository: `milljanerobinson-alt/LLNDAutomate`
- Deployment branch: `main`
- Automatic deployments: enabled
- Build command: `npm run build`
- Output directory: `dist`
- Custom domain: none
- Hosting boundary: Cloudflare-provided `*.pages.dev` only
- Required Vite variables configured: `VITE_SUPABASE_URL` and
  `VITE_SUPABASE_ANON_KEY`

Read-only verification on 9 August 2026 confirmed HTTP 200 for `/`, `/eios`,
`/llnd`, `/lln`, and a direct nested path. The deployed JavaScript contains
resolved Supabase client configuration, and the Supabase Auth settings endpoint
responded successfully when called with the deployed public client key. No secret
values were printed or committed.

Interactive browser rendering, console inspection, the Back-to-website click and a
real preview deployment remain Product Owner/manual checks because the verification
environment could not install its browser runtime and no unrelated deployment was
created solely to test previews.

## Deployment verification

After the first deployment, verify:

- `/` loads LLND Automate and the title is **LLND Automate**.
- `/eios` loads EIOS and the title changes to **EIOS**.
- `/llnd` and `/lln` migrate to the LLND root without loops.
- `/#/llnd-automate/login` loads the LLND login.
- **Back to website** returns to the staging root.
- Direct requests to app paths do not return a Cloudflare 404.
- OAuth and password-recovery links stay on the correct product hostname/path.
- The browser console has no new runtime errors.
- Built assets and page source contain no service-role keys, passwords, tokens, or
  other server credentials.
- A feature branch or PR preview URL is publicly reachable without authentication.

Record the stable staging URL and one verified preview URL on issue #32 after
deployment.
