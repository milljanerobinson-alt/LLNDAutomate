// Assessment-result validity and safe reuse.
//
// Pure functions (no Deno or Supabase imports) so the same rules run in the
// Edge Function and in the project's Vitest suite.
//
// Rules
// - A previous result is reused only when ALL of these hold:
//     1. the result's own completion date (lln_completed_at or
//        digital_completed_at — never the other assessment's date and never
//        the invitation's overall date) is present, parseable and not in the
//        future;
//     2. the RTO has configured a validity period for that assessment type;
//     3. the result was still inside that period at the decision time;
//     4. the qualification is identified and the result meets its
//        requirements (LLN: every required ACSF core skill; Digital: the pass
//        mark of the assessment the candidate sat).
// - Expired or insufficient results → a new assessment is issued.
// - Results that can't be verified (missing/invalid/future date, validity
//   period not configured, qualification not identified, scores missing) are
//   never accepted automatically and are never silently replaced: the case
//   is held for RTO review. No default validity period exists.

export type AssessmentType = "lln" | "digital";

export interface ValidityPolicy {
  lln_days: number | null;
  digital_days: number | null;
}

export const VALIDITY_SETTING_KEY = "assessment_result_validity";
export const MAX_VALIDITY_DAYS = 3650;
const DAY_MS = 86_400_000;

/** Reads the organisation setting. Anything not a whole number of days in range counts as "not configured". */
export function parseValidityPolicy(raw: unknown): ValidityPolicy {
  const value = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  const days = (v: unknown): number | null =>
    typeof v === "number" && Number.isInteger(v) && v >= 1 && v <= MAX_VALIDITY_DAYS ? v : null;
  return { lln_days: days(value.lln_days), digital_days: days(value.digital_days) };
}

export function policyDays(policy: ValidityPolicy, type: AssessmentType): number | null {
  return type === "lln" ? policy.lln_days : policy.digital_days;
}

// ── Requirements ──────────────────────────────────────────────────────────────

export interface QualificationRequirement {
  domain: string;
  acsf_skill: string | null;
  minimum_acsf_level: number;
}

/** "Oral Communication" → "oral_communication" (the key the LLN assessment stores). */
export function skillKey(skill: string): string {
  return skill.trim().toLowerCase().replace(/[\s-]+/g, "_");
}

const LLN_SKILLS = new Set(["reading", "writing", "numeracy", "oral_communication", "learning"]);

/** Requirements that the LLN assessment measures (Digital Literacy is measured by the Digital assessment). */
export function llnRequirements(reqs: QualificationRequirement[]): Array<{ skill: string; level: number; label: string }> {
  return reqs
    .filter((r) => r.acsf_skill && LLN_SKILLS.has(skillKey(r.acsf_skill)))
    .map((r) => ({ skill: skillKey(r.acsf_skill!), level: r.minimum_acsf_level, label: r.acsf_skill!.trim() }));
}

export interface SufficiencyResult {
  sufficient: boolean | null; // null = can't be determined
  detail: string;
}

export function checkLlnSufficiency(
  outcomes: Record<string, unknown> | null | undefined,
  reqs: QualificationRequirement[],
  defaultMinimumAcsf: number,
): SufficiencyResult {
  const scores: Record<string, number> = {};
  for (const [k, v] of Object.entries(outcomes ?? {})) {
    if (typeof v === "number" && Number.isFinite(v)) scores[skillKey(k)] = v;
  }
  if (Object.keys(scores).length === 0) return { sufficient: null, detail: "no ACSF levels were recorded for the result" };
  const required = llnRequirements(reqs);
  if (required.length === 0) {
    // Existing platform behaviour, stated plainly in the note.
    const ok = Object.values(scores).some((v) => v >= defaultMinimumAcsf);
    return {
      sufficient: ok,
      detail: `no ACSF requirements are recorded for this qualification; the platform minimum of ACSF ${defaultMinimumAcsf} in at least one skill was ${ok ? "met" : "not met"}`,
    };
  }
  const parts: string[] = [];
  let ok = true;
  for (const r of required) {
    const achieved = scores[r.skill];
    if (achieved === undefined) { ok = false; parts.push(`${r.label} not recorded (needs ${r.level})`); continue; }
    if (achieved < r.level) ok = false;
    parts.push(`${r.label} ${achieved} (needs ${r.level})`);
  }
  return { sufficient: ok, detail: `ACSF levels: ${parts.join(", ")}` };
}

