// Assessment-result validity and safe reuse.
//
// Pure functions (no Deno or Supabase imports) so the same rules run in the
// Edge Function and in the project's Vitest suite.
//
// A completed LLN or Digital result is reused for a NEW enrolment only when
// ALL checks pass:
//   1. it belongs to this learner within this RTO (exact matching; ambiguity
//      → review);
//   2. its OWN completion date (lln_completed_at / digital_completed_at —
//      never the other module's date or the invitation's overall date) is
//      present, valid and not in the future;
//   3. the RTO has configured a validity period for that module (there is no
//      default) and the result is inside it;
//   4. the enrolment and its course are identified, and the course's ACSF
//      mapping is approved by the RTO — the approval covers the current ACSF
//      levels and no training.gov.au change has been recorded since;
//   5. LLN: every required ACSF core skill is met. Digital: the pass mark of
//      the Digital assessment the candidate sat is met.
// No fallback thresholds and no time-based mapping expiry.
//
// An EXISTING enrolment keeps its original decision. Time passing never
// reissues an assessment; a course change or a failed re-check of an older
// record holds it for RTO review instead.
// Unverifiable → held for review: never described as valid, never reused,
// and no assessment sent automatically.

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
  const value = (raw && typeof raw === "object" && !Array.isArray(raw) ? raw : {}) as Record<string, unknown>;
  const days = (v: unknown): number | null =>
    typeof v === "number" && Number.isInteger(v) && v >= 1 && v <= MAX_VALIDITY_DAYS ? v : null;
  return { lln_days: days(value.lln_days), digital_days: days(value.digital_days) };
}

export function policyDays(policy: ValidityPolicy, type: AssessmentType): number | null {
  return type === "lln" ? policy.lln_days : policy.digital_days;
}

// ── Course (current enrolment) requirements ──────────────────────────────────

export interface QualificationRequirement {
  domain: string;
  acsf_skill: string | null;
  minimum_acsf_level: number;
}

export interface MappingApproval {
  approved: boolean;
  reason: string;
  approvalId: string | null;
}

export interface CourseContext {
  qualificationId: string | null;
  /** False when aXcelerate's enrolment endpoints couldn't be checked. */
  enrolmentVerified: boolean;
  approval: MappingApproval;
  requirements: QualificationRequirement[];
}

/** "Oral Communication" → "oral_communication" (the key the LLN assessment stores). */
export function skillKey(skill: string): string {
  return skill.trim().toLowerCase().replace(/[\s-]+/g, "_");
}

const LLN_SKILLS = new Set(["reading", "writing", "numeracy", "oral_communication", "learning"]);

/** Requirements the LLN assessment measures (Digital Literacy is measured by the Digital assessment). */
export function llnRequirements(reqs: QualificationRequirement[]): Array<{ skill: string; level: number; label: string }> {
  return reqs
    .filter((r) => r.acsf_skill && LLN_SKILLS.has(skillKey(r.acsf_skill)) && Number.isFinite(r.minimum_acsf_level) && r.minimum_acsf_level > 0)
    .map((r) => ({ skill: skillKey(r.acsf_skill!), level: r.minimum_acsf_level, label: r.acsf_skill!.trim() }));
}

/** Order-independent form of a set of ACSF requirements (matches the database snapshot). */
export function normaliseRequirements(reqs: Array<Partial<QualificationRequirement>>): string {
  return reqs
    .map((r) => `${skillKey(String(r.acsf_skill ?? r.domain ?? ""))}=${Number(r.minimum_acsf_level)}`)
    .sort()
    .join(",");
}

export interface ApprovalRecord {
  id: string;
  decision: "approved" | "migrated_approval" | "review_required" | string;
  requirements_snapshot: Array<Partial<QualificationRequirement>> | null;
  source_release?: string | null;
  decided_at: string;
}

/**
 * Whether the course's ACSF mapping is approved now. An approval stands
 * until a training.gov.au change is recorded or the ACSF levels change —
 * never because time has passed.
 */
