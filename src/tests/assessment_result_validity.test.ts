import { describe, expect, it } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import {
  buildInboundNote, checkDigitalSufficiency, checkLlnSufficiency, courseReadiness, escapeLike, evaluateResult,
  latestCompletedResult, matchStudent, outcomeSignature, ownInvitations, parseValidityPolicy, planAssessments,
  planForPreviousLog, shouldWriteNote, skillKey, validityFingerprint,
  type CourseContext, type Decision, type LearnerInvitation, type PreviousLog, type StudentRow,
} from '../../supabase/functions/_shared/result-validity';

// Assessment-result validity and safe reuse (P0). Numbers in the describe
// titles refer to the Product Owner's required test cases.

const DAY = 86_400_000;
const ORG = 'org-1';
const OTHER = 'org-2';
const NOW = new Date('2026-10-29T00:00:00.000Z');
const daysAgo = (n: number, ms = 0) => new Date(NOW.getTime() - n * DAY - ms).toISOString();
const COURSE: CourseContext = {
  qualificationId: 'q-cert3',
  mappingStatus: 'custom_mapping',
  mappingReviewedAt: daysAgo(30),
  requirements: [
    { domain: 'literacy', acsf_skill: 'Reading', minimum_acsf_level: 3 },
    { domain: 'language', acsf_skill: 'Oral Communication', minimum_acsf_level: 2 },
    { domain: 'numeracy', acsf_skill: 'Numeracy', minimum_acsf_level: 2 },
    { domain: 'digital', acsf_skill: 'Digital Literacy', minimum_acsf_level: 2 },
  ],
};
const GOOD_LLN = { reading: 3, writing: 3, numeracy: 3, oral_communication: 3, learning: 3 };
const POLICY = { lln_days: 365, digital_days: 180 };

function completed(overrides: Partial<LearnerInvitation> = {}): LearnerInvitation {
  return {
    id: 'inv-old', organisation_id: ORG, status: 'completed',
    lln_status: 'completed', lln_token: 't1', lln_completed_at: daysAgo(100), lln_acsf_outcomes: GOOD_LLN,
    digital_status: 'completed', digital_token: 't2', digital_completed_at: daysAgo(100), digital_score: 80,
    completed_at: daysAgo(100), created_at: daysAgo(101),
    ...overrides,
  };
}

function plan(opts: {
  invitations?: LearnerInvitation[]; previousLog?: PreviousLog | null; policy?: { lln_days: number | null; digital_days: number | null };
  lln?: boolean; digital?: boolean; course?: Partial<CourseContext>; now?: Date; passMarks?: Record<string, number | null>;
}): Decision[] {
  return planAssessments({
    organisationId: ORG,
    llnRequired: opts.lln ?? true,
    digitalRequired: opts.digital ?? true,
    invitations: opts.invitations ?? [completed()],
    previousLog: opts.previousLog ?? null,
    policy: opts.policy ?? POLICY,
    course: { ...COURSE, ...(opts.course ?? {}) },
    digitalPassMarks: opts.passMarks ?? { 'inv-old': 50 },
    now: opts.now ?? NOW,
  });
}
const of = (d: Decision[], type: 'lln' | 'digital') => d.find(x => x.type === type)!;
const note = (decisions: Decision[], courseName: string | null = 'BSB30120 Certificate III in Business') =>
  buildInboundNote({ contactName: 'Ana Li', courseName, decisions, now: NOW, timezone: 'Australia/Sydney' });

describe('validity setting', () => {
  it('accepts whole days from 1 to 3650 and treats anything else as not configured', () => {
    expect(parseValidityPolicy({ lln_days: 365, digital_days: 1 })).toEqual({ lln_days: 365, digital_days: 1 });
    expect(parseValidityPolicy({ lln_days: 3650, digital_days: 3651 })).toEqual({ lln_days: 3650, digital_days: null });
    for (const bad of [0, -1, 1.5, '30', null, undefined, true]) expect(parseValidityPolicy({ lln_days: bad }).lln_days).toBeNull();
    expect(parseValidityPolicy(['365'])).toEqual({ lln_days: null, digital_days: null });
  });
  it('has no default period', () => {
    expect(parseValidityPolicy({})).toEqual({ lln_days: null, digital_days: null });
    expect(parseValidityPolicy(null)).toEqual({ lln_days: null, digital_days: null });
  });
});

