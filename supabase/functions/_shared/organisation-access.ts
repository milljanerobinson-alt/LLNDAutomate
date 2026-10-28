// Issue #40 — organisation-aware access checks for Edge Functions.
//
// Staff access is decided by active organisation membership and workspace
// permission (Administration / Candidate Support / Technical), never by the
// legacy profiles.role value.
//
// aXcelerate credentials are still stored once for the platform (in the
// service-only `settings` table) and belong to the legacy RTO recorded in
// settings key `legacy_server_settings_organisation_id`. Until credentials are
// stored per organisation, only staff of that RTO may use or change the
// integration, and server-side processing is limited to that RTO's rows.

import { createClient, type SupabaseClient } from "jsr:@supabase/supabase-js@2";

export type Workspace = "administration" | "candidate_support" | "technical";

export type StaffContext = {
  userId: string;
  organisationId: string;
  workspaces: Workspace[];
};

export function serviceClient(): SupabaseClient {
  return createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);
}

/** Resolves the caller's active RTO membership and workspaces from their JWT. */
export async function getStaffContext(
  authHeader: string | null,
  service: SupabaseClient = serviceClient(),
): Promise<StaffContext | null> {
  if (!authHeader?.startsWith("Bearer ")) return null;
  const token = authHeader.slice("Bearer ".length);
  const { data: { user }, error } = await service.auth.getUser(token);
  if (error || !user) return null;

  const { data: membership } = await service
    .from("organisation_memberships")
    .select("organisation_id,status")
    .eq("user_id", user.id)
    .eq("status", "active")
    .maybeSingle();
  if (!membership?.organisation_id) return null;

  const { data: profile } = await service
    .from("profiles").select("is_active").eq("id", user.id).maybeSingle();
  if (!profile?.is_active) return null;

  const { data: access } = await service
    .from("user_workspace_access")
    .select("workspace")
    .eq("user_id", user.id)
    .eq("organisation_id", membership.organisation_id);

  return {
    userId: user.id,
    organisationId: membership.organisation_id as string,
    workspaces: (access ?? []).map((row: { workspace: string }) => row.workspace as Workspace),
  };
}

export function hasAnyWorkspace(context: StaffContext | null, allowed: Workspace[]): boolean {
  return !!context && context.workspaces.some((workspace) => allowed.includes(workspace));
}

/** The RTO that owns the platform-level aXcelerate credentials, if recorded. */
export async function getIntegrationOrganisationId(
  service: SupabaseClient = serviceClient(),
): Promise<string | null> {
  const { data } = await service
    .from("settings").select("value").eq("key", "legacy_server_settings_organisation_id").maybeSingle();
  const value = data?.value;
  return typeof value === "string" && value ? value : null;
}

/**
 * True when the caller is active staff of the RTO that owns the aXcelerate
 * integration and holds one of the allowed workspaces.
 */
export async function isIntegrationStaff(
  authHeader: string | null,
  allowed: Workspace[],
  service: SupabaseClient = serviceClient(),
): Promise<boolean> {
  const [context, integrationOrganisationId] = await Promise.all([
    getStaffContext(authHeader, service),
    getIntegrationOrganisationId(service),
  ]);
  return !!integrationOrganisationId
    && context?.organisationId === integrationOrganisationId
    && hasAnyWorkspace(context, allowed);
}

export type OrganisationEmailProfile = {
  // deno-lint-ignore no-explicit-any
  branding: Record<string, any>;
  // deno-lint-ignore no-explicit-any
  emailSettings: Record<string, any>;
  // deno-lint-ignore no-explicit-any
  notificationSettings: Record<string, any>;
};

const emptyEmailProfile = (): OrganisationEmailProfile => ({ branding: {}, emailSettings: {}, notificationSettings: {} });

/**
 * One RTO's own branding, email and notification settings (Issue #40).
 * Unknown or missing organisations get empty settings, so callers fall back to
 * neutral defaults instead of another RTO's branding.
 */
export async function getOrganisationEmailProfile(
  organisationId: string | null | undefined,
  service: SupabaseClient = serviceClient(),
): Promise<OrganisationEmailProfile> {
  const profile = emptyEmailProfile();
  if (!organisationId) return profile;
  const { data } = await service
    .from("organisation_settings")
    .select("key, value")
    .eq("organisation_id", organisationId)
    .in("key", ["org_branding", "email_settings", "notification_settings"]);
  for (const row of (data ?? []) as Array<{ key: string; value: unknown }>) {
    const value = row.value && typeof row.value === "object" ? row.value as Record<string, unknown> : {};
    if (row.key === "org_branding") profile.branding = value;
    if (row.key === "email_settings") profile.emailSettings = value;
    if (row.key === "notification_settings") profile.notificationSettings = value;
  }
  return profile;
}

/** Caches organisation email profiles for batch jobs that span several RTOs. */
export function createEmailProfileCache(service: SupabaseClient = serviceClient()) {
  const cache = new Map<string, Promise<OrganisationEmailProfile>>();
  return (organisationId: string | null | undefined): Promise<OrganisationEmailProfile> => {
    if (!organisationId) return Promise.resolve(emptyEmailProfile());
    if (!cache.has(organisationId)) cache.set(organisationId, getOrganisationEmailProfile(organisationId, service));
    return cache.get(organisationId)!;
  };
}