export function mappingApprovalState(input: {
  approvals: ApprovalRecord[];
  requirements: QualificationRequirement[];
  changeDetectedAt: string | null;
  changeSummary?: unknown;
}): MappingApproval {
  const sorted = [...input.approvals].sort((a, b) => (parseCompletionDate(b.decided_at)?.getTime() ?? 0) - (parseCompletionDate(a.decided_at)?.getTime() ?? 0));
  const latest = sorted[0];
  if (input.changeDetectedAt || latest?.decision === "review_required") {
    return { approved: false, reason: "the qualification has changed on training.gov.au and its ACSF mapping is awaiting RTO review", approvalId: null };
  }
  const approval = sorted.find((a) => a.decision === "approved" || a.decision === "migrated_approval");
  if (!approval) return { approved: false, reason: "the course's ACSF mapping has not been approved by the RTO", approvalId: null };
  if (normaliseRequirements(approval.requirements_snapshot ?? []) !== normaliseRequirements(input.requirements)) {
    return { approved: false, reason: "the course's ACSF levels have changed since the RTO approved them", approvalId: null };
  }
  return { approved: true, reason: "", approvalId: approval.id };
}

/** Whether the course can support an automatic reuse decision. */
export function courseReadiness(course: CourseContext, type: AssessmentType): { ready: boolean; reason: string } {
  if (!course.enrolmentVerified) {
    return { ready: false, reason: "the learner's aXcelerate enrolment could not be confirmed" };
  }
  if (!course.qualificationId) {
    return { ready: false, reason: "the course for this enrolment could not be identified" };
  }
  if (!course.approval.approved) return { ready: false, reason: course.approval.reason };
  if (type === "lln" && llnRequirements(course.requirements).length === 0) {
    return { ready: false, reason: "no LLN requirements are recorded for this course" };
  }
  return { ready: true, reason: "" };
}

// ── training.gov.au change assessment ────────────────────────────────────────

export interface SourceObservation {
  available: boolean;
  error?: string;
  code?: string | null;
  release?: string | null;
  status?: string | null; // e.g. "Current", "Superseded", "Deleted"
  supersededBy?: string | null;
  componentsHash?: string | null; // e.g. hash of core/elective unit list
}

export interface ApprovedSource {
  code: string;
  release: string | null;
  componentsHash?: string | null;
}

export type SourceAssessment =
  | { result: "unavailable"; reason: string }
  | { result: "not_applicable"; reason: string }
  | { result: "current" }
  | { result: "changed"; changes: string[] };

/**
 * Compares one qualification's approved source with what training.gov.au
 * reports now. A failed check is "unavailable" — never proof of no change.
 * Information about a different qualification is ignored.
 */
export function assessQualificationChange(approved: ApprovedSource, observed: SourceObservation): SourceAssessment {
  if (!observed.available) return { result: "unavailable", reason: observed.error || "training.gov.au could not be reached" };
  const sameCode = (observed.code ?? "").trim().toUpperCase() === approved.code.trim().toUpperCase();
  if (!sameCode) return { result: "not_applicable", reason: `information is for ${observed.code ?? "another qualification"}, not ${approved.code}` };
  const changes: string[] = [];
  const status = (observed.status ?? "").trim().toLowerCase();
  if (!approved.release) {
    changes.push(`the approved release was not recorded; training.gov.au shows release ${observed.release ?? "unknown"}`);
  } else if (observed.release && observed.release.trim() !== approved.release.trim()) {
    changes.push(`release changed from ${approved.release} to ${observed.release}`);
  }
  if (status && status !== "current") changes.push(`status is now ${observed.status}${observed.supersededBy ? ` (superseded by ${observed.supersededBy})` : ""}`);
  if (approved.componentsHash && observed.componentsHash && approved.componentsHash !== observed.componentsHash) {
    changes.push("units of competency changed");
  }
  return changes.length ? { result: "changed", changes } : { result: "current" };
}

export interface SufficiencyResult {
  sufficient: boolean | null; // null = can't be determined
  detail: string;
}

