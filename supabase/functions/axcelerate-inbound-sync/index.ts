import { createClient } from "jsr:@supabase/supabase-js@2";
import { getIntegrationOrganisationId, isIntegrationStaff } from "../_shared/organisation-access.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, PUT, DELETE, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization, X-Client-Info, Apikey, X-Cron-Secret",
};

const DEFAULT_MIN_ACSF = 2;
const DEFAULT_DIGITAL_PASS = 50;

// ── Auth ─────────────────────────────────────────────────────────────────────

// Issue #40: every candidate, invitation and qualification this sync reads or
// writes belongs to the RTO that owns the platform aXcelerate credentials.
// Set once per request, before any processing.
let INTEGRATION_ORGANISATION_ID = "";

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

// ── aXcelerate helpers ────────────────────────────────────────────────────────

function axHeaders(apiToken: string, wsToken: string) {
  return {
    apitoken: apiToken,
    wstoken: wsToken,
    "Content-Type": "application/x-www-form-urlencoded",
  };
}

function fmt(ts: string | null, timezone = "Australia/Sydney"): string {
  if (!ts) return "N/A";
  return new Date(ts).toLocaleString("en-AU", {
    day: "numeric", month: "long", year: "numeric",
    hour: "2-digit", minute: "2-digit",
    hour12: true,
    timeZone: timezone,
    timeZoneName: "short",
  });
}

// Parse custom field value — treats "Yes" (case-insensitive) as true
function isYes(value: unknown): boolean {
  return typeof value === "string" && value.trim().toLowerCase() === "yes";
}

// Extract a named custom field from the aXcelerate contact response.
// Matches on VARIABLE (machine name) only — never on the display field name.
function extractCustomField(contact: any, variableName: string): string | null {
  // Try every known key casing for the custom fields array
  const candidates: any[] = [
    contact.CUSTOMFIELDS,
    contact.customFields,
    contact.customfields,
    contact.custom_fields,
  ].filter(Array.isArray);

  for (const arr of candidates) {
    const entry = arr.find(
      (f: any) => (f.VARIABLE ?? f.variable ?? "").toLowerCase() === variableName.toLowerCase(),
    );
    if (entry != null) return entry.VALUE ?? entry.value ?? null;
  }

  // Flat key: CUSTOMFIELD_<VARIABLE_NAME> (uppercase)
  const flatKey = `CUSTOMFIELD_${variableName.toUpperCase()}`;
  if (flatKey in contact) {
    const raw = contact[flatKey];
    // aXcelerate sometimes wraps the value in a single-element array
    const val = Array.isArray(raw) ? raw[0] : raw;
    return val == null ? null : String(val);
  }

  return null;
}

// Return a snapshot of custom-field data useful for debugging mis-detections.
function customFieldsDebug(contact: any): unknown {
  const arr =
    contact.CUSTOMFIELDS ??
    contact.customFields ??
    contact.customfields ??
    contact.custom_fields ??
    null;
  if (!Array.isArray(arr)) {
    const keys = Object.keys(contact).filter((k) =>
      k.toLowerCase().includes("custom"),
    );
    const flatValues: Record<string, unknown> = {};
    for (const k of keys) flatValues[k] = contact[k];
    return { no_array_found: true, keys_with_custom: keys, flat_values: flatValues };
  }
  return arr.map((f: any) => ({
    VARIABLE: f.VARIABLE ?? f.variable ?? null,
    FIELDNAME: f.FIELDNAME ?? f.fieldName ?? null,
    VALUE: f.VALUE ?? f.value ?? null,
  }));
}

// ── Enrolment helpers ─────────────────────────────────────────────────────────

function normaliseEnrolmentList(raw: unknown): any[] {
  if (Array.isArray(raw)) return raw;
  if (raw && typeof raw === "object") {
    for (const key of ["DATA", "data", "enrolments", "ENROLMENTS", "results", "RESULTS", "items", "Items"]) {
      if (Array.isArray((raw as any)[key])) return (raw as any)[key];
    }
  }
  return [];
}

// Fetches active enrolments for a contact from aXcelerate.
// Returns checked=false if all API endpoints fail — caller lets the contact
// through to avoid blocking syncs when aXcelerate is temporarily unreachable.
// Flatten enrolment records from aXcelerate, which may return either a flat
// array of enrolment objects OR a qualification-wrapper array where each item
// has nested CLASSES / COURSES / CLASS arrays containing the actual enrolments.
function flattenEnrolments(raw: unknown): any[] {
  const top = normaliseEnrolmentList(raw);
  const flat: any[] = [];

  for (const item of top) {
    // Detect qualification-wrapper shape by looking for nested class/course arrays
    const nested: any[] | undefined =
      item.CLASSES ?? item.classes ??
      item.COURSES ?? item.courses ??
      item.CLASS ?? item.class ??
      item.ENROLMENTS ?? item.enrolments;

    if (Array.isArray(nested) && nested.length > 0) {
      // Inherit COURSEID from wrapper if class items don't have one
      const inheritId =
        item.COURSEID ?? item.courseId ?? item.COURSE_ID ??
        item.COURSETEMPLATEID ?? item.courseTemplateId ?? null;
      for (const cls of nested) {
        flat.push(inheritId && !(cls.COURSEID ?? cls.courseId) ? { ...cls, COURSEID: inheritId } : cls);
      }
    } else {
      flat.push(item);
    }
  }

  return flat;
}

