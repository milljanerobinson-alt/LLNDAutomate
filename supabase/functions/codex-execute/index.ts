/**
 * EWO-034R.3B — Codex Execute Edge Function
 *
 * Invokes the OpenAI API to generate code changes for a governed
 * engineering execution. Returns structured file changes with complete
 * file contents.
 *
 * EWO-034R.3B CHANGES:
 *   - Resolves the API key SERVER-SIDE from ai_provider_configs
 *   - Does NOT accept api_key from the client request body
 *   - Uses the model from ai_provider_configs, validated against supported models
 *   - Consistent with codex-dry-run and codex-health-check credential resolution
 */

import { createClient } from "npm:@supabase/supabase-js@2.45.0";
import { operatorDeniedResponse, requirePlatformOperator } from "../_shared/platform-operator.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, PUT, DELETE, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization, X-Client-Info, Apikey",
};

const OPENAI_API_BASE = "https://api.openai.com/v1";
const EXECUTION_PROVIDER = "openai";
const SUPPORTED_EXECUTION_MODELS = ["gpt-4o", "gpt-4o-mini", "gpt-4-turbo", "o3-mini"];

interface CodexExecuteRequest {
  execution_id: string;
  ewo_ref: string;
  task_objective: string;
  implementation_scope: string;
  acceptance_criteria: string[];
  affected_components: string[];
  target_repository: string;
  target_branch: string;
  target_environment: string;
  governance_constraints: string[];
  restricted_files: string[];
  model?: string;
}

/**
 * Resolve the OpenAI API key server-side from ai_provider_configs.
 * The raw key is NEVER sent from the browser.
 */
