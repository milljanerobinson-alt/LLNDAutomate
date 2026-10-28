import { createClient } from "jsr:@supabase/supabase-js@2";
import { getIntegrationOrganisationId, getStaffContext, hasAnyWorkspace } from "../_shared/organisation-access.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, PUT, DELETE, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization, X-Client-Info, Apikey",
};

function unauthorized(reason: string) {
  return new Response(JSON.stringify({ error: `Unauthorized: ${reason}` }), {
    status: 401,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { status: 200, headers: corsHeaders });
  }

  try {
    const authHeader = req.headers.get("Authorization");
    if (!authHeader?.startsWith("Bearer ")) {
      return unauthorized("missing or malformed Authorization header");
    }

    const token = authHeader.replace("Bearer ", "");
    const anonClient = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_ANON_KEY")!,
    );
    const { data: { user }, error: userError } = await anonClient.auth.getUser(token);
    if (userError || !user) {
      return unauthorized(`invalid session token — ${userError?.message ?? "no user"}`);
    }

    const serviceClient = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
    );
    const { data: profile, error: profileError } = await serviceClient
      .from("profiles")
      .select("role")
      .eq("id", user.id)
      .maybeSingle();

    if (profileError) {
      return unauthorized(`profile lookup failed — ${profileError.message}`);
    }
    if (!profile) {
      return unauthorized(`no profile found for user ${user.id}`);
    }
    // Issue #40: workspace permission in the RTO that owns the integration.
    // When no owner is recorded yet and no credentials exist, the first
    // Administration/Technical user to save credentials claims it for their RTO.
    const staff = await getStaffContext(authHeader, serviceClient);
    if (!hasAnyWorkspace(staff, ["administration", "technical"])) {
      return unauthorized("Administration or Technical workspace access is required");
    }
    const integrationOrganisationId = await getIntegrationOrganisationId(serviceClient);
    if (integrationOrganisationId && integrationOrganisationId !== staff!.organisationId) {
      return unauthorized("aXcelerate credentials are managed by the RTO that owns this integration");
    }
    if (!integrationOrganisationId) {
      const { data: existingTokens } = await serviceClient
        .from("settings").select("key").in("key", ["axcelerate_api_token", "axcelerate_ws_token"]);
      if ((existingTokens ?? []).length > 0) {
        return unauthorized("aXcelerate integration owner is not recorded; ask the platform operator to record it");
      }
      const { error: claimError } = await serviceClient.from("settings").insert({
        key: "legacy_server_settings_organisation_id",
        value: staff!.organisationId,
        updated_at: new Date().toISOString(),
      });
      if (claimError) return unauthorized("aXcelerate integration owner could not be recorded");
    }

    const { api_token, ws_token } = await req.json();

    if (!api_token && !ws_token) {
      return new Response(
        JSON.stringify({ error: "No tokens provided." }),
        { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } },
      );
    }

    // Store token values in settings table so they can be displayed and used by other functions
    if (api_token) {
      const { error } = await serviceClient
        .from("settings")
        .upsert({ key: "axcelerate_api_token", value: api_token, updated_at: new Date().toISOString() });
      if (error) throw new Error(`Failed to save API token: ${error.message}`);
    }

    if (ws_token) {
      const { error } = await serviceClient
        .from("settings")
        .upsert({ key: "axcelerate_ws_token", value: ws_token, updated_at: new Date().toISOString() });
      if (error) throw new Error(`Failed to save WS token: ${error.message}`);
    }

    return new Response(
      JSON.stringify({ success: true, message: "Credentials saved successfully." }),
      { headers: { ...corsHeaders, "Content-Type": "application/json" } },
    );
  } catch (err) {
    return new Response(
      JSON.stringify({ error: `Internal error: ${err instanceof Error ? err.message : String(err)}` }),
      { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } },
    );
  }
});
