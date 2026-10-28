import { describe, expect, it } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import {
  buildInboundNote, checkDigitalSufficiency, checkLlnSufficiency, escapeLike, evaluateResult,
  latestCompletedResult, matchStudent, outcomeSignature, parseValidityPolicy, planAssessments,
  planForPreviousLog, shouldWriteNote, skillKey,
  type LearnerInvitation, type PreviousLog, type QualificationRequirement, type StudentRow,
} from '../../supabase/functions/_shared/result-validity';

// Assessment-result validity and safe reuse.

const DAY = 86_400_000;
const ORG = 'org-1';
const OTHER = 'org-2';
const NOW = new Date('2026-10-29T00:00:00.000Z');
const daysAgo = (n: number, ms = 0) => new Date(NOW.getTime() - n * DAY - ms).toISOString();
const REQS: QualificationRequirement[] = [
  { domain: 'literacy', acsf_skill: 'Reading', minimum_acsf_level: 3 },
  { domain: 'language', acsf_skill: 'Oral Communication', minimum_acsf_level: 2 },
  { domain: 'numeracy', acsf_skill: 'Numeracy', minimum_acsf_level: 2 },
  { domain: 'digital', acsf_skill: 'Digital Literacy', minimum_acsf_level: 2 },
];
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
  lln?: boolean; digital?: boolean; qualificationIdentified?: boolean; now?: Date; passMarks?: Record<string, number | null>;
}) {
  return planAssessments({
    organisationId: ORG,
    llnRequired: opts.lln ?? true,
    digitalRequired: opts.digital ?? true,
    invitations: opts.invitations ?? [completed()],
    previousLog: opts.previousLog ?? null,
    policy: opts.policy ?? POLICY,
    requirements: REQS,
    digitalPassMarks: opts.passMarks ?? { 'inv-old': 50 },
    qualificationIdentified: opts.qualificationIdentified ?? true,
    defaultMinimumAcsf: 2,
    now: opts.now ?? NOW,
  });
}
const action = (r: ReturnType<typeof plan>, type: 'lln' | 'digital') => r.decisions.find(d => d.type === type)!;

describe('validity setting', () => {
  it('accepts whole days from 1 to 3650 and treats anything else as not configured', () => {
    expect(parseValidityPolicy({ lln_days: 365, digital_days: 1 })).toEqual({ lln_days: 365, digital_days: 1 });
    expect(parseValidityPolicy({ lln_days: 3650, digital_days: 3651 })).toEqual({ lln_days: 3650, digital_days: null });
    for (const bad of [0, -1, 1.5, '30', null, undefined, true]) {
      expect(parseValidityPolicy({ lln_days: bad }).lln_days).toBeNull();
    }
    expect(parseValidityPolicy(null)).toEqual({ lln_days: null, digital_days: null });
    expect(parseValidityPolicy('365')).toEqual({ lln_days: null, digital_days: null });
  });
  it('has no default period', () => {
    expect(parseValidityPolicy({})).toEqual({ lln_days: null, digital_days: null });
  });
});

describe('expiry boundaries', () => {
  const evalAt = (completedAt: string, days: number) => evaluateResult({
    type: 'lln', completedAtRaw: completedAt, validityDays: days,
    sufficiency: { sufficient: true, detail: 'ok' }, qualificationIdentified: true, asOf: NOW, now: NOW,
  });
  it('is valid 1 ms before the period ends', () => {
    expect(evalAt(daysAgo(365, -1), 365).status).toBe('valid');
  });
  it('has expired at exactly the end of the period', () => {
    expect(evalAt(daysAgo(365), 365).status).toBe('expired');
  });
  it('has expired 1 ms after the period ends', () => {
    expect(evalAt(daysAgo(365, 1), 365).status).toBe('expired');
  });
  it('a result completed today is valid for a 1-day period', () => {
    expect(evalAt(NOW.toISOString(), 1).status).toBe('valid');
  });
  it('reports the date the result stops being valid', () => {
    const c = evalAt(daysAgo(10), 30);
    expect(c.validUntil).toBe(new Date(NOW.getTime() + 20 * DAY).toISOString());
  });
});

