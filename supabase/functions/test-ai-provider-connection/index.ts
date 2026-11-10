import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";
import { operatorDeniedResponse, requirePlatformOperator } from "../_shared/platform-operator.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, PUT, DELETE, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization, X-Client-Info, Apikey",
};

function ok(data: unknown) {
  return new Response(JSON.stringify(data), {
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

function err(msg: string, status = 400) {
  return new Response(JSON.stringify({ error: msg }), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

const VALID_PROVIDERS = ["openai", "anthropic", "gemini"] as const;
type Provider = typeof VALID_PROVIDERS[number];

// Classify OpenAI errors into human-readable categories
function classifyOpenAIError(body: string, status: number): { type: string; message: string } {
  const lower = body.toLowerCase();
  if (status === 401 || lower.includes("invalid_api_key") || lower.includes("incorrect api key")) {
    return { type: "invalid_api_key", message: "Invalid API key. Check your key in the provider settings." };
  }
  if (status === 429) {
    if (lower.includes("quota") || lower.includes("insufficient_quota")) {
      return { type: "quota_exceeded", message: "API quota exceeded or billing limit reached." };
    }
    return { type: "rate_limited", message: "Rate limit exceeded. Try again in a moment." };
  }
  if (status === 404 || lower.includes("model_not_found") || lower.includes("does not exist")) {
    return { type: "model_unavailable", message: "Model not available on your account. Try a different model." };
  }
  if (status === 403) {
    return { type: "permission_denied", message: "Access denied. Your account may not have access to this model." };
  }
  return { type: "api_error", message: `API error (${status}): ${body.slice(0, 120)}` };
}

function classifyAnthropicError(body: string, status: number): { type: string; message: string } {
  const lower = body.toLowerCase();
  if (status === 401) return { type: "invalid_api_key", message: "Invalid Anthropic API key." };
  if (status === 429) return { type: "rate_limited", message: "Anthropic rate limit exceeded." };
  if (status === 404 || lower.includes("not found")) {
    return { type: "model_unavailable", message: "Model not available. Try a different model." };
  }
  return { type: "api_error", message: `Anthropic error (${status}): ${body.slice(0, 120)}` };
}

function classifyGeminiError(body: string, status: number): { type: string; message: string } {
  const lower = body.toLowerCase();
  if (status === 400 && lower.includes("api key not valid")) {
    return { type: "invalid_api_key", message: "Invalid Gemini API key." };
  }
  if (status === 429) return { type: "rate_limited", message: "Gemini rate limit exceeded." };
  if (status === 404 || lower.includes("not found")) {
    return { type: "model_unavailable", message: "Model not available. Try a different model." };
  }
  return { type: "api_error", message: `Gemini error (${status}): ${body.slice(0, 120)}` };
}

async function testOpenAI(apiKey: string, model: string): Promise<{ ok: boolean; message: string; errorType?: string; latencyMs: number }> {
  const start = Date.now();
  try {
    const resp = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: { "Authorization": `Bearer ${apiKey}`, "Content-Type": "application/json" },
      body: JSON.stringify({ model, messages: [{ role: "user", content: "Reply with the single word: OK" }], max_tokens: 8, temperature: 0 }),
      signal: AbortSignal.timeout(20_000),
    });
    const latencyMs = Date.now() - start;
    if (!resp.ok) {
      const body = await resp.text();
      const classified = classifyOpenAIError(body, resp.status);
      return { ok: false, message: classified.message, errorType: classified.type, latencyMs };
    }
    return { ok: true, message: "Connection successful", latencyMs };
  } catch (e) {
    return { ok: false, message: e instanceof Error ? e.message : "Network error", errorType: "network_error", latencyMs: Date.now() - start };
  }
}

async function testAnthropic(apiKey: string, model: string): Promise<{ ok: boolean; message: string; errorType?: string; latencyMs: number }> {
  const start = Date.now();
  try {
    const resp = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: { "x-api-key": apiKey, "anthropic-version": "2023-06-01", "content-type": "application/json" },
      body: JSON.stringify({ model, max_tokens: 8, messages: [{ role: "user", content: "Reply with the single word: OK" }] }),
      signal: AbortSignal.timeout(20_000),
    });
    const latencyMs = Date.now() - start;
    if (!resp.ok) {
      const body = await resp.text();
      const classified = classifyAnthropicError(body, resp.status);
      return { ok: false, message: classified.message, errorType: classified.type, latencyMs };
    }
    return { ok: true, message: "Connection successful", latencyMs };
  } catch (e) {
    return { ok: false, message: e instanceof Error ? e.message : "Network error", errorType: "network_error", latencyMs: Date.now() - start };
  }
}

async function testGemini(apiKey: string, model: string): Promise<{ ok: boolean; message: string; errorType?: string; latencyMs: number }> {
  const start = Date.now();
  try {
    const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`;
    const resp = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ contents: [{ role: "user", parts: [{ text: "Reply with the single word: OK" }] }], generationConfig: { maxOutputTokens: 8 } }),
      signal: AbortSignal.timeout(20_000),
    });
    const latencyMs = Date.now() - start;
    if (!resp.ok) {
      const body = await resp.text();
      const classified = classifyGeminiError(body, resp.status);
      return { ok: false, message: classified.message, errorType: classified.type, latencyMs };
    }
    return { ok: true, message: "Connection successful", latencyMs };
  } catch (e) {
    return { ok: false, message: e instanceof Error ? e.message : "Network error", errorType: "network_error", latencyMs: Date.now() - start };
  }
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response(null, { status: 200, headers: corsHeaders });

  // Issue #45: platform operators with MFA only (trusted server-to-server calls with the service-role key also pass).
  {
    const operatorCheck = await requirePlatformOperator(req.headers.get("Authorization"), { allowServiceRole: true });
    if (!operatorCheck.ok) return operatorDeniedResponse(operatorCheck, corsHeaders);
  }

  try {
    const svc = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
    );

    const body = await req.json();
    const provider = body.provider as Provider;
    const requestedModelId = body.model_id as string | undefined;

    if (!VALID_PROVIDERS.includes(provider)) {
      return err(`Invalid provider. Must be one of: ${VALID_PROVIDERS.join(", ")}`);
    }

    // Load provider config (for api_key)
    const { data: cfg } = await svc
      .from("ai_provider_configs")
      .select("api_key, model, is_enabled")
      .eq("provider", provider)
      .maybeSingle();

    if (!cfg?.api_key) {
      const result = { success: false, provider, model_id: null, message: "No API key configured for this provider. Add your API key first.", error_type: "missing_api_key", tested_at: new Date().toISOString() };
      await svc.from("ai_provider_test_results").insert({ provider, model_id: null, status: "failed", error_message: result.message });
      return ok(result);
    }

    // Resolve model to test
    let modelId = requestedModelId;
    if (!modelId) {
      // Try DB default first
      const { data: dbDefault } = await svc
        .from("ai_provider_models")
        .select("model_id")
        .eq("provider", provider)
        .eq("is_default", true)
        .eq("is_active", true)
        .maybeSingle();
      modelId = dbDefault?.model_id ?? cfg.model ?? null;
    }

    if (!modelId) {
      return err("No model available for testing.");
    }

    // Run the test
    let result: { ok: boolean; message: string; errorType?: string; latencyMs: number };
    if (provider === "openai") {
      result = await testOpenAI(cfg.api_key, modelId);
    } else if (provider === "anthropic") {
      result = await testAnthropic(cfg.api_key, modelId);
    } else {
      result = await testGemini(cfg.api_key, modelId);
    }

    const testedAt = new Date().toISOString();

    // Persist result
    await svc.from("ai_provider_test_results").insert({
      provider,
      model_id: modelId,
      status: result.ok ? "success" : "failed",
      error_message: result.ok ? null : result.message,
      latency_ms: result.latencyMs,
      tested_at: testedAt,
    });

    // Update provider health_status
    await svc.from("ai_provider_configs").update({
      health_status: result.ok ? "healthy" : "error",
      health_message: result.message,
      health_latency_ms: result.latencyMs,
      health_checked_at: testedAt,
    }).eq("provider", provider);

    return ok({
      success: result.ok,
      provider,
      model_id: modelId,
      message: result.message,
      error_type: result.errorType ?? null,
      latency_ms: result.latencyMs,
      tested_at: testedAt,
    });
  } catch (e) {
    return err(e instanceof Error ? e.message : "Internal error", 500);
  }
});
