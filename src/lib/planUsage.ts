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
    .replace(/[​-‍⁠﻿­]/g, '')
    .replace(/[\s   -     　]+/g, ' ')
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
