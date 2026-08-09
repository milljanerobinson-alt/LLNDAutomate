import { createClient } from "jsr:@supabase/supabase-js@2";

const cors = {"Access-Control-Allow-Origin":"*","Access-Control-Allow-Headers":"authorization, apikey, content-type"};
const allowed = new Set(["administration","candidate_support","technical"]);

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  try {
    const authorization = req.headers.get("Authorization") ?? "";
    const userClient = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_ANON_KEY")!, {
      global: { headers: { Authorization: authorization } },
    });
    const { data: { user } } = await userClient.auth.getUser();
    if (!user) return json({ error: "Authentication required" }, 401);
    const { data: access } = await userClient.from("user_workspace_access").select("organisation_id")
      .eq("user_id", user.id).eq("workspace", "administration").maybeSingle();
    if (!access) return json({ error: "Administration access required" }, 403);

    const { email, fullName, workspaces } = await req.json();
    const selected = Array.isArray(workspaces) ? [...new Set(workspaces)] : [];
    if (typeof email !== "string" || !email.includes("@") || !selected.length || selected.some(w => !allowed.has(w))) {
      return json({ error: "Valid email and workspace access are required" }, 400);
    }
    const service = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);
    const siteUrl = Deno.env.get("PUBLIC_SITE_URL") ?? req.headers.get("origin") ?? "";
    const redirectTo = `${siteUrl.replace(/\/$/, "")}/#/llnd-automate/login`;
    const { data, error } = await service.auth.admin.inviteUserByEmail(email.trim().toLowerCase(), {
      redirectTo,
      data: { full_name: String(fullName ?? "").trim(), organisation_id: access.organisation_id, workspaces: selected },
    });
    if (error || !data.user) return json({ error: error?.message ?? "Invitation failed" }, 400);
    await service.from("organisation_memberships").upsert({
      organisation_id: access.organisation_id, user_id: data.user.id, status: "active",
      invited_email: email.trim().toLowerCase(), invited_by: user.id,
    }, { onConflict: "organisation_id,user_id" });
    await service.from("user_workspace_access").delete().eq("organisation_id", access.organisation_id).eq("user_id", data.user.id);
    await service.from("user_workspace_access").insert(selected.map((workspace, i) => ({
      organisation_id: access.organisation_id, user_id: data.user!.id, workspace, is_primary: i === 0,
    })));
    return json({ invited: true });
  } catch (error) {
    return json({ error: error instanceof Error ? error.message : "Invitation failed" }, 500);
  }
});

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { ...cors, "Content-Type": "application/json" } });
}
