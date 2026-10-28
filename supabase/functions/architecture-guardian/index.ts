import { createClient } from "jsr:@supabase/supabase-js@2";
import { operatorDeniedResponse, requirePlatformOperator } from "../_shared/platform-operator.ts";
import { generate, loadAIConfig } from "../_shared/ai-service.ts";

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

async function verifyAdmin(req: Request) {
  const token = req.headers.get("Authorization")?.replace("Bearer ", "");
  if (!token) return null;
  const anon = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_ANON_KEY")!);
  const { data: { user }, error } = await anon.auth.getUser(token);
  if (error || !user) return null;
  const svc = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);
  const { data: profile } = await svc.from("profiles").select("role").eq("id", user.id).single();
  // Issue #45: operator status (grant + MFA) is enforced by requirePlatformOperator() in the request handler; the legacy profiles.role check is retired.
  if (!profile) return null;
  return svc;
}

// ── Platform context snapshot ─────────────────────────────────────────────────

async function fetchPlatformContext(svc: ReturnType<typeof createClient>) {
  const [features, backlog, releases, phases, audits, docs, roadmap, standards, decisions, guardian] =
    await Promise.all([
      svc.from("ecc_product_features").select("feature_id,name,category,lifecycle_stage,status").limit(200),
      svc.from("ecc_backlog_items").select("title,status,priority").limit(100),
      svc.from("ecc_releases").select("version,name,status").limit(20),
      svc.from("ecc_dev_phases").select("name,status,phase_number").limit(20),
      svc.from("ecc_audits").select("audit_number,name,audit_type,status").limit(20),
      svc.from("ecc_documentation").select("title,doc_type,doc_category").limit(100),
      svc.from("ecc_roadmap_items").select("title,status,theme").limit(50),
      svc.from("ecc_engineering_standards").select("standard_number,title,category").limit(50),
      svc.from("ecc_decisions").select("title,category,status").limit(50),
      svc.from("architecture_guardian_reviews")
        .select("title,change_type,decision,layout_severity,engineering_health_score,technical_debt_score")
        .limit(50),
    ]);

  const categories = [...new Set((features.data ?? []).map((f: { category: string }) => f.category))];

  return {
    features: features.data ?? [],
    backlog: backlog.data ?? [],
    categories,
    releases: releases.data ?? [],
    phases: phases.data ?? [],
    audits: audits.data ?? [],
    docs: (docs.data ?? []).map((d: { title: string; doc_type: string }) => `${d.title} (${d.doc_type})`),
    roadmap: roadmap.data ?? [],
    standards: standards.data ?? [],
    decisions: decisions.data ?? [],
    pastReviews: guardian.data ?? [],
  };
}

// ── System prompt ─────────────────────────────────────────────────────────────

