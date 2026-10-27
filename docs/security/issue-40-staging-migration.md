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

Hosted Auth redirect, Resend SMTP and Invite User template steps are documented in
`issue-40-auth-invitation-setup.md` and must be completed before Product Owner testing.
