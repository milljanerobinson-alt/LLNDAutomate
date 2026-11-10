import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";
import { operatorDeniedResponse, requirePlatformOperator } from "../_shared/platform-operator.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, PUT, DELETE, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization, X-Client-Info, Apikey",
};

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
    const { stripe_secret_key, stripe_webhook_secret } = await req.json();
    if (!stripe_secret_key) {
      return new Response(JSON.stringify({ error: "stripe_secret_key is required" }), {
        status: 400,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const supabase = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
    );

    const secrets: Record<string, string> = { STRIPE_SECRET_KEY: stripe_secret_key };
    if (stripe_webhook_secret) {
      secrets["STRIPE_WEBHOOK_SECRET"] = stripe_webhook_secret;
    }

    // Store in vault
    for (const [name, value] of Object.entries(secrets)) {
      const { error } = await supabase.rpc("vault_upsert_secret", {
        p_name: name,
        p_secret: value,
      }).maybeSingle();
      if (error) {
        // vault_upsert_secret may not exist — fall back to settings table
        await supabase.from("settings").upsert({ key: name, value }, { onConflict: "key" });
      }
    }

    // Validate key by calling Stripe
    const testRes = await fetch("https://api.stripe.com/v1/account", {
      headers: { Authorization: `Bearer ${stripe_secret_key}` },
    });

    if (!testRes.ok) {
      return new Response(
        JSON.stringify({ error: "Invalid Stripe secret key — could not authenticate with Stripe" }),
        { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } },
      );
    }

    const account = await testRes.json();

    return new Response(
      JSON.stringify({ success: true, account_id: account.id, display_name: account.settings?.dashboard?.display_name }),
      { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } },
    );
  } catch (err) {
    return new Response(
      JSON.stringify({ error: err instanceof Error ? err.message : "Unknown error" }),
      { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } },
    );
  }
});