describe('1–3. inside, outside and at the validity boundary', () => {
  const evalAt = (completedAt: string, days: number) => evaluateResult({
    type: 'lln', completedAtRaw: completedAt, validityDays: days, course: COURSE,
    sufficiency: { sufficient: true, detail: 'ok' }, now: NOW,
  });
  it('1. a result inside the period is reused', () => {
    expect(evalAt(daysAgo(100), 365).status).toBe('valid');
    expect(of(plan({}), 'lln').action).toBe('existing');
  });
  it('2. a result outside the period is reassessed', () => {
    expect(evalAt(daysAgo(400), 365).status).toBe('expired');
    expect(of(plan({ invitations: [completed({ lln_completed_at: daysAgo(400) })] }), 'lln').action).toBe('sent');
  });
  it('3. valid 1 ms before the end; expired exactly at the end and after', () => {
    expect(evalAt(daysAgo(365, -1), 365).status).toBe('valid');
    expect(evalAt(daysAgo(365), 365).status).toBe('expired');
    expect(evalAt(daysAgo(365, 1), 365).status).toBe('expired');
  });
  it('reports the end of the validity period', () => {
    expect(evalAt(daysAgo(10), 30).validUntil).toBe(new Date(NOW.getTime() + 20 * DAY).toISOString());
  });
});

describe('4. missing, malformed and future completion dates', () => {
  it.each([
    ['missing', null, 'no completion date'],
    ['empty', '', 'no completion date'],
    ['malformed', 'not-a-date', 'invalid completion date'],
    ['future', new Date(NOW.getTime() + 60_000).toISOString(), 'in the future'],
  ])('a %s date is never accepted or described as valid', (_l, value, reason) => {
    const d = of(plan({ invitations: [completed({ lln_completed_at: value as string | null })] }), 'lln');
    expect(d.action).toBe('review');
    expect(d.check?.status).toBe('unverifiable');
    expect(d.check?.reason).toContain(reason);
  });
});

describe('5. no configured RTO validity policy', () => {
  it('is never accepted automatically and no period is invented', () => {
    const d = of(plan({ policy: { lln_days: null, digital_days: 180 } }), 'lln');
    expect(d.action).toBe('review');
    expect(d.check?.status).toBe('not_configured');
    expect(d.check?.validUntil).toBeNull();
  });
  it('a first assessment is still issued when there is no previous result', () => {
    const d = plan({ invitations: [], policy: { lln_days: null, digital_days: null } });
    expect(of(d, 'lln').action).toBe('sent');
    expect(of(d, 'digital').action).toBe('sent');
  });
});

describe('6. separate LLN and Digital completion dates', () => {
  it('a recent Digital result does not make an expired LLN result valid', () => {
    const d = plan({ invitations: [completed({ lln_completed_at: daysAgo(400), digital_completed_at: daysAgo(5) })] });
    expect(of(d, 'lln').action).toBe('sent');
    expect(of(d, 'digital').action).toBe('existing');
  });
  it('a recent LLN result does not make an expired Digital result valid', () => {
    const d = plan({ invitations: [completed({ lln_completed_at: daysAgo(5), digital_completed_at: daysAgo(200) })] });
    expect(of(d, 'lln').action).toBe('existing');
    expect(of(d, 'digital').action).toBe('sent');
  });
  it('never borrows the invitation’s overall completion date', () => {
    const d = of(plan({ invitations: [completed({ digital_completed_at: null, completed_at: daysAgo(1) })] }), 'digital');
    expect(d.action).toBe('review');
  });
});

