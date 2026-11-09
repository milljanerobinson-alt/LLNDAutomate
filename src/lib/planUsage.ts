// LLND Mate Plan & usage: client for the server-side read model
// (public.get_my_plan_usage, supabase/migrations/20261109120000_llnd_mate_free_tier_metering.sql).
//
// The browser never computes or stores usage. Every figure shown comes from the
// server response, and anything unexpected is shown as an error rather than a
// guessed or default value.

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
      completed: number;
      allowance: number;
      remaining: number;
      inProgress: number;
      newStartsAvailable: boolean;
      /** First day of the next usage month (AEST), YYYY-MM-DD. */
      resetDate: string;
      level: UsageLevel;
    };

/** "Nearly used" from 80% of the allowance (8 of 10). */
export function usageLevel(completed: number, allowance: number): UsageLevel {
  if (completed >= allowance) return 'exhausted';
  if (completed === 0) return 'empty';
  if (completed >= Math.ceil(allowance * 0.8)) return 'near';
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
  if (plan.code !== 'llnd_mate_free' || plan.status !== 'active') return { kind: 'inconsistent' };
  const { completed, allowance, remaining, in_progress: inProgress, new_starts_available: newStarts } = usage;
  if (!isInt(completed) || !isInt(allowance) || allowance === 0 || !isInt(remaining) || !isInt(inProgress)) return { kind: 'inconsistent' };
  if (remaining !== Math.max(allowance - completed, 0)) return { kind: 'inconsistent' };
  if (typeof newStarts !== 'boolean' || newStarts !== completed < allowance) return { kind: 'inconsistent' };
  const resetDate = period.reset_date;
  if (typeof resetDate !== 'string' || !/^\d{4}-\d{2}-01$/.test(resetDate)) return { kind: 'inconsistent' };
  return {
    kind: 'ok',
    planName: String(plan.name ?? ''),
    tierLabel: String(plan.tier ?? ''),
    completed, allowance, remaining, inProgress,
    newStartsAvailable: newStarts,
    resetDate,
    level: usageLevel(completed, allowance),
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

/** True when the database refused a new assessment start (allowance reached or no entitlement). */
export function isAssessmentStartUnavailable(error: unknown): boolean {
  return isObj(error) && typeof error.message === 'string' && error.message.includes('assessment_start_unavailable');
}
