import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";
import { operatorDeniedResponse, requirePlatformOperator } from "../_shared/platform-operator.ts";
import { generate, createServiceClient } from "../_shared/ai-service.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, PUT, DELETE, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization, X-Client-Info, Apikey",
};

// ─── Types ────────────────────────────────────────────────────────────────────

type DraftType = "analysis" | "plan";

interface AnalysisDraftOutput {
  summary: string;
  constitution_review: string;
  architecture_notes: string;
  product_intelligence_notes: string;
  complexity_assessment: "low" | "medium" | "high" | "critical";
  confidence_score: "high" | "medium" | "low";
  confidence_explanation: string;
  evidence: EvidenceItem[];
}

interface PlanDraftOutput {
  executive_summary: string;
  engineering_strategy: string;
  recommended_approach: string;
  estimated_effort: string;
  confidence_score: "high" | "medium" | "low";
  confidence_explanation: string;
  evidence: EvidenceItem[];
}

interface EvidenceItem {
  type: "constitution" | "related_intent" | "knowledge_record" | "engineering_decision";
  ref: string;
  title: string;
  relevance: string;
}

// ─── Context builder ──────────────────────────────────────────────────────────

async function buildIntentContext(
  svc: ReturnType<typeof createClient>,
  intentId: string,
): Promise<string> {
  const sections: string[] = [];

  try {
    const { data: intent } = await svc
      .from("atd_engineering_intents")
      .select("intent_ref, title, raw_input, requested_outcome, business_objective, engineering_objective, scope, constraints")
      .eq("id", intentId)
      .maybeSingle();

    if (intent) {
      sections.push(`## Engineering Intent: ${intent.intent_ref}
Title: ${intent.title}
Raw Input: ${intent.raw_input ?? ""}
Requested Outcome: ${intent.requested_outcome ?? "Not specified"}
Business Objective: ${intent.business_objective ?? "Not specified"}
Engineering Objective: ${intent.engineering_objective ?? "Not specified"}
Scope: ${intent.scope ?? "Not specified"}
Constraints: ${intent.constraints ?? "None specified"}`);
    }
  } catch (_) { /* non-fatal */ }

  try {
    const { data: knowledge } = await svc
      .from("atd_knowledge_records")
      .select("record_ref, title, knowledge_type, content, tags, relevance_score")
      .eq("is_active", true)
      .order("relevance_score", { ascending: false })
      .limit(10);

    if (knowledge && knowledge.length > 0) {
      sections.push("## Relevant Knowledge Records\n" +
        knowledge.map((k: Record<string, unknown>) =>
          `- [${k.record_ref}] ${k.title} (${k.knowledge_type}): ${String(k.content).slice(0, 200)}`
        ).join("\n"));
    }
  } catch (_) { /* non-fatal */ }

  try {
    const { data: decisions } = await svc
      .from("atd_engineering_decisions")
      .select("decision_ref, title, rationale, stage, decided_at")
      .order("decided_at", { ascending: false })
      .limit(10);

    if (decisions && decisions.length > 0) {
      sections.push("## Recent Engineering Decisions\n" +
        decisions.map((d: Record<string, string>) =>
          `- [${d.decision_ref}] ${d.title}: ${d.rationale} (${d.stage})`
        ).join("\n"));
    }
  } catch (_) { /* non-fatal */ }

  try {
    const { data: standards } = await svc
      .from("ecc_engineering_standards")
      .select("ref, title, description, category")
      .eq("status", "active")
      .limit(15);

    if (standards && standards.length > 0) {
      sections.push("## Engineering Constitution & Standards\n" +
        standards.map((s: Record<string, string>) =>
          `- [${s.ref}] ${s.title} (${s.category}): ${String(s.description ?? "").slice(0, 150)}`
        ).join("\n"));
    }
  } catch (_) { /* non-fatal */ }

  try {
    const { data: relatedIntents } = await svc
      .from("atd_engineering_intents")
      .select("intent_ref, title, status")
      .neq("id", intentId)
      .in("lifecycle_status", ["active", "completed"])
      .order("created_at", { ascending: false })
      .limit(10);

    if (relatedIntents && relatedIntents.length > 0) {
      sections.push("## Related Engineering Intents\n" +
        relatedIntents.map((i: Record<string, string>) =>
          `- [${i.intent_ref}] ${i.title} (${i.status})`
        ).join("\n"));
    }
  } catch (_) { /* non-fatal */ }

  return sections.join("\n\n");
}

