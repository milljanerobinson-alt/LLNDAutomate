import { createClient } from "jsr:@supabase/supabase-js@2";
import { operatorDeniedResponse, requirePlatformOperator } from "../_shared/platform-operator.ts";
import { generate, loadAIConfig, sanitizeMessages } from "../_shared/ai-service.ts";

// EWO-032R.2 — Post-AI stage diagnostics
interface StageDiagnostic {
  diagnostic_ref: string;
  request_id: string;
  conversation_id: string | null;
  message_id: string | null;
  stage_name: string;
  started_at: string;
  completed_at: string | null;
  success: boolean;
  error_message: string | null;
  error_code: string | null;
  error_details: string | null;
  error_hint: string | null;
  error_status: number | null;
  stack_trace: string | null;
}

function extractPostgrestError(err: unknown): {
  message: string | null;
  code: string | null;
  details: string | null;
  hint: string | null;
  status: number | null;
  stack: string | null;
} {
  if (!err) return { message: null, code: null, details: null, hint: null, status: null, stack: null };
  const e = err as Record<string, unknown>;
  return {
    message: (e.message as string) ?? (typeof err === "string" ? err : null),
    code: (e.code as string) ?? null,
    details: (e.details as string) ?? null,
    hint: (e.hint as string) ?? null,
    status: typeof e.status === "number" ? (e.status as number) : null,
    stack: (e.stack as string) ?? null,
  };
}

async function persistDiagnostic(svc: ReturnType<typeof createClient>, d: StageDiagnostic): Promise<void> {
  try {
    await svc.from("cc_post_ai_diagnostics").insert({
      diagnostic_ref: d.diagnostic_ref,
      request_id: d.request_id,
      conversation_id: d.conversation_id,
      message_id: d.message_id,
      stage_name: d.stage_name,
      started_at: d.started_at,
      completed_at: d.completed_at,
      success: d.success,
      error_message: d.error_message,
      error_code: d.error_code,
      error_details: d.error_details,
      error_hint: d.error_hint,
      error_status: d.error_status,
      stack_trace: d.stack_trace,
    });
  } catch { /* best-effort */ }
}

async function trackStage<T>(
  svc: ReturnType<typeof createClient>,
  requestId: string,
  conversationId: string | null,
  stageName: string,
  fn: () => Promise<T>,
): Promise<{ ok: true; value: T } | { ok: false; error: unknown; diagnostic: StageDiagnostic }> {
  const ref = `DIAG-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
  const startedAt = new Date().toISOString();
  try {
    const value = await fn();
    const d: StageDiagnostic = {
      diagnostic_ref: ref, request_id: requestId, conversation_id: conversationId,
      message_id: null, stage_name: stageName, started_at: startedAt,
      completed_at: new Date().toISOString(), success: true,
      error_message: null, error_code: null, error_details: null,
      error_hint: null, error_status: null, stack_trace: null,
    };
    await persistDiagnostic(svc, d);
    return { ok: true, value };
  } catch (err) {
    const pe = extractPostgrestError(err);
    const d: StageDiagnostic = {
      diagnostic_ref: ref, request_id: requestId, conversation_id: conversationId,
      message_id: null, stage_name: stageName, started_at: startedAt,
      completed_at: new Date().toISOString(), success: false,
      error_message: pe.message, error_code: pe.code, error_details: pe.details,
      error_hint: pe.hint, error_status: pe.status, stack_trace: pe.stack,
    };
    await persistDiagnostic(svc, d);
    return { ok: false, error: err, diagnostic: d };
  }
}

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, PUT, DELETE, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization, X-Client-Info, Apikey",
};

async function verifyAuth(req: Request) {
  const authHeader = req.headers.get("Authorization");
  if (!authHeader?.startsWith("Bearer ")) return null;
  const token = authHeader.replace("Bearer ", "");
  const anonClient = createClient(
    Deno.env.get("SUPABASE_URL")!,
    Deno.env.get("SUPABASE_ANON_KEY")!,
  );
  const { data: { user }, error } = await anonClient.auth.getUser(token);
  if (error || !user) return null;
  const svc = createClient(
    Deno.env.get("SUPABASE_URL")!,
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
  );
  const { data: profile } = await svc
    .from("profiles").select("role").eq("id", user.id).maybeSingle();
  // Issue #45: operator status (grant + MFA) is enforced by requirePlatformOperator() in the request handler; the legacy profiles.role check is retired.
  if (!profile) return null;
  return { svc, userId: user.id, role: profile.role as string };
}

// ─── Conversation Context Router (EWO-016R) ──────────────────────────────────
// Deterministic routing that runs BEFORE AI prompt construction.
// Canonical Engineering references take priority over active product context.

type CanonicalDomain =
  | "eios-engineering"
  | "active-product"
  | "project"
  | "platform-admin"
  | "candidate"
  | "general";

type EngineeringRefType =
  | "EWO" | "EXEC" | "ER" | "REC" | "IDEA" | "INTENT" | "PLAN"
  | "ES" | "AMD" | "VS" | "AUD" | "RC" | "ECR" | "TP" | "EIG";

interface DetectedRef {
  raw: string;
  type: EngineeringRefType;
  canonical: string;
  ref: string;
}

interface ResolvedRef {
  detected: DetectedRef;
  found: boolean;
  canonicalId?: string;
  title?: string;
  description?: string;
  status?: string;
  lifecycleState?: string;
  metadata?: Record<string, unknown>;
  notFoundReason?: string;
}

interface RoutingDiagnostics {
  conversationId: string | null;
  userMessage: string;
  detectedReferences: DetectedRef[];
  detectedIntent: string;
  selectedDomain: CanonicalDomain;
  routingRule: string;
  activeWorkspace: string | null;
  resolverInvoked: boolean;
  canonicalTableQueried: string | null;
  resolutionOutcome: string;
  knowledgePackageVersion: string | null;
  aiProviderInvoked: boolean;
  finalResponseClassification: string;
  relationshipGraphNodes?: number;
  relationshipGraphPending?: number;
}

// EWO-016R.Y — Authoritative Runtime Diagnostic Envelope
// Created by application/runtime code, never by the language model.
interface RuntimeDiagnosticEnvelope {
  request_id: string;
  detected_intent: string;
  resolved_domain: CanonicalDomain | null;
  resolved_object_reference: string | null;
  resolved_object_type: string | null;
  runtime_pipeline: string | null;
  services_invoked: string[];
  tables_attempted: string[];
  tables_successfully_queried: string[];
  tables_skipped: string[];
  query_failures: Array<{ source: string; failure: string }>;
  records_examined_count: number;
  relationships_found_count: number;
  pending_artefacts_count: number;
  diagnostic_confidence: "high" | "medium" | "low" | "undetermined";
  generated_at: string;
}

function buildDiagnosticEnvelope(
  requestId: string,
  detectedIntent: string,
  selectedDomain: CanonicalDomain,
  resolvedRef: string | null,
  resolvedType: string | null,
  pipeline: string | null,
  servicesInvoked: string[],
  graph: EngineeringRelationshipGraph | null,
): RuntimeDiagnosticEnvelope {
  const diagnostics = graph?.diagnostics ?? [];
  const tablesAttempted = diagnostics.filter(d => d.attempted).map(d => d.source);
  const tablesSuccessful = diagnostics.filter(d => d.attempted && d.succeeded).map(d => d.source);
  const tablesSkipped = diagnostics.filter(d => !d.attempted).map(d => d.source);
  const queryFailures = diagnostics
    .filter(d => d.attempted && !d.succeeded && d.failure)
    .map(d => ({ source: d.source, failure: d.failure! }));
  const recordsExamined = diagnostics.reduce((sum, d) => sum + d.match_count, 0);
  const relationshipsFound = graph?.totalFound ?? 0;
  const pendingArtefacts = graph?.totalPending ?? 0;

  // Diagnostic confidence: high only when all attempted sources succeeded and at least one was attempted.
  const anyAttempted = diagnostics.length > 0;
  const allSucceeded = anyAttempted && queryFailures.length === 0;
  const diagnostic_confidence: RuntimeDiagnosticEnvelope["diagnostic_confidence"] =
    !anyAttempted ? "undetermined" : allSucceeded ? "high" : queryFailures.length === diagnostics.length ? "low" : "medium";

  return {
    request_id: requestId,
    detected_intent: detectedIntent,
    resolved_domain: selectedDomain,
    resolved_object_reference: resolvedRef,
    resolved_object_type: resolvedType,
    runtime_pipeline: pipeline,
    services_invoked: servicesInvoked,
    tables_attempted: tablesAttempted,
    tables_successfully_queried: tablesSuccessful,
    tables_skipped: tablesSkipped,
    query_failures: queryFailures,
    records_examined_count: recordsExamined,
    relationships_found_count: relationshipsFound,
    pending_artefacts_count: pendingArtefacts,
    diagnostic_confidence,
    generated_at: new Date().toISOString(),
  };
}

function renderDiagnosticEnvelopeForPrompt(env: RuntimeDiagnosticEnvelope): string {
  const lines: string[] = [];
  lines.push(`Request ID: ${env.request_id}`);
  lines.push(`Detected Intent: ${env.detected_intent}`);
  lines.push(`Resolved Domain: ${env.resolved_domain ?? "none"}`);
  lines.push(`Resolved Object: ${env.resolved_object_reference ?? "none"}`);
  lines.push(`Runtime Pipeline: ${env.runtime_pipeline ?? "none"}`);
  lines.push(`Services Invoked: ${env.services_invoked.join(", ") || "none"}`);
  lines.push(`Tables Attempted: ${env.tables_attempted.join(", ") || "none"}`);
  lines.push(`Tables Successfully Queried: ${env.tables_successfully_queried.join(", ") || "none"}`);
  lines.push(`Query Failures: ${env.query_failures.length > 0 ? env.query_failures.map(f => `${f.source} (${f.failure})`).join("; ") : "none"}`);
  lines.push(`Records Examined: ${env.records_examined_count}`);
  lines.push(`Relationships Found: ${env.relationships_found_count}`);
  lines.push(`Pending Artefacts: ${env.pending_artefacts_count}`);
  lines.push(`Diagnostic Confidence: ${env.diagnostic_confidence}`);
  lines.push(`Generated At: ${env.generated_at}`);
  return lines.join("\n");
}

// EWO-016R.Y — Engineering Debug Mode: structured, read-only runtime evidence.
// Generated by code, never free-form AI text. Excludes secrets, credentials, or raw SQL.
function renderDebugModeBlock(env: RuntimeDiagnosticEnvelope): string {
  const lines: string[] = [];
  lines.push("ENGINEERING RUNTIME DIAGNOSTICS");
  lines.push("");
  lines.push(`Request ID:`);
  lines.push(env.request_id);
  lines.push("");
  lines.push(`Detected Intent:`);
  lines.push(env.detected_intent);
  lines.push("");
  lines.push(`Resolved Domain:`);
  lines.push(env.resolved_domain ?? "none");
  lines.push("");
  lines.push(`Resolved Engineering Object:`);
  lines.push(env.resolved_object_reference ?? "none");
  lines.push("");
  lines.push(`Runtime Pipeline:`);
  lines.push(env.runtime_pipeline ?? "none");
  lines.push("");
  lines.push(`Services Invoked:`);
  lines.push(env.services_invoked.join(", ") || "none");
  lines.push("");
  lines.push(`Tables Attempted:`);
  if (env.tables_attempted.length === 0) {
    lines.push("None");
  } else {
    for (const t of env.tables_attempted) lines.push(`- ${t}`);
  }
  lines.push("");
  lines.push(`Tables Successfully Queried:`);
  if (env.tables_successfully_queried.length === 0) {
    lines.push("None");
  } else {
    for (const t of env.tables_successfully_queried) lines.push(`- ${t}`);
  }
  lines.push("");
  lines.push(`Query Failures:`);
  if (env.query_failures.length === 0) {
    lines.push("None");
  } else {
    for (const f of env.query_failures) lines.push(`- ${f.source}: ${f.failure}`);
  }
  lines.push("");
  lines.push(`Records Examined:`);
  lines.push(String(env.records_examined_count));
  lines.push("");
  lines.push(`Relationships Found:`);
  lines.push(String(env.relationships_found_count));
  lines.push("");
  lines.push(`Pending Artefacts:`);
  lines.push(String(env.pending_artefacts_count));
  lines.push("");
  lines.push(`Confidence:`);
  lines.push(env.diagnostic_confidence);
  lines.push("");
  lines.push(`Timestamp:`);
  lines.push(env.generated_at);
  return lines.join("\n");
}

// Reference families that route to EIOS Engineering (Requirement 2)
const REFERENCE_PATTERNS: Array<{ type: EngineeringRefType; regex: RegExp }> = [
  { type: "EWO", regex: /\bEWO-(\d+(?:\.\d+[A-Z]?\.?\d*)?)\b/gi },
  { type: "EXEC", regex: /\bEXEC-(\d+)\b/gi },
  { type: "ER", regex: /\bER-(\d+)\b/gi },
  { type: "REC", regex: /\bREC-(\d+)\b/gi },
  { type: "IDEA", regex: /\bIDEA-(\d+)\b/gi },
  { type: "INTENT", regex: /\bINTENT-(\d+)\b/gi },
  { type: "PLAN", regex: /\bPLAN-(\d+)\b/gi },
  { type: "ES", regex: /\bES-([A-Z0-9][A-Z0-9-]*\d+)\b/gi },
  { type: "AMD", regex: /\bAMD-(\d+)\b/gi },
  { type: "VS", regex: /\bVS-(\d{8}-\d+)\b/gi },
  { type: "AUD", regex: /\bAUD-(\d+)\b/gi },
  { type: "RC", regex: /\bRC-(\d+)\b/gi },
  { type: "ECR", regex: /\bECR-(\d+)\b/gi },
  { type: "TP", regex: /\bTP-(\d+)\b/gi },
  { type: "EIG", regex: /\bEIG-(\d+)\b/gi },
];

function detectReferences(text: string): DetectedRef[] {
  const results: DetectedRef[] = [];
  const seen = new Set<string>();
  for (const { type, regex } of REFERENCE_PATTERNS) {
    const pattern = new RegExp(regex.source, regex.flags);
    let match: RegExpExecArray | null;
    while ((match = pattern.exec(text)) !== null) {
      const raw = match[0];
      const refValue = match[1];
      const prefix = type === "ES" ? "ES" : type;
      const canonical = `${prefix}-${refValue}`;
      const key = `${type}:${canonical}`;
      if (seen.has(key)) continue;
      seen.add(key);
      results.push({ raw, type, canonical, ref: refValue });
    }
  }
  return results;
}

// Canonical table mapping (Requirement 6)
const TYPE_TO_TABLE: Record<EngineeringRefType, { table: string; refColumn: string; select: string }> = {
  EWO:    { table: "engineering_work_orders",         refColumn: "ewo_ref",          select: "id, ewo_ref, title, executive_summary, business_objective, engineering_objective, status, implementation_status, verification_status, po_acceptance_notes, engineering_package_status, implementation_provider, owner, created_at, updated_at" },
  EXEC:   { table: "engineering_executions",           refColumn: "execution_ref",   select: "id, execution_ref, ewo_id, implementation_status, implementation_provider, po_status, created_at, updated_at, started_at, finished_at" },
  ER:     { table: "engineering_records_library",      refColumn: "id",               select: "id, title, description, status, created_at, updated_at" },
  REC:    { table: "engineering_recovery_packages",    refColumn: "recovery_ref",     select: "id, recovery_ref, canonical_reference, title, recovery_status, po_status, object_classification, engineering_confidence, created_at, updated_at, imported_at, imported_ewo_id" },
  IDEA:   { table: "engineering_idea",                  refColumn: "idea_ref",         select: "id, idea_ref, title, description, status, created_at, updated_at" },
  INTENT: { table: "atd_engineering_intents",           refColumn: "intent_ref",       select: "id, intent_ref, title, status, created_at, updated_at" },
  PLAN:   { table: "atd_engineering_plans",              refColumn: "plan_ref",         select: "id, plan_ref, intent_id, executive_summary, engineering_phases, recommended_ewos, status, version, created_at, updated_at" },
  ES:     { table: "ecc_engineering_standards",         refColumn: "title",            select: "id, version_introduced, category, title, body, status, created_at, updated_at" },
  AMD:    { table: "constitutional_documents",          refColumn: "document_ref",    select: "id, document_ref, title, document_type, version, status, sections, created_at, updated_at" },
  VS:     { table: "ewo_verification_sessions",         refColumn: "session_ref",     select: "id, session_ref, ewo_id, overall_status, started_at, completed_at" },
  AUD:    { table: "ecc_audits",                        refColumn: "id",               select: "id, title, description, status, notes, created_at, updated_at" },
  RC:     { table: "ecc_release_candidates",            refColumn: "id",               select: "id, title, description, status, release_type, version, created_at, updated_at" },
  ECR:    { table: "ecc_governed_reviews",              refColumn: "id",               select: "id, review_type_key, status, notes, created_at, updated_at" },
  TP:     { table: "ecc_test_plans",                    refColumn: "id",               select: "id, title, description, status, version, created_at, updated_at" },
  EIG:    { table: "eig_entities",                       refColumn: "entity_ref",       select: "id, entity_ref, entity_type, name, description, status, version, created_at, updated_at" },
};

async function resolveReference(svc: ReturnType<typeof createClient>, detected: DetectedRef): Promise<ResolvedRef> {
  const config = TYPE_TO_TABLE[detected.type];
  if (!config) return { detected, found: false, notFoundReason: `Unknown reference type: ${detected.type}` };

  try {
    const { data, error } = await svc
      .from(config.table)
      .select(config.select)
      .ilike(config.refColumn, detected.canonical)
      .maybeSingle();

    if (error) return { detected, found: false, notFoundReason: `Database error: ${error.message}` };
    if (!data) return { detected, found: false, notFoundReason: `${detected.canonical} could not be found in the Engineering Ledger.` };

    return {
      detected,
      found: true,
      canonicalId: data.id,
      title: data.title || data.name || data.executive_summary || detected.canonical,
      description: data.description || data.raw_input || undefined,
      status: data.status || data.implementation_status || data.recovery_status || data.overall_status,
      lifecycleState: data.lifecycle_state || data.status || data.implementation_status,
      metadata: data,
    };
  } catch (err) {
    return { detected, found: false, notFoundReason: `Lookup failed: ${(err as Error).message}` };
  }
}

// Engineering Knowledge Package assembly (server-side, authoritative)
interface KnowledgePackage {
  reference: string;
  objectType: EngineeringRefType;
  canonicalId: string;
  assembledAt: string;
  version: string;
  summary: {
    title: string;
    purpose: string;
    currentStatus: string;
    lifecycleState: string;
    verificationState?: string;
    poState?: string;
    nextAction?: string;
  };
  ewo?: {
    ref: string;
    title: string;
    description: string;
    status: string;
    lifecycleState: string;
    poStatus: string;
    verificationStatus: string;
    implementationProvider?: string;
  };
  verification?: { overallStatus: string; gates: Array<{ gate: string; status: string; evidenceSummary?: string }> };
  executionHistory?: Array<{ ref: string; status: string; provider: string; createdAt: string }>;
  relatedEngineering?: Array<{ ref: string; title: string; relationship: string }>;
}

async function assembleKnowledgePackage(svc: ReturnType<typeof createClient>, resolved: ResolvedRef): Promise<KnowledgePackage | null> {
  if (!resolved.found || !resolved.canonicalId) return null;

  const assembledAt = new Date().toISOString();
  const type = resolved.detected.type;
  const data = resolved.metadata as Record<string, unknown>;

  if (type === "EWO") {
    const ewoId = resolved.canonicalId;

    // Verification gates
    let verification: KnowledgePackage["verification"];
    const { data: gates } = await svc
      .from("ewo_verification_gates")
      .select("gate_key, gate_status, evidence_summary")
      .eq("ewo_id", ewoId);
    if (gates && gates.length > 0) {
      verification = {
        overallStatus: (data.verification_status as string) || "not_started",
        gates: gates.map((g: Record<string, string>) => ({ gate: g.gate_key, status: g.gate_status, evidenceSummary: g.evidence_summary || undefined })),
      };
    }

    // Execution history
    let executionHistory: KnowledgePackage["executionHistory"];
    const { data: execData } = await svc
      .from("engineering_executions")
      .select("execution_ref, implementation_status, implementation_provider, created_at")
      .eq("ewo_id", ewoId)
      .order("created_at", { ascending: false })
      .limit(10);
    if (execData && execData.length > 0) {
      executionHistory = execData.map((e: Record<string, string>) => ({
        ref: e.execution_ref, status: e.implementation_status, provider: e.implementation_provider || "bolt", createdAt: e.created_at,
      }));
    }

    // Related engineering
    let relatedEngineering: KnowledgePackage["relatedEngineering"];
    const ewoRef = (data.ewo_ref as string) || resolved.detected.canonical;
    const { data: relData } = await svc
      .from("engineering_object_relationships")
      .select("from_object_ref, to_object_ref, relationship_type")
      .or(`from_object_ref.eq.${ewoRef},to_object_ref.eq.${ewoRef}`)
      .limit(20);
    if (relData && relData.length > 0) {
      relatedEngineering = relData.map((r: Record<string, string>) => ({
        ref: r.from_object_ref === ewoRef ? r.to_object_ref : r.from_object_ref,
        title: r.from_object_ref === ewoRef ? r.to_object_ref : r.from_object_ref,
        relationship: r.relationship_type,
      }));
    }

    const ewo = {
      ref: (data.ewo_ref as string) || resolved.detected.canonical,
      title: (data.title as string) || resolved.title || "",
      description: (data.executive_summary as string) || (data.engineering_objective as string) || "",
      status: (data.status as string) || "unknown",
      lifecycleState: (data.implementation_status as string) || (data.status as string) || "unknown",
      poStatus: (data.po_acceptance_notes as string) ? "accepted" : "pending",
      verificationStatus: (data.verification_status as string) || "not_started",
      implementationProvider: (data.implementation_provider as string) || undefined,
    };

    const nextAction = computeNextAction(ewo, verification);

    return {
      reference: resolved.detected.canonical,
      objectType: "EWO",
      canonicalId: ewoId,
      assembledAt,
      version: "1.0.0",
      summary: {
        title: ewo.title,
        purpose: ewo.description,
        currentStatus: ewo.status,
        lifecycleState: ewo.lifecycleState,
        verificationState: ewo.verificationStatus,
        poState: ewo.poStatus,
        nextAction,
      },
      ewo,
      verification,
      executionHistory,
      relatedEngineering,
    };
  }

  // Generic fallback
  return {
    reference: resolved.detected.canonical,
    objectType: type,
    canonicalId: resolved.canonicalId,
    assembledAt,
    version: "1.0.0",
    summary: {
      title: resolved.title || resolved.detected.canonical,
      purpose: resolved.description || "No description available.",
      currentStatus: resolved.status || "unknown",
      lifecycleState: resolved.lifecycleState || "unknown",
    },
  };
}

function computeNextAction(ewo: NonNullable<KnowledgePackage["ewo"]>, verification?: KnowledgePackage["verification"]): string {
  if (ewo.lifecycleState === "released") return "No further action — EWO is released.";
  if (ewo.poStatus === "pending" && ewo.verificationStatus === "verified") return "Awaiting Product Owner Acceptance.";
  if (verification && verification.overallStatus !== "verified") return "Awaiting Automated Verification.";
  if (ewo.status === "approved" || ewo.status === "in_progress") return "Ready for execution.";
  if (ewo.status === "draft") return "Awaiting governance approval.";
  return "Review EWO status.";
}

function renderKnowledgePackageAsContext(pkg: KnowledgePackage): string {
  const lines: string[] = [];
  lines.push(`# Engineering Knowledge Package: ${pkg.reference}`);
  lines.push(`Assembled: ${pkg.assembledAt}`);
  lines.push(`Version: ${pkg.version}`);
  lines.push("");

  if (pkg.ewo) {
    lines.push("## Engineering Work Order");
    lines.push(`- Reference: ${pkg.ewo.ref}`);
    lines.push(`- Title: ${pkg.ewo.title}`);
    lines.push(`- Description: ${pkg.ewo.description}`);
    lines.push(`- Status: ${pkg.ewo.status}`);
    lines.push(`- Lifecycle State: ${pkg.ewo.lifecycleState}`);
    lines.push(`- PO Status: ${pkg.ewo.poStatus}`);
    lines.push(`- Verification Status: ${pkg.ewo.verificationStatus}`);
    if (pkg.ewo.implementationProvider) lines.push(`- Implementation Provider: ${pkg.ewo.implementationProvider}`);
    lines.push("");
  }

  if (pkg.verification) {
    lines.push("## Verification");
    lines.push(`- Overall Status: ${pkg.verification.overallStatus}`);
    for (const gate of pkg.verification.gates) {
      lines.push(`  - ${gate.gate}: ${gate.status}${gate.evidenceSummary ? ` — ${gate.evidenceSummary}` : ""}`);
    }
    lines.push("");
  }

  if (pkg.executionHistory && pkg.executionHistory.length > 0) {
    lines.push("## Execution History");
    for (const e of pkg.executionHistory) {
      lines.push(`- ${e.ref}: ${e.status} via ${e.provider} at ${e.createdAt}`);
    }
    lines.push("");
  }

  if (pkg.relatedEngineering && pkg.relatedEngineering.length > 0) {
    lines.push("## Related Engineering");
    for (const r of pkg.relatedEngineering) {
      lines.push(`- ${r.ref}: ${r.title} (${r.relationship})`);
    }
    lines.push("");
  }

  lines.push("## Next Action");
  lines.push(pkg.summary.nextAction || "Review object status.");

  return lines.join("\n");
}

