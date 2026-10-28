import { createClient } from "jsr:@supabase/supabase-js@2";
import { isIntegrationStaff } from "../_shared/organisation-access.ts";

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

function isValidAxcelerateUrl(urlStr: string): boolean {
  try {
    const parsed = new URL(urlStr);
    if (!["https:", "http:"].includes(parsed.protocol)) return false;
    const host = parsed.hostname.toLowerCase();
    if (host === "localhost" || host === "127.0.0.1" || host === "0.0.0.0") return false;
    if (host.startsWith("169.254.") || host.startsWith("10.") || host.startsWith("192.168.")) return false;
    if (host === "metadata.google.internal" || host.endsWith(".internal") || host.endsWith(".local")) return false;
    if (host.startsWith("172.")) {
      const second = parseInt(host.split(".")[1], 10);
      if (second >= 16 && second <= 31) return false;
    }
    return true;
  } catch {
    return false;
  }
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
    const anonClient = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_ANON_KEY")!);
    const { data: { user }, error: userError } = await anonClient.auth.getUser(token);
    if (userError || !user) return unauthorized(`invalid session token — ${userError?.message ?? "no user"}`);

    const serviceClient = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);
    const { data: profile, error: profileError } = await serviceClient
      .from("profiles").select("role").eq("id", user.id).maybeSingle();

    if (profileError) return unauthorized(`profile lookup failed — ${profileError.message}`);
    if (!profile) return unauthorized(`no profile found for user ${user.id}`);
    // Issue #40: workspace permission in the RTO that owns the integration,
    // not the legacy profile role.
    if (!(await isIntegrationStaff(authHeader, ["administration", "technical"], serviceClient))) {
      return unauthorized("Administration or Technical access in the RTO that owns this aXcelerate integration is required");
    }

    const { api_base_url } = await req.json();

    if (!api_base_url || typeof api_base_url !== "string") {
      return new Response(
        JSON.stringify({ error: "API base URL is required." }),
        { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } },
      );
    }

    if (!isValidAxcelerateUrl(api_base_url)) {
      return new Response(
        JSON.stringify({ error: "Invalid URL. Only public HTTPS URLs are allowed." }),
        { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } },
      );
    }

    // Load stored API token and WS token to make an authenticated test request
    const { data: tokenSetting } = await serviceClient
      .from("settings")
      .select("value")
      .eq("key", "axcelerate_api_token")
      .maybeSingle();

    const { data: wsTokenSetting } = await serviceClient
      .from("settings")
      .select("value")
      .eq("key", "axcelerate_ws_token")
      .maybeSingle();

    const apiToken: string | null = typeof tokenSetting?.value === "string" ? tokenSetting.value : null;
    const wsToken: string | null = typeof wsTokenSetting?.value === "string" ? wsTokenSetting.value : null;

    const base = api_base_url.replace(/\/$/, "");

    // aXcelerate uses header-based auth: apitoken + wstoken headers
    const axHeaders: Record<string, string> = { "Accept": "application/json" };
    if (apiToken) axHeaders["apitoken"] = apiToken;
    if (wsToken) axHeaders["wstoken"] = wsToken;

    // Correct endpoint is /courses/ (plural). Try with and without trailing slash.
    const candidates = apiToken
      ? [`${base}/courses/`, `${base}/courses`]
      : [base];

    try {
      let lastStatus = 0;
      let lastBody = "";
      for (const testUrl of candidates) {
        const response = await fetch(testUrl, {
          method: "GET",
          headers: axHeaders,
          signal: AbortSignal.timeout(10000),
        });
        lastStatus = response.status;

        if (response.ok) {
          return new Response(
            JSON.stringify({ success: true, message: "Connected and authenticated successfully." }),
            { headers: { ...corsHeaders, "Content-Type": "application/json" } },
          );
        }

        if (response.status === 401 || response.status === 403) {
          return new Response(
            JSON.stringify({ success: false, error: `Server reached but credentials were rejected (${response.status}). Check your API token and WS token.` }),
            { status: 502, headers: { ...corsHeaders, "Content-Type": "application/json" } },
          );
        }

        lastBody = await response.text().catch(() => "");
        // 404/405 — try next candidate
      }

      return new Response(
        JSON.stringify({ success: false, error: `aXcelerate returned ${lastStatus}. Check the base URL (should end in /api, e.g. https://yourcompany.axcelerate.com.au/api).` }),
        { status: 502, headers: { ...corsHeaders, "Content-Type": "application/json" } },
      );
    } catch {
      return new Response(
        JSON.stringify({ success: false, error: "Could not reach the aXcelerate API. Check the base URL." }),
        { status: 502, headers: { ...corsHeaders, "Content-Type": "application/json" } },
      );
    }
  } catch (err) {
    return new Response(
      JSON.stringify({ error: `Internal error: ${err instanceof Error ? err.message : String(err)}` }),
      { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } },
    );
  }
});