describe('completion dates are checked per assessment', () => {
  it('uses each assessment’s own date: recent LLN reused, old Digital reassessed', () => {
    const r = plan({ invitations: [completed({ lln_completed_at: daysAgo(30), digital_completed_at: daysAgo(200) })] });
    expect(action(r, 'lln').action).toBe('existing');
    expect(action(r, 'digital').action).toBe('sent');
    expect(action(r, 'digital').check?.status).toBe('expired');
  });
  it('does not borrow the invitation’s overall date when an assessment date is missing', () => {
    const r = plan({ invitations: [completed({ digital_completed_at: null, completed_at: daysAgo(1) })] });
    expect(action(r, 'digital').action).toBe('review');
    expect(action(r, 'digital').check?.reason).toContain('no completion date');
  });
  it.each([
    ['missing', null, 'no completion date'],
    ['empty', '', 'no completion date'],
    ['invalid', 'not-a-date', 'invalid completion date'],
    ['future', new Date(NOW.getTime() + 60_000).toISOString(), 'in the future'],
  ])('a %s completion date is never accepted automatically', (_label, value, reason) => {
    const r = plan({ invitations: [completed({ lln_completed_at: value as string | null })] });
    expect(action(r, 'lln').action).toBe('review');
    expect(action(r, 'lln').check?.status).toBe('unverifiable');
    expect(action(r, 'lln').check?.reason).toContain(reason);
  });
  it('an unconfigured validity period is never accepted automatically and never invents a period', () => {
    const r = plan({ policy: { lln_days: null, digital_days: 180 } });
    expect(action(r, 'lln').action).toBe('review');
    expect(action(r, 'lln').check?.status).toBe('not_configured');
    expect(action(r, 'lln').check?.validUntil).toBeNull();
    expect(action(r, 'digital').action).toBe('existing');
  });
  it('without any previous result a first assessment is issued, configured or not', () => {
    const r = plan({ invitations: [], policy: { lln_days: null, digital_days: null } });
    expect(action(r, 'lln').action).toBe('sent');
    expect(action(r, 'digital').action).toBe('sent');
  });
});