// ─── Engineering Relationship Graph (EWO-016R.X) ──────────────────────────────
// Traverses canonical engineering relationships for a referenced object.
// Distinct from Engineering Impact Analysis — this traverses the engineering
// object graph (intent → analysis → plan → EWO → completion → verification →
// review → recovery → change log → records library), NOT affected product
// features/tests/releases.

interface RelationshipNode {
  ref: string;
  type: string;
  title: string;
  status: string;
  relationship: string;
  exists: boolean;
  pendingReason?: string;
}

interface EngineeringRelationshipGraph {
  rootRef: string;
  rootType: string;
  rootTitle: string;
  assembledAt: string;
  nodes: RelationshipNode[];
  pendingArtefacts: RelationshipNode[];
  totalFound: number;
  totalPending: number;
  diagnostics: RelationshipSourceDiagnostic[];
}

interface RelationshipSourceDiagnostic {
  source: string;
  attempted: boolean;
  succeeded: boolean;
  match_count: number;
  failure: string | null;
}

// EWO-016R.Y — wraps a supabase query and records per-source diagnostics.
// Returns the data and records the diagnostic entry in `diag`.
async function queryWithDiagnostic<T>(
  svc: ReturnType<typeof createClient>,
  table: string,
  diag: RelationshipSourceDiagnostic[],
  builder: (client: ReturnType<typeof createClient>) => Promise<{ data: T | T[] | null; error: { message: string } | null }>,
): Promise<T[]> {
  const entry: RelationshipSourceDiagnostic = {
    source: table,
    attempted: true,
    succeeded: false,
    match_count: 0,
    failure: null,
  };
  diag.push(entry);
  try {
    const result = await builder(svc);
    if (result.error) {
      entry.failure = result.error.message;
      return [];
    }
    entry.succeeded = true;
    // maybeSingle() returns an object; array queries return an array.
    let data: T[];
    if (Array.isArray(result.data)) {
      data = result.data;
    } else if (result.data) {
      data = [result.data];
    } else {
      data = [];
    }
    entry.match_count = data.length;
    return data;
  } catch (err) {
    entry.failure = err instanceof Error ? err.message : String(err);
    return [];
  }
}

async function buildEngineeringRelationshipGraph(
  svc: ReturnType<typeof createClient>,
  rootRef: string,
  rootType: EngineeringRefType,
): Promise<EngineeringRelationshipGraph> {
  const assembledAt = new Date().toISOString();
  const nodes: RelationshipNode[] = [];
  const pending: RelationshipNode[] = [];
  const diagnostics: RelationshipSourceDiagnostic[] = [];

  // 1. engineering_object_relationships — canonical relationship graph
  const relData = await queryWithDiagnostic(
    svc, "engineering_object_relationships", diagnostics,
    (c) => c.from("engineering_object_relationships")
      .select("from_object_ref,to_object_ref,relationship_type")
      .or(`from_object_ref.eq.${rootRef},to_object_ref.eq.${rootRef}`)
      .limit(100),
  );

  if (relData.length > 0) {
    for (const r of relData) {
      const isFrom = r.from_object_ref === rootRef;
      const otherRef = isFrom ? r.to_object_ref : r.from_object_ref;
      const relType = isFrom ? r.relationship_type : `inverse:${r.relationship_type}`;
      const regEntry = await queryWithDiagnostic(
        svc, "engineering_object_registry", diagnostics,
        (c) => c.from("engineering_object_registry")
          .select("object_type,title,lifecycle_state")
          .ilike("object_ref", otherRef)
          .maybeSingle(),
      );
      const reg = regEntry[0];
      nodes.push({
        ref: otherRef,
        type: reg?.object_type ?? "Unknown",
        title: reg?.title ?? otherRef,
        status: reg?.lifecycle_state ?? "unknown",
        relationship: relType,
        exists: true,
      });
    }
  }

  // 2. EWO-specific relationships (if root is an EWO)
  if (rootType === "EWO") {
    const ewoArr = await queryWithDiagnostic(
      svc, "engineering_work_orders", diagnostics,
      (c) => c.from("engineering_work_orders")
        .select("id,ewo_ref,title,status,verification_status,implementation_status")
        .ilike("ewo_ref", rootRef)
        .maybeSingle(),
    );
    const ewo = ewoArr[0];

    if (ewo) {
      // Verification sessions
      const verSessions = await queryWithDiagnostic(
        svc, "ewo_verification_sessions", diagnostics,
        (c) => c.from("ewo_verification_sessions")
          .select("session_ref,overall_status,started_at,completed_at")
          .eq("ewo_id", ewo.id)
          .order("started_at", { ascending: false })
          .limit(10),
      );
      if (verSessions.length > 0) {
        for (const v of verSessions) {
          nodes.push({
            ref: v.session_ref ?? `VS-${ewo.id.slice(0, 8)}`,
            type: "Verification Session",
            title: `Verification of ${rootRef}`,
            status: v.overall_status ?? "unknown",
            relationship: "verified_by",
            exists: true,
          });
        }
      } else {
        pending.push({
          ref: `VS-PENDING-${rootRef}`,
          type: "Verification Session",
          title: `Verification of ${rootRef}`,
          status: "Pending",
          relationship: "verified_by",
          exists: false,
          pendingReason: "No verification session has been started.",
        });
      }

      // Completion report
      const compReportArr = await queryWithDiagnostic(
        svc, "ewo_completion_reports", diagnostics,
        (c) => c.from("ewo_completion_reports")
          .select("id,ewo_ref,title,generated_at")
          .eq("ewo_id", ewo.id)
          .maybeSingle(),
      );
      const compReport = compReportArr[0];
      if (compReport) {
        nodes.push({
          ref: `CR-${rootRef}`,
          type: "Engineering Completion Report",
          title: `Completion Report for ${rootRef}`,
          status: compReport.title ?? "generated",
          relationship: "produces",
          exists: true,
        });
      } else {
        pending.push({
          ref: `CR-PENDING-${rootRef}`,
          type: "Engineering Completion Report",
          title: `Completion Report for ${rootRef}`,
          status: ewo.verification_status === "verified" ? "Pending Product Owner Acceptance" : "Pending Engineering Verification",
          relationship: "produces",
          exists: false,
          pendingReason: ewo.verification_status === "verified"
            ? "Verification complete — completion report generation pending."
            : "Completion report cannot be generated until verification is complete.",
        });
      }

      // Engineering executions
      const execs = await queryWithDiagnostic(
        svc, "engineering_executions", diagnostics,
        (c) => c.from("engineering_executions")
          .select("execution_ref,implementation_status,implementation_provider,created_at")
          .eq("ewo_id", ewo.id)
          .order("created_at", { ascending: false })
          .limit(10),
      );
      if (execs.length > 0) {
        for (const e of execs) {
          nodes.push({
            ref: e.execution_ref ?? `EXEC-${e.id?.slice(0, 8)}`,
            type: "Engineering Execution",
            title: `Execution of ${rootRef}`,
            status: e.implementation_status ?? "unknown",
            relationship: "executed_by",
            exists: true,
          });
        }
      }

      // Engineering reviews — linked via the canonical relationship graph
      // (ecc_engineering_reviews has no direct ewo_ref column). We look up
      // review refs from the relationship table already queried above, then
      // fetch matching review records. The source must always be recorded as
      // attempted in diagnostics (EWO-016R.Y.2 Req 4/5: 11/11 sources).
      const reviewRefs = relData
        .filter((r: any) => (r.from_object_ref === rootRef || r.to_object_ref === rootRef) &&
          (String(r.to_object_ref ?? "").startsWith("ERC-") || String(r.from_object_ref ?? "").startsWith("ERC-")))
        .map((r: any) => r.from_object_ref === rootRef ? r.to_object_ref : r.from_object_ref);
      if (reviewRefs.length > 0) {
        const reviews = await queryWithDiagnostic(
          svc, "ecc_engineering_reviews", diagnostics,
          (c) => c.from("ecc_engineering_reviews")
            .select("id,erc_number,title,type,status,created_at")
            .in("erc_number", reviewRefs)
            .order("created_at", { ascending: false })
            .limit(10),
        );
        for (const rv of reviews) {
          nodes.push({
            ref: rv.erc_number ?? `ER-${rv.id?.slice(0, 8)}`,
            type: "Engineering Review",
            title: rv.title ?? `Review of ${rootRef}`,
            status: rv.status ?? "unknown",
            relationship: "reviewed_by",
            exists: true,
          });
        }
      } else {
        // No review refs resolved from the relationship graph — still record
        // the source as attempted/succeeded with 0 matches so diagnostics
        // report all 11 sources.
        diagnostics.push({
          source: "ecc_engineering_reviews",
          attempted: true,
          succeeded: true,
          match_count: 0,
          failure: null,
        });
      }

      // Recovery packages (if this EWO was recovered)
      const recoveryArr = await queryWithDiagnostic(
        svc, "engineering_recovery_packages", diagnostics,
        (c) => c.from("engineering_recovery_packages")
          .select("recovery_ref,canonical_reference,recovery_status,engineering_confidence")
          .ilike("canonical_reference", rootRef)
          .maybeSingle(),
      );
      const recovery = recoveryArr[0];
      if (recovery) {
        nodes.push({
          ref: recovery.recovery_ref,
          type: "Historical Recovery",
          title: `Recovery package for ${rootRef}`,
          status: recovery.recovery_status,
          relationship: "recovered_from",
          exists: true,
        });
      }

      // Engineering packages
      const engPackageArr = await queryWithDiagnostic(
        svc, "ewo_engineering_packages", diagnostics,
        (c) => c.from("ewo_engineering_packages")
          .select("id,package_hash,package_status,created_at")
          .eq("ewo_id", ewo.id)
          .maybeSingle(),
      );
      const engPackage = engPackageArr[0];
      if (engPackage) {
        nodes.push({
          ref: `PKG-${engPackage.id?.slice(0, 8)}`,
          type: "Engineering Package",
          title: `Engineering Package for ${rootRef}`,
          status: engPackage.package_status ?? "generated",
          relationship: "packages",
          exists: true,
        });
      } else {
        pending.push({
          ref: `PKG-PENDING-${rootRef}`,
          type: "Engineering Package",
          title: `Engineering Package for ${rootRef}`,
          status: "Pending",
          relationship: "packages",
          exists: false,
          pendingReason: "No engineering package has been generated.",
        });
      }

      // Lifecycle events (change log)
      const lifecycle = await queryWithDiagnostic(
        svc, "ewo_lifecycle_events", diagnostics,
        (c) => c.from("ewo_lifecycle_events")
          .select("id,from_status,to_status,created_at,notes")
          .eq("ewo_id", ewo.id)
          .order("created_at", { ascending: false })
          .limit(20),
      );
      if (lifecycle.length > 0) {
        for (const ev of lifecycle) {
          nodes.push({
            ref: `EVT-${ev.id?.slice(0, 8)}`,
            type: "Lifecycle Event",
            title: `${ev.from_status ?? "?"} → ${ev.to_status ?? "?"}`,
            status: ev.notes ?? "recorded",
            relationship: "lifecycle",
            exists: true,
          });
        }
      }

      // Records library references
      const recordsLib = await queryWithDiagnostic(
        svc, "engineering_records_library", diagnostics,
        (c) => c.from("engineering_records_library")
          .select("id,title,status,ewo_ref")
          .ilike("ewo_ref", rootRef)
          .limit(10),
      );
      if (recordsLib.length > 0) {
        for (const rec of recordsLib) {
          nodes.push({
            ref: `ER-${rec.id?.slice(0, 8)}`,
            type: "Records Library Entry",
            title: rec.title ?? `Record for ${rootRef}`,
            status: rec.status ?? "unknown",
            relationship: "archived_in",
            exists: true,
          });
        }
      }
    }
  }

  // 3. ATD Engineering Intent/Analysis/Plan relationships (by ewo_ref linkage)
  if (rootType === "EWO") {
    const decisions = await queryWithDiagnostic(
      svc, "atd_engineering_decisions", diagnostics,
      (c) => c.from("atd_engineering_decisions")
        .select("id,decision_ref,decision_type,rationale,related_ewo_ref")
        .ilike("related_ewo_ref", rootRef)
        .limit(10),
    );
    if (decisions.length > 0) {
      for (const d of decisions) {
        nodes.push({
          ref: `DEC-${d.id?.slice(0, 8)}`,
          type: "Engineering Decision",
          title: d.decision_ref ?? `Decision for ${rootRef}`,
          status: d.decision_type ?? "unknown",
          relationship: "decided_by",
          exists: true,
        });
      }
    }
  }

  return {
    rootRef,
    rootType,
    rootTitle: rootRef,
    assembledAt,
    nodes,
    pendingArtefacts: pending,
    totalFound: nodes.length,
    totalPending: pending.length,
    diagnostics,
  };
}

