import { createClient } from "jsr:@supabase/supabase-js@2";
import { operatorDeniedResponse, requirePlatformOperator } from "../_shared/platform-operator.ts";
import { generate, loadAIConfig } from "../_shared/ai-service.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, PUT, DELETE, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization, X-Client-Info, Apikey",
};

function json(data: unknown, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

// ── Auth ──────────────────────────────────────────────────────────────────────

async function verifyAdmin(req: Request) {
  const header = req.headers.get("Authorization");
  if (!header?.startsWith("Bearer ")) return null;
  const token = header.replace("Bearer ", "");
  const anon = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_ANON_KEY")!);
  const { data: { user }, error } = await anon.auth.getUser(token);
  if (error || !user) return null;
  const svc = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);
  const { data: profile } = await svc.from("profiles").select("role").eq("id", user.id).maybeSingle();
  // Issue #45: operator status (grant + MFA) is enforced by requirePlatformOperator() in the request handler; the legacy profiles.role check is retired.
  if (!profile) return null;
  return { svc, userId: user.id };
}

// ── Context builders ───────────────────────────────────────────────────────────

async function buildDevPhasesContext(svc: ReturnType<typeof createClient>): Promise<string> {
  const { data: phases } = await svc
    .from("ecc_dev_phases")
    .select("phase_number,title,description,status,priority,confidence,estimated_build_time,estimated_risk,release_version,completed_at,objectives,acceptance_criteria,implementation_tasks,related_features,related_db_objects,notes")
    .order("phase_number");

  if (!phases?.length) return "No development phases defined.";

  return phases.map((p: Record<string, unknown>) => {
    const obj = Array.isArray(p.objectives) ? (p.objectives as string[]).join("; ") : "";
    const ac  = Array.isArray(p.acceptance_criteria) ? (p.acceptance_criteria as string[]).join("; ") : "";
    const completed = p.completed_at ? ` [COMPLETED ${(p.completed_at as string).slice(0, 10)}]` : "";
    return `Phase ${p.phase_number}: ${p.title} [${(p.status as string).toUpperCase()}] priority:${p.priority} risk:${p.estimated_risk}${completed}
  Version: ${p.release_version ?? "TBD"}
  Objectives: ${obj}
  Acceptance: ${ac}
  DB: ${Array.isArray(p.related_db_objects) ? (p.related_db_objects as string[]).join(",") : ""}`;
  }).join("\n\n");
}

async function buildEIGContext(svc: ReturnType<typeof createClient>): Promise<string> {
  const [entitiesRes, relRes] = await Promise.all([
    svc.from("eig_entities").select("entity_type,entity_ref,name,status,description,tags").order("entity_type").order("name").limit(200),
    svc.from("eig_relationships").select("from_entity_id,to_entity_id,relationship_type,strength").limit(300),
  ]);

  const entities = entitiesRes.data ?? [];
  const rels     = relRes.data ?? [];

  if (entities.length === 0) return "Engineering Intelligence Graph: no entities found.";

  const byType: Record<string, string[]> = {};
  for (const e of entities) {
    const t = e.entity_type as string;
    if (!byType[t]) byType[t] = [];
    byType[t].push(`${e.entity_ref ? `[${e.entity_ref}]` : ""}${e.name}(${e.status})`);
  }

  const entitySummary = Object.entries(byType)
    .map(([type, items]) => `  ${type} (${items.length}): ${items.slice(0, 6).join(", ")}${items.length > 6 ? ` +${items.length - 6} more` : ""}`)
    .join("\n");

  const relTypeCounts: Record<string, number> = {};
  for (const r of rels) {
    relTypeCounts[r.relationship_type as string] = (relTypeCounts[r.relationship_type as string] ?? 0) + 1;
  }
  const relSummary = Object.entries(relTypeCounts).sort((a, b) => b[1] - a[1]).slice(0, 8)
    .map(([t, c]) => `${t}: ${c}`).join(", ");

  return `## Engineering Intelligence Graph
Total entities: ${entities.length} | Total relationships: ${rels.length}

${entitySummary}

Relationship types: ${relSummary}`;
}

