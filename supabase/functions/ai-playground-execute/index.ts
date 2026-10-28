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

const PRICING: Record<string, [number, number]> = {
  "gpt-4o":                  [0.000005,   0.000015   ],
  "gpt-4o-mini":             [0.00000015, 0.0000006  ],
  "o3-mini":                 [0.0000011,  0.0000044  ],
  "o3":                      [0.00001,    0.00004    ],
  "gpt-5.4-nano":            [0.000000075,0.0000003  ],
  "gpt-5.4-mini":            [0.00000015, 0.0000006  ],
  "gpt-5.4":                 [0.000005,   0.000015   ],
  "gpt-5.5":                 [0.000005,   0.000015   ],
  "claude-3-5-sonnet":       [0.000003,   0.000015   ],
  "claude-3-5-haiku":        [0.00000025, 0.00000125 ],
  "claude-3-opus":           [0.000015,   0.000075   ],
  "claude-opus-4-5":         [0.000015,   0.000075   ],
  "gemini-2.5-flash":        [0.0000003,  0.0000025  ],
  "gemini-2.5-pro":          [0.00000125, 0.00001    ],
  "gemini-1.5-flash":        [0.000000075,0.0000003  ],
  "gemini-1.5-pro":          [0.00000125, 0.000005   ],
};

function estimateCost(model: string, inp: number, out: number): number {
  const key = Object.keys(PRICING).find(k => model.toLowerCase().includes(k.toLowerCase()));
  if (!key) return 0;
  const [inRate, outRate] = PRICING[key];
  return inp * inRate + out * outRate;
}

async function callOpenAI(
  apiKey: string, model: string,
  systemPrompt: string, userPrompt: string,
  temperature: number, maxTokens: number,
): Promise<{ content: string; inputTokens: number; outputTokens: number }> {
  const messages = systemPrompt
    ? [{ role: "system", content: systemPrompt }, { role: "user", content: userPrompt }]
    : [{ role: "user", content: userPrompt }];

  const resp = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: { "Authorization": `Bearer ${apiKey}`, "Content-Type": "application/json" },
    body: JSON.stringify({ model, messages, temperature, max_tokens: maxTokens }),
    signal: AbortSignal.timeout(60_000),
  });
  if (!resp.ok) {
    const body = await resp.text();
    throw new Error(`OpenAI error ${resp.status}: ${body.slice(0, 300)}`);
  }
  const data = await resp.json();
  return {
    content: data.choices?.[0]?.message?.content ?? "",
    inputTokens: data.usage?.prompt_tokens ?? 0,
    outputTokens: data.usage?.completion_tokens ?? 0,
  };
}

async function callAnthropic(
  apiKey: string, model: string,
  systemPrompt: string, userPrompt: string,
  temperature: number, maxTokens: number,
): Promise<{ content: string; inputTokens: number; outputTokens: number }> {
  const body: Record<string, unknown> = {
    model, max_tokens: maxTokens, temperature,
    messages: [{ role: "user", content: userPrompt }],
  };
  if (systemPrompt) body.system = systemPrompt;

  const resp = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: { "x-api-key": apiKey, "anthropic-version": "2023-06-01", "content-type": "application/json" },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(60_000),
  });
  if (!resp.ok) {
    const errBody = await resp.text();
    throw new Error(`Anthropic error ${resp.status}: ${errBody.slice(0, 300)}`);
  }
  const data = await resp.json();
  return {
    content: data.content?.[0]?.text ?? "",
    inputTokens: data.usage?.input_tokens ?? 0,
    outputTokens: data.usage?.output_tokens ?? 0,
  };
}

