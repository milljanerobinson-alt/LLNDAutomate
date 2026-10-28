import { createClient } from "jsr:@supabase/supabase-js@2";
import { getIntegrationOrganisationId, isIntegrationStaff } from "../_shared/organisation-access.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, PUT, DELETE, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization, X-Client-Info, Apikey",
};

const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MAX_ATTEMPTS = 3;

type EventType =
  | "invitation_sent"
  | "assessment_completed"
  | "support_plan_generated"
  | "intervention_required";

async function verifyAuth(req: Request): Promise<{ userId: string } | null> {
  const authHeader = req.headers.get("Authorization");
  if (!authHeader?.startsWith("Bearer ")) return null;
  const token = authHeader.replace("Bearer ", "");
  const supabase = createClient(
    Deno.env.get("SUPABASE_URL")!,
    Deno.env.get("SUPABASE_ANON_KEY")!,
    { global: { headers: { Authorization: authHeader } } },
  );
  const { data: { user }, error } = await supabase.auth.getUser(token);
  if (error || !user) return null;
  // Issue #40: Administration/Technical staff of the integration RTO only.
  if (!(await isIntegrationStaff(authHeader, ["administration", "technical"]))) return null;
  return { userId: user.id };
}

function fmt(ts: string | null): string {
  if (!ts) return "N/A";
  return new Date(ts).toLocaleString("en-AU", {
    day: "numeric", month: "short", year: "numeric",
    hour: "2-digit", minute: "2-digit",
  });
}

function buildNoteForEvent(
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

  const divider = "─".repeat(50);

  switch (eventType) {
    case "invitation_sent": {
      return [
        "▶ LLND Automate ASSESSMENT INVITATION SENT",
        divider,
        `Candidate:      ${name} <${email}>`,
        `Qualification:  ${qualName}`,
        `Invited:        ${fmt(invitation.sent_at)}`,
        `Due Date:       ${invitation.due_date ? fmt(invitation.due_date) : "Not set"}`,
        "",
        "The candidate has been invited to complete their LLND Automate assessment.",
        `Portal Link: ${portalUrl}`,
        divider,
        "Source: LLND Automate",
      ].join("\n");
    }

    case "assessment_completed": {
      const rec = invitation.course_recommendation || "N/A";
      const recLabel: Record<string, string> = {
        suitable: "SUITABLE — No additional support required",
        suitable_with_support: "SUITABLE WITH SUPPORT — Support plan recommended",
        not_yet_suitable: "NOT YET SUITABLE — Significant support required",
      };
      const lines = [
        "✅ LLND Automate ASSESSMENT COMPLETED",
        divider,
        `Candidate:      ${name} <${email}>`,
        `Qualification:  ${qualName}`,
        `Completed:      ${fmt(invitation.completed_at)}`,
        "",
        "OUTCOME",
        `Recommendation: ${recLabel[rec] || rec}`,
      ];
      if (invitation.recommendation_reasons?.length > 0) {
        lines.push(`Reasons:        ${(invitation.recommendation_reasons as string[]).join("; ")}`);
      }
      if (invitation.trainer_override) {
        lines.push(`Trainer Override: ${invitation.trainer_override}`);
        if (invitation.trainer_override_reason) {
          lines.push(`Override Reason: ${invitation.trainer_override_reason}`);
        }
      }
      lines.push("", "ASSESSMENT RESULTS");
      for (const ia of invAssessments) {
        const title = ia.assessment?.title || ia.assessment?.type || "Assessment";
        const score = ia.individual_score != null ? `${ia.individual_score}%` : "N/A";
        const passed = ia.individual_passed ? "PASSED" : "BELOW THRESHOLD";
        lines.push(`• ${title}: ${score} — ${passed}`);
        if (ia.acsf_outcomes && Object.keys(ia.acsf_outcomes).length > 0) {
          for (const [domain, level] of Object.entries(ia.acsf_outcomes)) {
            lines.push(`  ${domain.replace(/_/g, " ")}: ACSF Level ${level}`);
          }
        }
      }
      lines.push("", `Portal: ${portalUrl}`);
      lines.push(divider, "Source: LLND Automate");
      return lines.join("\n");
    }

    case "support_plan_generated": {
      const planContent = supportPlan?.content as Record<string, any> | null;
      const strategies: string[] = planContent?.strategies || planContent?.support_strategies || [];
      const summary: string = planContent?.summary || planContent?.overview || "";
      const lines = [
        "📋 LLND Automate SUPPORT PLAN GENERATED",
        divider,
        `Candidate:      ${name} <${email}>`,
        `Qualification:  ${qualName}`,
        `Plan Status:    ${supportPlan?.status === "approved" ? "APPROVED" : "Draft"}`,
        `Generated:      ${fmt(supportPlan?.created_at)}`,
      ];
      if (summary) {
        lines.push("", "SUMMARY", summary);
      }
      if (strategies.length > 0) {
        lines.push("", "RECOMMENDED STRATEGIES");
        strategies.slice(0, 5).forEach((s: string, i: number) => {
          lines.push(`${i + 1}. ${typeof s === "string" ? s : JSON.stringify(s)}`);
        });
        if (strategies.length > 5) {
          lines.push(`  ... and ${strategies.length - 5} more (see LLND Automate portal)`);
        }
      }
      const rec = invitation.course_recommendation || "N/A";
      lines.push("", `Readiness: ${rec.replace(/_/g, " ").toUpperCase()}`);
      lines.push("", `Full plan: ${portalUrl}`);
      lines.push(divider, "Source: LLND Automate");
      return lines.join("\n");
    }

    case "intervention_required": {
      const triggerReason: string = (extraData.trigger_reason as string) || "Not specified";
      const lines = [
        "🚨 LLND Automate INTERVENTION FLAGGED",
        divider,
        `Candidate:      ${name} <${email}>`,
        `Qualification:  ${qualName}`,
        `Flagged:        ${fmt(new Date().toISOString())}`,
        "",
        "REASON FOR INTERVENTION",
        triggerReason,
        "",
        "The candidate has been flagged for intervention based on their LLND Automate assessment results.",
        "Please review their support needs and contact them to arrange appropriate assistance.",
        "",
        `Results: ${portalUrl}`,
        divider,
        "Source: LLND Automate",
      ];
      return lines.join("\n");
    }

    default:
      return `LLND Automate Event: ${eventType}\nCandidate: ${name}\nTimestamp: ${fmt(new Date().toISOString())}`;
  }
}

