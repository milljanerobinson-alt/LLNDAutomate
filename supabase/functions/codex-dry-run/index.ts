import { createClient } from "npm:@supabase/supabase-js@2.45.0";
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

/**
 * Resolve the shared OpenAI credential on the server side (service role only).
 * The raw key is NEVER returned to the caller.
 */
async function resolveSharedOpenAIKey(supabase: ReturnType<typeof createClient>) {
  const { data: provider } = await supabase
    .from("ai_provider_configs")
    .select("provider, is_enabled, has_api_key, api_key")
    .eq("provider", "openai")
    .maybeSingle();

  if (!provider) {
    return { available: false, apiKey: null, status: "unavailable" as const, reason: "OpenAI provider is not configured in AI Infrastructure" };
  }
  if (!provider.is_enabled) {
    return { available: false, apiKey: null, status: "disabled" as const, reason: "OpenAI provider is disabled in AI Infrastructure" };
  }
  if (!provider.has_api_key) {
    return { available: false, apiKey: null, status: "unavailable" as const, reason: "OpenAI provider has no API key configured" };
  }

  // The raw key lives in ai_provider_configs.api_key (pre-existing source of truth).
  // SECURITY FINDING: stored in plaintext — pre-existing limitation of the AI
  // Infrastructure credential model. Codex reuses this source without duplication.
  const apiKey = provider.api_key as string | null;
  if (!apiKey || apiKey.trim().length === 0) {
    return { available: false, apiKey: null, status: "unavailable" as const, reason: "OpenAI API key is missing from provider config" };
  }

  return { available: true, apiKey, status: "available" as const, reason: "Shared OpenAI provider credential is configured and enabled" };
}

/**
 * Perform a real, read-only OpenAI /models call to verify credential
 * resolution, authentication, and endpoint availability without modifying
 * the repository or consuming paid execution tokens.
 */