function buildSystemPrompt(ctx: Awaited<ReturnType<typeof fetchPlatformContext>>) {
  return `You are the Engineering Guardian — the permanent engineering governance system for the Engineering Command Centre platform.

Your role is to prevent architectural duplication, drift, unnecessary complexity, layout/scroll violations, security issues, performance regressions, and technical debt accumulation.

EXISTING PLATFORM CONTEXT:
Feature Categories: ${ctx.categories.join(", ")}
Features (${ctx.features.length}): ${ctx.features.slice(0, 30).map((f: { name: string; category: string; lifecycle_stage: string }) => `${f.name} [${f.category}/${f.lifecycle_stage}]`).join("; ")}
Backlog Items (${ctx.backlog.length}): ${ctx.backlog.slice(0, 20).map((b: { title: string; status: string }) => `${b.title} [${b.status}]`).join("; ")}
Active Releases: ${ctx.releases.map((r: { version: string; name?: string; status: string }) => `${r.version}${r.name ? ' - ' + r.name : ''} [${r.status}]`).join(", ")}
Dev Phases: ${ctx.phases.map((p: { phase_number: number; name: string; status: string }) => `Phase ${p.phase_number}: ${p.name} [${p.status}]`).join("; ")}
Engineering Standards: ${ctx.standards.slice(0, 10).map((s: { standard_number: string; title: string }) => `${s.standard_number}: ${s.title}`).join("; ")}
Past Reviews: ${ctx.pastReviews.map((r: { title: string; change_type: string; decision: string; engineering_health_score?: number }) => `${r.title} [${r.change_type}] → ${r.decision}${r.engineering_health_score != null ? ' (health:' + r.engineering_health_score + ')' : ''}`).join("; ")}

NAVIGATION SECTIONS IN ECC:
Mission Control, Goals & Epics, Roadmap, Ideas & Backlog, Feature Health (Product Audit),
Dev Programme, Features, Architecture, Documentation, Testing & QA, Releases,
Engineering Audits, Engineering Guardian, AI Platform,
Platform Operations (General, Integrations, Security, Environments, Feature Flags,
Automation, Monitoring, Cost Monitoring, Platform Analytics, Audit Settings,
Release Settings, System Logs)

─── ENGINEERING GOVERNANCE DECISION RULES ────────────────────────────────────

DECISION OUTCOMES:
- APPROVE_NEW: Genuinely new, no overlap with existing features, categories, navigation, tables, or workflows
- EXTEND_EXISTING: Overlaps with an existing section but adds new capability — recommend extending that section
- MERGE_WITH_EXISTING: Mostly duplicates existing content — recommend merging
- REJECT_DUPLICATE: Would create direct duplication with no added value
- NEEDS_PRODUCT_OWNER_REVIEW: High risk, affects core architecture, or you are uncertain

CONFIDENCE SCORE: 0-100.
DUPLICATE RISK: none | low | medium | high | critical

─── REVIEW CATEGORIES (MANDATORY — inspect all that apply) ──────────────────

ARCHITECTURE:
  - Duplicate functionality, components, pages, tables, or API endpoints
  - Circular dependencies or dead code
  - Excessive complexity or unused abstractions

ENGINEERING:
  - Shared component and reusable hook opportunities
  - State management consistency
  - Naming conventions and folder structure violations
  - Coding standards and technical debt introduction

LAYOUT (Mission Control pages — ALWAYS check for UI proposals):
  PATTERN A (isFullHeight pages): root must be flex flex-col h-full; header shrink-0; content flex-1 overflow-y-auto
  PATTERN B (simple scroll pages): root uses padding only; outer wrapper scrolls
  isFullHeight keys: mission-control, features, ai-platform, audits, qa-testing, architecture, documentation, product-audit, backlog, arch-guardian, pa-*
  Violation types: SCROLL_NESTED, SCROLL_HIDDEN, HEIGHT_VIEWPORT, OVERFLOW_CLIP, FLEX_UNSIZED, POSITION_OBSCURE, SCROLL_ORPHAN, PATTERN_MISMATCH, RESPONSIVE_BREAK

PERFORMANCE:
  - Large components or expensive renders
  - Duplicate API requests or excessive DB queries
  - Bundle growth concerns or missing lazy loading

SECURITY:
  - Secrets, credentials, or sensitive data exposure
  - Missing authentication or authorization
  - Supabase RLS policy gaps
  - Edge Function input validation issues

COMPLIANCE:
  - Violations of ECC engineering standards
  - Pattern deviations from approved architectural decisions
  - Release readiness concerns

─── ENGINEERING SCORES ──────────────────────────────────────────────────────

Rate each score 0–100 for the proposed change:
- complexity_score: 0 = simple, 100 = extremely complex
- maintainability_score: 100 = highly maintainable, 0 = unmaintainable
- technical_debt_score: 0 = no debt, 100 = extreme debt introduced
- mc_compliance_score: 100 = fully compliant with MC layout standard, 0 = violates standard (only relevant for UI proposals; set 100 for non-UI proposals)
- engineering_health_score: overall engineering quality 0–100 (100 = excellent)

─── AUTO-FAIL TRIGGERS ──────────────────────────────────────────────────────

Set risk_level to "critical" when:
  - Security finding with exposed credentials or broken auth
  - Content completely unreachable (scroll-locked or hidden)
  - Critical duplication that would break platform integrity

Set risk_level to "high" when:
  - Multiple architectural violations found
  - Layout issues preventing content access
  - Security gaps or missing RLS policies
  - engineering_health_score < 40

─── SSOT (SINGLE SOURCE OF TRUTH) ENFORCEMENT ──────────────────────────────

Every engineering artefact must have exactly one canonical location. Duplication of data, UI, or logic across the platform is an engineering violation.

SSOT RULES:
1. Data lives in ONE table. Any new table proposal must prove it cannot extend an existing table.
2. UI sections live in ONE location. Overlapping information across pages must be consolidated.
3. All dashboards and reports must be projections of canonical ECC data — never independently maintained.
4. State that could be derived from existing records must NOT be stored separately.

SSOT VIOLATION TRIGGERS (classify as architecture finding, severity: high or critical):
- A new table is proposed when an existing table could be extended with new columns
- A new page duplicates information already shown on another page without adding capability
- A new component is created that is functionally identical to an existing component
- Derived state is stored redundantly (e.g. computed totals stored alongside raw data)

─── REUSE BEFORE BUILD ENFORCEMENT ─────────────────────────────────────────

Before approving any new component, page, table, hook, or service — check EXHAUSTIVELY:

REUSE CHECKLIST (apply to every new artefact proposed):
1. Does an existing PAGE already serve this purpose? → recommend extending that page
2. Does an existing TABLE already store this type of data? → recommend adding columns
3. Does an existing COMPONENT already render this pattern? → recommend reusing it
4. Does an existing HOOK or utility already provide this logic? → recommend sharing it
5. Does an existing EDGE FUNCTION already call this API? → recommend extending the payload

REUSE FINDINGS: When an existing artefact can be reused, add a finding:
- severity: "high" for new tables/pages that duplicate existing ones
- severity: "medium" for new components that duplicate existing ones
- category: "architecture"
- description: "Reuse Before Build violation: [what was proposed]"
- recommended_fix: "Reuse [existing artefact] by [specific extension approach]"

If the platform already has ≥3 similar patterns, ALWAYS prefer the established pattern.

─── RECOMMENDATION GROUPS ───────────────────────────────────────────────────

Group recommendations:
  - immediate: Must fix before implementing (blocking issues)
  - recommended: Should fix in the same sprint
  - future_improvement: Nice-to-have for a future sprint

You must return ONLY valid JSON. No markdown. No explanation outside JSON.`;
}

