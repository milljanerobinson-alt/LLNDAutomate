import { createClient } from "jsr:@supabase/supabase-js@2";
import { getIntegrationOrganisationId, isIntegrationStaff } from "../_shared/organisation-access.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, PUT, DELETE, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization, X-Client-Info, Apikey, X-Cron-Secret",
};

const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// ── Auth ─────────────────────────────────────────────────────────────────────

async function verifyAuth(req: Request, supabase: any): Promise<boolean> {
  const authHeader = req.headers.get("Authorization") || "";
  const cronSecret = req.headers.get("X-Cron-Secret") || "";

  if (authHeader === `Bearer ${Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")}`) return true;

  if (cronSecret) {
    const { data: row } = await supabase.from("settings").select("value").eq("key", "cron_secret").maybeSingle();
    if (row?.value === cronSecret || row?.value?.toString() === cronSecret) return true;
  }

  const anonClient = createClient(
    Deno.env.get("SUPABASE_URL")!,
    Deno.env.get("SUPABASE_ANON_KEY")!,
    { global: { headers: { Authorization: authHeader } } },
  );
  const { data: { user }, error } = await anonClient.auth.getUser();
  if (error || !user) return false;
  // Issue #40: only Administration/Technical staff of the RTO that owns the
  // platform aXcelerate credentials may trigger this integration.
  return await isIntegrationStaff(authHeader, ["administration", "technical"], supabase);
}

// ── Report generation ─────────────────────────────────────────────────────────

function fmt(ts: string | null): string {
  if (!ts) return "N/A";
  return new Date(ts).toLocaleString("en-AU", {
    day: "numeric", month: "short", year: "numeric",
    hour: "2-digit", minute: "2-digit",
  });
}

function fmtDate(ts: string | null): string {
  if (!ts) return "N/A";
  return new Date(ts).toLocaleDateString("en-AU", {
    day: "numeric", month: "short", year: "numeric",
  });
}

function generateLlnReport(params: {
  invitation: any;
  qualification: any;
  acsfOutcomes: Record<string, number>;
  requirements: { domain: string; minimum_acsf_level: number }[];
  recommendation: string | null;
  reasons: string[];
  orgName: string;
}): string {
  const { invitation, qualification, acsfOutcomes, requirements, recommendation, reasons, orgName } = params;
  const D = "═".repeat(60);
  const d = "─".repeat(60);
  const qualName = qualification ? `${qualification.code} ${qualification.name}` : "N/A";
  const recLabels: Record<string, string> = {
    suitable: "SUITABLE — No additional support required",
    suitable_with_support: "SUITABLE WITH SUPPORT — Support plan recommended",
    not_yet_suitable: "NOT YET SUITABLE — Significant support required",
  };

  const domainLabels: Record<string, string> = {
    reading: "Reading",
    writing: "Writing",
    numeracy: "Numeracy",
    oral: "Oral Communication",
    oral_communication: "Oral Communication",
    learning: "Learning",
    digital: "Digital Literacy",
    language: "Language",
    literacy: "Literacy",
  };

  const lines: string[] = [
    D,
    `${orgName}`,
    "LLN ASSESSMENT REPORT",
    `Generated: ${fmt(new Date().toISOString())}`,
    D,
    "",
    "LEARNER DETAILS",
    d,
    `Name:           ${invitation.candidate_name}`,
    `Email:          ${invitation.candidate_email}`,
    `Date of Birth:  ${invitation.candidate_dob ? fmtDate(invitation.candidate_dob) : "Not recorded"}`,
    "",
    "ASSESSMENT DETAILS",
    d,
    `Qualification:  ${qualName}`,
    `Assessment:     LLN Assessment`,
    `Completed:      ${fmt(invitation.lln_completed_at || invitation.completed_at)}`,
    "",
    "ACSF OUTCOMES",
    d,
  ];

  const domainEntries = Object.entries(acsfOutcomes);
  if (domainEntries.length === 0) {
    lines.push("No ACSF outcome data recorded.");
  } else {
    for (const [domain, level] of domainEntries) {
      const label = domainLabels[domain.toLowerCase()] || domain;
      const req = requirements.find(
        (r) => r.domain.toLowerCase() === domain.toLowerCase(),
      );
      const minLevel = req?.minimum_acsf_level ?? 2;
      const meets = level >= minLevel;
      const gap = minLevel - level;
      lines.push(
        `${label.padEnd(22)} ACSF Level ${level}  (required: ${minLevel})  ${meets ? "✓ MEETS" : `✗ GAP: ${gap} level${gap > 1 ? "s" : ""}`}`,
      );
    }
  }

  lines.push(
    "",
    "RECOMMENDATION",
    d,
    recLabels[recommendation || ""] || recommendation || "N/A",
  );

  if (reasons && reasons.length > 0) {
    lines.push("", "ASSESSMENT NOTES");
    for (const r of reasons) lines.push(`• ${r}`);
  }

  lines.push(
    "",
    D,
    "This report was generated automatically by the LLND Automate.",
    "Source: LLND Automate",
    D,
  );

  return lines.join("\n");
}

