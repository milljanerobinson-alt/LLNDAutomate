import { createClient } from "jsr:@supabase/supabase-js@2";
import { createEmailProfileCache, getStaffContext, hasAnyWorkspace } from "../_shared/organisation-access.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, PUT, DELETE, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization, X-Client-Info, Apikey",
};

const MAX_ATTEMPTS = 3;
const BATCH_SIZE = 20;

const EMAIL_TYPE_LABELS: Record<string, string> = {
  invitation: "sent",
  reminder_1: "reminder",
  reminder_2: "reminder",
  reminder_3: "reminder",
  completion_admin: "completed",
  completion_student: "completed",
};

const EMAIL_SUBJECTS: Record<string, string> = {
  invitation: "Your LLND Automate Assessment Invitation",
  reminder_1: "Reminder: Complete Your LLND Automate Assessment",
  reminder_2: "Second Reminder: Your LLND Automate Assessment is Pending",
  reminder_3: "Final Reminder: Action Required — LLND Automate Assessment",
  completion_admin: "Assessment Completed — Review Required",
  completion_student: "Your Assessment Has Been Submitted",
};

function buildEmailHtml(
  orgName: string,
  title: string,
  preheader: string,
  content: string,
): string {
  return `<!DOCTYPE html>
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
}

const BTN =
  "display:inline-block;background:#1e40af;color:#ffffff;text-decoration:none;padding:12px 24px;border-radius:8px;font-size:14px;font-weight:600;margin:16px 0;";

function buildContent(
  emailType: string,
  recipientName: string,
  orgName: string,
  extraData: Record<string, unknown>,
): { subject: string; html: string } {
  const name = recipientName || "there";
  const portalUrl = (extraData.portal_url as string) || "";
  const dueDate = (extraData.due_date as string) || null;
  const qualificationName = (extraData.qualification_name as string) || "";
  const completedAt = (extraData.completed_at as string) || "";
  const resultsUrl = (extraData.results_url as string) || "";

  const subject = `${EMAIL_SUBJECTS[emailType] || "Assessment Update"} — ${orgName}`;

  let html = "";

  switch (emailType) {
    case "invitation":
      html = buildEmailHtml(
        orgName,
        "You've Been Invited to Complete Your LLND Automate Assessment",
        "Language, Literacy, Numeracy & Digital Skills Assessment",
        `<p style="color:#475569;font-size:15px;line-height:1.6;">Hi ${name},</p>
         <p style="color:#475569;font-size:15px;line-height:1.6;">You have been invited to complete your LLND Automate (Language, Literacy, Numeracy &amp; Digital) assessment${qualificationName ? ` as part of your enrolment in <strong>${qualificationName}</strong>` : ""}. You can complete this at your own pace using the link below.</p>
         ${portalUrl ? `<p style="margin:20px 0;"><a href="${portalUrl}" style="${BTN}">Start My Assessment</a></p>` : ""}
         ${dueDate ? `<p style="color:#475569;font-size:14px;">Please complete your assessment by: <strong>${dueDate}</strong></p>` : ""}
         <p style="color:#475569;font-size:14px;margin-top:20px;">If you have any questions, please contact your trainer or training provider.</p>`,
      );
      break;

    case "reminder_1":
      html = buildEmailHtml(
        orgName,
        "Friendly Reminder: Your Assessment is Waiting",
        "You have a pending LLND Automate assessment",
        `<p style="color:#475569;font-size:15px;line-height:1.6;">Hi ${name},</p>
         <p style="color:#475569;font-size:15px;line-height:1.6;">This is a friendly reminder that you have a pending LLND Automate assessment to complete. It only takes a short time and can be done from any device.</p>
         ${portalUrl ? `<p style="margin:20px 0;"><a href="${portalUrl}" style="${BTN}">Continue My Assessment</a></p>` : ""}
         ${dueDate ? `<p style="color:#475569;font-size:14px;">Completion due: <strong>${dueDate}</strong></p>` : ""}
         <p style="color:#475569;font-size:14px;margin-top:20px;">If you have already completed your assessment, please disregard this message.</p>`,
      );
      break;

    case "reminder_2":
      html = buildEmailHtml(
        orgName,
        "Second Reminder: Please Complete Your Assessment",
        "Action still required — LLND Automate assessment pending",
        `<p style="color:#475569;font-size:15px;line-height:1.6;">Hi ${name},</p>
         <p style="color:#475569;font-size:15px;line-height:1.6;">We noticed your LLND Automate assessment is still incomplete. Completing this assessment helps us tailor the right support for you throughout your training.</p>
         ${portalUrl ? `<p style="margin:20px 0;"><a href="${portalUrl}" style="${BTN}">Complete My Assessment Now</a></p>` : ""}
         ${dueDate ? `<p style="color:#e53e3e;font-size:14px;font-weight:600;">Due date: ${dueDate}</p>` : ""}
         <p style="color:#475569;font-size:14px;margin-top:20px;">Please contact your trainer if you are experiencing any difficulties accessing the assessment.</p>`,
      );
      break;

    case "reminder_3":
      html = buildEmailHtml(
        orgName,
        "Final Reminder: Assessment Due Soon",
        "Urgent — please complete your LLND Automate assessment",
        `<p style="color:#475569;font-size:15px;line-height:1.6;">Hi ${name},</p>
         <p style="color:#e53e3e;font-size:15px;line-height:1.6;font-weight:600;">This is your final reminder to complete your LLND Automate assessment.</p>
         <p style="color:#475569;font-size:15px;line-height:1.6;">Completing this assessment is a requirement of your enrolment${qualificationName ? ` in <strong>${qualificationName}</strong>` : ""}. Please complete it as soon as possible.</p>
         ${portalUrl ? `<p style="margin:20px 0;"><a href="${portalUrl}" style="display:inline-block;background:#dc2626;color:#ffffff;text-decoration:none;padding:12px 24px;border-radius:8px;font-size:14px;font-weight:600;margin:16px 0;">Complete Assessment — Final Reminder</a></p>` : ""}
         ${dueDate ? `<p style="color:#dc2626;font-size:14px;font-weight:600;">Due: ${dueDate}</p>` : ""}
         <p style="color:#475569;font-size:14px;margin-top:20px;">If you are unable to complete the assessment, please contact your trainer immediately.</p>`,
      );
      break;

    case "completion_admin":
      html = buildEmailHtml(
        orgName,
        "Assessment Completed — Trainer Review Required",
        `${name} has submitted their LLND Automate assessment`,
        `<p style="color:#475569;font-size:15px;line-height:1.6;">A learner has completed their LLND Automate assessment and their results are ready for your review.</p>
         <table style="width:100%;border-collapse:collapse;margin:16px 0;">
           <tr><td style="padding:8px 12px;background:#f8fafc;border-radius:4px;font-size:14px;font-weight:600;color:#374151;width:140px;">Learner</td><td style="padding:8px 12px;font-size:14px;color:#475569;">${name}</td></tr>
           ${qualificationName ? `<tr><td style="padding:8px 12px;background:#f8fafc;border-radius:4px;font-size:14px;font-weight:600;color:#374151;">Qualification</td><td style="padding:8px 12px;font-size:14px;color:#475569;">${qualificationName}</td></tr>` : ""}
           ${completedAt ? `<tr><td style="padding:8px 12px;background:#f8fafc;border-radius:4px;font-size:14px;font-weight:600;color:#374151;">Completed At</td><td style="padding:8px 12px;font-size:14px;color:#475569;">${completedAt}</td></tr>` : ""}
         </table>
         ${resultsUrl ? `<p style="margin:20px 0;"><a href="${resultsUrl}" style="${BTN}">View Results &amp; Support Plan</a></p>` : ""}
         <p style="color:#475569;font-size:14px;margin-top:20px;">Please review the results and generate a support plan as required.</p>`,
      );
      break;

    case "completion_student":
      html = buildEmailHtml(
        orgName,
        "Your Assessment Has Been Submitted",
        "LLND Automate assessment completed successfully",
        `<p style="color:#475569;font-size:15px;line-height:1.6;">Hi ${name},</p>
         <p style="color:#475569;font-size:15px;line-height:1.6;">Your LLND Automate assessment has been successfully submitted. Your trainer will review your results and be in touch with any next steps or support recommendations.</p>
         ${completedAt ? `<p style="color:#475569;font-size:14px;">Submitted: <strong>${completedAt}</strong></p>` : ""}
         <p style="color:#475569;font-size:14px;margin-top:20px;">Thank you for completing your assessment.</p>`,
      );
      break;

    default:
      html = buildEmailHtml(
        orgName,
        "Assessment Update",
        "",
        `<p style="color:#475569;font-size:15px;line-height:1.6;">Hi ${name},</p>
         <p style="color:#475569;font-size:15px;line-height:1.6;">There is an update regarding your LLND Automate assessment. Please contact your trainer for details.</p>`,
      );
  }

  return { subject, html };
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { status: 200, headers: corsHeaders });
  }

  try {
    // Auth: service role key OR cron secret header OR admin/trainer session
    const authHeader = req.headers.get("Authorization") || "";
    const cronSecret = req.headers.get("X-Cron-Secret") || "";
    const isServiceCall = authHeader === `Bearer ${Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")}`;

    let isCronCall = false;
    if (!isServiceCall && cronSecret) {
      // Validate against the cron_secret stored in settings
      const svcClient = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);
      const { data: row } = await svcClient.from("settings").select("value").eq("key", "cron_secret").maybeSingle();
      isCronCall = row?.value === cronSecret || row?.value?.toString() === cronSecret;
    }

    // Issue #40: a signed-in staff member may only process their own RTO's emails.
    let callerOrganisationId: string | null = null;
    if (!isServiceCall && !isCronCall) {
      const anonClient = createClient(
        Deno.env.get("SUPABASE_URL")!,
        Deno.env.get("SUPABASE_ANON_KEY")!,
        { global: { headers: { Authorization: authHeader } } },
      );
      const { data: { user }, error: authErr } = await anonClient.auth.getUser();
      if (authErr || !user) {
        return new Response(JSON.stringify({ error: "Unauthorized" }), {
          status: 401,
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }
      const staff = await getStaffContext(authHeader);
      if (!hasAnyWorkspace(staff, ["administration", "candidate_support", "technical"])) {
        return new Response(JSON.stringify({ error: "Unauthorized" }), {
          status: 401,
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }
      callerOrganisationId = staff!.organisationId;
    }

    // Parse optional body params
    const body = req.method === "POST" ? await req.json().catch(() => ({})) : {};
    const specificQueueId: string | null = body.queue_id ?? null;
    const invitationId: string | null = body.invitation_id ?? null;

    const supabase = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
    );

    // Platform email provider key; branding and email preferences are per RTO (Issue #40).
    const { data: settingsRows } = await supabase
      .from("settings")
      .select("key, value")
      .in("key", ["RESEND_API_KEY"]);

    const settings: Record<string, any> = {};
    (settingsRows || []).forEach((s: any) => { settings[s.key] = s.value; });

    const emailProfileFor = createEmailProfileCache(supabase);
    const brandingFor = async (organisationId: string | null | undefined) => {
      const profile = await emailProfileFor(organisationId);
      return {
        orgName: (profile.branding.name as string) || "LLND Automate Assessment Platform",
        adminEmail: (profile.branding.contact_email as string) || "",
        emailSettings: profile.emailSettings,
      };
    };

    const RESEND_API_KEY: string =
      Deno.env.get("RESEND_API_KEY") ||
      (typeof settings["RESEND_API_KEY"] === "string" ? settings["RESEND_API_KEY"] : "");

    // --- Step 1: Auto-detect completed invitations missing completion emails ---
    let completedQuery = supabase
      .from("assessment_invitations")
      .select("id, organisation_id, candidate_name, candidate_email, qualification_id, completed_at")
      .eq("status", "completed")
      .not("completed_at", "is", null);
    if (callerOrganisationId) completedQuery = completedQuery.eq("organisation_id", callerOrganisationId);
    const { data: completedInvs } = await completedQuery;

    if (completedInvs && completedInvs.length > 0) {
      for (const inv of completedInvs) {
        const { orgName, adminEmail, emailSettings } = await brandingFor(inv.organisation_id);
        // Check if completion_admin email already exists for this invitation
        const { data: existing } = await supabase
          .from("email_queue")
          .select("id")
          .eq("invitation_id", inv.id)
          .eq("email_type", "completion_admin")
          .maybeSingle();

        if (!existing) {
          // Load qualification name
          let qualName = "";
          if (inv.qualification_id) {
            const { data: qual } = await supabase
              .from("qualifications")
              .select("name, code")
              .eq("id", inv.qualification_id)
              .maybeSingle();
            if (qual) qualName = `${qual.code} ${qual.name}`;
          }

          const origin = Deno.env.get("SITE_URL") || "https://app.example.com";
          const completedAtFormatted = inv.completed_at
            ? new Date(inv.completed_at).toLocaleString("en-AU", {
                day: "numeric", month: "short", year: "numeric",
                hour: "2-digit", minute: "2-digit",
              })
            : "";

          const extraData = {
            qualification_name: qualName,
            completed_at: completedAtFormatted,
            portal_url: `${origin}/#/student/${inv.id}`,
          };

          // Insert completion_admin email
          if (emailSettings.send_completion_admin !== false && adminEmail) {
            await supabase.from("email_queue").upsert({
              invitation_id: inv.id,
              organisation_id: inv.organisation_id,
              email_type: "completion_admin",
              recipient_email: adminEmail,
              recipient_name: `${orgName} Team`,
              scheduled_at: inv.completed_at || new Date().toISOString(),
              idempotency_key: `${inv.id}:completion_admin`,
              extra_data: { ...extraData, candidate_name: inv.candidate_name },
            }, { onConflict: "idempotency_key", ignoreDuplicates: true });
          }

          // Insert completion_student email
          if (emailSettings.send_completion_student === true) {
            await supabase.from("email_queue").upsert({
              invitation_id: inv.id,
              organisation_id: inv.organisation_id,
              email_type: "completion_student",
              recipient_email: inv.candidate_email,
              recipient_name: inv.candidate_name,
              scheduled_at: inv.completed_at || new Date().toISOString(),
              idempotency_key: `${inv.id}:completion_student`,
              extra_data: extraData,
            }, { onConflict: "idempotency_key", ignoreDuplicates: true });
          }
        }
      }
    }

    // --- Step 2: Suppress pending reminders for completed/cancelled invitations ---
    await supabase
      .from("email_queue")
      .update({ status: "suppressed" })
      .in("email_type", ["reminder_1", "reminder_2", "reminder_3"])
      .eq("status", "pending")
      .in(
        "invitation_id",
        (await supabase
          .from("assessment_invitations")
          .select("id")
          .in("status", ["completed"])).data?.map((r: any) => r.id) || [],
      );

    // --- Step 3: Load due queue items ---
    let queueQuery = supabase
      .from("email_queue")
      .select("*, assessment_invitations!inner(id, organisation_id, status, unique_token, lln_token, digital_token, qualification_id)")
      .in("status", ["pending", "failed"])
      .lte("scheduled_at", new Date().toISOString())
      .lt("attempts", MAX_ATTEMPTS)
      .or("next_attempt_at.is.null,next_attempt_at.lte." + new Date().toISOString())
      .order("scheduled_at", { ascending: true })
      .limit(specificQueueId ? 1 : BATCH_SIZE);

    if (callerOrganisationId) queueQuery = queueQuery.eq("organisation_id", callerOrganisationId);
    if (specificQueueId) {
      queueQuery = queueQuery.eq("id", specificQueueId);
    } else if (invitationId) {
      queueQuery = queueQuery.eq("invitation_id", invitationId);
    }

    const { data: queueItems, error: queueErr } = await queueQuery;
    if (queueErr) throw new Error(`Queue read failed: ${queueErr.message}`);

    const items = queueItems || [];
    let sent = 0;
    let failed = 0;
    let suppressed = 0;
    const results: any[] = [];

    for (const item of items) {
      const inv = item.assessment_invitations as any;
      const { orgName, emailSettings } = await brandingFor(item.organisation_id ?? inv?.organisation_id);

      // Suppress reminders if invitation is completed
      if (
        ["reminder_1", "reminder_2", "reminder_3"].includes(item.email_type) &&
        inv?.status === "completed"
      ) {
        await supabase
          .from("email_queue")
          .update({ status: "suppressed" })
          .eq("id", item.id);
        suppressed++;
        results.push({ id: item.id, type: item.email_type, outcome: "suppressed" });
        continue;
      }

      // Check per-type enabled setting
      const settingKey = `send_${item.email_type}`;
      if (emailSettings[settingKey] === false) {
        results.push({ id: item.id, type: item.email_type, outcome: "skipped_disabled" });
        continue;
      }

      // Mark as sending
      await supabase
        .from("email_queue")
        .update({ status: "sending", last_attempted_at: new Date().toISOString(), attempts: item.attempts + 1 })
        .eq("id", item.id);

      const extraData = item.extra_data || {};

      // Build portal URL if not in extra_data
      if (!extraData.portal_url && inv?.unique_token) {
        const origin = Deno.env.get("SITE_URL") || "https://app.example.com";
        extraData.portal_url = `${origin}/#/student/${inv.unique_token}`;
      }

      const { subject, html } = buildContent(
        item.email_type,
        item.recipient_name || "",
        orgName,
        extraData,
      );

      let emailStatus = "sent";
      let lastError = null;

      if (RESEND_API_KEY) {
        const res = await fetch("https://api.resend.com/emails", {
          method: "POST",
          headers: {
            Authorization: `Bearer ${RESEND_API_KEY}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            from: `${orgName} <onboarding@resend.dev>`,
            to: [item.recipient_email],
            subject,
            html,
          }),
        });

        if (!res.ok) {
          emailStatus = "failed";
          const resErr = await res.json().catch(() => ({}));
          lastError = resErr.message || resErr.name || JSON.stringify(resErr);
        }
      } else {
        // No API key — log as pending (will appear in activity as "pending")
        emailStatus = "pending";
      }

      // Log to notifications
      const { data: notif } = await supabase
        .from("notifications")
        .insert({
          invitation_id: item.invitation_id,
          type: EMAIL_TYPE_LABELS[item.email_type] || "sent",
          recipient_email: item.recipient_email,
          recipient_name: item.recipient_name,
          subject,
          body: html,
          status: emailStatus === "sent" ? "sent" : emailStatus === "pending" ? "pending" : "failed",
          email_queue_id: item.id,
        })
        .select("id")
        .maybeSingle();

      // Update queue row
      const newAttempts = item.attempts + 1;
      const nextAttemptAt = emailStatus === "failed"
        ? new Date(Date.now() + Math.pow(2, newAttempts) * 60 * 1000).toISOString()
        : null;

      await supabase
        .from("email_queue")
        .update({
          status: emailStatus === "sent" ? "sent" : emailStatus === "pending" ? "pending" : "failed",
          sent_at: emailStatus === "sent" ? new Date().toISOString() : null,
          last_error: lastError,
          notification_id: notif?.id || null,
          next_attempt_at: nextAttemptAt,
        })
        .eq("id", item.id);

      // Audit trail
      await supabase.from("audit_trail").insert({
        invitation_id: item.invitation_id,
        event_type: `email.${item.email_type}.${emailStatus}`,
        category: "candidate_management",
        severity: emailStatus === "failed" ? "warning" : "info",
        description: `${item.email_type} email ${emailStatus} — ${item.recipient_email}`,
        source: "system",
        actor: "system",
        event_data: { email_type: item.email_type, recipient: item.recipient_email, attempts: item.attempts + 1 },
        timestamp: new Date().toISOString(),
      });

      if (emailStatus === "sent") {
        sent++;
        results.push({ id: item.id, type: item.email_type, outcome: "sent", to: item.recipient_email });
      } else if (emailStatus === "pending") {
        results.push({ id: item.id, type: item.email_type, outcome: "pending_no_key" });
      } else {
        failed++;
        results.push({ id: item.id, type: item.email_type, outcome: "failed", error: lastError });
      }
    }

    return new Response(
      JSON.stringify({
        processed: items.length,
        sent,
        failed,
        suppressed,
        no_api_key: !RESEND_API_KEY,
        results,
      }),
      { headers: { ...corsHeaders, "Content-Type": "application/json" } },
    );
  } catch (err: any) {
    return new Response(
      JSON.stringify({ error: err.message || "Internal error" }),
      { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } },
    );
  }
});