describe('7. one module sufficient, the other not', () => {
  it('LLN sufficient, Digital below pass mark → only Digital is reassessed', () => {
    const d = plan({ invitations: [completed({ digital_score: 40 })] });
    expect(of(d, 'lln').action).toBe('existing');
    expect(of(d, 'digital')).toMatchObject({ action: 'sent' });
    expect(of(d, 'digital').check?.status).toBe('insufficient');
  });
  it('Digital sufficient, LLN below requirement → only LLN is reassessed', () => {
    const d = plan({ invitations: [completed({ lln_acsf_outcomes: { ...GOOD_LLN, reading: 2 } })] });
    expect(of(d, 'lln').action).toBe('sent');
    expect(of(d, 'digital').action).toBe('existing');
  });
  it('Digital uses the pass mark of the assessment the candidate sat', () => {
    expect(checkDigitalSufficiency(74, 75).sufficient).toBe(false);
    expect(checkDigitalSufficiency(75, 75).sufficient).toBe(true);
    expect(of(plan({ passMarks: { 'inv-old': 90 } }), 'digital').action).toBe('sent');
  });
  it('an unknown pass mark or missing score is not accepted', () => {
    expect(of(plan({ passMarks: {} }), 'digital').action).toBe('review');
    expect(of(plan({ invitations: [completed({ digital_score: null })] }), 'digital').action).toBe('review');
  });
});

describe('8. results below course requirements', () => {
  it('maps requirement skills to the stored result keys', () => {
    expect(skillKey('Oral Communication')).toBe('oral_communication');
    expect(checkLlnSufficiency(GOOD_LLN, COURSE.requirements).sufficient).toBe(true);
  });
  it('one skill below its level is insufficient and named', () => {
    const r = checkLlnSufficiency({ ...GOOD_LLN, reading: 2 }, COURSE.requirements);
    expect(r.sufficient).toBe(false);
    expect(r.detail).toContain('Reading 2 (required 3)');
  });
  it('a required skill missing from the result is insufficient', () => {
    const { reading: _omit, ...rest } = GOOD_LLN;
    expect(checkLlnSufficiency(rest, COURSE.requirements).sufficient).toBe(false);
  });
  it('a result with no recorded ACSF levels is not accepted', () => {
    expect(of(plan({ invitations: [completed({ lln_acsf_outcomes: {} })] }), 'lln').action).toBe('review');
  });
  it('the most recent attempt counts, even when an older attempt was better', () => {
    const older = completed({ id: 'a', lln_completed_at: daysAgo(50) });
    const newer = completed({ id: 'b', lln_completed_at: daysAgo(10), lln_acsf_outcomes: { ...GOOD_LLN, reading: 1 } });
    expect(latestCompletedResult([older, newer], 'lln', ORG)?.id).toBe('b');
    expect(of(plan({ invitations: [older, newer] }), 'lln').action).toBe('sent');
  });
});

describe('9. missing or unapproved course mappings (no fallback thresholds)', () => {
  it('course not identified → not reused', () => {
    expect(of(plan({ course: { qualificationId: null } }), 'lln').check?.reason).toContain('course for this enrolment could not be identified');
  });
  it.each([
    ['mapping required', { mappingStatus: 'mapping_required' }],
    ['review required', { mappingStatus: 'review_required' }],
    ['no mapping status', { mappingStatus: null }],
    ['never reviewed', { mappingReviewedAt: null }],
    ['review older than 365 days', { mappingReviewedAt: daysAgo(366) }],
  ])('%s → not reused, held for review', (_l, course) => {
    const d = plan({ course: course as Partial<CourseContext> });
    expect(of(d, 'lln').action).toBe('review');
    expect(of(d, 'digital').action).toBe('review');
  });
  it('no LLN requirements recorded → LLN not reused; the old ACSF 2 fallback is gone', () => {
    const c = { ...COURSE, requirements: [] };
    expect(courseReadiness(c, 'lln', NOW).ready).toBe(false);
    expect(checkLlnSufficiency(GOOD_LLN, []).sufficient).toBeNull();
    expect(of(plan({ course: { requirements: [] } }), 'lln').action).toBe('review');
  });
  it('an expired result is reassessed even when the mapping is incomplete', () => {
    expect(of(plan({ course: { qualificationId: null }, invitations: [completed({ lln_completed_at: daysAgo(400) })] }), 'lln').action).toBe('sent');
  });
});

