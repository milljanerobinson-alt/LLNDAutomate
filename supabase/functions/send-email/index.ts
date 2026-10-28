import { createClient } from "jsr:@supabase/supabase-js@2";
import { getOrganisationEmailProfile, getStaffContext, hasAnyWorkspace } from "../_shared/organisation-access.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, PUT, DELETE, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization, X-Client-Info, Apikey",
};

const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const VALID_NOTIFICATION_TYPES = ["sent", "reminder", "completed", "overdue", "trainer_review", "intervention", "support_plan"];

async function verifyAuth(req: Request) {
  // Issue #40: any active staff member of an RTO (previously role admin/trainer).
  const context = await getStaffContext(req.headers.get("Authorization"));
  return hasAnyWorkspace(context, ["administration", "candidate_support", "technical"]) ? context : null;
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { status: 200, headers: corsHeaders });
  }

  try {
    const auth = await verifyAuth(req);
    if (!auth) {
      return new Response(JSON.stringify({ error: "Unauthorized" }), {
        status: 401,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const requestBody = await req.json();
    const { type, invitation_id, recipient_email, recipient_name, quiz_links, due_date } = requestBody;

    if (!type || !VALID_NOTIFICATION_TYPES.includes(type)) {
      return new Response(JSON.stringify({ error: "Invalid notification type" }), {
        status: 400,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    if (!recipient_email || typeof recipient_email !== "string") {
      return new Response(JSON.stringify({ error: "Recipient email is required" }), {
        status: 400,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    if (invitation_id && !UUID_REGEX.test(invitation_id)) {
      return new Response(JSON.stringify({ error: "Invalid invitation ID format" }), {
        status: 400,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const supabase = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!
    );

    // Issue #40: email on behalf of the caller's own RTO only.
    if (invitation_id) {
      const { data: invitationOrg } = await supabase
        .from("assessment_invitations").select("organisation_id").eq("id", invitation_id).maybeSingle();
      if (!invitationOrg || invitationOrg.organisation_id !== auth.organisationId) {
        return new Response(JSON.stringify({ error: "Invitation not found" }), {
          status: 404,
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }
    }

    // Branding and notification preferences belong to the RTO; the email
    // provider key is platform configuration.
    const [organisationProfile, { data: settingsData }] = await Promise.all([
      getOrganisationEmailProfile(auth.organisationId, supabase),
      supabase.from("settings").select("key, value").in("key", ["RESEND_API_KEY"]),
    ]);

    const settings: Record<string, any> = {};
    settingsData?.forEach((s) => { settings[s.key] = s.value; });

    const orgName = organisationProfile.branding.name || "LLND Automate";
    const notifSettings = organisationProfile.notificationSettings;

    if (notifSettings[type] === false) {
      return new Response(JSON.stringify({ message: "Notification type disabled" }), {
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // Resolve API key: edge function secret takes priority, then settings table
    const RESEND_API_KEY =
      Deno.env.get("RESEND_API_KEY") ||
      (typeof settings["RESEND_API_KEY"] === "string" ? settings["RESEND_API_KEY"] : null);

    let subject = "";
    let htmlBody = "";

    const buildEmailHtml = (title: string, preheader: string, content: string) => `
<!DOCTYPE html>
<html>
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head>
<body style="margin:0;padding:0;background:#f8fafc;font-family:system-ui,-apple-system,sans-serif;">
  <div style="max-width:600px;margin:40px auto;background:#ffffff;border-radius:12px;overflow:hidden;box-shadow:0 1px 3px rgba(0,0,0,0.1);">
    <div style="background:#1e40af;padding:32px 40px;">
      <h1 style="margin:0;color:#ffffff;font-size:22px;font-weight:700;">${orgName}</h1>
      <p style="margin:8px 0 0;color:#bfdbfe;font-size:14px;">${preheader}</p>
    </div>
    <div style="padding:32px 40px;">
      <h2 style="margin:0 0 16px;color:#0f172a;font-size:20px;font-weight:600;">${title}</h2>
      ${content}
    </div>
    <div style="padding:20px 40px;background:#f8fafc;border-top:1px solid #e2e8f0;">
      <p style="margin:0;color:#94a3b8;font-size:12px;">This is an automated message from ${orgName}. Please do not reply to this email.</p>
    </div>
  </div>
</body>
</html>`;

    const btnStyle = 'display:inline-block;background:#1e40af;color:#ffffff;text-decoration:none;padding:12px 24px;border-radius:8px;font-size:14px;font-weight:600;margin:8px 0;';

    switch (type) {
      case "sent":
        subject = `${orgName}: Your LLND Automate Assessment Invitation`;
        let linksHtml = "";
        if (quiz_links) {
          for (const [title, link] of Object.entries(quiz_links)) {
            linksHtml += `<p style="margin:12px 0 4px;font-size:14px;font-weight:600;color:#374151;">${title}</p><a href="${link}" style="${btnStyle}">Start Assessment</a>`;
          }
        }
        htmlBody = buildEmailHtml(
          "You've been invited to complete your LLND Automate Assessments",
          "Language, Literacy, Numeracy & Digital Skills Assessment",
          `<p style="color:#475569;font-size:15px;line-height:1.6;">Hi ${recipient_name},</p>
           <p style="color:#475569;font-size:15px;line-height:1.6;">You have been invited to complete your LLND Automate (Language, Literacy, Numeracy &amp; Digital) assessments. You can complete these at your own pace using the links below.</p>
           ${linksHtml}
           ${due_date ? `<p style="color:#475569;font-size:14px;margin-top:20px;">Please complete all assessments by: <strong>${due_date}</strong></p>` : ""}
           <p style="color:#475569;font-size:14px;margin-top:20px;">If you have any questions, please contact your trainer.</p>`
        );
        break;

      case "reminder":
        subject = `Reminder: Complete Your LLND Automate Assessment — ${orgName}`;
        let reminderLinksHtml = "";
        if (quiz_links) {
          for (const [title, link] of Object.entries(quiz_links)) {
            reminderLinksHtml += `<p style="margin:12px 0 4px;font-size:14px;font-weight:600;color:#374151;">${title}</p><a href="${link}" style="${btnStyle}">Continue Assessment</a>`;
          }
        }
        htmlBody = buildEmailHtml(
          "Friendly Reminder: Assessment Pending",
          "You have an incomplete LLND Automate assessment",
          `<p style="color:#475569;font-size:15px;line-height:1.6;">Hi ${recipient_name},</p>
           <p style="color:#475569;font-size:15px;line-height:1.6;">This is a friendly reminder that you have pending LLND Automate assessments to complete. Use the links below to continue where you left off.</p>
           ${reminderLinksHtml}
           <p style="color:#475569;font-size:14px;margin-top:20px;">If you have already completed these assessments, please disregard this message.</p>`
        );
        break;

      case "completed":
        subject = `Assessment Submitted — ${orgName}`;
        htmlBody = buildEmailHtml(
          "Assessment Submitted Successfully",
          "Your LLND Automate assessments have been submitted",
          `<p style="color:#475569;font-size:15px;line-height:1.6;">Hi ${recipient_name},</p>
           <p style="color:#475569;font-size:15px;line-height:1.6;">Your LLND Automate assessments have been completed and submitted for review. Your trainer will review your results and be in touch with next steps.</p>`
        );
        break;

      case "overdue":
        subject = `Action Required: Overdue Assessment — ${orgName}`;
        htmlBody = buildEmailHtml(
          "Your Assessment is Overdue",
          "Please complete your LLND Automate assessment as soon as possible",
          `<p style="color:#475569;font-size:15px;line-height:1.6;">Hi ${recipient_name},</p>
           <p style="color:#475569;font-size:15px;line-height:1.6;">Your LLND Automate assessments are now overdue. Please complete them as soon as possible by contacting your trainer to arrange access.</p>`
        );
        break;

      default:
        subject = `Assessment Update — ${orgName}`;
        htmlBody = buildEmailHtml(
          "Assessment Update",
          "",
          `<p style="color:#475569;font-size:15px;line-height:1.6;">Hi ${recipient_name},</p>
           <p style="color:#475569;font-size:15px;line-height:1.6;">There is an update regarding your LLND Automate assessment. Please log in to the portal for details.</p>`
        );
    }

    let emailStatus = "sent";

    if (RESEND_API_KEY) {
      const fromAddress = `${orgName} <onboarding@resend.dev>`;

      const res = await fetch("https://api.resend.com/emails", {
        method: "POST",
        headers: {
          "Authorization": `Bearer ${RESEND_API_KEY}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          from: fromAddress,
          to: [recipient_email],
          subject,
          html: htmlBody,
        }),
      });

      if (!res.ok) {
        emailStatus = "failed";
        const resendError = await res.json().catch(() => ({}));
        await supabase.from("notifications").insert({
          invitation_id,
          type,
          recipient_email,
          recipient_name,
          subject,
          body: htmlBody,
          status: emailStatus,
        });
        return new Response(
          JSON.stringify({ error: `Email delivery failed: ${resendError.message || resendError.name || JSON.stringify(resendError)}` }),
          { status: 502, headers: { ...corsHeaders, "Content-Type": "application/json" } }
        );
      }
    } else {
      // No API key configured — log but don't send
      emailStatus = "pending";
    }

    await supabase.from("notifications").insert({
      invitation_id,
      type,
      recipient_email,
      recipient_name,
      subject,
      body: htmlBody,
      status: emailStatus,
    });

    return new Response(
      JSON.stringify({
        message: RESEND_API_KEY ? "Email sent" : "Email queued (no API key configured)",
        subject,
        email_sent: !!RESEND_API_KEY,
      }),
      { headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  } catch (_err) {
    return new Response(JSON.stringify({ error: "An internal error occurred" }), {
      status: 500,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});
