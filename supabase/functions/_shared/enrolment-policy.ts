// aXcelerate enrolment policy for LLND write-backs.
//
// LLND Automate never creates or changes an aXcelerate enrolment because an
// assessment invitation or completion happened. The former behaviour —
// search the course's instances and enrol the learner in the first one
// returned — has been removed: it could create duplicate or wrong
// enrolments and progressed learners without any requirement check.
//
// Optional progression of an EXISTING enrolment is a separate, not yet
// approved feature. It will need the exact aXcelerate enrolment ID and a
// per-RTO setting; until then this policy always returns "none".

export const ENROLMENT_EVENT_TYPES = ["invitation_sent", "quiz_sent", "assessment_completed"] as const;

export interface EnrolmentDecision {
  action: "none";
  reason: string;
  /** Recorded in axcelerate_sync_log (sync_type "enrol") so the decision is traceable. */
  log: Record<string, unknown> | null;
}

export function enrolmentDecision(input: {
  eventType: string;
  axcelerateEnrolmentId?: string | number | null;
  axcelerateCourseId?: string | number | null;
}): EnrolmentDecision {
  if (!(ENROLMENT_EVENT_TYPES as readonly string[]).includes(input.eventType)) {
    return { action: "none", reason: "event does not affect enrolment", log: null };
  }
  const exact = input.axcelerateEnrolmentId !== null && input.axcelerateEnrolmentId !== undefined && String(input.axcelerateEnrolmentId) !== "";
  const reason = exact
    ? "enrolment progression is not enabled; the existing aXcelerate enrolment was not changed"
    : "no exact aXcelerate enrolment is linked; LLND Automate does not create or choose an enrolment";
  return {
    action: "none",
    reason,
    log: {
      skipped: true,
      event_type: input.eventType,
      reason,
      axcelerate_course_id: input.axcelerateCourseId ?? null,
      exact_enrolment_linked: exact,
    },
  };
}
