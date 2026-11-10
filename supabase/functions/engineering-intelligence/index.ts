/**
 * Engineering Intelligence Layer — EWO-012
 *
 * Universal AI execution endpoint for EIOS.
 * All AI requests flow through this function — no component calls providers directly.
 *
 * Pipeline:
 *   1. Receive IntelligenceRequest
 *   2. Load prompt from library
 *   3. Build Engineering Context Package (constitution + standards + memory + graph)
 *   4. Assess conversation continuity
 *   5. Select provider via ai-service
 *   6. Execute governed prompt
 *   7. Validate response
 *   8. Score confidence
 *   9. Persist eil_request + eil_result + eil_cost_event
 *  10. Return IntelligenceResult
 */

import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";
import { operatorDeniedResponse, requirePlatformOperator } from "../_shared/platform-operator.ts";
import { generate, createServiceClient } from "../_shared/ai-service.ts";
import type { AIMessage } from "../_shared/ai-service.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, PUT, DELETE, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization, X-Client-Info, Apikey",
};

// ─── Request Types ────────────────────────────────────────────────────────────

type RequestCapability =
  | "engineering_analysis"
  | "engineering_planning"
  | "continuity_assessment"
  | "confidence_assessment"
  | "knowledge_extraction"
  | "custom";

interface IntelligenceRequest {
  capability: RequestCapability;
  conversation_id?: string;
  intent_id?: string;
  plan_id?: string;
  session_id?: string;
  // Allow caller to pass raw context or let EIL build it
  context?: Record<string, unknown>;
  // Override prompt key (uses default for capability if omitted)
  prompt_key?: string;
  temperature?: number;
  max_tokens?: number;
}

interface ContextSource {
  type: string;
  ref: string;
  title: string;
  relevance_score: number;
}

interface EvidenceItem {
  type: string;
  ref: string;
  title: string;
  relevance: string;
}

interface ConfidenceFactor {
  factor: string;
  impact: "positive" | "negative" | "neutral";
  description: string;
}

interface IntelligenceResult {
  request_id: string;
  result_id: string;
  capability: string;
  // Parsed output
  structured_output: Record<string, unknown> | null;
  raw_response: string;
  // Confidence
  confidence: number;
  confidence_level: "high" | "medium" | "low";
  confidence_factors: ConfidenceFactor[];
  confidence_rationale: string;
  missing_information: string[];
  recommended_review_level: string;
  // Evidence
  evidence: EvidenceItem[];
  // Context package summary
  context_sources: ContextSource[];
  context_token_count: number;
  // Continuity
  continuity_type: string;
  continuity_confidence: number;
  continuity_conversation_ids: string[];
  // Provider
  provider: string;
  model: string;
  prompt_tokens: number;
  completion_tokens: number;
  duration_ms: number;
  estimated_cost_usd: number;
  // Validation
  validation_passed: boolean;
  validation_issues: string[];
}

// ─── Context Package Builder ──────────────────────────────────────────────────