export function checkDigitalSufficiency(score: unknown, passMark: number | null): SufficiencyResult {
  if (typeof score !== "number" || !Number.isFinite(score)) return { sufficient: null, detail: "no Digital score was recorded for the result" };
  if (passMark === null) return { sufficient: null, detail: "the Digital assessment's pass mark could not be found" };
  return { sufficient: score >= passMark, detail: `Digital score ${score}% (pass mark ${passMark}%)` };
}

// ── Completion dates and validity ────────────────────────────────────────────

export type ResultStatus = "valid" | "expired" | "insufficient" | "unverifiable" | "not_configured";

export interface ResultCheck {
  status: ResultStatus;
  reason: string;
  completedAt: string | null;
  validUntil: string | null;
  validityDays: number | null;
  sufficiencyDetail: string | null;
}

export function parseCompletionDate(raw: unknown): Date | null {
  if (typeof raw !== "string" || raw.trim() === "") return null;
  const d = new Date(raw);
  return Number.isNaN(d.getTime()) ? null : d;
}

/**
 * Evaluates one result at `asOf` (the decision time). `now` is only used to
 * reject completion dates in the future.
 * Boundary: valid while asOf < completedAt + days; at exactly that instant it has expired.
 */
export function evaluateResult(input: {
  type: AssessmentType;
  completedAtRaw: unknown;
  validityDays: number | null;
  sufficiency: SufficiencyResult;
  qualificationIdentified: boolean;
  asOf: Date;
  now: Date;
}): ResultCheck {
  const label = input.type === "lln" ? "LLN" : "Digital";
  const base = { completedAt: null as string | null, validUntil: null as string | null, validityDays: input.validityDays, sufficiencyDetail: input.sufficiency.detail };
  if (input.completedAtRaw === null || input.completedAtRaw === undefined || input.completedAtRaw === "") {
    return { ...base, status: "unverifiable", reason: `the previous ${label} result has no completion date` };
  }
  const completed = parseCompletionDate(input.completedAtRaw);
  if (!completed) return { ...base, status: "unverifiable", reason: `the previous ${label} result has an invalid completion date` };
  const completedAt = completed.toISOString();
  if (completed.getTime() > input.now.getTime()) {
    return { ...base, completedAt, status: "unverifiable", reason: `the previous ${label} result has a completion date in the future` };
  }
  if (input.validityDays === null) {
    return { ...base, completedAt, status: "not_configured", reason: `the RTO has not set how long ${label} results remain valid` };
  }
  const validUntil = new Date(completed.getTime() + input.validityDays * DAY_MS);
  const withDates = { ...base, completedAt, validUntil: validUntil.toISOString() };
  if (input.asOf.getTime() >= validUntil.getTime()) {
    return { ...withDates, status: "expired", reason: `the previous ${label} result is older than the RTO's ${input.validityDays}-day validity period` };
  }
  if (!input.qualificationIdentified) {
    return { ...withDates, status: "unverifiable", reason: `the qualification could not be identified, so the ${label} result could not be checked against its requirements` };
  }
  if (input.sufficiency.sufficient === null) {
    return { ...withDates, status: "unverifiable", reason: input.sufficiency.detail };
  }
  if (!input.sufficiency.sufficient) {
    return { ...withDates, status: "insufficient", reason: `the previous ${label} result does not meet this qualification's requirements` };
  }
  return { ...withDates, status: "valid", reason: `the previous ${label} result is within the RTO's ${input.validityDays}-day validity period and meets this qualification's requirements` };
}

// ── Choosing the result to evaluate ──────────────────────────────────────────

export interface CompletedInvitation {
  id: string;
  organisation_id?: string | null;
  lln_status?: string | null;
  digital_status?: string | null;
  lln_completed_at?: string | null;
  digital_completed_at?: string | null;
  completed_at?: string | null;
  created_at?: string | null;
}

/**
 * The most recent attempt of this type is the one that counts (a later attempt
 * supersedes an earlier one). Ordered by that type's own completion date;
 * attempts with an unusable date sort by the invitation's dates so they still
 * surface (and are then rejected as unverifiable rather than skipped).
 */