async function fetchContactEnrolments(
  base: string,
  apiToken: string,
  wsToken: string,
  contactId: number,
): Promise<{ hasActiveEnrolment: boolean; courseId: number | null; qualCode: string | null; checked: boolean }> {
  const headers = { apitoken: apiToken, wstoken: wsToken, Accept: "application/json" };
  const stripped = base.replace(/\/$/, "");
  const urls = [
    // Correct aXcelerate endpoint: /contact/enrolments/:contactID
    `${stripped}/contact/enrolments/${contactId}`,
    // Legacy / alternate patterns kept as fallback
    `${stripped}/contact/${contactId}/course/`,
    `${stripped}/contact/${contactId}/courses/`,
    `${stripped}/contact/${contactId}/enrolment/`,
    `${stripped}/contact/${contactId}/enrolments/`,
    `${stripped}/enrolment/?contactID=${contactId}`,
    `${stripped}/enrolments/?contactID=${contactId}`,
    `${stripped}/course/?contactID=${contactId}`,
  ];

  for (const url of urls) {
    try {
      const res = await fetch(url, { method: "GET", headers, signal: AbortSignal.timeout(15_000) });
      if (!res.ok) continue;
      const body = await res.json().catch(() => null);
      if (!body) continue;

      const list = flattenEnrolments(body);
      if (list.length === 0) return { hasActiveEnrolment: true, courseId: null, qualCode: null, checked: false };

      const inactiveStatuses = ["cancelled", "canceled", "withdrawn", "deleted", "inactive"];
      const active = list.filter((e: any) => {
        const status = String(
          e.STATUS ?? e.status ?? e.enrolmentStatus ?? e.ENROLMENTSTATUS ?? ""
        ).trim().toLowerCase();
        return !inactiveStatuses.includes(status);
      });

      if (active.length === 0) return { hasActiveEnrolment: false, courseId: null, qualCode: null, checked: true };

      // Prefer TYPE "p" (accredited program/qualification) rows for course ID extraction.
      // The /contact/enrolments/ endpoint returns mixed rows (programs, units, workshops).
      const programs = active.filter((e: any) =>
        String(e.TYPE ?? e.type ?? "").toLowerCase() === "p"
      );
      const preferred = programs.length > 0 ? programs : active;
      const first = preferred[0];

      // The /contact/enrolments/ response uses ID as the course template ID.
      // Legacy endpoints may use COURSEID / COURSETEMPLATEID.
      const rawId =
        first.ID ?? first.id ??
        first.COURSEID ?? first.courseId ?? first.course_id ?? first.COURSE_ID ??
        first.COURSETEMPLATEID ?? first.courseTemplateId ?? null;
      const courseId =
        rawId != null && !isNaN(Number(rawId)) && Number(rawId) > 0 ? Number(rawId) : null;

      // CODE on the enrolment row is often empty for programs; return it anyway
      // in case it's populated — caller can use it for a code-based fallback lookup.
      const qualCode = String(first.CODE ?? first.code ?? "").trim() || null;

      return { hasActiveEnrolment: true, courseId, qualCode, checked: true };
    } catch { continue; }
  }

  // All endpoints failed — can't verify enrolment, allow sync to proceed
  return { hasActiveEnrolment: true, courseId: null, qualCode: null, checked: false };
}

// ── ACSF sufficiency check ───────────────────────────────────────────────────

function isLlnSufficient(
  llnAcsfOutcomes: Record<string, number> | null,
  requirements: { domain: string; minimum_acsf_level: number }[],
): boolean {
  if (!llnAcsfOutcomes || Object.keys(llnAcsfOutcomes).length === 0) return false;
  if (requirements.length === 0) {
    // No specific requirements: pass if any outcomes recorded
    return Object.values(llnAcsfOutcomes).some((v) => v >= DEFAULT_MIN_ACSF);
  }
  for (const req of requirements) {
    const achieved = llnAcsfOutcomes[req.domain.toLowerCase()] ?? 0;
    if (achieved < req.minimum_acsf_level) return false;
  }
  return true;
}

function isDigitalSufficient(digitalScore: number | null): boolean {
  return digitalScore !== null && digitalScore >= DEFAULT_DIGITAL_PASS;
}

// ── Student record helpers ────────────────────────────────────────────────────

async function findOrCreateStudent(
  supabase: any,
  params: {
    firstName: string;
    lastName: string;
    dob: string | null;
    email: string | null;
    axcelerateContactId: number;
  },
): Promise<string> {
  const { firstName, lastName, dob, email, axcelerateContactId } = params;

  // Primary: match by axcelerate contact ID
  const { data: byContactId } = await supabase
    .from("students")
    .select("id").eq("organisation_id", INTEGRATION_ORGANISATION_ID)
    .eq("axcelerate_contact_id", axcelerateContactId)
    .maybeSingle();
  if (byContactId) return byContactId.id;

  // Secondary: DOB + name match
  if (dob) {
    const { data: byDob } = await supabase
      .from("students")
      .select("id").eq("organisation_id", INTEGRATION_ORGANISATION_ID)
      .eq("date_of_birth", dob)
      .ilike("first_name", firstName)
      .ilike("last_name", lastName)
      .maybeSingle();
    if (byDob) {
      await supabase.from("students").update({ axcelerate_contact_id: axcelerateContactId }).eq("organisation_id", INTEGRATION_ORGANISATION_ID).eq("id", byDob.id);
      return byDob.id;
    }
  }

  // Tertiary: email
  if (email) {
    const { data: byEmail } = await supabase
      .from("students")
      .select("id").eq("organisation_id", INTEGRATION_ORGANISATION_ID)
      .ilike("email", email)
      .maybeSingle();
    if (byEmail) {
      await supabase.from("students").update({ axcelerate_contact_id: axcelerateContactId }).eq("organisation_id", INTEGRATION_ORGANISATION_ID).eq("id", byEmail.id);
      return byEmail.id;
    }
  }

  // Create new
  const { data: created, error } = await supabase
    .from("students")
    .insert({
      organisation_id: INTEGRATION_ORGANISATION_ID,
      axcelerate_contact_id: axcelerateContactId,
      first_name: firstName,
      last_name: lastName,
      date_of_birth: dob,
      email: email || null,
      current_status: "invitation_sent",
    })
    .select("id")
    .single();

  if (error) throw new Error(`Failed to create student: ${error.message}`);
  return created.id;
}

async function findOrCreateEnrolment(
  supabase: any,
  studentId: string,
  qualificationId: string | null,
  axcelerateCourseId: number | null,
): Promise<string> {
  if (qualificationId) {
    const { data: existing } = await supabase
      .from("enrolments")
      .select("id").eq("organisation_id", INTEGRATION_ORGANISATION_ID)
      .eq("student_id", studentId)
      .eq("qualification_id", qualificationId)
      .maybeSingle();
    if (existing) return existing.id;
  }

  const { data: created, error } = await supabase
    .from("enrolments")
    .insert({
      organisation_id: INTEGRATION_ORGANISATION_ID,
      student_id: studentId,
      qualification_id: qualificationId,
      axcelerate_course_id: axcelerateCourseId,
      enrolment_date: new Date().toISOString().split("T")[0],
    })
    .select("id")
    .single();

  if (error) throw new Error(`Failed to create enrolment: ${error.message}`);
  return created.id;
}

async function logLifecycleEvent(
  supabase: any,
  params: {
    studentId: string;
    invitationId: string | null;
    eventType: string;
    fromStatus: string | null;
    toStatus: string | null;
    note?: string;
    eventData?: Record<string, unknown>;
  },
): Promise<void> {
  await supabase.from("student_lifecycle_events").insert({
    student_id: params.studentId,
    invitation_id: params.invitationId,
    event_type: params.eventType,
    from_status: params.fromStatus,
    to_status: params.toStatus,
    actor: "system",
    note: params.note ?? null,
    event_data: params.eventData ?? {},
  });
}