export function checkLlnSufficiency(outcomes: unknown, reqs: QualificationRequirement[]): SufficiencyResult {
  const scores: Record<string, number> = {};
  if (outcomes && typeof outcomes === "object" && !Array.isArray(outcomes)) {
    for (const [k, v] of Object.entries(outcomes as Record<string, unknown>)) {
      if (typeof v === "number" && Number.isFinite(v)) scores[skillKey(k)] = v;
    }
  }
  if (Object.keys(scores).length === 0) return { sufficient: null, detail: "no ACSF levels are recorded for the result" };
  const required = llnRequirements(reqs);
  if (required.length === 0) return { sufficient: null, detail: "no LLN requirements are recorded for this course" };
  const parts: string[] = [];
  let ok = true;
  for (const r of required) {
    const achieved = scores[r.skill];
    if (achieved === undefined) { ok = false; parts.push(`${r.label} not recorded (required ${r.level})`); continue; }
    if (achieved < r.level) ok = false;
    parts.push(`${r.label} ${achieved} (required ${r.level})`);
  }
  return { sufficient: ok, detail: `ACSF ${parts.join(", ")}` };
}

export function checkDigitalSufficiency(score: unknown, passMark: number | null): SufficiencyResult {
  if (typeof score !== "number" || !Number.isFinite(score)) return { sufficient: null, detail: "no Digital score is recorded for the result" };
  if (passMark === null || !Number.isFinite(passMark)) return { sufficient: null, detail: "the Digital assessment's pass mark could not be found" };
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
 * Evaluates one module's result as at `asOf` (the enrolment's decision time).
 * `now` is only used to reject completion dates in the future.
 * Boundary: valid while asOf < completedAt + days; at exactly that instant it has expired.
 */
export function evaluateResult(input: {
  type: AssessmentType;
  completedAtRaw: unknown;
  validityDays: number | null;
  course: CourseContext;
  sufficiency: SufficiencyResult;
  asOf: Date;
  now: Date;
}): ResultCheck {
  const label = input.type === "lln" ? "LLN" : "Digital";
  const empty = { completedAt: null as string | null, validUntil: null as string | null, validityDays: input.validityDays, sufficiencyDetail: null as string | null };
  if (input.completedAtRaw === null || input.completedAtRaw === undefined || input.completedAtRaw === "") {
    return { ...empty, status: "unverifiable", reason: `the previous ${label} result has no completion date` };
  }
  const completed = parseCompletionDate(input.completedAtRaw);
  if (!completed) return { ...empty, status: "unverifiable", reason: `the previous ${label} result has an invalid completion date` };
  const completedAt = completed.toISOString();
  if (completed.getTime() > input.now.getTime()) {
    return { ...empty, completedAt, status: "unverifiable", reason: `the previous ${label} result has a completion date in the future` };
  }
  if (input.validityDays === null) {
    return { ...empty, completedAt, status: "not_configured", reason: `the RTO has not set how long ${label} results remain valid` };
  }
  const validUntil = new Date(completed.getTime() + input.validityDays * DAY_MS);
  const dated = { ...empty, completedAt, validUntil: validUntil.toISOString() };
  if (input.asOf.getTime() >= validUntil.getTime()) {
    return { ...dated, status: "expired", reason: `the previous ${label} result is older than the RTO's ${input.validityDays}-day validity period` };
  }
  const readiness = courseReadiness(input.course, input.type);
  if (!readiness.ready) return { ...dated, status: "unverifiable", reason: readiness.reason };
  if (input.sufficiency.sufficient === null) return { ...dated, status: "unverifiable", reason: input.sufficiency.detail };
  if (!input.sufficiency.sufficient) {
    return { ...dated, sufficiencyDetail: input.sufficiency.detail, status: "insufficient", reason: `the previous ${label} result does not meet the current requirements for this course` };
  }
  return { ...dated, sufficiencyDetail: input.sufficiency.detail, status: "valid", reason: `the ${label} result is within the RTO's ${input.validityDays}-day validity period and meets the current requirements for this course` };
}

