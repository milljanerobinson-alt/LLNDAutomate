import { createClient } from "jsr:@supabase/supabase-js@2";
import { isApprovedOrigin, parseOrigin } from "./origin-policy.ts";

const allowed = new Set(["administration","candidate_support","technical"]);

function configuredOrigins() {
  const siteUrl = parseOrigin(Deno.env.get("PUBLIC_SITE_URL"));
  if (!siteUrl) throw new Error("PUBLIC_SITE_URL is required and must be a valid HTTP(S) origin");
  const allowlist = (Deno.env.get("INVITATION_REDIRECT_ALLOWLIST") ?? "")
    .split(",")
    .map((value) => parseOrigin(value))
    .filter((value): value is string => Boolean(value));
  return { siteUrl, allowlist };
}

function approvedSiteUrl(req: Request) {
  const { siteUrl, allowlist } = configuredOrigins();
  const origin = req.headers.get("origin");
  if (origin && !isApprovedOrigin(origin, siteUrl, allowlist)) throw new Error("Invitation origin is not approved");
  return siteUrl;
}

function corsHeaders(req: Request) {
  const headers: Record<string, string> = {
    "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Vary": "Origin",
  };
  const origin = req.headers.get("origin");
  try {
    const { siteUrl, allowlist } = configuredOrigins();
    if (origin && isApprovedOrigin(origin, siteUrl, allowlist)) {
      headers["Access-Control-Allow-Origin"] = parseOrigin(origin)!;
    }
  } catch {
    // Missing or invalid configuration fails closed: no origin is reflected.
  }
  return headers;
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders(req) });
  try {
    const authorization = req.headers.get("Authorization") ?? "";
    const userClient = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_ANON_KEY")!, {
      global: { headers: { Authorization: authorization } },
    });
    const { data: { user } } = await userClient.auth.getUser();
    if (!user) return json({ error: "Authentication required" }, 401, req);
    const { data: access } = await userClient.from("user_workspace_access").select("organisation_id")
      .eq("user_id", user.id).eq("workspace", "administration").maybeSingle();
    if (!access) return json({ error: "Administration access required" }, 403, req);

    const { email, fullName, workspaces } = await req.json();
    const selected = Array.isArray(workspaces) ? [...new Set(workspaces)] : [];
    if (typeof email !== "string" || !email.includes("@") || !selected.length || selected.some(w => !allowed.has(w))) {
      return json({ error: "Valid email and workspace access are required" }, 400, req);
    }
    const service = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);
    const siteUrl = approvedSiteUrl(req);
    const redirectTo = `${siteUrl.replace(/\/$/, "")}/#/llnd-automate/login`;
    const normalEmail = email.trim().toLowerCase();
    const { data: grantId, error: grantError } = await service.rpc("prepare_staff_invitation", {
      p_email: normalEmail,
      p_full_name: String(fullName ?? "").trim(),
      p_organisation_id: access.organisation_id,
      p_workspaces: selected,
      p_inviter_id: user.id,
    });
    if (grantError || !grantId) return json({ error: grantError?.message ?? "Invitation grant could not be prepared" }, 400, req);
    const { data, error } = await service.auth.admin.inviteUserByEmail(email.trim().toLowerCase(), {
      redirectTo,
      data: { full_name: String(fullName ?? "").trim(), invitation_grant_id: grantId },
    });
    if (error || !data.user) {
      const { error: reconciliationError } = await service.rpc("reconcile_staff_invitation", {
        p_grant_id: grantId,
      });
      if (!reconciliationError) return json({ invited: true, reconciled: true }, 200, req);
      return json({ error: error?.message ?? reconciliationError?.message ?? "Invitation failed", retryable: true }, 400, req);
    }
    const { error: linkedError } = await service.rpc("link_staff_invitation", {
      p_grant_id: grantId,
      p_user_id: data.user.id,
    });
    if (linkedError) return json({ error: linkedError.message, retryable: true, invitationSent: true }, 500, req);
    return json({ invited: true }, 200, req);
  } catch (error) {
    return json({ error: error instanceof Error ? error.message : "Invitation failed" }, 500, req);
  }
});

function json(body: unknown, status = 200, req?: Request) {
  return new Response(JSON.stringify(body), { status, headers: { ...(req ? corsHeaders(req) : {}), "Content-Type": "application/json" } });
}
