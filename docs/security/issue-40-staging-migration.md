# Issue #40 staging migration runbook

Do not apply the Issue #40 migration until Product Owner approval is recorded.

Before applying it to staging:

1. Create and verify a Supabase backup or point-in-time recovery point.
2. Record row counts for `profiles`, `organisation_memberships`, `user_workspace_access`, `students`, `enrolments`, `assessment_invitations`, `support_cases`, and the four diagnostic/queue tables.
3. Record the active administrator count and the Product Owner's three workspace rows.
4. Configure `PUBLIC_SITE_URL=https://llndautomate.pages.dev` for `invite-rto-staff`. Add only explicitly approved local origins to `INVITATION_REDIRECT_ALLOWLIST`; never use a wildcard.
5. Apply `20260809092000_issue040_rto_workspace_access.sql` through the Supabase migration runner. The explicit transaction rolls back all schema, data, function and RLS changes if any preflight assertion fails.
6. Do not deploy `invite-rto-staff` until the migration succeeds because it depends on the new invitation RPCs.

After applying it, compare the recorded counts, confirm at least one active Administration member, confirm the Product Owner has Administration, Candidate Support and Technical, and test cross-RTO denial before deploying the Edge Function. If validation fails, stop application traffic and restore the verified recovery point; do not attempt an ad-hoc partial rollback of tenancy or RLS changes.