// ─── Analysis draft generator ─────────────────────────────────────────────────

async function generateAnalysisDraft(
  svc: ReturnType<typeof createClient>,
  intentId: string,
  providerConfigId: string | undefined,
  executionId: string | undefined,
): Promise<AnalysisDraftOutput> {
  const context = await buildIntentContext(svc, intentId);

  const systemPrompt = `You are an expert Engineering Technical Director performing an Engineering Analysis for a software engineering intent.

Your role is to:
1. Assess the intent against the Engineering Constitution and quality standards
2. Identify complexity, risks, and architectural concerns
3. Provide a structured, actionable analysis

You MUST respond with valid JSON matching this exact schema:
{
  "summary": "A concise, complete analysis summary (3-5 sentences)",
  "constitution_review": "How this intent aligns with the Engineering Constitution and relevant standards",
  "architecture_notes": "Key architectural considerations, patterns, risks, and dependencies",
  "product_intelligence_notes": "Relevant product context, user impact, and strategic alignment",
  "complexity_assessment": "low" | "medium" | "high" | "critical",
  "confidence_score": "high" | "medium" | "low",
  "confidence_explanation": "Brief explanation of the confidence score",
  "evidence": [
    {
      "type": "constitution" | "related_intent" | "knowledge_record" | "engineering_decision",
      "ref": "reference string",
      "title": "title",
      "relevance": "one sentence explaining relevance"
    }
  ]
}

Complexity definitions:
- low: straightforward, well-understood domain, minimal risk
- medium: some unknowns, moderate coordination required, manageable risks
- high: significant unknowns, cross-cutting concerns, substantial coordination
- critical: systemic impact, requires Architecture Review Board, high organisational risk

Confidence definitions:
- high: sufficient context, clear scope, well-understood domain
- medium: reasonable context but some gaps, some assumptions required
- low: limited context, significant unknowns, needs more information`;

  const userMessage = `Please analyse the following Engineering Intent and produce a structured Engineering Analysis draft.

${context}

Respond ONLY with the JSON object. No markdown, no explanation, just the JSON.`;

  const aiResponse = await generate(svc, {
    feature: "atd-engineering-draft-analysis",
    messages: [{ role: "user", content: userMessage }],
    systemPrompt,
    temperature: 0.3,
    maxTokens: 2000,
    explicitProviderConfigId: providerConfigId,
  });

  let parsed: AnalysisDraftOutput;
  try {
    const text = aiResponse.content.trim();
    const jsonStr = text.startsWith("{") ? text : text.slice(text.indexOf("{"), text.lastIndexOf("}") + 1);
    parsed = JSON.parse(jsonStr) as AnalysisDraftOutput;
  } catch (_) {
    throw new Error("AI returned malformed JSON for analysis draft");
  }

  if (!parsed.summary || !parsed.complexity_assessment || !parsed.confidence_score) {
    throw new Error("AI analysis draft is missing required fields");
  }

  return parsed;
}

// ─── Plan draft generator ─────────────────────────────────────────────────────