async function findExistingLearner(
  supabase: any,
  firstName: string,
  lastName: string,
  dob: string | null,
  email: string | null,
): Promise<any | null> {
  const fullName = `${firstName} ${lastName}`.trim();

  // Primary match: DOB + first + last name
  if (dob) {
    const { data } = await supabase
      .from("assessment_invitations")
      .select("*").eq("organisation_id", INTEGRATION_ORGANISATION_ID)
      .eq("candidate_dob", dob)
      .ilike("candidate_name", `%${firstName}%`)
      .ilike("candidate_name", `%${lastName}%`)
      .order("created_at", { ascending: false })
      .limit(1);
    if (data && data.length > 0) return data[0];
  }

  // Fallback: exact name match
  if (fullName.length > 2) {
    const { data } = await supabase
      .from("assessment_invitations")
      .select("*").eq("organisation_id", INTEGRATION_ORGANISATION_ID)
      .ilike("candidate_name", fullName)
      .order("created_at", { ascending: false })
      .limit(1);
    if (data && data.length > 0) return data[0];
  }

  // Last fallback: email match
  if (email) {
    const { data } = await supabase
      .from("assessment_invitations")
      .select("*").eq("organisation_id", INTEGRATION_ORGANISATION_ID)
      .ilike("candidate_email", email)
      .order("created_at", { ascending: false })
      .limit(1);
    if (data && data.length > 0) return data[0];
  }

  return null;
}

// ── Find best existing completed invitation for ACSF check ──────────────────

async function findBestCompletedInvitation(
  supabase: any,
  firstName: string,
  lastName: string,
  dob: string | null,
  email: string | null,
  assessmentType: "lln" | "digital",
): Promise<any | null> {
  // Build a base query for completed invitations for this learner
  let query = supabase
    .from("assessment_invitations")
    .select("*").eq("organisation_id", INTEGRATION_ORGANISATION_ID)
    .eq("status", "completed")
    .order("completed_at", { ascending: false })
    .limit(10);

  if (dob) {
    query = query.eq("candidate_dob", dob);
  } else if (email) {
    query = query.ilike("candidate_email", email);
  } else {
    query = query.ilike("candidate_name", `%${firstName}%`).ilike("candidate_name", `%${lastName}%`);
  }

  const { data } = await query;
  if (!data || data.length === 0) return null;

  // Filter for the specific assessment type
  return data.find((inv: any) => {
    if (assessmentType === "lln") {
      return inv.lln_status === "completed" && inv.lln_token;
    } else {
      return inv.digital_status === "completed" && inv.digital_token;
    }
  }) ?? null;
}

// ── Create invitation ────────────────────────────────────────────────────────

async function createInvitation(
  supabase: any,
  params: {
    candidateName: string;
    candidateEmail: string;
    candidateDob: string | null;
    qualificationId: string | null;
    axcelerateContactId: number;
    assessmentType: "lln" | "digital" | "both";
    rtoName: string;
    dueDate: string | null;
    studentId: string | null;
    enrolmentId: string | null;
  },
): Promise<{ invId: string; llnToken: string | null; digitalToken: string | null }> {
  const needsLln = params.assessmentType === "lln" || params.assessmentType === "both";
  const needsDigital = params.assessmentType === "digital" || params.assessmentType === "both";

  const uniqueToken = crypto.randomUUID();
  const llnToken = needsLln ? crypto.randomUUID() : null;
  const digitalToken = needsDigital ? crypto.randomUUID() : null;

  const { data: inv, error } = await supabase
    .from("assessment_invitations")
    .insert({
      organisation_id: INTEGRATION_ORGANISATION_ID,
      candidate_name: params.candidateName,
      candidate_email: params.candidateEmail,
      candidate_dob: params.candidateDob,
      qualification_id: params.qualificationId,
      unique_token: uniqueToken,
      lln_token: llnToken,
      lln_status: needsLln ? "pending" : null,
      digital_token: digitalToken,
      digital_status: needsDigital ? "pending" : null,
      status: "sent",
      sent_at: new Date().toISOString(),
      progress_percent: 0,
      axcelerate_contact_id: params.axcelerateContactId,
      rto_name: params.rtoName || null,
      due_date: params.dueDate,
      student_id: params.studentId,
      enrolment_id: params.enrolmentId,
    })
    .select("id")
    .single();

  if (error) throw new Error(`Failed to create invitation: ${error.message}`);

  // Link to assessment records
  const { data: assessments } = await supabase
    .from("assessments")
    .select("id, type")
    .eq("status", "active")
    .in("type", [needsLln && needsDigital ? "lln" : needsLln ? "lln" : "digital"]);

  const activeAssessments = await supabase
    .from("assessments")
    .select("id, type")
    .eq("status", "active");

  const toLink = (activeAssessments.data || []).filter((a: any) => {
    if (params.assessmentType === "both") return true;
    return a.type === params.assessmentType;
  });

  if (toLink.length > 0) {
    await supabase.from("invitation_assessments").insert(
      toLink.map((a: any) => ({
        invitation_id: inv.id,
        assessment_id: a.id,
        individual_status: "pending",
        acsf_outcomes: {},
      })),
    );
  }

  return { invId: inv.id, llnToken, digitalToken };
}

// ── Queue invitation email + reminders ───────────────────────────────────────

async function queueInvitationEmails(
  supabase: any,
  params: {
    invId: string;
    candidateEmail: string;
    candidateName: string;
    portalUrl: string;
    llnUrl: string | null;
    digitalUrl: string | null;
    qualName: string;
    dueDate: string | null;
    orgName: string;
  },
): Promise<void> {
  const { data: settingsRow } = await supabase
    .from("settings")
    .select("value")
    .eq("key", "email_settings")
    .maybeSingle();
  const emailSettings: Record<string, unknown> = settingsRow?.value ?? {};

  const now = Date.now();
  const r1Hours = typeof emailSettings.reminder_1_hours === "number" ? emailSettings.reminder_1_hours : 48;
  const r2Days = typeof emailSettings.reminder_2_days === "number" ? emailSettings.reminder_2_days : 5;
  const r3Days = typeof emailSettings.reminder_3_days === "number" ? emailSettings.reminder_3_days : 7;

  const extraData = {
    portal_url: params.portalUrl,
    lln_url: params.llnUrl,
    digital_url: params.digitalUrl,
    qualification_name: params.qualName,
    due_date: params.dueDate,
    org_name: params.orgName,
  };

  const rows = [
    {
      invitation_id: params.invId,
      email_type: "invitation",
      recipient_email: params.candidateEmail,
      recipient_name: params.candidateName,
      scheduled_at: new Date().toISOString(),
      status: "pending",
      idempotency_key: `${params.invId}:invitation`,
      extra_data: extraData,
    },
    {
      invitation_id: params.invId,
      email_type: "reminder_1",
      recipient_email: params.candidateEmail,
      recipient_name: params.candidateName,
      scheduled_at: new Date(now + r1Hours * 3_600_000).toISOString(),
      status: "pending",
      idempotency_key: `${params.invId}:reminder_1`,
      extra_data: extraData,
    },
    {
      invitation_id: params.invId,
      email_type: "reminder_2",
      recipient_email: params.candidateEmail,
      recipient_name: params.candidateName,
      scheduled_at: new Date(now + r2Days * 86_400_000).toISOString(),
      status: "pending",
      idempotency_key: `${params.invId}:reminder_2`,
      extra_data: extraData,
    },
    {
      invitation_id: params.invId,
      email_type: "reminder_3",
      recipient_email: params.candidateEmail,
      recipient_name: params.candidateName,
      scheduled_at: new Date(now + r3Days * 86_400_000).toISOString(),
      status: "pending",
      idempotency_key: `${params.invId}:reminder_3`,
      extra_data: extraData,
    },
  ];

  await supabase.from("email_queue").upsert(rows, {
    onConflict: "idempotency_key",
    ignoreDuplicates: true,
  });
}

