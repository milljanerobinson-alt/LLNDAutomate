// LLND Mate Plan & usage: client for the server-side read model
// (public.get_my_plan_usage, supabase/migrations/20261110090000_llnd_mate_free_tier_invitations.sql).
//
// LLND Mate Free is counted by invitations sent. The browser never computes or
// stores usage: every figure comes from the server, and anything unexpected is
// shown as an error rather than a guessed or default value.

import { supabase } from './supabase';

export type UsageLevel = 'empty' | 'normal' | 'near' | 'exhausted';

export type PlanUsageState =
  | { kind: 'loading' }
  | { kind: 'unauthorised' }
  | { kind: 'error' }
  | { kind: 'no_entitlement' }
  | { kind: 'inconsistent' }
  | {
      kind: 'ok';
      planName: string;
      tierLabel: string;
      /** Active invitations counted against this month's allowance. */
      used: number;
      allowance: number;
      remaining: number;
      /** Chargeable invitations sent this month, including ones later deleted. */
      sentThisMonth: number;
      /** Invitations returned to the allowance by deleting assessments sent this month. */
      returnedByDeletion: number;
      /** "Test Test" invitations this month (never counted). */
      testInvitations: number;
      newInvitationsAvailable: boolean;
      /** First day of the next usage month (AEST), YYYY-MM-DD. */
      resetDate: string;
      level: UsageLevel;
    };

/** "Nearly used" from 80% of the allowance (8 of 10). */
export function usageLevel(used: number, allowance: number): UsageLevel {
  if (used >= allowance) return 'exhausted';
  if (used === 0) return 'empty';
  if (used >= Math.ceil(allowance * 0.8)) return 'near';
  return 'normal';
}

const isInt = (v: unknown): v is number => typeof v === 'number' && Number.isInteger(v) && v >= 0;
const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);

/** Validates the server response. Anything malformed becomes 'inconsistent', never a default. */
export function parsePlanUsage(raw: unknown): PlanUsageState {
  if (!isObj(raw)) return { kind: 'inconsistent' };
  if (raw.state === 'no_entitlement') return { kind: 'no_entitlement' };
  if (raw.state !== 'ok') return { kind: 'inconsistent' };
  const plan = raw.plan, usage = raw.usage, period = raw.period;
  if (!isObj(plan) || !isObj(usage) || !isObj(period)) return { kind: 'inconsistent' };
  if (raw.consistent !== true) return { kind: 'inconsistent' };
  if (plan.code !== 'llnd_mate_free' || plan.status !== 'active' || plan.unit !== 'invitations') return { kind: 'inconsistent' };
  const {
    used, allowance, remaining, sent_this_month: sent, returned_by_deletion: returned,
    test_invitations: tests, new_invitations_available: available,
  } = usage;
  if (![used, allowance, remaining, sent, returned, tests].every(isInt) || allowance === 0) return { kind: 'inconsistent' };
  const u = used as number, a = allowance as number;
  if (remaining !== Math.max(a - u, 0)) return { kind: 'inconsistent' };
  if ((sent as number) - (returned as number) !== u) return { kind: 'inconsistent' };
  if (typeof available !== 'boolean' || available !== u < a) return { kind: 'inconsistent' };
  const resetDate = period.reset_date;
  if (typeof resetDate !== 'string' || !/^\d{4}-\d{2}-01$/.test(resetDate)) return { kind: 'inconsistent' };
  return {
    kind: 'ok',
    planName: String(plan.name ?? ''),
    tierLabel: String(plan.tier ?? ''),
    used: u, allowance: a, remaining: remaining as number,
    sentThisMonth: sent as number, returnedByDeletion: returned as number, testInvitations: tests as number,
    newInvitationsAvailable: available,
    resetDate,
    level: usageLevel(u, a),
  };
}

export async function fetchPlanUsage(): Promise<PlanUsageState> {
  try {
    const { data, error } = await supabase.rpc('get_my_plan_usage');
    if (error) {
      if (error.code === '42501' || /not_authorised|permission denied/i.test(error.message ?? '')) return { kind: 'unauthorised' };
      return { kind: 'error' };
    }
    return parsePlanUsage(data);
  } catch {
    return { kind: 'error' };
  }
}

/** "2026-12-01" -> "1 December 2026" (calendar date, no time-zone shift). */
export function formatResetDate(isoDate: string): string {
  const [y, m, d] = isoDate.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d)).toLocaleDateString('en-AU', { day: 'numeric', month: 'long', year: 'numeric', timeZone: 'UTC' });
}

/** Server refused a new invitation because this month's allowance is used. */
export function isInvitationAllowanceReached(error: unknown): boolean {
  return isObj(error) && typeof error.message === 'string' && error.message.includes('invitation_allowance_reached');
}
/** Server refused a new invitation because the organisation has no confirmed plan. */
export function isInvitationPlanUnconfirmed(error: unknown): boolean {
  return isObj(error) && typeof error.message === 'string' && error.message.includes('invitation_plan_unconfirmed');
}