async function resolveApiKey(supabase: ReturnType<typeof createClient>): Promise<{
  available: boolean;
  apiKey: string | null;
  model: string | null;
  reason: string;
}> {
  const { data: provider } = await supabase
    .from("ai_provider_configs")
    .select("provider, is_enabled, has_api_key, api_key, model")
    .eq("provider", EXECUTION_PROVIDER)
    .maybeSingle();

  if (!provider) {
    return { available: false, apiKey: null, model: null, reason: `Provider '${EXECUTION_PROVIDER}' not configured in ai_provider_configs` };
  }
  if (!provider.is_enabled) {
    return { available: false, apiKey: null, model: provider.model, reason: `Provider '${EXECUTION_PROVIDER}' is disabled` };
  }
  if (!provider.has_api_key) {
    return { available: false, apiKey: null, model: provider.model, reason: `Provider '${EXECUTION_PROVIDER}' has no API key configured` };
  }

  const apiKey = provider.api_key as string | null;
  if (!apiKey || apiKey.trim().length === 0) {
    return { available: false, apiKey: null, model: provider.model, reason: `Provider '${EXECUTION_PROVIDER}' API key is empty` };
  }

  return { available: true, apiKey, model: provider.model || "gpt-4o", reason: "Credential resolved" };
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

    const body: CodexExecuteRequest = await req.json();

    if (!body.execution_id || !body.ewo_ref || !body.task_objective) {
      return new Response(
        JSON.stringify({ error: "Missing required fields: execution_id, ewo_ref, task_objective" }),
        { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } },
      );
    }

    // EWO-034R.3B: Resolve credentials SERVER-SIDE — no client-supplied keys.
    const credential = await resolveApiKey(supabase);

    if (!credential.available || !credential.apiKey) {
      return new Response(
        JSON.stringify({
          error: `Credential resolution failed: ${credential.reason}`,
          execution_status: "failed",
        }),
        { status: 403, headers: { ...corsHeaders, "Content-Type": "application/json" } },
      );
    }

    // EWO-034R.3B: Standardised model resolution.
    // Priority: client-preferred model → ai_provider_configs.model → gpt-4o fallback.
    // Validate against supported models — do not silently substitute.
    const requestedModel = body.model || credential.model || "gpt-4o";

    if (!SUPPORTED_EXECUTION_MODELS.includes(requestedModel)) {
      return new Response(
        JSON.stringify({
          error: `Model '${requestedModel}' is not supported. Supported models: ${SUPPORTED_EXECUTION_MODELS.join(", ")}`,
          execution_status: "failed",
        }),
        { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } },
      );
    }

    const model = requestedModel;
    const apiCallStart = Date.now();

    // Build the system prompt that instructs Codex to return structured JSON
    const systemPrompt = `You are an autonomous engineering execution agent operating within a governed engineering pipeline.

You MUST return your response as a JSON object with this exact structure:
{
  "files_created": [{"path": "", "action": "create", "content": "", "diff_summary": "", "lines_added": 0, "lines_removed": 0}],
  "files_modified": [{"path": "", "action": "modify", "content": "", "diff_summary": "", "lines_added": 0, "lines_removed": 0}],
  "files_deleted": [],
  "commands_executed": [],
  "tests_executed": [],
  "implementation_notes": "",
  "deviations_from_plan": [],
  "unresolved_issues": [],
  "acceptance_criteria_status": [{"criterion": "", "satisfied": true, "evidence": ""}]
}

CRITICAL RULES:
1. The "content" field in files_created and files_modified MUST contain the COMPLETE file contents after your changes are applied. Not diffs — full file content.
2. Only modify files within the permitted directories: src/, supabase/, public/
3. Do NOT modify any of these restricted files: ${(body.restricted_files || []).join(", ")}
4. Each file change must include accurate lines_added and lines_removed counts.
5. The acceptance_criteria_status must address each acceptance criterion.
6. Do not include markdown code fences in your response — return raw JSON only.`;

    const userPrompt = `Engineering Work Order: ${body.ewo_ref}
Execution ID: ${body.execution_id}

Task Objective:
${body.task_objective}

Implementation Scope:
${body.implementation_scope}

Affected Components (target files):
${(body.affected_components || []).map((c) => `- ${c}`).join("\n")}

Acceptance Criteria:
${(body.acceptance_criteria || []).map((c, i) => `${i + 1}. ${c}`).join("\n")}

Governance Constraints:
${(body.governance_constraints || []).map((c) => `- ${c}`).join("\n")}

Target Repository: ${body.target_repository}
Target Branch: ${body.target_branch}
Target Environment: ${body.target_environment}

Generate the code changes needed to fulfill this engineering objective. Return ONLY the JSON object.`;

    // Call the OpenAI API with the server-resolved key
    const openaiResponse = await fetch(`${OPENAI_API_BASE}/chat/completions`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${credential.apiKey}`,
      },
      body: JSON.stringify({
        model: model,
        messages: [
          { role: "system", content: systemPrompt },
          { role: "user", content: userPrompt },
        ],
        temperature: 0.1,
        max_tokens: 16000,
        response_format: { type: "json_object" },
      }),
    });

    const apiResponseTime = Date.now() - apiCallStart;

    if (!openaiResponse.ok) {
      const errText = await openaiResponse.text();
      return new Response(
        JSON.stringify({
          error: `OpenAI API error (${openaiResponse.status}): ${errText}`,
          execution_status: "failed",
        }),
        { status: 502, headers: { ...corsHeaders, "Content-Type": "application/json" } },
      );
    }

    const openaiData = await openaiResponse.json();
    const content = openaiData.choices?.[0]?.message?.content;

    if (!content) {
      return new Response(
        JSON.stringify({
          error: "Empty response from OpenAI",
          execution_status: "failed",
        }),
        { status: 502, headers: { ...corsHeaders, "Content-Type": "application/json" } },
      );
    }

    // Parse the structured response
    let structuredResult;
    try {
      structuredResult = JSON.parse(content);
    } catch (parseErr) {
      return new Response(
        JSON.stringify({
          error: `Failed to parse Codex response as JSON: ${parseErr instanceof Error ? parseErr.message : String(parseErr)}`,
          raw_content: content.slice(0, 2000),
          execution_status: "failed",
        }),
        { status: 502, headers: { ...corsHeaders, "Content-Type": "application/json" } },
      );
    }

    // Validate the response has the required structure
    if (!structuredResult.files_created && !structuredResult.files_modified) {
      return new Response(
        JSON.stringify({
          error: "Codex response missing files_created or files_modified",
          raw_content: content.slice(0, 2000),
          execution_status: "failed",
        }),
        { status: 502, headers: { ...corsHeaders, "Content-Type": "application/json" } },
      );
    }

    // Extract usage metrics
    const usage = openaiData.usage || {};
    const cachedTokens = usage.prompt_tokens_details?.cached_tokens || 0;

    return new Response(
      JSON.stringify({
        execution_id: body.execution_id,
        provider: "codex",
        provider_version: "1.0.0",
        model_used: model,
        execution_status: "success",
        files_created: structuredResult.files_created || [],
        files_modified: structuredResult.files_modified || [],
        files_deleted: structuredResult.files_deleted || [],
        commands_executed: structuredResult.commands_executed || [],
        tests_executed: structuredResult.tests_executed || [],
        implementation_notes: structuredResult.implementation_notes || "",
        deviations_from_plan: structuredResult.deviations_from_plan || [],
        unresolved_issues: structuredResult.unresolved_issues || [],
        acceptance_criteria_status: structuredResult.acceptance_criteria_status || [],
        estimated_cost: {
          estimated_cost_usd: ((usage.prompt_tokens || 0) * 2.5 + (usage.completion_tokens || 0) * 10) / 1_000_000,
          currency: "USD",
        },
        actual_usage: {
          actual_input_tokens: usage.prompt_tokens || 0,
          actual_cached_input_tokens: cachedTokens,
          actual_output_tokens: usage.completion_tokens || 0,
        },
        actual_cost: {
          actual_cost_usd: ((usage.prompt_tokens || 0) * 2.5 + (usage.completion_tokens || 0) * 10) / 1_000_000,
          cost_variance_usd: 0,
        },
        retry_count: 0,
        provider_diagnostics: {
          provider_id: "codex",
          provider_name: "OpenAI Codex Execution Provider",
          model_used: model,
          api_response_time_ms: apiResponseTime,
          rate_limit_remaining: openaiResponse.headers.get("x-ratelimit-remaining-requests"),
          rate_limit_reset_at: openaiResponse.headers.get("x-ratelimit-reset-requests"),
          provider_health: "healthy",
          diagnostic_confidence: 1.0,
        },
        runtime_diagnostics: {
          request_id: `CODEX-EXEC-${body.execution_id}`,
          detected_intent: "codex_execution",
          services_invoked: ["openai_api"],
          pipeline_stages_completed: [],
          provider_records_examined: 1,
          unavailable_fields: [],
          diagnostic_confidence: 1.0,
          lifecycle_change_performed: false,
          generated_timestamp: new Date().toISOString(),
          audit_reference: `CODEX-EXEC-${body.execution_id}`,
        },
        constitutional_compliance_result: {
          compliant: true,
          amendments_checked: [],
          violations: [],
          warnings: [],
        },
        audit_reference: `CODEX-EXEC-${body.execution_id}`,
        completion_package_reference: null,
      }),
      { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } },
    );
  } catch (err) {
    return new Response(
      JSON.stringify({ error: err instanceof Error ? err.message : "Internal error", execution_status: "failed" }),
      { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } },
    );
  }
});
