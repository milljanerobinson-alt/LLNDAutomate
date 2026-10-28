import { createClient } from "jsr:@supabase/supabase-js@2";
import { getIntegrationOrganisationId, isIntegrationStaff } from "../_shared/organisation-access.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, PUT, DELETE, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization, X-Client-Info, Apikey",
};

const MAX_ATTEMPTS = 5;
const BATCH_SIZE = 10;

type EventType =
  | "invitation_sent"
  | "quiz_sent"
  | "assessment_completed"
  | "support_plan_generated"
  | "intervention_required"
  | "lln_assessment_opened"
  | "digital_assessment_opened"
  | "lln_assessment_completed"
  | "digital_assessment_completed"
  | "report_found_no_resend"
  | "no_lln_required";

function fmt(ts: string | null): string {
  if (!ts) return "N/A";
  return new Date(ts).toLocaleString("en-AU", {
    day: "numeric", month: "short", year: "numeric",
    hour: "2-digit", minute: "2-digit",
  });
}

function buildNote(
  eventType: EventType,
  invitation: any,
  invAssessments: any[],
  supportPlan: any | null,
  extraData: Record<string, unknown>,
  portalBaseUrl: string,
): string {
  const name = invitation.candidate_name;
  const email = invitation.candidate_email;
  const qualName = invitation.qualification
    ? `${invitation.qualification.code} ${invitation.qualification.name}`
    : "N/A";
  const portalUrl = `${portalBaseUrl}/#/student/${invitation.unique_token}`;
  const D = "─".repeat(50);

  switch (eventType) {
    case "invitation_sent":
    case "quiz_sent":
      return [
        "▶ LLND Automate ASSESSMENT INVITATION SENT", D,
        `Candidate:     ${name} <${email}>`,
        `Qualification: ${qualName}`,
        `Invited:       ${fmt(invitation.sent_at)}`,
        `Due:           ${invitation.due_date ? fmt(invitation.due_date) : "Not set"}`,
        "", "The candidate has been invited to complete their LLND Automate assessment.",
        `Portal: ${portalUrl}`, D, "Source: LLND Automate",
      ].join("\n");

    case "assessment_completed": {
      const recLabels: Record<string, string> = {
        suitable: "SUITABLE — no additional support required",
        suitable_with_support: "SUITABLE WITH SUPPORT — support plan recommended",
        not_yet_suitable: "NOT YET SUITABLE — significant support required",
      };
      const rec = invitation.course_recommendation || "unknown";
      const lines = [
        "✅ LLND Automate ASSESSMENT COMPLETED", D,
        `Candidate:     ${name} <${email}>`,
        `Qualification: ${qualName}`,
        `Completed:     ${fmt(invitation.completed_at)}`,
        "", "OUTCOME",
        `Recommendation: ${recLabels[rec] || rec.replace(/_/g, " ").toUpperCase()}`,
      ];
      if (invitation.recommendation_reasons?.length) {
        lines.push(`Reasons: ${(invitation.recommendation_reasons as string[]).join("; ")}`);
      }
      if (invitation.trainer_override) {
        lines.push(`Trainer Override: ${invitation.trainer_override}`);
        if (invitation.trainer_override_reason) lines.push(`  Reason: ${invitation.trainer_override_reason}`);
      }
      lines.push("", "ASSESSMENT RESULTS");
      for (const ia of invAssessments) {
        const title = ia.assessment?.title || ia.assessment?.type || "Assessment";
        const score = ia.individual_score != null ? `${ia.individual_score}%` : "N/A";
        lines.push(`• ${title}: ${score} — ${ia.individual_passed ? "PASSED" : "BELOW THRESHOLD"}`);
        if (ia.acsf_outcomes) {
          for (const [d, l] of Object.entries(ia.acsf_outcomes)) {
            lines.push(`  ${d.replace(/_/g, " ")}: ACSF Level ${l}`);
          }
        }
      }
      lines.push("", `Portal: ${portalUrl}`, D, "Source: LLND Automate");
      return lines.join("\n");
    }

    case "support_plan_generated": {
      const content = supportPlan?.content as Record<string, any> | null;
      const strategies: string[] = content?.strategies || content?.support_strategies || [];
      const summary: string = content?.summary || content?.overview || "";
      const lines = [
        "📋 LLND Automate SUPPORT PLAN GENERATED", D,
        `Candidate:    ${name} <${email}>`,
        `Qualification:${qualName}`,
        `Status:       ${supportPlan?.status === "approved" ? "APPROVED" : "Draft"}`,
        `Generated:    ${fmt(supportPlan?.created_at)}`,
      ];
      if (summary) lines.push("", "SUMMARY", summary);
      if (strategies.length) {
        lines.push("", "RECOMMENDED STRATEGIES");
        strategies.slice(0, 5).forEach((s: string, i: number) => lines.push(`${i + 1}. ${typeof s === "string" ? s : JSON.stringify(s)}`));
        if (strategies.length > 5) lines.push(`  ... and ${strategies.length - 5} more`);
      }
      lines.push("", `Portal: ${portalUrl}`, D, "Source: LLND Automate");
      return lines.join("\n");
    }

    case "intervention_required":
      return [
        "🚨 LLND Automate INTERVENTION FLAGGED", D,
        `Candidate:     ${name} <${email}>`,
        `Qualification: ${qualName}`,
        `Flagged:       ${fmt(new Date().toISOString())}`,
        "", "REASON", (extraData.trigger_reason as string) || "Not specified",
        "", "Please review and arrange appropriate support.",
        `Portal: ${portalUrl}`, D, "Source: LLND Automate",
      ].join("\n");

    case "lln_assessment_opened":
      return [
        "▶ LLN ASSESSMENT STARTED", D,
        `Candidate:     ${name} <${email}>`,
        `Qualification: ${qualName}`,
        `Opened:        ${fmt((extraData.opened_at as string) || new Date().toISOString())}`,
        "", "The candidate has opened and started their LLN assessment in the LLND Automate Portal.",
        `Portal: ${portalUrl}`, D, "Source: LLND Automate",
      ].join("\n");

    case "digital_assessment_opened":
      return [
        "▶ DIGITAL SKILLS ASSESSMENT STARTED", D,
        `Candidate:     ${name} <${email}>`,
        `Qualification: ${qualName}`,
        `Opened:        ${fmt((extraData.opened_at as string) || new Date().toISOString())}`,
        "", "The candidate has opened and started their Digital Skills assessment in the LLND Automate Portal.",
        `Portal: ${portalUrl}`, D, "Source: LLND Automate",
      ].join("\n");

    case "lln_assessment_completed": {
      const score = extraData.score != null ? `${extraData.score}%` : "N/A";
      const passedLabel = extraData.passed ? "PASSED" : "BELOW THRESHOLD";
      const lines = [
        "✅ LLN ASSESSMENT SUBMITTED", D,
        `Candidate:     ${name} <${email}>`,
        `Qualification: ${qualName}`,
        `Completed:     ${fmt((extraData.completed_at as string) || new Date().toISOString())}`,
        "", `Score: ${score} — ${passedLabel}`,
      ];
      const outcomes = extraData.acsf_outcomes as Record<string, number> | undefined;
      if (outcomes && Object.keys(outcomes).length > 0) {
        lines.push("", "ACSF LEVEL OUTCOMES");
        for (const [domain, level] of Object.entries(outcomes)) {
          lines.push(`  ${domain.replace(/_/g, " ")}: Level ${level}`);
        }
      }
      lines.push("", `Portal: ${portalUrl}`, D, "Source: LLND Automate");
      return lines.join("\n");
    }

    case "digital_assessment_completed": {
      const score = extraData.score != null ? `${extraData.score}%` : "N/A";
      const passedLabel = extraData.passed ? "PASSED" : "BELOW THRESHOLD";
      const lines = [
        "✅ DIGITAL SKILLS ASSESSMENT SUBMITTED", D,
        `Candidate:     ${name} <${email}>`,
        `Qualification: ${qualName}`,
        `Completed:     ${fmt((extraData.completed_at as string) || new Date().toISOString())}`,
        "", `Score: ${score} — ${passedLabel}`,
      ];
      const outcomes = extraData.acsf_outcomes as Record<string, number> | undefined;
      if (outcomes && Object.keys(outcomes).length > 0) {
        lines.push("", "DIGITAL SKILL OUTCOMES");
        for (const [domain, level] of Object.entries(outcomes)) {
          lines.push(`  ${domain.replace(/_/g, " ")}: Level ${level}`);
        }
      }
      lines.push("", `Portal: ${portalUrl}`, D, "Source: LLND Automate");
      return lines.join("\n");
    }

    case "report_found_no_resend":
      return [
        "ℹ️ EXISTING COMPLETED REPORT FOUND — NO RESEND REQUIRED", D,
        `Candidate:     ${name} <${email}>`,
        `Qualification: ${qualName}`,
        `Recorded:      ${fmt(new Date().toISOString())}`,
        "", "An existing completed LLND Automate assessment report was found for this candidate.",
        "No new assessment was required. The existing report remains valid.",
        `Portal: ${portalUrl}`, D, "Source: LLND Automate",
      ].join("\n");

    case "no_lln_required":
      return [
        "ℹ️ LLND Automate ASSESSMENT NOT REQUIRED", D,
        `Candidate:     ${name} <${email}>`,
        `Qualification: ${qualName}`,
        `Recorded:      ${fmt(new Date().toISOString())}`,
        "", "This candidate does not require an LLND Automate assessment.",
        "Reason: existing valid result or qualification exemption applies.",
        `Portal: ${portalUrl}`, D, "Source: LLND Automate",
      ].join("\n");

    default:
      return `LLND Automate Event: ${eventType}\nCandidate: ${name}\n${fmt(new Date().toISOString())}`;
  }
}

