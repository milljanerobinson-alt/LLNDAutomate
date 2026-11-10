import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";
import { operatorDeniedResponse, requirePlatformOperator } from "../_shared/platform-operator.ts";
import { generate, createServiceClient } from "../_shared/ai-service.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, PUT, DELETE, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization, X-Client-Info, Apikey",
};

// ─── Required plan schema fields ──────────────────────────────────────────────

const REQUIRED_PLAN_FIELDS = [
  "executive_summary",
  "business_objective",
  "engineering_objective",
  "engineering_analysis",
  "recommended_strategy",
  "engineering_phases",
  "estimated_effort",
  "risks",
  "standards_affected",
  "recommended_ewos",
  "implementation_recommendation",
] as const;

function validatePlanSchema(plan: Record<string, unknown>): string[] {
  const missing: string[] = [];
  for (const field of REQUIRED_PLAN_FIELDS) {
    const v = plan[field];
    if (v === undefined || v === null || v === "") {
      missing.push(field);
    } else if (
      (field === "engineering_phases" || field === "risks" ||
       field === "standards_affected" || field === "recommended_ewos") &&
      !Array.isArray(v)
    ) {
      missing.push(`${field} (must be array)`);
    }
  }
  return missing;
}

// ─── Platform context builder ─────────────────────────────────────────────────

async function buildPlatformContext(
  svc: ReturnType<typeof createClient>,
  organisationId: string | null,
): Promise<string> {
  const sections: string[] = [];

  // Helper: apply org filter when the caller is tenant-scoped
  function orgFilter<T extends { eq: (col: string, val: string) => T }>(
    query: T,
  ): T {
    return organisationId ? query.eq("organisation_id", organisationId) : query;
  }

  try {
    const q = svc
      .from("atd_engineering_decisions")
      .select("decision_ref, title, rationale, stage, decided_at")
      .order("decided_at", { ascending: false })
      .limit(15);
    const { data: decisions } = await q;
    if (decisions && decisions.length > 0) {
      sections.push("## Recent Engineering Decisions\n" +
        decisions.map((d: Record<string, string>) =>
          `- [${d.decision_ref}] ${d.title}: ${d.rationale} (${d.stage})`
        ).join("\n"));
    }
  } catch (_) { /* non-fatal */ }

  try {
    let q = svc
      .from("atd_engineering_intents")
      .select("intent_ref, title, status, created_at")
      .order("created_at", { ascending: false })
      .limit(20);
    if (organisationId) q = q.eq("organisation_id", organisationId);
    const { data: intents } = await q;
    if (intents && intents.length > 0) {
      sections.push("## Existing Engineering Intents\n" +
        intents.map((i: Record<string, string>) =>
          `- [${i.intent_ref}] ${i.title} — ${i.status}`
        ).join("\n"));
    }
  } catch (_) { /* non-fatal */ }

  try {
    const { data: knowledge } = await svc
      .from("atd_knowledge_records")
      .select("title, knowledge_type, content, tags")
      .eq("is_active", true)
      .order("relevance_score", { ascending: false })
      .limit(15);
    if (knowledge && knowledge.length > 0) {
      sections.push("## Engineering Knowledge Base\n" +
        knowledge.map((k: Record<string, unknown>) =>
          `- [${k.knowledge_type}] ${k.title}: ${(k.content as string).slice(0, 150)}`
        ).join("\n"));
    }
  } catch (_) { /* non-fatal */ }

  try {
    const { data: features } = await svc
      .from("features")
      .select("name, status, phase")
      .in("status", ["active", "planned", "in_development"])
      .order("name")
      .limit(30);
    if (features && features.length > 0) {
      sections.push("## Platform Features\n" +
        features.map((f: Record<string, string>) =>
          `- ${f.name} (${f.status}, phase: ${f.phase ?? "unassigned"})`
        ).join("\n"));
    }
  } catch (_) { /* non-fatal */ }

  try {
    const { data: wos } = await svc
      .from("engineering_work_orders")
      .select("ref, title, status, category")
      .order("created_at", { ascending: false })
      .limit(20);
    if (wos && wos.length > 0) {
      sections.push("## Recent Engineering Work Orders\n" +
        wos.map((w: Record<string, string>) =>
          `- [${w.ref}] ${w.title} — ${w.status} (${w.category})`
        ).join("\n"));
    }
  } catch (_) { /* non-fatal */ }

  // Suppress unused variable warning
  void orgFilter;

  return sections.length > 0
    ? sections.join("\n\n")
    : "No platform context available — operating without historical data.";
}

// ─── Compute a simple content hash ───────────────────────────────────────────