describe('10–12. changed policy, changed requirements, previously processed records', () => {
  const fp = (policy = POLICY, course = COURSE) => validityFingerprint(policy, course, true, true);
  const validated = (over: Partial<PreviousLog> = {}): PreviousLog => ({
    status: 'skipped', invitation_id: null, lln_invitation_id: 'inv-old', digital_invitation_id: 'inv-old',
    validated_at: daysAgo(1), validity_fingerprint: fp(), validity_checks: [{ valid_until: daysAgo(-200) }],
    outcome_signature: 'x', note_written: true, ...over,
  });
  it('12. a validated, unchanged, unexpired entry stands', () => {
    expect(planForPreviousLog(validated(), NOW, fp()).recheck).toBe(false);
  });
  it('12. an entry written before validity checks is re-checked', () => {
    expect(planForPreviousLog(validated({ validated_at: null }), NOW, fp())).toMatchObject({ recheck: true });
  });
  it('12. an entry is re-checked once a result it relied on expires', () => {
    expect(planForPreviousLog(validated({ validity_checks: [{ valid_until: NOW.toISOString() }] }), NOW, fp())).toMatchObject({ recheck: true, reason: 'a relied-on result has expired' });
  });
  it('12. an entry is re-checked when the course mapping falls due for review', () => {
    expect(planForPreviousLog(validated({ validity_checks: [{ valid_until: daysAgo(-200), recheck_by: daysAgo(1) }] }), NOW, fp()).recheck).toBe(true);
  });
  it('12. a review hold is always re-checked', () => {
    expect(planForPreviousLog(validated({ status: 'review_required' }), NOW, fp()).recheck).toBe(true);
  });
  it('10. changing the validity policy forces a re-check, and the new period applies', () => {
    const newPolicy = { lln_days: 90, digital_days: 180 };
    expect(planForPreviousLog(validated(), NOW, fp(newPolicy))).toMatchObject({ recheck: true, reason: 'validity policy or course requirements changed' });
    expect(of(plan({ policy: newPolicy }), 'lln').action).toBe('sent');
    expect(of(plan({ policy: { lln_days: null, digital_days: 180 } }), 'lln').action).toBe('review');
  });
  it('11. changing course requirements forces a re-check against the new requirements', () => {
    const raised = { ...COURSE, requirements: COURSE.requirements.map(r => r.acsf_skill === 'Reading' ? { ...r, minimum_acsf_level: 4 } : r) };
    expect(planForPreviousLog(validated(), NOW, fp(POLICY, raised)).recheck).toBe(true);
    expect(of(plan({ course: raised }), 'lln').action).toBe('sent');
  });
  it('11. a mapping approval change forces a re-check', () => {
    expect(planForPreviousLog(validated(), NOW, fp(POLICY, { ...COURSE, mappingReviewedAt: daysAgo(2) })).recheck).toBe(true);
  });
  it('12. a review hold proceeds once the RTO sets a period', () => {
    expect(of(plan({ previousLog: validated({ status: 'review_required' }) }), 'lln').action).toBe('existing');
  });
  it('the assessment issued for this enrolment is never reissued for being below requirements', () => {
    const log: PreviousLog = { status: 'created', invitation_id: 'mine', lln_invitation_id: 'mine', digital_invitation_id: null };
    const mine = completed({ id: 'mine', lln_completed_at: daysAgo(15), lln_acsf_outcomes: { reading: 1 } });
    expect(of(plan({ previousLog: log, digital: false, invitations: [mine] }), 'lln')).toMatchObject({ action: 'completed', invitationId: 'mine' });
  });
  it('...but it is reassessed once it expires', () => {
    const log: PreviousLog = { status: 'created', invitation_id: 'mine', lln_invitation_id: 'mine', digital_invitation_id: null };
    const mine = completed({ id: 'mine', lln_completed_at: daysAgo(400) });
    expect(of(plan({ previousLog: log, digital: false, invitations: [mine] }), 'lln').action).toBe('sent');
  });
  it('reassessing one module keeps track of the other module’s own assessment', () => {
    const log: PreviousLog = {
      status: 'created', invitation_id: 'new-lln', lln_invitation_id: 'new-lln', digital_invitation_id: 'mine',
      validity_checks: [{ type: 'lln', own: true, invitation_id: 'new-lln' }, { type: 'digital', own: true, invitation_id: 'mine' }],
    };
    expect(ownInvitations(log).get('digital')).toBe('mine');
    const mine = completed({ id: 'mine', lln_status: null, digital_completed_at: daysAgo(10), digital_score: 10 });
    expect(of(plan({ previousLog: log, lln: false, invitations: [mine], passMarks: { mine: 50 } }), 'digital').action).toBe('completed');
  });
});

