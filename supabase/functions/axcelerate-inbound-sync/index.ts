import { createClient } from "jsr:@supabase/supabase-js@2";
import { getIntegrationOrganisationId, isIntegrationStaff } from "../_shared/organisation-access.ts";
import {
  VALIDITY_SETTING_KEY, buildInboundNote, escapeLike, latestCompletedResult, matchStudent, outcomeSignature,
  parseValidityPolicy, planAssessments, planForPreviousLog, shouldWriteNote,
  type AssessmentType, type Decision, type QualificationRequirement, type StudentRow,
} from "../_shared/result-validity.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, PUT, DELETE, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization, X-Client-Info, Apikey, X-Cron-Secret",
};

const DEFAULT_MIN_ACSF = 2;

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

// ── Student record helpers ────────────────────────────────────────────────────

// Exact, organisation-scoped student matching (see _shared/result-validity.ts).
async function resolveStudent(
  supabase: any,
  params: { firstName: string; lastName: string; dob: string | null; email: string | null; axcelerateContactId: number },
): Promise<{ kind: "matched" | "created"; id: string } | { kind: "ambiguous"; reason: string }> {
  const { firstName, lastName, dob, email, axcelerateContactId } = params;
  const cols = "id, organisation_id, axcelerate_contact_id, first_name, last_name, date_of_birth, email";
  const queries = [
    supabase.from("students").select(cols).eq("organisation_id", INTEGRATION_ORGANISATION_ID).eq("axcelerate_contact_id", axcelerateContactId).limit(5),
  ];
  if (dob) queries.push(supabase.from("students").select(cols).eq("organisation_id", INTEGRATION_ORGANISATION_ID).eq("date_of_birth", dob).limit(50));
  if (email) queries.push(supabase.from("students").select(cols).eq("organisation_id", INTEGRATION_ORGANISATION_ID).ilike("email", escapeLike(email.trim())).limit(20));
  const results = await Promise.all(queries);
  const failed = results.find((r: any) => r.error);
  if (failed) throw new Error(`Student lookup failed: ${failed.error.message}`);
  const byId = new Map<string, StudentRow>();
  for (const r of results) for (const row of (r.data ?? []) as StudentRow[]) byId.set(row.id, row);

  const match = matchStudent([...byId.values()], {
    organisationId: INTEGRATION_ORGANISATION_ID, contactId: axcelerateContactId, firstName, lastName, dob, email,
  });
  if (match.kind === "ambiguous") return match;
  if (match.kind === "matched") {
    if (match.linkContact) {
      await supabase.from("students").update({ axcelerate_contact_id: axcelerateContactId })
        .eq("organisation_id", INTEGRATION_ORGANISATION_ID).eq("id", match.id).is("axcelerate_contact_id", null);
    }
    return { kind: "matched", id: match.id };
  }

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
  return { kind: "created", id: created.id };
}

// Invitations that belong to this learner within the RTO: linked by student,
// by aXcelerate contact, or (legacy rows with neither) by exact name + DOB.
async function learnerInvitations(
  supabase: any,
  params: { studentId: string; contactId: number; fullName: string; dob: string | null },
): Promise<any[]> {
  const cols = "id, organisation_id, status, lln_status, digital_status, lln_token, digital_token, lln_completed_at, digital_completed_at, completed_at, created_at, lln_acsf_outcomes, digital_score, qualification_id, student_id, axcelerate_contact_id";
  const queries = [
    supabase.from("assessment_invitations").select(cols).eq("organisation_id", INTEGRATION_ORGANISATION_ID).eq("student_id", params.studentId).limit(50),
    supabase.from("assessment_invitations").select(cols).eq("organisation_id", INTEGRATION_ORGANISATION_ID).eq("axcelerate_contact_id", params.contactId).limit(50),
  ];
  if (params.dob && params.fullName.length > 2) {
    queries.push(supabase.from("assessment_invitations").select(cols).eq("organisation_id", INTEGRATION_ORGANISATION_ID)
      .is("student_id", null).is("axcelerate_contact_id", null)
      .eq("candidate_dob", params.dob).ilike("candidate_name", escapeLike(params.fullName)).limit(20));
  }
  const results = await Promise.all(queries);
  const failed = results.find((r: any) => r.error);
  if (failed) throw new Error(`Invitation lookup failed: ${failed.error.message}`);
  const byId = new Map<string, any>();
  for (const r of results) for (const row of r.data ?? []) byId.set(row.id, row);
  return [...byId.values()];
}