/** Same normalisation as the database's llnd_is_reserved_test_name (display hint only; the server decides). */
export function looksLikeReservedTestName(name: string): boolean {
  return name.normalize('NFKC').toLowerCase()
    .replace(/[\u200b-\u200d\u2060\ufeff\u00ad]/g, '')
    .replace(/[\s\u00a0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000]+/g, ' ')
    .trim() === 'test test';
}

export type DeleteResult = { ok: true; refunded: boolean; alreadyDeleted: boolean } | { ok: false; message: string };

/** Soft-deletes an assessment assignment. The server re-checks permission and the typed confirmation. */
export async function deleteAssessmentAssignment(invitationId: string, confirmation: string): Promise<DeleteResult> {
  try {
    const { data, error } = await supabase.rpc('delete_assessment_assignment', { p_invitation_id: invitationId, p_confirmation: confirmation });
    if (error) {
      if (/confirmation_required/.test(error.message ?? '')) return { ok: false, message: 'Type YES to confirm deletion.' };
      if (error.code === '42501' || /not_authorised/.test(error.message ?? '')) return { ok: false, message: 'You don’t have permission to delete assessments.' };
      if (/not_found/.test(error.message ?? '')) return { ok: false, message: 'This assessment could not be found. It may already have been deleted.' };
      return { ok: false, message: 'The assessment could not be deleted. Please try again.' };
    }
    const d = isObj(data) ? data : {};
    return { ok: true, refunded: d.allowance_refunded === true, alreadyDeleted: d.status === 'already_deleted' };
  } catch {
    return { ok: false, message: 'The assessment could not be deleted. Please try again.' };
  }
}

// ── Test Candidates ──────────────────────────────────────────────────────
// Names ("Test Test", "Test Test2", ...) are allocated by the server per RTO and
// are locked; the browser only shows them. Creating a Test Candidate is not an
// invitation. Assessments are sent through the normal invitation form with
// test_candidate_id, and the server binds the locked name and email.

export interface TestCandidate { id: string; candidateName: string; email: string; sequenceNumber: number; createdAt: string }

/** Same rule as the database email check. */
export function isValidTestCandidateEmail(email: string): boolean {
  const e = email.trim();
  return e.length > 0 && e.length <= 254 && /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(e);
}

/** Shown before confirmation; the server allocates the final name, which can differ if another user creates one first. */
export async function previewNextTestCandidateName(): Promise<string | null> {
  try {
    const { data, error } = await supabase.rpc('preview_next_test_candidate_name');
    return error || typeof data !== 'string' ? null : data;
  } catch { return null; }
}

export async function createTestCandidate(email: string): Promise<{ ok: true; candidate: TestCandidate } | { ok: false; message: string }> {
  if (!isValidTestCandidateEmail(email)) return { ok: false, message: 'Enter a valid email address.' };
  try {
    const { data, error } = await supabase.rpc('create_test_candidate', { p_email: email.trim() });
    if (error) {
      if (/invalid_email/.test(error.message ?? '')) return { ok: false, message: 'Enter a valid email address.' };
      if (error.code === '42501' || /not_authorised/.test(error.message ?? '')) return { ok: false, message: 'Only RTO administrators can create Test Candidates.' };
      return { ok: false, message: 'The Test Candidate could not be created. Please try again.' };
    }
    const d = (data ?? {}) as Record<string, unknown>;
    return { ok: true, candidate: { id: String(d.id), candidateName: String(d.candidate_name), email: String(d.email), sequenceNumber: Number(d.sequence_number), createdAt: new Date().toISOString() } };
  } catch { return { ok: false, message: 'The Test Candidate could not be created. Please try again.' }; }
}

export async function listTestCandidates(): Promise<TestCandidate[]> {
  const { data, error } = await supabase.from('test_candidates')
    .select('id, candidate_name, email, sequence_number, created_at').order('sequence_number', { ascending: false });
  if (error) return [];
  return (data ?? []).map((r: any) => ({ id: r.id, candidateName: r.candidate_name, email: r.email, sequenceNumber: r.sequence_number, createdAt: r.created_at }));
}

export async function deleteTestCandidate(id: string, confirmation: string): Promise<DeleteResult> {
  try {
    const { data, error } = await supabase.rpc('delete_test_candidate', { p_test_candidate_id: id, p_confirmation: confirmation });
    if (error) {
      if (/confirmation_required/.test(error.message ?? '')) return { ok: false, message: 'Type YES to confirm deletion.' };
      return { ok: false, message: 'The Test Candidate could not be deleted. Please try again.' };
    }
    return { ok: true, refunded: false, alreadyDeleted: (data as { status?: string } | null)?.status === 'already_deleted' };
  } catch { return { ok: false, message: 'The Test Candidate could not be deleted. Please try again.' }; }
}

/** Existing pricing / plan comparison route. Paid plans there are "Coming soon"; nothing can be bought. */
export const UPGRADE_OPTIONS_HASH = '#/pricing';
