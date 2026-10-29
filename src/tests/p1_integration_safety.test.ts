import { describe, expect, it } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import { ENROLMENT_EVENT_TYPES, enrolmentDecision } from '../../supabase/functions/_shared/enrolment-policy';
import { STAFF_REVIEW_OUTCOMES, computeCompletionOutcome, type CompletionCourse } from '../../supabase/functions/_shared/completion-outcome';

// P1 critical integration safety fixes:
//  1. No aXcelerate enrolment is ever created for an invitation or completion.
//  2. Completion outcomes compare results with the course's APPROVED ACSF
//     requirements (no fallback level) and refer shortfalls to RTO staff.

const repo = (p: string) => path.resolve(__dirname, '../..', p);
const read = (p: string) => fs.readFileSync(repo(p), 'utf8');
const queue = read('supabase/functions/process-axcelerate-queue/index.ts');
const sync = read('supabase/functions/axcelerate-sync/index.ts');
const complete = read('supabase/functions/on-assessment-complete/index.ts');
const migration = read('supabase/migrations/20261029100000_completion_requirements_not_confirmed.sql');

function allFunctionSources(): Array<[string, string]> {
  const dir = repo('supabase/functions');
  const out: Array<[string, string]> = [];
  const walk = (d: string) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p);
      else if (e.name.endsWith('.ts')) out.push([path.relative(dir, p), fs.readFileSync(p, 'utf8')]);
    }
  };
  walk(dir);
  return out;
}