// ── Build contact note ────────────────────────────────────────────────────────

function buildInboundNote(params: {
  contactName: string;
  contactEmail: string;
  qualName: string;
  llnAction: "sent" | "active" | "existing" | "none";
  digitalAction: "sent" | "active" | "existing" | "none";
  llnInsufficientAcsf?: boolean;
  digitalInsufficientAcsf?: boolean;
  timezone?: string;
}): string {
  const lines: string[] = ["LLND Automate PORTAL ASSESSMENT SYNC"];
  lines.push(`Contact: ${params.contactName}`);
  lines.push(`Qualification: ${params.qualName}`);
  lines.push(`Date: ${fmt(new Date().toISOString(), params.timezone)}`);

  const outcomeLines: string[] = [];

  if (params.llnAction === "sent") {
    outcomeLines.push("- LLN Quiz: Invitation generated and sent.");
    if (params.llnInsufficientAcsf) {
      outcomeLines.push("  (Previous assessment found but did not meet qualification ACSF requirements.)");
    }
  } else if (params.llnAction === "active") {
    outcomeLines.push("- LLN Quiz: Student already has an outstanding LLN assessment invitation in the LLND Automate Portal. No additional invitation has been issued.");
  } else if (params.llnAction === "existing") {
    outcomeLines.push("- LLN Quiz: Student already exists in the LLND Automate Portal with a current valid LLN assessment suitable for this qualification. No additional LLN assessment has been issued.");
  }

  if (params.digitalAction === "sent") {
    outcomeLines.push("- Digital Skills Quiz: Invitation generated and sent.");
    if (params.digitalInsufficientAcsf) {
      outcomeLines.push("  (Previous assessment found but did not meet qualification pass threshold.)");
    }
  } else if (params.digitalAction === "active") {
    outcomeLines.push("- Digital Skills Quiz: Student already has an outstanding Digital Skills assessment invitation in the LLND Automate Portal. No additional invitation has been issued.");
  } else if (params.digitalAction === "existing") {
    outcomeLines.push("- Digital Skills Quiz: Student already exists in the LLND Automate Portal with a current valid Digital Skills assessment suitable for this qualification. No additional Digital Skills assessment has been issued.");
  }

  if (outcomeLines.length > 0) {
    lines.push("OUTCOME");
    lines.push(...outcomeLines);
  } else {
    lines.push("OUTCOME");
    lines.push("- No action required — no assessment fields marked as required.");
  }

  return lines.join("\n");
}