async function verifySharedCredential(apiKey: string): Promise<{
  authenticated: boolean;
  models_available: boolean;
  models_found: string[];
  detail: string;
}> {
  try {
    const response = await fetch(`${OPENAI_API_BASE}/models`, {
      method: "GET",
      headers: { Authorization: `Bearer ${apiKey}` },
    });

    if (response.ok) {
      const models = await response.json();
      const modelIds: string[] = (models.data || []).map((m: { id: string }) => m.id);
      return {
        authenticated: true,
        models_available: modelIds.length > 0,
        models_found: modelIds.slice(0, 5),
        detail: `Authenticated against OpenAI API; ${modelIds.length} models visible`,
      };
    }
    if (response.status === 401 || response.status === 403) {
      return { authenticated: false, models_available: false, models_found: [], detail: `OpenAI rejected the shared credential (HTTP ${response.status})` };
    }
    if (response.status === 429) {
      return { authenticated: true, models_available: true, models_found: [], detail: "OpenAI accepted the shared credential (rate limited)" };
    }
    return { authenticated: false, models_available: false, models_found: [], detail: `OpenAI returned HTTP ${response.status}` };
  } catch {
    return { authenticated: false, models_available: false, models_found: [], detail: "Unable to reach OpenAI API" };
  }
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

    const { environment = "staging", request, skipApiCheck = false } = await req.json();

    // 1. Validate execution package
    const packageErrors: string[] = [];
    if (!request.execution_id) packageErrors.push("Missing execution_id");
    if (!request.ewo_ref) packageErrors.push("Missing ewo_ref");
    if (!request.repository_ref) packageErrors.push("Missing repository_ref");
    if (!request.branch_ref) packageErrors.push("Missing branch_ref");
    if (!request.task_objective) packageErrors.push("Missing task_objective");
    if (!request.scope) packageErrors.push("Missing scope");
    if (!request.acceptance_criteria || request.acceptance_criteria.length === 0) packageErrors.push("Missing acceptance_criteria");
    if (request.po_approval_state !== "approved") packageErrors.push("PO approval state is not approved");

    // 2. Validate governance
    const governanceErrors: string[] = [];
    if (!request.governance_constraints || request.governance_constraints.length === 0) governanceErrors.push("No governance constraints specified");
    if (!request.restricted_files || request.restricted_files.length === 0) governanceErrors.push("No restricted files specified");

    // 3. Check provider eligibility
    const { data: provider } = await supabase
      .from("execution_provider_registry")
      .select("*")
      .eq("provider_id", "codex")
      .maybeSingle();
    const providerEligible = provider !== null && provider.is_governed === true;

    // 4. Resolve the SHARED OpenAI credential (no longer codex_provider_credentials)
    const credential = await resolveSharedOpenAIKey(supabase);

    let credentialStatus: string = credential.status;
    let credentialVerification: { authenticated: boolean; models_available: boolean; models_found: string[]; detail: string } | null = null;

    // 5. Verify the shared credential against the real OpenAI API
    if (credential.available && !skipApiCheck) {
      credentialVerification = await verifySharedCredential(credential.apiKey!);
      if (!credentialVerification.authenticated) {
        credentialStatus = "invalid";
      }
    } else if (credential.available && skipApiCheck) {
      credentialStatus = "valid";
    }

    // 6. Get model — EWO-034R.3B: standardised model resolution
    // Resolve from ai_provider_configs (the openai row's model column), not from
    // execution_provider_registry.provider_config.default_model.
    const { data: aiProvider } = await supabase
      .from("ai_provider_configs")
      .select("model")
      .eq("provider", "openai")
      .maybeSingle();
    const SUPPORTED_MODELS = ["gpt-4o", "gpt-4o-mini", "gpt-4-turbo", "o3-mini"];
    const selectedModel = aiProvider?.model || "gpt-4o";
    const modelSupported = SUPPORTED_MODELS.includes(selectedModel);

    // 7. Get supported operations
    const supportedOperations = provider?.provider_config?.supported_operations || [];

    // 8. Estimate context size
    const contextStr = JSON.stringify(request.context_package || {});
    const instructionsLen = (request.task_objective || "").length + (request.scope || "").length;
    const constraintsLen = (request.acceptance_criteria || []).join(" ").length +
      (request.architectural_constraints || []).join(" ").length +
      (request.governance_constraints || []).join(" ").length;
    const totalChars = contextStr.length + instructionsLen + constraintsLen;
    const estimatedContextSize = Math.ceil(totalChars / 4);
    const estimatedInputTokens = Math.ceil(estimatedContextSize * 0.75);
    const estimatedCachedTokens = Math.ceil(estimatedInputTokens * 0.5);
    const estimatedOutputTokens = Math.min(request.token_budget || 16384, 8192);

    // 9. Get pricing and estimate cost
    const { data: budgetConfig } = await supabase
      .from("codex_budget_config")
      .select("*")
      .eq("environment", environment)
      .eq("is_active", true)
      .maybeSingle();

    let estimatedCostUsd = 0;
    let budgetStatus = "within_limits";
    let budgetValidationDetail: Record<string, unknown> = {};

    if (budgetConfig) {
      const inputCost = (estimatedInputTokens / 1_000_000) * parseFloat(budgetConfig.input_token_price_per_1m);
      const cachedCost = (estimatedCachedTokens / 1_000_000) * parseFloat(budgetConfig.cached_input_token_price_per_1m);
      const outputCost = (estimatedOutputTokens / 1_000_000) * parseFloat(budgetConfig.output_token_price_per_1m);
      estimatedCostUsd = Math.round((inputCost + cachedCost + outputCost) * 1_000_000) / 1_000_000;

      const execPct = (estimatedCostUsd / parseFloat(budgetConfig.per_execution_limit_usd)) * 100;
      if (execPct >= parseFloat(budgetConfig.hard_stop_threshold_pct)) {
        budgetStatus = "exceeded";
      } else if (execPct >= parseFloat(budgetConfig.approval_threshold_pct)) {
        budgetStatus = "approval_required";
      } else if (execPct >= parseFloat(budgetConfig.warning_threshold_pct)) {
        budgetStatus = "warning";
      }

      budgetValidationDetail = {
        per_execution_limit: parseFloat(budgetConfig.per_execution_limit_usd),
        per_ewo_limit: parseFloat(budgetConfig.per_ewo_limit_usd),
        daily_limit: parseFloat(budgetConfig.daily_limit_usd),
        monthly_limit: parseFloat(budgetConfig.monthly_limit_usd),
      };
    } else {
      budgetStatus = "exceeded";
    }

    // 10. Check for prohibited actions
    const prohibitedActionsDetected: string[] = [];
    const restrictedFiles = request.restricted_files || [];
    const permittedFiles = request.permitted_files || [];
    for (const restricted of restrictedFiles) {
      if (permittedFiles.includes(restricted)) {
        prohibitedActionsDetected.push(`Restricted file in permitted list: ${restricted}`);
      }
    }

    // 11. Determine approval requirements
    const approvalRequirements: string[] = [];
    if (budgetStatus === "approval_required") approvalRequirements.push("Budget approval required");
    if (request.po_approval_state !== "approved") approvalRequirements.push("Product Owner approval required");
    if (environment === "production") approvalRequirements.push("Production environment approval required");

    const result = {
      execution_package_valid: packageErrors.length === 0,
      governance_valid: governanceErrors.length === 0,
      provider_eligible: providerEligible,
      credential_status: credentialStatus,
      credential_reference: SHARED_OPENAI_CREDENTIAL_REFERENCE,
      credential_source: "ai_infrastructure_openai",
      credential_verified: credentialVerification?.authenticated ?? false,
      credential_verification_detail: credentialVerification?.detail ?? credential.reason,
      selected_model: selectedModel,
      model_supported: modelSupported,
      supported_models: SUPPORTED_MODELS,
      supported_operations: supportedOperations,
      estimated_context_size: estimatedContextSize,
      estimated_input_tokens: estimatedInputTokens,
      estimated_cached_input_tokens: estimatedCachedTokens,
      estimated_output_tokens: estimatedOutputTokens,
      estimated_cost_usd: estimatedCostUsd,
      budget_status: budgetStatus,
      approval_requirements: approvalRequirements,
      prohibited_actions_detected: prohibitedActionsDetected,
      execution_diagnostics: {
        package_errors: packageErrors,
        governance_errors: governanceErrors,
        budget_validation: budgetValidationDetail,
        pricing_available: budgetConfig !== null,
        provider_active: provider?.is_active || false,
        models_visible: credentialVerification?.models_available ?? false,
      },
      paid_tokens_consumed: 0,
    };

    return new Response(JSON.stringify(result), {
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  } catch (e) {
    return err(e instanceof Error ? e.message : "Internal error", 500);
  }
});