async function buildFullContext(svc: ReturnType<typeof createClient>): Promise<string> {
  const [
    features, roadmap, milestones, decisions, standards,
    goals, epics, backlog, docs, devPhases, usageLog, eigContext,
  ] = await Promise.all([
    svc.from("ecc_product_features").select("feature_id,name,category,lifecycle_stage,testing_status,compliance_critical,operational_risk,priority,documentation_status").order("feature_id"),
    svc.from("ecc_roadmap_items").select("title,status,priority").order("position").limit(30),
    svc.from("ecc_milestones").select("name,status,target_date").order("sort_order").limit(15),
    svc.from("ecc_decisions").select("title,status,category,decision_date").order("decision_date", { ascending: false }).limit(15),
    svc.from("ecc_engineering_standards").select("title,category,status").limit(20),
    svc.from("ecc_goals").select("title,status,priority,progress_pct").order("position").limit(15),
    svc.from("ecc_epics").select("title,status,priority,progress_pct").order("position").limit(15),
    svc.from("ecc_backlog_items").select("title,priority,status,item_type,risk").order("created_at", { ascending: false }).limit(30),
    svc.from("ecc_documentation").select("title,doc_type,version,status").order("updated_at", { ascending: false }).limit(20),
    svc.from("ecc_dev_phases").select("*").order("phase_number"),
    svc.from("ai_usage_log").select("feature,model,success,cache_hit,estimated_cost_usd").order("created_at", { ascending: false }).limit(50),
    buildEIGContext(svc),
  ]);

  const fData = features.data ?? [];
  const featureStats = {
    total: fData.length,
    live: fData.filter((f: Record<string, unknown>) => f.lifecycle_stage === "live").length,
    in_dev: fData.filter((f: Record<string, unknown>) => f.lifecycle_stage === "in_development").length,
    not_tested: fData.filter((f: Record<string, unknown>) => f.testing_status === "not_tested").length,
    compliance_critical: fData.filter((f: Record<string, unknown>) => f.compliance_critical).length,
    docs_missing: fData.filter((f: Record<string, unknown>) => f.documentation_status === "missing" || f.documentation_status === "draft").length,
  };

  const phaseContext = await buildDevPhasesContext(svc);
  const currentPhase = (devPhases.data ?? []).find((p: Record<string, unknown>) => p.status === "in_progress");
  const nextPlanned  = (devPhases.data ?? []).find((p: Record<string, unknown>) => p.status === "planned");

  const usageStats = usageLog.data ?? [];
  const totalCost = usageStats.reduce((s: number, r: Record<string, unknown>) => s + ((r.estimated_cost_usd as number) ?? 0), 0);
  const cacheHits = usageStats.filter((r: Record<string, unknown>) => r.cache_hit).length;

  return `
# Technical Director — Full Platform Context
Date: ${new Date().toISOString().slice(0, 10)}

## Platform
LLND Automate — SaaS for Australian RTOs. Automates LLN and Digital Literacy assessment.
Stack: React 18 + TypeScript + Vite + Tailwind | Supabase (Postgres + RLS + Edge Functions + Auth) | Stripe | aXcelerate | pg_cron | Platform-managed AI (OpenAI/Anthropic)

## Development Programme Status
Current in-progress phase: ${currentPhase ? `Phase ${(currentPhase as Record<string,unknown>).phase_number} — ${(currentPhase as Record<string,unknown>).title}` : "None"}
Next planned phase: ${nextPlanned ? `Phase ${(nextPlanned as Record<string,unknown>).phase_number} — ${(nextPlanned as Record<string,unknown>).title}` : "None"}
Total phases: ${(devPhases.data ?? []).length} | Complete: ${(devPhases.data ?? []).filter((p: Record<string, unknown>) => p.status === "complete").length} | In Progress: ${(devPhases.data ?? []).filter((p: Record<string, unknown>) => p.status === "in_progress").length} | Planned: ${(devPhases.data ?? []).filter((p: Record<string, unknown>) => p.status === "planned").length} | Backlog: ${(devPhases.data ?? []).filter((p: Record<string, unknown>) => p.status === "backlog").length}

## All Development Phases
${phaseContext}

## Feature Registry
Total: ${featureStats.total} | Live: ${featureStats.live} | In Dev: ${featureStats.in_dev} | Not Tested: ${featureStats.not_tested} | Compliance Critical: ${featureStats.compliance_critical} | Missing Docs: ${featureStats.docs_missing}

${fData.slice(0, 60).map((f: Record<string, unknown>) => `- ${f.feature_id}: ${f.name} (${f.category}) lifecycle:${f.lifecycle_stage} testing:${f.testing_status} docs:${f.documentation_status}${f.compliance_critical ? " COMPLIANCE-CRITICAL" : ""}`).join("\n")}

## Goals & Epics
${(goals.data ?? []).map((g: Record<string, unknown>) => `- ${g.title} [${g.status}] ${g.progress_pct}%`).join("\n") || "None"}

${(epics.data ?? []).map((e: Record<string, unknown>) => `- ${e.title} [${e.status}] ${e.progress_pct}%`).join("\n") || ""}

## Roadmap
${(roadmap.data ?? []).map((r: Record<string, unknown>) => `- ${r.title} [${r.status}] priority:${r.priority}`).join("\n") || "None"}

## Milestones
${(milestones.data ?? []).map((m: Record<string, unknown>) => `- ${m.name} [${m.status}]${m.target_date ? ` due:${m.target_date}` : ""}`).join("\n") || "None"}

## Backlog (top items)
${(backlog.data ?? []).slice(0, 15).map((b: Record<string, unknown>) => `- [${b.item_type}] ${b.title} priority:${b.priority} status:${b.status}`).join("\n") || "None"}

## Documentation
${(docs.data ?? []).map((d: Record<string, unknown>) => `- ${d.title} (${d.doc_type}) v${d.version} [${d.status}]`).join("\n") || "None"}

## Architecture Decisions
${(decisions.data ?? []).map((d: Record<string, unknown>) => `- ${d.title} [${d.status}] (${d.decision_date})`).join("\n") || "None"}

## Engineering Standards
${(standards.data ?? []).map((s: Record<string, unknown>) => `- ${s.title} (${s.category}) [${s.status}]`).join("\n") || "None"}

## AI Usage (last 50 requests)
Total requests: ${usageStats.length} | Cache hits: ${cacheHits} | Est. total cost: $${totalCost.toFixed(4)}

${eigContext}
`.trim();
}

// ── Engineering Review Context ────────────────────────────────────────────────

