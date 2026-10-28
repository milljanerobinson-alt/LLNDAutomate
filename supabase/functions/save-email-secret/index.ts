import { createClient } from "jsr:@supabase/supabase-js@2";
import { operatorDeniedResponse, requirePlatformOperator } from "../_shared/platform-operator.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, PUT, DELETE, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization, X-Client-Info, Apikey",
};

async function verifyAdmin(req: Request) {
  const authHeader = req.headers.get("Authorization");
  if (!authHeader?.startsWith("Bearer ")) return null;

  const token = authHeader.replace("Bearer ", "");
  const anonClient = createClient(
    Deno.env.get("SUPABASE_URL")!,
    Deno.env.get("SUPABASE_ANON_KEY")!,
  );
  const { data: { user }, error } = await anonClient.auth.getUser(token);
  if (error || !user) return null;

  const serviceClient = createClient(
    Deno.env.get("SUPABASE_URL")!,
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
  );
  const { data: profile } = await serviceClient
    .from("profiles")
    .select("role")
    .eq("id", user.id)
    .maybeSingle();

  // Issue #45: operator status (grant + MFA) is enforced by requirePlatformOperator() in the request handler; the legacy profiles.role check is retired.
  if (!profile) return null;

  return user;
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { status: 200, headers: corsHeaders });
  }

  // Issue #45: platform operators with MFA only (no service-role bypass for platform credentials).
  {
    const operatorCheck = await requirePlatformOperator(req.headers.get("Authorization"), { allowServiceRole: false });
    if (!operatorCheck.ok) return operatorDeniedResponse(operatorCheck, corsHeaders);
  }

  try {
    const user = await verifyAdmin(req);
    if (!user) {
      return new Response(JSON.stringify({ error: "Unauthorized" }), {
        status: 401,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const { api_key } = await req.json();

    if (!api_key || typeof api_key !== "string" || !api_key.startsWith("re_")) {
      return new Response(
        JSON.stringify({ error: "A valid Resend API key (starting with re_) is required." }),
        { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } },
      );
    }

    // Validate key against Resend API
    const testRes = await fetch("https://api.resend.com/domains", {
      headers: { Authorization: `Bearer ${api_key}` },
    });

    if (!testRes.ok) {
      return new Response(
        JSON.stringify({ error: "Invalid Resend API key — could not authenticate with Resend." }),
        { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } },
      );
    }

    const supabase = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!
    );

    // Try vault first, fall back to settings table
    const { error: vaultError } = await supabase.rpc("vault_upsert_secret", {
      p_name: "RESEND_API_KEY",
      p_secret: api_key,
    }).maybeSingle();

    if (vaultError) {
      await supabase
        .from("settings")
        .upsert({ key: "RESEND_API_KEY", value: api_key }, { onConflict: "key" });
    }

    return new Response(
      JSON.stringify({ success: true, message: "Resend API key saved successfully. Emails will now be sent automatically." }),
      { headers: { ...corsHeaders, "Content-Type": "application/json" } },
    );
  } catch (_err) {
    return new Response(
      JSON.stringify({ error: "An internal error occurred." }),
      { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } },
    );
  }
});