async function processJob(
  supabase: any,
  job: any,
  axConfig: { apiBaseUrl: string; apiToken: string; wsToken: string; portalBaseUrl: string },
): Promise<{ success: boolean; contactId?: number; noteBody?: string; error?: string }> {
  const { apiBaseUrl, apiToken, wsToken, portalBaseUrl } = axConfig;
  const headers = {
    apitoken: apiToken,
    wstoken: wsToken,
    "Content-Type": "application/x-www-form-urlencoded",
  };

  const logCall = async (
    syncType: string,
    req: Record<string, unknown>,
    res: unknown,
    status: string,
    err?: string,
  ) => {
    await supabase.from("axcelerate_sync_log").insert({
      invitation_id: job.invitation_id,
      writeback_queue_id: job.id,
      event_type: job.event_type,
      sync_type: syncType,
      request_payload: req,
      response_payload: res,
      status,
      error: err ?? null,
    });
  };

  const invitation = job.assessment_invitations;
  if (!invitation) return { success: false, error: "Invitation not found in job" };

  // Resolve contact — reuse stored contact_id if already resolved
  let contactId: number | null = job.contact_id ?? invitation.axcelerate_contact_id ?? null;

  if (!contactId) {
    try {
      const sr = await fetch(`${apiBaseUrl}/contacts/search`, {
        method: "POST", headers,
        body: new URLSearchParams({ email: invitation.candidate_email }),
      });
      const sd = await sr.json().catch(() => ({}));
      await logCall("contact_search", { email: invitation.candidate_email }, sd, sr.ok ? "success" : "failed");
      if (sr.ok && (sd.CONTACTID || sd.contactID)) contactId = sd.CONTACTID || sd.contactID;
    } catch (e: any) {
      await logCall("contact_search", { email: invitation.candidate_email }, null, "failed", e.message);
    }
  }

  if (!contactId) {
    const [givenName, ...rest] = invitation.candidate_name.trim().split(" ");
    const surname = rest.join(" ") || "Unknown";
    try {
      const cr = await fetch(`${apiBaseUrl}/contact/`, {
        method: "POST", headers,
        body: new URLSearchParams({ givenName, surname, email: invitation.candidate_email }),
      });
      const cd = await cr.json().catch(() => ({}));
      await logCall("contact_create", { givenName, surname, email: invitation.candidate_email }, cd, cr.ok ? "success" : "failed");
      if (!cr.ok) return { success: false, error: `Contact create failed: HTTP ${cr.status}` };
      contactId = cd.CONTACTID || cd.contactID || null;
    } catch (e: any) {
      return { success: false, error: `Contact create exception: ${e.message}` };
    }
    if (contactId) {
      await supabase.from("assessment_invitations")
        .update({ axcelerate_contact_id: contactId }).eq("id", job.invitation_id);
    }
  }

  if (!contactId) return { success: false, error: "Could not resolve aXcelerate contact ID" };

  // Enroll in course for invitation/completion events — but never for a
  // learner the aXcelerate inbound sync found already enrolled (their
  // invitation is linked to that enrolment, or the job says so). Enrolling
  // them in "the first available" course instance would duplicate their
  // enrolment and progress it without any validity check.
  const alreadyEnrolledInAxcelerate = !!invitation.enrolment_id || job.extra_data?.skip_enrolment === true;
  if (alreadyEnrolledInAxcelerate && ["invitation_sent", "quiz_sent", "assessment_completed"].includes(job.event_type)) {
    await logCall("enrol", { skipped: true, reason: "learner already enrolled in aXcelerate (inbound sync)" }, null, "success");
  }
  if (!alreadyEnrolledInAxcelerate && ["invitation_sent", "quiz_sent", "assessment_completed"].includes(job.event_type)) {
    const courseId = invitation.qualification?.axcelerate_course_id;
    if (courseId) {
      try {
        const ir = await fetch(`${apiBaseUrl}/course/instance/search`, {
          method: "POST", headers,
          body: new URLSearchParams({ courseID: String(courseId) }),
        });
        const id_ = await ir.json().catch(() => ([]));
        await logCall("course_instance_search", { courseID: courseId }, id_, ir.ok ? "success" : "failed");
        if (ir.ok && Array.isArray(id_) && id_.length > 0) {
          const instanceId = id_[0].instanceID || id_[0].INSTANCEID;
          const er = await fetch(`${apiBaseUrl}/course/enrol`, {
            method: "POST", headers,
            body: new URLSearchParams({ contactID: String(contactId), instanceID: String(instanceId) }),
          });
          const ed = await er.json().catch(() => ({}));
          await logCall("enrol", { contactID: contactId, instanceID: instanceId }, ed, er.ok ? "success" : "failed");
        }
      } catch (_) { /* enrollment is non-fatal */ }
    }
  }

  // Load supporting data
  const { data: invAssessments } = await supabase
    .from("invitation_assessments")
    .select("*, assessment:assessments(id, title, type)")
    .eq("invitation_id", job.invitation_id);

  const { data: supportPlan } = await supabase
    .from("support_plans")
    .select("*")
    .eq("invitation_id", job.invitation_id)
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();

  // Build and write the contact note
  const noteText = buildNote(
    job.event_type as EventType,
    invitation,
    invAssessments || [],
    supportPlan,
    job.extra_data || {},
    portalBaseUrl,
  );

  try {
    const nr = await fetch(`${apiBaseUrl}/contact/note/`, {
      method: "POST", headers,
      body: new URLSearchParams({ contactID: String(contactId), note: noteText }),
    });
    const nd = await nr.json().catch(() => ({}));
    await logCall("note", { contactID: contactId, event_type: job.event_type }, nd, nr.ok ? "success" : "failed");
    if (!nr.ok) return { success: false, contactId, noteBody: noteText, error: `Note write failed: HTTP ${nr.status}` };
  } catch (e: any) {
    return { success: false, contactId, noteBody: noteText, error: `Note exception: ${e.message}` };
  }

  // Student lifecycle updates for opened events
  if (["lln_assessment_opened", "digital_assessment_opened"].includes(job.event_type)) {
    const studentId = invitation.student_id ?? null;
    const toStatus = job.event_type === "lln_assessment_opened" ? "lln_opened" : "digital_opened";
    if (studentId) {
      await supabase.from("students")
        .update({ current_status: toStatus }).eq("id", studentId);
      await supabase.from("student_lifecycle_events").insert({
        student_id: studentId, invitation_id: job.invitation_id,
        event_type: job.event_type, from_status: null, to_status: toStatus,
        actor: "system",
        note: `${job.event_type === "lln_assessment_opened" ? "LLN" : "Digital"} assessment opened — aXcelerate note written`,
        event_data: { contact_id: contactId },
      });
    }
  }

  // Student lifecycle updates for completion events
  if (["lln_assessment_completed", "digital_assessment_completed"].includes(job.event_type)) {
    const studentId = invitation.student_id ?? null;
    const toStatus = job.event_type === "lln_assessment_completed" ? "lln_completed" : "digital_completed";
    if (studentId) {
      await supabase.from("students")
        .update({ current_status: toStatus }).eq("id", studentId);
      await supabase.from("student_lifecycle_events").insert({
        student_id: studentId, invitation_id: job.invitation_id,
        event_type: job.event_type, from_status: null, to_status: toStatus,
        actor: "system",
        note: `${job.event_type === "lln_assessment_completed" ? "LLN" : "Digital"} assessment completed — aXcelerate note written`,
        event_data: { contact_id: contactId, score: job.extra_data?.score, passed: job.extra_data?.passed },
      });
    }
  }

  // Outcome record for overall assessment_completed
  if (job.event_type === "assessment_completed") {
    const rec = invitation.course_recommendation || "unknown";
    const outcomeText = [
      "OUTCOME RECORD",
      `Date: ${fmt(invitation.completed_at)}`,
      `Result: ${rec.replace(/_/g, " ").toUpperCase()}`,
      `Intervention Required: ${rec === "not_yet_suitable" ? "YES" : "NO"}`,
    ].join("\n");
    try {
      const or_ = await fetch(`${apiBaseUrl}/contact/note/`, {
        method: "POST", headers,
        body: new URLSearchParams({ contactID: String(contactId), note: outcomeText }),
      });
      const od = await or_.json().catch(() => ({}));
      await logCall("outcome", { contactID: contactId }, od, or_.ok ? "success" : "failed");
    } catch (_) { /* outcome note failure is non-fatal */ }
  }

  return { success: true, contactId, noteBody: noteText };
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { status: 200, headers: corsHeaders });
  }

  try {
    const authHeader = req.headers.get("Authorization") || "";
    const cronSecret = req.headers.get("X-Cron-Secret") || "";
    const isServiceCall = authHeader === `Bearer ${Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")}`;

    let isCronCall = false;
    if (!isServiceCall && cronSecret) {
      const svcClient = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);
      const { data: row } = await svcClient.from("settings").select("value").eq("key", "cron_secret").maybeSingle();
      isCronCall = row?.value === cronSecret || row?.value?.toString() === cronSecret;
    }

    if (!isServiceCall && !isCronCall) {
      const anonClient = createClient(
        Deno.env.get("SUPABASE_URL")!,
        Deno.env.get("SUPABASE_ANON_KEY")!,
        { global: { headers: { Authorization: authHeader } } },
      );
      const { data: { user }, error } = await anonClient.auth.getUser();
      if (error || !user) {
        return new Response(JSON.stringify({ error: "Unauthorized" }), {
          status: 401, headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }
      // Issue #40: Administration/Technical staff of the integration RTO only.
      if (!(await isIntegrationStaff(authHeader, ["administration", "technical"]))) {
        return new Response(JSON.stringify({ error: "Unauthorized" }), {
          status: 401, headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }
    }

    const body = req.method === "POST" ? await req.json().catch(() => ({})) : {};
    const specificJobId: string | null = body.job_id ?? null;
    const filterInvitationId: string | null = body.invitation_id ?? null;

    const supabase = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
    );

    // Load aXcelerate config
    const [{ data: settingsRow }, { data: apiTokenRow }, { data: wsTokenRow }] = await Promise.all([
      supabase.from("settings").select("value").eq("key", "axcelerate_config").maybeSingle(),
      supabase.from("settings").select("value").eq("key", "axcelerate_api_token").maybeSingle(),
      supabase.from("settings").select("value").eq("key", "axcelerate_ws_token").maybeSingle(),
    ]);
    const apiBaseUrl: string = settingsRow?.value?.api_base_url || "";
    const apiToken: string = Deno.env.get("AXCELERATE_API_TOKEN") || (typeof apiTokenRow?.value === "string" ? apiTokenRow.value : "") || "";
    const wsToken: string = Deno.env.get("AXCELERATE_WS_TOKEN") || (typeof wsTokenRow?.value === "string" ? wsTokenRow.value : "") || "";
    const portalBaseUrl: string = Deno.env.get("SITE_URL") || "https://app.example.com";

    if (!apiBaseUrl || !apiToken || !wsToken) {
      return new Response(
        JSON.stringify({ error: "aXcelerate credentials not configured", processed: 0 }),
        { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } },
      );
    }

    const axConfig = { apiBaseUrl, apiToken, wsToken, portalBaseUrl };

    // Issue #40: the platform credentials belong to one RTO. Never process
    // another RTO's candidates with them.
    const integrationOrganisationId = await getIntegrationOrganisationId(supabase);
    if (!integrationOrganisationId) {
      return new Response(
        JSON.stringify({ error: "aXcelerate integration owner is not recorded", processed: 0 }),
        { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } },
      );
    }

    // Auto-detect completed invitations missing an assessment_completed write-back job
    if (!specificJobId && !filterInvitationId) {
      const { data: completedInvs } = await supabase
        .from("assessment_invitations")
        .select("id")
        .eq("organisation_id", integrationOrganisationId)
        .eq("status", "completed")
        .not("completed_at", "is", null);

      if (completedInvs && completedInvs.length > 0) {
        for (const inv of completedInvs) {
          await supabase.from("axcelerate_writeback_queue").upsert(
            {
              invitation_id: inv.id,
              event_type: "assessment_completed",
              status: "pending",
              idempotency_key: `${inv.id}:assessment_completed`,
              extra_data: {},
            },
            { onConflict: "idempotency_key", ignoreDuplicates: true },
          );
        }
      }
    }

    // Recover stuck "processing" jobs older than 10 minutes
    await supabase
      .from("axcelerate_writeback_queue")
      .update({ status: "pending" })
      .eq("organisation_id", integrationOrganisationId)
      .eq("status", "processing")
      .lt("last_attempted_at", new Date(Date.now() - 10 * 60 * 1000).toISOString());

    // Load pending/failed jobs that are due for processing
    let jobQuery = supabase
      .from("axcelerate_writeback_queue")
      .select(`
        *,
        assessment_invitations!inner(
          id, candidate_name, candidate_email, unique_token,
          sent_at, completed_at, due_date, course_recommendation,
          recommendation_reasons, trainer_override, trainer_override_reason,
          axcelerate_contact_id, student_id, enrolment_id,
          qualification:qualifications(id, code, name, axcelerate_course_id)
        )
      `)
      .eq("organisation_id", integrationOrganisationId)
      .in("status", ["pending", "failed"])
      .lt("attempts", MAX_ATTEMPTS)
      .or("next_attempt_at.is.null,next_attempt_at.lte." + new Date().toISOString())
      .order("created_at", { ascending: true })
      .limit(specificJobId ? 1 : BATCH_SIZE);

    if (specificJobId) jobQuery = jobQuery.eq("id", specificJobId);
    else if (filterInvitationId) jobQuery = jobQuery.eq("invitation_id", filterInvitationId);

    const { data: jobs, error: jobErr } = await jobQuery;
    if (jobErr) throw new Error(`Queue read failed: ${jobErr.message}`);

    const items = jobs || [];
    let succeeded = 0;
    let failed = 0;
    const results: any[] = [];

    for (const job of items) {
      await supabase.from("axcelerate_writeback_queue")
        .update({ status: "processing", last_attempted_at: new Date().toISOString(), attempts: job.attempts + 1 })
        .eq("id", job.id);

      const result = await processJob(supabase, job, axConfig);

      const newAttempts = job.attempts + 1;
      const backoffMs = Math.pow(2, newAttempts) * 60 * 1000; // 2, 4, 8, 16, 32 min
      const nextAttemptAt = result.success ? null : new Date(Date.now() + backoffMs).toISOString();

      await supabase.from("axcelerate_writeback_queue")
        .update({
          status: result.success ? "success" : "failed",
          last_error: result.error ?? null,
          completed_at: result.success ? new Date().toISOString() : null,
          next_attempt_at: result.success ? null : nextAttemptAt,
          contact_id: result.contactId ?? job.contact_id ?? null,
          note_body: result.noteBody ?? null,
        })
        .eq("id", job.id);

      await supabase.from("audit_trail").insert({
        invitation_id: job.invitation_id,
        event_type: `axcelerate.writeback.${job.event_type}.${result.success ? "success" : "failed"}`,
        category: "axcelerate_integration",
        severity: result.success ? "info" : "warning",
        description: `aXcelerate write-back (${job.event_type}) ${result.success ? "succeeded" : `failed: ${result.error}`}`,
        source: "system", actor: "system",
        event_data: { event_type: job.event_type, contact_id: result.contactId, error: result.error },
        timestamp: new Date().toISOString(),
      });

      if (result.success) {
        succeeded++;
        results.push({ id: job.id, event_type: job.event_type, outcome: "success", contactId: result.contactId });
      } else {
        failed++;
        results.push({ id: job.id, event_type: job.event_type, outcome: "failed", error: result.error });
      }
    }

    return new Response(
      JSON.stringify({ processed: items.length, succeeded, failed, results }),
      { headers: { ...corsHeaders, "Content-Type": "application/json" } },
    );
  } catch (err: any) {
    return new Response(
      JSON.stringify({ error: err.message || "Internal error" }),
      { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } },
    );
  }
});
