// Completion outcome for a finished LLND assessment.
//
// Pure functions (no Deno or Supabase imports) so the Edge Function and the
// project's Vitest suite use the same rules.
//
// - LLN: each required ACSF core skill on the course's APPROVED mapping is
//   compared with the learner's result for that same skill (requirements
//   store the skill in `acsf_skill`; results are keyed "reading",
//   "oral_communication", …). No fallback level is ever used.
// - Digital: the score is compared with the configured pass mark of the
//   Digital assessment the learner sat. No fixed bands.
// - When the approved requirements or pass mark can't be established, the
//   outcome is "requirements_not_confirmed": never "suitable". It is
//   referred to RTO staff for review like any other support outcome.
// - The result itself is never changed, and nothing here reissues an
//   assessment or changes an enrolment.

import { llnRequirements, skillKey, type MappingApproval, type QualificationRequirement } from "./result-validity.ts";

export type CompletionRecommendation =
  | "suitable"
  | "suitable_with_support"
  | "not_yet_suitable"
  | "requirements_not_confirmed";

/** Outcomes that open a support case for RTO staff review. */
export const STAFF_REVIEW_OUTCOMES: CompletionRecommendation[] = ["suitable_with_support", "not_yet_suitable", "requirements_not_confirmed"];

export interface CompletionCourse {
  /** The qualification belongs to the learner's own RTO. */
  qualificationId: string | null;
  sameOrganisation: boolean;
  approval: MappingApproval;
  requirements: QualificationRequirement[];
}

export interface RiskFlag {
  skill: string;
  studentLevel: number;
  requiredLevel: number;
  gap: number;
}

export interface CompletionOutcome {
  recommendation: CompletionRecommendation;
  reasons: string[];
  riskFlags: RiskFlag[];
  llnStatus: "met" | "minor_gap" | "below" | "not_confirmed" | "not_taken";
  digitalStatus: "met" | "below" | "not_confirmed" | "not_taken";
}

const LABEL: Record<string, string> = {
  reading: "Reading", writing: "Writing", numeracy: "Numeracy",
  oral_communication: "Oral Communication", learning: "Learning",
};

function scoresOf(outcomes: unknown): Record<string, number> {
  const out: Record<string, number> = {};
  if (outcomes && typeof outcomes === "object" && !Array.isArray(outcomes)) {
    for (const [k, v] of Object.entries(outcomes as Record<string, unknown>)) {
      if (typeof v === "number" && Number.isFinite(v)) out[skillKey(k)] = v;
    }
  }
  return out;
}

function courseProblem(course: CompletionCourse): string | null {
  if (!course.qualificationId) return "the course for this assessment is not identified";
  if (!course.sameOrganisation) return "the course does not belong to this RTO";
  if (!course.approval.approved) return course.approval.reason || "the course's ACSF mapping has not been approved by the RTO";
  return null;
}

export function computeCompletionOutcome(input: {
  llnOutcomes: unknown;
  llnCompleted: boolean;
  digitalScore: unknown;
  digitalCompleted: boolean;
  digitalPassMark: number | null;
  course: CompletionCourse;
}): CompletionOutcome {
  const reasons: string[] = [];
  const riskFlags: RiskFlag[] = [];
  let llnStatus: CompletionOutcome["llnStatus"] = "not_taken";
  let digitalStatus: CompletionOutcome["digitalStatus"] = "not_taken";

  // ── LLN ──
  if (input.llnCompleted) {
    const scores = scoresOf(input.llnOutcomes);
    const problem = courseProblem(input.course);
    const required = llnRequirements(input.course.requirements);
    if (Object.keys(scores).length === 0) {
      llnStatus = "not_confirmed";
      reasons.push("LLN: no ACSF levels were recorded for the completed assessment — RTO review required");
    } else if (problem) {
      llnStatus = "not_confirmed";
      reasons.push(`LLN: requirements not confirmed because ${problem} — RTO review required`);
    } else if (required.length === 0) {
      llnStatus = "not_confirmed";
      reasons.push("LLN: no LLN requirements are recorded on the course's approved mapping — RTO review required");
    } else {
      let minor = 0, significant = 0, missing = 0;
      for (const r of required) {
        const achieved = scores[r.skill];
        const label = LABEL[r.skill] ?? r.label;
        if (achieved === undefined) {
          missing++;
          reasons.push(`${label}: no result recorded (required ACSF Level ${r.level}) — RTO review required`);
          continue;
        }
        const gap = r.level - achieved;
        if (gap > 0) {
          riskFlags.push({ skill: r.skill, studentLevel: achieved, requiredLevel: r.level, gap });
          if (gap === 1) { minor++; reasons.push(`${label}: ACSF Level ${achieved} (required ${r.level}) — minor gap`); }
          else { significant++; reasons.push(`${label}: ACSF Level ${achieved} (required ${r.level}) — significant gap`); }
        }
      }
      // Same gap rules as before, now against the real requirement.
      if (significant >= 2 || (significant >= 1 && minor >= 1)) llnStatus = "below";
      else if (significant === 1 || minor >= 1) llnStatus = "minor_gap";
      else if (missing > 0) llnStatus = "not_confirmed";
      else llnStatus = "met";
    }
  }

  // ── Digital ──
  if (input.digitalCompleted) {
    const score = typeof input.digitalScore === "number" && Number.isFinite(input.digitalScore) ? input.digitalScore : null;
    const passMark = typeof input.digitalPassMark === "number" && Number.isFinite(input.digitalPassMark) ? input.digitalPassMark : null;
    if (score === null) {
      digitalStatus = "not_confirmed";
      reasons.push("Digital: no score was recorded for the completed assessment — RTO review required");
    } else if (passMark === null) {
      digitalStatus = "not_confirmed";
      reasons.push(`Digital: score ${score}% recorded, but the assessment's pass mark could not be found — RTO review required`);
    } else if (score < passMark) {
      digitalStatus = "below";
      reasons.push(`Digital: score ${score}% is below the assessment's pass mark of ${passMark}%`);
    } else {
      digitalStatus = "met";
    }
  }

  let recommendation: CompletionRecommendation;
  if (llnStatus === "below" || digitalStatus === "below") recommendation = "not_yet_suitable";
  else if (llnStatus === "not_confirmed" || digitalStatus === "not_confirmed") recommendation = "requirements_not_confirmed";
  else if (llnStatus === "minor_gap") recommendation = "suitable_with_support";
  else if (llnStatus === "not_taken" && digitalStatus === "not_taken") {
    recommendation = "requirements_not_confirmed";
    reasons.push("No completed LLN or Digital result was found — RTO review required");
  } else recommendation = "suitable";

  if (recommendation === "suitable") reasons.push("All assessed skills meet the course's approved requirements");
  return { recommendation, reasons, riskFlags, llnStatus, digitalStatus };
}
