# Issue #45 platform-operator access runbook

Status: implemented on `feature/issue-45-platform-operator-access`. **Not applied
or deployed.** The staging hold remains until the Product Owner approves.

## What changes

- EIOS (the engineering workspace) and RTO support need an explicit
  **platform-operator grant plus MFA** (an authenticator-app code). The legacy
  `profiles.role = 'admin'` value no longer gives EIOS access. That includes
  the four permanent RTO test identities, which keep their RTO workspaces.
- Operators support one RTO at a time through a **support session**: a
  mandatory reason, up to 60 minutes, an End session button and a banner
  ("Supporting: <RTO> — ends hh:mm").
- Support access is **read-only**. Views: organisation summary, staff and
  statuses, integration and sync status, email activity (recipients masked),
  qualifications and subscription status. No settings values, credentials,
  Stripe identifiers, candidate answers or raw integration payloads.
- Every view is recorded. The RTO's Administration sees it under
  Organisation → *Platform support access*, labelled "LLND Automate platform
  support — <name>", with the reason, times and which information was viewed.
- Secret-saving functions (`save-llm-secret`, `save-email-secret`,
  `save-provider-key`, `save-stripe-key`) need an MFA operator; they still
  never return stored values. EIOS Edge Functions need an operator, or a
  trusted server-to-server call with the service-role key.
- All EIOS tables become operator-only in the database; anonymous access is
  removed and EIOS views run with the caller's permissions.

## Order of operations (when approved)

1. Issue #40 staging alignment first: the #45 migration refuses to run unless
   the Issue #40 migrations are present.
2. Run `supabase/inspection/issue040_staging_inspection.sql` and review its
   table list and `legacy_role_policies` against the EIOS prefix list in the
   migration. Anything not covered must be reviewed before applying. (After
   the migration, `SELECT * FROM public.issue045_eios_tables_preview();`
   lists every relation it treated as EIOS.)
3. Create a backup / point-in-time recovery point.
4. In Supabase Auth, enable **TOTP MFA** (Authentication → Multi-Factor).
5. Apply `20261028140000_issue045_platform_operator_access.sql` through the
   migration runner (single transaction; any failure rolls it all back).
6. Deploy `_shared/platform-operator.ts` users together: `operator-support`,
   the four secret functions, the guarded EIOS functions and `atd-mcp-server`.
7. Deploy the app (Cloudflare Pages).

Until step 8, **nobody** (including the Product Owner) can open EIOS. That is
expected.

## 8. Bootstrap the first operator (Product Owner, SQL Editor only)

The browser and the API cannot grant operator access. In the Supabase SQL
Editor:

```sql
SELECT public.grant_platform_operator('<operator email>', '<reason, at least 10 characters>');
```

To remove access:

```sql
SELECT public.revoke_platform_operator('<operator email>', '<reason>');
```

Both are recorded in `platform_operator_audit`. The operator then signs in at
`/eios`, enrols an authenticator app on first use, and enters a code each time.

## Staging operator test account

- Create a **new** account (for example `milljanerobinson+operator@gmail.com`).
  It must not be one of the four RTO test identities and must not be the
  Product Owner's own account; the e2e helper refuses both.
- Grant it with the SQL above, sign in once at `/eios`, enrol TOTP and keep the
  setup key (shown as the QR code's secret) in the password manager.
- Add secure environment variables for the authenticated run:
  `E2E_OPERATOR_EMAIL`, `E2E_OPERATOR_PASSWORD`, `E2E_OPERATOR_TOTP_SECRET`
  (base32 setup key). Never commit or print them.
- Run `npm run test:e2e:operator` with the existing Issue #40 variables and
  `BASE_URL` set to the branch preview.

## Known dependency: MCP connector

The MCP server now requires an operator, which means an MFA (aal2) session.
Whether tokens issued through the OAuth connector flow carry `aal2` must be
checked on staging after MFA is enabled. If they do not, the connector stops
working for EIOS until an approved follow-up (for example requiring MFA during
the OAuth consent sign-in).

## Recovery

Forward-only. If validation fails, restore the recovery point from step 3.
Do not hand-edit policies. Revoking an operator takes effect on their next
request.