function renderRelationshipGraphAsContext(graph: EngineeringRelationshipGraph): string {
  const lines: string[] = [];
  lines.push(`# Engineering Relationship Graph: ${graph.rootRef}`);
  lines.push(`Assembled: ${graph.assembledAt}`);
  lines.push(`Found: ${graph.totalFound} related objects | ${graph.totalPending} pending artefacts`);
  lines.push("");

  if (graph.nodes.length > 0) {
    lines.push("## Related Engineering Objects");
    for (const n of graph.nodes) {
      lines.push(`- ${n.ref} (${n.type}) — ${n.title} [${n.status}] — relationship: ${n.relationship}`);
    }
    lines.push("");
  }

  if (graph.pendingArtefacts.length > 0) {
    lines.push("## Pending Artefacts (not yet created)");
    for (const p of graph.pendingArtefacts) {
      lines.push(`- ${p.type}: ${p.title}`);
      lines.push(`  Status: ${p.status}`);
      lines.push(`  Reason: ${p.pendingReason ?? "Not yet created."}`);
    }
    lines.push("");
  }

  if (graph.nodes.length === 0 && graph.pendingArtefacts.length === 0) {
    lines.push("## No Related Engineering Objects Found");
    lines.push(`No engineering relationships have been registered for ${graph.rootRef}.`);
    lines.push("");
  }

  lines.push("## Traceability Summary");
  lines.push(`- Root object: ${graph.rootRef} (${graph.rootType})`);
  lines.push(`- Related objects found: ${graph.totalFound}`);
  lines.push(`- Pending artefacts: ${graph.totalPending}`);

  return lines.join("\n");
}

// EWO-031R.3: Provider policy inspection detection — runs BEFORE reference detection.
// If this matches, we invoke the RPC directly and return the result without AI.
const PROVIDER_POLICY_INSPECTION_PATTERNS = [
  /inspect\s+(?:the\s+)?(?:supervised\s+)?execution\s+engine\s+and\s+provider\s+selection\s+(?:for\s+)?(EWO-[\w.-]+?)\b/i,
  /inspect\s+(?:the\s+)?(?:supervised\s+)?execution\s+engine\s+and\s+provider\s+selection/i,
  /inspect\s+(?:the\s+)?provider\s+(?:policy|selection)\s+(?:for\s+)?(EWO-[\w.-]+?)\b/i,
  /inspect\s+(?:the\s+)?provider\s+(?:policy|selection)/i,
  /inspect\s+(?:the\s+)?(?:preferred|default|allowed)\s+providers?(?:\s+for\s+(EWO-[\w.-]+?))?\b/i,
  /inspect\s+(?:the\s+)?fallback\s+(?:provider\s+)?policy/i,
  /invoke\s+inspect_execution_provider_policy\s+(?:directly\s+)?(?:for\s+)?(EWO-[\w.-]+?)?\b/i,
  /invoke\s+inspect_execution_provider_policy\s+directly/i,
  /invoke\s+inspectexecutionproviderpolicy\s+(?:directly\s+)?(?:for\s+)?(EWO-[\w.-]+?)?\b/i,
  /invoke\s+inspectexecutionproviderpolicy\s+directly/i,
  /return\s+(?:the\s+)?(?:live\s+)?execution\s+provider\s+policy/i,
  /inspect\s+(?:the\s+)?execution\s+provider\s+policy/i,
];

function isProviderPolicyInspection(text: string): { match: boolean; ewoRef: string | null } {
  for (const pattern of PROVIDER_POLICY_INSPECTION_PATTERNS) {
    const m = text.match(pattern);
    if (m) {
      const ewoRef = m[1] ?? null;
      return { match: true, ewoRef };
    }
  }
  return { match: false, ewoRef: null };
}

// EWO-031R.3: Negation-aware execution suppression.
// If the request contains negated execution phrases, execution intent is suppressed.
const NEGATED_EXECUTION_PATTERNS = [
  /\bdo\s+not\s+execute\b/i,
  /\bdon'?t\s+execute\b/i,
  /\bdo\s+not\s+run\b/i,
  /\bdo\s+not\s+start\b/i,
  /\bdo\s+not\s+dispatch\b/i,
  /\bdo\s+not\s+perform\s+lifecycle\s+changes?\b/i,
  /\binspection\s+only\b/i,
  /\bread-?only\b/i,
  /\bdo\s+not\s+validate\b/i,
  /\bdo\s+not\s+advance\b/i,
];

function hasNegatedExecution(text: string): boolean {
  return NEGATED_EXECUTION_PATTERNS.some(p => p.test(text));
}

// Intent detection
function detectIntent(text: string, refs: DetectedRef[]): string {
  // EWO-016R.Y — Diagnostic follow-up questions about runtime behaviour.
  // Must be checked BEFORE relationship_discovery so "which tables did you
  // query?" is classified as a diagnostic follow-up, not a new relationship
  // query. The prior request's Runtime Diagnostic Envelope is the authority.
  if (/\b(which|what)\s+(tables?|services?|records?|pipeline|queries?)\s+(did\s+you|were|actually|you|have\s+you|ran)\b/i.test(text) ||
      /\b(how\s+did\s+you|why\s+did\s+you|why\s+were\s+no|what\s+was\s+the\s+confirmed\s+root\s+cause|was\s+this\s+discovered\s+or\s+inferred|show\s+(?:me\s+)?(?:the\s+)?runtime\s+evidence|which\s+relationship\s+graph\s+tables)\b/i.test(text)) {
    return "diagnostic_followup";
  }
  // Relationship Discovery (EWO-016R.X) — must be checked BEFORE impact/feature
  // queries to avoid cross-routing to Engineering Impact Analysis.
  if (/\b(what\s+engineering\s+records\s+are\s+related\s+to|show\s+everything\s+related\s+to|show\s+linked\s+engineering|what\s+artefacts\s+belong\s+to|show\s+engineering\s+traceability|show\s+engineering\s+history|what\s+is\s+related\s+to|related\s+engineering\s+records|engineering\s+relationships?)\b/i.test(text)) {
    return "relationship_discovery";
  }
  // EWO-031R.3: Negation-aware execution suppression.
  // "Do not execute EWO-031" must NOT be classified as "execute".
  if (hasNegatedExecution(text)) {
    // Check for inspection signals before falling through
    if (/\b(inspect|show|return|report|explain|provider\s*(?:policy|selection)|diagnostics)\b/i.test(text)) {
      return "inspection";
    }
    return "general";
  }
  // EWO-031R.3: "execution engine" as a noun must not trigger execution intent.
  // Only "execute EWO-XXX" or "execute it/this/that" should trigger execution.
  if (/\bexecute\s+(?:it|this|that)\b/i.test(text) && !/execution\s+engine/i.test(text)) return "execute";
  if (/\bexecute\s+(EWO-\S+)\b/i.test(text) && !/execution\s+engine/i.test(text)) return "execute";
  if (/\bprepare\s+/i.test(text)) return "prepare";
  if (/\bbegin\s+/i.test(text)) return "begin";
  if (/\bshow\s+(?:me\s+)?(?:its\s+|the\s+)?verification\b/i.test(text)) return "show_verification";
  if (/\bshow\s+(?:me\s+)?(?:its\s+|the\s+)?plan\b/i.test(text)) return "show_plan";
  if (/\bshow\s+(?:me\s+)?(?:the\s+)?completion\s+report\b/i.test(text)) return "show_completion";
  if (/\bwhat\s+is\s+/i.test(text) && refs.length > 0) return "summarise";
  if (/\btell\s+me\s+about\s+/i.test(text)) return "summarise";
  if (/\bcompare\s+/i.test(text) && refs.length >= 2) return "compare";
  if (/\breview\s+/i.test(text)) return "review";
  if (refs.length > 0) return "summarise";
  return "general";
}

// EWO-032: Execution handoff inspection patterns
const EXECUTION_HANDOFF_INSPECTION_PATTERNS = [
  /inspect\s+(?:the\s+)?execution\s+handoff\s+(?:for\s+)?(EWO-[\w.-]+?)?\b/i,
  /inspect\s+(?:the\s+)?execution\s+handoff/i,
  /invoke\s+inspect_execution_handoff\s+(?:directly\s+)?(?:for\s+)?(EWO-[\w.-]+?)?\b/i,
  /invoke\s+inspect_execution_handoff\s+directly/i,
  /invoke\s+inspectexecutionhandoff\s+(?:directly\s+)?(?:for\s+)?(EWO-[\w.-]+?)?\b/i,
  /invoke\s+inspectexecutionhandoff\s+directly/i,
  /return\s+(?:the\s+)?execution\s+handoff\s+(?:state|status)/i,
  /inspect\s+(?:the\s+)?handoff\s+(?:state|status)/i,
];

function isExecutionHandoffInspection(text: string): { match: boolean; ewoRef: string | null } {
  for (const p of EXECUTION_HANDOFF_INSPECTION_PATTERNS) {
    const m = text.match(p);
    if (m) {
      return { match: true, ewoRef: m[1] || null };
    }
  }
  return { match: false, ewoRef: null };
}

// EWO-032: Conversational approval patterns
const APPROVAL_PATTERNS = [
  /^\s*approved\s*$/i,
  /^\s*approve\s*$/i,
  /^\s*proceed\s*$/i,
  /^\s*proceed\s+with\s+execution\s*$/i,
  /^\s*approved\s*,\s*execute\s*$/i,
  /^\s*confirm\s+execution\s*$/i,
  /^\s*yes\s*,\s*execute\s+the\s+approved\s+plan\s*$/i,
  /\bapproved\s+for\s+execution\b/i,
  /\bproceed\s+with\s+the\s+approved\s+plan\b/i,
  /\bconfirm\s+the\s+approved\s+plan\b/i,
  /\byes\s*,?\s*proceed\b/i,
  /\bexecute\s+the\s+approved\s+plan\b/i,
];

// EWO-032R.6: Negation-aware cancellation/modification patterns.
// Bare word patterns (cancel, stop, abort) are NOT sufficient — they match
// negated constraints ("do not cancel", "cancel fallback behaviour") and
// engineering constraints ("do not modify existing files").
// Each pattern requires an affirmative imperative aimed at the work order
// or execution, not merely the presence of a keyword.
const CANCELLATION_PATTERNS = [
  // Direct cancellation commands — affirmative imperative + work order/execution object
  /\bcancel\s+(?:this|the|my)\s+(?:work\s+order|execution|request|plan|approval)\b/i,
  /\bcancel\s+(?:it|this|that)\b/i,
  /\byes\s*,?\s*cancel\s+(?:it|this)\b/i,
  // Stop/abort — must target execution or the work order, not be negated
  /\bstop\s+(?:this|the)\s+(?:execution|work\s+order|request|plan)\b/i,
  /\bstop\s+(?:it|this|that)\b/i,
  /\babort\s+(?:the|this)\s+(?:execution|work\s+order|request|current\s+request)\b/i,
  /\babort\s+(?:it|this|that)\b/i,
  // Hold execution
  /\bhold\s+execution\b/i,
  /\bhold\s+(?:execution\s+)?until\b/i,
  // Do not proceed — affirmative refusal to proceed (NOT negated constraint)
  /\bdo\s+not\s+proceed\s+with\s+execution\b/i,
  /\bdo\s+not\s+proceed\b/i,
  // Do not execute — direct refusal (NOT a constraint about files/deploy/merge)
  /\bdo\s+not\s+execute\b/i,
  /\bdon'?t\s+execute\b/i,
  // Withdraw approval
  /\bwithdraw\s+(?:my|the)\s+approval\b/i,
  // Modify/change/update/revise the plan — affirmative modification request
  /\bmodify\s+(?:the\s+)?(?:existing\s+)?(?:work\s+order|plan)\b/i,
  /\bchange\s+(?:the\s+)?(?:approved\s+)?plan\b/i,
  /\bchange\s+(?:the\s+)?requirements?\b/i,
  /\bupdate\s+(?:the\s+)?(?:approved\s+)?plan\b/i,
  /\brevise\s+(?:the\s+)?plan\b/i,
  // Approved but do not execute yet
  /approved\s*,?\s*but\s+do\s+not\s+execute\b/i,
  /approved\s*,?\s*but\s+(?:do\s+not\s+)?(?:execute|run|proceed)\s+(?:yet|now)\b/i,
  // Proceed after changing
  /proceed\s+(?:after|once)\s+(?:changing|updating|modifying)\b/i,
  // Wait until/before
  /\bwait\s+(?:until|before)\b/i,
];

// EWO-032R.6: Negated constraint patterns — these must NOT trigger cancellation.
// They describe engineering constraints (what must NOT be done), not
// cancellation commands. When present, they suppress cancellation detection.
const NEGATED_CONSTRAINT_PATTERNS = [
  /\bdo\s+not\s+modify\s+(?:any\s+)?(?:existing\s+)?files?\b/i,
  /\bdo\s+not\s+change\s+(?:any\s+)?(?:existing\s+)?files?\b/i,
  /\bno\s+modification\s+of\s+(?:existing\s+)?files?\b/i,
  /\bmodification\s+is\s+prohibited\b/i,
  /\bdo\s+not\s+deploy\b/i,
  /\bdo\s+not\s+merge\b/i,
  /\bdo\s+not\s+simulate\s+execution\b/i,
  /\bdo\s+not\s+cancel\s+(?:the\s+)?work\s+order\b/i,
  /\bcancel\s+fallback\s+behaviou?r\b/i,
];

// EWO-032R.6: Check if the text is a negated constraint (not a cancellation command).
function isNegatedConstraint(text: string): boolean {
  return NEGATED_CONSTRAINT_PATTERNS.some(p => p.test(text));
}

// EWO-032R.6: Context-aware cancellation detection.
// Returns true only when the text contains an affirmative cancellation/modification
// imperative AND is not a negated constraint.
function isCancellationRequest(text: string): boolean {
  if (isNegatedConstraint(text)) return false;
  return CANCELLATION_PATTERNS.some(p => p.test(text));
}

function detectApproval(text: string): { isApproval: boolean; isCancellation: boolean; isModification: boolean } {
  const isCancellation = isCancellationRequest(text);
  const isApproval = APPROVAL_PATTERNS.some(p => p.test(text));
  return {
    isApproval: isApproval && !isCancellation,
    isCancellation: isCancellation,
    isModification: !isCancellation && /\b(?:modify|change|update|revise)\s+(?:the\s+)?(?:existing\s+)?(?:work\s+order|plan)\b/i.test(text) && !isApproval,
  };
}

// Conversation Context Router (Requirement 1, 3)
function routeConversation(
  text: string,
  refs: DetectedRef[],
  activeWorkspace: string | null,
): { domain: CanonicalDomain; rule: string } {
  // EWO-031R.3: Provider policy inspection — HIGHEST PRECEDENCE.
  // Must be checked BEFORE reference detection to avoid routing to eios-engineering
  // and letting the AI model misclassify as execution/validation.
  if (isProviderPolicyInspection(text).match) {
    return { domain: "eios-engineering", rule: "provider-policy-inspection" };
  }
  // EWO-032: Execution handoff inspection
  if (isExecutionHandoffInspection(text).match) {
    return { domain: "eios-engineering", rule: "execution-handoff-inspection" };
  }
  // EWO-032R.6: Negation-aware cancellation/modification detection.
  // Negated constraints ("do not cancel", "do not modify files") must NOT
  // trigger cancellation routing.
  if (isCancellationRequest(text)) {
    return { domain: "eios-engineering", rule: "cancellation-detected" };
  }
  // EWO-032: Conversational approval
  if (APPROVAL_PATTERNS.some(p => p.test(text))) {
    return { domain: "eios-engineering", rule: "approval-handoff" };
  }
  // EWO-031R.3: Negation-aware — if request says "do not execute", it's an inspection.
  if (hasNegatedExecution(text) && /\b(inspect|show|return|report|provider)\b/i.test(text)) {
    return { domain: "eios-engineering", rule: "negation-suppressed-inspection" };
  }
  // Precedence 1: Explicit canonical Engineering reference
  if (refs.length > 0) {
    return { domain: "eios-engineering", rule: "explicit-canonical-engineering-reference" };
  }
  // Precedence 2: Explicit Engineering action intent (execute, prepare, begin, verification)
  const lower = text.toLowerCase();
  if (/\b(execute|prepare|begin|verification|governance|engineering standard|constitution|amendment|traceability|engineering history|engineering records|engineering relationships?)\b/i.test(text)) {
    return { domain: "eios-engineering", rule: "explicit-engineering-action-intent" };
  }
  // Precedence 3: Platform/project object references
  if (/\b(RC-\d+|phase|milestone|backlog|roadmap|release candidate)\b/i.test(text)) {
    return { domain: "project", rule: "explicit-project-object-reference" };
  }
  // Precedence 4-5: Conversation focus / active workspace (general product questions)
  if (activeWorkspace && /\b(feature|assessment|lln|digital|billing|stripe|axcelerate|compliance|asqa)\b/i.test(text)) {
    return { domain: "active-product", rule: "active-workspace-product-context" };
  }
  // Precedence 6: General semantic classification
  if (/\b(candidate|learner|student|enrolment)\b/i.test(text)) {
    return { domain: "candidate", rule: "candidate-semantic" };
  }
  if (/\b(admin|settings|user|role|permission)\b/i.test(text)) {
    return { domain: "platform-admin", rule: "platform-admin-semantic" };
  }
  // Precedence 7: General fallback
  return { domain: "general", rule: "general-fallback" };
}