async function buildELPMContext(
  svc: ReturnType<typeof createClient>,
  reviewId: string,
): Promise<string> {
  // Load the 10 most recent reviews for historical search
  const { data: allReviews } = await svc
    .from("ecc_engineering_reviews")
    .select("erc_number,title,type,status,engineering_area,engineering_decision,lessons_learned,future_recommendations,is_reference,related_features,related_releases,related_ercs")
    .order("created_at", { ascending: false })
    .limit(20);

  // Load engineering memory
  const { data: memory } = await svc
    .from("ecc_engineering_memory")
    .select("memory_type,title,content,weight,source_ref,is_superseded")
    .eq("is_superseded", false)
    .order("weight", { ascending: false })
    .limit(20);

  const { data: currentReview } = await svc
    .from("ecc_engineering_reviews")
    .select("erc_number,type,engineering_area,related_features,related_releases,related_ercs,elpm_generated_at,elpm_historical_confidence")
    .eq("id", reviewId)
    .maybeSingle();

  if (!allReviews?.length && !memory?.length) return "";

  const others = (allReviews ?? []).filter((r: Record<string, unknown>) => r.erc_number !== currentReview?.erc_number);

  const similar = others.filter((r: Record<string, unknown>) => {
    const sameType = r.type === currentReview?.type;
    const sameArea = currentReview?.engineering_area && r.engineering_area === currentReview.engineering_area;
    return sameType || sameArea;
  }).slice(0, 5);

  const memoryLines = (memory ?? []).map((m: Record<string, unknown>) =>
    `  [${"★".repeat(m.weight as number)}] ${m.memory_type}: ${m.title} — ${(m.content as string).slice(0, 80)}`
  ).join("\n");

  const similarLines = similar.map((r: Record<string, unknown>) => [
    `  ${r.erc_number}: ${r.title} [${r.status}]${r.is_reference ? " ★REFERENCE" : ""}`,
    r.engineering_decision ? `    Decision: ${(r.engineering_decision as string).slice(0, 100)}` : "",
    r.lessons_learned ? `    Lessons: ${(r.lessons_learned as string).slice(0, 80)}` : "",
  ].filter(Boolean).join("\n")).join("\n\n");

  const historicalConf = currentReview?.elpm_historical_confidence;

  return `## Engineering Learning, Precedent & Memory (ELPM)
Historical Confidence: ${historicalConf != null ? Math.round((historicalConf as number) * 100) + "%" : "Not yet computed"}
Similar Reviews Found: ${similar.length}

### Engineering Memory (Active Standing Decisions)
${memoryLines || "No engineering memory entries found."}

### Similar Historical Reviews
${similarLines || "No similar historical reviews found."}

**AI Instruction**: Before generating your engineering review analysis, honour all active Engineering Memory entries (especially 5-star entries). Where similar historical reviews exist, build upon their decisions rather than starting fresh. Explicitly reference which historical decisions you are applying and why.`;
}

async function buildConversationIntelligenceContext(
  svc: ReturnType<typeof createClient>,
  reviewType: string,
  engineeringArea: string | null,
): Promise<string> {
  const { data } = await svc
    .from("ecc_conversation_intelligence")
    .select("conversation_title,conversation_type,engineering_area,summary,extracted_decisions,extracted_lessons,extracted_recommendations,extracted_po_feedback,related_ercs,confidence_score,lineage_status")
    .neq("lineage_status", "archived")
    .order("indexed_at", { ascending: false })
    .limit(20);

  if (!data?.length) return "";

  const items = data as Array<Record<string, unknown>>;

  // Filter for relevance
  const relevant = items.filter(ci => {
    const sameType = (ci.conversation_type as string).includes(reviewType.replace(/_/g, " "));
    const sameArea = engineeringArea && (ci.engineering_area as string | null)?.toLowerCase() === engineeringArea.toLowerCase();
    const hasDecisions = (ci.extracted_decisions as unknown[]).length > 0;
    return sameType || sameArea || hasDecisions;
  }).slice(0, 8);

  if (relevant.length === 0) return "";

  const lines = relevant.map(ci => {
    const decisions = (ci.extracted_decisions as Array<{ decision: string }>)
      .slice(0, 2)
      .map(d => `    Decision: ${d.decision.slice(0, 120)}`);
    const lessons = (ci.extracted_lessons as Array<{ lesson: string }>)
      .slice(0, 2)
      .map(l => `    Lesson: ${l.lesson.slice(0, 120)}`);
    const poFeedback = (ci.extracted_po_feedback as Array<{ feedback: string; direction: string }>)
      .slice(0, 1)
      .map(f => `    PO Feedback (${f.direction}): ${f.feedback.slice(0, 100)}`);

    return [
      `  [${(ci.conversation_type as string).replace(/_/g, " ").toUpperCase()}] ${ci.conversation_title as string} (conf: ${Math.round((ci.confidence_score as number) * 100)}%)`,
      ...decisions,
      ...lessons,
      ...poFeedback,
    ].filter(Boolean).join("\n");
  }).join("\n\n");

  return `## Conversation Intelligence (ELPM Phase 17.3)
Related ATD conversations indexed: ${relevant.length}

${lines}

**AI Instruction**: Apply decisions and lessons extracted from these historical ATD conversations. If a PO decision is present, honour it. Reference conversation intelligence when it directly applies to the current engineering review.`;
}

async function buildPlatformArchitectureContext(
  svc: ReturnType<typeof createClient>,
): Promise<string> {
  const { data: modules } = await svc
    .from("ecc_module_registry")
    .select("name,slug,module_type,layer,status,version,reusable,description,architecture_notes,dependencies")
    .eq("status", "active")
    .order("layer", { ascending: true });

  if (!modules?.length) return "";

  const byType: Record<string, string[]> = { core_platform: [], domain_module: [], infrastructure: [] };
  for (const m of modules as Array<Record<string, unknown>>) {
    const t = m.module_type as string;
    if (byType[t]) {
      byType[t].push(`${m.name as string} [v${m.version as string}${m.reusable ? ", reusable" : ""}]`);
    }
  }

  const archNotes = (modules as Array<Record<string, unknown>>)
    .filter(m => m.architecture_notes)
    .slice(0, 5)
    .map(m => `  ${m.name as string}: ${(m.architecture_notes as string).slice(0, 120)}`)
    .join("\n");

  return `## ATD Platform Architecture (TP-018)
Layer 1 — Core Platform (${byType.core_platform.length} modules): ${byType.core_platform.join(", ")}
Layer 2 — Domain Modules (${byType.domain_module.length} modules): ${byType.domain_module.join(", ")}
Layer 3 — Infrastructure (${byType.infrastructure.length} modules): ${byType.infrastructure.join(", ")}

Key Architecture Notes:
${archNotes || "  No specific notes."}

**AI Instruction**: When generating engineering recommendations, classify every capability as Core Platform / Domain Module / Infrastructure. Ensure recommendations preserve the three-layer architectural boundary. Core Platform modules must be designed to be reusable across future products. Domain-specific logic must NOT be embedded in Core Platform modules.`;
}