// Pass mark of the Digital assessment the candidate actually sat.
async function digitalPassMark(supabase: any, invitationId: string): Promise<number | null> {
  const { data } = await supabase
    .from("invitation_assessments")
    .select("assessments(type, pass_threshold)")
    .eq("invitation_id", invitationId);
  for (const row of data ?? []) {
    const a = Array.isArray(row.assessments) ? row.assessments[0] : row.assessments;
    if (a?.type === "digital" && typeof a.pass_threshold === "number") return a.pass_threshold;
  }
  return null;
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
      ).then(() => {}, () => {});
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
    let requirements: QualificationRequirement[] = [];

    const lookupQual = async (query: any) => {
      const { data: qual } = await query;
      if (!qual) return;
      qualificationId = qual.id;
      qualName = `${qual.code} ${qual.name}`;
      const { data: reqs } = await supabase
        .from("qualification_lln_requirements")
        .select("domain, acsf_skill, minimum_acsf_level")
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
      .eq("organisation_id", INTEGRATION_ORGANISATION_ID)
      .eq("idempotency_key", idempotencyKey)
      .maybeSingle();

    const now = new Date();
    // Previously processed entries are re-checked unless they were validated
    // under the result-validity rules (see planForPreviousLog).
    let previousLog = existingLog ?? null;

    if (existingLog && existingLog.status === "created") {
      // The FK is ON DELETE SET NULL: if the invitation was deleted, start again.
      let invitationGone = !existingLog.invitation_id;
      if (!invitationGone) {
        const { data: existingInv } = await supabase
          .from("assessment_invitations")
          .select("id").eq("organisation_id", INTEGRATION_ORGANISATION_ID)
          .eq("id", existingLog.invitation_id)
          .maybeSingle();
        invitationGone = !existingInv;
      }
      if (invitationGone) {
        await supabase.from("axcelerate_inbound_sync_log").delete()
          .eq("organisation_id", INTEGRATION_ORGANISATION_ID).eq("idempotency_key", idempotencyKey);
        previousLog = null;
      }
    }

    const plan = planForPreviousLog(previousLog, now);
    if (previousLog && !plan.recheck && ["created", "skipped"].includes(previousLog.status)) {
      // Validated earlier for this enrolment: keep the decision. Patch a
      // missing email and retry a failed note, as before.
      if (previousLog.status === "created" && email && previousLog.invitation_id) {
        const { data: inv } = await supabase
          .from("assessment_invitations")
          .select("id, candidate_email").eq("organisation_id", INTEGRATION_ORGANISATION_ID)
          .eq("id", previousLog.invitation_id)
          .maybeSingle();
        if (inv && !inv.candidate_email) {
          await supabase.from("assessment_invitations").update({ candidate_email: email })
            .eq("organisation_id", INTEGRATION_ORGANISATION_ID).eq("id", inv.id);
          await supabase.from("email_queue")
            .update({ recipient_email: email, status: "pending", attempts: 0, last_error: null })
            .eq("organisation_id", INTEGRATION_ORGANISATION_ID)
            .eq("invitation_id", inv.id).in("status", ["failed", "pending"]);
          await supabase.from("axcelerate_inbound_sync_log").update({ contact_email: email })
            .eq("organisation_id", INTEGRATION_ORGANISATION_ID).eq("id", previousLog.id);
          fetch(`${Deno.env.get("SUPABASE_URL")}/functions/v1/process-email-queue`, {
            method: "POST",
            headers: { "Content-Type": "application/json", Authorization: `Bearer ${Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!}` },
            body: JSON.stringify({ invitation_id: inv.id }),
          }).catch(() => {});
          return new Response(JSON.stringify({ message: "Email was missing — patched and re-queued", invitation_id: inv.id }),
            { headers: { ...corsHeaders, "Content-Type": "application/json" } });
        }
      }
      if (!previousLog.note_written && previousLog.note_text) {
        try {
          const noteRes = await fetch(`${apiBaseUrl}/contact/note/`, {
            method: "POST",
            headers: axHdr,
            body: new URLSearchParams({ contactID: String(contactId), contactNote: previousLog.note_text, noteTypeID: "88" }),
          });
          if (noteRes.ok) {
            await supabase.from("axcelerate_inbound_sync_log").update({ note_written: true })
              .eq("organisation_id", INTEGRATION_ORGANISATION_ID).eq("id", previousLog.id);
          }
          await supabase.from("axcelerate_sync_log").insert({
            invitation_id: previousLog.invitation_id,
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
        JSON.stringify({ message: "Already processed", idempotency_key: idempotencyKey, status: previousLog.status, log_id: previousLog.id }),
        { headers: { ...corsHeaders, "Content-Type": "application/json" } },
      );
    }

    // ── 5. Identify the student within this RTO ─────────────────────────────
    const studentResult = await resolveStudent(supabase, {
      firstName, lastName, dob, email: email || null, axcelerateContactId: contactId,
    });

    // ── 6. Decide each assessment ───────────────────────────────────────────
    const { data: validityRow } = await supabase
      .from("organisation_settings").select("value")
      .eq("organisation_id", INTEGRATION_ORGANISATION_ID).eq("key", VALIDITY_SETTING_KEY).maybeSingle();
    const validityPolicy = parseValidityPolicy(validityRow?.value);
    let decisions: Decision[] = [];
    let studentId: string | null = null;
    let ambiguousReason: string | null = null;

    if (studentResult.kind === "ambiguous") {
      ambiguousReason = studentResult.reason;
    } else {
      studentId = studentResult.id;
      const invitations = await learnerInvitations(supabase, { studentId, contactId, fullName, dob });
      const digitalPassMarks: Record<string, number | null> = {};
      if (digitalRequired) {
        const latestDigital = latestCompletedResult(invitations, "digital", INTEGRATION_ORGANISATION_ID);
        if (latestDigital) digitalPassMarks[latestDigital.id] = await digitalPassMark(supabase, latestDigital.id);
      }
      decisions = planAssessments({
        organisationId: INTEGRATION_ORGANISATION_ID,
        llnRequired,
        digitalRequired,
        invitations,
        previousLog,
        policy: validityPolicy,
        requirements,
        digitalPassMarks,
        qualificationIdentified: !!qualificationId,
        defaultMinimumAcsf: DEFAULT_MIN_ACSF,
        now,
      }).decisions;
    }

    const llnDecision = decisions.find((d) => d.type === "lln");
    const digitalDecision = decisions.find((d) => d.type === "digital");
    const llnAction = ambiguousReason ? (llnRequired ? "review" : "none") : (llnDecision?.action ?? "none");
    const digitalAction = ambiguousReason ? (digitalRequired ? "review" : "none") : (digitalDecision?.action ?? "none");
    let llnInvitationId: string | null = llnDecision?.invitationId ?? null;
    let digitalInvitationId: string | null = digitalDecision?.invitationId ?? null;

    // ── 7. Create invitations for anything that requires a new one ──────────
    let newInvitationId: string | null = null;

    const needsNewLln = llnAction === "sent";
    const needsNewDigital = digitalAction === "sent";

    // Backfill qualification onto an existing OPEN invitation that was created
    // without one (e.g. when the enrolment API was unavailable on the first run).
    if (qualificationId && !needsNewLln && !needsNewDigital) {
      const existingInvId = (llnAction === "active" ? llnInvitationId : null) ?? (digitalAction === "active" ? digitalInvitationId : null);
      if (existingInvId) {
        await supabase
          .from("assessment_invitations")
          .update({ qualification_id: qualificationId }).eq("organisation_id", INTEGRATION_ORGANISATION_ID)
          .eq("id", existingInvId).is("qualification_id", null);
      }
    }

    let enrolmentId: string | null = null;
    if (studentId) {
      try {
        enrolmentId = await findOrCreateEnrolment(supabase, studentId, qualificationId, resolvedCourseId);
      } catch (e: any) {
        // Non-fatal — proceed without enrolment linkage
        console.error("Enrolment creation failed:", e.message);
      }
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

    // ── 8. Contact note: one concise summary, written only when the outcome changes
    const finalDecisions: Decision[] = ambiguousReason
      ? (["lln", "digital"] as AssessmentType[])
          .filter((t) => (t === "lln" ? llnRequired : digitalRequired))
          .map((t) => ({ type: t, action: "review" as const, invitationId: null,
            check: { status: "unverifiable" as const, reason: `${ambiguousReason}, so the student could not be identified reliably`, completedAt: null, validUntil: null, validityDays: null, sufficiencyDetail: null } }))
      : decisions.map((d) => d.action === "sent"
          ? { ...d, invitationId: (d.type === "lln" ? llnInvitationId : digitalInvitationId) }
          : d);
    const signature = outcomeSignature(finalDecisions);
    const noteText = buildInboundNote({
      contactName: fullName,
      qualName,
      qualificationIdentified: !!qualificationId,
      decisions: finalDecisions,
      now,
      timezone: accountTimezone,
    });

    const writeNote = shouldWriteNote(previousLog, signature, finalDecisions);
    let noteWritten = !writeNote;
    if (writeNote) {
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
        noteWritten = false;
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
    }

    // ── 9. Record in inbound sync log ───────────────────────────────────────
    const assessmentTypeDone =
      llnRequired && digitalRequired ? "both"
      : llnRequired ? "lln"
      : "digital";

    const needsReview = llnAction === "review" || digitalAction === "review";
    const finalStatus = needsNewLln || needsNewDigital
      ? "created"
      : needsReview ? "review_required" : "skipped";
    const keptInvitationId = previousLog?.status === "created" ? previousLog.invitation_id : null;

    await supabase.from("axcelerate_inbound_sync_log").upsert(
      {
        organisation_id: INTEGRATION_ORGANISATION_ID,
        axcelerate_contact_id: contactId,
        assessment_type: assessmentTypeDone,
        qualification_id: qualificationId,
        axcelerate_course_id: resolvedCourseId,
        idempotency_key: idempotencyKey,
        status: finalStatus === "skipped" && keptInvitationId ? "created" : finalStatus,
        invitation_id: newInvitationId ?? keptInvitationId,
        lln_invitation_id: llnInvitationId,
        digital_invitation_id: digitalInvitationId,
        contact_name: fullName,
        contact_email: email,
        note_text: writeNote ? noteText : (previousLog?.note_text ?? noteText),
        note_written: noteWritten,
        outcome_signature: signature,
        decision_at: plan.asOf.toISOString(),
        validated_at: needsReview ? null : now.toISOString(),
        validity_checks: finalDecisions.map((d) => ({
          type: d.type, action: d.action, invitation_id: d.invitationId,
          status: d.check?.status ?? null, reason: d.check?.reason ?? null,
          completed_at: d.check?.completedAt ?? null, valid_until: d.check?.validUntil ?? null,
          validity_days: d.check?.validityDays ?? null, requirements: d.check?.sufficiencyDetail ?? null,
        })),
        error: ambiguousReason,
        processed_at: now.toISOString(),
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