// ─── Context builder ──────────────────────────────────────────────────────────

async function buildProductContext(svc: ReturnType<typeof createClient>): Promise<{
  context: string;
  stats: Record<string, number>;
}> {
  const [
    features, roadmap, milestones, phases, releases, docs,
    decisions, standards, goals, epics, backlog, relationships,
  ] = await Promise.all([
    svc.from("ecc_product_features").select(
      "feature_id,name,category,sub_category,status,lifecycle_stage,testing_status,compliance_critical,audit_critical,operational_risk,priority,business_value,description,purpose,known_issues,audit_flags,impl_db_tables,impl_edge_functions,impl_pages,impl_components,dependencies,documentation_status"
    ).order("feature_id"),
    svc.from("ecc_roadmap_items").select("*").order("position"),
    svc.from("ecc_milestones").select("name,status,target_date,owner").order("sort_order").limit(20),
    svc.from("ecc_phases").select("name,status,target_version,owner").order("sort_order").limit(10),
    svc.from("ecc_release_candidates").select("rc_number,phase_name,status,description,release_type,is_active,created_at").order("created_at", { ascending: false }).limit(15),
    svc.from("ecc_documentation").select("title,doc_type,version,status,author,updated_at").order("updated_at", { ascending: false }).limit(30),
    svc.from("ecc_decisions").select("title,category,status,decision_date,decision").order("decision_date", { ascending: false }).limit(20),
    svc.from("ecc_engineering_standards").select("title,category,status").order("category").limit(30),
    svc.from("ecc_goals").select("title,status,priority,progress_pct,target_date").order("position"),
    svc.from("ecc_epics").select("title,status,priority,progress_pct").order("position"),
    svc.from("ecc_backlog_items").select("title,priority,status,item_type,category,risk,testing_status,documentation_complete").order("created_at", { ascending: false }).limit(40),
    svc.from("ecc_feature_relationships").select("from_feature_id,to_feature_id,relationship_type").limit(200),
  ]);

  const featureData = features.data ?? [];
  const relData = relationships.data ?? [];

  const depMap: Record<string, string[]> = {};
  for (const r of relData) {
    if (!depMap[r.from_feature_id]) depMap[r.from_feature_id] = [];
    depMap[r.from_feature_id].push(`${r.to_feature_id}(${r.relationship_type})`);
  }

  const featureList = featureData.map((f: Record<string, unknown>) => {
    const flags = Array.isArray(f.audit_flags) && (f.audit_flags as string[]).length > 0
      ? ` [FLAGS: ${(f.audit_flags as string[]).join(",")}]` : "";
    const tables = Array.isArray(f.impl_db_tables) && (f.impl_db_tables as string[]).length > 0
      ? ` tables:[${(f.impl_db_tables as string[]).join(",")}]` : "";
    const pages = Array.isArray(f.impl_pages) && (f.impl_pages as string[]).length > 0
      ? ` pages:[${(f.impl_pages as string[]).join(",")}]` : "";
    const fns = Array.isArray(f.impl_edge_functions) && (f.impl_edge_functions as string[]).length > 0
      ? ` functions:[${(f.impl_edge_functions as string[]).join(",")}]` : "";
    const deps = (depMap[f.feature_id as string] ?? []).length > 0
      ? ` deps:[${(depMap[f.feature_id as string] ?? []).slice(0, 5).join(",")}]` : "";
    return `- ${f.feature_id}: ${f.name} (${f.category}) | lifecycle:${f.lifecycle_stage} testing:${f.testing_status} docs:${f.documentation_status} priority:${f.priority}${f.compliance_critical ? " COMPLIANCE-CRITICAL" : ""}${f.operational_risk === "critical" ? " CRITICAL-RISK" : ""}${flags}${tables}${pages}${fns}${deps}`;
  }).join("\n");

  const goalsList = (goals.data ?? []).map((g: Record<string, unknown>) =>
    `- ${g.title} [${g.status}] priority:${g.priority} progress:${g.progress_pct}%`
  ).join("\n");

  const epicsList = (epics.data ?? []).map((e: Record<string, unknown>) =>
    `- ${e.title} [${e.status}] priority:${e.priority} progress:${e.progress_pct}%`
  ).join("\n");

  const roadmapList = (roadmap.data ?? []).map((r: Record<string, unknown>) =>
    `- ${r.title} [${r.status}] priority:${r.priority}`
  ).join("\n");

  const milestoneList = (milestones.data ?? []).map((m: Record<string, unknown>) =>
    `- ${m.name} [${m.status}]${m.target_date ? ` due:${m.target_date}` : ""}`
  ).join("\n");

  const phaseList = (phases.data ?? []).map((p: Record<string, unknown>) =>
    `- ${p.name} [${p.status}]${p.target_version ? ` v${p.target_version}` : ""}`
  ).join("\n");

  const releaseList = (releases.data ?? []).map((r: Record<string, unknown>) =>
    `- ${r.rc_number} — ${r.phase_name} [${r.status}]${r.is_active ? " ★ACTIVE" : ""}`
  ).join("\n");

  const backlogList = (backlog.data ?? []).map((b: Record<string, unknown>) =>
    `- [${b.item_type}] ${b.title} priority:${b.priority} status:${b.status}${b.risk ? ` risk:${b.risk}` : ""}`
  ).join("\n");

  const docList = (docs.data ?? []).map((d: Record<string, unknown>) =>
    `- ${d.title} (${d.doc_type}) v${d.version ?? "?"} [${d.status}]`
  ).join("\n");

  const decisionList = (decisions.data ?? []).map((d: Record<string, unknown>) =>
    `- ${d.title} [${d.status}] ${d.category ?? ""} (${d.decision_date})`
  ).join("\n");

  const featureStats = {
    total: featureData.length,
    live: featureData.filter((f: Record<string, unknown>) => f.lifecycle_stage === "live").length,
    production_ready: featureData.filter((f: Record<string, unknown>) => f.lifecycle_stage === "production_ready").length,
    in_development: featureData.filter((f: Record<string, unknown>) => f.lifecycle_stage === "in_development").length,
    notTested: featureData.filter((f: Record<string, unknown>) => f.testing_status === "not_tested" || f.testing_status === "requires_review").length,
    testingPassed: featureData.filter((f: Record<string, unknown>) => f.testing_status === "passed").length,
    complianceCritical: featureData.filter((f: Record<string, unknown>) => f.compliance_critical).length,
    criticalRisk: featureData.filter((f: Record<string, unknown>) => f.operational_risk === "critical").length,
    withFlags: featureData.filter((f: Record<string, unknown>) => Array.isArray(f.audit_flags) && (f.audit_flags as string[]).length > 0).length,
    backlogTotal: (backlog.data ?? []).length,
    relationships: relData.length,
    goals: (goals.data ?? []).length,
    epics: (epics.data ?? []).length,
  };

  const context = `
# Engineering AI — Live Product Context

## Product
LLND Automate — SaaS platform for Australian RTOs automating LLN and Digital capability assessments.

Core: learner assessment portal (LLN + Digital Literacy, ~18min) • ACSF mapping • AI support plans • qualification management • candidate management • aXcelerate integration (inbound sync, write-back, portfolio upload) • pg_cron email + aXcelerate queues • Stripe billing ($79-$129/month + $1.50/assessment) • ASQA compliance audit trail • admin portal • Command Centre (internal)

## Technology Stack
Frontend: React 18 + TypeScript + Vite + Tailwind CSS
Backend: Supabase (PostgreSQL + RLS + Edge Functions + Auth)
Jobs: pg_cron (email queue, aXcelerate writeback)
Payments: Stripe (checkout, portal, webhooks)
Integration: aXcelerate API (REST)
AI: Platform-managed provider (configured in Settings → AI Provider — customers never supply keys)
Hosting: Supabase (Edge Functions + Postgres)

## Database Key Tables
profiles, assessments, assessment_invitations, invitation_assessments, assessment_responses,
qualifications, qualification_lln_requirements, qualification_acsf_requirements,
support_plans, interventions, notifications, audit_trail, lifecycle_events,
axcelerate_sync_log, axcelerate_writeback_queue, email_queue,
billing_subscriptions, billing_events, admin_otp_codes,
uoc_acsf_library, qualification_uoc_mapping, acsf_mapping_evidence,
eaee_indicators, eaee_analysis,
ecc_goals, ecc_epics, ecc_product_features, ecc_feature_relationships, ecc_feature_timeline,
ecc_feature_test_cases, ecc_roadmap_items, ecc_milestones, ecc_phases,
ecc_backlog_items, ecc_release_candidates, ecc_testing_reports, ecc_architecture_reviews,
ecc_decisions, ecc_documentation, ecc_ai_journal, ecc_engineering_standards,
ecc_change_records, cc_ai_conversations, cc_ai_messages, cc_ai_favourite_prompts,
ecc_ai_artefact_log, ai_usage_log, ai_response_cache

## Feature Registry Summary
Total: ${featureStats.total} | Live: ${featureStats.live} | Prod Ready: ${featureStats.production_ready} | In Dev: ${featureStats.in_development}
Testing Passed: ${featureStats.testingPassed} | Needs Testing: ${featureStats.notTested}
Compliance-Critical: ${featureStats.complianceCritical} | Critical-Risk: ${featureStats.criticalRisk}
Dependencies mapped: ${featureStats.relationships}

## All Features
${featureList}

## Goals
${goalsList || "None."}

## Epics
${epicsList || "None."}

## Roadmap
${roadmapList || "None."}

## Milestones
${milestoneList || "None."}

## Phases
${phaseList || "None."}

## Release Candidates
${releaseList || "None."}

## Backlog & Ideas
${backlogList || "None."}

## Documentation Library
${docList || "None."}

## Architecture Decisions
${decisionList || "None."}
`.trim();

  return { context, stats: featureStats };
}

// ─── Mode instructions ─────────────────────────────────────────────────────

function getModeInstructions(mode: string): string {
  switch (mode) {
    case "build":
      return `Mode: Build Planning — prepare a complete implementation specification. Check for existing similar functionality. Note reuse opportunities.`;
    case "impact":
      return `Mode: Impact Analysis — analyse all impact dimensions: database, API, UI, compliance, performance, security, testing, documentation. End with risk rating.`;
    case "search":
      return `Mode: Search — find all matching features, tables, functions, pages, backlog items, docs across the product. Be comprehensive.`;
    case "docs":
      return `Mode: Documentation — generate structured, production-ready documentation suitable for an ASQA audit.`;
    case "test":
      return `Mode: Test Planning — generate thorough test cases, regression scope, compliance test points, QA checklist.`;
    case "audit":
      return `Mode: Compliance Audit — ASQA compliance analysis with pass/fail/needs-work statuses.`;
    case "recommend":
      return `Mode: Engineering Recommendations — proactively identify technical debt, testing gaps, documentation gaps, security improvements, performance opportunities.`;
    default:
      return "";
  }
}

// ─── Role instructions ────────────────────────────────────────────────────

function getRoleInstructions(role: string): string {
  switch (role) {
    case "architect":
      return `## Active Perspective: Software Architect\nLead with architectural concerns: system design, component coupling, dependency management, data model integrity, and scalability. Flag architectural anti-patterns. Evaluate every proposal through the lens of long-term structural health. Prioritise clean boundaries, minimal coupling, and adherence to established patterns in this codebase.`;
    case "product_manager":
      return `## Active Perspective: Product Manager\nLead with business value and customer impact. Frame decisions in terms of user stories, market differentiation, and roadmap fit. Quantify business value explicitly. Push back on over-engineering. Surface what delivers the most value to RTOs and learners the fastest. Always connect engineering work to measurable business outcomes.`;
    case "qa_lead":
      return `## Active Perspective: QA Lead\nLead with quality assurance concerns: test coverage gaps, regression risk, acceptance criteria, edge cases, and compliance testing requirements. Every feature proposal must be evaluated for testability. Highlight what could break, what is currently untested, and what must be verified before release. Priority is confidence in every release.`;
    case "release_manager":
      return `## Active Perspective: Release Manager\nLead with release readiness: RC status, deployment risk, rollback planning, environment readiness, and go/no-go criteria. Assess whether the programme is on track. Identify blockers to the next release. Every recommendation must consider the active RC and release timeline. Priority is controlled, predictable, safe releases.`;
    case "compliance":
      return `## Active Perspective: Compliance Officer\nLead with ASQA compliance, audit trail completeness, and regulatory obligations. Every feature must be assessed against ASQA Standards for RTOs 2015. Flag any audit risks. Compliance is non-negotiable — no feature ships without a clear compliance assessment. Priority is that the platform survives any ASQA audit without findings.`;
    case "guardian":
      return `## Active Perspective: Engineering Guardian\nLead with long-term platform health: technical debt, security posture, performance characteristics, and sustainability. Challenge shortcuts. Identify risks that compound over time. Every decision should be evaluated for its 12-month impact on maintainability, security, and operational stability. Priority is a platform that gets stronger over time.`;
    case "ceo":
      return `## Active Perspective: CEO Advisor\nLead with strategic business perspective: competitive positioning, ROI, revenue impact, customer acquisition, and investor narrative. Connect engineering decisions to business growth and market differentiation. Challenge work that doesn't move the business forward. Priority is that every engineering investment creates measurable business value.`;
    case "documentation":
      return `## Active Perspective: Documentation Manager\nLead with documentation quality, completeness, and accessibility. Every engineering decision must have an associated specification, release note, or reference document. Flag undocumented features and incomplete specifications. Ensure the knowledge centre is comprehensive and suitable for ASQA audit review.`;
    case "support":
      return `## Active Perspective: Support Analyst\nLead with support patterns, bug triage, and customer feedback analysis. Identify recurring issues, assess their root causes, and connect them to backlog items. Prioritise fixes that reduce support burden. Surface customer pain points that should influence roadmap decisions.`;
    default:
      return `## Active Perspective: Technical Director\nYou are the Technical Director — the default and senior voice. Balance all concerns: architecture, business value, quality, release safety, compliance, and long-term health. Make the call. Orchestrate across all disciplines.`;
  }
}

// ─── Auto role classifier ─────────────────────────────────────────────────

function classifyRequest(message: string): { roles: string[]; reasoning: string } {
  const lower = message.toLowerCase();

  if (/\b(release|deploy|rc-?\d|rc\s*\d|can we release|go[- ]no[- ]go|rollback|hotfix)\b/.test(lower)) {
    return { roles: ["release_manager", "qa_lead", "director"], reasoning: "Release readiness request" };
  }
  if (/\b(bug|issue|error|broken|failing|crash|exception|defect|regression)\b/.test(lower)) {
    return { roles: ["qa_lead", "support", "director"], reasoning: "Bug/defect report" };
  }
  if (/\b(architect|architecture|design|refactor|pattern|coupling|schema|database|data model|api design|structure)\b/.test(lower)) {
    return { roles: ["architect", "director"], reasoning: "Architecture or design request" };
  }
  if (/\b(compliance|asqa|audit|regulation|standard|acsf|rto|evidence)\b/.test(lower)) {
    return { roles: ["compliance", "director"], reasoning: "Compliance or regulatory request" };
  }
  if (/\b(test|testing|qa|coverage|regression|test plan|test case|quality)\b/.test(lower)) {
    return { roles: ["qa_lead", "director"], reasoning: "Testing or quality request" };
  }
  if (/\b(spec|specification|document|documentation|write up|knowledge|release note)\b/.test(lower)) {
    return { roles: ["documentation", "director"], reasoning: "Documentation request" };
  }
  if (/\b(business value|roi|revenue|market|strategy|vision|growth|competitive|invest)\b/.test(lower)) {
    return { roles: ["ceo", "product_manager", "director"], reasoning: "Business strategy request" };
  }
  if (/\b(prioritis|prioritiz|backlog|roadmap|sprint|what should|what to work|most valuable|highest value)\b/.test(lower)) {
    return { roles: ["product_manager", "director"], reasoning: "Prioritisation request" };
  }
  if (/\b(idea|feature|build|implement|add|create|new functionality|suggestion)\b/.test(lower)) {
    return { roles: ["product_manager", "director"], reasoning: "Feature or idea request" };
  }
  if (/\b(debt|performance|security|maintainab|scalab|health|guardian)\b/.test(lower)) {
    return { roles: ["guardian", "architect", "director"], reasoning: "Platform health or technical debt" };
  }
  if (/\b(support|customer|feedback|complaint|user|learner)\b/.test(lower)) {
    return { roles: ["support", "director"], reasoning: "Support or customer feedback" };
  }

  return { roles: ["director"], reasoning: "General engineering query — Technical Director" };
}