async function generatePlanDraft(
  svc: ReturnType<typeof createClient>,
  intentId: string,
  analysisId: string,
  providerConfigId: string | undefined,
): Promise<PlanDraftOutput> {
  const context = await buildIntentContext(svc, intentId);

  let analysisContext = "";
  try {
    const { data: analysis } = await svc
      .from("atd_engineering_analyses")
      .select("analysis_ref, summary, complexity_assessment, constitution_review, architecture_notes, product_intelligence_notes")
      .eq("id", analysisId)
      .maybeSingle();

    if (analysis) {
      analysisContext = `\n\n## Engineering Analysis: ${analysis.analysis_ref}
Complexity: ${analysis.complexity_assessment}
Summary: ${analysis.summary ?? ""}
Constitution Review: ${analysis.constitution_review ?? ""}
Architecture Notes: ${analysis.architecture_notes ?? ""}
Product Intelligence: ${analysis.product_intelligence_notes ?? ""}`;
    }
  } catch (_) { /* non-fatal */ }

  const systemPrompt = `You are an expert Engineering Technical Director creating an Engineering Plan based on a completed Engineering Analysis.

Your role is to translate the analysis into a structured, actionable engineering plan.

You MUST respond with valid JSON matching this exact schema:
{
  "executive_summary": "A concise executive summary of the engineering plan (3-5 sentences)",
  "engineering_strategy": "The overall technical strategy — phasing, approach, tooling decisions",
  "recommended_approach": "Specific implementation approach with key technical choices",
  "estimated_effort": "Realistic effort estimate (e.g. '2-3 weeks', '40 hours', '2 sprints')",
  "confidence_score": "high" | "medium" | "low",
  "confidence_explanation": "Brief explanation of the confidence in this plan",
  "evidence": [
    {
      "type": "constitution" | "related_intent" | "knowledge_record" | "engineering_decision",
      "ref": "reference string",
      "title": "title",
      "relevance": "one sentence explaining relevance"
    }
  ]
}

Confidence definitions:
- high: clear scope, well-understood approach, analysis is thorough
- medium: reasonable scope but some planning gaps or dependencies uncertain
- low: significant planning uncertainties, needs more analysis or stakeholder input`;

  const userMessage = `Please generate an Engineering Plan draft based on the following Engineering Intent and Analysis.

${context}${analysisContext}

Respond ONLY with the JSON object. No markdown, no explanation, just the JSON.`;

  const aiResponse = await generate(svc, {
    feature: "atd-engineering-draft-plan",
    messages: [{ role: "user", content: userMessage }],
    systemPrompt,
    temperature: 0.3,
    maxTokens: 2000,
    explicitProviderConfigId: providerConfigId,
  });

  let parsed: PlanDraftOutput;
  try {
    const text = aiResponse.content.trim();
    const jsonStr = text.startsWith("{") ? text : text.slice(text.indexOf("{"), text.lastIndexOf("}") + 1);
    parsed = JSON.parse(jsonStr) as PlanDraftOutput;
  } catch (_) {
    throw new Error("AI returned malformed JSON for plan draft");
  }

  if (!parsed.executive_summary || !parsed.confidence_score) {
    throw new Error("AI plan draft is missing required fields");
  }

  return parsed;
}

// ─── Handler ──────────────────────────────────────────────────────────────────

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
    const svc = createServiceClient();

    const body = await req.json() as {
      draft_type: DraftType;
      intent_id: string;
      analysis_id?: string;
      _providerConfigId?: string;
      _executionId?: string;
    };

    const { draft_type, intent_id, analysis_id, _providerConfigId, _executionId } = body;

    if (!draft_type || !intent_id) {
      return new Response(
        JSON.stringify({ error: "draft_type and intent_id are required" }),
        { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } },
      );
    }

    if (draft_type === "analysis") {
      const draft = await generateAnalysisDraft(svc, intent_id, _providerConfigId, _executionId);
      return new Response(
        JSON.stringify({ draft_type: "analysis", ...draft }),
        { headers: { ...corsHeaders, "Content-Type": "application/json" } },
      );
    }

    if (draft_type === "plan") {
      if (!analysis_id) {
        return new Response(
          JSON.stringify({ error: "analysis_id is required for plan drafts" }),
          { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } },
        );
      }
      const draft = await generatePlanDraft(svc, intent_id, analysis_id, _providerConfigId);
      return new Response(
        JSON.stringify({ draft_type: "plan", ...draft }),
        { headers: { ...corsHeaders, "Content-Type": "application/json" } },
      );
    }

    return new Response(
      JSON.stringify({ error: `Unknown draft_type: ${draft_type}` }),
      { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } },
    );
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return new Response(
      JSON.stringify({ error: message }),
      { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } },
    );
  }
});