// ── Choosing the result to evaluate ──────────────────────────────────────────

export interface LearnerInvitation {
  id: string;
  organisation_id?: string | null;
  status?: string | null;
  lln_status?: string | null;
  digital_status?: string | null;
  lln_token?: string | null;
  digital_token?: string | null;
  lln_completed_at?: string | null;
  digital_completed_at?: string | null;
  completed_at?: string | null;
  created_at?: string | null;
  lln_acsf_outcomes?: unknown;
  digital_score?: number | null;
}

/**
 * The most recent attempt of this module counts (a later attempt supersedes
 * an earlier one). Ordered by the module's own completion date; attempts
 * with an unusable date still surface (and are then rejected as
 * unverifiable rather than silently skipped).
 */
export function latestCompletedResult<T extends LearnerInvitation>(rows: T[], type: AssessmentType, organisationId: string): T | null {
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

// ── Decisions ────────────────────────────────────────────────────────────────

/**
 * sent     — a new assessment invitation is issued
 * active   — an assessment invitation is already open
 * existing — a previous result is reused (all checks passed)
 * completed — the assessment issued for this enrolment was completed; its
 *             outcome stands and is never reissued automatically
 * review   — held for RTO review; nothing reused, nothing issued
 */
export type Action = "sent" | "active" | "existing" | "completed" | "review" | "none";

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
  latest: LearnerInvitation | null;
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
  created_at?: string | null;
  decision_at?: string | null;
  validated_at?: string | null;
  validity_fingerprint?: string | null;
  validity_checks?: Array<{ type?: string; own?: boolean; invitation_id?: string | null; valid_until?: string | null }> | null;
  outcome_signature?: string | null;
  note_written?: boolean | null;
  note_text?: string | null;
}

/**
 * What an existing enrolment's decision depends on in the course: which
 * course, which mapping approval, and the ACSF levels. The RTO's validity
 * period is deliberately excluded: a changed period applies to new
 * enrolments, not to decisions already made.
 */
export function validityFingerprint(course: CourseContext, llnRequired: boolean, digitalRequired: boolean): string {
  return [
    `need=${llnRequired ? "L" : ""}${digitalRequired ? "D" : ""}`,
    `course=${course.qualificationId ?? "unknown"}`,
    `approval=${course.approval.approved ? course.approval.approvalId : "none"}`,
    `reqs=${normaliseRequirements(course.requirements)}`,
  ].join(";");
}

/**
 * new             — no previous record: a fresh decision for a new enrolment.
 * stand           — a validated decision for this (existing) enrolment, with
 *                   no relevant course change: kept as it is. Time passing
 *                   and routine repeated events never reopen it.
 * resolve_hold    — held for review earlier: re-checked as at the original
 *                   decision time, so it can proceed once the cause is fixed.
 * recheck_existing — recorded before validity checks, or the course changed
 *                   since: re-checked as at the original decision time;
 *                   anything that no longer passes is held for review, never
 *                   reassessed automatically.
 * Until exact enrolment identification exists, a repeated event for the same
 * contact, modules and course is treated as the same enrolment.
 */
export type PlanMode = "new" | "stand" | "resolve_hold" | "recheck_existing";

export function planForPreviousLog(log: PreviousLog | null, now: Date, fingerprint: string): { mode: PlanMode; asOf: Date; reason: string } {
  if (!log) return { mode: "new", asOf: now, reason: "no previous decision for this enrolment" };
  const original = parseCompletionDate(log.decision_at) ?? parseCompletionDate(log.created_at) ?? now;
  const asOf = original.getTime() > now.getTime() ? now : original;
  if (log.status === "review_required") return { mode: "resolve_hold", asOf, reason: "held for review" };
  if (!log.validated_at) return { mode: "recheck_existing", asOf, reason: "recorded before validity checks" };
  if (log.validity_fingerprint !== fingerprint) return { mode: "recheck_existing", asOf, reason: "the course, its mapping approval or its ACSF levels changed" };
  return { mode: "stand", asOf, reason: "validated for this enrolment" };
}

