# Release note — Users: deactivated list and permanent deletion (Issue #40)

Status: implemented on `feature/issue-40-rto-workspace-access`; awaiting Product Owner testing. Not yet released to stable staging.

## What changes for RTO Administration users

**Administration → Users** now has two lists:

- **Active and invited staff** — people who can work in LLND Automate now, and people who have been invited but haven't finished setting up their account. Invited people are shown as *inactive until they set up their account*.
- **Deactivated staff** — people whose access has been switched off. You can reactivate them at any time.

**Permanent deletion.** A **Delete** button appears for deactivated staff and for invitations that haven't been accepted.

- When you press **Delete**, LLND Automate first checks whether the person appears in any recorded history. That includes support cases, interventions, support plans, assessment records, audit records, uploaded files, staff invitations they sent, or the record of who created the organisation.
- If they appear anywhere, deletion is refused and LLND Automate tells you where. Keep them deactivated so the history stays intact.
- If they appear nowhere, you confirm once more and their account and sign-in are removed permanently. This can't be undone. You can invite the same email address again later.
- Active staff can't be deleted. Deactivate them first.
- You can't delete your own account.
- Your organisation always keeps at least one active Administration user.
- Each deletion is recorded: who was deleted, their previous access, who deleted them and when. Only Administration users in your RTO can see this record.

## What does not change

- Deactivation and reactivation work as before.
- No support case, intervention, audit entry or other compliance evidence is ever deleted or left without its owner by this feature.
- Candidate Support and Technical users can't see or use deletion.

## How to test (Product Owner)

1. Sign in to the issue 40 preview as an Administration user and open **Users**.
2. Invite a test address. It appears under **Active and invited staff**. Press **Delete**, confirm, and check that it disappears.
3. Deactivate a test staff user who has never been assigned a support case. They move to **Deactivated staff**. Delete them.
4. Assign a support case to another test user, deactivate them, then press **Delete**. Deletion should be refused and name **Support cases**.
5. Check that reactivating a deactivated user moves them back to the first list.