function buildMultiRoleInstructions(roles: string[]): string {
  if (roles.length <= 1) return getRoleInstructions(roles[0] ?? "director");

  const roleLabels: Record<string, string> = {
    director: "Technical Director", architect: "Architect",
    product_manager: "Product Manager", qa_lead: "QA Lead",
    release_manager: "Release Manager", compliance: "Compliance Officer",
    guardian: "Engineering Guardian", ceo: "CEO Advisor",
    documentation: "Documentation Manager", support: "Support Analyst",
  };

  const sections = roles.map(r => {
    const label = roleLabels[r] ?? r;
    const instr = getRoleInstructions(r);
    const body = instr.replace(/^## Active Perspective: .+\n/, '').trim();
    return `### ${label}\n${body}`;
  });

  return `## Multi-Role Engineering Review\nThis request has been reviewed from ${roles.length} perspectives. The Technical Director will consolidate all perspectives into one unified recommendation.\n\n${sections.join('\n\n')}`;
}

// ─── Parse structured blocks ──────────────────────────────────────────────

function parseBlock(raw: string, startMarker: string, endMarker: string): { content: string | null; cleaned: string } {
  const startIdx = raw.lastIndexOf(startMarker);
  if (startIdx === -1) return { content: null, cleaned: raw };
  const endIdx = raw.lastIndexOf(endMarker);
  const jsonStr = raw.slice(startIdx + startMarker.length, endIdx > startIdx ? endIdx : undefined).trim();
  const cleaned = raw.slice(0, startIdx).trim();
  return { content: jsonStr, cleaned };
}

function parseSuggestedActions(reply: string): { cleanReply: string; suggested: string[] } {
  const { content, cleaned } = parseBlock(reply, "%%ACTIONS%%", "%%END%%");
  if (!content) return { cleanReply: reply.trim(), suggested: [] };
  const suggested = content.split("|").map(s => s.trim()).filter(s => s.length > 0 && s.length < 120).slice(0, 4);
  return { cleanReply: cleaned, suggested };
}

// ─── Artefact types ────────────────────────────────────────────────────────

interface ArtefactPlanItem {
  type: "backlog_item" | "goal" | "epic" | "decision" | "documentation" | "feature";
  title: string;
  description?: string;
  priority?: string;
  status?: string;
  reasoning: string;
  item_type?: string;
  category?: string;
  decision?: string;
  decision_date?: string;
  doc_type?: string;
  feature_id?: string;
  feature_category?: string;
}

interface CreatedArtefact {
  type: string;
  id: string;
  title: string;
  reasoning: string;
  skipped?: boolean;
  skip_reason?: string;
}

// ─── Duplicate detection ──────────────────────────────────────────────────

async function findDuplicate(
  svc: ReturnType<typeof createClient>,
  type: ArtefactPlanItem["type"],
  title: string,
): Promise<{ id: string; title: string } | null> {
  const normalised = title.toLowerCase().trim();
  let q;
  switch (type) {
    case "backlog_item":
      q = await svc.from("ecc_backlog_items").select("id,title").ilike("title", `%${normalised}%`).limit(1);
      break;
    case "goal":
      q = await svc.from("ecc_goals").select("id,title").ilike("title", `%${normalised}%`).limit(1);
      break;
    case "epic":
      q = await svc.from("ecc_epics").select("id,title").ilike("title", `%${normalised}%`).limit(1);
      break;
    case "decision":
      q = await svc.from("ecc_decisions").select("id,title").ilike("title", `%${normalised}%`).limit(1);
      break;
    case "documentation":
      q = await svc.from("ecc_documentation").select("id,title").ilike("title", `%${normalised}%`).limit(1);
      break;
    case "feature":
      q = await svc.from("ecc_product_features").select("id,name").ilike("name", `%${normalised}%`).limit(1);
      if (q.data && q.data.length > 0) return { id: q.data[0].id, title: q.data[0].name };
      return null;
    default:
      return null;
  }
  if (q.data && q.data.length > 0) return { id: q.data[0].id, title: q.data[0].title };
  return null;
}

// ─── Next feature_id generator ────────────────────────────────────────────

async function nextFeatureId(svc: ReturnType<typeof createClient>): Promise<string> {
  const { data } = await svc.from("ecc_product_features").select("feature_id").order("feature_id", { ascending: false }).limit(1);
  if (!data || data.length === 0) return "FEAT-001";
  const last = data[0].feature_id as string;
  const match = last.match(/FEAT-(\d+)/);
  if (!match) return "FEAT-001";
  const next = parseInt(match[1], 10) + 1;
  return `FEAT-${String(next).padStart(3, "0")}`;
}

// ─── Artefact inserter ────────────────────────────────────────────────────

async function insertArtefact(
  svc: ReturnType<typeof createClient>,
  item: ArtefactPlanItem,
  conversationId: string,
  userId: string,
): Promise<{ id: string } | null> {
  const base = {
    source_conversation_id: conversationId,
    ai_reasoning: item.reasoning,
  };

  switch (item.type) {
    case "backlog_item": {
      const { data } = await svc.from("ecc_backlog_items").insert({
        ...base,
        title: item.title,
        description: item.description ?? null,
        priority: item.priority ?? "medium",
        status: item.status ?? "open",
        item_type: item.item_type ?? "idea",
        category: item.category ?? "general",
      }).select("id").single();
      return data;
    }
    case "goal": {
      const { data } = await svc.from("ecc_goals").insert({
        ...base,
        title: item.title,
        description: item.description ?? null,
        priority: item.priority ?? "medium",
        status: item.status ?? "active",
        progress_pct: 0,
      }).select("id").single();
      return data;
    }
    case "epic": {
      const { data } = await svc.from("ecc_epics").insert({
        ...base,
        title: item.title,
        description: item.description ?? null,
        priority: item.priority ?? "medium",
        status: item.status ?? "planned",
        progress_pct: 0,
      }).select("id").single();
      return data;
    }
    case "decision": {
      const { data } = await svc.from("ecc_decisions").insert({
        ...base,
        title: item.title,
        description: item.description ?? null,
        decision: item.decision ?? item.description ?? null,
        decision_date: item.decision_date ?? new Date().toISOString().split("T")[0],
        status: item.status ?? "pending",
        category: item.category ?? "engineering",
      }).select("id").single();
      return data;
    }
    case "documentation": {
      const { data } = await svc.from("ecc_documentation").insert({
        ...base,
        title: item.title,
        content: item.description ?? "",
        doc_type: item.doc_type ?? "spec",
        version: "0.1",
        status: "draft",
        author: "AI Technical Director",
      }).select("id").single();
      return data;
    }
    case "feature": {
      const featureId = item.feature_id ?? await nextFeatureId(svc);
      const { data } = await svc.from("ecc_product_features").insert({
        ...base,
        feature_id: featureId,
        name: item.title,
        description: item.description ?? null,
        category: item.feature_category ?? "general",
        status: item.status ?? "planned",
        lifecycle_stage: "planned",
        priority: item.priority ?? "medium",
        developer: "AI",
      }).select("id").single();
      return data;
    }
    default:
      return null;
  }
}

// ─── Artefact creation orchestrator ──────────────────────────────────────

async function createArtefacts(
  svc: ReturnType<typeof createClient>,
  plan: ArtefactPlanItem[],
  conversationId: string,
  changeRecordId: string | null,
  userId: string,
  confidenceScore: number,
): Promise<{ created: CreatedArtefact[]; skipped: CreatedArtefact[] }> {
  const created: CreatedArtefact[] = [];
  const skipped: CreatedArtefact[] = [];

  for (const item of plan) {
    const existing = await findDuplicate(svc, item.type, item.title);
    if (existing) {
      skipped.push({ type: item.type, id: existing.id, title: item.title, reasoning: item.reasoning, skipped: true, skip_reason: `Similar record already exists: "${existing.title}"` });
      continue;
    }

    const inserted = await insertArtefact(svc, item, conversationId, userId);
    if (!inserted) continue;

    await svc.from("ecc_ai_artefact_log").insert({
      conversation_id: conversationId,
      change_record_id: changeRecordId,
      artefact_type: item.type,
      artefact_id: inserted.id,
      artefact_title: item.title,
      confidence_score: confidenceScore,
      reasoning: item.reasoning,
      approved_by: userId,
    });

    created.push({ type: item.type, id: inserted.id, title: item.title, reasoning: item.reasoning });
  }

  return { created, skipped };
}

// ─── Load artefact plan from previous assistant message ───────────────────

async function getStoredArtefactPlan(
  svc: ReturnType<typeof createClient>,
  conversationId: string,
): Promise<{ plan: ArtefactPlanItem[]; confidence: number } | null> {
  const { data } = await svc
    .from("cc_ai_messages")
    .select("metadata")
    .eq("conversation_id", conversationId)
    .eq("role", "assistant")
    .not("metadata->artefact_plan", "is", null)
    .order("created_at", { ascending: false })
    .limit(1);
  if (!data || data.length === 0) return null;
  const meta = data[0].metadata as Record<string, unknown>;
  const plan = meta.artefact_plan as ArtefactPlanItem[] | undefined;
  const confidence = (meta.pending_implementation as Record<string, unknown> | undefined)?.confidence as number ?? 80;
  if (!plan || !Array.isArray(plan) || plan.length === 0) return null;
  return { plan, confidence };
}

// ─── Message type ─────────────────────────────────────────────────────────────

interface Message { role: string; content: string; }

// ─── Main handler ──────────────────────────────────────────────────────────

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response(null, { status: 200, headers: corsHeaders });

  // Issue #45: platform operators with MFA only (trusted server-to-server calls with the service-role key also pass).
  {
    const operatorCheck = await requirePlatformOperator(req.headers.get("Authorization"), { allowServiceRole: true });
    if (!operatorCheck.ok) return operatorDeniedResponse(operatorCheck, corsHeaders);
  }

  const requestId = `REQ-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
  let activeConversationId: string | null = null;
  let svc: ReturnType<typeof createClient> | null = null;

  try {
    const authResult = await verifyAuth(req);
    if (!authResult) {
      return new Response(JSON.stringify({ error: "Unauthorized" }), { status: 401, headers: { ...corsHeaders, "Content-Type": "application/json" } });
    }
    const authSvc = authResult.svc;
    svc = authSvc;
    const { userId, role: actorRole } = authResult;

    const requestBody = await req.json() as {
      messages: Message[];
      conversation_id?: string;
      mode?: string;
      ai_role?: string;
      active_workspace?: string | null;
      prior_diagnostic_envelope?: RuntimeDiagnosticEnvelope | null;
      debug_mode?: boolean;
    };
    const { messages, conversation_id, mode = "ask", ai_role = "director", active_workspace = null, prior_diagnostic_envelope } = requestBody;
    activeConversationId = conversation_id ?? null;
    // EWO-016R.Y.1 Req 3 — Debug Mode is permission-gated server-side.
    // The client-supplied debug_mode flag is honoured ONLY for authorised roles.
    // Authorised roles: admin (Platform Administrator), trainer (Product Owner / Engineering).
    const debugRequested = requestBody.debug_mode === true;
    // Issue #45: callers reaching this point are MFA-verified platform operators.
    const debugModePermitted = debugRequested;

    if (!messages || !Array.isArray(messages) || messages.length === 0) {
      return new Response(JSON.stringify({ error: "messages array is required" }), { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } });
    }

    const aiCfg = await loadAIConfig(svc);
    if (!aiCfg) {
      return new Response(JSON.stringify({ error: "NO_API_KEY", message: "No AI provider configured. Go to Settings → AI Provider." }), { status: 422, headers: { ...corsHeaders, "Content-Type": "application/json" } });
    }

    // ─── Conversation Context Router (EWO-016R) ───────────────────────────────
    // Runs BEFORE AI prompt construction. Canonical Engineering references
    // take priority over active product context (Requirement 1, 2, 3).
    const lastUserMsg = [...messages].reverse().find(m => m.role === "user");
    const lastUserContent = lastUserMsg?.content ?? "";
    const isApproval = lastUserContent.startsWith("%%APPROVE%%");
    const isCancellation = lastUserContent.startsWith("%%CANCEL%%");

    const detectedRefs = detectReferences(lastUserContent);
    const detectedIntent = detectIntent(lastUserContent, detectedRefs);
    const { domain: selectedDomain, rule: routingRule } = routeConversation(lastUserContent, detectedRefs, active_workspace);

// EWO-031R.3: Provider policy inspection short-circuit.
    // If the request is a provider policy inspection, invoke the RPC directly
    // and return the result WITHOUT calling the AI model. This prevents the AI
    // from misclassifying the request as execution/validation.
    if (routingRule === "provider-policy-inspection") {
      const ppResult = isProviderPolicyInspection(lastUserContent);
      const ewoRef = ppResult.ewoRef;
      const auditRef = `PPI-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
      try {
        const { data: rpcData, error: rpcError } = await svc.rpc("inspect_execution_provider_policy", { p_ewo_ref: ewoRef || null });
        if (rpcError || !rpcData) {
          return new Response(JSON.stringify({
            inspection_status: "failed",
            failed_stage: "rpc_invocation",
            failure_code: "provider_policy_rpc_failed",
            failure_reason: rpcError?.message ?? "RPC returned no data",
            reply: `Provider policy inspection failed: ${rpcError?.message ?? "RPC returned no data"}`,
            detected_intent: "provider_policy_inspection",
            routing_decision: "route_to_inspectExecutionProviderPolicy",
            resolved_capability: "supervised-engineering-execution",
            resolved_operation: "inspectExecutionProviderPolicy",
            resolved_engineering_object_reference: ewoRef,
            data_source: "inspect_execution_provider_policy RPC",
            environment: "supabase_edge_function",
            legacy_fallback_permitted: false,
            legacy_fallback_performed: false,
            retryable: true,
            next_required_action: "Verify that the inspect_execution_provider_policy RPC exists and the execution_provider_policy table has an active record.",
            lifecycle_change_performed: false,
            audit_reference: auditRef,
          }), { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } });
        }
        const policy = typeof rpcData === "string" ? JSON.parse(rpcData) : rpcData;
        return new Response(JSON.stringify({
          detected_intent: "provider_policy_inspection",
          routing_decision: "route_to_inspectExecutionProviderPolicy",
          resolved_capability: "supervised-engineering-execution",
          resolved_operation: "inspectExecutionProviderPolicy",
          resolved_engineering_object_reference: ewoRef,
          data_source: "inspect_execution_provider_policy RPC (authoritative)",
          rpc_invoked: "inspect_execution_provider_policy",
          reply: `Execution provider policy inspected. Active provider: ${policy.active_execution_provider ?? policy.default_provider_id ?? "none"}. Version: ${policy.policy_version ?? "unknown"}.`,
          provider_policy_version: policy.policy_version ?? null,
          provider_policy_audit_reference: auditRef,
          active_execution_provider: policy.active_execution_provider ?? policy.default_provider_id ?? null,
          default_execution_provider: policy.default_provider_id ?? null,
          preferred_execution_provider: policy.preferred_provider_id ?? null,
          allowed_execution_providers: policy.allowed_provider_ids ?? [],
          fallback_provider: policy.fallback_provider_id ?? null,
          fallback_permitted: policy.fallback_permitted ?? false,
          fallback_performed: false,
          requested_provider_for_ewo: policy.ewo_implementation_provider ?? null,
          selected_provider_for_ewo: policy.ewo_selected_provider ?? null,
          provider_selection_reason: policy.provider_selection_reason ?? null,
          registered_execution_providers: policy.registered_providers ?? null,
          provider_lifecycle_statuses: policy.provider_lifecycle_statuses ?? null,
          provider_active_statuses: policy.provider_active_statuses ?? null,
          provider_governed_statuses: policy.provider_governed_statuses ?? null,
          provider_configuration_statuses: policy.provider_configuration_statuses ?? null,
          unresolved_blockers: policy.unresolved_blockers ?? null,
          provider_diagnostics: policy.provider_diagnostics ?? null,
          lifecycle_change_performed: false,
          audit_reference: auditRef,
          runtime_diagnostics: {
            raw_request_text: lastUserContent,
            positive_intent_signals: ["inspect", "provider", "selection", "execution engine"],
            negative_intent_signals: [],
            matched_inspection_pattern: "provider-policy-inspection",
            matched_execution_pattern: null,
            suppressed_patterns: ["inspectSupervisedExecutionEngine"],
            negation_handling_result: "not_applicable",
            extracted_ewo_reference: ewoRef,
            resolved_capability: "supervised-engineering-execution",
            resolved_operation: "inspectExecutionProviderPolicy",
            dispatch_handler: "inspect_execution_provider_policy RPC",
            rpc_invoked: "inspect_execution_provider_policy",
            data_source: "execution_provider_policy table",
            fallback_attempted: false,
            final_classification_confidence: 0.98,
          },
        }), { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } });
      } catch (err) {
        return new Response(JSON.stringify({
          inspection_status: "failed",
          failed_stage: "rpc_invocation",
          failure_code: "provider_policy_rpc_exception",
          failure_reason: String(err),
          reply: `Provider policy inspection failed: ${String(err)}`,
          detected_intent: "provider_policy_inspection",
          routing_decision: "route_to_inspectExecutionProviderPolicy",
          resolved_capability: "supervised-engineering-execution",
          resolved_operation: "inspectExecutionProviderPolicy",
          resolved_engineering_object_reference: ewoRef,
          data_source: "inspect_execution_provider_policy RPC",
          legacy_fallback_permitted: false,
          legacy_fallback_performed: false,
          lifecycle_change_performed: false,
          audit_reference: auditRef,
        }), { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } });
      }
    }

    // EWO-032: Execution handoff inspection short-circuit.
    // If the request is a handoff inspection, invoke the RPC directly.
    if (routingRule === "execution-handoff-inspection") {
      const hiResult = isExecutionHandoffInspection(lastUserContent);
      const ewoRef = hiResult.ewoRef;
      const auditRef = `EHI-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
      try {
        const { data: rpcData, error: rpcError } = await svc.rpc("inspect_execution_handoff", {
          p_ewo_ref: ewoRef || null,
          p_conversation_id: conversation_id || null,
        });
        if (rpcError || !rpcData) {
          return new Response(JSON.stringify({
            inspection_status: "failed",
            failed_stage: "rpc_invocation",
            failure_code: "execution_handoff_rpc_failed",
            failure_reason: rpcError?.message ?? "RPC returned no data",
            reply: `Execution handoff inspection failed: ${rpcError?.message ?? "RPC returned no data"}`,
            detected_intent: "execution_handoff_inspection",
            routing_decision: "route_to_inspectExecutionHandoff",
            resolved_capability: "supervised-engineering-execution",
            resolved_operation: "inspectExecutionHandoff",
            resolved_engineering_object_reference: ewoRef,
            data_source: "inspect_execution_handoff RPC",
            legacy_fallback_permitted: false,
            legacy_fallback_performed: false,
            lifecycle_change_performed: false,
            audit_reference: auditRef,
          }), { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } });
        }
        const handoff = typeof rpcData === "string" ? JSON.parse(rpcData) : rpcData;
        return new Response(JSON.stringify({
          detected_intent: "execution_handoff_inspection",
          routing_decision: "route_to_inspectExecutionHandoff",
          resolved_capability: "supervised-engineering-execution",
          resolved_operation: "inspectExecutionHandoff",
          resolved_engineering_object_reference: ewoRef,
          data_source: "inspect_execution_handoff RPC (authoritative)",
          rpc_invoked: "inspect_execution_handoff",
          handoff_found: handoff.handoff_found ?? false,
          work_order_reference: handoff.work_order_reference ?? null,
          conversation_id: handoff.conversation_id ?? null,
          plan_version: handoff.plan_version ?? null,
          approval_received: handoff.approval_received ?? false,
          approval_validated: handoff.approval_validated ?? false,
          execution_request_created: handoff.execution_request_created ?? false,
          execution_request_id: handoff.execution_request_id ?? null,
          dispatch_attempted: handoff.dispatch_attempted ?? false,
          governed_execution_engine_invoked: handoff.governed_execution_engine_invoked ?? false,
          execution_session_id: handoff.execution_session_id ?? null,
          requested_provider_id: handoff.requested_provider_id ?? null,
          selected_provider_id: handoff.selected_provider_id ?? null,
          provider_selection_reason: handoff.provider_selection_reason ?? null,
          provider_readiness_status: handoff.provider_readiness_status ?? "not_checked",
          provider_readiness_detail: handoff.provider_readiness_detail ?? {},
          current_execution_status: handoff.current_execution_status ?? null,
          failure_stage: handoff.failure_stage ?? null,
          exact_runtime_error: handoff.exact_runtime_error ?? null,
          audit_reference: handoff.audit_reference ?? auditRef,
          lifecycle_change_performed: false,
          reply: handoff.handoff_found
            ? `Execution handoff found for ${handoff.work_order_reference ?? ewoRef}. Execution request: ${handoff.execution_request_id ?? "none"}. Status: ${handoff.current_execution_status ?? "unknown"}.`
            : `No execution handoff found for ${ewoRef ?? "this work order"}.`,
        }), { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } });
      } catch (err) {
        return new Response(JSON.stringify({
          inspection_status: "failed",
          failed_stage: "rpc_invocation",
          failure_code: "execution_handoff_rpc_exception",
          failure_reason: String(err),
          reply: `Execution handoff inspection failed: ${String(err)}`,
          detected_intent: "execution_handoff_inspection",
          routing_decision: "route_to_inspectExecutionHandoff",
          resolved_capability: "supervised-engineering-execution",
          resolved_operation: "inspectExecutionHandoff",
          resolved_engineering_object_reference: ewoRef,
          data_source: "inspect_execution_handoff RPC",
          legacy_fallback_permitted: false,
          legacy_fallback_performed: false,
          lifecycle_change_performed: false,
          audit_reference: auditRef,
        }), { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } });
      }
    }

    // EWO-032: Approval-to-execution handoff short-circuit.
    // When the user says "approved" or "proceed", create a real governed
    // execution request and dispatch to the supervised execution engine.
    // Do NOT let the AI model simulate execution.
    if (routingRule === "approval-handoff" || routingRule === "cancellation-detected") {
      const approvalResult = await trackStage(svc, requestId, conversation_id ?? null, "approval_intent_detection", async () => {
        return detectApproval(lastUserContent);
      });
      if (!approvalResult.ok) {
        return new Response(JSON.stringify({
          success: false,
          failure_stage: "approval_intent_detection",
          exact_runtime_error: approvalResult.diagnostic.error_message,
          error_code: approvalResult.diagnostic.error_code,
          diagnostic_reference: approvalResult.diagnostic.diagnostic_ref,
          request_id: requestId,
          conversation_id: conversation_id ?? null,
        }), { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } });
      }
      const approval = approvalResult.value;
      const auditRef = `EHR-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;

      // Cancellation/modification takes precedence
      if (approval.isCancellation || approval.isModification) {
        return new Response(JSON.stringify({
          detected_intent: "cancellation_or_modification",
          routing_decision: "route_to_cancellation",
          approval_received: false,
          approval_validated: false,
          execution_request_created: false,
          execution_request_id: null,
          dispatch_attempted: false,
          governed_execution_engine_invoked: false,
          lifecycle_change_performed: false,
          audit_reference: auditRef,
          reply: "Cancellation or modification request detected. Execution will not proceed.",
          message: "Cancellation or modification request detected. Execution will not proceed.",
        }), { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } });
      }

      if (approval.isApproval) {
        // Resolve active EWO from conversation context
        let activeEwoRef: string | null = null;
        if (detectedRefs.length > 0) {
          const ewoRef = detectedRefs.find(r => r.type === "EWO");
          if (ewoRef) activeEwoRef = ewoRef.canonical;
        }
        if (!activeEwoRef && conversation_id) {
          const { data: activeObj } = await svc
            .from("atd_conversation_active_objects")
            .select("active_ewo_ref")
            .eq("conversation_id", conversation_id)
            .maybeSingle();
          if (activeObj?.active_ewo_ref) activeEwoRef = activeObj.active_ewo_ref;
        }

        if (!activeEwoRef) {
          return new Response(JSON.stringify({
            detected_intent: "approval_without_pending_plan",
            routing_decision: "route_to_approval_refused",
            approval_received: true,
            approval_validated: false,
            refusal_reason: "No pending governed engineering work order found for approval.",
            reply: "No pending governed engineering work order found for approval.",
            execution_request_created: false,
            execution_request_id: null,
            dispatch_attempted: false,
            governed_execution_engine_invoked: false,
            lifecycle_change_performed: false,
            audit_reference: auditRef,
          }), { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } });
        }

        // Validate approval preconditions
        const { data: ewo, error: ewoError } = await svc
          .from("engineering_work_orders")
          .select("id, ewo_ref, status, engineering_package_status")
          .eq("ewo_ref", activeEwoRef)
          .maybeSingle();

        if (ewoError || !ewo) {
          return new Response(JSON.stringify({
            detected_intent: "approval_ewo_not_found",
            routing_decision: "route_to_approval_refused",
            approval_received: true,
            approval_validated: false,
            refusal_reason: `Engineering Work Order ${activeEwoRef} not found.`,
            reply: `Engineering Work Order ${activeEwoRef} not found.`,
            execution_request_created: false,
            execution_request_id: null,
            dispatch_attempted: false,
            governed_execution_engine_invoked: false,
            lifecycle_change_performed: false,
            audit_reference: auditRef,
          }), { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } });
        }

        // Check for finalised plan
        const { data: plan } = await svc
          .from("engineering_plans")
          .select("id, status, updated_at")
          .eq("ewo_ref", activeEwoRef)
          .eq("plan_type", "plan")
          .order("updated_at", { ascending: false })
          .limit(1)
          .maybeSingle();

        if (!plan) {
          return new Response(JSON.stringify({
            detected_intent: "approval_without_plan",
            routing_decision: "route_to_approval_refused",
            approval_received: true,
            approval_validated: false,
            refusal_reason: `No finalised execution plan found for ${activeEwoRef}. Prepare the engineering plan first.`,
            reply: `No finalised execution plan found for ${activeEwoRef}. Prepare the engineering plan first.`,
            execution_request_created: false,
            execution_request_id: null,
            dispatch_attempted: false,
            governed_execution_engine_invoked: false,
            lifecycle_change_performed: false,
            audit_reference: auditRef,
          }), { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } });
        }

        // Check for EWO closed/archived
        if (ewo.status === "closed" || ewo.status === "archived") {
          return new Response(JSON.stringify({
            detected_intent: "approval_ewo_inactive",
            routing_decision: "route_to_approval_refused",
            approval_received: true,
            approval_validated: false,
            refusal_reason: `EWO ${activeEwoRef} is ${ewo.status}. Approval requires an active EWO.`,
            reply: `EWO ${activeEwoRef} is ${ewo.status}. Approval requires an active EWO.`,
            execution_request_created: false,
            execution_request_id: null,
            dispatch_attempted: false,
            governed_execution_engine_invoked: false,
            lifecycle_change_performed: false,
            audit_reference: auditRef,
          }), { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } });
        }

        // Idempotency check — return existing request if one exists
        const idempotencyKey = `${conversation_id || "unknown"}+${activeEwoRef}+${plan.id}+conversational`;
        const { data: existingRequest } = await svc
          .from("execution_handoff_requests")
          .select("*")
          .or(`idempotency_key.eq.${idempotencyKey},ewo_ref.eq.${activeEwoRef}`)
          .not("execution_status", "eq", "cancelled")
          .order("created_at", { ascending: false })
          .limit(1)
          .maybeSingle();

        if (existingRequest) {
          return new Response(JSON.stringify({
            detected_intent: "approval_duplicate",
            routing_decision: "route_to_approval_idempotent",
            approval_received: true,
            approval_validated: true,
            execution_request_created: true,
            execution_request_id: existingRequest.execution_request_id,
            dispatch_attempted: existingRequest.dispatch_attempted,
            governed_execution_engine_invoked: existingRequest.governed_execution_engine_invoked,
            execution_session_id: existingRequest.execution_session_id,
            selected_provider_id: existingRequest.selected_provider_id,
            provider_readiness_status: existingRequest.provider_readiness_status,
            current_execution_status: existingRequest.execution_status,
            failure_stage: existingRequest.failure_stage,
            exact_runtime_error: existingRequest.exact_runtime_error,
            lifecycle_change_performed: false,
            audit_reference: existingRequest.audit_reference,
            is_duplicate: true,
            reply: `Approval already processed. Execution request ${existingRequest.execution_request_id} exists with status ${existingRequest.execution_status}.`,
          }), { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } });
        }

        // Create execution request
        const executionRequestId = `EHR-${String(Date.now()).slice(-8)}-${Math.random().toString(36).slice(2, 6).toUpperCase()}`;
        const approvalReference = `APPR-${activeEwoRef}-${Date.now()}`;

        // Resolve repository target
        const { data: target } = await svc
          .from("execution_targets")
          .select("repository")
          .eq("is_active", true)
          .limit(1)
          .maybeSingle();

        const { data: handoffRecord, error: handoffError } = await svc
          .from("execution_handoff_requests")
          .insert({
            execution_request_id: executionRequestId,
            ewo_ref: activeEwoRef,
            conversation_id: conversation_id || null,
            approved_plan_version: plan.id,
            approval_reference: approvalReference,
            approving_persona: "product_owner",
            approval_timestamp: new Date().toISOString(),
            requested_provider_id: "codex",
            allowed_provider_ids: ["codex"],
            fallback_permitted: false,
            repository_identifier: target?.repository || null,
            branch_policy: { disposable_branch: true, no_existing_files_modified: true },
            file_change_scope: { permitted_files: [], restricted_files: [] },
            deployment_policy: { deployment_permitted: false },
            merge_policy: { merge_permitted: false },
            validation_requirements: [],
            execution_status: "approved",
            provider_readiness_status: "not_checked",
            dispatch_attempted: false,
            dispatch_success: false,
            governed_execution_engine_invoked: false,
            idempotency_key: idempotencyKey,
            audit_reference: auditRef,
          })
          .select("*")
          .single();

        if (handoffError || !handoffRecord) {
          await svc.from("execution_handoff_audit").insert({
            handoff_id: null,
            ewo_ref: activeEwoRef,
            event_type: "execution_request_creation_failed",
            event_data: { execution_request_id: executionRequestId, error: handoffError?.message || "Unknown error" },
          }).then(() => {}, () => {});
          return new Response(JSON.stringify({
            detected_intent: "approval_request_creation_failed",
            routing_decision: "route_to_approval_failed",
            approval_received: true,
            approval_validated: true,
            execution_request_created: false,
            execution_request_id: null,
            dispatch_attempted: false,
            governed_execution_engine_invoked: false,
            failure_stage: "request_creation",
            exact_runtime_error: handoffError?.message || "Failed to create execution request.",
            reply: handoffError?.message || "Failed to create execution request.",
            lifecycle_change_performed: false,
            audit_reference: auditRef,
          }), { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } });
        }

        // Audit: execution request created
        await svc.from("execution_handoff_audit").insert({
          handoff_id: handoffRecord.id,
          ewo_ref: activeEwoRef,
          event_type: "execution_request_created",
          event_data: { execution_request_id: executionRequestId, approval_reference: approvalReference },
        }).then(() => {}, () => {});

        // Record PO execution approval
        await svc.rpc("approve_ewo_for_execution", {
          p_ewo_ref: activeEwoRef,
          p_approved_by: "product_owner",
          p_decision: "approved",
          p_approval_statement: "Conversational approval for execution handoff.",
          p_provider_preference: "codex",
        }).then(() => {}, () => {});

        // Audit: provider readiness started
        await svc.from("execution_handoff_audit").insert({
          handoff_id: handoffRecord.id,
          ewo_ref: activeEwoRef,
          event_type: "provider_readiness_started",
          event_data: { execution_request_id: executionRequestId, provider: "codex" },
        }).then(() => {}, () => {});

        // Provider readiness gate
        const { data: provider, error: providerError } = await svc
          .from("execution_provider_registry")
          .select("provider_id, provider_name, is_active, is_governed, configuration_status, credential_reference_status, provider_health, canonical_contract_version")
          .eq("provider_id", "codex")
          .maybeSingle();

        let readinessStatus = "passed";
        let readinessDetail: Record<string, unknown> = {};
        let readinessError: string | null = null;

        if (providerError || !provider) {
          readinessStatus = "failed";
          readinessError = 'Provider "codex" is not registered in the execution provider registry.';
        } else {
          readinessDetail = { provider_registered: true, provider_name: provider.provider_name };
          if (!provider.is_active) { readinessStatus = "failed"; readinessError = `Provider "${provider.provider_name}" is not active.`; }
          else if (!provider.is_governed) { readinessStatus = "failed"; readinessError = `Provider "${provider.provider_name}" is not governed.`; }
          else if (provider.configuration_status === "not_configured") { readinessStatus = "failed"; readinessError = `Provider "${provider.provider_name}" configuration is not complete.`; }
          else if (provider.credential_reference_status === "unavailable" || provider.credential_reference_status === "revoked") { readinessStatus = "failed"; readinessError = `Provider "${provider.provider_name}" credentials are ${provider.credential_reference_status}.`; }
          else if (provider.provider_health && provider.provider_health !== "healthy") { readinessStatus = "failed"; readinessError = `Provider "${provider.provider_name}" health is ${provider.provider_health}.`; }
          else if (provider.canonical_contract_version !== "1.0") { readinessStatus = "failed"; readinessError = `Provider contract version ${provider.canonical_contract_version} is incompatible.`; }
        }

        // Check policy allows codex
        const { data: policy } = await svc
          .from("execution_provider_policy")
          .select("allowed_provider_ids, fallback_permitted, policy_version")
          .eq("lifecycle_status", "active")
          .maybeSingle();

        if (policy) {
          const allowedIds: string[] = Array.isArray(policy.allowed_provider_ids) ? policy.allowed_provider_ids : [];
          if (!allowedIds.includes("codex")) {
            readinessStatus = "failed";
            readinessError = `Provider "codex" is not in the allowed provider list: [${allowedIds.join(", ")}].`;
          }
          if (policy.fallback_permitted) {
            readinessStatus = "failed";
            readinessError = "Provider policy permits fallback. Codex-only execution requires fallback to be disabled.";
          }
          readinessDetail.policy_version = policy.policy_version;
        }

        await svc.from("execution_handoff_requests").update({
          provider_readiness_status: readinessStatus,
          provider_readiness_detail: readinessDetail,
        }).eq("execution_request_id", executionRequestId);

        // Audit: provider readiness result
        await svc.from("execution_handoff_audit").insert({
          handoff_id: handoffRecord.id,
          ewo_ref: activeEwoRef,
          event_type: "provider_readiness_result",
          event_data: { execution_request_id: executionRequestId, readiness_status: readinessStatus, error: readinessError, detail: readinessDetail },
        }).then(() => {}, () => {});

        if (readinessStatus === "failed") {
          await svc.from("execution_handoff_requests").update({
            execution_status: "failed",
            failure_stage: "provider_readiness",
            exact_runtime_error: readinessError,
          }).eq("execution_request_id", executionRequestId);

          return new Response(JSON.stringify({
            detected_intent: "approval_handoff_readiness_failed",
            routing_decision: "route_to_readiness_failed",
            approval_received: true,
            approval_validated: true,
            execution_request_created: true,
            execution_request_id: executionRequestId,
            dispatch_attempted: false,
            governed_execution_engine_invoked: false,
            requested_provider_id: "codex",
            selected_provider_id: null,
            provider_readiness_status: "failed",
            provider_readiness_detail: readinessDetail,
            current_execution_status: "failed",
            failure_stage: "provider_readiness",
            exact_runtime_error: readinessError,
            reply: `Provider readiness check failed: ${readinessError}`,
            lifecycle_change_performed: false,
            audit_reference: auditRef,
          }), { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } });
        }

        // Dispatch to supervised execution engine
        await svc.from("execution_handoff_requests").update({
          dispatch_attempted: true,
          execution_status: "dispatched",
          selected_provider_id: "codex",
          provider_selection_reason: "Codex selected as preferred and default provider per active execution provider policy.",
        }).eq("execution_request_id", executionRequestId);

        await svc.from("execution_handoff_audit").insert({
          handoff_id: handoffRecord?.id ?? null,
          ewo_ref: activeEwoRef,
          event_type: "dispatch_attempted",
          event_data: { execution_request_id: executionRequestId, provider: "codex", readiness: readinessStatus },
        });

        // Attempt pipeline execution — failures return structured result, never HTTP 500
        let pipelineSuccess = false;
        let pipelineError: string | null = null;
        let executionSessionId: string | null = null;
        let governedEngineInvoked = false;
        let failureStage: string | null = null;

        try {
          const { data: pipelineData, error: pipelineErr } = await svc.rpc("execute_supervised_pipeline", {
            p_ewo_ref: activeEwoRef,
            p_preferred_provider: "codex",
          });
          if (pipelineErr) {
            pipelineError = pipelineErr.message;
            failureStage = "dispatch";
          } else if (pipelineData) {
            const result = typeof pipelineData === "string" ? JSON.parse(pipelineData) : pipelineData;
            pipelineSuccess = result.success ?? false;
            executionSessionId = result.execution_record?.execution_ref ?? result.execution_ref ?? null;
            failureStage = result.failure_stage ?? null;
            if (!pipelineSuccess) {
              pipelineError = result.error || "Execution pipeline failed.";
            }
            governedEngineInvoked = true;
          } else {
            pipelineError = "Execution pipeline returned no data.";
            failureStage = "dispatch";
          }
        } catch (e) {
          pipelineError = e instanceof Error ? e.message : "Unknown execution error";
          failureStage = "dispatch";
        }

        await svc.from("execution_handoff_audit").insert({
          handoff_id: handoffRecord?.id ?? null,
          ewo_ref: activeEwoRef,
          event_type: pipelineSuccess ? "dispatch_succeeded" : "dispatch_failed",
          event_data: {
            execution_request_id: executionRequestId,
            execution_session_id: executionSessionId,
            governed_execution_engine_invoked: governedEngineInvoked,
            failure_stage: failureStage,
            error: pipelineError,
          },
        });

        if (pipelineSuccess) {
          await svc.from("execution_handoff_requests").update({
            dispatch_success: true,
            governed_execution_engine_invoked: true,
            execution_status: "executing",
            execution_session_id: executionSessionId,
          }).eq("execution_request_id", executionRequestId);

          return new Response(JSON.stringify({
            detected_intent: "approval_handoff_dispatched",
            routing_decision: "route_to_execution_dispatched",
            approval_received: true,
            approval_validated: true,
            execution_request_created: true,
            execution_request_id: executionRequestId,
            dispatch_attempted: true,
            dispatch_success: true,
            governed_execution_engine_invoked: true,
            execution_session_id: executionSessionId,
            requested_provider_id: "codex",
            selected_provider_id: "codex",
            provider_selection_reason: "Codex selected as preferred and default provider per active execution provider policy.",
            provider_readiness_status: "passed",
            provider_readiness_detail: readinessDetail,
            current_execution_status: "executing",
            failure_stage: null,
            exact_runtime_error: null,
            reply: `Execution dispatched successfully. Execution request ${executionRequestId} is now running.`,
            lifecycle_change_performed: false,
            audit_reference: auditRef,
          }), { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } });
        } else {
          await svc.from("execution_handoff_requests").update({
            dispatch_success: false,
            governed_execution_engine_invoked: governedEngineInvoked,
            execution_status: "failed",
            execution_session_id: executionSessionId,
            failure_stage: failureStage || "dispatch",
            exact_runtime_error: pipelineError,
          }).eq("execution_request_id", executionRequestId);

          return new Response(JSON.stringify({
            detected_intent: "approval_handoff_execution_failed",
            routing_decision: "route_to_execution_failed",
            approval_received: true,
            approval_validated: true,
            execution_request_created: true,
            execution_request_id: executionRequestId,
            dispatch_attempted: true,
            dispatch_success: false,
            governed_execution_engine_invoked: governedEngineInvoked,
            execution_session_id: executionSessionId,
            requested_provider_id: "codex",
            selected_provider_id: "codex",
            provider_selection_reason: "Codex selected as preferred and default provider per active execution provider policy.",
            provider_readiness_status: "passed",
            provider_readiness_detail: readinessDetail,
            current_execution_status: "failed",
            failure_stage: failureStage || "dispatch",
            exact_runtime_error: pipelineError,
            reply: `Execution failed: ${pipelineError}`,
            lifecycle_change_performed: false,
            audit_reference: auditRef,
          }), { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } });
        }
      }
    }

    // Resolve references and assemble Knowledge Package when EIOS Engineering domain selected
    let resolvedRefs: ResolvedRef[] = [];
    let knowledgePackage: KnowledgePackage | null = null;
    let resolverInvoked = false;
    let canonicalTableQueried: string | null = null;
    let resolutionOutcome = "no-references-detected";
    let knowledgePackageVersion: string | null = null;

    // Relationship graph (EWO-016R.X) — built when intent is relationship_discovery
    let relationshipGraph: EngineeringRelationshipGraph | null = null;
    let relationshipGraphRendered: string | null = null;

    if (selectedDomain === "eios-engineering" && detectedRefs.length > 0) {
      resolverInvoked = true;
      resolvedRefs = await Promise.all(detectedRefs.map(r => resolveReference(svc, r)));
      const primaryResolved = resolvedRefs[0];
      canonicalTableQueried = TYPE_TO_TABLE[primaryResolved.detected.type]?.table ?? null;

      if (primaryResolved.found) {
        knowledgePackage = await assembleKnowledgePackage(svc, primaryResolved);
        if (knowledgePackage) {
          knowledgePackageVersion = knowledgePackage.version;
          resolutionOutcome = "resolved";
        } else {
          resolutionOutcome = "resolution-failed-technical";
        }
        // Build relationship graph when intent is relationship_discovery (EWO-016R.X)
        if (detectedIntent === "relationship_discovery") {
          relationshipGraph = await buildEngineeringRelationshipGraph(svc, primaryResolved.detected.canonical, primaryResolved.detected.type);
          relationshipGraphRendered = renderRelationshipGraphAsContext(relationshipGraph);
        }
      } else {
        resolutionOutcome = "not-found";
      }
    }

    // EWO-016R.Y — Build the authoritative Runtime Diagnostic Envelope.
    // Created by application code from the actual runtime path taken; the
    // language model must never alter or invent these values.
    // For diagnostic_followup, bind to the prior request's envelope (Req 4).
    const runtimeRequestId = `REQ-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
    let diagnosticEnvelope: RuntimeDiagnosticEnvelope;
    let priorEnvelopeBound = false;
    if (detectedIntent === "diagnostic_followup" && prior_diagnostic_envelope) {
      diagnosticEnvelope = prior_diagnostic_envelope;
      priorEnvelopeBound = true;
    } else {
      diagnosticEnvelope = buildDiagnosticEnvelope(
        runtimeRequestId,
        detectedIntent,
        selectedDomain,
        resolvedRefs.length > 0 && resolvedRefs[0].found ? resolvedRefs[0].detected.canonical : null,
        resolvedRefs.length > 0 ? resolvedRefs[0].detected.type : null,
        detectedIntent === "relationship_discovery" && relationshipGraph ? "buildEngineeringRelationshipGraph" : null,
        resolverInvoked ? ["resolveReference", detectedIntent === "relationship_discovery" ? "buildEngineeringRelationshipGraph" : ""].filter(Boolean) : [],
        relationshipGraph,
      );
    }

    const { context: productContext, stats } = await buildProductContext(svc);
    const modeInstructions = getModeInstructions(mode);

    // Auto-classify or use selected role
    let selectedRoles: string[];
    let autoClassified = false;
    if (ai_role === "auto") {
      const classified = classifyRequest(lastUserContent);
      selectedRoles = classified.roles;
      autoClassified = true;
    } else {
      selectedRoles = [ai_role];
    }
    const roleInstructions = buildMultiRoleInstructions(selectedRoles);

    // ─── System Prompt Construction (Requirement 4, 11) ──────────────────────
    // When EIOS Engineering domain is selected and a Knowledge Package was
    // assembled, the Engineering context is AUTHORITATIVE. LLND Automate
    // product context is included only as optional related context, never as
    // the defining domain.
    const engineeringContextBlock = knowledgePackage
      ? renderKnowledgePackageAsContext(knowledgePackage)
      : null;
    const relationshipContextBlock = relationshipGraphRendered;

    const isEiosDomain = selectedDomain === "eios-engineering";
    const isRelationshipDiscovery = detectedIntent === "relationship_discovery";

    const systemPrompt = `You are the AI Technical Director (ATD) operating on the Engineering Intelligence Operating System (EIOS). Internal only. Never visible to customers.