describe('1. no automatic aXcelerate enrolment', () => {
  it('no Edge Function searches course instances or calls the enrol endpoint', () => {
    const offenders = allFunctionSources()
      .filter(([, src]) => /course\/instance\/search|\/course\/enrol\b/.test(src))
      .map(([f]) => f);
    expect(offenders).toEqual([]);
  });
  it('manual invitation (no linked enrolment): nothing is enrolled, and the reason is recorded', () => {
    const d = enrolmentDecision({ eventType: 'invitation_sent', axcelerateEnrolmentId: null, axcelerateCourseId: 1234 });
    expect(d.action).toBe('none');
    expect(d.reason).toContain('no exact aXcelerate enrolment is linked');
    expect(d.log).toMatchObject({ skipped: true, event_type: 'invitation_sent', axcelerate_course_id: 1234, exact_enrolment_linked: false });
  });
  it('assessment completion: nothing is enrolled or progressed', () => {
    expect(enrolmentDecision({ eventType: 'assessment_completed', axcelerateCourseId: 1234 }).action).toBe('none');
    expect(enrolmentDecision({ eventType: 'quiz_sent' }).action).toBe('none');
  });
  it('missing enrolment ID never leads to choosing an instance', () => {
    for (const id of [null, undefined, '']) {
      const d = enrolmentDecision({ eventType: 'assessment_completed', axcelerateEnrolmentId: id as null, axcelerateCourseId: 99 });
      expect(d).toMatchObject({ action: 'none' });
      expect(d.log).toMatchObject({ exact_enrolment_linked: false });
    }
  });
  it('even with an exact enrolment ID, progression is not enabled yet', () => {
    const d = enrolmentDecision({ eventType: 'assessment_completed', axcelerateEnrolmentId: 'E-1', axcelerateCourseId: 99 });
    expect(d.action).toBe('none');
    expect(d.reason).toContain('enrolment progression is not enabled');
  });
  it('repeat processing of the same job gives the same no-enrolment decision', () => {
    const input = { eventType: 'invitation_sent', axcelerateEnrolmentId: null, axcelerateCourseId: 5 };
    expect(enrolmentDecision(input)).toEqual(enrolmentDecision(input));
  });
  it('events that never touched enrolment write no enrolment log', () => {
    expect(enrolmentDecision({ eventType: 'intervention_required' }).log).toBeNull();
    expect([...ENROLMENT_EVENT_TYPES]).toEqual(['invitation_sent', 'quiz_sent', 'assessment_completed']);
  });
  it('both write-back paths use the policy and log the decision', () => {
    expect(queue).toContain('const enrolment = enrolmentDecision({');
    expect(queue).toContain('if (enrolment.log) await logCall("enrol", enrolment.log, null, "success");');
    expect(sync).toContain('const enrolment = enrolmentDecision({');
    expect(sync).toContain('if (enrolment.log) await logSync("enrol", enrolment.log, null, "success");');
  });
  it('the decision is logged with a sync type the database accepts', () => {
    expect(queue).not.toContain('logCall("enrol_skipped"');
    expect(queue).not.toContain('logCall("course_instance_search"');
    expect(sync).not.toContain('logSync("course_instance_search"');
  });
  it('legitimate notes and reports still run for invitations and completions', () => {
    expect(queue).toContain('const noteText = buildNote(');
    expect(queue).toContain('if (job.event_type === "assessment_completed") {');
    expect(sync).toContain('// 3. Load supporting data for the note');
  });
  it('cross-RTO: the queue only processes jobs for the integration RTO', () => {
    expect(queue).toMatch(/from\("axcelerate_writeback_queue"\)\s*\.select\([\s\S]{0,600}?\.eq\("organisation_id", integrationOrganisationId\)/);
  });
});

const REQS = [
  { domain: 'literacy', acsf_skill: 'Reading', minimum_acsf_level: 3 },
  { domain: 'literacy', acsf_skill: 'Writing', minimum_acsf_level: 2 },
  { domain: 'language', acsf_skill: 'Oral Communication', minimum_acsf_level: 2 },
  { domain: 'numeracy', acsf_skill: 'Numeracy', minimum_acsf_level: 2 },
  { domain: 'literacy', acsf_skill: 'Learning', minimum_acsf_level: 2 },
  { domain: 'digital', acsf_skill: 'Digital Literacy', minimum_acsf_level: 2 },
];
const COURSE: CompletionCourse = {
  qualificationId: 'q1', sameOrganisation: true, requirements: REQS,
  approval: { approved: true, reason: '', approvalId: 'a1' },
};
const MEETS = { reading: 3, writing: 3, oral_communication: 3, numeracy: 3, learning: 3 };
const outcome = (o: Partial<Parameters<typeof computeCompletionOutcome>[0]> = {}) => computeCompletionOutcome({
  llnOutcomes: MEETS, llnCompleted: true, digitalScore: 80, digitalCompleted: true, digitalPassMark: 60, course: COURSE, ...o,
});

describe('2. completion compares results with approved course requirements', () => {
  it('a learner at Level 2 against a course requiring Level 3 is below requirement and referred to staff', () => {
    const r = outcome({ llnOutcomes: { ...MEETS, reading: 2 } });
    expect(r.recommendation).toBe('suitable_with_support');
    expect(r.reasons).toContain('Reading: ACSF Level 2 (required 3) — minor gap');
    expect(r.riskFlags).toEqual([{ skill: 'reading', studentLevel: 2, requiredLevel: 3, gap: 1 }]);
    expect(STAFF_REVIEW_OUTCOMES).toContain(r.recommendation);
  });
  it('the support-case trigger fires for exactly the staff-review outcomes', () => {
    const fn = migration.slice(migration.indexOf('CREATE OR REPLACE FUNCTION public.create_support_case_from_outcome()'));
    const list = fn.match(/course_recommendation IN \(([^)]*)\)/)![1].split(',').map(s => s.trim().replace(/'/g, ''));
    expect(list.sort()).toEqual([...STAFF_REVIEW_OUTCOMES].sort());
    expect(fn).toContain('VALUES (NEW.organisation_id, NEW.id, NEW.student_id)');
    expect(fn).toContain('ON CONFLICT (invitation_id) DO NOTHING');
  });
  it('the old mismatch is fixed: requirements are matched by ACSF skill, not domain', () => {
    // Before: "literacy" never matched "reading", so Level 2 was assumed for every skill.
    expect(outcome({ llnOutcomes: { ...MEETS, reading: 2, writing: 2 } }).recommendation).toBe('suitable_with_support');
    expect(outcome().recommendation).toBe('suitable');
  });
  it('gap rules: one significant gap with another gap → not yet suitable', () => {
    const r = outcome({ llnOutcomes: { ...MEETS, reading: 1, numeracy: 1 } });
    expect(r.recommendation).toBe('not_yet_suitable');
  });
  it('meeting every approved requirement → suitable', () => {
    expect(outcome().recommendation).toBe('suitable');
  });
  it('no approved mapping → requirements not confirmed, never suitable (no Level 2 fallback)', () => {
    const r = outcome({ course: { ...COURSE, approval: { approved: false, reason: "the course's ACSF mapping has not been approved by the RTO", approvalId: null } } });
    expect(r.recommendation).toBe('requirements_not_confirmed');
    expect(STAFF_REVIEW_OUTCOMES).toContain(r.recommendation);
    expect(r.reasons.join(' ')).toContain('not been approved');
  });
  it('no LLN requirements recorded → requirements not confirmed', () => {
    expect(outcome({ course: { ...COURSE, requirements: [REQS[5]] } }).recommendation).toBe('requirements_not_confirmed');
  });
  it('course not identified, or belonging to another RTO → requirements not confirmed', () => {
    expect(outcome({ course: { ...COURSE, qualificationId: null } }).recommendation).toBe('requirements_not_confirmed');
    const r = outcome({ course: { ...COURSE, sameOrganisation: false } });
    expect(r.recommendation).toBe('requirements_not_confirmed');
    expect(r.reasons.join(' ')).toContain('does not belong to this RTO');
  });
  it('a required skill with no result → staff review, not suitable', () => {
    const { learning: _l, ...rest } = MEETS;
    expect(outcome({ llnOutcomes: rest }).recommendation).toBe('requirements_not_confirmed');
  });
  it('Digital uses the configured pass mark of the assessment sat (no 50/70 bands)', () => {
    expect(outcome({ digitalScore: 59, digitalPassMark: 60 }).recommendation).toBe('not_yet_suitable');
    expect(outcome({ digitalScore: 60, digitalPassMark: 60 }).recommendation).toBe('suitable');
    expect(outcome({ digitalScore: 55, digitalPassMark: 50 }).recommendation).toBe('suitable');
  });
  it('a missing Digital pass mark or score → requirements not confirmed', () => {
    expect(outcome({ digitalPassMark: null }).recommendation).toBe('requirements_not_confirmed');
    expect(outcome({ digitalScore: null }).recommendation).toBe('requirements_not_confirmed');
  });
  it('a module that was not taken is not judged', () => {
    expect(outcome({ digitalCompleted: false, digitalScore: null }).recommendation).toBe('suitable');
    expect(outcome({ llnCompleted: false, llnOutcomes: null }).recommendation).toBe('suitable');
  });
  it('nothing completed → staff review, never suitable', () => {
    expect(outcome({ llnCompleted: false, digitalCompleted: false }).recommendation).toBe('requirements_not_confirmed');
  });
});

describe('2. completion function wiring', () => {
  it('uses only the approved mapping of the learner’s own RTO; the fallbacks are gone', () => {
    expect(complete).toContain('computeCompletionOutcome({');
    expect(complete).toContain('mappingApprovalState({');
    expect(complete).toMatch(/from\("qualification_mapping_approvals"\)[\s\S]{0,200}eq\("organisation_id", inv\.organisation_id\)/);
    expect(complete).not.toContain('DEFAULT_MIN_LEVEL');
    expect(complete).not.toContain('qualification_mapping_library');
    expect(complete).not.toMatch(/digitalScore < (50|70)/);
  });
  it('reads the Digital pass mark of the assessment the learner sat', () => {
    expect(complete).toContain('select("assessments(type, pass_threshold)")');
  });
  it('is idempotent: records an outcome only once', () => {
    expect(complete).toContain('if (inv.course_recommendation) {');
    expect(complete).toContain('.is("course_recommendation", null)');
  });
  it('preserves the completed result and does not reissue or enrol', () => {
    expect(complete).not.toMatch(/update\(\{[^}]*(lln_acsf_outcomes|digital_score|lln_completed_at|digital_completed_at)/);
    expect(complete).not.toMatch(/from\("assessment_invitations"\)\s*\.insert/);
    expect(complete).not.toContain('event_type: "invitation_sent"');
    expect(complete).not.toMatch(/course\/enrol|instance\/search/);
  });
  it('the migration allows the new outcome without seeding or changing results', () => {
    expect(migration).toContain("'suitable', 'suitable_with_support', 'not_yet_suitable', 'requirements_not_confirmed'");
    expect(migration).not.toMatch(/UPDATE public\.assessment_invitations/i);
  });
});