describe('scores and ACSF requirements', () => {
  it('maps requirement skills to the LLN result keys', () => {
    expect(skillKey('Oral Communication')).toBe('oral_communication');
    expect(checkLlnSufficiency(GOOD_LLN, REQS, 2).sufficient).toBe(true);
  });
  it('a skill below its required level is insufficient → reassessed', () => {
    const r = plan({ invitations: [completed({ lln_acsf_outcomes: { ...GOOD_LLN, reading: 2 } })] });
    expect(action(r, 'lln').action).toBe('sent');
    expect(action(r, 'lln').check?.status).toBe('insufficient');
    expect(action(r, 'lln').check?.sufficiencyDetail).toContain('Reading 2 (needs 3)');
  });
  it('a required skill missing from the result is insufficient', () => {
    const { reading: _r, ...rest } = GOOD_LLN;
    expect(checkLlnSufficiency(rest, REQS, 2).sufficient).toBe(false);
  });
  it('Digital Literacy is not checked against LLN results', () => {
    expect(checkLlnSufficiency(GOOD_LLN, REQS, 2).detail).not.toContain('Digital');
  });
  it('a result with no recorded ACSF levels is not accepted automatically', () => {
    const r = plan({ invitations: [completed({ lln_acsf_outcomes: {} })] });
    expect(action(r, 'lln').action).toBe('review');
  });
  it('Digital uses the pass mark of the assessment the candidate sat', () => {
    expect(checkDigitalSufficiency(70, 75).sufficient).toBe(false);
    expect(checkDigitalSufficiency(75, 75).sufficient).toBe(true);
    const r = plan({ invitations: [completed({ digital_score: 60 })], passMarks: { 'inv-old': 70 } });
    expect(action(r, 'digital').action).toBe('sent');
  });
  it('an unknown Digital pass mark or score is not accepted automatically', () => {
    expect(action(plan({ passMarks: {} }), 'digital').action).toBe('review');
    expect(action(plan({ invitations: [completed({ digital_score: null })] }), 'digital').action).toBe('review');
  });
  it('a result is not reused when the qualification could not be identified', () => {
    const r = plan({ qualificationIdentified: false });
    expect(action(r, 'lln').action).toBe('review');
    expect(action(r, 'lln').check?.reason).toContain('qualification could not be identified');
  });
  it('an expired result is reassessed even when the qualification is unknown', () => {
    const r = plan({ qualificationIdentified: false, invitations: [completed({ lln_completed_at: daysAgo(400) })] });
    expect(action(r, 'lln').action).toBe('sent');
  });
  it('the most recent attempt counts, even if an older one was better', () => {
    const older = completed({ id: 'a', lln_completed_at: daysAgo(50) });
    const newer = completed({ id: 'b', lln_completed_at: daysAgo(10), lln_acsf_outcomes: { ...GOOD_LLN, reading: 1 } });
    expect(latestCompletedResult([older, newer], 'lln', ORG)?.id).toBe('b');
    expect(action(plan({ invitations: [older, newer] }), 'lln').action).toBe('sent');
  });
  it('an open invitation is reported as active, not replaced', () => {
    const open = { id: 'open', organisation_id: ORG, status: 'in_progress', lln_token: 'x', lln_status: 'pending' } as LearnerInvitation;
    expect(action(plan({ invitations: [open, completed()] }), 'lln')).toMatchObject({ action: 'active', invitationId: 'open' });
  });
  it('an invitation whose LLN is finished is not treated as an open LLN invitation', () => {
    const half = completed({ id: 'half', status: 'in_progress', digital_status: 'pending', digital_completed_at: null });
    const r = plan({ invitations: [half] });
    expect(action(r, 'lln').action).toBe('existing');
    expect(action(r, 'digital')).toMatchObject({ action: 'active', invitationId: 'half' });
  });
});

describe('changed validity settings', () => {
  const inv = [completed({ lln_completed_at: daysAgo(200) })];
  it('a longer period accepts the result', () => {
    expect(action(plan({ invitations: inv, policy: { lln_days: 365, digital_days: 365 } }), 'lln').action).toBe('existing');
  });
  it('a shorter period applies to the next decision', () => {
    expect(action(plan({ invitations: inv, policy: { lln_days: 90, digital_days: 365 } }), 'lln').action).toBe('sent');
  });
  it('clearing the period stops automatic reuse', () => {
    expect(action(plan({ invitations: inv, policy: { lln_days: null, digital_days: 365 } }), 'lln').action).toBe('review');
  });
  it('a review hold proceeds once the RTO sets a period', () => {
    const log: PreviousLog = { status: 'review_required', invitation_id: null, lln_invitation_id: 'inv-old', digital_invitation_id: null, created_at: daysAgo(5), validated_at: null };
    expect(planForPreviousLog(log, NOW).recheck).toBe(true);
    expect(action(plan({ previousLog: log, invitations: inv, policy: { lln_days: 365, digital_days: 365 } }), 'lln').action).toBe('existing');
  });
});