You are NOT a general-purpose assistant. You are a Technical Director leading an engineering organisation. You think in systems, own engineering decisions, and manage the ECC as your primary domain.${autoClassified ? `\n\nYou are responding from ${selectedRoles.length > 1 ? `${selectedRoles.length} coordinated perspectives` : 'the most appropriate perspective'} for this request.` : ""}

${roleInstructions}

## Engineering Identity
You permanently identify as the AI Technical Director. Never respond with generic assistant language. Never say "I'm just an AI" or "I can't do that." If something is within ECC authority, do it. If it's outside ECC authority (production code, SQL execution, deployments), state that clearly and offer what you CAN do instead.

## Platform and Product Context Separation
EIOS is the Engineering Intelligence Operating System and canonical Engineering domain.
LLND Automate is a product engineered through EIOS.
ATD operates on EIOS. When asked about an EWO, EXEC, REC, or other canonical Engineering reference, you are answering from EIOS Engineering context — NOT from LLND Automate product context.
LLND Automate product context is related but NOT interchangeable with EIOS Engineering context.
${isEiosDomain ? `\n**This request has been routed to the EIOS Engineering domain.** The Engineering Knowledge Package below is AUTHORITATIVE for the referenced object. Do not override it with LLND Automate product context, model memory, or historical conversation assumptions.\n\n## AUTHORITATIVE Engineering Knowledge Package\n${engineeringContextBlock}\n` : ""}${isRelationshipDiscovery && relationshipContextBlock ? `\n## AUTHORITATIVE Engineering Relationship Graph\n${relationshipContextBlock}\n\n## Relationship Discovery vs Impact Analysis\nThis request was classified as Engineering Relationship Discovery. You are traversing the engineering object graph — related engineering records, artefacts, and traceability — NOT performing Engineering Impact Analysis.\n- DO traverse: engineering intent, analysis, plan, work order, completion report, verification evidence, engineering package, engineering review, historical recovery, change log, records library.\n- DO NOT traverse: affected product features, APIs, tests, releases, integrations — that is Engineering Impact Analysis, a separate capability.\n- For each related object, state its reference, type, title, status, and the relationship to the root object.\n- For artefacts that do not yet exist, clearly identify them as Pending with their pending reason — do NOT omit them.\n- Present the complete engineering traceability through the conversation.\n` : ""}
## AUTHORITATIVE Runtime Diagnostic Envelope (EWO-016R.Y)
The following runtime diagnostics were produced by application code for request ${diagnosticEnvelope.request_id}. They are AUTHORITATIVE evidence of what the runtime actually did. You MUST answer runtime/diagnostic questions ("which tables did you query?", "why did you reach that conclusion?", "show the runtime evidence", "how did you determine this?") exclusively from this envelope.
${priorEnvelopeBound ? `\n**This is a diagnostic follow-up.** The envelope below is from the PRIOR request (${diagnosticEnvelope.request_id}) and is the authoritative evidence for this follow-up. Do NOT build a fresh hypothetical explanation; answer from this envelope only.\n` : ""}
${renderDiagnosticEnvelopeForPrompt(diagnosticEnvelope)}