describe('13. repeated events and duplicate prevention', () => {
  it('the same event twice produces the same outcome and no second note', () => {
    const first = plan({});
    const sig = outcomeSignature(first);
    const log: PreviousLog = { status: 'skipped', invitation_id: null, lln_invitation_id: 'inv-old', digital_invitation_id: 'inv-old', outcome_signature: sig, note_written: true };
    const second = plan({ previousLog: log });
    expect(outcomeSignature(second)).toBe(sig);
    expect(shouldWriteNote(log, sig, second)).toBe(false);
  });
  it('an open invitation is reported, not duplicated', () => {
    const open = { id: 'open', organisation_id: ORG, status: 'in_progress', lln_token: 'x', lln_status: 'pending' } as LearnerInvitation;
    expect(of(plan({ invitations: [open, completed()] }), 'lln')).toMatchObject({ action: 'active', invitationId: 'open' });
  });
  it('a finished LLN on an in-progress invitation is not an open LLN invitation', () => {
    const half = completed({ id: 'half', status: 'in_progress', digital_status: 'pending', digital_completed_at: null });
    const d = plan({ invitations: [half], passMarks: { half: 50 } });
    expect(of(d, 'lln').action).toBe('existing');
    expect(of(d, 'digital')).toMatchObject({ action: 'active', invitationId: 'half' });
  });
  it('a repeated review hold writes its note once', () => {
    const d = plan({ policy: { lln_days: null, digital_days: null } });
    const log: PreviousLog = { status: 'review_required', invitation_id: null, lln_invitation_id: null, digital_invitation_id: null, outcome_signature: outcomeSignature(d), note_written: true };
    expect(shouldWriteNote(log, outcomeSignature(d), d)).toBe(false);
  });
  it('a changed outcome writes one new note; a failed note is retried', () => {
    const before = outcomeSignature(plan({ policy: { lln_days: null, digital_days: null } }));
    const after = plan({});
    const log: PreviousLog = { status: 'review_required', invitation_id: null, lln_invitation_id: null, digital_invitation_id: null, outcome_signature: before, note_written: true };
    expect(shouldWriteNote(log, outcomeSignature(after), after)).toBe(true);
    expect(shouldWriteNote({ ...log, outcome_signature: outcomeSignature(after), note_written: false }, outcomeSignature(after), after)).toBe(true);
  });
  it('re-checking an old entry that changes nothing does not repeat its note', () => {
    const legacy: PreviousLog = { status: 'skipped', invitation_id: null, lln_invitation_id: 'inv-old', digital_invitation_id: 'inv-old', note_written: true };
    const d = plan({ previousLog: legacy });
    expect(shouldWriteNote(legacy, outcomeSignature(d), d)).toBe(false);
  });
});

describe('14. same learner with multiple enrolments', () => {
  it('the same result is judged against each enrolment’s own course requirements', () => {
    const higher: Partial<CourseContext> = { qualificationId: 'q-diploma', requirements: COURSE.requirements.map(r => ({ ...r, minimum_acsf_level: 4 })) };
    expect(of(plan({ digital: false }), 'lln').action).toBe('existing');
    expect(of(plan({ digital: false, course: higher }), 'lln').action).toBe('sent');
  });
  it('each enrolment has its own decision record and fingerprint', () => {
    const a = validityFingerprint(POLICY, COURSE, true, false);
    const b = validityFingerprint(POLICY, { ...COURSE, qualificationId: 'q-diploma' }, true, false);
    expect(a).not.toBe(b);
    const src = fs.readFileSync(path.resolve(__dirname, '../../supabase/functions/axcelerate-inbound-sync/index.ts'), 'utf8');
    expect(src).toContain('const idempotencyKey = `${contactId}:${llnRequired ? "lln" : ""}_${digitalRequired ? "digital" : ""}:${qualificationId ?? "any"}`;');
  });
});

