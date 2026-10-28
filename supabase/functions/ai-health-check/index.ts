import { createClient } from "jsr:@supabase/supabase-js@2";
import { operatorDeniedResponse, requirePlatformOperator } from "../_shared/platform-operator.ts";
import { checkProviderHealth } from "../_shared/ai-service.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, PUT, DELETE, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization, X-Client-Info, Apikey",
};

function err(msg: string, status = 400) {
  return new Response(JSON.stringify({ error: msg }), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

function ok(data: unknown) {
  return new Response(JSON.stringify(data), {
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

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
  const svc = createClient(
    Deno.env.get("SUPABASE_URL")!,
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
  );
  const { data: profile } = await svc.from("profiles").select("role").eq("id", user.id).maybeSingle();
  // Issue #45: operator status (grant + MFA) is enforced by requirePlatformOperator() in the request handler; the legacy profiles.role check is retired.
  if (!profile) return null;
  return svc;
}

const VALID_PROVIDERS = ["openai", "gemini", "anthropic"];

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { status: 200, headers: corsHeaders });
  }

  // Issue #45: platform operators with MFA only (trusted server-to-server calls with the service-role key also pass).
  {
    const operatorCheck = await requirePlatformOperator(req.headers.get("Authorization"), { allowServiceRole: true });
    if (!operatorCheck.ok) return operatorDeniedResponse(operatorCheck, corsHeaders);
  }

  try {
    const svc = await verifyAdmin(req);
    if (!svc) return err("Unauthorized", 401);

    const { provider } = await req.json() as { provider: string };
    if (!VALID_PROVIDERS.includes(provider)) {
      return err(`Invalid provider. Must be one of: ${VALID_PROVIDERS.join(", ")}`);
    }

    // Load provider config
    const { data: cfg } = await svc
      .from("ai_provider_configs")
      .select("model, base_url, has_api_key")
      .eq("provider", provider)
      .maybeSingle();

    if (!cfg?.has_api_key) {
      return err(`No API key configured for ${provider}. Save a key first.`, 422);
    }

    // Load API key from settings
    const { data: keySetting } = await svc
      .from("settings")
      .select("value")
      .eq("key", `${provider}_api_key`)
      .maybeSingle();

    if (!keySetting?.value) {
      return err(`API key not found in settings for ${provider}.`, 422);
    }

    // Run health check
    const result = await checkProviderHealth(
      provider,
      keySetting.value,
      cfg.model || "",
      cfg.base_url || "",
    );

    const now = new Date().toISOString();

    // Persist health result to provider config
    await svc.from("ai_provider_configs").update({
      health_status: result.status,
      health_latency_ms: result.latencyMs,
      health_message: result.message,
      health_checked_at: now,
      updated_at: now,
    }).eq("provider", provider);

    return ok({
      provider,
      status: result.status,
      latency_ms: result.latencyMs,
      message: result.message,
      model: result.model,
      checked_at: now,
    });
  } catch (e) {
    return err(e instanceof Error ? e.message : "Internal error", 500);
  }
});
