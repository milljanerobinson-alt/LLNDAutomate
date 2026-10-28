// Issue #45 — platform-operator client helpers.
//
// The browser never decides operator status itself. Every answer comes from
// the database (platform_operator_status / is_platform_operator), which needs
// an explicit grant AND an MFA-verified (aal2) session. Holding all three RTO
// workspaces, or the legacy profiles.role = 'admin', never makes someone an
// operator.

import { supabase } from './supabase';

export interface SupportSession {
  session_id: string;
  organisation_id: string;
  organisation_name: string;
  reason: string;
  started_at: string;
  expires_at: string;
}

export interface PlatformOperatorStatus {
  granted: boolean;
  mfa_verified: boolean;
  operator: boolean;
  session: SupportSession | null;
}

export const SUPPORT_VIEWS = [
  { id: 'organisation_summary', label: 'Organisation summary' },
  { id: 'staff_list', label: 'Staff and statuses' },
  { id: 'integration_status', label: 'Integration and sync status' },
  { id: 'email_activity', label: 'Email activity' },
  { id: 'qualification_list', label: 'Qualifications' },
  { id: 'subscription_status', label: 'Subscription status' },
] as const;
export type SupportViewId = typeof SUPPORT_VIEWS[number]['id'];

export const SUPPORT_VIEW_LABELS: Record<string, string> = Object.fromEntries(SUPPORT_VIEWS.map(v => [v.id, v.label]));

export const NOT_OPERATOR: PlatformOperatorStatus = { granted: false, mfa_verified: false, operator: false, session: null };

export async function getPlatformOperatorStatus(): Promise<PlatformOperatorStatus> {
  const { data, error } = await supabase.rpc('platform_operator_status');
  if (error || !data || typeof data !== 'object') return NOT_OPERATOR;
  const d = data as Partial<PlatformOperatorStatus>;
  return {
    granted: d.granted === true,
    mfa_verified: d.mfa_verified === true,
    operator: d.operator === true,
    session: d.session ?? null,
  };
}

export async function listOrganisationsForSupport(): Promise<Array<{ organisation_id: string; organisation_name: string }>> {
  const { data, error } = await supabase.rpc('list_organisations_for_support');
  if (error) throw new Error(error.message);
  return (data ?? []) as Array<{ organisation_id: string; organisation_name: string }>;
}

export async function startSupportSession(organisationId: string, reason: string, minutes = 60): Promise<SupportSession> {
  const { data, error } = await supabase.rpc('start_operator_support_session', {
    p_organisation_id: organisationId, p_reason: reason, p_minutes: minutes,
  });
  if (error) throw new Error(error.message);
  const row = Array.isArray(data) ? data[0] : data;
  return row as SupportSession;
}

export async function endSupportSession(): Promise<void> {
  const { error } = await supabase.rpc('end_operator_support_session');
  if (error) throw new Error(error.message);
}

export async function fetchSupportView(resource: SupportViewId, organisationId: string): Promise<unknown> {
  const { data, error } = await supabase.functions.invoke('operator-support', {
    body: { resource, organisation_id: organisationId },
  });
  if (error) throw new Error(error.message);
  return (data as { data?: unknown })?.data;
}

export interface PlatformSupportAccessRow {
  session_id: string;
  operator_name: string;
  reason: string;
  started_at: string;
  ended_at: string;
  information_viewed: string[];
}

/** RTO Administration only: platform support access to the caller's own RTO. */
export async function listPlatformSupportAccess(): Promise<PlatformSupportAccessRow[]> {
  const { data, error } = await supabase.rpc('list_platform_support_access');
  if (error) throw new Error(error.message);
  return (data ?? []) as PlatformSupportAccessRow[];
}

export function formatTime(iso: string | null | undefined): string {
  if (!iso) return '';
  return new Date(iso).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}