describe('repeated syncs and previously processed records', () => {
  it('an old "already processed" entry without validation is re-checked at its original decision time', () => {
    const legacy: PreviousLog = { status: 'skipped', invitation_id: null, lln_invitation_id: 'inv-old', digital_invitation_id: null, created_at: daysAgo(300), note_written: true };
    const p = planForPreviousLog(legacy, NOW);
    expect(p.recheck).toBe(true);
    expect(p.asOf.toISOString()).toBe(daysAgo(300));
  });
  it('a result that had already expired when it was reused is now reassessed', () => {
    const legacy: PreviousLog = { status: 'skipped', invitation_id: null, lln_invitation_id: 'inv-old', digital_invitation_id: null, created_at: daysAgo(10), note_written: true };
    const r = plan({ previousLog: legacy, digital: false, invitations: [completed({ lln_completed_at: daysAgo(500) })] });
    expect(action(r, 'lln').action).toBe('sent');
  });
  it('a result that was valid when reused is not reassessed mid-course', () => {
    const legacy: PreviousLog = { status: 'skipped', invitation_id: null, lln_invitation_id: 'inv-old', digital_invitation_id: null, created_at: daysAgo(300), note_written: true };
    const r = plan({ previousLog: legacy, digital: false, invitations: [completed({ lln_completed_at: daysAgo(400) })] });
    expect(action(r, 'lln').action).toBe('existing');
  });
  it('a validated entry stands', () => {
    const validated: PreviousLog = { status: 'skipped', invitation_id: null, lln_invitation_id: 'inv-old', digital_invitation_id: null, created_at: daysAgo(30), decision_at: daysAgo(30), validated_at: daysAgo(30) };
    expect(planForPreviousLog(validated, NOW).recheck).toBe(false);
  });
  it('the assessment created for this enrolment is never reissued, even if insufficient', () => {
    const created: PreviousLog = { status: 'created', invitation_id: 'mine', lln_invitation_id: 'mine', digital_invitation_id: null, created_at: daysAgo(20) };
    const mine = completed({ id: 'mine', lln_completed_at: daysAgo(15), lln_acsf_outcomes: { reading: 1 } });
    const r = plan({ previousLog: created, digital: false, invitations: [mine] });
    expect(action(r, 'lln')).toMatchObject({ action: 'existing', invitationId: 'mine', check: null });
  });
  it('running the same sync twice gives the same outcome and writes no second note', () => {
    const first = plan({});
    const sig = outcomeSignature(first.decisions);
    const log: PreviousLog = { status: 'skipped', invitation_id: null, lln_invitation_id: 'inv-old', digital_invitation_id: 'inv-old', created_at: NOW.toISOString(), decision_at: NOW.toISOString(), validated_at: NOW.toISOString(), outcome_signature: sig, note_written: true };
    const second = plan({ previousLog: log });
    expect(outcomeSignature(second.decisions)).toBe(sig);
    expect(shouldWriteNote(log, sig, second.decisions)).toBe(false);
  });
  it('a review hold repeated on every sync writes its note only once', () => {
    const decisions = plan({ policy: { lln_days: null, digital_days: null } }).decisions;
    const sig = outcomeSignature(decisions);
    const log: PreviousLog = { status: 'review_required', invitation_id: null, lln_invitation_id: null, digital_invitation_id: null, outcome_signature: sig, note_written: true };
    expect(shouldWriteNote(log, sig, decisions)).toBe(false);
  });
  it('a changed outcome writes a new note', () => {
    const before = outcomeSignature(plan({ policy: { lln_days: null, digital_days: null } }).decisions);
    const afterDecisions = plan({}).decisions;
    const log: PreviousLog = { status: 'review_required', invitation_id: null, lln_invitation_id: null, digital_invitation_id: null, outcome_signature: before, note_written: true };
    expect(shouldWriteNote(log, outcomeSignature(afterDecisions), afterDecisions)).toBe(true);
  });
  it('re-checking an old entry that changes nothing does not repeat its note', () => {
    const legacy: PreviousLog = { status: 'skipped', invitation_id: null, lln_invitation_id: 'inv-old', digital_invitation_id: 'inv-old', created_at: daysAgo(1), note_written: true };
    const decisions = plan({ previousLog: legacy }).decisions;
    expect(shouldWriteNote(legacy, outcomeSignature(decisions), decisions)).toBe(false);
  });
  it('a failed note is retried', () => {
    const decisions = plan({}).decisions;
    const sig = outcomeSignature(decisions);
    const log: PreviousLog = { status: 'skipped', invitation_id: null, lln_invitation_id: null, digital_invitation_id: null, outcome_signature: sig, note_written: false };
    expect(shouldWriteNote(log, sig, decisions)).toBe(true);
  });
  it('a decision time in the future is clamped to now', () => {
    const log: PreviousLog = { status: 'skipped', invitation_id: null, lln_invitation_id: null, digital_invitation_id: null, created_at: new Date(NOW.getTime() + DAY).toISOString() };
    expect(planForPreviousLog(log, NOW).asOf.getTime()).toBe(NOW.getTime());
  });
});

