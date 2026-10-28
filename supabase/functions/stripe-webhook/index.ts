import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, PUT, DELETE, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization, X-Client-Info, Apikey, stripe-signature",
};

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { status: 200, headers: corsHeaders });
  }

  const supabase = createClient(
    Deno.env.get("SUPABASE_URL")!,
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
  );

  const body = await req.text();
  const sig = req.headers.get("stripe-signature");

  // Verify webhook signature if secret is configured
  const { data: webhookSecretRow } = await supabase
    .from("settings")
    .select("value")
    .eq("key", "STRIPE_WEBHOOK_SECRET")
    .maybeSingle();

  const webhookSecret = typeof webhookSecretRow?.value === "string" ? webhookSecretRow.value : "";

  // Issue #40 billing integrity: verify Stripe's HMAC-SHA256 signature. Events
  // are refused when no webhook secret is configured, because an unverified
  // event could change another RTO's subscription.
  if (!webhookSecret) {
    return new Response(JSON.stringify({ error: "Stripe webhook secret is not configured" }), {
      status: 503,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
  if (!sig || !(await verifyStripeSignature(body, sig, webhookSecret))) {
    return new Response(JSON.stringify({ error: "Invalid Stripe signature" }), {
      status: 400,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }

  let event: Record<string, unknown>;
  try {
    event = JSON.parse(body);
  } catch {
    return new Response(JSON.stringify({ error: "Invalid JSON" }), {
      status: 400,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }

  const stripeEventId = event.id as string;
  const eventType = event.type as string;
  const data = event.data as Record<string, unknown>;
  const obj = data?.object as Record<string, unknown>;

  // Deduplicate events
  const { data: existing } = await supabase
    .from("billing_events")
    .select("id")
    .eq("stripe_event_id", stripeEventId)
    .maybeSingle();

  if (existing) {
    return new Response(JSON.stringify({ received: true, duplicate: true }), {
      status: 200,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }

  // Log the event
  const organisationId = await resolveEventOrganisation(supabase, obj);
  await supabase.from("billing_events").insert({
    organisation_id: organisationId,
    stripe_event_id: stripeEventId,
    event_type: eventType,
    amount_cents: obj?.amount_paid as number ?? obj?.amount_due as number ?? null,
    currency: (obj?.currency as string)?.toUpperCase() ?? "AUD",
    description: describeEvent(eventType, obj),
    invoice_url: obj?.hosted_invoice_url as string ?? null,
    invoice_pdf: obj?.invoice_pdf as string ?? null,
    payload: event,
    processed: false,
  });

  // Process known events
  try {
    switch (eventType) {
      case "checkout.session.completed":
        await handleCheckoutComplete(supabase, obj, organisationId);
        break;
      case "customer.subscription.updated":
        await handleSubscriptionUpdated(supabase, obj);
        break;
      case "customer.subscription.deleted":
        await handleSubscriptionDeleted(supabase, obj);
        break;
      case "invoice.payment_succeeded":
        await handlePaymentSucceeded(supabase, obj);
        break;
      case "invoice.payment_failed":
        await handlePaymentFailed(supabase, obj);
        break;
    }

    await supabase
      .from("billing_events")
      .update({ processed: true, processed_at: new Date().toISOString() })
      .eq("stripe_event_id", stripeEventId);
  } catch (err) {
    await supabase
      .from("billing_events")
      .update({ error: err instanceof Error ? err.message : String(err) })
      .eq("stripe_event_id", stripeEventId);
  }

  return new Response(JSON.stringify({ received: true }), {
    status: 200,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
});

function describeEvent(type: string, obj: Record<string, unknown>): string {
  switch (type) {
    case "invoice.payment_succeeded": return "Payment succeeded";
    case "invoice.payment_failed": return "Payment failed";
    case "checkout.session.completed": return "Checkout completed";
    case "customer.subscription.updated": return "Subscription updated";
    case "customer.subscription.deleted": return "Subscription cancelled";
    default: return type.replace(/[._]/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
  }
}

async function handleCheckoutComplete(
  supabase: ReturnType<typeof createClient>,
  obj: Record<string, unknown>,
  organisationId: string | null,
) {
  // Issue #40: a checkout must be attributable to exactly one RTO.
  if (!organisationId) throw new Error("Checkout session is not linked to an organisation");
  const customerId = obj.customer as string;
  const subscriptionId = obj.subscription as string;
  const metadata = obj.metadata as Record<string, string> ?? {};

  if (!subscriptionId) return;

  // Fetch subscription from Stripe
  const stripeKey = await getStripeKey(supabase);
  if (!stripeKey) return;

  const subRes = await fetch(`https://api.stripe.com/v1/subscriptions/${subscriptionId}`, {
    headers: { Authorization: `Bearer ${stripeKey}` },
  });
  const stripeSub = await subRes.json();

  const pmId = stripeSub.default_payment_method as string;
  let last4: string | null = null;
  let brand: string | null = null;
  let expMonth: number | null = null;
  let expYear: number | null = null;

  if (pmId) {
    const pmRes = await fetch(`https://api.stripe.com/v1/payment_methods/${pmId}`, {
      headers: { Authorization: `Bearer ${stripeKey}` },
    });
    const pm = await pmRes.json();
    last4 = pm.card?.last4 ?? null;
    brand = pm.card?.brand ?? null;
    expMonth = pm.card?.exp_month ?? null;
    expYear = pm.card?.exp_year ?? null;
  }

  const periodStart = new Date(stripeSub.current_period_start * 1000).toISOString();
  const periodEnd = new Date(stripeSub.current_period_end * 1000).toISOString();

  const { data: existingSub } = await supabase
    .from("subscriptions")
    .select("id")
    .eq("organisation_id", organisationId)
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();

  const updates = {
    organisation_id: organisationId,
    plan_id: metadata.plan_id ?? null,
    status: stripeSub.status,
    stripe_customer_id: customerId,
    stripe_subscription_id: subscriptionId,
    stripe_payment_method_id: pmId ?? null,
    payment_method_last4: last4,
    payment_method_brand: brand,
    payment_method_exp_month: expMonth,
    payment_method_exp_year: expYear,
    current_period_start: periodStart,
    current_period_end: periodEnd,
    trial_ends_at: stripeSub.trial_end ? new Date(stripeSub.trial_end * 1000).toISOString() : null,
    updated_at: new Date().toISOString(),
  };

  if (existingSub) {
    await supabase.from("subscriptions").update(updates).eq("id", existingSub.id);
  } else {
    await supabase.from("subscriptions").insert(updates);
  }
}

async function handleSubscriptionUpdated(
  supabase: ReturnType<typeof createClient>,
  obj: Record<string, unknown>,
) {
  const stripeSubId = obj.id as string;
  const periodStart = new Date((obj.current_period_start as number) * 1000).toISOString();
  const periodEnd = new Date((obj.current_period_end as number) * 1000).toISOString();
  const cancelAtPeriodEnd = obj.cancel_at_period_end as boolean;
  const status = obj.status as string;

  await supabase
    .from("subscriptions")
    .update({
      status,
      current_period_start: periodStart,
      current_period_end: periodEnd,
      cancel_at_period_end: cancelAtPeriodEnd,
      cancelled_at: cancelAtPeriodEnd ? new Date().toISOString() : null,
      updated_at: new Date().toISOString(),
    })
    .eq("stripe_subscription_id", stripeSubId);
}

async function handleSubscriptionDeleted(
  supabase: ReturnType<typeof createClient>,
  obj: Record<string, unknown>,
) {
  const stripeSubId = obj.id as string;
  await supabase
    .from("subscriptions")
    .update({ status: "cancelled", cancelled_at: new Date().toISOString(), updated_at: new Date().toISOString() })
    .eq("stripe_subscription_id", stripeSubId);
}

async function handlePaymentSucceeded(
  supabase: ReturnType<typeof createClient>,
  obj: Record<string, unknown>,
) {
  const stripeSubId = obj.subscription as string;
  if (!stripeSubId) return;
  const periodStart = obj.period_start ? new Date((obj.period_start as number) * 1000).toISOString() : null;
  const periodEnd = obj.period_end ? new Date((obj.period_end as number) * 1000).toISOString() : null;

  await supabase
    .from("subscriptions")
    .update({
      status: "active",
      ...(periodStart && { current_period_start: periodStart }),
      ...(periodEnd && { current_period_end: periodEnd }),
      updated_at: new Date().toISOString(),
    })
    .eq("stripe_subscription_id", stripeSubId);
}

async function handlePaymentFailed(
  supabase: ReturnType<typeof createClient>,
  obj: Record<string, unknown>,
) {
  const stripeSubId = obj.subscription as string;
  if (!stripeSubId) return;
  await supabase
    .from("subscriptions")
    .update({ status: "past_due", updated_at: new Date().toISOString() })
    .eq("stripe_subscription_id", stripeSubId);
}

async function getStripeKey(supabase: ReturnType<typeof createClient>): Promise<string | null> {
  const { data } = await supabase.from("settings").select("value").eq("key", "STRIPE_SECRET_KEY").maybeSingle();
  return data?.value ?? null;
}

// Issue #40: which RTO an event belongs to — checkout/subscription metadata
// first (validated), otherwise the subscription already linked to the Stripe
// customer. Returns null when the event cannot be attributed.
async function resolveEventOrganisation(
  // deno-lint-ignore no-explicit-any -- matches the untyped clients used elsewhere in this function
  supabase: any,
  obj: Record<string, unknown> | undefined,
): Promise<string | null> {
  if (!obj) return null;
  const metadata = (obj.metadata ?? {}) as Record<string, string>;
  const fromMetadata = typeof metadata.organisation_id === "string" ? metadata.organisation_id : null;
  if (fromMetadata) {
    const { data: org } = await supabase.from("organisations").select("id").eq("id", fromMetadata).maybeSingle();
    if (org?.id) return org.id as string;
  }
  const customerId = typeof obj.customer === "string" ? obj.customer : null;
  if (customerId) {
    const { data: sub } = await supabase
      .from("subscriptions").select("organisation_id").eq("stripe_customer_id", customerId).maybeSingle();
    if (sub?.organisation_id) return sub.organisation_id as string;
  }
  return null;
}

// Stripe signature header: "t=<timestamp>,v1=<hex hmac>[,v1=...]". The signed
// payload is "<timestamp>.<raw body>" with the endpoint's webhook secret.
async function verifyStripeSignature(body: string, header: string, secret: string): Promise<boolean> {
  const parts = header.split(",").map((part) => part.trim());
  const timestamp = parts.find((part) => part.startsWith("t="))?.slice(2) ?? "";
  const signatures = parts.filter((part) => part.startsWith("v1=")).map((part) => part.slice(3));
  if (!timestamp || signatures.length === 0) return false;
  if (Math.abs(Date.now() / 1000 - Number(timestamp)) > 300) return false;
  const key = await crypto.subtle.importKey(
    "raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"],
  );
  const digest = new Uint8Array(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(`${timestamp}.${body}`)));
  const expected = Array.from(digest, (byte) => byte.toString(16).padStart(2, "0")).join("");
  return signatures.some((candidate) => timingSafeEqual(candidate, expected));
}

function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let difference = 0;
  for (let i = 0; i < a.length; i += 1) difference |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return difference === 0;
}