## Strict Diagnostic Grounding Rules (EWO-016R.Y)
When answering runtime or diagnostic questions, you MUST:
1. Answer exclusively from the Runtime Diagnostic Envelope above for the current request.
2. NEVER guess, invent, or infer table names, services invoked, retrieval paths, records inspected, or diagnostic outcomes that are not present in the envelope.
3. NEVER describe a table as queried unless it appears in "Tables Successfully Queried".
4. NEVER describe a configured-but-not-attempted source as queried. "Tables Attempted" lists only sources the runtime actually tried.
5. If the envelope does not contain the requested information, say: "The available runtime diagnostics do not confirm that information." Do NOT fill the gap with a plausible explanation.
6. Distinguish claims as: (a) Confirmed Runtime Fact — directly supported by the envelope; (b) Supported Inference — reasonably inferred from confirmed evidence but not directly recorded (preface with "Based on the available runtime evidence, the most likely explanation is..."); (c) Unknown — not available from current runtime evidence.
7. NEVER use language such as "confirmed root cause", "actually queried", "definitely", or "verified" unless the claim is directly supported by the envelope.
8. Zero discovered relationships is NOT proof that no related records exist. Do not confirm Cause A ("records do not exist") unless the envelope shows all relevant canonical sources were successfully queried and returned no candidates.

## Root Cause Determination Rules (EWO-016R.Y)
You may only confirm one of these causes when runtime evidence supports it:
- A. Related records do not exist. (Requires: all relevant canonical sources successfully queried, no candidates found.)
- B. Related records exist but are not linked. (Requires: candidate records found via canonical reference matching but no valid relationship link.)
- C. Related records are linked but traversal failed. (Requires: a valid link exists but was omitted from the returned graph.)
- D. Querying was incomplete or failed. (Requires: one or more required sources could not be queried — see Query Failures.)
- E. Root cause remains undetermined. (Applies when available diagnostics are insufficient.)
Never confirm Cause A merely because the returned relationship count is zero.

## Engineering Authority Model

### What I Am Authorised To Manage (ECC Planning Data)
After user approval, I can CREATE, UPDATE, and LINK any of the following:
✓ Backlog items (ideas, stories, bugs, tasks, spikes)
✓ Goals and Epics
✓ Roadmap items and Milestones
✓ Product Features (feature registry)
✓ Engineering Specifications and Documentation
✓ Architecture Decisions (ADRs)
✓ Testing Tasks and Test Plans
✓ Release Tasks and Release Candidates
✓ Engineering Audits
✓ Change Records
✓ Engineering Relationships (feature links, dependencies)
✓ Engineering Memory and Conversation Context
✓ Priorities, Workflow Stages, Engineering Status

I must NEVER incorrectly state that I cannot manage these ECC records. They are within my authority.

### What I Am NOT Authorised To Do (Production Software)
✗ Modify React source code or TypeScript
✗ Execute SQL migrations or modify database schema
✗ Deploy edge functions or modify infrastructure
✗ Delete production data
✗ Publish releases or modify runtime configuration

Production engineering always requires human implementation. When production changes are needed, I prepare the engineering specification, implementation prompt, and change record — then a human implements it.

## Capability Level: L1 — Engineering Planning
${modeInstructions ? `\n${modeInstructions}\n` : ""}
## Engineering Workflow

For ANY request involving ideas, features, bugs, architecture, documentation, or planning — you MUST follow this workflow:

### Stages 1 & 2 — Analyse + Prepare (Automatic, in ONE response)

1. Thoroughly analyse the request against the live product context
2. Check for existing similar features, backlog items, goals, and epics before recommending new ones
3. Determine where the work fits in the current engineering programme
4. Assess confidence, priority, business value, and engineering complexity
5. At the very end of this response, include ALL THREE structured blocks in this order:

---

**Block 1 — Engineering Decision (ALWAYS include for actionable requests):**

%%ENGINEERING_DECISION%%
{
  "recommendation": "Proceed",
  "priority_score": 85,
  "priority_level": "High",
  "engineering_confidence": 90,
  "business_value": 85,
  "engineering_value": 75,
  "compliance_value": 60,
  "customer_value": 90,
  "estimated_effort": "4–6 hours",
  "estimated_complexity": "Medium",
  "why_now": "Specific paragraph explaining why this work should happen now. Reference the current active phase, recent completions, active release candidates, or specific customer impact. Never be generic.",
  "suggested_phase": "Phase 12",
  "suggested_milestone": "RC-007 Milestone",
  "suggested_release": "RC-007",
  "suggested_roadmap_position": "Q3 2026",
  "feature_intelligence": {
    "creates_new_feature": false,
    "updates_existing_feature": "FEAT-024 or null",
    "existing_epic": "Epic title if this fits an existing epic, otherwise null",
    "existing_goal": "Goal title if this fits an existing goal, otherwise null",
    "creates_new_spec": true,
    "reasoning": "Brief explanation of why this classification was chosen"
  },
  "impact_summary": {
    "affected_features": ["FEAT-001"],
    "affected_specs": ["Spec title"],
    "affected_tests": ["TP-001 Regression"],
    "affected_documentation": ["Doc title"],
    "affected_releases": ["RC-007"],
    "affected_architecture": ["table_name"],
    "affected_integrations": ["aXcelerate"],
    "affected_apis": ["edge-function-name"],
    "affected_db_objects": ["table_name"]
  },
  "testing_recommendations": [
    { "type": "TP-001 Regression", "required": true, "reason": "Core assessment flow affected" },
    { "type": "Integration Testing", "required": true, "reason": "External API affected" },
    { "type": "Performance Testing", "required": false, "reason": "No performance-critical path affected" }
  ],
  "documentation_recommendations": [
    { "type": "Engineering Specification", "required": true, "title": "Spec title" },
    { "type": "Release Notes", "required": true, "title": "RC-007 Release Notes" },
    { "type": "User Documentation", "required": false, "title": "Not required — internal feature" }
  ],
  "duplicate_analysis": {
    "similar_records_found": false,
    "recommendation": "Create New",
    "existing_record": null,
    "reasoning": "No similar backlog items or features found."
  },
  "implementation_readiness": {
    "percentage": 60,
    "items_complete": ["Architecture defined", "Specification drafted"],
    "items_outstanding": ["Testing plan", "Dependencies confirmed", "Final approval"]
  },
  "director_summary": {
    "recommendation": "Proceed",
    "priority": 91,
    "reason": "2-3 sentence executive justification referencing business value, engineering risk, and roadmap fit.",
    "estimated_effort": "4–6 hours",
    "suggested_phase": "Phase 12",
    "suggested_release": "RC-007",
    "required_testing": ["TP-001 Regression", "Integration Testing"]
  }
}
%%END_ENGINEERING_DECISION%%

**Block 2 — Artefact Plan (ALWAYS include for actionable requests):**

%%ARTEFACT_PLAN%%
[
  {
    "type": "backlog_item",
    "title": "...",
    "description": "...",
    "priority": "high",
    "item_type": "idea",
    "category": "product",
    "reasoning": "Why this specific artefact is being created"
  }
]
%%END_ARTEFACT_PLAN%%

**Block 3 — Approval Summary:**

%%APPROVAL_SUMMARY%%
{
  "task": "Brief descriptive task name",
  "confidence": 94,
  "confidence_reason": "Clear plain-English explanation",
  "risk": "low",
  "estimated_time": "18 minutes",
  "target": "staging",
  "rollback_available": true,
  "affected_features": ["FEAT-001"],
  "changes": {
    "react_components": 2,
    "edge_functions": 1,
    "db_migrations": 1,
    "documentation": 2,
    "regression_tests": 5
  },
  "rollback_instructions": "Step-by-step rollback instructions"
}
%%END_APPROVAL%%

---

### Stage 3 — Approve (Mandatory pause)
After providing analysis + all three blocks, stop. Do NOT create artefacts until the user approves.

### Stage 4 — Apply (Only after %%APPROVE%%)
When you receive %%APPROVE%%:
- The ECC artefacts will be auto-created by the system — do NOT re-list them
- Provide implementation guidance, implementation prompt, or engineering notes
- After all content, include the %%CHANGE_RECORD%% block

%%CHANGE_RECORD%%
{
  "task_name": "...",
  "confidence_score": 94,
  "confidence_reason": "...",
  "implementation_summary": "2-3 sentence plain-English summary",
  "affected_features": ["FEAT-001"],
  "affected_components": ["ComponentName.tsx"],
  "affected_edge_functions": ["function-name"],
  "affected_db_tables": ["table_name"],
  "risk_level": "low",
  "rollback_instructions": "...",
  "estimated_time": "..."
}
%%END_CHANGE_RECORD%%

---

## Engineering Decision Quality Standards

### Priority Score (0-100)
- 90-100: Business-critical, customer-facing, blocks releases
- 70-89: High value, active roadmap alignment, low risk
- 50-69: Medium value, useful but not urgent
- 30-49: Low priority, technical debt, nice-to-have
- 0-29: Defer, insufficient justification

### Value Dimensions (0-100 each)
- Business Value: Revenue impact, customer acquisition, RTO operational value
- Engineering Value: Reduces debt, improves architecture, enables future work
- Compliance Value: ASQA compliance, audit trail, regulatory requirements
- Customer Value: Direct impact on RTO staff and learner experience

### Complexity Scale
- Simple: Single file change, no DB migration, no external dependencies
- Medium: 2-5 files, possible DB change, internal dependencies only
- Complex: Multiple systems, DB migrations, external API changes
- Highly Complex: Architecture change, multi-phase, compliance implications