async function buildContextPackage(
  svc: ReturnType<typeof createClient>,
  req: IntelligenceRequest,
): Promise<{
  contextText: string;
  contextSources: ContextSource[];
  tokenEstimate: number;
  continuityConversationIds: string[];
  continuityPackageIds: string[];
  continuityConfidence: number;
  continuityType: string;
  graphNodes: unknown[];
  graphRelationships: number;
  memoryRecords: number;
  standardsCount: number;
  constitutionClauses: number;
}> {
  const sections: string[] = [];
  const sources: ContextSource[] = [];
  let graphNodes: unknown[] = [];
  let graphRelationships = 0;
  let memoryRecords = 0;
  let standardsCount = 0;
  let constitutionClauses = 0;
  const continuityConversationIds: string[] = [];
  const continuityPackageIds: string[] = [];
  let continuityConfidence = 0;
  let continuityType = "new";

  // 1. Engineering Constitution
  try {
    const { data: constitution } = await svc
      .from("engineering_constitution")
      .select("clause_ref, title, description, category")
      .eq("is_active", true)
      .order("clause_ref")
      .limit(12);
    if (constitution && constitution.length > 0) {
      constitutionClauses = constitution.length;
      sections.push("## Engineering Constitution");
      for (const c of constitution) {
        sections.push(`### ${c.clause_ref}: ${c.title}\n${c.description ?? ""}`);
        sources.push({ type: "constitution", ref: c.clause_ref, title: c.title, relevance_score: 0.9 });
      }
    }
  } catch (_) {}

  // 2. Engineering Standards (top 5 most relevant)
  try {
    const { data: standards } = await svc
      .from("engineering_standards")
      .select("standard_ref, title, description, category")
      .eq("status", "active")
      .order("created_at", { ascending: false })
      .limit(5);
    if (standards && standards.length > 0) {
      standardsCount = standards.length;
      sections.push("## Engineering Standards");
      for (const s of standards) {
        sections.push(`### ${s.standard_ref}: ${s.title}\n${s.description ?? ""}`);
        sources.push({ type: "standard", ref: s.standard_ref, title: s.title, relevance_score: 0.8 });
      }
    }
  } catch (_) {}

  // 3. Engineering Intent (if provided)
  if (req.intent_id) {
    try {
      const { data: intent } = await svc
        .from("atd_engineering_intents")
        .select("intent_ref, title, raw_input, requested_outcome, business_objective, engineering_objective, scope, constraints")
        .eq("id", req.intent_id)
        .maybeSingle();
      if (intent) {
        sections.push(`## Engineering Intent: ${intent.intent_ref}\nTitle: ${intent.title}\n` +
          `Objective: ${intent.engineering_objective ?? ""}\n` +
          `Business Objective: ${intent.business_objective ?? ""}\n` +
          `Scope: ${intent.scope ?? ""}\nConstraints: ${intent.constraints ?? ""}\n` +
          `Raw Input: ${intent.raw_input ?? ""}`);
        sources.push({ type: "intent", ref: intent.intent_ref, title: intent.title, relevance_score: 1.0 });
      }
    } catch (_) {}
  }

  // 4. Engineering Memory (last 5 relevant records)
  try {
    const { data: memory } = await svc
      .from("engineering_memory")
      .select("memory_ref, title, content, memory_type")
      .order("created_at", { ascending: false })
      .limit(5);
    if (memory && memory.length > 0) {
      memoryRecords = memory.length;
      sections.push("## Engineering Memory");
      for (const m of memory) {
        sections.push(`### ${m.memory_ref}: ${m.title} [${m.memory_type}]\n${(m.content ?? "").slice(0, 300)}`);
        sources.push({ type: "memory", ref: m.memory_ref, title: m.title, relevance_score: 0.7 });
      }
    }
  } catch (_) {}

  // 5. Engineering Intelligence Graph — top relationships
  try {
    const { data: entities } = await svc
      .from("eig_entities")
      .select("entity_ref, entity_type, name, description")
      .order("created_at", { ascending: false })
      .limit(8);
    if (entities && entities.length > 0) {
      graphNodes = entities;
      sections.push("## Engineering Intelligence Graph");
      for (const e of entities) {
        sections.push(`- [${e.entity_type}] ${e.entity_ref}: ${e.name}`);
        sources.push({ type: "graph_node", ref: e.entity_ref, title: e.name, relevance_score: 0.65 });
      }
      const { count } = await svc
        .from("eig_relationships")
        .select("id", { count: "exact", head: true })
        .then((r) => r);
      graphRelationships = count ?? 0;
    }
  } catch (_) {}

  // 6. Related Engineering Packages (from conversation)
  if (req.conversation_id) {
    try {
      const { data: relatedIntents } = await svc
        .from("atd_engineering_intents")
        .select("intent_ref, title, status")
        .eq("source_conversation_id", req.conversation_id)
        .order("created_at", { ascending: false })
        .limit(3);
      if (relatedIntents && relatedIntents.length > 0) {
        sections.push("## Prior Engineering from This Conversation");
        for (const i of relatedIntents) {
          sections.push(`- ${i.intent_ref}: ${i.title} [${i.status}]`);
          sources.push({ type: "prior_intent", ref: i.intent_ref, title: i.title, relevance_score: 0.85 });
        }
      }
    } catch (_) {}

    // Continuity: look for related conversations
    try {
      const { data: lineage } = await svc
        .from("eil_conversation_lineage")
        .select("*")
        .eq("conversation_id", req.conversation_id)
        .maybeSingle();
      if (lineage) {
        continuityConversationIds.push(...(lineage.related_intent_ids ?? []));
        continuityPackageIds.push(...(lineage.related_plan_ids ?? []));
        continuityConfidence = lineage.continuity_confidence ?? 0;
        continuityType = lineage.continuity_type ?? "new";
      }
    } catch (_) {}
  }

  // 7. Caller-supplied context override
  if (req.context && Object.keys(req.context).length > 0) {
    sections.push("## Additional Context");
    sections.push(JSON.stringify(req.context, null, 2).slice(0, 2000));
  }

  const contextText = sections.join("\n\n");
  const tokenEstimate = Math.ceil(contextText.length / 4); // rough token estimate

  return {
    contextText,
    contextSources: sources,
    tokenEstimate,
    continuityConversationIds,
    continuityPackageIds,
    continuityConfidence,
    continuityType,
    graphNodes,
    graphRelationships,
    memoryRecords,
    standardsCount,
    constitutionClauses,
  };
}