describe('15. cross-RTO isolation and ambiguous identity', () => {
  const base = { organisationId: ORG, contactId: 42, firstName: 'Ana', lastName: 'Li', dob: '2000-01-01', email: 'ana@x.com' };
  const row = (o: Partial<StudentRow>): StudentRow => ({ id: 's1', organisation_id: ORG, axcelerate_contact_id: null, first_name: 'Ana', last_name: 'Li', date_of_birth: '2000-01-01', email: 'ana@x.com', ...o });
  it('another RTO’s results and open invitations are never used', () => {
    const theirs = completed({ id: 'theirs', organisation_id: OTHER, lln_completed_at: daysAgo(1) });
    expect(latestCompletedResult([theirs], 'lln', ORG)).toBeNull();
    expect(of(plan({ invitations: [theirs] }), 'lln').action).toBe('sent');
    const open = { id: 'open', organisation_id: OTHER, status: 'sent', lln_token: 'x', lln_status: 'pending' } as LearnerInvitation;
    expect(of(plan({ invitations: [open] }), 'lln').action).toBe('sent');
  });
  it('another RTO’s student is never matched, even with the same contact ID', () => {
    expect(matchStudent([row({ organisation_id: OTHER, axcelerate_contact_id: 42 })], base).kind).toBe('none');
  });
  it('matches by contact ID, then exact name + date of birth, then email without a DOB conflict', () => {
    expect(matchStudent([row({ id: 'byId', axcelerate_contact_id: 42, first_name: 'Other' }), row({})], base)).toMatchObject({ kind: 'matched', id: 'byId', by: 'contact_id' });
    expect(matchStudent([row({ first_name: 'ANA', last_name: ' li ' })], base)).toMatchObject({ by: 'dob_and_name' });
    expect(matchStudent([row({ first_name: 'A.', date_of_birth: null })], base)).toMatchObject({ by: 'email_and_dob' });
  });
  it('never matches on date of birth alone, a conflicting DOB, or a record linked to another contact', () => {
    expect(matchStudent([row({ first_name: 'Ben', email: 'ben@x.com' })], base).kind).toBe('none');
    expect(matchStudent([row({ first_name: 'Sam', date_of_birth: '1970-05-05' })], base).kind).toBe('none');
    expect(matchStudent([row({ axcelerate_contact_id: 99 })], base).kind).toBe('none');
  });
  it('ambiguous identity is held for review, not guessed', () => {
    expect(matchStudent([row({ id: 'a' }), row({ id: 'b' })], base).kind).toBe('ambiguous');
    expect(matchStudent([row({ id: 'a', axcelerate_contact_id: 42 }), row({ id: 'b', axcelerate_contact_id: 42 })], base).kind).toBe('ambiguous');
    const src = fs.readFileSync(path.resolve(__dirname, '../../supabase/functions/axcelerate-inbound-sync/index.ts'), 'utf8');
    expect(src).toContain('so the learner could not be identified reliably');
  });
  it('LIKE wildcards in names and emails are matched literally', () => {
    expect(escapeLike('a_b%c@x.com')).toBe('a\\_b\\%c@x.com');
  });
});