// ── User prompt ───────────────────────────────────────────────────────────────

function buildUserPrompt(proposal: {
  title: string;
  change_type: string;
  proposed_change_summary: string;
  review_mode: string;
}) {
  return `Run a full Engineering Guardian review for the following proposal:

TITLE: ${proposal.title}
CHANGE TYPE: ${proposal.change_type}
MODE: ${proposal.review_mode}
PROPOSED CHANGE:
${proposal.proposed_change_summary}

Return a JSON object with EXACTLY these fields:
{
  "decision": "APPROVE_NEW" | "EXTEND_EXISTING" | "MERGE_WITH_EXISTING" | "REJECT_DUPLICATE" | "NEEDS_PRODUCT_OWNER_REVIEW",
  "confidence_score": 0-100,
  "confidence_reason": "brief reason",
  "duplicate_risk": "none" | "low" | "medium" | "high" | "critical",
  "recommended_sot": "single source of truth recommendation",
  "recommended_approach": "specific implementation approach",
  "recommended_nav_location": "where in navigation this should live (if applicable)",
  "data_model_impact": "impact on database tables and schema",
  "component_reuse": "existing components that can be reused",
  "performance_impact": "performance considerations",
  "risk_level": "low" | "medium" | "high" | "critical",
  "existing_related_areas": [{"area": "name", "type": "page|table|component|service", "relevance": "brief"}],
  "potential_duplicates": [{"area": "name", "type": "page|table|component|service", "overlap_description": "brief"}],
  "evidence_found": [{"evidence": "what was found", "source": "where"}],
  "manual_checks_required": ["check 1", "check 2"],
  "uncertainty_notes": "any uncertainty or caveats",

  "findings": [
    {
      "severity": "critical" | "high" | "medium" | "low",
      "category": "architecture" | "engineering" | "layout" | "performance" | "security" | "compliance",
      "description": "what the finding is",
      "root_cause": "why this is a problem",
      "recommended_fix": "specific fix",
      "estimated_effort": "small|medium|large",
      "affected_files": ["file1", "file2"],
      "confidence": 0-100
    }
  ],

  "layout_violations": [
    {
      "severity": "critical" | "high" | "medium" | "low",
      "violation_type": "SCROLL_NESTED" | "SCROLL_HIDDEN" | "HEIGHT_VIEWPORT" | "OVERFLOW_CLIP" | "FLEX_UNSIZED" | "POSITION_OBSCURE" | "SCROLL_ORPHAN" | "PATTERN_MISMATCH" | "RESPONSIVE_BREAK",
      "page": "page or component name",
      "component": "specific element or className",
      "root_cause": "why this is a violation",
      "recommended_fix": "exact fix",
      "confidence": 0-100
    }
  ],
  "layout_severity": "none" | "low" | "medium" | "high" | "critical",

  "complexity_score": 0-100,
  "maintainability_score": 0-100,
  "technical_debt_score": 0-100,
  "mc_compliance_score": 0-100,
  "engineering_health_score": 0-100,

  "immediate_recommendations": [{"title": "short title", "description": "what and why", "benefit": "expected engineering benefit"}],
  "recommended_improvements": [{"title": "short title", "description": "what and why", "benefit": "expected engineering benefit"}],
  "future_improvements": [{"title": "short title", "description": "what and why", "benefit": "expected engineering benefit"}],

  "markdown_report": "# Engineering Guardian Review\\n\\n...full 18-section report..."
}

SCORING GUIDANCE:
- Populate findings for ALL 6 categories that apply. Set to [] for categories with no issues.
- layout_violations is a subset of findings focused on Mission Control layout issues.
- layout_severity = worst severity in layout_violations (or "none" if no layout issues).
- engineering_health_score = overall quality: 90-100 excellent, 70-89 good, 50-69 fair, 30-49 poor, 0-29 critical.
- If the proposal has zero UI impact: layout_violations=[], layout_severity="none", mc_compliance_score=100.

The markdown_report must include all 18 sections:
1. Proposed Change Summary
2. Change Type & Trigger
3. Existing Related Areas Found
4. Potential Duplicate Areas
5. Duplication Risk
6. Recommended Single Source of Truth
7. Recommended Implementation Approach
8. Recommended Navigation Location
9. Data Model Impact
10. Component Reuse Opportunities
11. Performance Impact
12. Risk Level & Engineering Scores
13. Confidence Score
14. Evidence Found
15. Manual Checks Required
16. Layout & Scroll Validation
17. Findings by Category (table: Severity | Category | Description | Root Cause | Fix | Effort)
18. Recommendations (Immediate / Recommended / Future)`;
}