function buildFrozenIntelligenceContext(eine_serialized: string): string {
  return eine_serialized;
}

async function buildEngineeringReviewContext(
  svc: ReturnType<typeof createClient>,
  reviewId?: string,
): Promise<{ reviewContext: string; review: Record<string, unknown> | null }> {
  if (!reviewId) return { reviewContext: "", review: null };

  const { data: review } = await svc
    .from("ecc_engineering_reviews")
    .select("*")
    .eq("id", reviewId)
    .maybeSingle();

  if (!review) return { reviewContext: "", review: null };

  const reviewContext = `## Engineering Review Under Analysis
ERC Number: ${review.erc_number}
Title: ${review.title}
Type: ${review.type}
Status: ${review.status}
Engineering Area: ${review.engineering_area ?? "Not specified"}
Author: ${review.author ?? "Not specified"}
Review Date: ${review.review_date ?? "Not specified"}

Executive Summary: ${review.executive_summary ?? "Not provided"}
Problem Statement: ${review.problem_statement ?? "Not provided"}
Engineering Analysis: ${review.engineering_analysis ?? "Not provided"}
Root Cause: ${review.root_cause ?? "Not provided"}
Engineering Decision: ${review.engineering_decision ?? "Not provided"}
Changes Implemented: ${review.changes_implemented ?? "Not provided"}
Validation Performed: ${review.validation_performed ?? "Not provided"}
Lessons Learned: ${review.lessons_learned ?? "Not provided"}
Future Recommendations: ${review.future_recommendations ?? "Not provided"}

Related Audits: ${(review.related_audits as string[] ?? []).join(", ") || "None"}
Related Features: ${(review.related_features as string[] ?? []).join(", ") || "None"}
Related Releases: ${(review.related_releases as string[] ?? []).join(", ") || "None"}
Related Test Plans: ${(review.related_test_plans as string[] ?? []).join(", ") || "None"}
Related Dev Phases: ${(review.related_phases as string[] ?? []).join(", ") || "None"}
Files Modified: ${(review.files_modified as string[] ?? []).length} file(s)`;

  return { reviewContext, review };
}

// ── Block parser ───────────────────────────────────────────────────────────────

function parseBlock(raw: string, start: string, end: string): { json: Record<string, unknown> | null; cleaned: string } {
  const si = raw.lastIndexOf(start);
  if (si === -1) return { json: null, cleaned: raw };
  const ei = raw.lastIndexOf(end);
  const str = raw.slice(si + start.length, ei > si ? ei : undefined).trim();
  const cleaned = raw.slice(0, si).trim();
  try { return { json: JSON.parse(str), cleaned }; } catch { return { json: null, cleaned: raw }; }
}

// ── TD System Prompt ───────────────────────────────────────────────────────────

