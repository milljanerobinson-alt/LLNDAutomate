import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";
import { getStaffContext, hasAnyWorkspace } from "../_shared/organisation-access.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, PUT, DELETE, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization, X-Client-Info, Apikey",
};

async function getStripeKey(supabase: ReturnType<typeof createClient>): Promise<string | null> {
  const { data } = await supabase.from("settings").select("value").eq("key", "STRIPE_SECRET_KEY").maybeSingle();
  return data?.value ?? null;
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { status: 200, headers: corsHeaders });
  }

  const supabase = createClient(
    Deno.env.get("SUPABASE_URL")!,
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
  );

  // Issue #40: only Administration staff may open billing for their own RTO.
  const staff = await getStaffContext(req.headers.get("Authorization"), supabase);
  if (!hasAnyWorkspace(staff, ["administration"])) {
    return new Response(JSON.stringify({ error: "Unauthorized" }), {
      status: 401, headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }

  try {
    const { plan_id, success_url, cancel_url } = await req.json();

    const stripeKey = await getStripeKey(supabase);
    if (!stripeKey) {
      return new Response(
        JSON.stringify({ error: "Stripe is not configured. Add your Stripe secret key in Settings." }),
        { status: 503, headers: { ...corsHeaders, "Content-Type": "application/json" } },
      );
    }

    // Get plan details
    const { data: plan } = await supabase
      .from("subscription_plans")
      .select("*")
      .eq("id", plan_id)
      .single();

    if (!plan) {
      return new Response(
        JSON.stringify({ error: "Plan not found" }),
        { status: 404, headers: { ...corsHeaders, "Content-Type": "application/json" } },
      );
    }

    // Get existing subscription for Stripe customer ID
    const { data: sub } = await supabase
      .from("subscriptions")
      .select("stripe_customer_id")
      .eq("organisation_id", staff!.organisationId)
      .order("created_at", { ascending: false })
      .limit(1)
      .maybeSingle();

    const sessionParams = new URLSearchParams({
      "mode": "subscription",
      "success_url": success_url ?? `${req.headers.get("origin") ?? ""}/`,
      "cancel_url": cancel_url ?? `${req.headers.get("origin") ?? ""}/`,
      "line_items[0][price_data][currency]": "aud",
      "line_items[0][price_data][product_data][name]": plan.name,
      "line_items[0][price_data][recurring][interval]": "month",
      "line_items[0][price_data][unit_amount]": String(plan.platform_fee_cents),
      "line_items[0][quantity]": "1",
      "metadata[plan_id]": plan_id,
      "metadata[organisation_id]": staff!.organisationId,
      "subscription_data[metadata][organisation_id]": staff!.organisationId,
      "allow_promotion_codes": "true",
    });

    if (sub?.stripe_customer_id) {
      sessionParams.set("customer", sub.stripe_customer_id);
    }

    // Add 14-day trial for new subscriptions without payment history
    if (!sub?.stripe_customer_id) {
      sessionParams.set("subscription_data[trial_period_days]", "14");
    }

    const stripeRes = await fetch("https://api.stripe.com/v1/checkout/sessions", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${stripeKey}`,
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: sessionParams.toString(),
    });

    const session = await stripeRes.json();
    if (!stripeRes.ok) {
      return new Response(
        JSON.stringify({ error: session.error?.message ?? "Stripe error" }),
        { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } },
      );
    }

    return new Response(
      JSON.stringify({ url: session.url, session_id: session.id }),
      { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } },
    );
  } catch (err) {
    return new Response(
      JSON.stringify({ error: err instanceof Error ? err.message : "Unknown error" }),
      { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } },
    );
  }
});