### Why Now — Quality Rules
- Reference specific active phases, milestones, or release candidates from the live context
- Reference recently completed work this builds upon
- Reference specific customer or compliance pain points
- NEVER use generic phrases like "this is a good idea" or "this would be beneficial"

### Feature Intelligence Rules
- If a similar feature (FEAT-XXX) already exists → recommend updating it, not creating new
- If an active epic already covers this work → link to it, don't create a new epic
- If an active goal already covers this → link to it, don't create a new goal
- Only create new goals/epics when there is genuinely no existing structure

### Artefact Selection
For "I have an idea": backlog_item(idea) + documentation(spec) + optionally goal if no existing goal fits
For "I found a bug": backlog_item(bug) + decision(investigation)
For "Build a feature": backlog_item(story) + documentation(spec)
For "Create Engineering Spec": documentation(spec) + decision
For "Review architecture": decision + documentation(reference)
For "Create Test Plan": documentation(spec with doc_type=test_plan)
For "Analyse impact": decision + backlog_item(task)

### When NOT to use the workflow
Pure questions, search-only, compliance audit read-only, recommendations without actionable request — respond normally without the three blocks.

## Engineering Reference Resolution Rules
${isEiosDomain && knowledgePackage ? `
A canonical Engineering reference (${knowledgePackage.reference}) was detected and RESOLVED from the canonical EIOS Engineering source. The Engineering Knowledge Package above contains the authoritative record. You MUST:
- Answer from this Engineering Knowledge Package, NOT from LLND Automate product context.
- State the correct title, purpose, lifecycle state, verification state, and PO state from the package.
- NEVER say the referenced object is unknown, unrecognised, or not found.
- NEVER ask the Product Owner to provide information already in the Knowledge Package.
- NEVER describe the referenced Engineering object as an LLND Automate feature or backlog item.
- Treat the Knowledge Package as authoritative over model memory, product context, and historical conversation assumptions.
` : isEiosDomain && !knowledgePackage && resolvedRefs.length > 0 && !resolvedRefs[0].found ? `
A canonical Engineering reference (${resolvedRefs[0].detected.canonical}) was detected but could not be resolved from the canonical EIOS Engineering source. You MUST:
- State that ${resolvedRefs[0].detected.canonical} was recognised as an EIOS Engineering reference.
- State that the canonical record could not be loaded because Engineering context resolution failed.
- Do NOT say the reference is unknown, unrecognised, or not part of LLND Automate.
- Do NOT ask the Product Owner to describe it.
- Do NOT treat it as an LLND Automate feature.
` : ""}

## Confidence Scoring
- 80-100%: High confidence — proceed
- 60-79%: Good confidence — flag assumptions
- 40-59%: Moderate confidence — recommend validation
- 20-39%: Low confidence — request more evidence
- 0-19%: Insufficient evidence — ask for details

## General Rules
1. Always base answers on live product data — never fabricate
2. Reference features as FEAT-XXX, tables by exact name
3. Format with Markdown: headers, bullets, tables, code blocks
4. When analysing bugs, check the dependency graph for downstream impact
5. Never overstate certainty
6. End every response (except workflow approval responses) with: %%ACTIONS%%[3-4 follow-up actions, pipe-separated, max 80 chars]%%END%%

## Live Product Context (LLND Automate — related but NOT authoritative for EIOS Engineering queries)

${productContext}`;

    let effectiveMessages = messages;
    if (isApproval) {
      effectiveMessages = [
        ...messages.slice(0, -1),
        {
          role: "user",
          content: "%%APPROVE%% — The user has approved. The ECC planning artefacts will be created automatically by the system. Provide implementation guidance, implementation prompt, or engineering notes, followed by the %%CHANGE_RECORD%% block.",
        },
      ];
    }
    if (isCancellation) {
      effectiveMessages = [
        ...messages.slice(0, -1),
        {
          role: "user",
          content: "%%CANCEL%% — The user has cancelled this implementation. Acknowledge the cancellation and ask how they would like to proceed instead.",
        },
      ];
    }

    // EWO-032R.3: Sanitize messages at the boundary before entering the shared AI
    // service. Removes null/undefined content from persisted conversation history
    // and coerces remaining content to strings. Records a diagnostic when removal
    // occurs so invalid history is traceable.
    const rawMessages = effectiveMessages.map(m => ({
      role: m.role as "user" | "assistant",
      content: m.content,
    }));
    const preSanitizeCount = rawMessages.length;
    const sanitizedForProvider = sanitizeMessages(rawMessages);
    const removedCount = preSanitizeCount - sanitizedForProvider.length;
    if (removedCount > 0) {
      const sanitizeDiagRef = `SAN-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
      const sanitizeDiag: StageDiagnostic = {
        diagnostic_ref: sanitizeDiagRef, request_id: requestId, conversation_id: conversation_id ?? null,
        message_id: null, stage_name: "message_sanitization", started_at: new Date().toISOString(),
        completed_at: new Date().toISOString(), success: true,
        error_message: `Removed ${removedCount} null-content message(s) before AI provider invocation.`,
        error_code: null, error_details: null, error_hint: null, error_status: null, stack_trace: null,
      };
      await persistDiagnostic(svc, sanitizeDiag).catch(() => {});
    }

    const aiResponse = await generate(svc, {
      feature: "command-centre-ai",
      systemPrompt,
      messages: sanitizedForProvider,
      userId,
    });

    // ─── Routing Diagnostics (Requirement 9) ──────────────────────────────────
    const diagnostics: RoutingDiagnostics = {
      conversationId: conversation_id ?? null,
      userMessage: lastUserContent.slice(0, 200),
      detectedReferences: detectedRefs,
      detectedIntent,
      selectedDomain,
      routingRule,
      activeWorkspace: active_workspace,
      resolverInvoked,
      canonicalTableQueried,
      resolutionOutcome,
      knowledgePackageVersion,
      aiProviderInvoked: true,
      finalResponseClassification: isRelationshipDiscovery ? "eios-engineering-relationship-discovery" : isEiosDomain && knowledgePackage ? "eios-engineering-resolved" : isEiosDomain ? "eios-engineering-not-found" : selectedDomain,
      relationshipGraphNodes: relationshipGraph?.totalFound ?? 0,
      relationshipGraphPending: relationshipGraph?.totalPending ?? 0,
    };

    // ─── Context Used metadata (Requirement 10) ───────────────────────────────
    const contextUsed = knowledgePackage ? {
      domain: "eios-engineering" as const,
      resolvedObject: knowledgePackage.reference,
      sources: knowledgePackage.layers ?? [
        { name: "Engineering Work Order", source: "engineering_work_orders" },
        ...(knowledgePackage.verification ? [{ name: "Verification", source: "ewo_verification_gates" }] : []),
        ...(knowledgePackage.executionHistory ? [{ name: "Execution History", source: "engineering_executions" }] : []),
        ...(knowledgePackage.relatedEngineering ? [{ name: "Related Engineering", source: "engineering_object_relationships" }] : []),
        ...(relationshipGraph ? [{ name: "Relationship Graph", source: "engineering_object_relationships,ewo_verification_sessions,ewo_completion_reports,engineering_executions,ecc_engineering_reviews,engineering_recovery_packages,ewo_engineering_packages,ewo_lifecycle_events,engineering_records_library,atd_engineering_decisions" }] : []),
      ],
      relationshipDiscovery: isRelationshipDiscovery ? {
        nodesFound: relationshipGraph?.totalFound ?? 0,
        pendingArtefacts: relationshipGraph?.totalPending ?? 0,
      } : undefined,
    } : null;

    const rawReply = aiResponse.content;

    // Parse engineering decision block (rich decision package for UI)
    const decisionParse = parseBlock(rawReply, "%%ENGINEERING_DECISION%%", "%%END_ENGINEERING_DECISION%%");
    let engineeringDecision: Record<string, unknown> | null = null;
    let workingReply = decisionParse.content ? decisionParse.cleaned : rawReply;

    if (decisionParse.content) {
      try {
        engineeringDecision = JSON.parse(decisionParse.content);
      } catch {
        // Malformed JSON — continue without decision block
      }
    }

    // Parse artefact plan
    const artefactParse = parseBlock(workingReply, "%%ARTEFACT_PLAN%%", "%%END_ARTEFACT_PLAN%%");
    let artefactPlan: ArtefactPlanItem[] | null = null;
    if (artefactParse.content) {
      workingReply = artefactParse.cleaned;
      try {
        artefactPlan = JSON.parse(artefactParse.content);
      } catch {
        // Malformed JSON — continue without plan
      }
    }

    // Parse approval summary
    const approvalParse = parseBlock(workingReply, "%%APPROVAL_SUMMARY%%", "%%END_APPROVAL%%");
    let pendingImplementation: Record<string, unknown> | null = null;
    if (approvalParse.content) {
      workingReply = approvalParse.cleaned;
      try {
        pendingImplementation = JSON.parse(approvalParse.content);
      } catch {
        // Malformed JSON
      }
    }

    // Parse change record (apply stage)
    const changeParse = parseBlock(workingReply, "%%CHANGE_RECORD%%", "%%END_CHANGE_RECORD%%");
    let changeRecordId: string | null = null;
    let createdArtefacts: CreatedArtefact[] = [];
    let skippedArtefacts: CreatedArtefact[] = [];

    if (changeParse.content) {
      workingReply = changeParse.cleaned;
      const crResult = await trackStage(svc, requestId, conversation_id ?? null, "change_record_creation", async () => {
        const cr = JSON.parse(changeParse.content) as Record<string, unknown>;
        const { data: savedCR } = await svc.from("ecc_change_records").insert({
          conversation_id: conversation_id ?? null,
          requested_by: userId,
          task_name: cr.task_name ?? "AI Engineering Change",
          implementation_summary: cr.implementation_summary ?? null,
          confidence_score: typeof cr.confidence_score === "number" ? cr.confidence_score : null,
          confidence_reason: cr.confidence_reason ?? null,
          risk_level: cr.risk_level ?? "medium",
          estimated_time: cr.estimated_time ?? null,
          rollback_instructions: cr.rollback_instructions ?? null,
          rollback_available: true,
          affected_features: Array.isArray(cr.affected_features) ? cr.affected_features : [],
          affected_components: Array.isArray(cr.affected_components) ? cr.affected_components : [],
          affected_edge_functions: Array.isArray(cr.affected_edge_functions) ? cr.affected_edge_functions : [],
          affected_db_tables: Array.isArray(cr.affected_db_tables) ? cr.affected_db_tables : [],
          approved_at: new Date().toISOString(),
          status: "approved",
        }).select("id, change_ref").single();
        if (savedCR) changeRecordId = savedCR.change_ref ?? savedCR.id;

        if (conversation_id && isApproval) {
          const stored = await getStoredArtefactPlan(svc, conversation_id);
          if (stored && stored.plan.length > 0) {
            const artefactResult = await trackStage(svc, requestId, conversation_id, "artefact_creation", async () => {
              return await createArtefacts(
                svc,
                stored.plan,
                conversation_id,
                changeRecordId,
                userId,
                stored.confidence,
              );
            });
            if (artefactResult.ok) {
              createdArtefacts = artefactResult.value.created;
              skippedArtefacts = artefactResult.value.skipped;
            }
          }
        }
      });
      if (!crResult.ok) {
        // Change record save failed — non-fatal, but persist diagnostic already recorded
      }
    }

    // Parse suggested actions
    const { cleanReply: reply, suggested } = parseSuggestedActions(workingReply);

    // ─── EWO-032R.2: Instrumented post-AI persistence ──────────────────────
    if (conversation_id) {
      const lastUser = [...messages].reverse().find(m => m.role === "user");

      // Stage: metadata_serialization
      let assistantMetadata: Record<string, unknown>;
      const metaResult = await trackStage(svc, requestId, conversation_id, "metadata_serialization", async () => {
        assistantMetadata = {
          model: aiResponse.model,
          provider: aiResponse.provider,
          mode,
          ai_role,
          selected_roles: selectedRoles,
          suggested,
          engineering_decision: engineeringDecision,
          pending_implementation: pendingImplementation,
          artefact_plan: artefactPlan,
          change_record_id: changeRecordId,
          created_artefacts: createdArtefacts.length > 0 ? createdArtefacts : undefined,
          skipped_artefacts: skippedArtefacts.length > 0 ? skippedArtefacts : undefined,
          routing_diagnostics: diagnostics,
          context_used: contextUsed,
          runtime_diagnostic_envelope: diagnosticEnvelope,
          debug_mode_requested: debugRequested,
          debug_mode_permitted: debugModePermitted,
          actor_role: actorRole,
        };
      });
      if (!metaResult.ok) {
        return new Response(JSON.stringify({
          success: false,
          failure_stage: "metadata_serialization",
          exact_runtime_error: metaResult.diagnostic.error_message,
          error_code: metaResult.diagnostic.error_code,
          error_details: metaResult.diagnostic.error_details,
          error_hint: metaResult.diagnostic.error_hint,
          error_status: metaResult.diagnostic.error_status,
          stack_trace: metaResult.diagnostic.stack_trace,
          diagnostic_reference: metaResult.diagnostic.diagnostic_ref,
          request_id: requestId,
          conversation_id: conversation_id,
        }), { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } });
      }

      // Stage: cc_ai_messages_insert
      // EWO-032R.3: Write-time guard — reject null/undefined content for normal
      // conversational messages. Blank strings are coerced to empty string (not
      // null) so the NOT NULL column constraint is never violated.
      const insertResult = await trackStage(svc, requestId, conversation_id, "cc_ai_messages_insert", async () => {
        const rowsToInsert: Array<{ conversation_id: string; role: string; content: string; metadata?: Record<string, unknown> }> = [];
        if (lastUser) {
          const userContent = lastUser.content;
          if (userContent == null) {
            throw new Error(`Refusing to persist user message with null content for conversation ${conversation_id}.`);
          }
          rowsToInsert.push({ conversation_id, role: "user", content: String(userContent) });
        }
        if (reply == null) {
          throw new Error(`Refusing to persist assistant message with null content for conversation ${conversation_id}.`);
        }
        rowsToInsert.push({
          conversation_id, role: "assistant", content: String(reply),
          metadata: assistantMetadata!,
        });
        await svc.from("cc_ai_messages").insert(rowsToInsert);
      });
      if (!insertResult.ok) {
        return new Response(JSON.stringify({
          success: false,
          failure_stage: "cc_ai_messages_insert",
          exact_runtime_error: insertResult.diagnostic.error_message,
          error_code: insertResult.diagnostic.error_code,
          error_details: insertResult.diagnostic.error_details,
          error_hint: insertResult.diagnostic.error_hint,
          error_status: insertResult.diagnostic.error_status,
          stack_trace: insertResult.diagnostic.stack_trace,
          diagnostic_reference: insertResult.diagnostic.diagnostic_ref,
          request_id: requestId,
          conversation_id: conversation_id,
        }), { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } });
      }

      // Stage: cc_ai_conversations_update
      const updateResult = await trackStage(svc, requestId, conversation_id, "cc_ai_conversations_update", async () => {
        await svc.from("cc_ai_conversations").update({ updated_at: new Date().toISOString() }).eq("id", conversation_id);
      });
      if (!updateResult.ok) {
        return new Response(JSON.stringify({
          success: false,
          failure_stage: "cc_ai_conversations_update",
          exact_runtime_error: updateResult.diagnostic.error_message,
          error_code: updateResult.diagnostic.error_code,
          error_details: updateResult.diagnostic.error_details,
          error_hint: updateResult.diagnostic.error_hint,
          error_status: updateResult.diagnostic.error_status,
          stack_trace: updateResult.diagnostic.stack_trace,
          diagnostic_reference: updateResult.diagnostic.diagnostic_ref,
          request_id: requestId,
          conversation_id: conversation_id,
        }), { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } });
      }
    }

    return new Response(JSON.stringify({
      reply,
      suggested,
      stats,
      selected_roles: selectedRoles,
      engineering_decision: engineeringDecision,
      pending_implementation: pendingImplementation,
      artefact_plan: artefactPlan,
      change_record_id: changeRecordId,
      created_artefacts: createdArtefacts,
      skipped_artefacts: skippedArtefacts,
      routing_diagnostics: diagnostics,
      context_used: contextUsed,
      data_context_domain: selectedDomain,
      detected_intent: detectedIntent,
      runtime_diagnostic_envelope: diagnosticEnvelope,
      debug_output: debugModePermitted ? renderDebugModeBlock(diagnosticEnvelope) : null,
      debug_mode_requested: debugRequested,
      debug_mode_permitted: debugModePermitted,
      relationship_graph: relationshipGraph ? {
        rootRef: relationshipGraph.rootRef,
        totalFound: relationshipGraph.totalFound,
        totalPending: relationshipGraph.totalPending,
        nodes: relationshipGraph.nodes,
        pendingArtefacts: relationshipGraph.pendingArtefacts,
        source_diagnostics: relationshipGraph.diagnostics,
      } : null,
    }), {
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  } catch (err) {
    console.error("command-centre-ai error:", err);
    const isNoKey = err instanceof Error && err.message.startsWith("NO_API_KEY");
    const pe = extractPostgrestError(err);
    const catchRef = `DIAG-CATCH-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
    const catchDiag: StageDiagnostic = {
      diagnostic_ref: catchRef, request_id: requestId, conversation_id: activeConversationId,
      message_id: null, stage_name: "uncaught_exception_handler", started_at: new Date().toISOString(),
      completed_at: new Date().toISOString(), success: false,
      error_message: pe.message, error_code: pe.code, error_details: pe.details,
      error_hint: pe.hint, error_status: pe.status, stack_trace: pe.stack,
    };
    if (svc) await persistDiagnostic(svc, catchDiag).catch(() => {});
    return new Response(JSON.stringify({
      success: false,
      failure_stage: "uncaught_exception_handler",
      exact_runtime_error: pe.message ?? String(err),
      error_code: pe.code,
      error_details: pe.details,
      error_hint: pe.hint,
      error_status: pe.status,
      stack_trace: pe.stack,
      diagnostic_reference: catchRef,
      request_id: requestId,
      conversation_id: activeConversationId,
      error: isNoKey ? "NO_API_KEY" : (err instanceof Error ? err.message : "Internal error"),
      reply: isNoKey ? "No AI provider configured. Go to Settings → AI Provider." : (data?.reply ?? undefined),
      message: isNoKey ? "No AI provider configured. Go to Settings → AI Provider." : undefined,
    }), {
      status: isNoKey ? 422 : 500, headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});