describe('cross-RTO isolation', () => {
  it('another RTO’s results are never reused', () => {
    const theirs = completed({ id: 'theirs', organisation_id: OTHER, lln_completed_at: daysAgo(1) });
    expect(latestCompletedResult([theirs], 'lln', ORG)).toBeNull();
    expect(action(plan({ invitations: [theirs] }), 'lln').action).toBe('sent');
  });
  it('another RTO’s open invitation does not count as active', () => {
    const open = { id: 'open', organisation_id: OTHER, status: 'sent', lln_token: 'x', lln_status: 'pending' } as LearnerInvitation;
    expect(action(plan({ invitations: [open] }), 'lln').action).toBe('sent');
  });
  it('another RTO’s student is never matched, even with the same contact ID', () => {
    const rows: StudentRow[] = [{ id: 's-other', organisation_id: OTHER, axcelerate_contact_id: 42, first_name: 'Ana', last_name: 'Li', date_of_birth: '2000-01-01', email: 'ana@x.com' }];
    expect(matchStudent(rows, { organisationId: ORG, contactId: 42, firstName: 'Ana', lastName: 'Li', dob: '2000-01-01', email: 'ana@x.com' }).kind).toBe('none');
  });
});

describe('student matching within the RTO', () => {
  const base = { organisationId: ORG, contactId: 42, firstName: 'Ana', lastName: 'Li', dob: '2000-01-01', email: 'ana@x.com' };
  const row = (o: Partial<StudentRow>): StudentRow => ({ id: 's1', organisation_id: ORG, axcelerate_contact_id: null, first_name: 'Ana', last_name: 'Li', date_of_birth: '2000-01-01', email: 'ana@x.com', ...o });
  it('matches by aXcelerate contact ID first', () => {
    expect(matchStudent([row({ id: 'byId', axcelerate_contact_id: 42, first_name: 'Other' }), row({})], base)).toMatchObject({ kind: 'matched', id: 'byId', by: 'contact_id' });
  });
  it('matches by date of birth and exact name, case-insensitively', () => {
    expect(matchStudent([row({ first_name: 'ANA', last_name: ' li ' })], base)).toMatchObject({ kind: 'matched', by: 'dob_and_name', linkContact: true });
  });
  it('does not match by date of birth alone', () => {
    expect(matchStudent([row({ first_name: 'Ben', email: 'ben@x.com' })], base).kind).toBe('none');
  });
  it('does not take over a record linked to a different contact', () => {
    expect(matchStudent([row({ axcelerate_contact_id: 99 })], base).kind).toBe('none');
  });
  it('matches by email only when dates of birth do not conflict', () => {
    expect(matchStudent([row({ first_name: 'A.', date_of_birth: null })], base)).toMatchObject({ kind: 'matched', by: 'email_and_dob' });
    expect(matchStudent([row({ first_name: 'Sam', date_of_birth: '1970-05-05' })], base).kind).toBe('none');
  });
  it('holds ambiguous matches for review instead of guessing', () => {
    expect(matchStudent([row({ id: 'a' }), row({ id: 'b' })], base).kind).toBe('ambiguous');
    expect(matchStudent([row({ id: 'a', axcelerate_contact_id: 42 }), row({ id: 'b', axcelerate_contact_id: 42 })], base).kind).toBe('ambiguous');
  });
  it('escapes LIKE wildcards so emails and names match literally', () => {
    expect(escapeLike('a_b%c@x.com')).toBe('a\\_b\\%c@x.com');
  });
});