function buildTDPrompt(context: string, mode: string, phaseContext?: string, reviewContext?: string): string {
  const modeInstr: Record<string, string> = {
    assess: `Mode: READINESS ASSESSMENT
You are assessing whether the current in-progress phase is complete and the platform is ready to advance.

Systematically check each acceptance criterion for the current phase. For each criterion determine: PASS, FAIL, or PARTIAL.

Check cross-cutting concerns:
- Testing complete? (no "not_tested" features in this phase)
- Documentation complete? (no "missing" docs for this phase)
- Architecture updated?
- Feature catalogue updated?
- Roadmap/milestones reflect completion?
- Security acceptable?
- Technical debt introduced?
- Regression risk?

End your response with EXACTLY this JSON block:
%%TD_ASSESSMENT%%
{
  "phase_number": <number>,
  "phase_title": "<title>",
  "overall_ready": <true|false>,
  "confidence": <0-100>,
  "criteria_results": [{"criterion": "<text>", "status": "pass|fail|partial", "note": "<brief>"}],
  "checklist": {
    "implementation_complete": <true|false>,
    "testing_complete": <true|false>,
    "documentation_complete": <true|false>,
    "architecture_updated": <true|false>,
    "feature_catalogue_updated": <true|false>,
    "roadmap_updated": <true|false>,
    "security_acceptable": <true|false>,
    "no_outstanding_bugs": <true|false>,
    "regression_risk_acceptable": <true|false>,
    "technical_debt_acceptable": <true|false>
  },
  "remaining_work": ["<item if not ready>"],
  "summary": "<2-3 sentence plain-English summary>",
  "recommendation": "<what to do next>"
}
%%END_TD_ASSESSMENT%%`,

    recommend: `Mode: NEXT PHASE RECOMMENDATION
You are recommending the next phase to build.

Review the development programme. Identify the highest-priority next phase considering:
- Dependencies (what must come first)
- Business impact
- Technical risk
- Compliance requirements
- Current platform maturity
- Outstanding technical debt

End your response with EXACTLY this JSON block:
%%TD_RECOMMENDATION%%
{
  "recommended_phase_number": <number>,
  "recommended_phase_title": "<title>",
  "confidence": <0-100>,
  "reasoning": "<clear reasoning paragraph>",
  "estimated_effort": "<human readable>",
  "estimated_risk": "low|medium|high|critical",
  "dependencies_satisfied": <true|false>,
  "business_impact": "<paragraph>",
  "technical_impact": "<paragraph>",
  "priority_rationale": "<why this over others>",
  "prerequisites": ["<list any unmet prerequisites>"],
  "alternative_phases": [{"phase_number": <n>, "reason": "<why not first>"}]
}
%%END_TD_RECOMMENDATION%%`,

    plan: `Mode: IMPLEMENTATION PLAN GENERATION
You are generating a complete, implementation-ready engineering plan for the specified phase.

${phaseContext ? `## Target Phase\n${phaseContext}\n` : ""}

Your plan must be comprehensive enough that a developer can implement it without any additional research.

Structure your response as:

1. **Executive Summary** — what this phase delivers and why it matters
2. **Architecture** — what changes to architecture/DB/functions/components
3. **Database Migrations** — exact tables, columns, RLS policies needed
4. **Edge Functions** — which to create or modify and what they do
5. **Frontend Components** — which pages/components to create or modify
6. **Testing Plan** — what to test and how
7. **Rollback Plan** — how to safely revert if needed
8. **Documentation Updates** — what docs to create or update

Then generate a COMPLETE, DETAILED IMPLEMENTATION PROMPT that the developer can paste directly. The implementation prompt must be self-contained and specify every change needed.

End with EXACTLY this JSON block:
%%TD_PLAN%%
{
  "phase_number": <number>,
  "phase_title": "<title>",
  "estimated_build_time": "<human readable>",
  "estimated_risk": "low|medium|high|critical",
  "confidence": <0-100>,
  "db_migrations": ["<table: description>"],
  "edge_functions": ["<function: purpose>"],
  "frontend_pages": ["<page: what changes>"],
  "frontend_components": ["<component: what changes>"],
  "test_cases": ["<test case description>"],
  "rollback_steps": ["<step>"],
  "documentation_updates": ["<doc: what to add>"],
  "implementation_prompt": "<COMPLETE, SELF-CONTAINED IMPLEMENTATION PROMPT — include all implementation details, acceptance criteria, design requirements, technical constraints — minimum 500 words>"
}
%%END_TD_PLAN%%`,

    engineering_review: `Mode: ENGINEERING REVIEW INTELLIGENCE
You are generating a comprehensive Engineering Review intelligence report.

${reviewContext ? `${reviewContext}\n` : ""}

Your task: Using the Engineering Intelligence Graph, ELPM historical knowledge, conversation intelligence, platform architecture context, and the review content above, generate a deep technical analysis that enriches this Engineering Review.

This output feeds the Engineering Intelligence Narrative Engine (EINE) which renders all 23 mandatory sections of the Intelligence Report. Produce structured, evidence-driven intelligence — not marketing prose. Be specific: name actual systems, modules, risks, and entities rather than generic statements.

Generate:

1. **AI Reasoning Summary** — explicitly list which EIG entities and relationships informed your analysis, why you selected them, confidence level
2. **Risk Register** — 3–6 specific, named risks. Reference actual components, tables, modules where relevant.
3. **Implementation Plan** — ordered phases. Each item should be concrete and actionable.
4. **Release Readiness** — assess all 5 gates with specific named blockers (not generic placeholders)
5. **Executive Brief** — product owner briefing: business impact, engineering impact, risks, effort, next action

End your response with EXACTLY this JSON block:
%%TD_REVIEW_INTELLIGENCE%%
{
  "ai_narrative": "<3–5 paragraph engineering analysis — what this review means architecturally, what changed, what risks exist, what should happen next. Reference specific EIG entities and historical precedents where available.>",
  "risk_register": [
    {
      "description": "<specific named risk referencing actual system component>",
      "likelihood": "low|medium|high",
      "impact": "low|medium|high|critical",
      "severity": "low|medium|high|critical",
      "mitigation": "<concrete mitigation action>",
      "owner": "<team or role>",
      "status": "open|mitigated|accepted"
    }
  ],
  "implementation_phases": [
    {
      "phase": <number>,
      "title": "<phase title>",
      "items": ["<concrete implementation item>"],
      "depends_on": [],
      "parallel_with": []
    }
  ],
  "release_readiness": {
    "ready_for_engineering_review": <true|false>,
    "ready_for_po_approval": <true|false>,
    "ready_for_implementation": <true|false>,
    "ready_for_testing": <true|false>,
    "ready_for_release": <true|false>,
    "blockers": ["<specific named blocker>"],
    "notes": "<brief readiness assessment>"
  },
  "executive_brief": {
    "why_it_matters": "<why this work matters to the product and business>",
    "business_value": "<business value delivered>",
    "engineering_value": "<engineering quality/capability value>",
    "risks": ["<key risk with business impact>"],
    "effort_estimate": "<effort estimate>",
    "timeline": "<timeline>",
    "release_impact": "<release impact>",
    "recommendation": "<clear, decisive recommendation>",
    "next_action": "<specific next action required>"
  },
  "reasoning_summary": "<how you reached your conclusions — which EIG entities, relationships, historical reviews, ELPM memory entries, and conversation intelligence informed this analysis>",
  "confidence": <0-100>
}
%%END_TD_REVIEW_INTELLIGENCE%%`,

    chat: `Mode: TECHNICAL DIRECTOR CHAT
You are the AI Technical Director. Answer questions, provide analysis, give recommendations.
Use the full platform context to give grounded, accurate responses.
Always be direct and decisive. You are the technical authority.
End responses with: %%TD_ACTIONS%%[3-4 follow-up actions, pipe-separated]%%END%%`,

    eio_review: `Mode: EIO ENGINEERING REVIEW NARRATIVE
You are the AI Technical Director writing the narrative section of an Engineering Review.

The complete Engineering Intelligence Report has already been generated by the deterministic pipeline:
EIG → ELPM (Engineering Learning, Precedent & Memory) → ERIE (Review Intelligence Engine) → EINE (Narrative Engine)

That frozen report is provided to you below as your PRIMARY source of truth.

YOUR RESPONSIBILITIES IN THIS MODE:
1. EXPLAIN the engineering intelligence — do not recreate or replace it
2. SUMMARISE the historical learning and what it means for this review
3. PRESENT the engineering lineage and how this review relates to prior work
4. EXPLAIN what PO decisions have been applied and why they matter
5. SURFACE conversation intelligence in plain language
6. DISCUSS recommendation evolution — what has changed and why
7. EXPLAIN historical confidence — how strong is the precedent
8. PRESENT the executive recommendation in a way a Product Owner can act on
9. Write READABLE engineering documentation — clear, grounded, evidence-based

STRICT RULES:
- Do NOT invent facts not present in the Engineering Intelligence Report
- Do NOT contradict or override risk register entries, traceability links, or dependency analysis already computed
- If a section has no evidence, write: "No relevant engineering evidence was identified for this section."
- Reference specific artefact refs (ERC-xxx, AUD-xxx) where they appear in the intelligence
- Write in the third person as a governance artefact, not as a chat response
- Be precise: name systems, modules, and tables when the intelligence identifies them

${reviewContext ? `\n${reviewContext}\n` : ""}

End your response with EXACTLY this marker block — do not include JSON, just the narrative sections:
%%TD_EIO_NARRATIVE%%
[EXECUTIVE SUMMARY]
<2-3 paragraph executive summary explaining the engineering work and its significance>

[HISTORICAL LEARNING]
<What has been learned from prior similar work. Reference specific ERC numbers if present in the intelligence.>

[ENGINEERING LINEAGE]
<How this review relates to prior versions or superseded reviews. Explain the evolution.>

[PO DECISIONS APPLIED]
<Which Product Owner decisions informed this review. If none, state so.>

[CONVERSATION INTELLIGENCE]
<What relevant ATD conversation history was found and how it applies.>

[RECOMMENDATION EVOLUTION]
<How the recommendation has changed from prior reviews. First iteration if applicable.>

[HISTORICAL CONFIDENCE]
<Explain the confidence level and what it is based on.>

[ENGINEERING REASONING]
<Explain how the analysis was conducted — which entities, relationships, and historical precedents were used.>

[EXECUTIVE RECOMMENDATION]
<A clear, actionable recommendation for the Product Owner. What needs to happen next and why.>
%%END_TD_EIO_NARRATIVE%%`,
  };

  return `You are the AI Technical Director for LLND Automate — an Australian SaaS platform for RTO compliance automation.

Your role: Technical lead for the entire product. You understand every component, database table, edge function, feature, compliance requirement, and architectural decision. You think strategically and act decisively.

You are NOT an assistant waiting for instructions. You are proactively managing the engineering programme:
- You know what has been built
- You know what needs to be built next
- You know the dependencies between phases
- You know the risks
- You assess readiness objectively
- You recommend the next move

## Your Responsibilities
1. Review current platform state against the development programme
2. Assess whether phases are truly complete (not just "code was written")
3. Recommend next priorities based on business value, risk, compliance
4. Generate complete implementation plans that developers can execute immediately
5. Ensure documentation, testing, and architecture stay in sync with the codebase
6. Generate comprehensive Engineering Review intelligence reports using the Engineering Intelligence Graph

## Decision Principles
- Compliance-critical work always takes priority
- Never recommend work that has unsatisfied dependencies
- A phase is only complete when ALL acceptance criteria pass AND testing, docs, and architecture are updated
- Be honest about gaps — never overclaim readiness
- Your confidence scores must be calibrated (if you're not sure, say so and explain why)
- Engineering Reviews are governance artefacts — treat them with precision and accountability

${modeInstr[mode] ?? modeInstr.chat}

---

${context}`;
}

// ── Main handler ───────────────────────────────────────────────────────────────

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response(null, { status: 200, headers: corsHeaders });

  // Issue #45: platform operators with MFA only (trusted server-to-server calls with the service-role key also pass).
  {
    const operatorCheck = await requirePlatformOperator(req.headers.get("Authorization"), { allowServiceRole: true });
    if (!operatorCheck.ok) return operatorDeniedResponse(operatorCheck, corsHeaders);
  }

  try {
    const auth = await verifyAdmin(req);
    if (!auth) return json({ error: "Unauthorized" }, 401);
    const { svc, userId } = auth;

    const body = await req.json() as {
      mode: "assess" | "recommend" | "plan" | "chat" | "engineering_review" | "eio_review";
      phase_number?: number;
      review_id?: string;
      message?: string;
      messages?: Array<{ role: string; content: string }>;
      eine_serialized?: string;
    };

    const { mode = "chat", phase_number, review_id, message, messages = [], eine_serialized } = body;

    const aiCfg = await loadAIConfig(svc);
    if (!aiCfg) {
      return json({ error: "NO_API_KEY", message: "AI provider not configured. Go to Settings → AI Provider." }, 422);
    }

    const context = await buildFullContext(svc);

    // For `plan` mode, load the specific phase for extra context
    let phaseContext: string | undefined;
    if (mode === "plan" && phase_number) {
      const { data: phase } = await svc
        .from("ecc_dev_phases")
        .select("*")
        .eq("phase_number", phase_number)
        .maybeSingle();
      if (phase) {
        phaseContext = `Phase ${phase.phase_number}: ${phase.title}
Description: ${phase.description ?? ""}
Objectives: ${Array.isArray(phase.objectives) ? (phase.objectives as string[]).join("\n- ") : ""}
Acceptance Criteria: ${Array.isArray(phase.acceptance_criteria) ? (phase.acceptance_criteria as string[]).join("\n- ") : ""}
Dependencies: ${JSON.stringify(phase.dependencies)}
Related Features: ${(phase.related_features ?? []).join(", ")}
Related DB Objects: ${(phase.related_db_objects ?? []).join(", ")}
Notes: ${phase.notes ?? ""}`;
      }
    }

    // For `engineering_review` mode, load the review + ELPM context + conversation intelligence
    let reviewContext: string | undefined;
    let reviewRecord: Record<string, unknown> | null = null;
    if (mode === "engineering_review" && review_id) {
      const result = await buildEngineeringReviewContext(svc, review_id);
      reviewContext = result.reviewContext;
      reviewRecord = result.review;
      // Append ELPM context so AI honours historical knowledge
      const elpmCtx = await buildELPMContext(svc, review_id);
      if (elpmCtx) reviewContext = (reviewContext ?? "") + "\n\n" + elpmCtx;
      // Append conversation intelligence context
      const ciCtx = await buildConversationIntelligenceContext(
        svc,
        reviewRecord?.type as string ?? "",
        reviewRecord?.engineering_area as string | null ?? null,
      );
      if (ciCtx) reviewContext = (reviewContext ?? "") + "\n\n" + ciCtx;
      // Append platform architecture context (TP-018)
      const archCtx = await buildPlatformArchitectureContext(svc);
      if (archCtx) reviewContext = (reviewContext ?? "") + "\n\n" + archCtx;
    }

    // For `eio_review` mode (Phase 18), load review context then append the frozen EINE report
    if (mode === "eio_review" && review_id) {
      console.log("[EIO] eio_review mode — assembling frozen intelligence context", { review_id });
      const result = await buildEngineeringReviewContext(svc, review_id);
      reviewRecord = result.review;
      reviewContext = result.reviewContext;
      if (eine_serialized) {
        const frozenCtx = buildFrozenIntelligenceContext(eine_serialized);
        reviewContext = (reviewContext ?? "") + "\n\n" + frozenCtx;
        console.log("[EIO] Frozen intelligence context appended", { chars: frozenCtx.length });
      } else {
        // Fallback: load from DB if client didn't send serialized EINE
        const elpmCtx = await buildELPMContext(svc, review_id);
        if (elpmCtx) reviewContext = (reviewContext ?? "") + "\n\n" + elpmCtx;
        const ciCtx = await buildConversationIntelligenceContext(
          svc,
          reviewRecord?.type as string ?? "",
          reviewRecord?.engineering_area as string | null ?? null,
        );
        if (ciCtx) reviewContext = (reviewContext ?? "") + "\n\n" + ciCtx;
        console.log("[EIO] No EINE serialized — using DB fallback context");
      }
    }

    const systemPrompt = buildTDPrompt(context, mode, phaseContext, reviewContext);

    // Build user message
    let userMessage = message ?? "";
    if (!userMessage) {
      switch (mode) {
        case "assess":            userMessage = `Perform a readiness assessment for the current in-progress phase${phase_number ? ` (Phase ${phase_number})` : ""}.`; break;
        case "recommend":         userMessage = "Recommend the next development phase to execute."; break;
        case "plan":              userMessage = `Generate a complete implementation plan for Phase ${phase_number}.`; break;
        case "engineering_review":userMessage = `Generate comprehensive Engineering Review intelligence for ${reviewRecord ? `${reviewRecord.erc_number}: ${reviewRecord.title}` : "the specified review"}. Analyse using the Engineering Intelligence Graph and provide deep technical reasoning, risk register, implementation plan, release readiness assessment, and executive brief.`; break;
        case "eio_review":        userMessage = `Write the Engineering Review narrative for ${reviewRecord ? `${reviewRecord.erc_number}: ${reviewRecord.title}` : "the specified review"} based entirely on the frozen Engineering Intelligence Report provided. Explain the intelligence. Do not recreate it.`; break;
        default:                  userMessage = "What is the current state of the platform?"; break;
      }
    }

    const effectiveMessages = [
      ...messages.map((m) => ({ role: m.role as "user" | "assistant", content: m.content })),
      { role: "user" as const, content: userMessage },
    ];

    const aiResponse = await generate(svc, {
      feature: `technical-director:${mode}`,
      systemPrompt,
      messages: effectiveMessages,
      userId,
      maxTokens: mode === "plan" || mode === "engineering_review" || mode === "eio_review" ? 8192 : 4096,
    });

    const rawReply = aiResponse.content;

    // Parse structured blocks
    let assessment: Record<string, unknown> | null = null;
    let recommendation: Record<string, unknown> | null = null;
    let plan: Record<string, unknown> | null = null;
    let reviewIntelligence: Record<string, unknown> | null = null;
    let eioNarrative: string | null = null;
    let displayReply = rawReply;

    if (mode === "assess") {
      const { json: parsed, cleaned } = parseBlock(rawReply, "%%TD_ASSESSMENT%%", "%%END_TD_ASSESSMENT%%");
      assessment = parsed;
      displayReply = cleaned;

      if (assessment?.phase_number) {
        await svc.from("ecc_dev_phases")
          .update({ readiness_assessment: assessment, reviewed_at: new Date().toISOString(), reviewed_by: userId })
          .eq("phase_number", assessment.phase_number);
      }
    }

    if (mode === "recommend") {
      const { json: parsed, cleaned } = parseBlock(rawReply, "%%TD_RECOMMENDATION%%", "%%END_TD_RECOMMENDATION%%");
      recommendation = parsed;
      displayReply = cleaned;
    }

    if (mode === "plan") {
      const { json: parsed, cleaned } = parseBlock(rawReply, "%%TD_PLAN%%", "%%END_TD_PLAN%%");
      plan = parsed;
      displayReply = cleaned;

      const implPrompt = plan?.implementation_prompt ?? plan?.bolt_prompt;
      if (implPrompt && phase_number) {
        await svc.from("ecc_dev_phases")
          .update({ bolt_prompt: implPrompt as string })
          .eq("phase_number", phase_number);
      }
    }

    if (mode === "engineering_review") {
      const { json: parsed, cleaned } = parseBlock(rawReply, "%%TD_REVIEW_INTELLIGENCE%%", "%%END_TD_REVIEW_INTELLIGENCE%%");
      reviewIntelligence = parsed;
      displayReply = cleaned;

      // Merge AI intelligence back into the review record
      if (reviewIntelligence && review_id) {
        const updates: Record<string, unknown> = {
          intelligence_generated_at: new Date().toISOString(),
          intelligence_engine_version: "1.0-ai",
        };
        if (Array.isArray(reviewIntelligence.risk_register)) {
          updates.risk_register = reviewIntelligence.risk_register;
        }
        if (reviewIntelligence.release_readiness) {
          const rr = reviewIntelligence.release_readiness as Record<string, unknown>;
          updates.release_readiness = {
            gates: [
              { gate: "Ready for Engineering Review",  ready: rr.ready_for_engineering_review,  note: "" },
              { gate: "Ready for PO Approval",         ready: rr.ready_for_po_approval,         note: "" },
              { gate: "Ready for Implementation",      ready: rr.ready_for_implementation,      note: "" },
              { gate: "Ready for Testing",             ready: rr.ready_for_testing,             note: "" },
              { gate: "Ready for Release",             ready: rr.ready_for_release,             note: rr.notes ?? "" },
            ],
            overall_ready: [rr.ready_for_engineering_review, rr.ready_for_po_approval, rr.ready_for_implementation, rr.ready_for_testing, rr.ready_for_release].every(Boolean),
            blockers:     rr.blockers ?? [],
            missing_evidence: [],
            outstanding_risks: [],
            outstanding_docs: [],
            outstanding_testing: [],
          };
        }
        if (reviewIntelligence.executive_brief) {
          updates.executive_brief = reviewIntelligence.executive_brief;
        }
        if (reviewIntelligence.ai_narrative) {
          updates.ai_reasoning = {
            sources_used: {},
            reasoning_summary: reviewIntelligence.ai_narrative,
            confidence_score: ((reviewIntelligence.confidence as number) ?? 75) / 100,
            evidence_count: 0,
          };
        }
        if (Array.isArray(reviewIntelligence.implementation_phases)) {
          updates.implementation_plan = {
            phases: reviewIntelligence.implementation_phases,
            critical_path: [],
            blocking_items: [],
            prerequisites: [],
            parallel_opportunities: [],
          };
        }
        await svc.from("ecc_engineering_reviews").update(updates).eq("id", review_id);
      }
    }

    // EIO Review mode — parse narrative and save to ai_reasoning
    if (mode === "eio_review") {
      const si = rawReply.lastIndexOf("%%TD_EIO_NARRATIVE%%");
      const ei = rawReply.lastIndexOf("%%END_TD_EIO_NARRATIVE%%");
      if (si !== -1) {
        eioNarrative = rawReply.slice(si + 20, ei > si ? ei : undefined).trim();
        displayReply = rawReply.slice(0, si).trim();
      } else {
        eioNarrative = rawReply.trim();
        displayReply = "";
      }

      if (eioNarrative && review_id) {
        console.log("[EIO] Saving narrative to review", { review_id, chars: eioNarrative.length });
        await svc.from("ecc_engineering_reviews").update({
          ai_reasoning: {
            sources_used: {
              eig_entities: 0,
              eig_relationships: 0,
              engineering_reviews: 0,
              specifications: 0,
              releases: 0,
              test_plans: 0,
              benchmarks: 0,
              risks: 0,
            },
            reasoning_summary: eioNarrative,
            eio_narrative: eioNarrative,
            eio_generated_at: new Date().toISOString(),
            eio_version: "1.0",
            confidence_score: 0.85,
            evidence_count: eine_serialized ? Math.round(eine_serialized.length / 100) : 0,
          },
          intelligence_generated_at: new Date().toISOString(),
          intelligence_engine_version: "EIO-1.0",
        }).eq("id", review_id);
        console.log("[EIO] Narrative saved successfully");
      }
    }

    // Parse chat actions
    let suggested: string[] = [];
    if (mode === "chat") {
      const si = displayReply.lastIndexOf("%%TD_ACTIONS%%");
      if (si !== -1) {
        const ei = displayReply.lastIndexOf("%%END%%");
        const raw = displayReply.slice(si + 14, ei > si ? ei : undefined).trim();
        suggested = raw.split("|").map((s) => s.trim()).filter(Boolean).slice(0, 4);
        displayReply = displayReply.slice(0, si).trim();
      }
    }

    return json({
      reply: displayReply,
      assessment,
      recommendation,
      plan,
      review_intelligence: reviewIntelligence,
      eio_narrative: eioNarrative,
      suggested,
      model: aiResponse.model,
      provider: aiResponse.provider,
    });
  } catch (err) {
    console.error("technical-director error:", err);
    const isNoKey = err instanceof Error && err.message.startsWith("NO_API_KEY");
    return json(
      { error: isNoKey ? "NO_API_KEY" : (err instanceof Error ? err.message : "Internal error") },
      isNoKey ? 422 : 500,
    );
  }
});
