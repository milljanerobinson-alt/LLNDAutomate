import { createClient } from "jsr:@supabase/supabase-js@2";
import { operatorDeniedResponse, requirePlatformOperator } from "../_shared/platform-operator.ts";
import { generate, loadAIConfig } from "../_shared/ai-service.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, PUT, DELETE, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization, X-Client-Info, Apikey",
};

// ─── Error helpers ────────────────────────────────────────────────────────────

interface AuditError {
  error: string;
  error_code: string;
  title: string;
  message: string;
  action: string;
  action_path?: string;
}

function auditErr(e: AuditError, status = 400) {
  return new Response(JSON.stringify(e), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

function ok(data: unknown) {
  return new Response(JSON.stringify(data), {
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

// ─── Auth ─────────────────────────────────────────────────────────────────────

type VerifyResult =
  | { ok: true; svc: ReturnType<typeof createClient> }
  | { ok: false; code: "unauthenticated" | "not_admin" };

async function verifyAdmin(req: Request): Promise<VerifyResult> {
  const authHeader = req.headers.get("Authorization");
  if (!authHeader?.startsWith("Bearer ")) return { ok: false, code: "unauthenticated" };

  const token = authHeader.replace("Bearer ", "");
  const anonClient = createClient(
    Deno.env.get("SUPABASE_URL")!,
    Deno.env.get("SUPABASE_ANON_KEY")!,
  );

  const { data: { user }, error } = await anonClient.auth.getUser(token);
  if (error || !user) return { ok: false, code: "unauthenticated" };

  const svc = createClient(
    Deno.env.get("SUPABASE_URL")!,
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
  );

  const { data: profile } = await svc
    .from("profiles")
    .select("role")
    .eq("id", user.id)
    .maybeSingle();

  // Issue #45: operator status (grant + MFA) is enforced by requirePlatformOperator() in the request handler; the legacy profiles.role check is retired.
  if (!profile) return { ok: false, code: "not_admin" };
  return { ok: true, svc };
}

// ─── Pre-flight ───────────────────────────────────────────────────────────────

interface PreflightCheck { name: string; passed: boolean; message: string }
interface PreflightResult { passed: boolean; checks: PreflightCheck[]; failedCheck?: PreflightCheck }

async function runPreflightChecks(
  svc: ReturnType<typeof createClient>,
  auditTitle: string,
): Promise<PreflightResult> {
  const checks: PreflightCheck[] = [];

  checks.push({
    name: "Audit Title",
    passed: !!auditTitle.trim(),
    message: auditTitle.trim() ? "Audit title provided." : "Audit title is required.",
  });

  try {
    const { data: providers } = await svc
      .from("ai_provider_configs")
      .select("id, provider, model, is_default, is_enabled, has_api_key")
      .eq("is_enabled", true)
      .eq("has_api_key", true);

    const hasProvider = (providers ?? []).length > 0;
    const defaultProvider = (providers ?? []).find((p: { is_default: boolean }) => p.is_default);
    checks.push({
      name: "AI Provider",
      passed: hasProvider,
      message: hasProvider
        ? `AI Provider configured${defaultProvider ? ` (${defaultProvider.provider})` : ""}.`
        : "No AI Provider with an API key is configured.",
    });
  } catch {
    checks.push({ name: "AI Provider", passed: false, message: "Unable to verify AI Provider configuration." });
  }

  try {
    const cfg = await loadAIConfig(svc);
    checks.push({
      name: "AI Model",
      passed: !!cfg?.model,
      message: cfg?.model ? `Model configured: ${cfg.model}` : "No AI model has been selected.",
    });
  } catch {
    checks.push({ name: "AI Model", passed: false, message: "Unable to verify AI model configuration." });
  }

  try {
    const { error } = await svc.from("ecc_audits").select("id").limit(1);
    checks.push({
      name: "Database Tables",
      passed: !error,
      message: error ? `Database error: ${error.message}` : "Required tables are accessible.",
    });
  } catch {
    checks.push({ name: "Database Tables", passed: false, message: "Unable to verify database configuration." });
  }

  const failedCheck = checks.find(c => !c.passed);
  return { passed: !failedCheck, checks, failedCheck };
}

// ─── Safe query helper ────────────────────────────────────────────────────────

async function safeQuery<T>(
  fn: () => Promise<{ data: T[] | null; error: unknown }>,
): Promise<T[]> {
  try {
    const { data } = await fn();
    return data ?? [];
  } catch {
    return [];
  }
}

// ─── Confidence calculation ───────────────────────────────────────────────────

interface ConfidenceInputs {
  totalFeatures: number;
  testedFeatures: number;
  documentedFeatures: number;
  decisions: number;
  testPlans: number;
  aiTelemetryAvailable: boolean;
  previousAuditAvailable: boolean;
  guardianReviews: number;
  backlogItems: number;
  epics: number;
  phases: number;
  rcs: number;
}

function calculateConfidence(inputs: ConfidenceInputs): { score: number; level: "high" | "medium" | "low"; breakdown: string[]; gates: Array<{ label: string; passed: boolean; detail: string }> } {
  const breakdown: string[] = [];
  const gates: Array<{ label: string; passed: boolean; detail: string }> = [];
  let score = 20; // base

  // Feature data (up to 25 pts)
  if (inputs.totalFeatures >= 20) { score += 25; breakdown.push("Rich feature register (25)"); }
  else if (inputs.totalFeatures >= 10) { score += 15; breakdown.push("Moderate feature register (15)"); }
  else if (inputs.totalFeatures > 0) { score += 8; breakdown.push("Sparse feature register (8)"); }

  gates.push({ label: "Feature register", passed: inputs.totalFeatures > 0, detail: `${inputs.totalFeatures} features registered` });

  // Testing coverage (up to 15 pts)
  const testPct = inputs.totalFeatures > 0 ? inputs.testedFeatures / inputs.totalFeatures : 0;
  if (testPct >= 0.5) { score += 15; breakdown.push("Good testing coverage (15)"); }
  else if (testPct >= 0.2) { score += 8; breakdown.push("Partial testing coverage (8)"); }
  else if (inputs.testPlans > 0) { score += 5; breakdown.push("Test plans available (5)"); }

  gates.push({ label: "Testing coverage", passed: testPct > 0, detail: `${inputs.testedFeatures}/${inputs.totalFeatures} features tested` });

  // Documentation (up to 10 pts)
  const docPct = inputs.totalFeatures > 0 ? inputs.documentedFeatures / inputs.totalFeatures : 0;
  if (docPct >= 0.5) { score += 10; breakdown.push("Good documentation (10)"); }
  else if (docPct >= 0.2) { score += 5; breakdown.push("Partial documentation (5)"); }

  gates.push({ label: "Documentation", passed: docPct > 0, detail: `${inputs.documentedFeatures}/${inputs.totalFeatures} features documented` });

  // Engineering governance (up to 15 pts)
  if (inputs.decisions >= 5) { score += 8; breakdown.push("Engineering decisions present (8)"); }
  else if (inputs.decisions > 0) { score += 4; breakdown.push("Some decisions present (4)"); }
  if (inputs.guardianReviews > 0) { score += 4; breakdown.push("Guardian reviews available (4)"); }
  if (inputs.epics >= 3) { score += 3; breakdown.push("Epics defined (3)"); }

  gates.push({ label: "Engineering decisions", passed: inputs.decisions > 0, detail: `${inputs.decisions} decisions recorded` });
  gates.push({ label: "Guardian reviews", passed: inputs.guardianReviews > 0, detail: inputs.guardianReviews > 0 ? `${inputs.guardianReviews} reviews available` : "No reviews on record" });

  // Platform structure (up to 10 pts)
  if (inputs.phases >= 2) { score += 5; breakdown.push("Multiple phases tracked (5)"); }
  if (inputs.rcs >= 1) { score += 5; breakdown.push("Release candidates present (5)"); }

  gates.push({ label: "Release candidates", passed: inputs.rcs >= 1, detail: `${inputs.rcs} release candidates` });

  // AI telemetry (up to 10 pts)
  if (inputs.aiTelemetryAvailable) { score += 10; breakdown.push("AI platform telemetry available (10)"); }

  gates.push({ label: "AI telemetry", passed: inputs.aiTelemetryAvailable, detail: inputs.aiTelemetryAvailable ? "AI provider configured" : "No AI provider configured" });

  // Previous audit (up to 15 pts — dramatically improves regression analysis)
  if (inputs.previousAuditAvailable) { score += 15; breakdown.push("Previous audit available for comparison (15)"); }

  gates.push({ label: "Historical comparison", passed: inputs.previousAuditAvailable, detail: inputs.previousAuditAvailable ? "Previous audit available" : "Baseline audit — no comparison" });

  score = Math.min(100, score);
  const level: "high" | "medium" | "low" = score >= 70 ? "high" : score >= 45 ? "medium" : "low";

  return { score, level, breakdown, gates };
}

// ─── Platform Maturity Model ──────────────────────────────────────────────────

interface MaturityGates {
  hasFeatureRegister: boolean;
  hasTestCoverage: boolean;
  hasDocumentation: boolean;
  hasReleaseCandidates: boolean;
  hasComplianceReview: boolean;
  testingAbove50pct: boolean;
  documentationAbove50pct: boolean;
  testingAbove80pct: boolean;
  documentationAbove80pct: boolean;
  hasGuardianReview: boolean;
  hasApprovedAudit: boolean;
}

function deriveMaturityLevel(gates: MaturityGates): { level: string; label: string; next: string; reasoning: string } {
  const {
    hasFeatureRegister, hasTestCoverage, hasDocumentation, hasReleaseCandidates,
    hasComplianceReview, testingAbove50pct, documentationAbove50pct,
    testingAbove80pct, documentationAbove80pct, hasGuardianReview, hasApprovedAudit,
  } = gates;

  if (testingAbove80pct && documentationAbove80pct && hasComplianceReview && hasApprovedAudit) {
    return { level: "commercially_mature", label: "Commercially Mature", next: "Commercial launch ready", reasoning: "All engineering gates satisfied. Testing 80%+, documentation 80%+, compliance reviewed, audit approved." };
  }
  if (testingAbove80pct && documentationAbove50pct && hasComplianceReview && hasGuardianReview) {
    return { level: "production_ready", label: "Production Ready", next: "Approved audit + 80% documentation required", reasoning: "Testing coverage 80%+ and compliance review complete. Documentation and audit approval needed for commercial maturity." };
  }
  if (testingAbove50pct && documentationAbove50pct && hasGuardianReview) {
    return { level: "pilot_ready", label: "Pilot Ready", next: "80% test coverage + compliance review required for Production Ready", reasoning: "Testing and documentation 50%+ with guardian review. Needs higher coverage and compliance review." };
  }
  if (testingAbove50pct && hasReleaseCandidates) {
    return { level: "internal_beta", label: "Internal Beta", next: "50% documentation + guardian review required for Pilot Ready", reasoning: "Testing 50%+ and release candidates present. Documentation and guardian review needed." };
  }
  if (hasTestCoverage && hasFeatureRegister && hasReleaseCandidates) {
    return { level: "engineering", label: "Engineering", next: "50% test coverage required for Internal Beta", reasoning: "Engineering foundation established with feature register and release candidates. Testing coverage must reach 50%." };
  }
  if (hasFeatureRegister && hasDocumentation) {
    return { level: "foundation", label: "Foundation", next: "Release candidates + testing required for Engineering", reasoning: "Feature register and documentation present. Release candidates and active testing needed." };
  }
  return { level: "prototype", label: "Prototype", next: "Feature register + documentation required for Foundation", reasoning: "Early stage — feature register and documentation not yet established." };
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

  const requestStart = Date.now();
  const logCtx: Record<string, unknown> = { timestamp: new Date().toISOString() };

  try {
    // Auth
    const authResult = await verifyAdmin(req);
    if (!authResult.ok) {
      if (authResult.code === "unauthenticated") {
        return auditErr({ error: "Unauthenticated", error_code: "unauthenticated", title: "Authentication Required", message: "You must be signed in to generate a Platform Audit.", action: "Please sign in with your account and try again." }, 401);
      }
      return auditErr({ error: "Unauthorized", error_code: "not_admin", title: "Administrator Access Required", message: "Only administrators can generate Platform Audits.", action: "Please sign in with an administrator account." }, 403);
    }

    const { svc } = authResult;

    const body = await req.json().catch(() => ({}));
    const {
      mode = "manual",
      title: titleInput,
      audit_name,
      notes,
      phase_name,
      audit_id,
      audit_type: requestedAuditType,
      is_draft = false,
    } = body as {
      mode?: string;
      title?: string;
      audit_name?: string;
      notes?: string;
      phase_name?: string;
      audit_id?: string;
      audit_type?: string;
      is_draft?: boolean;
    };

    const auditTitle = titleInput || audit_name || "";
    const auditDomain = requestedAuditType || "ai_platform";

    logCtx.mode     = mode;
    logCtx.title    = auditTitle;
    logCtx.audit_id = audit_id;

    // Pre-flight
    const preflight = await runPreflightChecks(svc, auditTitle);
    logCtx.preflight = preflight;

    if (!preflight.passed) {
      const failed = preflight.failedCheck!;
      if (failed.name === "Audit Title") {
        return auditErr({ error: "Missing audit title", error_code: "missing_title", title: "Audit Title Required", message: "Please provide a title for this audit before generating.", action: "Enter a title in the Audit Title field." }, 422);
      }
      if (failed.name === "AI Provider" || failed.name === "AI Model") {
        return auditErr({ error: "AI Provider not configured", error_code: "ai_not_configured", title: "AI Provider Not Configured", message: `No AI Provider has been configured. ${failed.message}`, action: "Configure an AI Provider in: Engineering Command Centre → Platform Administration → AI Providers", action_path: "pa-ai-providers" }, 422);
      }
      return auditErr({ error: "Pre-flight check failed", error_code: "preflight_failed", title: "Configuration Error", message: failed.message, action: "Review Platform Administration settings.", action_path: "pa-general" }, 422);
    }

    const startTime = Date.now();

    // ── Phase 1: Comprehensive parallel evidence gathering ────────────────────

    const [
      featuresRes,
      rcsRes,
      phasesRes,
      goalsRes,
      epicsRes,
      milestonesRes,
      backlogRes,
      decisionsRes,
      reviewHistoryRes,
      docsRes,
      testPlansRes,
      guardianRes,
      changeLogRes,
      aiProvidersRes,
      aiModelsRes,
      inboxRes,
      existingAuditsRes,
      referenceAuditRes,
    ] = await Promise.all([
      svc.from("ecc_product_features").select("id,feature_id,name,category,lifecycle_stage,testing_status,documentation_status,product_review_status,priority,compliance_critical,production_ready,created_at").order("created_at"),
      svc.from("ecc_release_candidates").select("id,rc_number,phase_name,status,is_active,release_type,archived_at").order("rc_number"),
      svc.from("ecc_dev_phases").select("id,title,phase_number,status,eos_grade").order("phase_number"),
      svc.from("ecc_goals").select("id,title,status,description").order("created_at"),
      svc.from("ecc_epics").select("id,title,status,priority,created_at").order("created_at"),
      svc.from("ecc_milestones").select("id,name,status,target_date").order("sort_order"),
      svc.from("ecc_backlog_items").select("id,title,status,priority,category,is_blocked,estimated_effort").order("priority"),
      svc.from("ecc_decisions").select("id,decision_ref,title,status,category,decision_type,created_at").order("created_at", { ascending: false }).limit(30),
      svc.from("ecc_feature_review_history").select("action,actor,created_at,from_lifecycle,to_lifecycle").order("created_at", { ascending: false }).limit(30),
      svc.from("ecc_feature_documentation").select("id,feature_id,doc_type,title,status,generated_by_ai,created_at").order("created_at", { ascending: false }).limit(100),
      safeQuery(() => svc.from("ecc_test_plans").select("id,plan_number,title,status,coverage_percent,total_cases,cases_passed,cases_failed,created_at").order("created_at", { ascending: false }).limit(10)),
      safeQuery(() => svc.from("ecc_guardian_reviews").select("id,review_ref,title,status,overall_score,critical_violations,created_at").order("created_at", { ascending: false }).limit(5)),
      safeQuery(() => svc.from("ecc_change_log").select("id,title,change_type,impact,status,created_at").order("created_at", { ascending: false }).limit(20)),
      svc.from("ai_provider_configs").select("id,provider,model,is_default,is_enabled,has_api_key").eq("is_enabled", true).eq("has_api_key", true),
      safeQuery(() => svc.from("ai_provider_models").select("provider,model_id,display_name,context_window,is_selected").eq("is_selected", true).limit(5)),
      safeQuery(() => svc.from("ecc_ai_inbox").select("id,type,priority,title,status,created_at").eq("status", "pending").order("created_at", { ascending: false }).limit(20)),
      svc.from("ecc_audits").select("id,audit_number,audit_type,name,overall_health_score,confidence_level,status,created_at,executive_summary,is_draft,is_reference,workspace").order("created_at", { ascending: false }).limit(20),
      // Fetch the active Reference Audit for this domain
      svc.from("ecc_audits").select("id,audit_number,audit_type,name,overall_health_score,confidence_level,status,created_at,executive_summary,is_draft,is_reference,workspace").eq("audit_type", auditDomain).eq("is_reference", true).eq("workspace", "production").maybeSingle(),
    ]);

    const features       = featuresRes.data ?? [];
    const rcs            = rcsRes.data ?? [];
    const phases         = phasesRes.data ?? [];
    const goals          = goalsRes.data ?? [];
    const epics          = epicsRes.data ?? [];
    const milestones     = milestonesRes.data ?? [];
    const backlog        = backlogRes.data ?? [];
    const decisions      = decisionsRes.data ?? [];
    const reviewHistory  = reviewHistoryRes.data ?? [];
    const docs           = docsRes.data ?? [];
    const testPlans      = testPlansRes as Record<string, unknown>[];
    const guardian       = guardianRes as Record<string, unknown>[];
    const changeLog      = changeLogRes as Record<string, unknown>[];
    const aiProviders    = aiProvidersRes.data ?? [];
    const aiModels       = aiModelsRes as Record<string, unknown>[];
    const inbox          = inboxRes as Record<string, unknown>[];
    const existingAudits = existingAuditsRes.data ?? [];
    const domainReferenceAudit = referenceAuditRes.data ?? null;

    // ── Phase 2: Select comparison audit ─────────────────────────────────────
    //
    // Priority order:
    //   1. Active Reference Audit for this domain (is_reference = true, workspace = production)
    //   2. Latest production audit in same domain (workspace = production, not current)
    //   3. No comparison (baseline audit)
    //
    // Legacy and Sandbox audits are NEVER used for comparison.

    const comparisonAudit: Record<string, unknown> | null =
      // 1. Reference audit — must be production workspace
      (domainReferenceAudit && domainReferenceAudit.id !== audit_id && (domainReferenceAudit as Record<string, unknown>).workspace === "production")
        ? domainReferenceAudit
        // 2. Latest production audit in same domain
        : (existingAudits.find((a: Record<string, unknown>) =>
            a.id !== audit_id &&
            a.audit_type === auditDomain &&
            a.workspace === "production"
          ) ?? null);

    // For backwards compat — keep `previousAudit` alias
    const previousAudit = comparisonAudit;

    let previousScores: Record<string, number> = {};
    let previousFindings: Record<string, unknown>[] = [];

    if (previousAudit) {
      const [prevScoresRes, prevFindingsRes] = await Promise.all([
        svc.from("ecc_audit_scores").select("category,score").eq("audit_id", previousAudit.id),
        svc.from("ecc_audit_findings").select("severity,category,title,current_status,description").eq("audit_id", previousAudit.id),
      ]);
      (prevScoresRes.data ?? []).forEach((s: { category: string; score: number }) => {
        previousScores[s.category] = s.score;
      });
      previousFindings = prevFindingsRes.data ?? [];
    }

    // ── Phase 3: Compute metrics ──────────────────────────────────────────────

    const totalFeatures      = features.length;
    const testedFeatures     = features.filter(f => f.testing_status === "passed").length;
    const documentedFeatures = features.filter(f => f.documentation_status === "documented").length;
    const poApproved         = features.filter(f => f.product_review_status === "approved").length;
    const liveFeatures       = features.filter(f => ["live", "released", "ready_for_release"].includes(f.lifecycle_stage)).length;
    const inDevFeatures      = features.filter(f => ["in_development", "ai_development"].includes(f.lifecycle_stage)).length;
    const complianceFeatures = features.filter(f => f.compliance_critical).length;
    const productionReady    = features.filter(f => f.production_ready).length;
    const awaitingReview     = features.filter(f => ["requested", "in_review"].includes(f.product_review_status) || ["awaiting_product_review", "product_review"].includes(f.lifecycle_stage)).length;
    const blockedFeatures    = features.filter(f => f.testing_status === "blocked").length;

    const testingPct     = totalFeatures > 0 ? Math.round(testedFeatures / totalFeatures * 100) : 0;
    const documentationPct = totalFeatures > 0 ? Math.round(documentedFeatures / totalFeatures * 100) : 0;

    const activeRC         = rcs.find(r => r.is_active);
    const currentPhase     = phases.find(p => p.status === "in_progress");
    // All permanent completion states used in the Engineering Command Centre
    const COMPLETED_PHASE_STATUSES = ["complete", "completed", "accepted", "closed", "historical_exception", "approved", "production"];
    const completedPhases  = phases.filter(p => COMPLETED_PHASE_STATUSES.includes(p.status)).length;
    const completedGoals   = goals.filter(g => g.status === "completed").length;
    const activeEpics      = epics.filter(e => e.status === "active" || e.status === "in_progress").length;
    const openBacklog      = backlog.filter(b => b.status === "open" || b.status === "todo").length;
    const blockedBacklog   = backlog.filter(b => b.is_blocked).length;
    const aiGeneratedDocs  = docs.filter(d => d.generated_by_ai).length;

    const activeProvider  = aiProviders.find((p: Record<string, unknown>) => p.is_default) ?? aiProviders[0];
    const aiTelemetryAvailable = aiProviders.length > 0;

    const openDecisions   = decisions.filter(d => d.status === "open" || d.status === "proposed").length;
    const openInbox       = inbox.length;

    const latestGuardian  = guardian[0] as Record<string, unknown> | undefined;
    const latestTestPlan  = testPlans[0] as Record<string, unknown> | undefined;

    // ── Phase 4: Confidence scoring ───────────────────────────────────────────

    const confidenceInputs: ConfidenceInputs = {
      totalFeatures,
      testedFeatures,
      documentedFeatures,
      decisions: decisions.length,
      testPlans: testPlans.length,
      aiTelemetryAvailable,
      previousAuditAvailable: !!previousAudit,
      guardianReviews: guardian.length,
      backlogItems: backlog.length,
      epics: epics.length,
      phases: phases.length,
      rcs: rcs.length,
    };

    const { score: confidenceScore, level: confidenceLevel, breakdown: confidenceBreakdown, gates: confidenceGates } = calculateConfidence(confidenceInputs);

    // Derive 7-level platform maturity from engineering gates
    const maturityGatesInput: MaturityGates = {
      hasFeatureRegister:      totalFeatures > 0,
      hasTestCoverage:         testedFeatures > 0,
      hasDocumentation:        documentedFeatures > 0,
      hasReleaseCandidates:    rcs.length > 0,
      hasComplianceReview:     guardian.length > 0,
      testingAbove50pct:       testingPct >= 50,
      documentationAbove50pct: documentationPct >= 50,
      testingAbove80pct:       testingPct >= 80,
      documentationAbove80pct: documentationPct >= 80,
      hasGuardianReview:       guardian.length > 0,
      hasApprovedAudit:        existingAudits.some(a => a.status === "approved" && a.id !== audit_id && !a.is_draft),
    };
    const derivedMaturity = deriveMaturityLevel(maturityGatesInput);

    // ── Phase 5: Compute next audit number ────────────────────────────────────

    let auditNumber: string | undefined;
    if (!audit_id) {
      if (is_draft) {
        auditNumber = `DRAFT-${Date.now().toString(36).toUpperCase()}`;
      } else {
        const productionAudits = existingAudits.filter((a: Record<string, unknown>) => a.workspace !== "sandbox");
        let nextNum = 1;
        if (productionAudits.length > 0) {
          const lastNum = productionAudits[0].audit_number.replace("AUD-", "");
          const parsed  = parseInt(lastNum, 10);
          if (!isNaN(parsed)) nextNum = parsed + 1;
        }
        auditNumber = `AUD-${String(nextNum).padStart(3, "0")}`;
      }
    }

    // ── Phase 6: Feature breakdown by category ────────────────────────────────

    const featuresByCategory = [...new Set(features.map(f => f.category))].map(cat => {
      const catFeatures = features.filter(f => f.category === cat);
      const catTested   = catFeatures.filter(f => f.testing_status === "passed").length;
      const catDocs     = catFeatures.filter(f => f.documentation_status === "documented").length;
      const catLive     = catFeatures.filter(f => ["live", "released"].includes(f.lifecycle_stage)).length;
      return { cat, total: catFeatures.length, tested: catTested, documented: catDocs, live: catLive };
    });

    // ── Phase 7: Load AI config ───────────────────────────────────────────────

    const aiConfig = await loadAIConfig(svc);
    if (!aiConfig) {
      return auditErr({ error: "AI Provider not configured", error_code: "ai_not_configured", title: "AI Provider Not Configured", message: "No AI Provider has been configured.", action: "Configure an AI Provider in: Engineering Command Centre → Platform Administration → AI Providers", action_path: "pa-ai-providers" }, 422);
    }

    logCtx.ai_provider = aiConfig.provider;
    logCtx.ai_model    = aiConfig.model;

    // ── Phase 7b: Pre-compute anchor scores for measurable categories ────────────
    // These are derived deterministically from engineering data and override AI values
    // to prevent score variance across identical inputs.

    function scaleFromPct(pct: number, hasData: boolean): number {
      if (!hasData) return 20;
      if (pct === 0)  return 15;
      if (pct >= 90)  return 93;
      if (pct >= 80)  return 84;
      if (pct >= 70)  return 76;
      if (pct >= 60)  return 68;
      if (pct >= 50)  return 60;
      if (pct >= 40)  return 52;
      if (pct >= 30)  return 44;
      if (pct >= 20)  return 36;
      if (pct >= 10)  return 28;
      return 22;
    }

    const anchorScores: Record<string, number> = {
      testing:       scaleFromPct(testingPct, totalFeatures > 0),
      documentation: scaleFromPct(documentationPct, totalFeatures > 0),
      features: totalFeatures === 0 ? 20 : Math.min(95, Math.round(
        (liveFeatures / totalFeatures * 35) +
        (productionReady / totalFeatures * 25) +
        (poApproved / totalFeatures * 20) +
        (inDevFeatures / totalFeatures * 10) +
        10
      )),
      compliance: complianceFeatures === 0
        ? 40
        : Math.min(85, Math.round(
            (features.filter(f => f.compliance_critical && f.testing_status === "passed").length / complianceFeatures) * 70 + 15
          )),
    };

    logCtx.anchor_scores = anchorScores;
    logCtx.evidence = {
      features: features.length, rcs: rcs.length, phases: phases.length,
      decisions: decisions.length, testPlans: testPlans.length,
      guardian: guardian.length, backlog: backlog.length,
      previousAudit: !!previousAudit, confidence: confidenceScore,
    };

    // ── Phase 8: Build prompt ─────────────────────────────────────────────────

    const isHistorical   = mode === "historical";
    const auditNameFinal = auditTitle || (isHistorical ? (phase_name ? `Historical — ${phase_name}` : "Historical Platform Audit") : `Platform Audit ${new Date().toLocaleDateString("en-AU")}`);

    const platformVersion = activeRC?.rc_number ?? (rcs.length > 0 ? rcs[rcs.length - 1].rc_number : "Pre-RC");
    const currentPhaseName = currentPhase
      ? `Phase ${currentPhase.phase_number} — ${currentPhase.title}`
      : (phase_name ?? (completedPhases > 0 ? `${completedPhases} phases completed` : "Pre-phase"));

    const isReferenceComparison = !!domainReferenceAudit && domainReferenceAudit.id === previousAudit?.id;
    const comparisonLabel = previousAudit
      ? isReferenceComparison
        ? `⭐ Reference Audit — ${previousAudit.audit_number} (${previousAudit.name})`
        : `${previousAudit.audit_number} — ${previousAudit.name} (latest production audit)`
      : "Baseline Audit — no previous audit for comparison";

    // Previous audit comparison section
    const previousAuditContext = previousAudit
      ? `
## Comparison Baseline: ${comparisonLabel}
${isReferenceComparison ? "NOTE: This comparison is against the designated Reference Audit — the official engineering benchmark for the " + auditDomain + " domain." : "NOTE: No Reference Audit has been designated. Comparing against the latest production audit."}
- Date: ${previousAudit.created_at?.split("T")[0]}
- Health Score: ${previousAudit.overall_health_score ?? "Unknown"}/100
- Confidence: ${previousAudit.confidence_level ?? "Unknown"}
- Executive Summary: ${previousAudit.executive_summary?.slice(0, 400) ?? "Not available"}

### Previous Category Scores
${Object.entries(previousScores).map(([cat, score]) => `- ${cat}: ${score}/100`).join("\n") || "No scores recorded"}

### Previous Open Findings (${previousFindings.filter(f => f.current_status === "open").length} open)
${previousFindings.filter(f => f.current_status === "open").slice(0, 10).map(f => `- [${f.severity}] ${f.title} (${f.category})`).join("\n") || "No open findings"}

### Previously Resolved Findings
${previousFindings.filter(f => f.current_status === "closed" || f.current_status === "resolved").slice(0, 5).map(f => `- [RESOLVED] ${f.title}`).join("\n") || "None resolved"}

NOTE: When generating findings, classify each as: NEW (not in previous audit), RESOLVED (was open, now addressed), IMPROVED (same finding, better state), REGRESSION (previously better), or UNCHANGED (same as previous).`
      : `
## Comparison Baseline: Baseline Audit
No previous audit available for the ${auditDomain} domain. This is the first audit. All findings will be classified as NEW.`;

    // Engineering context package
    const engineeringContext = `
## Engineering Command Centre — Live Context Package

### Platform Identity
- Platform: LLND Automate (Literacy, Language, Numeracy + Digital) Assessment Platform
- Platform Version: ${platformVersion}
- Current Engineering Phase: ${currentPhaseName}
- Active Release Candidate: ${activeRC ? `${activeRC.rc_number} (${activeRC.status})` : "None active"}
- AI Provider: ${activeProvider ? `${activeProvider.provider} — ${activeProvider.model ?? (aiModels[0] as Record<string,unknown>)?.display_name ?? "configured"}` : "Not configured"}
- Audit Domain: ${auditDomain}

### Engineering Health Scorecard
- Feature Register: ${totalFeatures} features total
  - Live / Released: ${liveFeatures} (${totalFeatures > 0 ? Math.round(liveFeatures/totalFeatures*100) : 0}%)
  - In Development: ${inDevFeatures}
  - Production Ready: ${productionReady}
  - PO Accepted: ${poApproved}/${totalFeatures}
  - Awaiting Review: ${awaitingReview}
  - Blocked: ${blockedFeatures}
  - Compliance-Critical Features: ${complianceFeatures}
- Testing Coverage: ${testingPct}% (${testedFeatures}/${totalFeatures} passed)
- Documentation Coverage: ${documentationPct}% (${documentedFeatures}/${totalFeatures} documented)
- AI-Generated Documents: ${aiGeneratedDocs}
- Open Engineering Decisions: ${openDecisions}
- Open Backlog Items: ${openBacklog} (${blockedBacklog} blocked)
- Active Epics: ${activeEpics}
- Completed Goals: ${completedGoals}/${goals.length}
- Phases Completed: ${completedPhases}/${phases.length}

### Feature Register by Category
${featuresByCategory.map(c => `- ${c.cat}: ${c.total} features | ${c.live} live | ${c.tested} tested | ${c.documented} documented`).join("\n") || "No category data"}

### Development Phases
${phases.map(p => `- Phase ${p.phase_number}: ${p.title} [${p.status}]${p.eos_grade ? ` — EOS Grade: ${p.eos_grade}` : ""}`).join("\n") || "No phases recorded"}

### Release Candidates
${rcs.map(r => `- ${r.rc_number}: ${r.phase_name ?? "Unnamed"} [${r.status}]${r.is_active ? " ← ACTIVE" : ""}${r.release_type ? ` (${r.release_type})` : ""}`).join("\n") || "No release candidates"}

### Goals (${completedGoals}/${goals.length} complete)
${goals.slice(0, 8).map(g => `- [${g.status}] ${g.title}`).join("\n") || "No goals recorded"}

### Active Epics (${activeEpics} active)
${epics.filter(e => e.status === "active" || e.status === "in_progress").slice(0, 6).map(e => `- [${e.priority ?? "medium"}] ${e.title}`).join("\n") || "No active epics"}

### Engineering Decisions (${openDecisions} open of ${decisions.length} total)
${decisions.slice(0, 8).map(d => `- [${d.status}] ${d.decision_ref ?? ""}: ${d.title} (${d.category ?? "general"})`).join("\n") || "No decisions recorded"}

### Backlog Summary (${openBacklog} open, ${blockedBacklog} blocked)
${backlog.filter(b => b.status === "open" || b.status === "todo").slice(0, 8).map(b => `- [${b.priority}] ${b.title}${b.is_blocked ? " ⚠ BLOCKED" : ""}`).join("\n") || "No open backlog items"}

### Test Plans
${testPlans.length > 0
  ? testPlans.slice(0, 5).map(t => `- ${t.plan_number}: ${t.title} [${t.status}]${t.coverage_percent != null ? ` — Coverage: ${t.coverage_percent}%` : ""}${t.total_cases ? ` | ${t.cases_passed ?? 0}/${t.total_cases} cases passed` : ""}`).join("\n")
  : "No formal test plans registered. Testing coverage is based on feature-level testing status only."}

### Engineering Guardian Reviews
${guardian.length > 0
  ? guardian.slice(0, 3).map(g => `- ${g.review_ref}: ${g.title} [${g.status}]${g.overall_score ? ` — Score: ${g.overall_score}/100` : ""}${g.critical_violations ? ` | ${g.critical_violations} critical violations` : ""}`).join("\n")
  : "No Engineering Guardian reviews on record."}
${latestGuardian ? `Latest Guardian Score: ${latestGuardian.overall_score ?? "Not scored"}/100` : ""}

### Documentation
- Total Documents: ${docs.length}
- AI-Generated: ${aiGeneratedDocs}
- Feature Documentation Rate: ${documentationPct}%

### AI Platform
- Provider Status: ${aiProviders.length > 0 ? `${aiProviders.length} provider(s) configured` : "No AI providers configured"}
- Active Provider: ${activeProvider ? `${activeProvider.provider}` : "None"}
- AI Telemetry: ${aiTelemetryAvailable ? "Available" : "Not configured"}

### Engineering Inbox (${openInbox} pending items)
${inbox.length > 0
  ? inbox.slice(0, 5).map(i => `- [${i.priority}/${i.type}] ${i.title}`).join("\n")
  : "No pending inbox items"}

### Recent Engineering Changes
${changeLog.length > 0
  ? changeLog.slice(0, 8).map(c => `- [${c.change_type ?? "change"}] ${c.title}${c.impact ? ` — Impact: ${c.impact}` : ""}`).join("\n")
  : "No recent change log entries"}

### Recent Product Review Activity
${reviewHistory.slice(0, 6).map(h => `- ${h.action} by ${h.actor} on ${h.created_at?.split("T")[0]}`).join("\n") || "No review history"}

### Confidence Analysis (Score: ${confidenceScore}/100 — ${confidenceLevel.toUpperCase()})
${confidenceBreakdown.map(b => `- ${b}`).join("\n")}

### Audit Context
- Audit Type: ${isHistorical ? "Historical Reconstruction" : "AI-Generated Platform Audit"}
- Audit Domain: ${auditDomain}
${phase_name ? `- Focus Area: ${phase_name}` : ""}
${notes ? `- Director Notes: ${notes}` : ""}`;

    // System prompt — AI Technical Director persona
    const systemPrompt = `You are the AI Technical Director of the LLND Automate Engineering Programme.

You are performing a formal engineering governance review as part of the programme's audit cycle.

Your role is to provide an independent, evidence-based assessment of the engineering programme's health, maturity, risks, and progress.

PERSONA AND VOICE:
- Write as a senior CTO or Engineering Director addressing the executive board and engineering leadership
- Reference live platform data by name — not generic observations
- Use executive engineering terminology: Engineering Programme, Release Candidate, Technical Debt, Engineering Investment, Architecture Health, Operational Readiness, Governance
- Every finding must reference specific platform evidence (feature names, percentages, RC numbers, phase names)
- Avoid generic statements that could apply to any software platform
- Quantify everything where data is available

LANGUAGE STANDARDS — CRITICAL:
- Do NOT make definitive compliance statements where evidence has not been established
  - WRONG: "Without testing the platform cannot be deemed compliant."
  - RIGHT: "Without testing, engineering cannot demonstrate compliance with sufficient confidence."
  - WRONG: "The platform is compliant."
  - RIGHT: "The platform has not yet established the evidence base required to assert compliance."
- Do NOT state certainty about things that have not been measured
- Use evidence-qualified language: "engineering cannot yet demonstrate", "insufficient evidence to assert", "testing coverage is insufficient to validate"
- Findings should be factual observations, not verdicts without evidence

EXECUTIVE SUMMARY STRUCTURE:
Structure the executive_summary field as 5 clear sections (use line breaks between them):
1. Current Engineering Position — one sentence: phase, RC, qualitative engineering health description (e.g. "developing", "strengthening") — do NOT write a specific numeric health score here as it is recomputed server-side
2. Key Improvements — what has improved since the comparison baseline (or "first audit baseline established")
3. Major Risks — the most critical risk to address
4. Engineering Recommendation — the single most important next investment
5. Executive Decision — approve/proceed/hold in one sentence

IMPROVEMENT TRACKING:
- Compare every finding against the Comparison Baseline section provided
- ${isReferenceComparison ? "This audit is being compared against the REFERENCE AUDIT — findings should note whether the platform has improved or regressed relative to the reference baseline" : "Classify each finding status: NEW, RESOLVED, IMPROVED, REGRESSION, or UNCHANGED"}
- Acknowledge improvements explicitly in the executive summary
- Call out regressions prominently

CONFIDENCE SCORING:
- The confidence score has been pre-calculated from evidence completeness (provided to you)
- Use this as your baseline — adjust slightly based on data quality in context
- A higher confidence score means more platform data was available to inform the audit

LANGUAGE EXAMPLES:
Instead of: "The platform lacks documentation."
Use: "Documentation coverage remains at ${documentationPct}%, preventing ${activeRC?.rc_number ?? "the active release"} from reaching Release Readiness."

Instead of: "Testing is incomplete."
Use: "${testingPct}% of features have passed testing. ${blockedFeatures} features are blocked, representing a ${complianceFeatures > 0 ? "compliance" : "quality"} risk for ${activeRC?.rc_number ?? "the current release"}."

Instead of: "There are open decisions."
Use: "${openDecisions} engineering decisions remain open, including items that may affect ${currentPhaseName} progression."

Instead of: "Without testing the platform cannot be deemed compliant."
Use: "Without tested features, engineering cannot demonstrate compliance with sufficient confidence for ${complianceFeatures} compliance-critical features."`;

    // User prompt
    const userPrompt = `Conduct a formal engineering governance audit of the LLND Automate platform.

${engineeringContext}

${previousAuditContext}

Generate a STRUCTURED JSON audit with EXACTLY this format (pure JSON only — no markdown wrapper):

AUTHORITATIVE COMPUTED METRICS — SINGLE SOURCE OF TRUTH
The following four metrics are pre-computed server-side from live engineering data.
Use these EXACT values in the "scores" object and score_notes. Do NOT deviate for these four categories.

SCORE ANCHORS (server-computed — use exactly as given):
- testing: ${anchorScores.testing} (from ${testingPct}% testing coverage, ${testedFeatures}/${totalFeatures} features — your score_notes.testing MUST cite "${testingPct}%")
- documentation: ${anchorScores.documentation} (from ${documentationPct}% doc coverage, ${documentedFeatures}/${totalFeatures} features — your score_notes.documentation MUST cite "${documentationPct}%")
- features: ${anchorScores.features} (from ${liveFeatures}/${totalFeatures} live, ${productionReady} production-ready, ${poApproved} PO-approved)
- compliance: ${anchorScores.compliance} (from ${complianceFeatures} compliance-critical features, ${features.filter(f => f.compliance_critical && f.testing_status === "passed").length} tested)

COVERAGE METRICS (use these exact figures in all narrative text, do not recalculate):
- Testing coverage: ${testingPct}% (${testedFeatures} of ${totalFeatures} features passed)
- Documentation coverage: ${documentationPct}% (${documentedFeatures} of ${totalFeatures} features documented)
- Live features: ${liveFeatures}/${totalFeatures} (${totalFeatures > 0 ? Math.round(liveFeatures/totalFeatures*100) : 0}%)

QUALITATIVE CATEGORY SCORES (architecture, engineering, security, performance, scalability, navigation, ux, ai_engineering, commercial_readiness, release_readiness, maintainability, technical_debt, po_governance):
These represent YOUR independent expert engineering assessment based on ALL the evidence above.
They must reflect the actual state of this engineering programme — NOT the testing/documentation coverage.
A platform with ${phases.length} phases (${completedPhases} completed), ${rcs.length} release candidates, ${decisions.length} engineering decisions, and ${totalFeatures} features in active development is NOT a zero-level platform.
Assess each qualitative category honestly: an active, multi-phase engineering programme typically scores 45–80 in areas where governance structures are in place.
Do NOT default any qualitative category to 20. That value should only appear if a category is genuinely non-existent.

OVERALL HEALTH SCORE: Provide your best-estimate integer. The server will recompute this as the arithmetic mean of your final category scores — do not try to pre-calculate it.
Do NOT reference a specific numeric overall_health_score in the executive_summary text (it changes after server computation). Instead, describe it qualitatively (e.g. "developing", "strengthening", "approaching production readiness").

{
  "audit_name": "${auditNameFinal}",
  "executive_summary": "Structure as 5 sections separated by newlines:\n1. Current Engineering Position: [phase, RC, qualitative health description — NO numeric score]\n2. Key Improvements: [what improved vs comparison baseline, or 'first audit baseline established']\n3. Major Risks: [most critical risk]\n4. Engineering Recommendation: [single most important next investment]\n5. Executive Decision: [approve/proceed/hold in one sentence]",
  "platform_maturity": "one of: Prototype, Foundation, Engineering, Internal Beta, Pilot Ready, Production Ready, Commercially Mature",
  "overall_health_score": 0-100,
  "overall_confidence": ${confidenceScore},
  "confidence_level": "${confidenceLevel}",
  "key_strengths": ["specific strength referencing platform data", "..."],
  "key_weaknesses": ["specific weakness with data", "..."],
  "highest_risks": ["specific risk with platform context", "..."],
  "highest_opportunities": ["specific opportunity", "..."],
  "top_priorities": ["most impactful next investment", "..."],
  "recommended_next_focus": "specific next engineering investment referencing current phase/RC",
  "commercial_readiness": "one of: not_ready, partially_ready, nearly_ready, ready",
  "commercial_confidence": 0-100,
  "commercial_recommendation": "commercial recommendation referencing release readiness state",
  "compliance_score": 0-100,
  "compliance_readiness": "one of: not_ready, partially_ready, nearly_ready, ready",
  "release_readiness_internal": "one of: not_ready, partially_ready, nearly_ready, ready",
  "release_readiness_beta": "one of: not_ready, partially_ready, nearly_ready, ready",
  "release_readiness_pilot": "one of: not_ready, partially_ready, nearly_ready, ready",
  "release_readiness_production": "one of: not_ready, partially_ready, nearly_ready, ready",
  "release_readiness_commercial": "one of: not_ready, partially_ready, nearly_ready, ready",
  "scores": {
    "architecture": 0-100,
    "engineering": 0-100,
    "features": 0-100,
    "documentation": 0-100,
    "testing": 0-100,
    "compliance": 0-100,
    "security": 0-100,
    "performance": 0-100,
    "scalability": 0-100,
    "navigation": 0-100,
    "ux": 0-100,
    "ai_engineering": 0-100,
    "commercial_readiness": 0-100,
    "release_readiness": 0-100,
    "maintainability": 0-100,
    "technical_debt": 0-100,
    "po_governance": 0-100
  },
  "score_notes": {
    "architecture": "note referencing platform evidence",
    "engineering": "note referencing phase/features",
    "features": "note referencing feature register data",
    "documentation": "note with actual percentage",
    "testing": "note with actual percentage",
    "compliance": "note referencing compliance-critical features",
    "security": "brief note",
    "performance": "brief note",
    "scalability": "brief note",
    "navigation": "brief note",
    "ux": "brief note",
    "ai_engineering": "note referencing AI provider/telemetry state",
    "commercial_readiness": "note referencing RC/release state",
    "release_readiness": "note referencing active RC",
    "maintainability": "brief note",
    "technical_debt": "brief note",
    "po_governance": "note referencing decision/backlog governance"
  },
  "executive_kpis": {
    "engineering_health": 0-100,
    "architecture_health": 0-100,
    "testing_health": 0-100,
    "compliance_health": 0-100,
    "documentation_health": 0-100,
    "release_readiness": 0-100,
    "ai_platform_health": 0-100,
    "performance_health": 0-100,
    "operational_health": 0-100
  },
  "findings": [
    {
      "severity": "critical|high|medium|low|information",
      "category": "category name",
      "title": "concise finding title referencing actual platform evidence",
      "description": "detailed description using platform-specific data and terminology",
      "business_impact": "specific business impact referencing release/commercial state",
      "technical_impact": "technical impact on engineering programme",
      "risk": "risk if not addressed, referencing phase/RC timeline",
      "recommendation": "specific actionable recommendation with priority action",
      "estimated_effort": "one of: Hours, Days, Weeks, Months",
      "priority": "must_have|should_have|could_have|vision",
      "affected_module": "module name",
      "affected_feature": "feature name or N/A",
      "finding_status": "NEW|RESOLVED|IMPROVED|REGRESSION|UNCHANGED",
      "risk_trend": "worsening|improving|stable|new|resolved",
      "investment_area": "one of: testing, documentation, architecture, governance, ai_platform, security, performance, compliance, release_readiness",
      "suggested_owner": "Engineering Director|QA Lead|Architect|Product Owner|Release Manager|Compliance Officer",
      "expected_improvement": "specific improvement if this finding is addressed (e.g. 'Testing coverage would increase from ${testingPct}% to 85%')",
      "evidence": ["specific data point supporting this finding", "e.g. '${testingPct}% testing coverage measured'", "e.g. '${totalFeatures} features in register'"],
      "dependencies": ["dependency 1 if any"]
    }
  ],
  "director_summary": "4-6 sentences written as the AI Technical Director addressing the executive board. Reference specific platform data. Include: overall engineering verdict, biggest current risk, most critical investment, and official engineering confidence statement.",
  "director_priorities": [
    {
      "priority": 1,
      "investment": "Investment area name (e.g. Testing Coverage)",
      "why": "Why this is the top priority — reference specific platform evidence",
      "roi": "Expected return on investment if actioned",
      "effort": "Estimated effort level (e.g. 2-3 weeks)",
      "risk_reduction": "What risk is reduced if completed",
      "platform_improvement": "How the platform improves if completed"
    }
  ],
  "engineering_decision": {
    "verdict": "Proceed|Proceed with Conditions|Hold Release|Do Not Proceed",
    "recommendation": "approve|approve_with_conditions|reject",
    "rationale": "2-3 sentence rationale referencing engineering evidence for this decision",
    "development_status": "e.g. Active Development",
    "commercial_status": "e.g. Pre-Commercial — Internal Only",
    "current_stage": "e.g. Engineering Phase 9",
    "current_release": "${activeRC?.rc_number ?? "Pre-RC"}",
    "recommended_next_release": "e.g. RC-004",
    "recommended_next_stage": "e.g. Phase 10 — Beta Preparation",
    "engineering_confidence": 0-100,
    "risk_level": "low|medium|high|critical",
    "business_risk": "1-sentence business risk assessment",
    "engineering_risk": "1-sentence engineering risk assessment",
    "compliance_risk": "1-sentence compliance risk (reference ${complianceFeatures} compliance-critical features)",
    "release_risk": "1-sentence release risk referencing active RC",
    "required_actions": ["Required action if approve_with_conditions or reject"],
    "approved_by": "AI Technical Director",
    "decision_date": "${new Date().toISOString().split("T")[0]}"
  },
  "recommendations": [
    {
      "title": "Short actionable recommendation title",
      "description": "2-3 sentence description of what to do and why — reference platform evidence",
      "priority": "critical|high|medium|low",
      "category": "testing|documentation|architecture|governance|security|compliance|performance|ai_platform|release_readiness",
      "owner": "Engineering Director|QA Lead|Architect|Product Owner|Release Manager|Compliance Officer"
    }
  ]
}

FINDING REQUIREMENTS:
- Generate 8-14 findings appropriate to the evidence quality
- Every finding MUST reference specific platform data (percentages, counts, RC numbers, phase names)
- Classify finding_status against previous audit data (all NEW if no previous audit)
- Prioritise findings that block ${activeRC?.rc_number ?? "the current release"} or ${currentPhaseName} progression
- ${testingPct < 50 ? `Testing coverage of ${testingPct}% is a critical programme risk — include a testing finding` : "Note testing progress in appropriate finding"}
- ${documentationPct < 50 ? `Documentation coverage of ${documentationPct}% blocks Release Readiness — include a documentation finding` : "Acknowledge documentation progress"}
- ${openDecisions > 0 ? `${openDecisions} open engineering decisions require governance finding` : ""}
- ${openInbox > 0 ? `${openInbox} pending AI Director inbox items need attention` : ""}
${latestGuardian ? `- Engineering Guardian most recent review scored ${latestGuardian.overall_score ?? "unknown"}/100 — reference this` : "- No Guardian review available — recommend initiating one"}

Return ONLY valid JSON. No markdown. No explanation.`;

    logCtx.prompt_built_at = Date.now() - requestStart;

    const aiResponse = await generate(svc, {
      feature: `platform-audit-${auditNumber ?? audit_id ?? "draft"}`,
      messages: [{ role: "user", content: userPrompt }],
      systemPrompt,
      maxTokens: 5000,
      temperature: 0,
    });

    logCtx.ai_response_at = Date.now() - requestStart;

    // ── Parse AI response ──────────────────────────────────────────────────────

    let parsed: Record<string, unknown>;
    try {
      const cleaned = aiResponse.content.replace(/^```(?:json)?\n?/m, "").replace(/\n?```$/m, "").trim();
      parsed = JSON.parse(cleaned);
    } catch {
      console.error("[audit] AI returned invalid JSON:", aiResponse.content.slice(0, 500));
      return auditErr({
        error: "Invalid AI response", error_code: "ai_parse_error", title: "AI Response Error",
        message: "The AI returned an unexpected format. Please try again.",
        action: "Retry the audit generation. If this persists, check the AI provider model selection.",
      }, 500);
    }

    const durationMs      = Date.now() - startTime;
    const durationMinutes = Math.round(durationMs / 60000) || 1;

    // ── Phase 9: Single-source-of-truth enforcement ───────────────────────────
    //
    // All engineering metrics are resolved to a single authoritative value here.
    // Nothing downstream should re-derive or re-calculate any of these.
    //
    // Order is critical:
    //   a) Apply anchor overrides to scores (deterministic measurable categories)
    //   b) Enforce minimum floor on all categories
    //   c) Compute overall_health_score as mean of all final category scores
    //   d) Override platform_maturity from server-derived gate logic
    //   e) Override score_notes for anchored categories with exact metric text
    //   f) Sync ALL executive_kpis to authoritative sources
    //   g) Sync compliance_score to anchorScores.compliance
    //   h) Sync commercial_confidence to the commercial_readiness score

    if (parsed.scores && typeof parsed.scores === "object") {
      const scores = parsed.scores as Record<string, number>;

      // (a) Override measurable categories with server-side anchors
      for (const [cat, anchor] of Object.entries(anchorScores)) {
        scores[cat] = anchor;
      }

      // (b) Enforce minimum of 20 for any category with engineering data present
      const hasEngData = totalFeatures > 0 || decisions.length > 0 || phases.length > 0;
      if (hasEngData) {
        for (const cat of Object.keys(scores)) {
          if (typeof scores[cat] === "number" && scores[cat] < 20) {
            scores[cat] = 20;
          }
        }
      }

      // (c) Compute overall_health_score server-side as arithmetic mean of all category scores
      const scoreCats = Object.values(scores).filter(v => typeof v === "number" && v > 0);
      const computedOverallHealth = scoreCats.length > 0
        ? Math.round(scoreCats.reduce((a, b) => a + b, 0) / scoreCats.length)
        : 50;
      parsed.overall_health_score = computedOverallHealth;

      // (c2) Sanitise executive_summary: replace any decimal/fractional score (e.g. 43.57/100)
      //      that the AI computed before server anchors were applied.
      if (typeof parsed.executive_summary === "string") {
        parsed.executive_summary = parsed.executive_summary.replace(
          /\b\d+\.\d{1,2}\/100\b/g,
          `${computedOverallHealth}/100`,
        );
      }

      // (d) Override platform_maturity with server-derived gate logic (fully deterministic)
      parsed.platform_maturity = derivedMaturity.label;

      // (e) Override score_notes for anchored categories — use post-floor scores.* values, not pre-floor anchorScores.*
      if (!parsed.score_notes || typeof parsed.score_notes !== "object") {
        parsed.score_notes = {};
      }
      const scoreNotes = parsed.score_notes as Record<string, string>;
      scoreNotes.testing        = `${testingPct}% of ${totalFeatures} features passed testing (${testedFeatures}/${totalFeatures}). Score: ${scores.testing}/100.`;
      scoreNotes.documentation  = `${documentationPct}% of ${totalFeatures} features documented (${documentedFeatures}/${totalFeatures}). Score: ${scores.documentation}/100.`;
      scoreNotes.compliance     = `${complianceFeatures} compliance-critical features; ${features.filter(f => f.compliance_critical && f.testing_status === "passed").length} have passed testing. Score: ${scores.compliance}/100.`;
      scoreNotes.features       = `${liveFeatures}/${totalFeatures} features live (${totalFeatures > 0 ? Math.round(liveFeatures/totalFeatures*100) : 0}%), ${productionReady} production-ready, ${poApproved} PO-approved. Score: ${scores.features}/100.`;

      // (f) Sync ALL executive_kpis to authoritative sources — use post-floor scores.* values
      // IMPORTANT: anchorScores.* is pre-floor; scores.* is post-floor (Phase 9b already ran).
      // KPIs must match the stored category scores exactly — always read from scores.* here.
      if (!parsed.executive_kpis || typeof parsed.executive_kpis !== "object") {
        parsed.executive_kpis = {};
      }
      const kpis = parsed.executive_kpis as Record<string, number>;
      kpis.engineering_health    = computedOverallHealth;
      kpis.testing_health        = scores.testing;         // post-floor — matches ecc_audit_scores row
      kpis.documentation_health  = scores.documentation;  // post-floor — matches ecc_audit_scores row
      kpis.compliance_health     = scores.compliance;      // post-floor — matches ecc_audit_scores row
      kpis.architecture_health   = typeof scores.architecture      === "number" ? scores.architecture      : (kpis.architecture_health   ?? 50);
      kpis.release_readiness     = typeof scores.release_readiness  === "number" ? scores.release_readiness  : (kpis.release_readiness     ?? 50);
      kpis.ai_platform_health    = typeof scores.ai_engineering     === "number" ? scores.ai_engineering     : (kpis.ai_platform_health    ?? 50);
      kpis.performance_health    = typeof scores.performance        === "number" ? scores.performance        : (kpis.performance_health    ?? 50);
      kpis.operational_health    = typeof scores.engineering        === "number" ? scores.engineering        : (kpis.operational_health    ?? 50);

      // (g) Sync compliance_score (top-level field) to the post-floor category score
      parsed.compliance_score = scores.compliance;

      // (h) Sync commercial_confidence to the commercial_readiness category score
      if (typeof scores.commercial_readiness === "number") {
        parsed.commercial_confidence = scores.commercial_readiness;
      }

      // (i) Confidence is deterministic — always use server-calculated value
      parsed.overall_confidence = confidenceScore;
    }

    // ── Build evidence sources ─────────────────────────────────────────────────

    const evidenceSources = [
      { source: "Feature Register",       count: totalFeatures,   note: `${totalFeatures} features analysed` },
      { source: "Dev Phases",             count: phases.length,   note: `${phases.length} phases (${completedPhases} completed)` },
      { source: "Documentation",          count: docs.length,     note: `${docs.length} documents (${documentationPct}% coverage)` },
      { source: "Product Review History", count: reviewHistory.length, note: `${reviewHistory.length} review events` },
      { source: "Release Candidates",     count: rcs.length,      note: `${rcs.length} release candidates` },
      { source: "Goals & Milestones",     count: goals.length + milestones.length, note: `${goals.length} goals, ${milestones.length} milestones` },
      { source: "Engineering Decisions",  count: decisions.length, note: `${decisions.length} decisions (${openDecisions} open)` },
      { source: "Backlog",                count: backlog.length,  note: `${backlog.length} items (${openBacklog} open)` },
      { source: "Test Plans",             count: testPlans.length, note: `${testPlans.length} formal test plans` },
      { source: "Guardian Reviews",       count: guardian.length, note: guardian.length > 0 ? `${guardian.length} reviews` : "None available" },
      { source: "AI Platform",            count: aiProviders.length, note: aiProviders.length > 0 ? `${aiProviders.length} provider(s)` : "Not configured" },
      { source: "Engineering Inbox",      count: inbox.length,    note: `${inbox.length} pending items` },
      ...(previousAudit ? [{ source: "Comparison Baseline", count: 1, note: `${isReferenceComparison ? "⭐ Reference Audit — " : ""}${previousAudit.audit_number} (score: ${previousAudit.overall_health_score ?? "?"}%)` }] : []),
    ];

    const findingsArr    = Array.isArray(parsed.findings) ? (parsed.findings as Record<string, unknown>[]) : [];
    const criticalCount  = findingsArr.filter(f => f.severity === "critical").length;
    const highCount      = findingsArr.filter(f => f.severity === "high").length;
    const mediumCount    = findingsArr.filter(f => f.severity === "medium").length;
    const lowCount       = findingsArr.filter(f => f.severity === "low" || f.severity === "information").length;

    logCtx.findings_count = findingsArr.length;

    // Compute per-category score deltas vs previous audit
    const parsedScores = (parsed.scores ?? {}) as Record<string, number>;
    const scoreDeltasObj: Record<string, { current: number; previous: number | null; delta: number | null }> = {};
    for (const [cat, current] of Object.entries(parsedScores)) {
      const previous = previousScores[cat] ?? null;
      scoreDeltasObj[cat] = {
        current: Math.min(100, Math.max(0, Number(current))),
        previous,
        delta: previous != null ? Number(current) - previous : null,
      };
    }

    // ── Upsert audit record ────────────────────────────────────────────────────

    const now = new Date().toISOString();
    const auditPayload: Record<string, unknown> = {
      audit_type:                  auditDomain,
      creation_method:             "ai_generated",
      is_draft:                    is_draft,
      workspace:                   is_draft ? "sandbox" : "production",
      audit_engine_version:        "Engineering Governance v1.0",
      name:                        String(parsed.audit_name ?? auditNameFinal),
      audit_date:                  new Date().toISOString().split("T")[0],
      platform_version:            platformVersion,
      development_phase:           currentPhaseName,
      status:                      "ai_generated",
      confidence_level:            String(parsed.confidence_level ?? confidenceLevel),
      overall_health_score:        Number(parsed.overall_health_score ?? 50),
      platform_maturity:           derivedMaturity.label,
      overall_confidence:          Number(parsed.overall_confidence ?? confidenceScore),
      executive_summary:           String(parsed.executive_summary ?? ""),
      director_summary:            parsed.director_summary ? String(parsed.director_summary) : null,
      director_priorities:         Array.isArray(parsed.director_priorities) ? parsed.director_priorities : null,
      engineering_decision:        parsed.engineering_decision && typeof parsed.engineering_decision === "object" ? parsed.engineering_decision : null,
      risk_level:                  parsed.engineering_decision
        ? String((parsed.engineering_decision as Record<string, unknown>).risk_level ?? "medium")
        : null,
      score_deltas:                Object.keys(scoreDeltasObj).length > 0 ? scoreDeltasObj : null,
      confidence_reasoning:        { score: confidenceScore, level: confidenceLevel, gates: confidenceGates, breakdown: confidenceBreakdown },
      maturity_gates:              { ...maturityGatesInput, derived_level: derivedMaturity.level, derived_label: derivedMaturity.label, next: derivedMaturity.next, reasoning: derivedMaturity.reasoning },
      previous_audit_type_id:      previousAudit?.id ?? null,
      key_strengths:               Array.isArray(parsed.key_strengths) ? parsed.key_strengths : [],
      key_weaknesses:              Array.isArray(parsed.key_weaknesses) ? parsed.key_weaknesses : [],
      highest_risks:               Array.isArray(parsed.highest_risks) ? parsed.highest_risks : [],
      highest_opportunities:       Array.isArray(parsed.highest_opportunities) ? parsed.highest_opportunities : [],
      top_priorities:              Array.isArray(parsed.top_priorities) ? parsed.top_priorities : [],
      recommended_next_focus:      String(parsed.recommended_next_focus ?? ""),
      commercial_readiness:        String(parsed.commercial_readiness ?? "not_ready"),
      commercial_confidence:       Number(parsed.commercial_confidence ?? 0),  // synced to commercial_readiness score in Phase 9h
      commercial_recommendation:   String(parsed.commercial_recommendation ?? ""),
      compliance_score:            anchorScores.compliance,  // authoritative — same value as scores.compliance
      compliance_readiness:        String(parsed.compliance_readiness ?? "not_ready"),
      release_readiness:           String(parsed.release_readiness_production ?? "not_ready"),
      release_readiness_internal:  String(parsed.release_readiness_internal ?? "not_ready"),
      release_readiness_beta:      String(parsed.release_readiness_beta ?? "not_ready"),
      release_readiness_pilot:     String(parsed.release_readiness_pilot ?? "not_ready"),
      release_readiness_production:String(parsed.release_readiness_production ?? "not_ready"),
      release_readiness_commercial:String(parsed.release_readiness_commercial ?? "not_ready"),
      critical_findings_count:     criticalCount,
      high_findings_count:         highCount,
      medium_findings_count:       mediumCount,
      low_findings_count:          lowCount,
      total_findings_count:        findingsArr.length,
      total_features:              totalFeatures,
      features_released:           liveFeatures,
      features_in_review:          awaitingReview,
      features_in_development:     inDevFeatures,
      evidence_sources:            evidenceSources,
      linked_feature_ids:          features.slice(0, 20).map(f => f.feature_id),
      audit_duration_minutes:      durationMinutes,
      executive_kpis:              parsed.executive_kpis ?? null,
      previous_audit_id:           previousAudit?.id ?? null,
      lifecycle_history:           [{
        from: "none",
        to:   "ai_generated",
        at:   now,
        by:   "AI Technical Director",
        notes: `Generated with ${confidenceLevel} confidence (${confidenceScore}/100). Context: ${featuresByCategory.length} categories, ${decisions.length} decisions, ${testPlans.length} test plans. Decision: ${parsed.engineering_decision ? String((parsed.engineering_decision as Record<string, unknown>).verdict ?? "Pending") : "Pending"}.`,
      }],
      updated_at:                  now,
    };

    let savedAuditId: string;

    if (audit_id) {
      const { error: updateErr } = await svc.from("ecc_audits").update(auditPayload).eq("id", audit_id);
      if (updateErr) throw new Error(`Failed to update audit: ${updateErr.message}`);
      savedAuditId = audit_id;
    } else {
      const { data: inserted, error: insertErr } = await svc
        .from("ecc_audits")
        .insert({ ...auditPayload, audit_number: auditNumber! })
        .select("id")
        .single();
      if (insertErr || !inserted) throw new Error(`Failed to create audit record: ${insertErr?.message}`);
      savedAuditId = inserted.id;
    }

    logCtx.audit_id = savedAuditId;

    // Also register in engineering register if new production audit
    if (!audit_id && !is_draft) {
      const { data: regNum } = await svc.rpc("get_next_register_number", { p_type: "aud" });
      if (regNum) {
        await svc.from("ecc_engineering_register").insert({
          register_number: regNum,
          register_type:   "aud",
          entity_id:       savedAuditId,
          entity_table:    "ecc_audits",
          title:           String(parsed.audit_name ?? auditNameFinal),
          status:          "draft",
        }).then(() => {}); // non-blocking, ignore errors
      }
    }

    // ── Upsert scores ──────────────────────────────────────────────────────────

    if (parsed.scores && typeof parsed.scores === "object") {
      const scoreNotes = (parsed.score_notes ?? {}) as Record<string, string>;
      const scores = parsed.scores as Record<string, number>;

      await svc.from("ecc_audit_scores").delete().eq("audit_id", savedAuditId);

      const scoreRows = Object.entries(scores).map(([category, score]) => ({
        audit_id: savedAuditId,
        category,
        score:    Math.min(100, Math.max(0, Number(score))),
        notes:    String(scoreNotes[category] ?? ""),
      }));
      if (scoreRows.length > 0) {
        await svc.from("ecc_audit_scores").insert(scoreRows);
      }
    }

    // ── Upsert findings ────────────────────────────────────────────────────────

    if (findingsArr.length > 0) {
      await svc.from("ecc_audit_findings").delete().eq("audit_id", savedAuditId);

      const findingRows = findingsArr.map((f, i) => ({
        audit_id:              savedAuditId,
        finding_number:        `F-${String(i + 1).padStart(3, "0")}`,
        severity:              String(f.severity ?? "medium"),
        category:              String(f.category ?? "General"),
        title:                 String(f.title ?? ""),
        description:           String(f.description ?? ""),
        business_impact:       String(f.business_impact ?? ""),
        technical_impact:      String(f.technical_impact ?? ""),
        risk:                  String(f.risk ?? ""),
        recommendation:        String(f.recommendation ?? ""),
        estimated_effort:      String(f.estimated_effort ?? "Days"),
        priority:              String(f.priority ?? "should_have"),
        affected_module:       String(f.affected_module ?? ""),
        affected_feature:      String(f.affected_feature ?? "N/A"),
        current_status:        "open",
        evidence:              Array.isArray(f.evidence) ? f.evidence : null,
        risk_trend:            f.risk_trend ? String(f.risk_trend) : null,
        previous_finding_title: previousFindings.find(p =>
          String(p.title).toLowerCase().includes(String(f.title ?? "").toLowerCase().slice(0, 20))
        )?.title as string | undefined ?? null,
      }));
      await svc.from("ecc_audit_findings").insert(findingRows);
    }

    // ── Generate Markdown report ───────────────────────────────────────────────

    const prevScoreComparison = Object.entries(scoreDeltasObj).map(([k, v]) => {
      const delta = v.delta;
      return `| ${k.replace(/_/g, " ").replace(/\b\w/g, l => l.toUpperCase())} | ${v.current}/100 | ${delta != null ? (delta > 0 ? `+${delta} ↑` : delta < 0 ? `${delta} ↓` : "—") : "—"} |`;
    }).join("\n");

    const findingStatusGroups: Record<string, Record<string, unknown>[]> = {
      NEW: [], RESOLVED: [], IMPROVED: [], REGRESSION: [], UNCHANGED: [],
    };
    for (const f of findingsArr) {
      const st = String(f.finding_status ?? "NEW");
      if (!findingStatusGroups[st]) findingStatusGroups[st] = [];
      findingStatusGroups[st].push(f);
    }

    const md = `# LLND Automate Engineering Programme Audit Report

**Audit:** ${auditNumber ?? audit_id} — ${String(parsed.audit_name ?? auditNameFinal)}
**Prepared by:** AI Technical Director
**Date:** ${new Date().toLocaleDateString("en-AU")}
**Platform Version:** ${platformVersion}
**Engineering Phase:** ${currentPhaseName}
**Confidence:** ${String(parsed.confidence_level ?? confidenceLevel).toUpperCase()} (${confidenceScore}/100)
${previousAudit ? `**Compared Against:** ${isReferenceComparison ? "⭐ Reference Audit — " : ""}${previousAudit.audit_number} — ${previousAudit.name} (${previousAudit.overall_health_score ?? "?"}% health)` : "**Baseline Audit:** No prior audit in this domain for comparison"}

---

## Executive Summary

${parsed.executive_summary ?? ""}

---

## Engineering Health

**Overall Health Score:** ${parsed.overall_health_score ?? 0}/100
**Platform Maturity:** ${parsed.platform_maturity ?? "Unknown"}
**Confidence:** ${parsed.overall_confidence ?? confidenceScore}%

### Improvement Summary${previousAudit ? ` vs ${previousAudit.audit_number}` : ""}
- NEW findings: ${findingStatusGroups.NEW?.length ?? 0}
- RESOLVED: ${findingStatusGroups.RESOLVED?.length ?? 0}
- IMPROVED: ${findingStatusGroups.IMPROVED?.length ?? 0}
- REGRESSIONS: ${findingStatusGroups.REGRESSION?.length ?? 0}
- UNCHANGED: ${findingStatusGroups.UNCHANGED?.length ?? 0}

---

## Category Scores

| Category | Score | ${previousAudit ? "Delta" : "—"} |
|----------|-------|${previousAudit ? "-------|" : ""}
${prevScoreComparison}

---

## Executive KPIs

${parsed.executive_kpis ? Object.entries(parsed.executive_kpis as Record<string, number>).map(([k, v]) => `- ${k.replace(/_/g, " ").replace(/\b\w/g, l => l.toUpperCase())}: ${v}/100`).join("\n") : "Not available"}

---

## Strengths

${Array.isArray(parsed.key_strengths) ? parsed.key_strengths.map((s: unknown) => `- ${s}`).join("\n") : "None identified"}

---

## Weaknesses

${Array.isArray(parsed.key_weaknesses) ? parsed.key_weaknesses.map((w: unknown) => `- ${w}`).join("\n") : "None identified"}

---

## Critical Findings

${criticalCount === 0 ? "No critical findings." : findingsArr.filter(f => f.severity === "critical").map((f, i) => `### F-${String(i + 1).padStart(3, "0")}: ${f.title} [${f.finding_status ?? "NEW"}]\n\n${f.description}\n\n**Business Impact:** ${f.business_impact}\n**Technical Impact:** ${f.technical_impact}\n**Risk:** ${f.risk}\n**Recommendation:** ${f.recommendation}\n**Effort:** ${f.estimated_effort} | **Owner:** ${f.suggested_owner ?? "Engineering Director"}\n**Expected Improvement:** ${f.expected_improvement ?? "N/A"}`).join("\n\n---\n\n")}

---

## High Findings

${highCount === 0 ? "No high findings." : findingsArr.filter(f => f.severity === "high").map((f, i) => `### ${i + 1}. ${f.title} [${f.finding_status ?? "NEW"}]\n\n${f.description}\n\n**Recommendation:** ${f.recommendation}\n**Effort:** ${f.estimated_effort} | **Owner:** ${f.suggested_owner ?? "Engineering Director"}`).join("\n\n---\n\n")}

---

## Medium Findings

${mediumCount === 0 ? "No medium findings." : findingsArr.filter(f => f.severity === "medium").map((f, i) => `### ${i + 1}. ${f.title} [${f.finding_status ?? "NEW"}]\n\n${f.description}\n\n**Recommendation:** ${f.recommendation}`).join("\n\n---\n\n")}

---

## Must-Have Engineering Investments

${findingsArr.filter(f => f.priority === "must_have").length === 0 ? "No must-have items." : findingsArr.filter(f => f.priority === "must_have").map((f, i) => `${i + 1}. **${f.title}** [${f.investment_area ?? f.category}]\n   - ${f.recommendation}\n   - Effort: ${f.estimated_effort} | Owner: ${f.suggested_owner ?? "Engineering Director"}\n   - Expected: ${f.expected_improvement ?? "N/A"}`).join("\n\n")}

---

## Commercial Readiness

**Status:** ${parsed.commercial_readiness ?? "Unknown"}
**Confidence:** ${parsed.commercial_confidence ?? 0}%
${parsed.commercial_recommendation ?? ""}

---

## Compliance Readiness

**Score:** ${parsed.compliance_score ?? 0}/100
**Status:** ${parsed.compliance_readiness ?? "Unknown"}

---

## Release Readiness

| Milestone | Status |
|-----------|--------|
| Internal Testing | ${parsed.release_readiness_internal ?? "not_ready"} |
| Beta | ${parsed.release_readiness_beta ?? "not_ready"} |
| Pilot Customers | ${parsed.release_readiness_pilot ?? "not_ready"} |
| Production | ${parsed.release_readiness_production ?? "not_ready"} |
| Commercial Launch | ${parsed.release_readiness_commercial ?? "not_ready"} |

---

## Recommended Next Engineering Investment

${parsed.recommended_next_focus ?? "No recommendation generated."}

---

## Top Priorities

${Array.isArray(parsed.top_priorities) ? parsed.top_priorities.map((p: unknown, i: number) => `${i + 1}. ${p}`).join("\n") : "None identified"}

---

## Highest Risks

${Array.isArray(parsed.highest_risks) ? parsed.highest_risks.map((r: unknown) => `- ${r}`).join("\n") : "None identified"}

---

## Engineering Context Used

${evidenceSources.map(e => `- **${e.source}:** ${e.note}`).join("\n")}

---

*Generated by LLND Automate Engineering Command Centre — AI Technical Director*
*Confidence: ${String(parsed.confidence_level ?? confidenceLevel).toUpperCase()} (${confidenceScore}/100) based on live engineering context*
*${new Date().toISOString()}*
`;

    await svc.from("ecc_audits").update({ markdown_report: md }).eq("id", savedAuditId);

    // ── Auto-create recommendations from AI output ─────────────────────────────

    const recsArr = Array.isArray(parsed.recommendations) ? (parsed.recommendations as Record<string, unknown>[]) : [];
    if (recsArr.length > 0) {
      // Delete existing AI-generated recs (preserve manual ones via work_item_created flag)
      await svc.from("ecc_audit_recommendations")
        .delete()
        .eq("audit_id", savedAuditId)
        .is("work_item_created", false);

      const { data: existingRecs } = await svc
        .from("ecc_audit_recommendations")
        .select("id")
        .eq("audit_id", savedAuditId);
      const startIdx = (existingRecs?.length ?? 0) + 1;

      const recRows = recsArr.map((r, i) => ({
        audit_id:    savedAuditId,
        rec_number:  `REC-${String(startIdx + i).padStart(3, "0")}`,
        title:       String(r.title ?? "Untitled Recommendation"),
        description: String(r.description ?? ""),
        priority:    String(r.priority ?? "medium"),
        category:    String(r.category ?? "engineering"),
        owner:       String(r.owner ?? "Engineering Director"),
        status:      "open",
      }));
      if (recRows.length > 0) {
        await svc.from("ecc_audit_recommendations").insert(recRows);
      }
    }

    // ── Auto-create artefact links ─────────────────────────────────────────────

    // Only auto-link on new audit creation (not regeneration) to avoid duplicates
    if (!audit_id) {
      const artefactLinks: Record<string, unknown>[] = [];

      if (activeRC) {
        artefactLinks.push({
          audit_id:       savedAuditId,
          artefact_type:  "release",
          artefact_ref:   activeRC.rc_number,
          artefact_title: `${activeRC.rc_number} — ${activeRC.phase_name ?? "Active Release"}`,
          notes:          "Active Release Candidate at time of audit",
          linked_by:      "AI Technical Director",
        });
      }

      if (currentPhase) {
        artefactLinks.push({
          audit_id:       savedAuditId,
          artefact_type:  "other",
          artefact_ref:   `Phase ${currentPhase.phase_number}`,
          artefact_title: `Phase ${currentPhase.phase_number} — ${currentPhase.title}`,
          notes:          "Engineering phase in progress at time of audit",
          linked_by:      "AI Technical Director",
        });
      }

      for (const tp of testPlans.slice(0, 3) as Record<string, unknown>[]) {
        artefactLinks.push({
          audit_id:       savedAuditId,
          artefact_type:  "test_plan",
          artefact_ref:   String(tp.plan_number ?? ""),
          artefact_title: String(tp.title ?? "Test Plan"),
          notes:          `Coverage: ${tp.coverage_percent ?? 0}% — Status: ${tp.status ?? "unknown"}`,
          linked_by:      "AI Technical Director",
        });
      }

      for (const gr of guardian.slice(0, 2) as Record<string, unknown>[]) {
        artefactLinks.push({
          audit_id:       savedAuditId,
          artefact_type:  "guardian_finding",
          artefact_ref:   String(gr.review_ref ?? ""),
          artefact_title: String(gr.title ?? "Guardian Review"),
          notes:          `Score: ${gr.overall_score ?? "N/A"}/100 — Status: ${gr.status ?? "unknown"}`,
          linked_by:      "AI Technical Director",
        });
      }

      if (artefactLinks.length > 0) {
        await svc.from("ecc_audit_artefact_links").insert(artefactLinks);
      }
    }

    // ── Record health snapshot for trend analysis (production audits only) ───────

    if (!is_draft) {
      const categoryScores = (parsed.scores ?? {}) as Record<string, number>;
      await svc.from("ecc_health_history").insert({
        audit_id:        savedAuditId,
        overall_score:   Number(parsed.overall_health_score ?? 50),
        category_scores: categoryScores,
        domain_key:      auditDomain,
        recorded_at:     now,
        notes:           `${String(parsed.audit_name ?? auditNameFinal)} · Confidence: ${confidenceLevel} (${confidenceScore}/100)`,
      });
    }

    logCtx.total_duration_ms = Date.now() - requestStart;
    console.log("[audit] Completed:", JSON.stringify(logCtx));

    return ok({
      success:              true,
      audit_id:             savedAuditId,
      audit_number:         auditNumber ?? audit_id,
      overall_health_score: parsed.overall_health_score,
      confidence_level:     parsed.confidence_level ?? confidenceLevel,
      confidence_score:     confidenceScore,
      preflight_checks:     preflight.checks,
    });

  } catch (e) {
    logCtx.error             = e instanceof Error ? e.message : String(e);
    logCtx.total_duration_ms = Date.now() - requestStart;
    console.error("[audit] Error:", JSON.stringify(logCtx));

    return auditErr({
      error:       e instanceof Error ? e.message : "Internal error",
      error_code:  "internal_error",
      title:       "Audit Engine Error",
      message:     "An unexpected error occurred while generating the audit.",
      action:      "Please try again. If this persists, check the System Logs in Platform Administration.",
      action_path: "pa-system-logs",
    }, 500);
  }
});