function generateDigitalReport(params: {
  invitation: any;
  qualification: any;
  digitalScore: number;
  orgName: string;
}): string {
  const { invitation, qualification, digitalScore, orgName } = params;
  const D = "═".repeat(60);
  const d = "─".repeat(60);
  const qualName = qualification ? `${qualification.code} ${qualification.name}` : "N/A";
  const passed = digitalScore >= 50;

  const lines: string[] = [
    D,
    `${orgName}`,
    "DIGITAL CAPABILITY ASSESSMENT REPORT",
    `Generated: ${fmt(new Date().toISOString())}`,
    D,
    "",
    "LEARNER DETAILS",
    d,
    `Name:           ${invitation.candidate_name}`,
    `Email:          ${invitation.candidate_email}`,
    `Date of Birth:  ${invitation.candidate_dob ? fmtDate(invitation.candidate_dob) : "Not recorded"}`,
    "",
    "ASSESSMENT DETAILS",
    d,
    `Qualification:  ${qualName}`,
    `Assessment:     Digital Capability Assessment`,
    `Completed:      ${fmt(invitation.digital_completed_at || invitation.completed_at)}`,
    "",
    "RESULTS",
    d,
    `Score:          ${digitalScore}%`,
    `Pass Threshold: 50%`,
    `Outcome:        ${passed ? "✓ PASSED" : "✗ BELOW THRESHOLD"}`,
    "",
    passed
      ? "The learner has demonstrated sufficient digital capability for workplace training."
      : "The learner's digital capability is below the minimum threshold. Additional support or reassessment may be required.",
    "",
    D,
    "This report was generated automatically by the LLND Automate.",
    "Source: LLND Automate",
    D,
  ];

  return lines.join("\n");
}

// ── aXcelerate portfolio type lookup ──────────────────────────────────────────

async function resolvePortfolioTypeId(
  apiBaseUrl: string,
  apiToken: string,
  wsToken: string,
  typeName: string,
): Promise<{ typeId: string | null; categoryId: string | null }> {
  try {
    const res = await fetch(`${apiBaseUrl}/contact/portfolio/type`, {
      method: "GET",
      headers: { apitoken: apiToken, wstoken: wsToken },
    });
    if (!res.ok) return { typeId: null, categoryId: null };

    const data = await res.json().catch(() => null);
    if (!Array.isArray(data)) return { typeId: null, categoryId: null };

    // Find "LLN Report" portfolio type
    const match = data.find(
      (t: any) =>
        (t.NAME || t.name || "").toLowerCase().includes(typeName.toLowerCase()) ||
        (t.PORTFOLIOTYPENAME || t.portfolioTypeName || "").toLowerCase().includes(typeName.toLowerCase()),
    );

    if (!match) return { typeId: null, categoryId: null };

    const typeId = String(
      match.PORTFOLIOTYPEID || match.portfolioTypeID || match.ID || match.id || "",
    );

    // Look for "Other Document" category within this type
    let categoryId: string | null = null;
    const categories = match.CATEGORIES || match.categories || [];
    if (Array.isArray(categories)) {
      const catMatch = categories.find(
        (c: any) =>
          (c.NAME || c.name || "").toLowerCase().includes("other") ||
          (c.CATEGORYNAME || c.categoryName || "").toLowerCase().includes("other"),
      );
      if (catMatch) {
        categoryId = String(
          catMatch.PORTFOLIOTYPECATEGORYID || catMatch.portfolioTypeCategoryID || catMatch.ID || catMatch.id || "",
        );
      }
    }

    return { typeId: typeId || null, categoryId };
  } catch {
    return { typeId: null, categoryId: null };
  }
}

