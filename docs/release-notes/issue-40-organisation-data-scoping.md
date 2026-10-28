# Release note — RTO data belongs to the RTO (Issue #40)

Status: implemented on `feature/issue-40-rto-workspace-access`; awaiting staging database alignment and Product Owner testing. Not yet released to stable staging.

## What changes

**Qualifications.** Each RTO now has its own qualifications, LLN requirements and ACSF mapping evidence.
- Two Administration users in the same RTO see the same qualifications.
- Another RTO can't see or change them.
- Candidate Support and Technical users in the same RTO can view qualifications but can't change them.

**RTO settings.** Branding, email and reminder settings, RTO number and state, and the aXcelerate watch list and auto-sync setting are saved per RTO.
- Administration manages the RTO settings.
- Technical, or Administration, manages the aXcelerate watch list and auto-sync setting.

**Platform secrets.** Platform passwords and keys (Stripe, AI providers, email and aXcelerate tokens, scheduled-job secret) can no longer be read or changed from any browser. Only server functions can use them.

**Billing.**
- Each RTO's subscription, usage, billable candidates and billing history are visible only to that RTO's Administration users.
- A completed assessment is counted against the candidate's own RTO. Previously it went to the newest subscription on the platform.
- The Stripe checkout and billing-portal functions now require an Administration user and only use that RTO's subscription.
- Stripe notifications are accepted only when Stripe's signature is valid.

**aXcelerate (interim).** The platform still has one set of aXcelerate credentials, belonging to the original RTO. Until each RTO can connect its own aXcelerate account:
- only that RTO's Administration or Technical users can use or change the connection;
- other RTOs' candidates are never sent to it.

## What does not change

- Candidates still use their assessment links, and nothing changes for them.
- Pricing plans remain visible on the public pricing page.
- Existing qualifications, settings and subscriptions are kept and assigned to the original RTO.

## Known limits (follow-on work)

- Emails and aXcelerate write-backs still use the original RTO's branding and email settings for every RTO.
- A second RTO can't yet connect its own aXcelerate account. Automatic aXcelerate sync can't create candidates for any RTO while more than one RTO exists.
- Some EIOS engineering screens can no longer read secrets in the browser. The "startup catch-up" for scheduled briefings and the "configured keys" indicator will show nothing until those screens use a server check.

## How to test (Product Owner)

1. Sign in as an Administration user of your RTO, open **Qualifications**, and check your qualifications are all there.
2. Sign in as an Administration user of a second test RTO. The first RTO's qualifications, settings and billing must not appear.
3. As a Technical-only user, open the aXcelerate inbound page and add and remove a watch-list contact.
4. As Candidate Support, check qualifications are visible but can't be edited.