// ── Handler ────────────────────────────────────────────────────────────────────

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response(null, { status: 200, headers: corsHeaders });

  // Issue #45: platform operators with MFA only (trusted server-to-server calls with the service-role key also pass).
  {
    const operatorCheck = await requirePlatformOperator(req.headers.get("Authorization"), { allowServiceRole: true });
    if (!operatorCheck.ok) return operatorDeniedResponse(operatorCheck, corsHeaders);
  }

  const svc = await verifyAdmin(req);
  if (!svc) return err("Unauthorized", 401);

  const body = await req.json().catch(() => null);
  if (!body) return err("Invalid request body");

  const { title, change_type, proposed_change_summary, review_mode = "prospective", trigger_source = "manual" } = body;
  if (!title || !change_type || !proposed_change_summary) {
    return err("Missing required fields: title, change_type, proposed_change_summary");
  }

  const t0 = Date.now();

  const [ctx, aiConfig] = await Promise.all([
    fetchPlatformContext(svc),
    loadAIConfig(svc),
  ]);

  if (!aiConfig) {
    return err("No AI provider configured. Please add an AI provider in Platform Operations → AI Providers.", 400);
  }

  const systemPrompt = buildSystemPrompt(ctx);
  const userPrompt = buildUserPrompt({ title, change_type, proposed_change_summary, review_mode });

  const aiResult = await generate(svc, {
    feature: "architecture-guardian",
    messages: [{ role: "user", content: userPrompt }],
    systemPrompt,
    temperature: 0.2,
    maxTokens: 5000,
  });

  let parsed: Record<string, unknown>;
  try {
    const raw = aiResult.content.trim();
    const jsonStr = raw.startsWith("```") ? raw.replace(/^```[a-z]*\n?/, "").replace(/\n?```$/, "") : raw;
    parsed = JSON.parse(jsonStr);
  } catch {
    return err("AI returned invalid JSON. Please try again.");
  }

  const generationMs = Date.now() - t0;

  // Count findings by category
  const findingsArr = Array.isArray(parsed.findings) ? parsed.findings as Array<{ category: string; severity: string }> : [];
  const performanceIssues = findingsArr.filter(f => f.category === 'performance').length;
  const securityIssues = findingsArr.filter(f => f.category === 'security').length;
  const techDebtItems = findingsArr.filter(f => f.category === 'engineering').length;
  const duplicateComponents = findingsArr.filter(f => f.category === 'architecture').length;

  const { data: review, error: insertError } = await svc
    .from("architecture_guardian_reviews")
    .insert({
      title,
      proposed_change_summary,
      change_type,
      review_mode,
      trigger_source,
      decision: parsed.decision,
      confidence_score: parsed.confidence_score,
      confidence_reason: parsed.confidence_reason,
      duplicate_risk: parsed.duplicate_risk,
      recommended_sot: parsed.recommended_sot,
      recommended_approach: parsed.recommended_approach,
      recommended_nav_location: parsed.recommended_nav_location,
      data_model_impact: parsed.data_model_impact,
      component_reuse: parsed.component_reuse,
      performance_impact: parsed.performance_impact,
      risk_level: parsed.risk_level,
      existing_related_areas: parsed.existing_related_areas ?? [],
      potential_duplicates: parsed.potential_duplicates ?? [],
      evidence_found: parsed.evidence_found ?? [],
      manual_checks_required: parsed.manual_checks_required ?? [],
      uncertainty_notes: parsed.uncertainty_notes,
      markdown_report: parsed.markdown_report,
      layout_violations: parsed.layout_violations ?? [],
      layout_severity: parsed.layout_severity ?? "none",
      findings: findingsArr,
      complexity_score: parsed.complexity_score ?? null,
      maintainability_score: parsed.maintainability_score ?? null,
      technical_debt_score: parsed.technical_debt_score ?? null,
      mc_compliance_score: parsed.mc_compliance_score ?? null,
      engineering_health_score: parsed.engineering_health_score ?? null,
      immediate_recommendations: parsed.immediate_recommendations ?? [],
      recommended_improvements: parsed.recommended_improvements ?? [],
      future_improvements: parsed.future_improvements ?? [],
      performance_issues: performanceIssues,
      security_issues: securityIssues,
      technical_debt_items: techDebtItems,
      duplicate_components: duplicateComponents,
      approval_status: "pending",
      linked_feature_id: body.linked_feature_id ?? null,
      linked_rc_id: body.linked_rc_id ?? null,
      linked_phase_id: body.linked_phase_id ?? null,
      linked_audit_id: body.linked_audit_id ?? null,
      ai_model_used: aiResult.model,
      ai_provider: aiResult.provider,
      generation_time_ms: generationMs,
    })
    .select()
    .single();

  if (insertError) return err(`Failed to save review: ${insertError.message}`, 500);

  return ok(review);
});
