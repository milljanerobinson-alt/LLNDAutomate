import { createClient } from "jsr:@supabase/supabase-js@2";
import { operatorDeniedResponse, requirePlatformOperator } from "../_shared/platform-operator.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, PUT, DELETE, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization, X-Client-Info, Apikey",
};

const OPENAI_API_BASE = "https://api.openai.com/v1";
const SHARED_OPENAI_CREDENTIAL_REFERENCE = "shared-provider://openai/default";

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

/**
 * Resolve the shared OpenAI credential on the server side.
 * Reads the raw key from `settings.openai_api_key` (service role only) and
 * the provider config from `ai_provider_configs`.
 * The raw key is NEVER returned to the caller.
 */
async function resolveSharedOpenAIKey(supabase: ReturnType<typeof createClient>) {
  const { data: provider } = await supabase
    .from("ai_provider_configs")
    .select("provider, is_enabled, has_api_key, health_status, api_key")
    .eq("provider", "openai")
    .maybeSingle();

  if (!provider) {
    return { available: false, apiKey: null, reason: "OpenAI provider is not configured in AI Infrastructure", status: "unavailable" as const };
  }
  if (!provider.is_enabled) {
    return { available: false, apiKey: null, reason: "OpenAI provider is disabled in AI Infrastructure", status: "disabled" as const };
  }
  if (!provider.has_api_key) {
    return { available: false, apiKey: null, reason: "OpenAI provider has no API key configured", status: "unavailable" as const };
  }

  // The raw key lives in ai_provider_configs.api_key (pre-existing source of truth).
  // SECURITY FINDING: stored in plaintext — pre-existing limitation of the AI
  // Infrastructure credential model. Codex reuses this source without duplication.
  const apiKey = provider.api_key as string | null;
  if (!apiKey || apiKey.trim().length === 0) {
    return { available: false, apiKey: null, reason: "OpenAI API key is missing from provider config", status: "unavailable" as const };
  }

  return { available: true, apiKey, reason: "Shared OpenAI provider credential is configured and enabled", status: "available" as const };
}

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
    const supabase = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
    );

    const { environment = "staging", skipApiCheck = false } = await req.json().catch(() => ({
      environment: "staging",
      skipApiCheck: false,
    }));

    const checkRef = `CODEX-HC-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const checkedAt = new Date().toISOString();

    // 1. Check provider registration
    const { data: provider } = await supabase
      .from("execution_provider_registry")
      .select("*")
      .eq("provider_id", "codex")
      .maybeSingle();

    const configurationStatus: "ok" | "not_configured" = provider ? "ok" : "not_configured";

    // 2. Resolve the shared OpenAI credential (server-side only)
    const credential = await resolveSharedOpenAIKey(supabase);

    let secretAvailabilityStatus: "available" | "unavailable" | "revoked" | "expired" = "unavailable";
    if (credential.available) secretAvailabilityStatus = "available";
    else if (credential.status === "disabled") secretAvailabilityStatus = "unavailable";

    // 3. Check budget config
    const { data: budgetConfig } = await supabase
      .from("codex_budget_config")
      .select("*")
      .eq("environment", environment)
      .eq("is_active", true)
      .maybeSingle();
    const budgetStatus = budgetConfig ? "configured" : "not_configured";

    // 4. API accessibility + authentication (real OpenAI /models endpoint)
    let apiAccessibilityStatus: "reachable" | "unreachable" | "not_checked" = "not_checked";
    let authenticationStatus: "authenticated" | "failed" | "not_checked" = "not_checked";
    let modelAvailabilityStatus: "available" | "unavailable" | "not_checked" = "not_checked";
    let rateLimitStatus: string | null = null;

    if (!skipApiCheck && credential.available && credential.apiKey) {
      try {
        const response = await fetch(`${OPENAI_API_BASE}/models`, {
          method: "GET",
          headers: { Authorization: `Bearer ${credential.apiKey}` },
        });

        if (response.ok) {
          apiAccessibilityStatus = "reachable";
          authenticationStatus = "authenticated";

          const models = await response.json();
          const modelIds: string[] = (models.data || []).map((m: { id: string }) => m.id);
          // EWO-034R.3B: Use the same supported models list as codex-execute and codex-dry-run
          const SUPPORTED_MODELS = ["gpt-4o", "gpt-4o-mini", "gpt-4-turbo", "o3-mini"];
          modelAvailabilityStatus = SUPPORTED_MODELS.some((m: string) => modelIds.includes(m))
            ? "available"
            : "unavailable";

          const remaining = response.headers.get("x-ratelimit-remaining-requests");
          const resetAt = response.headers.get("x-ratelimit-reset-requests");
          if (remaining) rateLimitStatus = `${remaining} requests remaining`;
          if (resetAt) rateLimitStatus = `${rateLimitStatus || ""} (resets at ${resetAt})`.trim() || null;
        } else if (response.status === 401 || response.status === 403) {
          apiAccessibilityStatus = "reachable";
          authenticationStatus = "failed";
        } else if (response.status === 429) {
          apiAccessibilityStatus = "reachable";
          authenticationStatus = "authenticated";
          rateLimitStatus = "Rate limited";
        } else {
          apiAccessibilityStatus = "unreachable";
        }
      } catch {
        apiAccessibilityStatus = "unreachable";
      }
    }

    // 5. Contract compatibility
    const contractVersion = provider?.canonical_contract_version || "unknown";
    const contractCompatibilityStatus: "compatible" | "incompatible" | "not_checked" =
      contractVersion === "1.0" ? "compatible" : contractVersion === "unknown" ? "not_checked" : "incompatible";

    // 6. Overall health
    const isHealthy =
      configurationStatus === "ok" &&
      secretAvailabilityStatus === "available" &&
      (skipApiCheck || (apiAccessibilityStatus === "reachable" && authenticationStatus === "authenticated")) &&
      budgetStatus === "configured";

    const result = {
      check_ref: checkRef,
      environment,
      configuration_status: configurationStatus,
      secret_availability_status: secretAvailabilityStatus,
      authentication_status: authenticationStatus,
      api_accessibility_status: apiAccessibilityStatus,
      model_availability_status: modelAvailabilityStatus,
      contract_compatibility_status: contractCompatibilityStatus,
      rate_limit_status: rateLimitStatus,
      is_healthy: isHealthy,
      diagnostics: {
        budget_status: budgetStatus,
        contract_version: contractVersion,
        provider_active: provider?.is_active || false,
        provider_governed: provider?.is_governed || false,
        credential_reference: SHARED_OPENAI_CREDENTIAL_REFERENCE,
        credential_source: "ai_infrastructure_openai",
        openai_credential_reason: credential.reason,
      },
      checked_at: checkedAt,
    };

    // 7. Record health check
    await supabase.from("codex_provider_health").insert({
      check_ref: checkRef,
      environment,
      configuration_status: configurationStatus,
      secret_availability_status: secretAvailabilityStatus,
      authentication_status: authenticationStatus,
      api_accessibility_status: apiAccessibilityStatus,
      model_availability_status: modelAvailabilityStatus,
      contract_compatibility_status: contractCompatibilityStatus,
      rate_limit_status: rateLimitStatus,
      diagnostics: result.diagnostics,
      is_healthy: isHealthy,
      checked_at: checkedAt,
    });

    // 8. Sync registry to authoritative state (no stale values)
    if (isHealthy) {
      await supabase.from("execution_provider_registry")
        .update({
          provider_health: "healthy",
          configuration_status: "configured",
          credential_reference_status: "available",
          credential_source_reference: SHARED_OPENAI_CREDENTIAL_REFERENCE,
          last_successful_health_check: checkedAt,
          updated_at: checkedAt,
        })
        .eq("provider_id", "codex");
    } else {
      const credRefStatus = secretAvailabilityStatus === "available" ? "available" : "unavailable";
      await supabase.from("execution_provider_registry")
        .update({
          provider_health: "unhealthy",
          configuration_status: configurationStatus,
          credential_reference_status: credential.status === "disabled" ? "unavailable" : credRefStatus,
          credential_source_reference: SHARED_OPENAI_CREDENTIAL_REFERENCE,
          last_failed_health_check: checkedAt,
          updated_at: checkedAt,
        })
        .eq("provider_id", "codex");
    }

    return ok(result);
  } catch (e) {
    return err(e instanceof Error ? e.message : "Internal error", 500);
  }
});