// ── Main handler ──────────────────────────────────────────────────────────────

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { status: 200, headers: corsHeaders });
  }

  const supabase = createClient(
    Deno.env.get("SUPABASE_URL")!,
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
  );

  try {
    const authed = await verifyAuth(req, supabase);
    if (!authed) {
      return new Response(JSON.stringify({ error: "Unauthorized" }), {
        status: 401, headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const body = await req.json().catch(() => ({}));
    const { invitation_id, assessment_type } = body as {
      invitation_id?: string;
      assessment_type?: "lln" | "digital";
    };

    if (!invitation_id || !UUID_REGEX.test(invitation_id)) {
      return new Response(JSON.stringify({ error: "Valid invitation_id required" }), {
        status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }
    if (!assessment_type || !["lln", "digital"].includes(assessment_type)) {
      return new Response(JSON.stringify({ error: "assessment_type must be 'lln' or 'digital'" }), {
        status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // Load invitation
    const { data: invitation } = await supabase
      .from("assessment_invitations")
      .select("*, qualification:qualifications(id, code, name, axcelerate_course_id)")
      .eq("id", invitation_id)
      .maybeSingle();

    if (!invitation) {
      return new Response(JSON.stringify({ error: "Invitation not found" }), {
        status: 404, headers: { ...corsHeaders, "Content-Type": "application/json" },
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

    const contactId: number | null = invitation.axcelerate_contact_id ?? null;
    if (!contactId) {
      return new Response(
        JSON.stringify({ error: "No aXcelerate contact ID on this invitation. Ensure the inbound sync or write-back has resolved the contact first." }),
        { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } },
      );
    }

    // Idempotency check
    const idempotencyKey = `${invitation_id}:${assessment_type}`;
    const { data: existingUpload } = await supabase
      .from("axcelerate_portfolio_uploads")
      .select("id, status")
      .eq("idempotency_key", idempotencyKey)
      .maybeSingle();

    if (existingUpload?.status === "success") {
      return new Response(
        JSON.stringify({ message: "Report already uploaded", idempotency_key: idempotencyKey }),
        { headers: { ...corsHeaders, "Content-Type": "application/json" } },
      );
    }

    // Validate assessment is complete
    if (assessment_type === "lln" && invitation.lln_status !== "completed") {
      return new Response(JSON.stringify({ error: "LLN assessment is not yet completed" }), {
        status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }
    if (assessment_type === "digital" && invitation.digital_status !== "completed") {
      return new Response(JSON.stringify({ error: "Digital assessment is not yet completed" }), {
        status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // Load aXcelerate credentials and org settings — env vars take priority, fall back to settings table
    const [cfgRes, brandRes, apiTokenRes, wsTokenRes] = await Promise.all([
      supabase.from("settings").select("value").eq("key", "axcelerate_config").maybeSingle(),
      supabase.from("settings").select("value").eq("key", "org_branding").maybeSingle(),
      supabase.from("settings").select("value").eq("key", "axcelerate_api_token").maybeSingle(),
      supabase.from("settings").select("value").eq("key", "axcelerate_ws_token").maybeSingle(),
    ]);

    const apiBaseUrl: string = cfgRes.data?.value?.api_base_url || "";
    const apiToken: string = Deno.env.get("AXCELERATE_API_TOKEN") || (typeof apiTokenRes.data?.value === "string" ? apiTokenRes.data.value : "") || "";
    const wsToken: string = Deno.env.get("AXCELERATE_WS_TOKEN") || (typeof wsTokenRes.data?.value === "string" ? wsTokenRes.data.value : "") || "";
    const orgName: string = brandRes.data?.value?.name || "LLND Automate";

    if (!apiBaseUrl || !apiToken || !wsToken) {
      return new Response(
        JSON.stringify({ error: "aXcelerate credentials not configured" }),
        { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } },
      );
    }

    // Generate report content
    let reportContent: string;
    let fileName: string;
    const today = new Date().toISOString().split("T")[0];
    const nameSafe = invitation.candidate_name.replace(/[^a-zA-Z0-9 ]/g, "").trim();

    if (assessment_type === "lln") {
      const acsfOutcomes = (invitation.lln_acsf_outcomes as Record<string, number>) || {};
      const { data: requirements } = await supabase
        .from("qualification_lln_requirements")
        .select("domain, minimum_acsf_level")
        .eq("qualification_id", invitation.qualification_id || "00000000-0000-0000-0000-000000000000");

      reportContent = generateLlnReport({
        invitation,
        qualification: invitation.qualification,
        acsfOutcomes,
        requirements: requirements || [],
        recommendation: invitation.course_recommendation,
        reasons: (invitation.recommendation_reasons as string[]) || [],
        orgName,
      });
      fileName = `LLN Report - ${nameSafe} - ${today}.txt`;
    } else {
      reportContent = generateDigitalReport({
        invitation,
        qualification: invitation.qualification,
        digitalScore: invitation.digital_score ?? 0,
        orgName,
      });
      fileName = `Digital Skills Report - ${nameSafe} - ${today}.txt`;
    }

    // Encode report as base64
    const encoder = new TextEncoder();
    const bytes = encoder.encode(reportContent);
    const base64Content = btoa(String.fromCharCode(...bytes));

    // Resolve portfolio type ID
    const portfolioTypeName = "LLN Report";
    const { typeId, categoryId } = await resolvePortfolioTypeId(
      apiBaseUrl, apiToken, wsToken, portfolioTypeName,
    );

    // Upsert portfolio upload tracking row
    const uploadTrackId = existingUpload?.id || null;
    const now = new Date().toISOString();

    if (uploadTrackId) {
      await supabase.from("axcelerate_portfolio_uploads").update({
        attempts: supabase.rpc ? 1 : 1,
        last_attempted_at: now,
        status: "pending",
      }).eq("id", uploadTrackId);
    } else {
      await supabase.from("axcelerate_portfolio_uploads").insert({
        invitation_id,
        assessment_type,
        axcelerate_contact_id: contactId,
        idempotency_key: idempotencyKey,
        status: "pending",
        file_name: fileName,
        portfolio_type_id: typeId,
        attempts: 1,
        last_attempted_at: now,
      });
    }

    // Upload to aXcelerate Portfolio
    const uploadBody = new URLSearchParams({
      contactID: String(contactId),
      fileName,
      fileData: base64Content,
    });
    if (typeId) uploadBody.set("portfolioTypeID", typeId);
    if (categoryId) uploadBody.set("portfolioTypeCategoryID", categoryId);

    let uploadSuccess = false;
    let uploadError: string | null = null;
    let uploadResponse: any = null;

    try {
      const uploadRes = await fetch(`${apiBaseUrl}/contact/portfolio/`, {
        method: "POST",
        headers: {
          apitoken: apiToken,
          wstoken: wsToken,
          "Content-Type": "application/x-www-form-urlencoded",
        },
        body: uploadBody,
      });
      uploadResponse = await uploadRes.json().catch(() => ({}));
      uploadSuccess = uploadRes.ok;
      if (!uploadRes.ok) uploadError = `HTTP ${uploadRes.status}`;
    } catch (e: any) {
      uploadError = e.message;
    }

    // Update tracking row
    await supabase.from("axcelerate_portfolio_uploads")
      .update({
        status: uploadSuccess ? "success" : "failed",
        error: uploadError,
        completed_at: uploadSuccess ? now : null,
      })
      .eq("idempotency_key", idempotencyKey);

    // Log to axcelerate_sync_log
    await supabase.from("axcelerate_sync_log").insert({
      invitation_id,
      event_type: "portfolio_upload",
      sync_type: "portfolio_upload",
      request_payload: {
        contactID: contactId,
        fileName,
        assessment_type,
        portfolioTypeID: typeId,
        portfolioTypeCategoryID: categoryId,
      },
      response_payload: uploadResponse,
      status: uploadSuccess ? "success" : "failed",
      error: uploadError,
    });

    // Audit trail
    await supabase.from("audit_trail").insert({
      invitation_id,
      event_type: uploadSuccess
        ? `axcelerate.portfolio_upload.${assessment_type}.success`
        : `axcelerate.portfolio_upload.${assessment_type}.failed`,
      category: "axcelerate_integration",
      severity: uploadSuccess ? "info" : "warning",
      description: uploadSuccess
        ? `${assessment_type.toUpperCase()} report uploaded to aXcelerate Portfolio for ${invitation.candidate_name}`
        : `Failed to upload ${assessment_type.toUpperCase()} report to aXcelerate Portfolio: ${uploadError}`,
      source: "system",
      actor: "system",
      event_data: { contact_id: contactId, file_name: fileName, error: uploadError },
      timestamp: now,
    });

    if (uploadSuccess) {
      return new Response(
        JSON.stringify({ success: true, file_name: fileName, contact_id: contactId }),
        { headers: { ...corsHeaders, "Content-Type": "application/json" } },
      );
    } else {
      return new Response(
        JSON.stringify({ error: uploadError, file_name: fileName }),
        { status: 502, headers: { ...corsHeaders, "Content-Type": "application/json" } },
      );
    }
  } catch (err: any) {
    return new Response(JSON.stringify({ error: err.message || "Internal error" }), {
      status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});
