// Issue #45 — platform-operator checks for Edge Functions.
//
// The database is the single source of truth: is_platform_operator() is true
// only for an active, explicitly granted operator whose current session has
// passed MFA (aal2). Edge Functions ask the database with the caller's own
// token, so operator status can't be asserted by the client, inferred from
// RTO workspaces, or taken from the legacy profiles.role value.

import { createClient } from "jsr:@supabase/supabase-js@2";

export type OperatorCheck =
  | { ok: true; via: "operator"; userId: string }
  | { ok: true; via: "service" }
  | { ok: false; status: 401 | 403; message: string };

function isServiceRoleBearer(authHeader: string | null): boolean {
  const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";
  return !!serviceKey && authHeader === `Bearer ${serviceKey}`;
}

/** A Supabase client acting as the caller (their JWT), for operator-only RPCs. */
export function callerClient(authHeader: string) {
  return createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_ANON_KEY")!, {
    global: { headers: { Authorization: authHeader } },
    auth: { persistSession: false, autoRefreshToken: false },
  });
}

/**
 * Allows only a platform operator with MFA. When allowServiceRole is true,
 * trusted server-to-server calls made with the service-role key also pass
 * (they never come from a browser).
 */
export async function requirePlatformOperator(
  authHeader: string | null,
  options: { allowServiceRole?: boolean } = {},
): Promise<OperatorCheck> {
  if (options.allowServiceRole && isServiceRoleBearer(authHeader)) return { ok: true, via: "service" };
  if (!authHeader?.startsWith("Bearer ")) return { ok: false, status: 401, message: "Authentication required" };

  const client = callerClient(authHeader);
  const { data: { user }, error: userError } = await client.auth.getUser(authHeader.slice("Bearer ".length));
  if (userError || !user) return { ok: false, status: 401, message: "Authentication required" };

  const { data: isOperator, error } = await client.rpc("is_platform_operator");
  if (error || isOperator !== true) {
    return { ok: false, status: 403, message: "Platform operator access with MFA is required" };
  }
  return { ok: true, via: "operator", userId: user.id };
}

export function operatorDeniedResponse(check: Extract<OperatorCheck, { ok: false }>, corsHeaders: Record<string, string>) {
  return new Response(JSON.stringify({ error: check.message }), {
    status: check.status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}
