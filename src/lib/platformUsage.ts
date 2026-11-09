// Platform-operator reporting for LLND Mate (cross-RTO). Every call is
// authorised on the server by public.llnd_is_platform_operator(), which uses the
// Issue #45 operator grant + MFA session. The browser holds no counts of its own.

import { supabase } from './supabase';

export interface RtoUsageRow {
  organisationId: string;
  organisationName: string;
  planCode: string | null;
  monthlyAllowance: number | null;
  totalInvitationsSent: number;
  monthInvitationsSent: number;
  monthNetUsage: number;
  monthRemaining: number | null;
  monthTestInvitations: number;
  totalTestInvitations: number;
  deletedInvitations: number;
  completedAssessments: number;
  restoredAssessments: number;
  counterConsistent: boolean;
}

export interface UsageHistoryRow { month: string; sent: number; refunded: number; net: number; tests: number; completed: number }

export interface DeletedAssessmentRow {
  invitationId: string;
  organisationName: string;
  learnerName: string;
  learnerEmail: string;
  isTest: boolean;
  invitedAt: string;
  priorStatus: 'not_started' | 'in_progress' | 'completed' | string | null;
  deletedAt: string | null;
  deletedByEmail: string | null;
  restorationStatus: 'deleted' | 'restored';
  restoredAt: string | null;
  restoredByEmail: string | null;
}

export type Loaded<T> = { kind: 'ok'; data: T } | { kind: 'unauthorised' } | { kind: 'error' };

const n = (v: unknown) => (typeof v === 'number' ? v : Number(v ?? 0));
const isDenied = (e: { code?: string; message?: string }) => e.code === '42501' || /not_authorised|permission denied/i.test(e.message ?? '');

export function mapUsageRow(r: Record<string, unknown>): RtoUsageRow {
  return {
    organisationId: String(r.organisation_id),
    organisationName: String(r.organisation_name ?? ''),
    planCode: (r.plan_code as string) ?? null,
    monthlyAllowance: r.monthly_allowance == null ? null : n(r.monthly_allowance),
    totalInvitationsSent: n(r.total_invitations_sent),
    monthInvitationsSent: n(r.month_invitations_sent),
    monthNetUsage: n(r.month_net_usage),
    monthRemaining: r.month_remaining == null ? null : n(r.month_remaining),
    monthTestInvitations: n(r.month_test_invitations),
    totalTestInvitations: n(r.total_test_invitations),
    deletedInvitations: n(r.deleted_invitations),
    completedAssessments: n(r.completed_assessments),
    restoredAssessments: n(r.restored_assessments),
    counterConsistent: r.counter_consistent === true,
  };
}

export async function fetchRtoUsage(month: string | null, search: string): Promise<Loaded<RtoUsageRow[]>> {
  try {
    const { data, error } = await supabase.rpc('platform_invitation_usage', { p_month: month, p_search: search.trim() || null });
    if (error) return isDenied(error) ? { kind: 'unauthorised' } : { kind: 'error' };
    return { kind: 'ok', data: ((data ?? []) as Record<string, unknown>[]).map(mapUsageRow) };
  } catch { return { kind: 'error' }; }
}

export async function fetchUsageHistory(organisationId: string): Promise<Loaded<UsageHistoryRow[]>> {
  try {
    const { data, error } = await supabase.rpc('platform_invitation_usage_history', { p_organisation_id: organisationId });
    if (error) return isDenied(error) ? { kind: 'unauthorised' } : { kind: 'error' };
    return { kind: 'ok', data: ((data ?? []) as Record<string, unknown>[]).map((r) => ({
      month: String(r.period_month), sent: n(r.invitations_sent), refunded: n(r.refunded), net: n(r.net_usage), tests: n(r.test_invitations), completed: n(r.completed),
    })) };
  } catch { return { kind: 'error' }; }
}

export async function fetchDeletedAssessments(search: string, includeRestored: boolean): Promise<Loaded<DeletedAssessmentRow[]>> {
  try {
    const { data, error } = await supabase.rpc('platform_deleted_assessments', { p_search: search.trim() || null, p_include_restored: includeRestored });
    if (error) return isDenied(error) ? { kind: 'unauthorised' } : { kind: 'error' };
    return { kind: 'ok', data: ((data ?? []) as Record<string, unknown>[]).map((r) => ({
      invitationId: String(r.invitation_id), organisationName: String(r.organisation_name ?? ''),
      learnerName: String(r.learner_name ?? ''), learnerEmail: String(r.learner_email ?? ''), isTest: r.is_test === true,
      invitedAt: String(r.invited_at ?? ''), priorStatus: (r.prior_status as string) ?? null,
      deletedAt: (r.deleted_at as string) ?? null, deletedByEmail: (r.deleted_by_email as string) ?? null,
      restorationStatus: r.restoration_status === 'restored' ? 'restored' : 'deleted',
      restoredAt: (r.restored_at as string) ?? null, restoredByEmail: (r.restored_by_email as string) ?? null,
    })) };
  } catch { return { kind: 'error' }; }
}

export async function restoreAssessment(invitationId: string, note: string): Promise<{ ok: true; already: boolean } | { ok: false; message: string }> {
  try {
    const { data, error } = await supabase.rpc('restore_assessment_assignment', { p_invitation_id: invitationId, p_note: note.trim() || null });
    if (error) return { ok: false, message: isDenied(error) ? 'Only platform operators with an MFA session can restore assessments.' : 'The assessment could not be restored.' };
    const status = (data as { status?: string } | null)?.status;
    return { ok: true, already: status === 'already_active' };
  } catch { return { ok: false, message: 'The assessment could not be restored.' }; }
}

/** "2026-11" for a month input; null means the current AEST month on the server. */
export function monthParam(value: string): string | null {
  return /^\d{4}-\d{2}$/.test(value) ? `${value}-01` : null;
}

export const PRIOR_STATUS_LABEL: Record<string, string> = { not_started: 'Not started', in_progress: 'In progress', completed: 'Completed' };