async function performWriteback(
  supabase: any,
  queueId: string,
  invitation: any,
  eventType: EventType,
  extraData: Record<string, unknown>,
  axConfig: { apiBaseUrl: string; apiToken: string; wsToken: string; portalBaseUrl: string },
): Promise<{ success: boolean; contactId?: number; error?: string }> {
  const { apiBaseUrl, apiToken, wsToken, portalBaseUrl } = axConfig;

  const headers = {
    apitoken: apiToken,
    wstoken: wsToken,
    "Content-Type": "application/x-www-form-urlencoded",
  };

  const logSync = async (
    sync_type: string,
    requestPayload: Record<string, unknown>,
    responsePayload: unknown,
    status: string,
    error?: string,
  ) => {
    await supabase.from("axcelerate_sync_log").insert({
      invitation_id: invitation.id,
      writeback_queue_id: queueId,
      event_type: eventType,
      sync_type,
      request_payload: requestPayload,
      response_payload: responsePayload,
      status,
      error: error ?? null,
    });
  };

  // 1. Resolve contact ID (search → create)
  let contactId: number | null = invitation.axcelerate_contact_id ?? null;

  if (!contactId) {
    const searchBody = new URLSearchParams({ email: invitation.candidate_email });
    try {
      const searchRes = await fetch(`${apiBaseUrl}/contacts/search`, {
        method: "POST", headers, body: searchBody,
      });
      const searchData = await searchRes.json().catch(() => ({}));
      await logSync("contact_search", { email: invitation.candidate_email }, searchData, searchRes.ok ? "success" : "failed");

      if (searchRes.ok && (searchData.CONTACTID || searchData.contactID)) {
        contactId = searchData.CONTACTID || searchData.contactID;
      }
    } catch (e: any) {
      await logSync("contact_search", { email: invitation.candidate_email }, null, "failed", e.message);
    }

    if (!contactId) {
      const [givenName, ...surnameParts] = invitation.candidate_name.trim().split(" ");
      const surname = surnameParts.join(" ") || "Unknown";
      const createBody = new URLSearchParams({ givenName, surname, email: invitation.candidate_email });
      try {
        const createRes = await fetch(`${apiBaseUrl}/contact/`, {
          method: "POST", headers, body: createBody,
        });
        const createData = await createRes.json().catch(() => ({}));
        await logSync("contact_create", { givenName, surname, email: invitation.candidate_email }, createData, createRes.ok ? "success" : "failed");

        if (!createRes.ok) {
          return { success: false, error: `Failed to create contact: HTTP ${createRes.status}` };
        }
        contactId = createData.CONTACTID || createData.contactID || null;
      } catch (e: any) {
        return { success: false, error: `Contact create exception: ${e.message}` };
      }
    }

    if (contactId) {
      await supabase
        .from("assessment_invitations")
        .update({ axcelerate_contact_id: contactId })
        .eq("id", invitation.id);
    }
  }

  if (!contactId) {
    return { success: false, error: "Could not resolve aXcelerate contact ID" };
  }

  // 2. Enroll in course (invitation_sent + assessment_completed only)
  if (["invitation_sent", "assessment_completed"].includes(eventType)) {
    const courseId = invitation.qualification?.axcelerate_course_id;
    if (courseId) {
      try {
        const instanceRes = await fetch(`${apiBaseUrl}/course/instance/search`, {
          method: "POST",
          headers,
          body: new URLSearchParams({ courseID: String(courseId) }),
        });
        const instanceData = await instanceRes.json().catch(() => ([]));
        await logSync("course_instance_search", { courseID: courseId }, instanceData, instanceRes.ok ? "success" : "failed");

        if (instanceRes.ok && Array.isArray(instanceData) && instanceData.length > 0) {
          const instanceId = instanceData[0].instanceID || instanceData[0].INSTANCEID;
          const enrolRes = await fetch(`${apiBaseUrl}/course/enrol`, {
            method: "POST",
            headers,
            body: new URLSearchParams({ contactID: String(contactId), instanceID: String(instanceId) }),
          });
          const enrolData = await enrolRes.json().catch(() => ({}));
          await logSync("enrol", { contactID: contactId, instanceID: instanceId }, enrolData, enrolRes.ok ? "success" : "failed");
        }
      } catch (_) {
        // Enrollment failure is non-fatal — continue to write the note
      }
    }
  }

  // 3. Load supporting data for the note
  const { data: invAssessments } = await supabase
    .from("invitation_assessments")
    .select("*, assessment:assessments(id, title, type)")
    .eq("invitation_id", invitation.id);

  const { data: supportPlan } = await supabase
    .from("support_plans")
    .select("*")
    .eq("invitation_id", invitation.id)
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();

  // 4. Write contact note
  const noteText = buildNoteForEvent(
    eventType,
    invitation,
    invAssessments || [],
    supportPlan,
    extraData,
    portalBaseUrl,
  );

  try {
    const noteRes = await fetch(`${apiBaseUrl}/contact/note/`, {
      method: "POST",
      headers,
      body: new URLSearchParams({ contactID: String(contactId), note: noteText }),
    });
    const noteData = await noteRes.json().catch(() => ({}));
    await logSync("note", { contactID: contactId, event_type: eventType }, noteData, noteRes.ok ? "success" : "failed");

    if (!noteRes.ok) {
      return { success: false, contactId, error: `Note write failed: HTTP ${noteRes.status}` };
    }
  } catch (e: any) {
    return { success: false, contactId, error: `Note exception: ${e.message}` };
  }

  // 5. Write outcome record for assessment_completed
  if (eventType === "assessment_completed") {
    const rec = invitation.course_recommendation || "unknown";
    const outcomeNote = [
      "OUTCOME RECORD",
      `Date: ${fmt(invitation.completed_at)}`,
      `Result: ${rec.replace(/_/g, " ").toUpperCase()}`,
      `Intervention Required: ${rec === "not_yet_suitable" ? "YES" : "NO"}`,
    ].join("\n");

    try {
      const outcomeRes = await fetch(`${apiBaseUrl}/contact/note/`, {
        method: "POST",
        headers,
        body: new URLSearchParams({ contactID: String(contactId), note: outcomeNote }),
      });
      const outcomeData = await outcomeRes.json().catch(() => ({}));
      await logSync("outcome", { contactID: contactId }, outcomeData, outcomeRes.ok ? "success" : "failed");
    } catch (_) {
      // Outcome note failure is non-fatal
    }
  }

  return { success: true, contactId };
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { status: 200, headers: corsHeaders });
  }

  try {
    const authHeader = req.headers.get("Authorization") || "";
    const isServiceCall = authHeader === `Bearer ${Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")}`;

    if (!isServiceCall) {
      const auth = await verifyAuth(req);
      if (!auth) {
        return new Response(JSON.stringify({ error: "Unauthorized" }), {
          status: 401,
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }
    }

    const body = await req.json().catch(() => ({}));
    const { invitation_id, event_type, queue_id } = body as {
      invitation_id?: string;
      event_type?: EventType;
      queue_id?: string;
    };

    if (!invitation_id || !UUID_REGEX.test(invitation_id)) {
      return new Response(JSON.stringify({ error: "Valid invitation_id required" }), {
        status: 400,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const resolvedEventType: EventType = event_type || "assessment_completed";
    const validTypes: EventType[] = ["invitation_sent", "assessment_completed", "support_plan_generated", "intervention_required"];
    if (!validTypes.includes(resolvedEventType)) {
      return new Response(JSON.stringify({ error: `Invalid event_type. Must be one of: ${validTypes.join(", ")}` }), {
        status: 400,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const supabase = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
    );

    // Load invitation with qualification
    const { data: invitation } = await supabase
      .from("assessment_invitations")
      .select("*, qualification:qualifications(id, code, name, axcelerate_course_id)")
      .eq("id", invitation_id)
      .maybeSingle();

    if (!invitation) {
      return new Response(JSON.stringify({ error: "Invitation not found" }), {
        status: 404,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // Issue #40: the platform aXcelerate credentials belong to one RTO. Refuse
    // to write another RTO's candidate into that RTO's aXcelerate account.
    const integrationOrganisationId = await getIntegrationOrganisationId(supabase);
    if (!integrationOrganisationId || invitation.organisation_id !== integrationOrganisationId) {
      return new Response(JSON.stringify({ error: "aXcelerate integration is not configured for this candidate's organisation" }), {
        status: 409, headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // Load aXcelerate credentials — env vars take priority, fall back to settings table
    const [{ data: settingsRow }, { data: apiTokenRow }, { data: wsTokenRow }] = await Promise.all([
      supabase.from("settings").select("value").eq("key", "axcelerate_config").maybeSingle(),
      supabase.from("settings").select("value").eq("key", "axcelerate_api_token").maybeSingle(),
      supabase.from("settings").select("value").eq("key", "axcelerate_ws_token").maybeSingle(),
    ]);
    const apiBaseUrl: string = settingsRow?.value?.api_base_url || "";
    const apiToken: string = Deno.env.get("AXCELERATE_API_TOKEN") || (typeof apiTokenRow?.value === "string" ? apiTokenRow.value : "") || "";
    const wsToken: string = Deno.env.get("AXCELERATE_WS_TOKEN") || (typeof wsTokenRow?.value === "string" ? wsTokenRow.value : "") || "";

    if (!apiBaseUrl || !apiToken || !wsToken) {
      return new Response(
        JSON.stringify({ error: "aXcelerate credentials not configured. Please configure them in Settings → aXcelerate." }),
        { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } },
      );
    }

    const portalBaseUrl = Deno.env.get("SITE_URL") || "https://app.example.com";

    // Find or create queue row for this job
    let queueRowId: string;
    const idempotencyKey = `${invitation_id}:${resolvedEventType}`;

    if (queue_id) {
      queueRowId = queue_id;
      await supabase.from("axcelerate_writeback_queue")
        .update({ status: "processing", last_attempted_at: new Date().toISOString(), attempts: supabase.rpc("coalesce", [0]) })
        .eq("id", queue_id);
    } else {
      // Upsert queue row
      const { data: existingRow } = await supabase
        .from("axcelerate_writeback_queue")
        .select("id, attempts")
        .eq("idempotency_key", idempotencyKey)
        .maybeSingle();

      if (existingRow) {
        queueRowId = existingRow.id;
        await supabase.from("axcelerate_writeback_queue")
          .update({ status: "processing", last_attempted_at: new Date().toISOString(), attempts: existingRow.attempts + 1 })
          .eq("id", queueRowId);
      } else {
        const { data: newRow } = await supabase.from("axcelerate_writeback_queue")
          .insert({
            invitation_id,
            event_type: resolvedEventType,
            status: "processing",
            idempotency_key: idempotencyKey,
            attempts: 1,
            last_attempted_at: new Date().toISOString(),
            extra_data: body.extra_data || {},
          })
          .select("id")
          .maybeSingle();
        queueRowId = newRow?.id;
      }
    }

    const result = await performWriteback(
      supabase,
      queueRowId,
      invitation,
      resolvedEventType,
      body.extra_data || {},
      { apiBaseUrl, apiToken, wsToken, portalBaseUrl },
    );

    // Update queue row with result
    await supabase.from("axcelerate_writeback_queue")
      .update({
        status: result.success ? "success" : "failed",
        last_error: result.error ?? null,
        completed_at: result.success ? new Date().toISOString() : null,
      })
      .eq("id", queueRowId);

    // Audit trail
    await supabase.from("audit_trail").insert({
      invitation_id,
      event_type: `axcelerate.writeback.${resolvedEventType}.${result.success ? "success" : "failed"}`,
      category: "axcelerate_integration",
      severity: result.success ? "info" : "warning",
      description: `aXcelerate write-back (${resolvedEventType}) ${result.success ? "succeeded" : `failed: ${result.error}`}`,
      source: "system",
      actor: "system",
      event_data: { event_type: resolvedEventType, contact_id: result.contactId, error: result.error },
      timestamp: new Date().toISOString(),
    });

    if (result.success) {
      return new Response(
        JSON.stringify({ message: "Synced to aXcelerate", contactId: result.contactId, event_type: resolvedEventType }),
        { headers: { ...corsHeaders, "Content-Type": "application/json" } },
      );
    } else {
      return new Response(
        JSON.stringify({ error: result.error, event_type: resolvedEventType }),
        { status: 502, headers: { ...corsHeaders, "Content-Type": "application/json" } },
      );
    }
  } catch (err: any) {
    return new Response(
      JSON.stringify({ error: err.message || "Internal error" }),
      { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } },
    );
  }
});