export function latestCompletedResult<T extends CompletedInvitation>(rows: T[], type: AssessmentType, organisationId: string): T | null {
  const own = rows.filter((r) => r.organisation_id === organisationId &&
    (type === "lln" ? r.lln_status === "completed" : r.digital_status === "completed"));
  if (own.length === 0) return null;
  const when = (r: T) => {
    const d = parseCompletionDate(type === "lln" ? r.lln_completed_at : r.digital_completed_at)
      ?? parseCompletionDate(r.completed_at) ?? parseCompletionDate(r.created_at);
    return d ? d.getTime() : 0;
  };
  return [...own].sort((a, b) => when(b) - when(a))[0];
}

// ── Per-type decision ────────────────────────────────────────────────────────

export type Action = "sent" | "active" | "existing" | "review" | "none";

export interface Decision {
  type: AssessmentType;
  action: Action;
  invitationId: string | null;
  check: ResultCheck | null;
}

export function decide(input: {
  type: AssessmentType;
  required: boolean;
  activeInvitationId: string | null;
  latest: CompletedInvitation | null;
  check: ResultCheck | null;
}): Decision {
  const { type } = input;
  if (!input.required) return { type, action: "none", invitationId: null, check: null };
  if (input.activeInvitationId) return { type, action: "active", invitationId: input.activeInvitationId, check: null };
  if (!input.latest || !input.check) return { type, action: "sent", invitationId: null, check: null };
  switch (input.check.status) {
    case "valid": return { type, action: "existing", invitationId: input.latest.id, check: input.check };
    case "expired":
    case "insufficient": return { type, action: "sent", invitationId: null, check: input.check };
    default: return { type, action: "review", invitationId: input.latest.id, check: input.check };
  }
}

// ── Previously processed records ─────────────────────────────────────────────

export interface PreviousLog {
  status: string;
  invitation_id: string | null;
  lln_invitation_id: string | null;
  digital_invitation_id: string | null;
  decision_at?: string | null;
  validated_at?: string | null;
  created_at?: string | null;
  outcome_signature?: string | null;
  note_written?: boolean | null;
}

/**
 * Whether a previous "already processed" entry can stand without re-checking.
 * - Entries written before validity checks existed (no validated_at) are
 *   re-checked, so they can't bypass expiry.
 * - Review-required entries are re-checked every time, so they proceed once
 *   the RTO fixes the cause (for example, sets a validity period).
 * - Validated entries stand: the result was valid when it was accepted for
 *   this enrolment, so the learner is not reassessed mid-course.
 * Re-checks are judged at the original decision time.
 */
export function planForPreviousLog(log: PreviousLog | null, now: Date): { recheck: boolean; asOf: Date } {
  if (!log) return { recheck: true, asOf: now };
  const asOf = parseCompletionDate(log.decision_at) ?? parseCompletionDate(log.created_at) ?? now;
  const decisionTime = asOf.getTime() > now.getTime() ? now : asOf;
  if (log.status === "review_required") return { recheck: true, asOf: decisionTime };
  if (!log.validated_at) return { recheck: true, asOf: decisionTime };
  return { recheck: false, asOf: decisionTime };
}

/** Types that the previous entry satisfied with the invitation it created for this enrolment — never re-evaluated. */
export function typesCoveredByOwnInvitation(log: PreviousLog | null): Set<AssessmentType> {
  const out = new Set<AssessmentType>();
  if (!log?.invitation_id) return out;
  if (log.lln_invitation_id === log.invitation_id) out.add("lln");
  if (log.digital_invitation_id === log.invitation_id) out.add("digital");
  return out;
}

/** Stable description of the outcome; the aXcelerate note is written only when this changes. */
export function outcomeSignature(decisions: Decision[]): string {
  return decisions
    .filter((d) => d.action !== "none")
    .map((d) => `${d.type}:${d.action}:${d.invitationId ?? ""}:${d.check?.status ?? ""}`)
    .sort()
    .join("|");
}

/**
 * Notes are milestones, not activity: write one when there is no earlier
 * note for this enrolment, or when the outcome changed. Entries written
 * before outcome signatures existed get a new note only if something new
 * happened (an invitation issued or a review hold), so re-checking old
 * records doesn't repeat notes in aXcelerate.
 */
