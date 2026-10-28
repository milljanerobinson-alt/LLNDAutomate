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

After the original Issue #40 migration, apply the forward-only
`20260811040000_issue040_activate_invitation_after_password.sql` before testing
new invitation acceptance. It replaces only the already-installed activation
function/trigger so confirmation alone remains invited/inactive and activation
occurs atomically after password setup. Apply it through the normal migration
runner; its explicit transaction rolls back the function and trigger replacement
together on failure. The previously applied migration files must not be edited.

## Conditional staff deletion (Product Owner refinement, 12 August 2026)

`20261028120000_issue040_conditional_staff_deletion.sql` is forward-only and must
be applied after the four earlier Issue #40 migrations. It adds:

- `staff_deletion_audit` — a record of every permanent staff deletion, readable
  only by Administration users of the same RTO;
- `get_staff_deletion_blockers(target_user)` — lists, in plain language, the
  kinds of recorded history that stop a user from being deleted;
- `delete_organisation_member(target_user)` — deletes a deactivated or invited
  staff user only when nothing records them, keeping last-Administration
  protection. It removes the Supabase Auth user in the same transaction.

Before applying it to a shared environment:

1. Create and verify a Supabase backup or point-in-time recovery point.
2. Record row counts for `profiles`, `organisation_memberships`,
   `user_workspace_access` and `staff_invitation_grants`.
3. Apply it through the normal migration runner. Its explicit transaction rolls
   back every object together on failure.

After applying it, confirm in staging that:

- deleting a deactivated user with an assigned support case or intervention note
  is refused and leaves the user and the record unchanged;
- deleting an unreferenced invited user removes the Auth user, membership and
  invitation grant, and writes one `staff_deletion_audit` row. This also confirms
  the database owner role is permitted to delete from `auth.users` on the hosted
  project; if it is not, the whole deletion rolls back and the error is shown.

## Organisation-scoped Administration and Technical data (refinement, scope confirmed 28 October 2026)

`20261028130000_issue040_organisation_data_scoping.sql` is forward-only and must
be applied after `20261028120000_issue040_conditional_staff_deletion.sql`. It:

- gives qualifications, subscriptions and billing events an owning organisation,
  and scopes LLN requirements, ACSF mapping evidence, mapping logs, billing usage
  and billable learners through them;
- moves RTO configuration (branding, email/reminder/notification settings, RTO
  number/state, aXcelerate watch list and auto-sync) into `organisation_settings`;
- makes the platform `settings` table server-only, except the non-secret
  `environment` key;
- bills each completed assessment to the candidate's own RTO subscription;
- stamps server-written email/aXcelerate queue and log rows with the related
  invitation's RTO (previously these server inserts were refused).

Legacy rows (created before organisations existed) are assigned to one legacy
organisation. If exactly one organisation exists it is used automatically. If
several exist, the migration stops with a message, changes nothing, and must be
re-run after choosing the owner, in the same SQL Editor run:

```sql
SELECT set_config('llnd.legacy_organisation_id', '<organisation uuid>', false);
-- then the full migration file
```

Before applying it to a shared environment:

1. Run `supabase/inspection/issue040_staging_inspection.sql` and keep the result.
2. Create and verify a Supabase backup or point-in-time recovery point.
3. Record row counts for `qualifications`, `qualification_lln_requirements`,
   `qualification_mapping_evidence`, `settings`, `subscriptions`, `billing_usage`,
   `billable_learners` and `billing_events`.

After applying it, confirm that the same row counts are unchanged, that every
`qualifications` and `subscriptions` row has an `organisation_id`, and that
`organisation_settings` holds the RTO configuration keys that were in `settings`.

Deploy these Edge Functions after the migration (they read the new columns and
`legacy_server_settings_organisation_id`): `_shared/organisation-access.ts` with
`axcelerate-bulk-sync`, `axcelerate-inbound-sync`, `axcelerate-sync`,
`compute-acsf-mapping`, `import-axcelerate-qualifications`,
`process-axcelerate-queue`, `save-axcelerate-secrets`, `save-stripe-key`,
`stripe-checkout`, `stripe-portal`, `stripe-webhook`,
`test-axcelerate-connection`, `upload-axcelerate-portfolio`, `send-email`,
`on-assessment-complete`, `process-email-queue` and `send-admin-otp`.

`stripe-webhook` now refuses events unless `STRIPE_WEBHOOK_SECRET` is configured
and Stripe's signature is valid.

## Recovery

All three newer Issue #40 migrations run in a single transaction: if any step
fails, nothing is changed. After a successful apply, do not hand-edit tables or
policies to undo it. If validation fails, stop testing and restore the verified
recovery point taken beforehand, then report the inspection result and the error.

Hosted Auth redirect, Resend SMTP and Invite User template steps are documented in
`issue-40-auth-invitation-setup.md` and must be completed before Product Owner testing.