// ─── Confidence Scorer ────────────────────────────────────────────────────────

function scoreConfidence(
  structuredOutput: Record<string, unknown> | null,
  contextSources: ContextSource[],
  capability: string,
): {
  confidence: number;
  level: "high" | "medium" | "low";
  factors: ConfidenceFactor[];
  rationale: string;
  recommendedReviewLevel: string;
} {
  const factors: ConfidenceFactor[] = [];
  let score = 50; // base

  // Context richness
  const contextScore = Math.min(30, contextSources.length * 3);
  score += contextScore;
  factors.push({
    factor: "Context Richness",
    impact: contextSources.length >= 5 ? "positive" : "neutral",
    description: `${contextSources.length} context sources available`,
  });

  // Constitution presence
  const hasConstitution = contextSources.some((s) => s.type === "constitution");
  if (hasConstitution) {
    score += 10;
    factors.push({ factor: "Constitutional Context", impact: "positive", description: "Engineering Constitution included in context" });
  } else {
    score -= 10;
    factors.push({ factor: "Constitutional Context", impact: "negative", description: "No constitutional context available" });
  }

  // Structured output quality
  if (structuredOutput) {
    const fields = Object.keys(structuredOutput).length;
    if (fields >= 5) {
      score += 10;
      factors.push({ factor: "Structured Output", impact: "positive", description: `${fields} structured fields returned` });
    }
    // Check for explicit confidence in output
    const outputConfidence = (structuredOutput as Record<string, unknown>).confidence_score;
    if (outputConfidence === "high") score += 10;
    else if (outputConfidence === "low") score -= 15;
  } else {
    score -= 20;
    factors.push({ factor: "Output Parsing", impact: "negative", description: "Could not parse structured output" });
  }

  score = Math.max(0, Math.min(100, score));
  const level = score >= 70 ? "high" : score >= 45 ? "medium" : "low";
  const recommendedReviewLevel =
    score >= 75 ? "spot_check" : score >= 50 ? "full_review" : "mandatory";

  return {
    confidence: score,
    level,
    factors,
    rationale: `Confidence ${score}/100 based on ${contextSources.length} context sources and output quality.`,
    recommendedReviewLevel,
  };
}

// ─── Response Validator ───────────────────────────────────────────────────────

function validateResponse(
  capability: string,
  structured: Record<string, unknown> | null,
): { passed: boolean; issues: string[] } {
  const issues: string[] = [];
  if (!structured) {
    issues.push("Response could not be parsed as structured output");
    return { passed: false, issues };
  }

  const requiredByCapability: Record<string, string[]> = {
    engineering_analysis: ["summary", "constitution_review", "architecture_notes", "complexity_assessment"],
    engineering_planning: ["executive_summary", "engineering_strategy", "recommended_approach", "estimated_effort"],
    continuity_assessment: ["continuity_type", "confidence", "reasoning"],
    confidence_assessment: ["confidence", "confidence_level", "rationale"],
    knowledge_extraction: ["patterns", "decisions", "lessons"],
  };

  const required = requiredByCapability[capability] ?? [];
  for (const field of required) {
    if (!(field in structured) || structured[field] === null || structured[field] === "") {
      issues.push(`Missing required field: ${field}`);
    }
  }

  return { passed: issues.length === 0, issues };
}