describe('16. contact-note wording', () => {
  it('uses the approved positive sentence only when every check passed, with dates and context', () => {
    const text = note(plan({ invitations: [completed({ lln_completed_at: '2026-07-21T00:00:00.000Z' })] }));
    expect(text).toContain('Existing LLND assessment results have been reviewed and meet the current LLND requirements for this course.');
    expect(text).toContain('LLN: completed 21 July 2026');
    expect(text).toContain("within the RTO's 365-day validity period");
    expect(text).toContain('ACSF Reading 3 (required 3)');
    expect(text).toContain('Digital score 80% (pass mark 50%)');
  });
  it('never uses the positive sentence when any module is not confirmed', () => {
    for (const d of [
      plan({ invitations: [completed({ digital_score: 10 })] }),
      plan({ policy: { lln_days: null, digital_days: 180 } }),
      plan({ invitations: [completed({ lln_completed_at: daysAgo(400) })] }),
    ]) expect(note(d)).not.toContain('meet the current LLND requirements');
  });
  it('reassessment and review are stated accurately', () => {
    expect(note(plan({ invitations: [completed({ lln_completed_at: daysAgo(400) })] }))).toContain('reassessment required — previous result (completed');
    const review = note(plan({ policy: { lln_days: null, digital_days: null } }));
    expect(review).toContain('LLND requirements not yet confirmed — pending RTO review because the RTO has not set how long LLN results remain valid');
    expect(review).toContain('No result has been reused and no new invitation has been issued.');
  });
  it('does not imply payment, admission or enrolment acceptance', () => {
    const text = note(plan({}));
    expect(text).toContain('This note records LLND assessment status only.');
    expect(text).not.toMatch(/admission|payment|enrolment (is )?(accepted|confirmed|approved)/i);
  });
  it('states when the course was not identified', () => {
    expect(note(plan({ course: { qualificationId: null } }), null)).toContain('Course: not identified from the aXcelerate enrolment');
  });
  it('the old unchecked "current valid" wording is gone', () => {
    const src = fs.readFileSync(path.resolve(__dirname, '../../supabase/functions/axcelerate-inbound-sync/index.ts'), 'utf8');
    expect(src).not.toContain('current valid');
  });
});

describe('wiring and enrolment safety', () => {
  const read = (p: string) => fs.readFileSync(path.resolve(__dirname, '../..', p), 'utf8');
  const src = read('supabase/functions/axcelerate-inbound-sync/index.ts');
  const queue = read('supabase/functions/process-axcelerate-queue/index.ts');
  const migration = read('supabase/migrations/20261029090000_assessment_result_validity.sql');
  it('reads the validity setting of the RTO doing the sync', () => {
    expect(src).toMatch(/from\("organisation_settings"\)[\s\S]{0,120}eq\("organisation_id", INTEGRATION_ORGANISATION_ID\)\.eq\("key", VALIDITY_SETTING_KEY\)/);
  });
  it('only short-circuits a previous entry the plan allows, within the RTO', () => {
    expect(src).toMatch(/axcelerate_inbound_sync_log"\)\s*\.select\("\*"\)\s*\.eq\("organisation_id", INTEGRATION_ORGANISATION_ID\)/);
    expect(src).toContain('planForPreviousLog(previousLog, now, fingerprint)');
    expect(src).toContain('!plan.recheck');
  });
  it('loads mapping approval with the qualification and records the fingerprint', () => {
    expect(src).toContain('select("id, code, name, mapping_status, reviewed_at")');
    expect(src).toContain('validity_fingerprint: fingerprint');
    expect(src).not.toContain('DEFAULT_MIN_ACSF');
  });
  it('inbound-sync write-backs never auto-enrol the learner', () => {
    expect(src).toContain('extra_data: { source: "axcelerate_inbound_sync", skip_enrolment: true }');
    expect(queue).toContain('const alreadyEnrolledInAxcelerate = !!invitation.enrolment_id || job.extra_data?.skip_enrolment === true;');
    expect(queue).toContain('if (!alreadyEnrolledInAxcelerate && ["invitation_sent", "quiz_sent", "assessment_completed"].includes(job.event_type))');
    expect(queue).toMatch(/student_id, enrolment_id,/);
  });
  it('reuse never queues a write-back of its own', () => {
    const reuseBlock = src.slice(src.indexOf('// ── 7. Create invitations'), src.indexOf('// ── 8. Contact note'));
    expect(reuseBlock).toMatch(/if \(needsNewLln \|\| needsNewDigital\) \{[\s\S]*axcelerate_writeback_queue/);
  });
  it('the migration adds the setting, validation, log columns and statuses, and seeds no default', () => {
    expect(migration).toContain("'assessment_result_validity') THEN 'administration'");
    expect(migration).toContain('validate_assessment_result_validity');
    expect(migration).toContain("'review_required'");
    expect(migration).toMatch(/ADD COLUMN IF NOT EXISTS validity_fingerprint/);
    expect(migration).not.toMatch(/INSERT INTO public\.organisation_settings/);
  });
});