/**
 * For each module, the invitation this sync issued for this enrolment (if
 * any). Recorded per module, so reassessing one module never loses track of
 * the other module's own assessment.
 */
export function ownInvitations(log: PreviousLog | null): Map<AssessmentType, string> {
  const out = new Map<AssessmentType, string>();
  if (!log) return out;
  for (const c of log.validity_checks ?? []) {
    if (c?.own && c.invitation_id && (c.type === "lln" || c.type === "digital")) out.set(c.type, c.invitation_id);
  }
  // Entries written before per-module tracking.
  if (log.invitation_id) {
    if (!out.has("lln") && log.lln_invitation_id === log.invitation_id) out.set("lln", log.invitation_id);
    if (!out.has("digital") && log.digital_invitation_id === log.invitation_id) out.set("digital", log.invitation_id);
  }
  return out;
}

/** Whether a final decision's invitation was issued by this sync for this enrolment. */
export function isOwnDecision(d: Decision, previous: Map<AssessmentType, string>, newInvitationId: string | null): boolean {
  if (!d.invitationId) return false;
  if (d.action === "sent") return d.invitationId === newInvitationId;
  return previous.get(d.type) === d.invitationId;
}

/** Stable description of the outcome; the aXcelerate note is written only when this changes. */
export function outcomeSignature(decisions: Decision[]): string {
  return decisions
    .filter((d) => d.action !== "none")
    // The enrolment's own completed assessment is identified by its
    // invitation alone, so the passing of time never changes the outcome.
    .map((d) => `${d.type}:${d.action}:${d.invitationId ?? ""}:${d.action === "completed" ? "" : d.check?.status ?? ""}`)
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

/**
 * Decides LLN and Digital for one contact and one enrolment. Each module is
 * decided independently, so a module that remains current and sufficient is
 * preserved when the other needs reassessment. `digitalPassMarks` holds the
 * pass mark of the Digital assessment sat on each invitation (by id).
 */
export function planAssessments(input: {
  organisationId: string;
  llnRequired: boolean;
  digitalRequired: boolean;
  invitations: LearnerInvitation[];
  previousLog: PreviousLog | null;
  mode: PlanMode;
  asOf: Date;
  policy: ValidityPolicy;
  course: CourseContext;
  digitalPassMarks: Record<string, number | null>;
  now: Date;
}): Decision[] {
  const own = ownInvitations(input.previousLog);
  const invitations = input.invitations.filter((i) => i.organisation_id === input.organisationId);
  const decisions: Decision[] = [];
  for (const type of ["lln", "digital"] as AssessmentType[]) {
    const required = type === "lln" ? input.llnRequired : input.digitalRequired;
    const tokenKey = type === "lln" ? "lln_token" : "digital_token";
    const statusKey = type === "lln" ? "lln_status" : "digital_status";
    const evaluate = (inv: LearnerInvitation) => evaluateResult({
      type,
      completedAtRaw: type === "lln" ? inv.lln_completed_at : inv.digital_completed_at,
      validityDays: policyDays(input.policy, type),
      course: input.course,
      sufficiency: type === "lln"
        ? checkLlnSufficiency(inv.lln_acsf_outcomes, input.course.requirements)
        : checkDigitalSufficiency(inv.digital_score, input.digitalPassMarks[inv.id] ?? null),
      asOf: input.asOf,
      now: input.now,
    });

    if (required && own.has(type)) {
      // The assessment issued for this enrolment. Its outcome stands: it is
      // never reissued because time has passed or because it fell short —
      // that is for the RTO to follow up.
      const ownId = own.get(type) as string;
      const inv = invitations.find((i) => i.id === ownId);
      if (inv) {
        const open = inv[statusKey] !== "completed";
        decisions.push({ type, action: open ? "active" : "completed", invitationId: ownId, check: open ? null : evaluate(inv) });
        continue;
      }
      // Own invitation no longer visible: decide afresh below.
    }

    const active = invitations.find((i) => ["sent", "opened", "in_progress"].includes(i.status ?? "") &&
      !!i[tokenKey] && i[statusKey] !== "completed");
    const latest = active ? null : latestCompletedResult(invitations, type, input.organisationId);
    const check = required && latest ? evaluate(latest) : null;
    let decision = decide({ type, required, activeInvitationId: active?.id ?? null, latest, check });
    // An existing enrolment is never reassessed automatically: a decision
    // that no longer passes is held for the RTO to review.
    if (input.mode === "recheck_existing" && decision.action === "sent") {
      decision = {
        type, action: "review", invitationId: latest?.id ?? null,
        check: check
          ? { ...check, status: "unverifiable", reason: `this enrolment was accepted earlier, but on re-checking ${check.reason}` }
          : { status: "unverifiable", reason: "this enrolment was accepted earlier, but no supporting result could be found on re-checking", completedAt: null, validUntil: null, validityDays: null, sufficiencyDetail: null },
      };
    }
    decisions.push(decision);
  }
  return decisions;
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

// ── Contact note (initial summary) ───────────────────────────────────────────

function fmtDate(iso: string | null, timezone: string): string {
  if (!iso) return "unknown date";
  return new Date(iso).toLocaleDateString("en-AU", { day: "numeric", month: "long", year: "numeric", timeZone: timezone });
}

const MODULE_NAME: Record<AssessmentType, string> = { lln: "LLN", digital: "Digital Skills" };

/**
 * One concise initial summary. Positive wording ("meet the current LLND
 * requirements") is used only when every check passed. The note covers LLND
 * assessment status only — not payment, admission or enrolment acceptance.
 */
export function buildInboundNote(params: {
  contactName: string;
  courseName: string | null;
  decisions: Decision[];
  now: Date;
  timezone: string;
}): string {
  const tz = params.timezone;
  const active = params.decisions.filter((d) => d.action !== "none");
  const lines = [
    "LLND Automate — LLND assessment status",
    `Contact: ${params.contactName}`,
    `Course: ${params.courseName ?? "not identified from the aXcelerate enrolment"}`,
    `Date: ${fmtDate(params.now.toISOString(), tz)}`,
  ];
  if (active.length === 0) {
    lines.push("No LLND assessment is required.");
    return lines.join("\n");
  }
  const allMet = active.every((d) => (d.action === "existing" || d.action === "completed") && d.check?.status === "valid");
  if (allMet) lines.push("Existing LLND assessment results have been reviewed and meet the current LLND requirements for this course.");
  for (const d of active) {
    const name = MODULE_NAME[d.type];
    const c = d.check;
    switch (d.action) {
      case "existing":
      case "completed":
        if (c?.status === "valid") {
          lines.push(`- ${name}: completed ${fmtDate(c.completedAt, tz)}; within the RTO's ${c.validityDays}-day validity period (until ${fmtDate(c.validUntil, tz)}); ${c.sufficiencyDetail}.`);
        } else {
          lines.push(`- ${name}: assessment completed for this enrolment; the result is recorded in LLND Automate for RTO follow-up.`);
        }
        break;
      case "active":
        lines.push(`- ${name}: assessment invitation already open. No new invitation issued.`);
        break;
      case "sent":
        if (c?.status === "expired") {
          lines.push(`- ${name}: reassessment required — previous result (completed ${fmtDate(c.completedAt, tz)}) is outside the RTO's ${c.validityDays}-day validity period. New invitation issued.`);
        } else if (c?.status === "insufficient") {
          lines.push(`- ${name}: reassessment required — previous result does not meet the current requirements for this course (${c.sufficiencyDetail}). New invitation issued.`);
        } else {
          lines.push(`- ${name}: no previous result. Assessment invitation issued.`);
        }
        break;
      case "review":
        lines.push(`- ${name}: LLND requirements not yet confirmed — pending RTO review because ${c?.reason ?? "the previous result could not be verified"}. No result has been reused and no new invitation has been issued.`);
        break;
    }
  }
  lines.push("This note records LLND assessment status only.");
  return lines.join("\n");
}