async function hashPlanContent(plan: Record<string, unknown>): Promise<string> {
  try {
    const canonical = JSON.stringify(plan, Object.keys(plan).sort());
    const encoded = new TextEncoder().encode(canonical);
    const buffer = await crypto.subtle.digest("SHA-256", encoded);
    return Array.from(new Uint8Array(buffer)).map(b => b.toString(16).padStart(2, "0")).join("");
  } catch {
    return "";
  }
}

// ─── System prompt ────────────────────────────────────────────────────────────

function buildSystemPrompt(platformContext: string): string {
  return `You are the ATD Reasoning Engine — the strategic intelligence layer of an Engineering Command Centre.

Your role is to analyse a Product Owner's engineering intent and generate a comprehensive Engineering Plan.

You have access to the following platform context:

${platformContext}

## Output Requirements

You MUST respond with a valid JSON object (no markdown fences) containing ALL of the following fields:

{
  "executive_summary": "2-3 sentence plain-language summary for stakeholders",
  "business_objective": "Clear statement of the business value being delivered",
  "engineering_objective": "Technical objective — what the engineering team must build",
  "engineering_analysis": "Detailed technical analysis: architecture implications, data model changes, integration points, risks, and constraints",
  "recommended_strategy": "The recommended engineering approach and why",
  "engineering_phases": [
    { "phase": 1, "name": "Phase name", "description": "What is delivered in this phase", "estimated_effort": "X weeks" }
  ],
  "estimated_effort": "Total effort estimate (e.g. 3-6 weeks)",
  "risks": ["Risk 1", "Risk 2"],
  "standards_affected": ["Standard or architectural pattern affected"],
  "recommended_ewos": ["EWO short title 1", "EWO short title 2"],
  "implementation_recommendation": "Specific recommendation on how to proceed, dependencies, and sequencing"
}

Be precise, engineering-grade, and grounded in the platform context. Do not fabricate data. If the platform context is sparse, acknowledge it and reason from first principles.`;
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

  try {
    const body = await req.json();
    const {
      title,
      raw_input,
      requested_outcome,
      business_objective,
      engineering_objective,
      scope,
      constraints,
      intent_id,
      organisation_id,
      _providerConfigId,
      _executionId,
    } = body as {
      title: string;
      raw_input: string;
      requested_outcome?: string;
      business_objective?: string;
      engineering_objective?: string;
      scope?: string;
      constraints?: string;
      intent_id?: string;
      organisation_id?: string;
      _providerConfigId?: string;
      _executionId?: string;
    };

    if (!title || !raw_input) {
      return new Response(
        JSON.stringify({ error: "title and raw_input are required" }),
        { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } },
      );
    }

    const svc = createServiceClient();
    const tenantOrgId = organisation_id ?? null;

    // Transition intent to 'analysing' immediately
    if (intent_id) {
      let q = svc
        .from("atd_engineering_intents")
        .update({ status: "analysing" })
        .eq("id", intent_id)
        .in("status", ["captured", "analysed", "planned", "rejected"]);
      if (tenantOrgId) q = q.eq("organisation_id", tenantOrgId);
      await q;
    }

    const platformContext = await buildPlatformContext(svc, tenantOrgId);

    const userMessage = [
      `## Engineering Intent: ${title}`,
      ``,
      `**Product Owner Request:**`,
      raw_input,
      requested_outcome   ? `\n**Requested Outcome:** ${requested_outcome}` : "",
      business_objective  ? `\n**Business Objective:** ${business_objective}` : "",
      engineering_objective ? `\n**Engineering Objective:** ${engineering_objective}` : "",
      scope               ? `\n**Scope:** ${scope}` : "",
      constraints         ? `\n**Constraints:** ${constraints}` : "",
    ].filter(Boolean).join("\n");

    const systemPrompt = buildSystemPrompt(platformContext);

    const aiResponse = await generate(svc, {
      feature: "atd-reasoning",
      systemPrompt,
      messages: [{ role: "user", content: userMessage }],
      temperature: 0.4,
      maxTokens: 4096,
      userId: undefined,
      explicitProviderConfigId: _providerConfigId,
    });

    // Parse the AI response as JSON
    let plan: Record<string, unknown>;
    try {
      const cleaned = aiResponse.content.replace(/^```json\s*/i, "").replace(/```\s*$/i, "").trim();
      plan = JSON.parse(cleaned);
    } catch {
      return new Response(
        JSON.stringify({
          error: "AI_PARSE_ERROR: The reasoning engine returned a non-JSON response.",
          failure_category: "schema_validation_error",
          raw_response: aiResponse.content,
        }),
        { status: 422, headers: { ...corsHeaders, "Content-Type": "application/json" } },
      );
    }

    // Schema validation
    const missingFields = validatePlanSchema(plan);
    if (missingFields.length > 0) {
      return new Response(
        JSON.stringify({
          error: `SCHEMA_VALIDATION_FAILED: Missing or invalid fields: ${missingFields.join(", ")}`,
          failure_category: "schema_validation_error",
          missing_fields: missingFields,
        }),
        { status: 422, headers: { ...corsHeaders, "Content-Type": "application/json" } },
      );
    }

    // Persist versioned engineering plan
    let savedPlanId: string | undefined;
    let savedPlanRef: string | undefined;
    let planVersion = 1;

    if (intent_id) {
      try {
        // Find any existing awaiting_approval plans for this intent and supersede them
        let priorQuery = svc
          .from("atd_engineering_plans")
          .select("id, plan_ref, version_number, status")
          .eq("intent_id", intent_id)
          .in("status", ["draft", "awaiting_approval"])
          .order("version_number", { ascending: false });
        if (tenantOrgId) priorQuery = priorQuery.eq("organisation_id", tenantOrgId);
        const { data: priorPlans } = await priorQuery;

        if (priorPlans && priorPlans.length > 0) {
          planVersion = (priorPlans[0].version_number ?? 0) + 1;
          let supersededQuery = svc
            .from("atd_engineering_plans")
            .update({ status: "superseded" })
            .eq("intent_id", intent_id)
            .in("status", ["draft", "awaiting_approval"]);
          if (tenantOrgId) supersededQuery = supersededQuery.eq("organisation_id", tenantOrgId);
          await supersededQuery;
        }

        const contentHash = await hashPlanContent(plan);

        // Generate plan ref
        const { count } = await svc
          .from("atd_engineering_plans")
          .select("*", { count: "exact", head: true });
        const n = ((count ?? 0) + 1).toString().padStart(3, "0");
        const plan_ref = `ATD-PLAN-${n}`;

        const { data: savedPlan } = await svc
          .from("atd_engineering_plans")
          .insert({
            plan_ref,
            intent_id,
            executive_summary: plan.executive_summary ?? null,
            engineering_strategy: plan.recommended_strategy ?? null,
            recommended_approach: plan.implementation_recommendation ?? null,
            estimated_effort: plan.estimated_effort ?? null,
            required_ewos: Array.isArray(plan.recommended_ewos) ? plan.recommended_ewos : [],
            engineering_phases: Array.isArray(plan.engineering_phases) ? plan.engineering_phases : [],
            status: "awaiting_approval",
            version_number: planVersion,
            plan_content_hash: contentHash || null,
            plan_payload: plan,
            capability_execution_id: _executionId ?? null,
            generating_provider: aiResponse.provider,
            generating_model: aiResponse.model,
            created_by: "atd-reasoning",
            organisation_id: tenantOrgId,
            ...(priorPlans && priorPlans.length > 0
              ? { supersedes_plan_id: priorPlans[0].id }
              : {}),
          })
          .select()
          .single();

        if (savedPlan) {
          savedPlanId = savedPlan.id;
          savedPlanRef = savedPlan.plan_ref;

          // Link prior superseded plan back to new version
          if (priorPlans && priorPlans.length > 0) {
            await svc
              .from("atd_engineering_plans")
              .update({ superseded_by_plan_id: savedPlan.id })
              .eq("id", priorPlans[0].id);
          }
        }

        // Transition intent to awaiting_approval (tenant-scoped)
        let updateIntentQuery = svc
          .from("atd_engineering_intents")
          .update({ status: "awaiting_approval" })
          .eq("id", intent_id);
        if (tenantOrgId) updateIntentQuery = updateIntentQuery.eq("organisation_id", tenantOrgId);
        await updateIntentQuery;

      } catch (persistErr) {
        // Non-fatal — return the plan data even if persistence fails
        console.error("Plan persistence error:", persistErr);
      }
    }

    return new Response(
      JSON.stringify({
        ...plan,
        _plan_id: savedPlanId ?? null,
        _plan_ref: savedPlanRef ?? null,
        _plan_version: planVersion,
        _provider: aiResponse.provider,
        _model: aiResponse.model,
        _tokens_prompt: aiResponse.promptTokens,
        _tokens_completion: aiResponse.completionTokens,
        _tokens: aiResponse.promptTokens + aiResponse.completionTokens,
        _duration_ms: aiResponse.durationMs,
        _routing: aiResponse.routingMetadata ?? null,
      }),
      { headers: { ...corsHeaders, "Content-Type": "application/json" } },
    );

  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const failureCategory = message.includes("NO_API_KEY") ? "no_provider" : "unknown";
    return new Response(
      JSON.stringify({ error: message, failure_category: failureCategory }),
      { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } },
    );
  }
});
