# Issue #40 staff invitation and Auth email staging setup

## Application callback

Staff invitations use the trusted `PUBLIC_SITE_URL` plus `/accept-invite`. The
request `Origin` is validated for CORS but never selects the email redirect.
Supabase's implicit Auth response uses the fragment for session or error values;
keeping the application route in the pathname ensures it survives that response.

Required hosted redirect entries:

```text
https://llndautomate.pages.dev/accept-invite
https://*.llndautomate.pages.dev/accept-invite
http://localhost:5173/accept-invite
```

The staging Edge Function currently sends invitations to the first entry because
`PUBLIC_SITE_URL=https://llndautomate.pages.dev`. The preview wildcard permits a
future preview-specific trusted site URL without opening arbitrary external
redirects. Add `https://<production-domain>/accept-invite` only after the
production domain exists.

The Supabase **Site URL** remains `https://llndautomate.pages.dev/` for staging.

## Supabase Auth delivery through Resend

In the hosted Supabase project, open **Authentication → Email → SMTP Settings**
and configure:

```text
Host: smtp.resend.com
Port: 587
Username: resend
Password: dedicated Resend sending credential (hosted secret; never Git)
Sender name: LLND Automate
Sender email: the currently verified Resend-approved staging sender
```

Prefer a separate restricted Resend credential for Supabase Auth. The existing
Edge Function `RESEND_API_KEY` is not inherited by hosted Supabase Auth and must
not be copied into source control. No new sender-domain verification is required
for Issue #40 if the selected staging sender is already approved by Resend.

## Hosted Invite User template

Subject:

```text
You've been invited to LLND Automate
```

Body:

```html
<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <title>You've been invited to LLND Automate</title>
  </head>
  <body style="margin:0;background:#f8fafc;font-family:Arial,sans-serif;color:#0f172a;">
    <table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="background:#f8fafc;padding:32px 16px;">
      <tr>
        <td align="center">
          <table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="max-width:600px;background:#ffffff;border:1px solid #e2e8f0;border-radius:12px;">
            <tr>
              <td style="padding:32px;">
                <h1 style="margin:0 0 24px;color:#2563EB;font-size:28px;">LLND Automate</h1>
                <h2 style="margin:0 0 16px;font-size:22px;">You've been invited</h2>
                <p style="margin:0 0 16px;line-height:1.6;">Your RTO has invited you to access LLND Automate as a staff member.</p>
                <p style="margin:0 0 24px;line-height:1.6;">Finish setting up your staff account by choosing a secure password.</p>
                <p style="margin:0 0 28px;">
                  <a href="{{ .ConfirmationURL }}" style="display:inline-block;background:#2563EB;color:#ffffff;text-decoration:none;font-weight:700;padding:13px 22px;border-radius:8px;">Set up your LLND Automate account</a>
                </p>
                <p style="margin:0 0 8px;font-size:13px;color:#475569;line-height:1.5;">If the button does not work, copy and paste this link into your browser:</p>
                <p style="margin:0 0 24px;font-size:13px;line-height:1.5;word-break:break-all;"><a href="{{ .ConfirmationURL }}" style="color:#2563EB;">{{ .ConfirmationURL }}</a></p>
                <p style="margin:0;font-size:13px;color:#64748b;line-height:1.5;">Invitation links may expire. If this link is invalid or expired, contact your RTO administrator and ask for a new invitation.</p>
              </td>
            </tr>
          </table>
        </td>
      </tr>
    </table>
  </body>
</html>
```

Keep `{{ .ConfirmationURL }}` exactly as shown. Supabase generates the secure
one-time action URL and includes the trusted `/accept-invite` redirect supplied
by `invite-rto-staff`.

## Related Auth templates

- **Reset Password:** use LLND Automate branding and a single “Reset your
  password” CTA with `{{ .ConfirmationURL }}`. The complete reset experience
  remains Issue #23.
- **Confirm Signup:** if self-signup email confirmation remains enabled, explain
  that the user is confirming a new RTO account, not accepting a staff invite.
- **Magic Link/OTP:** if enabled later, use a clearly labelled sign-in CTA/code,
  state the short expiry, and never describe it as staff invitation acceptance.

## Staging and pre-launch boundaries

Staging now uses Resend delivery, the sender name **LLND Automate**, branded Auth
content, and a currently approved temporary sender address.

Before production launch, Issues #16 and #44 must cover purchasing the production
domain, verifying its sender domain in Resend, SPF, DKIM, DMARC monitoring, changing
the sender to an LLND-controlled address such as `noreply@<production-domain>`,
aligning assessment and Auth sender identities, and removing production use of
`onboarding@resend.dev`.