export function shouldWriteNote(previous: PreviousLog | null, signature: string, decisions: Decision[]): boolean {
  if (!previous || previous.note_written !== true) return true;
  if (previous.outcome_signature) return previous.outcome_signature !== signature;
  return decisions.some((d) => d.action === "sent" || d.action === "review");
}

// ── Whole-contact plan ───────────────────────────────────────────────────────

export interface LearnerInvitation extends CompletedInvitation {
  status?: string | null;
  lln_token?: string | null;
  digital_token?: string | null;
  lln_acsf_outcomes?: Record<string, unknown> | null;
  digital_score?: number | null;
}

/**
 * Decides LLN and Digital for one contact. `digitalPassMarks` holds the pass
 * mark of the Digital assessment sat on each invitation (by invitation id).
 */
export function planAssessments(input: {
  organisationId: string;
  llnRequired: boolean;
  digitalRequired: boolean;
  invitations: LearnerInvitation[];
  previousLog: PreviousLog | null;
  policy: ValidityPolicy;
  requirements: QualificationRequirement[];
  digitalPassMarks: Record<string, number | null>;
  qualificationIdentified: boolean;
  defaultMinimumAcsf: number;
  now: Date;
}): { decisions: Decision[]; asOf: Date; recheck: boolean } {
  const { recheck, asOf } = planForPreviousLog(input.previousLog, input.now);
  const own = typesCoveredByOwnInvitation(input.previousLog);
  const invitations = input.invitations.filter((i) => i.organisation_id === input.organisationId);
  const decisions: Decision[] = [];
  for (const type of ["lln", "digital"] as AssessmentType[]) {
    const required = type === "lln" ? input.llnRequired : input.digitalRequired;
    const tokenKey = type === "lln" ? "lln_token" : "digital_token";
    const statusKey = type === "lln" ? "lln_status" : "digital_status";
    if (required && own.has(type)) {
      // Satisfied by the invitation created for this enrolment: its outcome
      // is this enrolment's result and is never reissued automatically.
      const ownId = input.previousLog!.invitation_id as string;
      const inv = invitations.find((i) => i.id === ownId);
      const open = !!inv && inv[statusKey] !== "completed";
      decisions.push({ type, action: open ? "active" : "existing", invitationId: ownId, check: null });
      continue;
    }
    const active = invitations.find((i) => ["sent", "opened", "in_progress"].includes(i.status ?? "") &&
      !!i[tokenKey] && i[statusKey] !== "completed");
    const latest = active ? null : latestCompletedResult(invitations, type, input.organisationId);
    let check: ResultCheck | null = null;
    if (required && latest) {
      const sufficiency = type === "lln"
        ? checkLlnSufficiency(latest.lln_acsf_outcomes, input.requirements, input.defaultMinimumAcsf)
        : checkDigitalSufficiency(latest.digital_score, input.digitalPassMarks[latest.id] ?? null);
      check = evaluateResult({
        type,
        completedAtRaw: type === "lln" ? latest.lln_completed_at : latest.digital_completed_at,
        validityDays: policyDays(input.policy, type),
        sufficiency,
        qualificationIdentified: input.qualificationIdentified,
        asOf,
        now: input.now,
      });
    }
    decisions.push(decide({ type, required, activeInvitationId: active?.id ?? null, latest, check }));
  }
  return { decisions, asOf, recheck };
}

// ── Student matching within one RTO ──────────────────────────────────────────

export interface StudentRow {
  id: string;
  organisation_id: string;
  axcelerate_contact_id: number | null;
  first_name: string | null;
  last_name: string | null;
  date_of_birth: string | null;
  email: string | null;
}

export type StudentMatch =
  | { kind: "matched"; id: string; by: "contact_id" | "dob_and_name" | "email_and_dob"; linkContact: boolean }
  | { kind: "none" }
  | { kind: "ambiguous"; reason: string };

const norm = (s: string | null | undefined) => (s ?? "").trim().toLowerCase().replace(/\s+/g, " ");

/**
 * Exact, organisation-scoped matching. Never guesses:
 * 1. aXcelerate contact ID (unique within the RTO);
 * 2. date of birth + first and last name, only for records not linked to a different contact;
 * 3. email, only when dates of birth don't conflict and the record isn't linked to a different contact.
 * More than one candidate at any step → ambiguous (held for review).
 */