// ── Main handler ─────────────────────────────────────────────────────────────

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

    const integrationOrganisationId = await getIntegrationOrganisationId(supabase);
    if (!integrationOrganisationId) {
      return new Response(JSON.stringify({ error: "aXcelerate integration owner is not recorded" }), {
        status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }
    INTEGRATION_ORGANISATION_ID = integrationOrganisationId;

    const body = await req.json().catch(() => ({}));
    const contactId: number | null = body.contact_id ?? null;
    const axcelerateCourseId: number | null = body.axcelerate_course_id ?? null;

    if (!contactId || typeof contactId !== "number") {
      return new Response(JSON.stringify({ error: "contact_id (number) is required" }), {
        status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // Load aXcelerate credentials from settings table
    const [{ data: cfgRow }, { data: apiTokenRow }, { data: wsTokenRow }] = await Promise.all([
      supabase.from("settings").select("value").eq("key", "axcelerate_config").maybeSingle(),
      supabase.from("settings").select("value").eq("key", "axcelerate_api_token").maybeSingle(),
      supabase.from("settings").select("value").eq("key", "axcelerate_ws_token").maybeSingle(),
    ]);
    const apiBaseUrl: string = cfgRow?.value?.api_base_url || "";
    const apiToken: string = (typeof apiTokenRow?.value === "string" ? apiTokenRow.value : "") || "";
    const wsToken: string = (typeof wsTokenRow?.value === "string" ? wsTokenRow.value : "") || "";
    const accountTimezone: string = cfgRow?.value?.timezone || "Australia/Sydney";

    if (!apiBaseUrl || !apiToken || !wsToken) {
      return new Response(
        JSON.stringify({ error: "aXcelerate credentials not configured. Please configure them in Settings." }),
        { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } },
      );
    }

    const axHdr = axHeaders(apiToken, wsToken);

    // Load org settings
    const { data: brandRow } = await supabase
      .from("settings").select("value").eq("key", "org_branding").maybeSingle();
    const orgName: string = brandRow?.value?.name || "LLND Automate";
    const portalBase: string =
      Deno.env.get("SITE_URL") ||
      brandRow?.value?.app_url ||
      "https://app.example.com";
    let contact: any;
    let contactRawKeys: string[] = [];
    try {
      const res = await fetch(`${apiBaseUrl}/contact/${contactId}`, {
        method: "GET",
        headers: { apitoken: apiToken, wstoken: wsToken },
      });
      if (!res.ok) {
        throw new Error(`aXcelerate returned HTTP ${res.status}`);
      }
      contact = await res.json();
      contactRawKeys = Object.keys(contact);
    } catch (e: any) {
      // Stamp the sync log with a 15-minute backoff so the bulk sync doesn't
      // retry this contact in a tight loop when the aXcelerate API is down.
      await supabase.from("axcelerate_inbound_sync_log").upsert(
        {
          axcelerate_contact_id: contactId,
          assessment_type: "error",
          idempotency_key: `${contactId}:fetch_error`,
          status: "error",
          contact_name: null,
          contact_email: null,
          processed_at: new Date().toISOString(),
          created_at: new Date().toISOString(),
        },
        { onConflict: "idempotency_key" },
      ).catch(() => {});
      return new Response(JSON.stringify({ error: `Failed to fetch contact: ${e.message}` }), {
        status: 502, headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // Normalize contact fields (aXcelerate may use upper or lower case)
    const firstName: string = contact.GIVENNAME || contact.givenName || contact.firstName || "";
    const lastName: string = contact.SURNAME || contact.surname || contact.lastName || "";
    const email: string =
      contact.EMAIL ||
      contact.email ||
      contact.EMAILADDRESS ||
      contact.emailAddress ||
      contact.emailaddress ||
      contact.EMAILWORKADDRESS ||
      contact.emailWorkAddress ||
      contact.EMAIL1 ||
      contact.email1 ||
      "";
    const dobRaw: string | null = contact.DOB || contact.dob || contact.DATE_OF_BIRTH || null;

    // Normalize DOB to YYYY-MM-DD
    let dob: string | null = null;
    if (dobRaw) {
      const d = new Date(dobRaw);
      if (!isNaN(d.getTime())) {
        dob = d.toISOString().split("T")[0];
      }
    }

    const fullName = `${firstName} ${lastName}`.trim() || `Contact ${contactId}`;

    // ── 2. Check custom fields ──────────────────────────────────────────────
    const llnRequired = isYes(extractCustomField(contact, "lln_quiz_required"));
    const digitalRequired = isYes(extractCustomField(contact, "digital_quiz_required"));

    if (!llnRequired && !digitalRequired) {
      // Stamp the sync log so the bulk sync can skip this contact for ~5 minutes
      // before re-checking. Uses idempotency_key="${contactId}:none" so it never
      // conflicts with keys for actual assessment work on this contact.
      await supabase.from("axcelerate_inbound_sync_log").upsert(
        {
          axcelerate_contact_id: contactId,
          assessment_type: "none",
          idempotency_key: `${contactId}:none`,
          status: "skipped",
          contact_name: fullName || null,
          contact_email: email || null,
          processed_at: new Date().toISOString(),
          created_at: new Date().toISOString(),
        },
        { onConflict: "idempotency_key" },
      );
      await supabase.from("audit_trail").insert({
        event_type: "axcelerate.inbound_sync.skipped",
        category: "axcelerate_integration",
        severity: "info",
        description: `Inbound sync for contact ${contactId} (${fullName}): no assessment fields set`,
        source: "system",
        actor: "system",
        event_data: { contact_id: contactId, lln_required: false, digital_required: false },
        timestamp: new Date().toISOString(),
      });
      return new Response(JSON.stringify({
        message: "No action required",
        contact_id: contactId,
        lln_action: "none",
        digital_action: "none",
        custom_fields_debug: customFieldsDebug(contact),
      }), {
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // ── 2b. Verify contact has an active aXcelerate enrolment ──────────────
    // Contacts with quiz flags set but no active enrolment are skipped.
    // If the enrolment API is unreachable (checked=false), we let the contact
    // through so a temporary outage doesn't silently block all syncs.
    let resolvedCourseId: number | null = axcelerateCourseId;
    let contactQualCode: string | null = null;
    if (!axcelerateCourseId) {
      const enrolmentResult = await fetchContactEnrolments(apiBaseUrl, apiToken, wsToken, contactId);

      if (enrolmentResult.checked && !enrolmentResult.hasActiveEnrolment) {
        await supabase.from("axcelerate_inbound_sync_log").upsert(
          {
            axcelerate_contact_id: contactId,
            assessment_type: "none",
            idempotency_key: `${contactId}:no_enrolment`,
            status: "skipped",
            contact_name: fullName || null,
            contact_email: email || null,
            processed_at: new Date().toISOString(),
            created_at: new Date().toISOString(),
          },
          { onConflict: "idempotency_key" },
        );
        return new Response(JSON.stringify({
          message: "No active enrolment in aXcelerate — skipped",
          contact_id: contactId,
          lln_action: "none",
          digital_action: "none",
        }), {
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }

      resolvedCourseId = enrolmentResult.courseId;
      // Carry forward the qual code from the enrolment response for fallback lookup
      if (!contactQualCode && enrolmentResult.qualCode) contactQualCode = enrolmentResult.qualCode;
    }

    // ── 2c. If no courseId yet, try fetching contact qualifications directly ──
    // The enrolment endpoints sometimes return empty even when a qualification
    // exists (e.g. tentative enrolments). Fall back to the contact's
    // qualification endpoint to get the qualification code so we can look it up.
    if (!resolvedCourseId) {
      // First try extracting from the contact detail response itself
      const qualArr: any[] | null =
        contact.QUALIFICATIONS ?? contact.qualifications ??
        contact.COURSES ?? contact.courses ?? null;
      if (Array.isArray(qualArr) && qualArr.length > 0) {
        const first = qualArr[0];
        contactQualCode =
          first.QUALIFICATIONCODE ?? first.qualificationCode ??
          first.QUALCODE ?? first.qualCode ??
          first.CODE ?? first.code ?? null;
        const rawCId = first.COURSEID ?? first.courseId ?? first.COURSE_ID ?? null;
        if (rawCId && !isNaN(Number(rawCId))) resolvedCourseId = Number(rawCId);
      }

      // If still nothing, call the dedicated qualification endpoint
      if (!contactQualCode && !resolvedCourseId) {
        const stripped = apiBaseUrl.replace(/\/$/, "");
        const qualUrls = [
          `${stripped}/contact/${contactId}/qualification/`,
          `${stripped}/contact/${contactId}/qualifications/`,
          `${stripped}/contact/${contactId}/course/`,
          `${stripped}/contact/${contactId}/courses/`,
        ];
        const axQualHdr = { apitoken: apiToken, wstoken: wsToken, Accept: "application/json" };
        for (const url of qualUrls) {
          try {
            const res = await fetch(url, { method: "GET", headers: axQualHdr, signal: AbortSignal.timeout(10_000) });
            if (!res.ok) continue;
            const body = await res.json().catch(() => null);
            if (!body) continue;
            const list = flattenEnrolments(body);
            if (list.length === 0) continue;
            const first = list[0];
            const code =
              first.QUALIFICATIONCODE ?? first.qualificationCode ??
              first.QUALCODE ?? first.qualCode ??
              first.CODE ?? first.code ?? null;
            if (code) { contactQualCode = String(code); }
            const rawCId = first.COURSEID ?? first.courseId ?? first.COURSE_ID ?? null;
            if (rawCId && !isNaN(Number(rawCId))) resolvedCourseId = Number(rawCId);
            if (contactQualCode || resolvedCourseId) break;
          } catch { continue; }
        }
      }
    }

    // ── 3. Look up qualification ────────────────────────────────────────────
    let qualificationId: string | null = null;
    let qualName = "N/A";
    let requirements: { domain: string; minimum_acsf_level: number }[] = [];

    const lookupQual = async (query: any) => {
      const { data: qual } = await query;
      if (!qual) return;
      qualificationId = qual.id;
      qualName = `${qual.code} ${qual.name}`;
      const { data: reqs } = await supabase
        .from("qualification_lln_requirements")
        .select("domain, minimum_acsf_level")
        .eq("qualification_id", qual.id);
      requirements = reqs || [];
    };

    if (resolvedCourseId) {
      await lookupQual(
        supabase.from("qualifications").select("id, code, name").eq("organisation_id", INTEGRATION_ORGANISATION_ID)
          .eq("axcelerate_course_id", resolvedCourseId).eq("active", true).maybeSingle()
      );
    }

    // Fallback: look up by qualification code if still not found
    if (!qualificationId && contactQualCode) {
      await lookupQual(
        supabase.from("qualifications").select("id, code, name").eq("organisation_id", INTEGRATION_ORGANISATION_ID)
          .ilike("code", contactQualCode).eq("active", true).maybeSingle()
      );
    }

    // Debug: if we still have no qualification, log the contact response keys
    // and a probe of the /course/ endpoint so we can diagnose the right API pattern.
    if (!qualificationId) {
      const stripped = apiBaseUrl.replace(/\/$/, "");
      // Probe the correct enrolments endpoint for diagnostics
      const probeUrl = `${stripped}/contact/enrolments/${contactId}`;
      let probeStatus = 0;
      let probeBody: unknown = null;
      try {
        const pr = await fetch(probeUrl, {
          method: "GET",
          headers: { apitoken: apiToken, wstoken: wsToken, Accept: "application/json" },
          signal: AbortSignal.timeout(8_000),
        });
        probeStatus = pr.status;
        probeBody = await pr.json().catch(() => null);
      } catch { /* ignore */ }

      await supabase.from("audit_trail").insert({
        event_type: "axcelerate.inbound_sync.qual_debug",
        category: "axcelerate_integration",
        severity: "info",
        description: `Qual lookup failed for contact ${contactId} — logging API probe`,
        source: "system",
        actor: "system",
        event_data: {
          contact_id: contactId,
          contact_top_level_keys: contactRawKeys,
          contact_qual_code_extracted: contactQualCode,
          resolved_course_id: resolvedCourseId,
          probe_url: probeUrl,
          probe_status: probeStatus,
          probe_body_sample: JSON.stringify(probeBody)?.slice(0, 500),
        },
        timestamp: new Date().toISOString(),
      });
    }


    const idempotencyKey = `${contactId}:${llnRequired ? "lln" : ""}_${digitalRequired ? "digital" : ""}:${qualificationId ?? "any"}`;
    const { data: existingLog } = await supabase
      .from("axcelerate_inbound_sync_log")
      .select("*")
      .eq("idempotency_key", idempotencyKey)
      .maybeSingle();

    if (existingLog && ["created", "skipped"].includes(existingLog.status)) {
      // For "created" records: verify the linked invitation still exists.
      // The FK is ON DELETE SET NULL, so if invitations were cleared, invitation_id becomes
      // null but status stays "created". Detect this and re-process rather than blocking.
      if (existingLog.status === "created") {
        let invitationGone = !existingLog.invitation_id;
        if (!invitationGone && existingLog.invitation_id) {
          const { data: existingInv } = await supabase
            .from("assessment_invitations")
            .select("id").eq("organisation_id", INTEGRATION_ORGANISATION_ID)
            .eq("id", existingLog.invitation_id)
            .maybeSingle();
          invitationGone = !existingInv;
        }

        if (invitationGone) {
          // Stale log — invitation was deleted. Clear it and fall through to re-create.
          await supabase
            .from("axcelerate_inbound_sync_log")
            .delete()
            .eq("idempotency_key", idempotencyKey);
        } else {
          // Invitation exists. If email was missing on the previous run but we now have
          // one, patch the invitation and re-queue the email.
          if (email && existingLog.invitation_id) {
            const { data: inv } = await supabase
              .from("assessment_invitations")
              .select("id, candidate_email, unique_token, lln_token, digital_token").eq("organisation_id", INTEGRATION_ORGANISATION_ID)
              .eq("id", existingLog.invitation_id)
              .maybeSingle();

            if (inv && !inv.candidate_email && email) {
              await supabase
                .from("assessment_invitations")
                .update({ candidate_email: email }).eq("organisation_id", INTEGRATION_ORGANISATION_ID)
                .eq("id", inv.id);

              await supabase
                .from("email_queue")
                .update({ recipient_email: email, status: "pending", attempts: 0, last_error: null })
                .eq("invitation_id", inv.id)
                .in("status", ["failed", "pending"]);

              await supabase
                .from("axcelerate_inbound_sync_log")
                .update({ contact_email: email })
                .eq("id", existingLog.id);

              fetch(`${Deno.env.get("SUPABASE_URL")}/functions/v1/process-email-queue`, {
                method: "POST",
                headers: {
                  "Content-Type": "application/json",
                  Authorization: `Bearer ${Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!}`,
                },
                body: JSON.stringify({ invitation_id: inv.id }),
              }).catch(() => {});

              return new Response(
                JSON.stringify({
                  message: "Email was missing — patched and re-queued",
                  invitation_id: inv.id,
                  email_patched: email,
                }),
                { headers: { ...corsHeaders, "Content-Type": "application/json" } },
              );
            }
          }

          // Retry note write if it failed previously
          if (!existingLog.note_written && existingLog.note_text) {
            try {
              const noteRes = await fetch(`${apiBaseUrl}/contact/note/`, {
                method: "POST",
                headers: axHdr,
                body: new URLSearchParams({
                  contactID: String(contactId),
                  contactNote: existingLog.note_text,
                }),
              });
              if (noteRes.ok) {
                await supabase
                  .from("axcelerate_inbound_sync_log")
                  .update({ note_written: true })
                  .eq("id", existingLog.id);
              }
              await supabase.from("axcelerate_sync_log").insert({
                invitation_id: existingLog.invitation_id,
                event_type: "inbound_sync",
                sync_type: "note_retry",
                request_payload: { contactID: contactId },
                response_payload: await noteRes.json().catch(() => ({})),
                status: noteRes.ok ? "success" : "failed",
                error: noteRes.ok ? null : `HTTP ${noteRes.status}`,
              });
            } catch (_e) { /* non-fatal */ }
          }

          return new Response(
            JSON.stringify({
              message: "Already processed",
              idempotency_key: idempotencyKey,
              status: existingLog.status,
              log_id: existingLog.id,
            }),
            { headers: { ...corsHeaders, "Content-Type": "application/json" } },
          );
        }
      } else {
        // "skipped" — no invitation to verify, just return early
        return new Response(
          JSON.stringify({
            message: "Already processed",
            idempotency_key: idempotencyKey,
            status: existingLog.status,
            log_id: existingLog.id,
          }),
          { headers: { ...corsHeaders, "Content-Type": "application/json" } },
        );
      }
    }

    // ── 5. Match existing learner ───────────────────────────────────────────
    const existingLearner = await findExistingLearner(supabase, firstName, lastName, dob, email || null);

    // Update axcelerate_contact_id on existing invitations for this learner if not set
    if (existingLearner && !existingLearner.axcelerate_contact_id) {
      await supabase
        .from("assessment_invitations")
        .update({ axcelerate_contact_id: contactId }).eq("organisation_id", INTEGRATION_ORGANISATION_ID)
        .ilike("candidate_email", existingLearner.candidate_email);
    }

    // ── 6. Determine what assessments are needed ────────────────────────────
    let llnAction: "sent" | "active" | "existing" | "none" = "none";
    let digitalAction: "sent" | "active" | "existing" | "none" = "none";
    let llnInsufficientAcsf = false;
    let digitalInsufficientAcsf = false;
    let llnInvitationId: string | null = null;
    let digitalInvitationId: string | null = null;

    // -- LLN --
    if (llnRequired) {
      // Check for an existing active (not completed) invitation for this learner + LLN
      const { data: activeInv } = await supabase
        .from("assessment_invitations")
        .select("id, status, lln_status").eq("organisation_id", INTEGRATION_ORGANISATION_ID)
        .ilike("candidate_email", email || existingLearner?.candidate_email || "__none__")
        .in("status", ["sent", "opened", "in_progress"])
        .not("lln_token", "is", null)
        .maybeSingle();

      if (activeInv) {
        // Already has an active invitation pending — not yet completed
        llnAction = "active";
        llnInvitationId = activeInv.id;
      } else {
        // Check for a completed, sufficient assessment
        const completed = await findBestCompletedInvitation(
          supabase, firstName, lastName, dob, email || null, "lln",
        );

        if (completed) {
          const outcomes = (completed.lln_acsf_outcomes as Record<string, number>) || {};
          if (isLlnSufficient(outcomes, requirements)) {
            llnAction = "existing";
            llnInvitationId = completed.id;
          } else {
            llnInsufficientAcsf = true;
          }
        }

        if (llnAction === "none") {
          llnAction = "sent";
        }
      }
    }

    // -- Digital --
    if (digitalRequired) {
      const { data: activeInv } = await supabase
        .from("assessment_invitations")
        .select("id, status, digital_status").eq("organisation_id", INTEGRATION_ORGANISATION_ID)
        .ilike("candidate_email", email || existingLearner?.candidate_email || "__none__")
        .in("status", ["sent", "opened", "in_progress"])
        .not("digital_token", "is", null)
        .maybeSingle();

      if (activeInv) {
        digitalAction = "active";
        digitalInvitationId = activeInv.id;
      } else {
        const completed = await findBestCompletedInvitation(
          supabase, firstName, lastName, dob, email || null, "digital",
        );

        if (completed) {
          if (isDigitalSufficient(completed.digital_score)) {
            digitalAction = "existing";
            digitalInvitationId = completed.id;
          } else {
            digitalInsufficientAcsf = true;
          }
        }

        if (digitalAction === "none") {
          digitalAction = "sent";
        }
      }
    }

    // ── 7. Create invitations for anything that requires a new one ──────────
    let newInvitationId: string | null = null;

    const needsNewLln = llnAction === "sent";
    const needsNewDigital = digitalAction === "sent";

    // Backfill qualification onto an existing active invitation that was created
    // without one (e.g. when the enrolment API was unavailable on the first run).
    if (qualificationId && !needsNewLln && !needsNewDigital) {
      const existingInvId = llnInvitationId ?? digitalInvitationId;
      if (existingInvId) {
        const { data: existingInv } = await supabase
          .from("assessment_invitations")
          .select("id, qualification_id").eq("organisation_id", INTEGRATION_ORGANISATION_ID)
          .eq("id", existingInvId)
          .maybeSingle();
        if (existingInv && !existingInv.qualification_id) {
          await supabase
            .from("assessment_invitations")
            .update({ qualification_id: qualificationId }).eq("organisation_id", INTEGRATION_ORGANISATION_ID)
            .eq("id", existingInvId);
        }
      }
    }

    // Find or create the student record
    let studentId: string | null = null;
    let enrolmentId: string | null = null;
    try {
      studentId = await findOrCreateStudent(supabase, {
        firstName,
        lastName,
        dob,
        email: email || null,
        axcelerateContactId: contactId,
      });
      enrolmentId = await findOrCreateEnrolment(supabase, studentId, qualificationId, resolvedCourseId);
    } catch (e: any) {
      // Non-fatal — proceed without student linkage
      console.error("Student/enrolment creation failed:", e.message);
    }

    if (needsNewLln || needsNewDigital) {
      let assessmentType: "lln" | "digital" | "both";
      if (needsNewLln && needsNewDigital) assessmentType = "both";
      else if (needsNewLln) assessmentType = "lln";
      else assessmentType = "digital";

      const { invId, llnToken, digitalToken } = await createInvitation(supabase, {
        candidateName: fullName,
        candidateEmail: email,
        candidateDob: dob,
        qualificationId,
        axcelerateContactId: contactId,
        assessmentType,
        rtoName: orgName,
        dueDate: null,
        studentId,
        enrolmentId,
      });

      newInvitationId = invId;
      if (needsNewLln) llnInvitationId = invId;
      if (needsNewDigital) digitalInvitationId = invId;

      // Update student status and log lifecycle event
      if (studentId) {
        await supabase.from("students")
          .update({ current_status: "invitation_sent", latest_invitation_id: invId }).eq("organisation_id", INTEGRATION_ORGANISATION_ID)
          .eq("id", studentId);
        await logLifecycleEvent(supabase, {
          studentId,
          invitationId: invId,
          eventType: "invitation_created",
          fromStatus: "lln_required",
          toStatus: "invitation_sent",
          note: `Invitation created via aXcelerate inbound sync for qualification ${qualName}`,
          eventData: { contact_id: contactId, assessment_type: assessmentType, qualification_id: qualificationId },
        });
      }

      // Build portal URLs
      const { data: createdInv } = await supabase
        .from("assessment_invitations")
        .select("unique_token, lln_token, digital_token").eq("organisation_id", INTEGRATION_ORGANISATION_ID)
        .eq("id", invId)
        .single();

      const portalUrl = `${portalBase}/#/student/${createdInv.unique_token}`;
      const llnUrl = createdInv.lln_token ? `${portalBase}/#/lln/${createdInv.lln_token}` : null;
      const digitalUrl = createdInv.digital_token ? `${portalBase}/#/digital/${createdInv.digital_token}` : null;

      // Queue invitation email + reminders
      await queueInvitationEmails(supabase, {
        invId,
        candidateEmail: email,
        candidateName: fullName,
        portalUrl,
        llnUrl,
        digitalUrl,
        qualName,
        dueDate: null,
        orgName,
      });

      // Queue aXcelerate write-back for invitation_sent
      await supabase.from("axcelerate_writeback_queue").upsert(
        {
          invitation_id: invId,
          event_type: "invitation_sent",
          status: "pending",
          idempotency_key: `${invId}:invitation_sent`,
          extra_data: {},
        },
        { onConflict: "idempotency_key", ignoreDuplicates: true },
      );

      // Audit — contact created
      await supabase.from("audit_trail").insert({
        invitation_id: invId,
        event_type: "contact.created",
        category: "candidate_management",
        severity: "info",
        description: `Contact created in aXcelerate and synced to the portal (Contact ${contactId})`,
        source: "system",
        actor: "system",
        event_data: { contact_id: contactId, qualification_id: qualificationId },
        timestamp: new Date().toISOString(),
      });

      // Audit — quiz(zes) sent
      const quizSentType =
        llnAction === "sent" && digitalAction === "sent" ? "lln_digital.sent"
        : llnAction === "sent" ? "lln.sent"
        : digitalAction === "sent" ? "digital.sent"
        : null;
      if (quizSentType) {
        await supabase.from("audit_trail").insert({
          invitation_id: invId,
          event_type: quizSentType,
          category: "candidate_management",
          severity: "info",
          description:
            quizSentType === "lln_digital.sent"
              ? `LLN quiz and Digital quiz sent to ${fullName}`
              : quizSentType === "lln.sent"
              ? `LLN quiz sent to ${fullName}`
              : `Digital quiz sent to ${fullName}`,
          source: "system",
          actor: "system",
          event_data: { contact_id: contactId, qualification_id: qualificationId },
          timestamp: new Date().toISOString(),
        });
      }
    }

    // ── 8. Write contact note to aXcelerate ────────────────────────────────
    const noteText = buildInboundNote({
      contactName: fullName,
      contactEmail: email,
      qualName,
      llnAction,
      digitalAction,
      llnInsufficientAcsf,
      digitalInsufficientAcsf,
      timezone: accountTimezone,
    });

    let noteWritten = false;
    try {
      const noteRes = await fetch(`${apiBaseUrl}/contact/note/`, {
        method: "POST",
        headers: axHdr,
        body: new URLSearchParams({ contactID: String(contactId), contactNote: noteText, noteTypeID: "88" }),
      });
      noteWritten = noteRes.ok;

      await supabase.from("axcelerate_sync_log").insert({
        invitation_id: newInvitationId,
        event_type: "inbound_sync",
        sync_type: "note",
        request_payload: { contactID: contactId, note_length: noteText.length },
        response_payload: await noteRes.json().catch(() => ({})),
        status: noteRes.ok ? "success" : "failed",
        error: noteRes.ok ? null : `HTTP ${noteRes.status}`,
      });
    } catch (e: any) {
      await supabase.from("axcelerate_sync_log").insert({
        invitation_id: newInvitationId,
        event_type: "inbound_sync",
        sync_type: "note",
        request_payload: { contactID: contactId },
        response_payload: null,
        status: "failed",
        error: e.message,
      });
    }

    // ── 9. Record in inbound sync log ───────────────────────────────────────
    const assessmentTypeDone =
      llnRequired && digitalRequired ? "both"
      : llnRequired ? "lln"
      : "digital";

    const finalStatus = needsNewLln || needsNewDigital ? "created" : "skipped";

    await supabase.from("axcelerate_inbound_sync_log").upsert(
      {
        axcelerate_contact_id: contactId,
        assessment_type: assessmentTypeDone,
        qualification_id: qualificationId,
        axcelerate_course_id: resolvedCourseId,
        idempotency_key: idempotencyKey,
        status: finalStatus,
        invitation_id: newInvitationId,
        lln_invitation_id: llnInvitationId,
        digital_invitation_id: digitalInvitationId,
        contact_name: fullName,
        contact_email: email,
        note_text: noteText,
        note_written: noteWritten,
        processed_at: new Date().toISOString(),
      },
      { onConflict: "idempotency_key" },
    );

    // ── 10. Trigger email queue dispatch ────────────────────────────────────
    if (newInvitationId) {
      const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
      fetch(`${Deno.env.get("SUPABASE_URL")}/functions/v1/process-email-queue`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${serviceKey}`,
        },
        body: JSON.stringify({ invitation_id: newInvitationId }),
      }).catch(() => {});

      fetch(`${Deno.env.get("SUPABASE_URL")}/functions/v1/process-axcelerate-queue`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${serviceKey}`,
        },
        body: JSON.stringify({ invitation_id: newInvitationId }),
      }).catch(() => {});
    }

    // Final audit
    await supabase.from("audit_trail").insert({
      invitation_id: newInvitationId,
      event_type: `axcelerate.inbound_sync.${finalStatus}`,
      category: "axcelerate_integration",
      severity: "info",
      description: `Inbound sync for ${fullName} (Contact ${contactId}): LLN=${llnAction}, Digital=${digitalAction}`,
      source: "system",
      actor: "system",
      event_data: {
        contact_id: contactId,
        lln_action: llnAction,
        digital_action: digitalAction,
        new_invitation_id: newInvitationId,
        qualification_id: qualificationId,
      },
      timestamp: new Date().toISOString(),
    });

    return new Response(
      JSON.stringify({
        success: true,
        contact_id: contactId,
        contact_name: fullName,
        lln_action: llnAction,
        digital_action: digitalAction,
        new_invitation_id: newInvitationId,
        note_written: noteWritten,
        status: finalStatus,
      }),
      { headers: { ...corsHeaders, "Content-Type": "application/json" } },
    );
  } catch (err: any) {
    return new Response(JSON.stringify({ error: err.message || "Internal error" }), {
      status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});