async function callGemini(
  apiKey: string, model: string,
  systemPrompt: string, userPrompt: string,
  temperature: number, maxTokens: number,
): Promise<{ content: string; inputTokens: number; outputTokens: number }> {
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`;
  const reqBody: Record<string, unknown> = {
    contents: [{ role: "user", parts: [{ text: userPrompt }] }],
    generationConfig: { temperature, maxOutputTokens: maxTokens },
  };
  if (systemPrompt) reqBody.systemInstruction = { parts: [{ text: systemPrompt }] };

  const resp = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(reqBody),
    signal: AbortSignal.timeout(60_000),
  });
  if (!resp.ok) {
    const errBody = await resp.text();
    throw new Error(`Gemini error ${resp.status}: ${errBody.slice(0, 300)}`);
  }
  const data = await resp.json();
  return {
    content: data.candidates?.[0]?.content?.parts?.[0]?.text ?? "",
    inputTokens: data.usageMetadata?.promptTokenCount ?? 0,
    outputTokens: data.usageMetadata?.candidatesTokenCount ?? 0,
  };
}

async function runPrompt(
  svc: ReturnType<typeof createClient>,
  provider: Provider,
  modelId: string | undefined,
  systemPrompt: string,
  userPrompt: string,
  temperature: number,
  maxTokens: number,
): Promise<{
  content: string;
  provider: string;
  model: string;
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  estimatedCost: number;
  executionTimeMs: number;
}> {
  const { data: cfg } = await svc
    .from("ai_provider_configs")
    .select("api_key, model")
    .eq("provider", provider)
    .maybeSingle();

  if (!cfg?.api_key) throw new Error(`No API key configured for ${provider}`);

  let resolvedModel = modelId;
  if (!resolvedModel) {
    const { data: dbModel } = await svc
      .from("ai_provider_models")
      .select("model_id")
      .eq("provider", provider)
      .eq("is_default", true)
      .eq("is_active", true)
      .maybeSingle();
    resolvedModel = dbModel?.model_id ?? cfg.model ?? "gpt-4o";
  }

  const start = Date.now();
  let result: { content: string; inputTokens: number; outputTokens: number };

  if (provider === "anthropic") {
    result = await callAnthropic(cfg.api_key, resolvedModel, systemPrompt, userPrompt, temperature, maxTokens);
  } else if (provider === "gemini") {
    result = await callGemini(cfg.api_key, resolvedModel, systemPrompt, userPrompt, temperature, maxTokens);
  } else {
    result = await callOpenAI(cfg.api_key, resolvedModel, systemPrompt, userPrompt, temperature, maxTokens);
  }

  const executionTimeMs = Date.now() - start;
  const totalTokens = result.inputTokens + result.outputTokens;
  const estimatedCost = estimateCost(resolvedModel, result.inputTokens, result.outputTokens);

  return {
    content: result.content,
    provider,
    model: resolvedModel,
    inputTokens: result.inputTokens,
    outputTokens: result.outputTokens,
    totalTokens,
    estimatedCost,
    executionTimeMs,
  };
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
    const {
      provider = "openai",
      model_id,
      system_prompt = "",
      user_prompt,
      temperature = 0.7,
      max_tokens = 1000,
      prompt_name,
      compare_provider,
      compare_model_id,
    } = body as {
      provider?: string;
      model_id?: string;
      system_prompt?: string;
      user_prompt: string;
      temperature?: number;
      max_tokens?: number;
      prompt_name?: string;
      compare_provider?: string;
      compare_model_id?: string;
    };

    if (!user_prompt?.trim()) return err("user_prompt is required");
    if (!VALID_PROVIDERS.includes(provider as Provider)) {
      return err(`Invalid provider. Must be one of: ${VALID_PROVIDERS.join(", ")}`);
    }

    const safeTemp = Math.min(2, Math.max(0, temperature));
    const safeTokens = Math.min(8000, Math.max(50, max_tokens));

    // Primary run
    let primaryResult: Awaited<ReturnType<typeof runPrompt>> | null = null;
    let primaryError: string | null = null;
    try {
      primaryResult = await runPrompt(svc, provider as Provider, model_id, system_prompt, user_prompt, safeTemp, safeTokens);
    } catch (e) {
      primaryError = e instanceof Error ? e.message : String(e);
    }

    // Save to history
    await svc.from("ai_playground_history").insert({
      provider,
      model: primaryResult?.model ?? model_id ?? "unknown",
      prompt_name: prompt_name ?? null,
      system_prompt: system_prompt || null,
      user_prompt,
      response: primaryResult?.content ?? null,
      input_tokens: primaryResult?.inputTokens ?? null,
      output_tokens: primaryResult?.outputTokens ?? null,
      total_tokens: primaryResult?.totalTokens ?? null,
      estimated_cost: primaryResult?.estimatedCost ?? null,
      execution_time_ms: primaryResult?.executionTimeMs ?? null,
      success: primaryError === null,
      error_message: primaryError,
      temperature: safeTemp,
      max_tokens: safeTokens,
    });

    if (primaryError) {
      return ok({ success: false, error: primaryError, provider, model: model_id });
    }

    // Comparison run (optional)
    let compareResult: Awaited<ReturnType<typeof runPrompt>> | null = null;
    let compareError: string | null = null;
    if (compare_provider && VALID_PROVIDERS.includes(compare_provider as Provider)) {
      try {
        compareResult = await runPrompt(svc, compare_provider as Provider, compare_model_id, system_prompt, user_prompt, safeTemp, safeTokens);
        await svc.from("ai_playground_history").insert({
          provider: compare_provider,
          model: compareResult.model,
          prompt_name: prompt_name ? `${prompt_name} (comparison)` : null,
          system_prompt: system_prompt || null,
          user_prompt,
          response: compareResult.content,
          input_tokens: compareResult.inputTokens,
          output_tokens: compareResult.outputTokens,
          total_tokens: compareResult.totalTokens,
          estimated_cost: compareResult.estimatedCost,
          execution_time_ms: compareResult.executionTimeMs,
          success: true,
          temperature: safeTemp,
          max_tokens: safeTokens,
        });
      } catch (e) {
        compareError = e instanceof Error ? e.message : String(e);
      }
    }

    return ok({
      success: true,
      primary: primaryResult,
      compare: compareResult ?? (compareError ? { error: compareError } : null),
    });
  } catch (e) {
    return err(e instanceof Error ? e.message : "Internal error", 500);
  }
});