export function matchStudent(
  rows: StudentRow[],
  input: { organisationId: string; contactId: number; firstName: string; lastName: string; dob: string | null; email: string | null },
): StudentMatch {
  const own = rows.filter((r) => r.organisation_id === input.organisationId);
  const byContact = own.filter((r) => r.axcelerate_contact_id === input.contactId);
  if (byContact.length === 1) return { kind: "matched", id: byContact[0].id, by: "contact_id", linkContact: false };
  if (byContact.length > 1) return { kind: "ambiguous", reason: "more than one student record has this aXcelerate contact ID" };

  const free = own.filter((r) => r.axcelerate_contact_id === null || r.axcelerate_contact_id === undefined);
  if (input.dob && norm(input.firstName) && norm(input.lastName)) {
    const byDob = free.filter((r) => r.date_of_birth === input.dob &&
      norm(r.first_name) === norm(input.firstName) && norm(r.last_name) === norm(input.lastName));
    if (byDob.length === 1) return { kind: "matched", id: byDob[0].id, by: "dob_and_name", linkContact: true };
    if (byDob.length > 1) return { kind: "ambiguous", reason: "more than one student record has this name and date of birth" };
  }
  if (norm(input.email)) {
    const byEmail = free.filter((r) => norm(r.email) === norm(input.email) &&
      (!r.date_of_birth || !input.dob || r.date_of_birth === input.dob));
    if (byEmail.length === 1) return { kind: "matched", id: byEmail[0].id, by: "email_and_dob", linkContact: true };
    if (byEmail.length > 1) return { kind: "ambiguous", reason: "more than one student record shares this email address" };
  }
  return { kind: "none" };
}

/** Escapes LIKE wildcards so a name or email is matched literally. */
export function escapeLike(value: string): string {
  return value.replace(/[\\%_]/g, (c) => `\\${c}`);
}

// ── Contact note ──────────────────────────────────────────────────────────────

function fmtDate(iso: string | null, timezone: string): string {
  if (!iso) return "unknown date";
  return new Date(iso).toLocaleDateString("en-AU", { day: "numeric", month: "long", year: "numeric", timeZone: timezone });
}

/** One concise initial summary. Wording states exactly what was checked. */
export function buildInboundNote(params: {
  contactName: string;
  qualName: string;
  qualificationIdentified: boolean;
  decisions: Decision[];
  now: Date;
  timezone: string;
}): string {
  const lines = ["LLND Automate — assessment check", `Contact: ${params.contactName}`,
    `Qualification: ${params.qualificationIdentified ? params.qualName : "not identified from the aXcelerate enrolment"}`,
    `Date: ${fmtDate(params.now.toISOString(), params.timezone)}`, "OUTCOME"];
  let any = false;
  for (const d of params.decisions) {
    if (d.action === "none") continue;
    any = true;
    const name = d.type === "lln" ? "LLN" : "Digital Skills";
    const c = d.check;
    switch (d.action) {
      case "active":
        lines.push(`- ${name}: an assessment invitation is already open in LLND Automate. No new invitation issued.`);
        break;
      case "existing":
        if (!c) {
          lines.push(`- ${name}: completed through the LLND Automate invitation issued for this enrolment. No new assessment issued.`);
          break;
        }
        lines.push(`- ${name}: previous result reused. Completed ${fmtDate(c!.completedAt, params.timezone)}; valid for ${c!.validityDays} days (until ${fmtDate(c!.validUntil, params.timezone)}); ${c!.sufficiencyDetail}. No new assessment issued.`);
        break;
      case "sent":
        if (c?.status === "expired") {
          lines.push(`- ${name}: previous result (completed ${fmtDate(c.completedAt, params.timezone)}) is older than the RTO's ${c.validityDays}-day validity period. New assessment invitation issued.`);
        } else if (c?.status === "insufficient") {
          lines.push(`- ${name}: previous result does not meet this qualification's requirements (${c.sufficiencyDetail}). New assessment invitation issued.`);
        } else {
          lines.push(`- ${name}: no previous result found. Assessment invitation issued.`);
        }
        break;
      case "review":
        lines.push(`- ${name}: a previous result exists but was not accepted automatically because ${c?.reason ?? "it could not be verified"}. Held for RTO review in LLND Automate; no new invitation issued yet.`);
        break;
    }
  }
  if (!any) lines.push("- No assessment required.");
  return lines.join("\n");
}