describe('contact note wording', () => {
  const note = (decisions: ReturnType<typeof plan>['decisions'], qualificationIdentified = true) =>
    buildInboundNote({ contactName: 'Ana Li', qualName: 'BSB30120 Certificate III', qualificationIdentified, decisions, now: NOW, timezone: 'Australia/Sydney' });
  it('a reused result states its completion date, validity period, end date and what was checked', () => {
    const text = note(plan({ invitations: [completed({ lln_completed_at: '2026-07-21T00:00:00.000Z' })], digital: false }).decisions);
    expect(text).toContain('LLN: previous result reused');
    expect(text).toContain('Completed 21 July 2026');
    expect(text).toContain('valid for 365 days');
    expect(text).toContain('ACSF levels: Reading 3 (needs 3)');
  });
  it('an expired result says so and that a new invitation was issued', () => {
    const text = note(plan({ invitations: [completed({ lln_completed_at: daysAgo(400) })], digital: false }).decisions);
    expect(text).toContain('older than the RTO\'s 365-day validity period. New assessment invitation issued.');
  });
  it('a review hold gives the reason and does not claim a valid result', () => {
    const text = note(plan({ policy: { lln_days: null, digital_days: null } }).decisions);
    expect(text).toContain('not accepted automatically because the RTO has not set how long LLN results remain valid');
    expect(text).not.toMatch(/current valid/i);
  });
  it('an unidentified qualification is stated, not shown as "N/A"', () => {
    expect(note(plan({ qualificationIdentified: false }).decisions, false)).toContain('not identified from the aXcelerate enrolment');
  });
  it('never uses the old unchecked "current valid" claim', () => {
    const src = fs.readFileSync(path.resolve(__dirname, '../../supabase/functions/axcelerate-inbound-sync/index.ts'), 'utf8');
    expect(src).not.toContain('current valid');
  });
});

describe('inbound sync wiring', () => {
  const src = fs.readFileSync(path.resolve(__dirname, '../../supabase/functions/axcelerate-inbound-sync/index.ts'), 'utf8');
  const migration = fs.readFileSync(path.resolve(__dirname, '../../supabase/migrations/20261029090000_assessment_result_validity.sql'), 'utf8');
  it('reads the validity setting for the RTO doing the sync', () => {
    expect(src).toMatch(/from\("organisation_settings"\)[\s\S]{0,120}eq\("organisation_id", INTEGRATION_ORGANISATION_ID\)\.eq\("key", VALIDITY_SETTING_KEY\)/);
  });
  it('looks up previous log entries within the RTO and short-circuits only validated ones', () => {
    expect(src).toMatch(/axcelerate_inbound_sync_log"\)\s*\.select\("\*"\)\s*\.eq\("organisation_id", INTEGRATION_ORGANISATION_ID\)/);
    expect(src).toContain('!plan.recheck');
  });
  it('uses the shared decision plan and records what was checked', () => {
    expect(src).toContain('planAssessments(');
    expect(src).toContain('validity_checks:');
    expect(src).toContain('decision_at: plan.asOf.toISOString()');
    expect(src).toContain('outcome_signature: signature');
  });
  it('the migration adds the setting, validation, log columns and review status', () => {
    expect(migration).toContain("'assessment_result_validity') THEN 'administration'");
    expect(migration).toContain('validate_assessment_result_validity');
    expect(migration).toContain("'review_required'");
    expect(migration).toMatch(/ADD COLUMN IF NOT EXISTS validated_at/);
    // No default period is seeded for any RTO.
    expect(migration).not.toMatch(/INSERT INTO public\.organisation_settings/);
  });
});