// ─── Main handler ─────────────────────────────────────────────────────────────

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { status: 200, headers: corsHeaders });
  }

  // Issue #45: platform operators with MFA only (trusted server-to-server calls with the service-role key also pass).
  {
    const operatorCheck = await requirePlatformOperator(req.headers.get("Authorization"), { allowServiceRole: true });
    if (!operatorCheck.ok) return operatorDeniedResponse(operatorCheck, corsHeaders);
  }

  const startMs = Date.now();

  try {
    const body: IntelligenceRequest = await req.json();
    if (!body.capability) {
      return new Response(JSON.stringify({ error: "capability is required" }), {
        status: 400,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const svc = createServiceClient();

    // ── Step 1: Load prompt ───────────────────────────────────────────────────
    const promptKey = body.prompt_key ?? body.capability;
    const { data: prompt } = await svc
      .from("eil_prompt_library")
      .select("id, system_prompt, user_template, title")
      .eq("prompt_key", promptKey)
      .eq("is_active", true)
      .eq("is_default", true)
      .maybeSingle();

    // ── Step 2: Build context package ────────────────────────────────────────
    const ctx = await buildContextPackage(svc, body);

    // ── Step 3: Compose messages ──────────────────────────────────────────────
    const systemPrompt = prompt?.system_prompt ??
      `You are the EIOS Engineering Intelligence Layer — a governed AI system for ${body.capability}. Respond with valid JSON.`;

    const userTemplate = prompt?.user_template ??
      `Engineering Context Package:\n{{context_package}}\n\nProvide your analysis as JSON.`;

    const userContent = userTemplate.replace("{{context_package}}", ctx.contextText);

    const messages: AIMessage[] = [{ role: "user", content: userContent }];

    // ── Step 4: Create eil_request record ────────────────────────────────────
    const { data: eilRequest } = await svc.from("eil_requests").insert({
      capability: body.capability,
      request_type: "generate",
      conversation_id: body.conversation_id ?? null,
      intent_id: body.intent_id ?? null,
      plan_id: body.plan_id ?? null,
      session_id: body.session_id ?? null,
      prompt_id: prompt?.id ?? null,
      context_package: { system_prompt: systemPrompt, context_text_length: ctx.contextText.length },
      context_sources: ctx.contextSources,
      context_token_count: ctx.tokenEstimate,
      continuity_conversation_ids: ctx.continuityConversationIds,
      continuity_package_ids: ctx.continuityPackageIds,
      continuity_confidence: ctx.continuityConfidence,
      continuity_strategy: ctx.continuityType,
      graph_nodes_retrieved: ctx.graphNodes,
      graph_relationships_retrieved: ctx.graphRelationships,
      memory_records_retrieved: ctx.memoryRecords,
      standards_retrieved: ctx.standardsCount,
      constitution_clauses: ctx.constitutionClauses,
      status: "running",
    }).select("id").maybeSingle();

    const requestId = eilRequest?.id;

    // ── Step 5: Execute provider ──────────────────────────────────────────────
    let rawResponse = "";
    let structuredOutput: Record<string, unknown> | null = null;
    let providerName = "unknown";
    let modelName = "unknown";
    let promptTokens = 0;
    let completionTokens = 0;
    let estimatedCost = 0;
    let durationMs = 0;
    let providerError: string | undefined;

    try {
      const aiResp = await generate(svc, {
        feature: `eil_${body.capability}`,
        messages,
        systemPrompt,
        temperature: body.temperature ?? 0.3,
        maxTokens: body.max_tokens ?? 4096,
      });

      rawResponse = aiResp.content;
      providerName = aiResp.provider;
      modelName = aiResp.model;
      promptTokens = aiResp.promptTokens;
      completionTokens = aiResp.completionTokens;
      estimatedCost = 0; // calculated in ai-service
      durationMs = aiResp.durationMs;

      // Parse JSON from response
      const jsonMatch = rawResponse.match(/\{[\s\S]*\}/);
      if (jsonMatch) {
        try {
          structuredOutput = JSON.parse(jsonMatch[0]);
        } catch (_) {}
      }
    } catch (e) {
      providerError = e instanceof Error ? e.message : String(e);
    }

    durationMs = Date.now() - startMs;

    // ── Step 6: Validate ──────────────────────────────────────────────────────
    const validation = validateResponse(body.capability, structuredOutput);

    // ── Step 7: Score confidence ──────────────────────────────────────────────
    const conf = scoreConfidence(structuredOutput, ctx.contextSources, body.capability);

    // ── Step 8: Extract evidence ──────────────────────────────────────────────
    const evidence: EvidenceItem[] = (structuredOutput?.evidence as EvidenceItem[]) ??
      ctx.contextSources.slice(0, 5).map((s) => ({
        type: s.type,
        ref: s.ref,
        title: s.title,
        relevance: s.relevance_score >= 0.8 ? "high" : "medium",
      }));

    // ── Step 9: Persist result ────────────────────────────────────────────────
    let resultId: string | undefined;
    if (requestId) {
      const { data: eilResult } = await svc.from("eil_results").insert({
        request_id: requestId,
        raw_response: rawResponse,
        structured_output: structuredOutput,
        confidence: conf.confidence,
        confidence_level: conf.level,
        confidence_factors: conf.factors,
        confidence_rationale: conf.rationale,
        missing_information: [],
        recommended_review_level: conf.recommendedReviewLevel,
        evidence_used: evidence,
        evidence_count: evidence.length,
        validation_passed: validation.passed,
        validation_issues: validation.issues,
      }).select("id").maybeSingle();
      resultId = eilResult?.id;

      // Update request with completion status
      await svc.from("eil_requests").update({
        status: providerError ? "error" : "complete",
        provider: providerName,
        model: modelName,
        prompt_tokens: promptTokens,
        completion_tokens: completionTokens,
        estimated_cost_usd: estimatedCost,
        duration_ms: durationMs,
        error_message: providerError ?? null,
        completed_at: new Date().toISOString(),
      }).eq("id", requestId);

      // Persist cost event
      await svc.from("eil_cost_events").insert({
        request_id: requestId,
        capability: body.capability,
        conversation_id: body.conversation_id ?? null,
        intent_id: body.intent_id ?? null,
        provider: providerName,
        model: modelName,
        prompt_tokens: promptTokens,
        completion_tokens: completionTokens,
        prompt_cost_usd: 0,
        completion_cost_usd: 0,
        total_cost_usd: estimatedCost,
        duration_ms: durationMs,
        cache_hit: false,
      });

      // Update prompt usage count
      if (prompt?.id) {
        await svc.from("eil_prompt_library")
          .update({ usage_count: svc.rpc as unknown as number, last_used_at: new Date().toISOString() })
          .eq("id", prompt.id)
          .then(() => {});
      }
    }

    // ── Step 10: Return result ────────────────────────────────────────────────
    const result: IntelligenceResult = {
      request_id: requestId ?? "",
      result_id: resultId ?? "",
      capability: body.capability,
      structured_output: structuredOutput,
      raw_response: rawResponse,
      confidence: conf.confidence,
      confidence_level: conf.level,
      confidence_factors: conf.factors,
      confidence_rationale: conf.rationale,
      missing_information: [],
      recommended_review_level: conf.recommendedReviewLevel,
      evidence: evidence,
      context_sources: ctx.contextSources,
      context_token_count: ctx.tokenEstimate,
      continuity_type: ctx.continuityType,
      continuity_confidence: ctx.continuityConfidence,
      continuity_conversation_ids: ctx.continuityConversationIds,
      provider: providerName,
      model: modelName,
      prompt_tokens: promptTokens,
      completion_tokens: completionTokens,
      duration_ms: durationMs,
      estimated_cost_usd: estimatedCost,
      validation_passed: validation.passed,
      validation_issues: validation.issues,
    };

    if (providerError && !structuredOutput) {
      return new Response(JSON.stringify({ error: providerError, partial: result }), {
        status: 502,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    return new Response(JSON.stringify(result), {
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });

  } catch (err) {
    return new Response(
      JSON.stringify({ error: err instanceof Error ? err.message : String(err) }),
      { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } },
    );
  }
});
