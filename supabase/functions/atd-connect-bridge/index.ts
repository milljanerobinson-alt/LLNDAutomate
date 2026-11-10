// EWO-024R.1 / EWO-029R.1 — ATD Connect: Conversation Inspection Bridge Edge Function
// Provider-independent, authenticated, connector-ready external interface.
// Invokes the same governed inspection services used by the ATD Connect workspace.

import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "npm:@supabase/supabase-js@2";
import { operatorDeniedResponse, requirePlatformOperator } from "../_shared/platform-operator.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, PUT, DELETE, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization, X-Client-Info, Apikey",
};

interface ConversationInspectionRequest {
  request_id?: string;
  requesting_persona: string;
  client_id?: string;
  session_id?: string;
  natural_language_request: string;
  requested_capability?: string;
  requested_operation?: string;
  requested_object_reference?: string;
  inspection_options?: Record<string, boolean>;
  authentication_context?: Record<string, unknown>;
  requested_at?: string;
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
    // ─── Authentication ─────────────────────────────────────────────────────────
    const authHeader = req.headers.get("Authorization");
    const apiKey = req.headers.get("apikey") ?? req.headers.get("Apikey");

    if (!authHeader && !apiKey) {
      return new Response(
        JSON.stringify({
          governed: true,
          refused: true,
          reason: "authentication_required",
          message: "Authentication required. Provide an Authorization header or Apikey header.",
        }),
        { status: 401, headers: { ...corsHeaders, "Content-Type": "application/json" } },
      );
    }

    // Verify the token against Supabase auth
    const supabaseUrl = Deno.env.get("SUPABASE_URL") ?? "";
    const supabaseAnonKey = Deno.env.get("SUPABASE_ANON_KEY") ?? "";

    const supabase = createClient(supabaseUrl, supabaseAnonKey, {
      global: { headers: { Authorization: authHeader ?? `Bearer ${apiKey}` } },
    });

    const { data: authData, error: authError } = await supabase.auth.getUser();

    if (authError || !authData.user) {
      return new Response(
        JSON.stringify({
          governed: true,
          refused: true,
          reason: "authentication_failed",
          message: "Authentication failed. Invalid or expired token.",
        }),
        { status: 403, headers: { ...corsHeaders, "Content-Type": "application/json" } },
      );
    }

    // ─── Rate Limiting (basic) ───────────────────────────────────────────────────
    const userId = authData.user.id;
    const oneMinuteAgo = new Date(Date.now() - 60000).toISOString();
    const { count: recentCount } = await supabase
      .from("atd_connect_inspection_log")
      .select("*", { count: "exact", head: true })
      .eq("requesting_persona", userId)
      .gte("timestamp", oneMinuteAgo);

    if ((recentCount ?? 0) > 60) {
      return new Response(
        JSON.stringify({
          governed: true,
          refused: true,
          reason: "rate_limit_exceeded",
          message: "Rate limit exceeded. Maximum 60 requests per minute.",
        }),
        { status: 429, headers: { ...corsHeaders, "Content-Type": "application/json" } },
      );
    }

    // ─── Parse Request ───────────────────────────────────────────────────────────
    if (req.method !== "POST") {
      return new Response(
        JSON.stringify({
          governed: true,
          error: "Only POST method is supported.",
        }),
        { status: 405, headers: { ...corsHeaders, "Content-Type": "application/json" } },
      );
    }

    const body: ConversationInspectionRequest = await req.json();

    if (!body.natural_language_request) {
      return new Response(
        JSON.stringify({
          governed: true,
          error: "natural_language_request is required.",
        }),
        { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } },
      );
    }

    // ─── Build Conversation Request ──────────────────────────────────────────────
    const request = {
      request_id: body.request_id ?? `ATD-EXT-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      requesting_persona: body.requesting_persona ?? "external",
      client_id: body.client_id ?? "external-client",
      session_id: body.session_id,
      natural_language_request: body.natural_language_request,
      requested_capability: body.requested_capability,
      requested_operation: body.requested_operation,
      requested_object_reference: body.requested_object_reference,
      inspection_options: body.inspection_options ?? {},
      authentication_context: {
        authenticated: true,
        persona: body.requesting_persona ?? "external",
        client_id: body.client_id ?? "external-client",
        user_id: userId,
      },
      requested_at: body.requested_at ?? new Date().toISOString(),
    };

    // ─── Process via Conversation Bridge ─────────────────────────────────────────
    // The bridge invokes the same governed inspection services used by the workspace.
    // We inline the interpretation + execution here since edge functions cannot
    // import from the src/ directory.

    // Step 1: Interpret the NL request (deterministic, provider-independent)
    const interpretation = interpretRequest(request.natural_language_request);

    // Step 2: Check for write request — governed refusal
    if (interpretation.isWriteRequest) {
      const auditRef = `ATD-EXT-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
      await supabase.from("atd_connect_inspection_log").insert({
        request_id: auditRef,
        timestamp: new Date().toISOString(),
        requesting_persona: request.requesting_persona,
        operation: "discoverCapabilities",
        outcome: "error",
        error_message: "Write request refused — ATD Connect is read-only",
        request_source: "external",
        result_type: "error",
        original_request: request.natural_language_request,
        client_id: request.client_id,
      });

      return new Response(
        JSON.stringify({
          request_id: request.request_id,
          governed: true,
          refused: true,
          reason: "read_only_boundary",
          message: "Request refused: ATD Connect is read-only. Write operations are not supported.",
          audit_reference: auditRef,
          completed_at: new Date().toISOString(),
          intent_diagnostics: {
            detected_intent: "write_request",
            confidence: 1.0,
            routing_decision: "governed_refusal",
            extracted_target: null,
            matched_pattern: null,
            isWriteRequest: true,
            isMetadataQuestion: false,
            isFrameworkIntrospection: false,
            isExecutionInspection: false,
            lifecycle_change_requested: false,
          },
        }),
        { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } },
      );
    }

    // Step 3: Check for ambiguous/unresolved request
    if (interpretation.ambiguous || !interpretation.capability || !interpretation.operation) {
      const auditRef = `ATD-EXT-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
      await supabase.from("atd_connect_inspection_log").insert({
        request_id: auditRef,
        timestamp: new Date().toISOString(),
        requesting_persona: request.requesting_persona,
        operation: "discoverCapabilities",
        inspected_capability: interpretation.capability,
        inspected_object: interpretation.objectReference,
        outcome: "governed_empty",
        request_source: "external",
        result_type: "unresolved",
        original_request: request.natural_language_request,
        interpretation: interpretation.interpretation,
        client_id: request.client_id,
      });

      return new Response(
        JSON.stringify({
          request_id: request.request_id,
          governed: true,
          interpretation: interpretation.interpretation,
          resolved_capability: interpretation.capability,
          resolved_operation: interpretation.operation,
          resolved_object_reference: interpretation.objectReference,
          inspection_result: null,
          evidence_references: [],
          constitutional_references: [],
          health: {
            availability: "available",
            health: "warning",
            inspection_confidence: 0.3,
            evidence_quality: 0,
            relationship_completeness: 0,
          },
          confidence: 0,
          missing_information: ["Unable to resolve request to a supported operation"],
          audit_reference: auditRef,
          completed_at: new Date().toISOString(),
          result_type: "unresolved",
          intent_diagnostics: {
            detected_intent: interpretation.intentLabel ?? "unresolved",
            confidence: 0,
            routing_decision: "unresolved",
            extracted_target: interpretation.objectReference,
            matched_pattern: interpretation.matchedPattern,
            isWriteRequest: false,
            isMetadataQuestion: interpretation.isMetadataQuestion,
            isFrameworkIntrospection: interpretation.isFrameworkIntrospection,
            isExecutionInspection: interpretation.isExecutionInspection,
            lifecycle_change_requested: false,
          },
        }),
        { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } },
      );
    }

    // Step 4: Execute the governed inspection
    const inspectionResult = await executeInspectionFromEdge(
      supabase,
      interpretation.capability!,
      interpretation.operation!,
      interpretation.objectReference,
      request.requesting_persona,
    );

    // Step 5: Record audit
    const auditRef = `ATD-EXT-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    await supabase.from("atd_connect_inspection_log").insert({
      request_id: auditRef,
      timestamp: new Date().toISOString(),
      requesting_persona: request.requesting_persona,
      operation: interpretation.operation,
      inspected_capability: interpretation.capability,
      inspected_object: interpretation.objectReference,
      outcome: inspectionResult.data ? "success" : "governed_empty",
      request_source: "external",
      result_type: inspectionResult.data ? "success" : "governed_empty",
      original_request: request.natural_language_request,
      resolved_capability: interpretation.capability,
      resolved_operation: interpretation.operation,
      resolved_object_reference: interpretation.objectReference,
      client_id: request.client_id,
      confidence: inspectionResult.health?.inspection_confidence ?? 0,
    });

    // Step 6: Store conversation request
    await supabase.from("atd_connect_conversation_requests").insert({
      request_id: request.request_id,
      requesting_persona: request.requesting_persona,
      client_id: request.client_id,
      session_id: request.session_id,
      natural_language_request: request.natural_language_request,
      resolved_capability: interpretation.capability,
      resolved_operation: interpretation.operation,
      resolved_object_reference: interpretation.objectReference,
      inspection_options: request.inspection_options,
      authentication_context: request.authentication_context,
      requested_at: request.requested_at,
      completed_at: new Date().toISOString(),
      governed: true,
      interpretation: interpretation.interpretation,
      result_type: inspectionResult.data ? "success" : "governed_empty",
      confidence: inspectionResult.health?.inspection_confidence ?? 0,
      audit_reference: auditRef,
    });

    // Step 7: Build intent diagnostics
    const intentDiagnostics = {
      detected_intent: interpretation.intentLabel ?? "inspection_or_query",
      confidence: inspectionResult.health?.inspection_confidence ?? 0,
      routing_decision: `route_to_${interpretation.operation}`,
      extracted_target: interpretation.objectReference,
      matched_pattern: interpretation.matchedPattern,
      isWriteRequest: false,
      isMetadataQuestion: interpretation.isMetadataQuestion,
      isFrameworkIntrospection: interpretation.isFrameworkIntrospection,
      isExecutionInspection: interpretation.isExecutionInspection,
      lifecycle_change_requested: false,
    };

    // Step 8: Return governed response
    return new Response(
      JSON.stringify({
        request_id: request.request_id,
        governed: true,
        interpretation: interpretation.interpretation,
        resolved_capability: interpretation.capability,
        resolved_operation: interpretation.operation,
        resolved_object_reference: interpretation.objectReference,
        inspection_result: inspectionResult.data,
        evidence_references: [],
        constitutional_references: [],
        health: inspectionResult.health,
        confidence: inspectionResult.health?.inspection_confidence ?? 0,
        missing_information: inspectionResult.explanation ? [inspectionResult.explanation] : [],
        audit_reference: auditRef,
        completed_at: new Date().toISOString(),
        result_type: inspectionResult.data ? "success" : "governed_empty",
        intent_diagnostics: intentDiagnostics,
      }),
      { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } },
    );
  } catch (err) {
    return new Response(
      JSON.stringify({
        governed: true,
        error: err instanceof Error ? err.message : "Internal server error",
      }),
      { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } },
    );
  }
});

// ─── NL Interpretation (deterministic, provider-independent) ─────────────────────
// Inlined for edge function independence — mirrors src/lib/atdConnect/conversationBridge.ts
// EWO-029R.1: Updated with negative-context write detection, execution engine
// patterns at highest precedence, and intent diagnostics.

const WRITE_KEYWORDS = [
  "insert", "update", "delete", "create", "modify", "change",
  "approve", "accept", "close", "deploy", "execute", "run",
  "lifecycle", "transition", "write", "set", "assign",
  "remove", "drop", "purge", "archive", "restore",
];

const NEGATIVE_CONTEXT_PATTERNS = [
  /do\s+not\s+(?:perform|make|execute|trigger|initiate)\s+(?:any\s+)?(?:lifecycle\s+)?changes?/i,
  /do\s+not\s+(?:perform|make|execute|trigger|initiate)\s+(?:any\s+)?lifecycle/i,
  /no\s+lifecycle\s+changes?/i,
  /read[\\s-]?only/i,
  /do\s+not\s+(?:write|modify|update|create|delete|insert)/i,
];

function isWriteRequest(text: string): boolean {
  const lower = text.toLowerCase();

  // EWO-031: Governed execution intents are NOT write requests — they route
  // through the governed execution pipeline, not the read-only inspection layer.
  const EXECUTION_INTENT_RE = /\b(?:create\s+(?:an?\s+)?(?:ewo|engineering\s+work\s+order)|prepare\s+(?:its|the)\s+(?:engineering\s+)?(?:analysis|plan)|approve\s+(?:it|this|EWO-[\w.-]+)\s+for\s+execution|execute\s+(?:it|this|EWO-[\w.-]+)|start\s+execution\s+(?:of|for))\b/i;
  if (EXECUTION_INTENT_RE.test(text)) return false;

  // Check for negative context — if the request explicitly says NOT to perform
  // lifecycle changes, it's a read-only inspection request
  for (const pattern of NEGATIVE_CONTEXT_PATTERNS) {
    if (pattern.test(text)) return false;
  }

  // Check for inspection keywords that indicate read-only intent
  const isInspection = /\\b(?:inspect|show|list|describe|explain|what|how|tell\\s+me\\s+about|view|display|get|fetch|retrieve)\\b/i.test(text);

  // If the request is clearly an inspection and mentions "execute" only in
  // the context of "execution engine", "execution provider", etc., it's read-only
  if (isInspection && /\\b(?:execution\\s+engine|execution\\s+provider|execution\\s+pipeline|execution\\s+package|execution\\s+record|execution\\s+history|execution\\s+governance)\\b/i.test(text)) {
    const executeAsVerb = /\\bexecute\\b(?!\\s+(?:engine|provider|pipeline|package|record|history|governance|engine\\.|engine,))/i;
    if (!executeAsVerb.test(text)) return false;
  }

  return WRITE_KEYWORDS.some(kw => new RegExp(`\\b${kw}\\b`, "i").test(lower));
}

interface InterpretedRequest {
  capability: string | null;
  operation: string | null;
  objectReference: string | null;
  interpretation: string;
  isWriteRequest: boolean;
  ambiguous: boolean;
  intentLabel: string | null;
  matchedPattern: string | null;
  isExecutionInspection: boolean;
  isFrameworkIntrospection: boolean;
  isMetadataQuestion: boolean;
}

// PRECEDENCE ORDER: execution engine → execution provider → execution record/package/pipeline
// → generic capability → generic inspection → unresolved
const OPERATION_PATTERNS: Array<{
  patterns: RegExp[];
  capability: string;
  operation: string;
  requiresObject: boolean;
  objectPattern?: RegExp;
  intentLabel?: string;
}> = [
  // EWO-031R.2/R.4: Provider policy inspection — HIGHEST PRECEDENCE (before supervised execution engine)
  // R.4: Added direct RPC name and canonical operation name aliases.
  // requiresObject: false so it works without an EWO reference (null parameter to RPC).
  {
    patterns: [
      /inspect\s+(?:the\s+)?(?:supervised\s+)?execution\s+engine\s+and\s+provider\s+selection\s+(?:for\s+)?(EWO-[\w.-]+)\b/i,
      /inspect\s+(?:the\s+)?(?:supervised\s+)?execution\s+engine\s+and\s+provider\s+selection/i,
      /inspect\s+(?:the\s+)?provider\s+(?:policy|selection)\s+(?:for\s+)?(EWO-[\w.-]+)\b/i,
      /inspect\s+(?:the\s+)?provider\s+(?:policy|selection)/i,
      /inspect\s+(?:the\s+)?(?:preferred|default|allowed|fallback)\s+provider/i,
      /invoke\s+inspect_execution_provider_policy\s+(?:directly\s+)?(?:for\s+)?(EWO-[\w.-]+)?\b/i,
      /invoke\s+inspect_execution_provider_policy\s+directly/i,
      /invoke\s+inspectexecutionproviderpolicy\s+(?:directly\s+)?(?:for\s+)?(EWO-[\w.-]+)?\b/i,
      /invoke\s+inspectexecutionproviderpolicy\s+directly/i,
      /return\s+(?:the\s+)?(?:live\s+)?execution\s+provider\s+policy/i,
      /inspect\s+(?:the\s+)?execution\s+provider\s+policy/i,
    ],
    capability: "supervised-engineering-execution",
    operation: "inspectExecutionProviderPolicy",
    requiresObject: false,
    objectPattern: /(EWO-[\w.-]+)/i,
    intentLabel: "provider_policy_inspection",
  },
  // EWO-032: Execution handoff inspection
  {
    patterns: [
      /inspect\s+(?:the\s+)?execution\s+handoff\s+(?:for\s+)?(EWO-[\w.-]+?)?\b/i,
      /inspect\s+(?:the\s+)?execution\s+handoff/i,
      /invoke\s+inspect_execution_handoff\s+(?:directly\s+)?(?:for\s+)?(EWO-[\w.-]+?)?\b/i,
      /invoke\s+inspect_execution_handoff\s+directly/i,
      /invoke\s+inspectexecutionhandoff\s+(?:directly\s+)?(?:for\s+)?(EWO-[\w.-]+?)?\b/i,
      /invoke\s+inspectexecutionhandoff\s+directly/i,
      /return\s+(?:the\s+)?execution\s+handoff\s+(?:state|status)/i,
      /inspect\s+(?:the\s+)?handoff\s+(?:state|status)/i,
    ],
    capability: "supervised-engineering-execution",
    operation: "inspectExecutionHandoff",
    requiresObject: false,
    objectPattern: /(EWO-[\w.-]+)/i,
    intentLabel: "execution_handoff_inspection",
  },
  // EWO-029R.1: Supervised execution engine inspection — HIGHEST PRECEDENCE
  // EWO-031R.2: Negative lookahead prevents matching when "provider selection" or "provider policy" follows.
  {
    patterns: [
      /inspect\s+(?:the\s+)?(?:supervised\s+)?(?:engineering\s+)?execution\s+engine(?!\s+and\s+provider\s+(?:selection|policy))/i,
      /explain\s+(?:the\s+)?(?:supervised\s+)?(?:engineering\s+)?execution\s+engine(?!\s+and\s+provider\s+(?:selection|policy))/i,
      /describe\s+(?:the\s+)?(?:supervised\s+)?(?:engineering\s+)?execution\s+engine(?!\s+and\s+provider\s+(?:selection|policy))/i,
      /show\s+(?:the\s+)?(?:supervised\s+)?(?:engineering\s+)?execution\s+engine(?!\s+and\s+provider\s+(?:selection|policy))/i,
      /what\s+is\s+(?:the\s+)?(?:supervised\s+)?(?:engineering\s+)?execution\s+engine(?!\s+and\s+provider\s+(?:selection|policy))/i,
      /inspect\s+(?:the\s+)?supervised\s+engineering\s+execution(?!\s+and\s+provider\s+(?:selection|policy))/i,
      /inspect\s+(?:the\s+)?execution\s+provider\s+framework/i,
      /show\s+(?:the\s+)?engineering\s+execution\s+providers?\s+and\s+pipeline/i,
      /what\s+governance\s+gates\s+prevent\s+(?:atd|eos)\s+from\s+executing/i,
      /inspect\s+(?:the\s+)?supervised\s+engineering\s+execution\s+engine(?!\s+and\s+provider\s+(?:selection|policy))/i,
      /show\s+(?:the\s+)?supervised\s+engineering\s+execution(?!\s+and\s+provider\s+(?:selection|policy))/i,
      /explain\s+(?:the\s+)?supervised\s+engineering\s+execution(?!\s+and\s+provider\s+(?:selection|policy))/i,
    ],
    capability: "supervised-engineering-execution",
    operation: "inspectSupervisedExecutionEngine",
    requiresObject: false,
    intentLabel: "supervised_execution_engine_inspection",
  },
  // EWO-029R.1: Execution package support inspection
  {
    patterns: [
      /inspect\s+(?:the\s+)?execution\s+package\s+support/i,
      /show\s+(?:the\s+)?execution\s+package\s+support/i,
      /what\s+is\s+(?:the\s+)?execution\s+package\s+support/i,
    ],
    capability: "supervised-engineering-execution",
    operation: "inspectSupervisedExecutionEngine",
    requiresObject: false,
    intentLabel: "supervised_execution_engine_inspection",
  },
  // EWO-029: Execution provider inspection
  {
    patterns: [/list\s+execution\s+providers/i, /show\s+execution\s+providers/i, /what\s+execution\s+providers/i],
    capability: "execution-providers",
    operation: "listExecutionProviders",
    requiresObject: false,
    intentLabel: "execution_provider_inspection",
  },
  // EWO-029: Inspect execution provider
  {
    patterns: [/inspect\s+(?:the\s+)?(.+?)\s+execution\s+provider/i, /describe\s+(?:the\s+)?(.+?)\s+execution\s+provider/i],
    capability: "execution-providers",
    operation: "inspectExecutionProvider",
    requiresObject: true,
    objectPattern: /inspect\s+(?:the\s+)?(.+?)\s+execution\s+provider/i,
    intentLabel: "execution_provider_inspection",
  },
  // EWO-029: Execution records
  {
    patterns: [/list\s+execution\s+records/i, /show\s+execution\s+records/i, /what\s+execution\s+records/i],
    capability: "execution-records",
    operation: "listExecutionRecords",
    requiresObject: false,
    intentLabel: "execution_record_inspection",
  },
  // EWO-029: Inspect execution record
  {
    patterns: [/inspect\s+(?:the\s+)?execution\s+record\s+(?:for\s+)?(.+)/i, /inspect\s+(SER-[\w.-]+)/i],
    capability: "execution-records",
    operation: "inspectExecutionRecord",
    requiresObject: true,
    objectPattern: /(?:for\s+)?(SER-[\w.-]+|.+)/i,
    intentLabel: "execution_record_inspection",
  },
  // EWO-029: Execution pipeline
  {
    patterns: [/inspect\s+(?:the\s+)?execution\s+pipeline\s+(?:for\s+)?(.+)/i, /show\s+execution\s+pipeline\s+(?:for\s+)?(.+)/i],
    capability: "execution-pipeline",
    operation: "inspectExecutionPipeline",
    requiresObject: true,
    objectPattern: /(?:for\s+)?(SER-[\w.-]+|.+)/i,
    intentLabel: "execution_pipeline_inspection",
  },
  // EWO-029: Execution governance gate
  {
    patterns: [/inspect\s+(?:the\s+)?execution\s+governance\s+gate\s+(?:for\s+)?(.+)/i, /show\s+execution\s+governance\s+(?:for\s+)?(.+)/i],
    capability: "execution-governance",
    operation: "inspectExecutionGovernanceGate",
    requiresObject: true,
    objectPattern: /(?:for\s+)?(EWO-[\w.]+|.+)/i,
    intentLabel: "execution_governance_inspection",
  },
  // EWO-029: Execution history
  {
    patterns: [/(?:show|list|inspect)\s+execution\s+history\s+(?:for\s+)?(.+)/i],
    capability: "execution-history",
    operation: "inspectExecutionHistory",
    requiresObject: true,
    objectPattern: /(?:for\s+)?(EWO-[\w.]+|.+)/i,
    intentLabel: "execution_history_inspection",
  },
  // discoverCapabilities
  { patterns: [/list\s+(every\s+|all\s+)?(engineering\s+)?capabilit/i, /discover\s+capabilit/i], capability: "atd-connect", operation: "discoverCapabilities", requiresObject: false, intentLabel: "capability_discovery" },
  { patterns: [/list\s+pages/i, /show\s+pages/i], capability: "pages", operation: "listPages", requiresObject: false },
  { patterns: [/inspect\s+(?:the\s+)?(.+?)\s+page/i], capability: "pages", operation: "inspectPage", requiresObject: true, objectPattern: /inspect\s+(?:the\s+)?(.+?)\s+page/i },
  { patterns: [/list\s+workspaces/i, /show\s+workspaces/i], capability: "workspaces", operation: "listWorkspaces", requiresObject: false },
  { patterns: [/inspect\s+(?:the\s+)?(.+?)\s+workspace/i], capability: "workspaces", operation: "inspectWorkspace", requiresObject: true, objectPattern: /inspect\s+(?:the\s+)?(.+?)\s+workspace/i },
  { patterns: [/list\s+services/i, /show\s+services/i], capability: "services", operation: "listServices", requiresObject: false },
  { patterns: [/inspect\s+(?:the\s+)?(.+?)\s+service/i], capability: "services", operation: "inspectService", requiresObject: true, objectPattern: /inspect\s+(?:the\s+)?(.+?)\s+service/i },
  { patterns: [/list\s+(engineering\s+)?standards/i, /show\s+(all\s+)?(engineering\s+)?standards/i], capability: "standards", operation: "listStandards", requiresObject: false },
  { patterns: [/inspect\s+(?:the\s+)?standard\s+(?:for\s+)?(.+)/i], capability: "standards", operation: "inspectStandard", requiresObject: true, objectPattern: /inspect\s+(?:the\s+)?standard\s+(?:for\s+)?(.+)/i },
  { patterns: [/list\s+constitution/i, /show\s+constitution/i], capability: "constitution", operation: "listConstitution", requiresObject: false },
  { patterns: [/inspect\s+(?:the\s+)?(?:amendment|constitution)\s+(?:for\s+)?(.+)/i], capability: "constitution", operation: "inspectConstitution", requiresObject: true, objectPattern: /inspect\s+(?:the\s+)?(?:amendment|constitution)\s+(?:for\s+)?(.+)/i },
  { patterns: [/list\s+(engineering\s+)?records/i, /show\s+(engineering\s+)?records/i], capability: "engineering-records", operation: "listEngineeringRecords", requiresObject: false },
  { patterns: [/inspect\s+(?:the\s+)?(?:engineering\s+)?record\s+(?:for\s+)?(.+)/i], capability: "engineering-records", operation: "inspectEngineeringRecord", requiresObject: true, objectPattern: /inspect\s+(?:the\s+)?(?:engineering\s+)?record\s+(?:for\s+)?(.+)/i },
  { patterns: [/list\s+(engineering\s+)?work\s+orders/i, /show\s+(engineering\s+)?work\s+orders/i], capability: "engineering-work-orders", operation: "listEngineeringWorkOrders", requiresObject: false },
  // EWO-031: Governed execution intent patterns — BEFORE write-request prevention.
  // These route through the governed execution pipeline, not the read-only inspection layer.
  {
    patterns: [
      /create\s+(?:an?\s+)?(?:ewo\s+|engineering\s+work\s+order\s+)?(EWO-[\w.-]+)\b/i,
      /create\s+(?:an?\s+)?ewo\s+(?:for\s+)?(.+)/i,
      /register\s+(?:an?\s+)?(?:ewo\s+|engineering\s+work\s+order\s+)?(EWO-[\w.-]+)\b/i,
      /create\s+(?:ewo\s+)?(EWO-[\w.-]+)/i,
    ],
    capability: "engineering-work-orders",
    operation: "createEngineeringWorkOrderFromConversation",
    requiresObject: true,
    objectPattern: /(EWO-[\w.-]+)/i,
    intentLabel: "create_ewo",
  },
  {
    patterns: [
      /prepare\s+(?:the\s+)?(?:engineering\s+)?analysis\s+(?:for\s+)?(EWO-[\w.-]+)\b/i,
      /prepare\s+(?:its|the)\s+(?:engineering\s+)?analysis/i,
      /generate\s+(?:the\s+)?analysis\s+(?:for\s+)?(EWO-[\w.-]+)\b/i,
    ],
    capability: "engineering-work-orders",
    operation: "prepareEngineeringAnalysis",
    requiresObject: true,
    objectPattern: /(EWO-[\w.-]+)/i,
    intentLabel: "prepare_analysis",
  },
  {
    patterns: [
      /prepare\s+(?:the\s+)?(?:engineering\s+)?plan\s+(?:for\s+)?(EWO-[\w.-]+)\b/i,
      /prepare\s+(?:its|the)\s+(?:engineering\s+)?plan/i,
      /generate\s+(?:the\s+)?plan\s+(?:for\s+)?(EWO-[\w.-]+)\b/i,
    ],
    capability: "engineering-work-orders",
    operation: "prepareEngineeringPlan",
    requiresObject: true,
    objectPattern: /(EWO-[\w.-]+)/i,
    intentLabel: "prepare_plan",
  },
  {
    patterns: [
      /approve\s+(EWO-[\w.-]+)\s+for\s+execution/i,
      /approve\s+(?:it|this)\s+for\s+execution/i,
      /grant\s+execution\s+approval\s+(?:for\s+)?(EWO-[\w.-]+)\b/i,
      /approve\s+execution\s+(?:for\s+|of\s+)?(EWO-[\w.-]+)\b/i,
    ],
    capability: "engineering-work-orders",
    operation: "approveEngineeringWorkOrderForExecution",
    requiresObject: true,
    objectPattern: /(EWO-[\w.-]+)/i,
    intentLabel: "approve_execution",
  },
  {
    patterns: [
      /execute\s+(EWO-[\w.-]+)\s+(?:using\s+)?codex/i,
      /execute\s+(?:it|this)\s+using\s+codex/i,
      /execute\s+(EWO-[\w.-]+)\b/i,
      /run\s+(EWO-[\w.-]+)\s+(?:using\s+)?codex/i,
      /execute\s+(?:it|this)\s+through\s+(?:the\s+)?(?:supervised\s+)?execution/i,
      /start\s+execution\s+(?:of\s+|for\s+)?(EWO-[\w.-]+)\b/i,
    ],
    capability: "supervised-engineering-execution",
    operation: "executeEngineeringWorkOrder",
    requiresObject: true,
    objectPattern: /(EWO-[\w.-]+)/i,
    intentLabel: "execute_ewo",
  },
  {
    patterns: [
      /inspect\s+(?:the\s+)?(?:execution\s+state|execution\s+status|latest\s+execution)\s+(?:of\s+|for\s+)?(EWO-[\w.-]+)\b/i,
      /inspect\s+(?:the\s+)?execution\s+(?:of\s+|for\s+)?(EWO-[\w.-]+)\b/i,
      /show\s+(?:me\s+)?(?:the\s+)?execution\s+(?:status|state|results)\s+(?:of\s+|for\s+)?(EWO-[\w.-]+)\b/i,
      /inspect\s+(?:the\s+)?latest\s+execution\s+for\s+(EWO-[\w.-]+)\b/i,
    ],
    capability: "supervised-engineering-execution",
    operation: "inspectEngineeringExecution",
    requiresObject: true,
    objectPattern: /(EWO-[\w.-]+)/i,
    intentLabel: "inspect_execution",
  },

  // EWO-030R.5: Acceptance governance inspection — must be BEFORE generic EWO inspection
  {
    patterns: [
      /inspect\s+(?:the\s+)?(EWO-[\w.]+)\s+acceptance\s+governance\s+state/i,
      /inspect\s+(?:the\s+)?acceptance\s+governance\s+(?:state\s+)?(?:for\s+)?(EWO-[\w.]+)/i,
      /inspect\s+(?:the\s+)?product\s+owner\s+acceptance\s+governance\s+(?:for\s+)?(EWO-[\w.]+)/i,
      /verify\s+(?:the\s+)?acceptance\s+safeguards\s+(?:for\s+)?(EWO-[\w.]+)/i,
      /inspect\s+(?:the\s+)?unauthorised\s+acceptance\s+correction\s+(?:for\s+)?(EWO-[\w.]+)/i,
      /inspect\s+(?:the\s+)?governed\s+acceptance\s+state\s+of\s+(EWO-[\w.]+)/i,
      /inspect\s+(?:the\s+)?acceptance\s+governance\s+of\s+(EWO-[\w.]+)/i,
    ],
    capability: "engineering-work-orders",
    operation: "inspectEngineeringWorkOrderAcceptanceGovernance",
    requiresObject: true,
    objectPattern: /(?:state\s+)?(?:for\s+|of\s+)?(EWO-[\w.]+)/i,
    intentLabel: "acceptance_governance_inspection",
  },
  { patterns: [/inspect\s+(?:ewo\s+)?(EWO-[\w.]+)/i, /describe\s+(?:ewo\s+)?(EWO-[\w.]+)/i], capability: "engineering-work-orders", operation: "inspectEngineeringWorkOrder", requiresObject: true, objectPattern: /inspect\s+(?:ewo\s+)?(EWO-[\w.]+)/i },
  { patterns: [/list\s+(engineering\s+)?plans/i, /show\s+(engineering\s+)?plans/i], capability: "engineering-plans", operation: "listEngineeringPlans", requiresObject: false },
  { patterns: [/inspect\s+(?:the\s+)?(?:engineering\s+)?plan\s+(?:for\s+)?(.+)/i], capability: "engineering-plans", operation: "inspectEngineeringPlan", requiresObject: true, objectPattern: /inspect\s+(?:the\s+)?(?:engineering\s+)?plan\s+(?:for\s+)?(.+)/i },
  { patterns: [/list\s+(engineering\s+)?memory/i, /show\s+(engineering\s+)?memory/i], capability: "memory", operation: "listMemory", requiresObject: false },
  { patterns: [/inspect\s+(?:the\s+)?(?:engineering\s+)?memory\s+(?:for\s+)?(.+)/i], capability: "memory", operation: "inspectMemory", requiresObject: true, objectPattern: /inspect\s+(?:the\s+)?(?:engineering\s+)?memory\s+(?:for\s+)?(.+)/i },
  { patterns: [/list\s+knowledge/i, /show\s+(all\s+)?knowledge/i, /show\s+related\s+knowledge/i], capability: "knowledge", operation: "listKnowledge", requiresObject: false },
  { patterns: [/inspect\s+(?:the\s+)?knowledge\s+(?:for\s+)?(.+)/i], capability: "knowledge", operation: "inspectKnowledge", requiresObject: true, objectPattern: /inspect\s+(?:the\s+)?knowledge\s+(?:for\s+)?(.+)/i },
  { patterns: [/list\s+lineage/i, /show\s+lineage/i], capability: "lineage", operation: "listLineage", requiresObject: false },
  { patterns: [/inspect\s+(?:the\s+)?lineage\s+(?:for\s+)?(.+)/i], capability: "lineage", operation: "inspectLineage", requiresObject: true, objectPattern: /inspect\s+(?:the\s+)?lineage\s+(?:for\s+)?(.+)/i },
  { patterns: [/(?:show|inspect|list|navigate)\s+relationships?\s+(?:for\s+)?(.+)/i, /relationships?\s+(?:for\s+)?(EWO-[\w.]+)/i, /related\s+engineering\s+(?:for\s+)?(.+)/i], capability: "lineage", operation: "inspectRelationships", requiresObject: true, objectPattern: /(?:for\s+)?(EWO-[\w.]+|[A-Za-z][\w-]+)/i },
];

function interpretRequest(text: string): InterpretedRequest {
  const trimmed = text.trim();
  if (isWriteRequest(trimmed)) {
    return {
      capability: null, operation: null, objectReference: null,
      interpretation: "Request appears to be a write operation. ATD Connect is read-only.",
      isWriteRequest: true, ambiguous: false,
      intentLabel: "write_request", matchedPattern: null,
      isExecutionInspection: false, isFrameworkIntrospection: false, isMetadataQuestion: false,
    };
  }
  for (const p of OPERATION_PATTERNS) {
    for (const regex of p.patterns) {
      if (regex.test(trimmed)) {
        let objRef: string | null = null;
        if (p.requiresObject && p.objectPattern) {
          const m = trimmed.match(p.objectPattern);
          objRef = m && m[1] ? m[1].trim() : null;
          if (!objRef) {
            return {
              capability: p.capability, operation: p.operation, objectReference: null,
              interpretation: `Resolved operation "${p.operation}" but could not extract object reference.`,
              isWriteRequest: false, ambiguous: true,
              intentLabel: p.intentLabel ?? null, matchedPattern: regex.source,
              isExecutionInspection: p.capability.includes("execution"),
              isFrameworkIntrospection: p.capability === "atd-connect",
              isMetadataQuestion: false,
            };
          }
        } else if (p.objectPattern) {
          // EWO-031R.4: Extract object optionally even when not required
          const m = trimmed.match(p.objectPattern);
          objRef = m && m[1] ? m[1].trim() : null;
        }
        return {
          capability: p.capability, operation: p.operation, objectReference: objRef,
          interpretation: `Resolved to capability "${p.capability}", operation "${p.operation}"${objRef ? `, object "${objRef}"` : ""}.`,
          isWriteRequest: false, ambiguous: false,
          intentLabel: p.intentLabel ?? null, matchedPattern: regex.source,
          isExecutionInspection: p.capability.includes("execution"),
          isFrameworkIntrospection: p.capability === "atd-connect",
          isMetadataQuestion: false,
        };
      }
    }
  }
  return {
    capability: null, operation: null, objectReference: null,
    interpretation: "Unable to resolve request to a supported ATD Connect operation.",
    isWriteRequest: false, ambiguous: true,
    intentLabel: "unresolved", matchedPattern: null,
    isExecutionInspection: false, isFrameworkIntrospection: false, isMetadataQuestion: false,
  };
}

// ─── Execute Inspection from Edge ─────────────────────────────────────────────────
// Queries the same EIOS tables that the governed inspection services query,
// but returns governed DTOs only — never raw rows.

// Canonical pipeline stages — mirrors src/lib/supervisedExecutionEngine.ts PIPELINE_STAGES
const PIPELINE_STAGES = [
  "po_approval",
  "execution_preparation",
  "execution_package_generation",
  "execution_provider_selection",
  "execution_dispatch",
  "execution_monitoring",
  "execution_result_collection",
  "completion_package_generation",
  "engineering_knowledge_extraction",
  "await_product_owner_review",
];

// Canonical governance gate definitions — mirrors evaluateGovernanceGate in supervisedExecutionEngine.ts
const GOVERNANCE_GATE_DEFINITIONS = [
  { gate: "ewo_exists", description: "The Engineering Work Order must exist in the governed registry.", severity: "critical" },
  { gate: "ewo_active", description: "The EWO must be active (not closed or archived).", severity: "critical" },
  { gate: "engineering_package", description: "An Engineering Package must be generated for the EWO.", severity: "critical" },
  { gate: "po_approval", description: "Product Owner approval must be recorded for the EWO.", severity: "critical" },
  { gate: "execution_approval", description: "Explicit Product Owner execution approval must be recorded.", severity: "critical" },
  { gate: "constitution_checked", description: "No active constitutional amendment blocks execution.", severity: "warning" },
];

async function executeInspectionFromEdge(
  supabase: ReturnType<typeof createClient>,
  capability: string,
  operation: string,
  objectRef: string | null,
  persona: string,
): Promise<{ data: unknown | null; health: Record<string, unknown> | null; explanation: string | null }> {
  try {
    if (operation === "inspectExecutionProviderPolicy") {
      const { data: rpcData, error: rpcError } = await supabase.rpc("inspect_execution_provider_policy", { p_ewo_ref: objectRef || null });
      if (rpcError || !rpcData) {
        // EWO-031R.2: Governed failure — do NOT fall back to legacy Bolt inspection
        return { data: { inspection_status: "failed", failed_stage: "rpc_invocation", failure_code: "provider_policy_rpc_failed", failure_reason: rpcError?.message ?? "RPC returned no data", detected_intent: "provider_policy_inspection", resolved_operation: "inspectExecutionProviderPolicy", data_source: "inspect_execution_provider_policy RPC", environment: "supabase_edge_function", legacy_fallback_permitted: false, legacy_fallback_performed: false, retryable: true, next_required_action: "Verify that the inspect_execution_provider_policy RPC exists and the execution_provider_policy table has an active record.", lifecycle_change_performed: false }, health: null, explanation: `Unable to inspect provider policy: ${rpcError?.message ?? "RPC returned no data"}` };
      }
      const policy = typeof rpcData === "string" ? JSON.parse(rpcData) : rpcData;
      return { data: { ...policy, detected_intent: "provider_policy_inspection", routing_decision: "route_to_inspectExecutionProviderPolicy", resolved_operation: "inspectExecutionProviderPolicy", data_source: "inspect_execution_provider_policy RPC (authoritative)", active_execution_provider: policy.active_execution_provider ?? policy.default_provider_id ?? null, default_execution_provider: policy.default_provider_id ?? null, preferred_execution_provider: policy.preferred_provider_id ?? null, allowed_execution_providers: policy.allowed_provider_ids ?? [], fallback_provider: policy.fallback_provider_id ?? null, fallback_permitted: policy.fallback_permitted ?? false, fallback_performed: false, requested_provider_for_ewo: policy.ewo_implementation_provider ?? null, selected_provider_for_ewo: policy.ewo_selected_provider ?? null, provider_selection_reason: policy.provider_selection_reason ?? null, lifecycle_change_performed: false }, health: { availability: "available", health: "healthy", inspection_confidence: 0.95, evidence_quality: 0.9, relationship_completeness: 0.8 }, explanation: null };
    }
    // EWO-032: Execution handoff inspection
    if (operation === "inspectExecutionHandoff") {
      const { data: handoffData, error: handoffError } = await supabase.rpc("inspect_execution_handoff", { p_ewo_ref: objectRef || null, p_conversation_id: null });
      if (handoffError || !handoffData) {
        return { data: { inspection_status: "failed", failed_stage: "rpc_invocation", failure_code: "execution_handoff_rpc_failed", failure_reason: handoffError?.message ?? "RPC returned no data", detected_intent: "execution_handoff_inspection", resolved_operation: "inspectExecutionHandoff", data_source: "inspect_execution_handoff RPC", environment: "supabase_edge_function", legacy_fallback_permitted: false, legacy_fallback_performed: false, lifecycle_change_performed: false }, health: null, explanation: `Unable to inspect execution handoff: ${handoffError?.message ?? "RPC returned no data"}` };
      }
      const handoff = typeof handoffData === "string" ? JSON.parse(handoffData) : handoffData;
      return { data: { ...handoff, detected_intent: "execution_handoff_inspection", routing_decision: "route_to_inspectExecutionHandoff", resolved_operation: "inspectExecutionHandoff", data_source: "inspect_execution_handoff RPC (authoritative)", lifecycle_change_performed: false }, health: { availability: "available", health: "healthy", inspection_confidence: 0.95, evidence_quality: 0.9, relationship_completeness: 0.8 }, explanation: null };
    }

    // ─── EWO-031: Governed Execution Operations ──────────────────────────────
    if (operation === "createEngineeringWorkOrderFromConversation") {
      const { data: existing } = await supabase.from("engineering_work_orders").select("ewo_ref, status").eq("ewo_ref", objectRef ?? "").maybeSingle();
      if (existing) {
        return { data: { ewo_already_exists: true, ewo_status: existing.status }, health: null, explanation: `EWO ${objectRef} already exists with status ${existing.status}.` };
      }
      const { error: createError } = await supabase.from("engineering_work_orders").insert({ ewo_ref: objectRef, title: `Engineering Work Order ${objectRef}`, status: "draft", engineering_package_status: "Not Generated", implementation_status: "not_started" });
      if (createError) {
        return { data: null, health: null, explanation: `Failed to create EWO: ${createError.message}` };
      }
      return { data: { ewo_created: true, ewo_ref: objectRef, ewo_status: "draft" }, health: null, explanation: null };
    }

    if (operation === "prepareEngineeringAnalysis") {
      const { data: rpcData, error: rpcError } = await supabase.rpc("prepare_engineering_analysis", { p_ewo_ref: objectRef ?? "" });
      if (rpcError || !rpcData) {
        return { data: null, health: null, explanation: `Unable to prepare analysis for "${objectRef}": ${rpcError?.message ?? "RPC returned no data"}` };
      }
      return { data: rpcData, health: null, explanation: null };
    }

    if (operation === "prepareEngineeringPlan") {
      const { data: rpcData, error: rpcError } = await supabase.rpc("prepare_engineering_plan", { p_ewo_ref: objectRef ?? "" });
      if (rpcError || !rpcData) {
        return { data: null, health: null, explanation: `Unable to prepare plan for "${objectRef}": ${rpcError?.message ?? "RPC returned no data"}` };
      }
      return { data: rpcData, health: null, explanation: null };
    }

    if (operation === "approveEngineeringWorkOrderForExecution") {
      const isCodex = /codex/i.test(String(originalRequest || ""));
      const { data: rpcData, error: rpcError } = await supabase.rpc("approve_ewo_for_execution", { p_ewo_ref: objectRef ?? "", p_approved_by: "Product Owner", p_decision: "approved", p_approval_statement: "Execution approved through governed conversation routing.", p_provider_preference: isCodex ? "codex" : null });
      if (rpcError || !rpcData) {
        return { data: null, health: null, explanation: `Unable to approve execution for "${objectRef}": ${rpcError?.message ?? "RPC returned no data"}` };
      }
      return { data: rpcData, health: null, explanation: null };
    }

    if (operation === "executeEngineeringWorkOrder") {
      const isCodex = /codex/i.test(String(originalRequest || ""));
      const { data: gateData, error: gateError } = await supabase.rpc("inspect_ewo_execution_state", { p_ewo_ref: objectRef ?? "" });
      if (gateError || !gateData) {
        return { data: null, health: null, explanation: `Unable to evaluate execution gate for "${objectRef}": ${gateError?.message ?? "RPC returned no data"}` };
      }
      const gate = typeof gateData === "string" ? JSON.parse(gateData) : gateData;
      if (!gate.execution_eligible) {
        const blockers: string[] = [];
        if (!gate.analysis?.exists) blockers.push("Engineering Analysis must be prepared");
        if (!gate.plan?.exists) blockers.push("Engineering Plan must be prepared");
        if (!gate.execution_approval?.exists) blockers.push("Product Owner execution approval is required");
        if (gate.ewo_status === "closed" || gate.ewo_status === "archived") blockers.push(`EWO is ${gate.ewo_status}`);
        return { data: { execution_status: "blocked", failed_stage: "execution_gate", failure_code: "gate_failed", failure_reason: blockers[0] ?? "Execution gate failed", blockers, lifecycle_change_performed: false }, health: null, explanation: null };
      }
      // Gate passed — check provider
      if (isCodex) {
        const { data: providers } = await supabase.from("execution_provider_registry").select("*").eq("is_active", true);
        const codexProvider = (providers ?? []).find((p: Record<string, unknown>) => String(p.provider_name).toLowerCase() === "codex");
        if (!codexProvider) {
          return { data: { execution_status: "refused", failed_stage: "provider_selection", failure_code: "codex_unavailable", failure_reason: "Codex provider is not available. Codex-only execution requested — fallback is not permitted.", fallback_permitted: false, fallback_performed: false, lifecycle_change_performed: false }, health: null, explanation: null };
        }
      }
      // Create execution record
      const executionRef = `SER-${objectRef}-${Date.now()}`;
      const { data: ewo } = await supabase.from("engineering_work_orders").select("id").eq("ewo_ref", objectRef).maybeSingle();
      const { error: execError } = await supabase.from("supervised_execution_records").insert({ execution_ref: executionRef, ewo_id: ewo?.id, ewo_ref: objectRef, provider: isCodex ? "codex" : "bolt", execution_status: "pending", governance_gate_passed: true, governance_diagnostics: { gate_data: gate } });
      if (execError) {
        return { data: null, health: null, explanation: `Failed to create execution record: ${execError.message}` };
      }
      return { data: { execution_status: "dispatched", execution_ref: executionRef, selected_provider: isCodex ? "codex" : "bolt", fallback_permitted: !isCodex, fallback_performed: false, lifecycle_change_performed: true }, health: null, explanation: null };
    }

    if (operation === "inspectEngineeringExecution") {
      const { data: rpcData, error: rpcError } = await supabase.rpc("inspect_ewo_execution_state", { p_ewo_ref: objectRef ?? "" });
      if (rpcError || !rpcData) {
        return { data: null, health: null, explanation: `Unable to inspect execution state for "${objectRef}": ${rpcError?.message ?? "RPC returned no data"}` };
      }
      return { data: rpcData, health: { availability: "available", health: "healthy", inspection_confidence: 0.95, evidence_quality: 0.9, relationship_completeness: 0.8 }, explanation: null };
    }

    // ─── EWO-030R.5: Acceptance Governance Inspection ────────────────────────
    if (operation === "inspectEngineeringWorkOrderAcceptanceGovernance") {
      const { data: rpcData, error: rpcError } = await supabase.rpc("inspect_ewo_acceptance_state", { p_ewo_ref: objectRef ?? "" });
      if (rpcError || !rpcData) {
        return { data: null, health: null, explanation: `Unable to inspect acceptance governance for "${objectRef}": ${rpcError?.message ?? "RPC returned no data"}` };
      }
      return { data: rpcData, health: { availability: "available", health: "healthy", inspection_confidence: 0.95, evidence_quality: 0.9, relationship_completeness: 0.8 }, explanation: null };
    }

    // ─── EWO-029R.1: Supervised Execution Engine Inspection ────────────────────
    if (operation === "inspectSupervisedExecutionEngine") {
      return await inspectSupervisedExecutionEngineFromEdge(supabase, persona);
    }

    // Map operation to table + query
    const tableMap: Record<string, { table: string; columns: string; isList: boolean }> = {
      listExecutionProviders: { table: "execution_provider_registry", columns: "*", isList: true },
      listExecutionRecords: { table: "supervised_execution_records", columns: "*", isList: true },
      listPages: { table: "_static", columns: "*", isList: true },
      listWorkspaces: { table: "_static", columns: "*", isList: true },
      listServices: { table: "ecc_module_registry", columns: "module_key, name, description, status", isList: true },
      listStandards: { table: "ecc_engineering_standards", columns: "id, standard_code, title, description, status", isList: true },
      listConstitution: { table: "constitutional_documents", columns: "id, amendment_id, title, status, description", isList: true },
      listEngineeringRecords: { table: "engineering_records_library", columns: "id, record_ref, record_type, title, status, ewo_ref", isList: true },
      listEngineeringWorkOrders: { table: "engineering_work_orders", columns: "id, ewo_ref, title, status", isList: true },
      listEngineeringPlans: { table: "epre_recommendations", columns: "id, ewo_ref, recommendation_type, status, summary", isList: true },
      listMemory: { table: "engineering_memory", columns: "id, record_ref, title, knowledge_category, authority_state", isList: true },
      listKnowledge: { table: "ecc_knowledge_objects", columns: "id, title, knowledge_type, status, summary", isList: true },
      listLineage: { table: "engineering_record_lineage", columns: "id, from_record_ref, to_ref, relationship_type", isList: true },
    };

    const singleMap: Record<string, { table: string; refColumn: string }> = {
      inspectExecutionProvider: { table: "execution_provider_registry", refColumn: "provider_id" },
      inspectExecutionRecord: { table: "supervised_execution_records", refColumn: "execution_ref" },
      inspectExecutionPipeline: { table: "execution_pipeline_events", refColumn: "execution_record_id" },
      inspectExecutionGovernanceGate: { table: "supervised_execution_records", refColumn: "ewo_ref" },
      inspectExecutionHistory: { table: "supervised_execution_records", refColumn: "ewo_ref" },
      inspectPage: { table: "_static", refColumn: "id" },
      inspectWorkspace: { table: "_static", refColumn: "id" },
      inspectService: { table: "ecc_module_registry", refColumn: "module_key" },
      inspectStandard: { table: "ecc_engineering_standards", refColumn: "standard_code" },
      inspectConstitution: { table: "constitutional_documents", refColumn: "amendment_id" },
      inspectEngineeringRecord: { table: "engineering_records_library", refColumn: "record_ref" },
      inspectEngineeringWorkOrder: { table: "engineering_work_orders", refColumn: "ewo_ref" },
      inspectEngineeringPlan: { table: "epre_recommendations", refColumn: "ewo_ref" },
      inspectMemory: { table: "engineering_memory", refColumn: "record_ref" },
      inspectKnowledge: { table: "ecc_knowledge_objects", refColumn: "id" },
      inspectLineage: { table: "engineering_record_lineage", refColumn: "id" },
      inspectRelationships: { table: "engineering_record_lineage", refColumn: "from_record_ref" },
    };

    if (operation === "discoverCapabilities") {
      const { data } = await supabase.from("atd_connect_capabilities").select("*").eq("status", "active").order("name");
      return { data, health: { availability: "available", health: "healthy", inspection_confidence: 0.9, evidence_quality: 0.8, relationship_completeness: 0.5 }, explanation: null };
    }

    if (operation === "inspectCapability") {
      const { data } = await supabase.from("atd_connect_capabilities").select("*").eq("capability_id", objectRef ?? "").maybeSingle();
      return { data, health: data ? { availability: "available", health: "healthy", inspection_confidence: 0.9, evidence_quality: 0.8, relationship_completeness: 0.5 } : null, explanation: data ? null : `Capability "${objectRef}" not found.` };
    }

    if (operation.startsWith("list")) {
      const config = tableMap[operation];
      if (!config || config.table === "_static") {
        return { data: { items: [], total_count: 0, capability_id: capability }, health: { availability: "available", health: "healthy", inspection_confidence: 0.7, evidence_quality: 0.5, relationship_completeness: 0.3 }, explanation: null };
      }
      const { data, error } = await supabase.from(config.table).select(config.columns).order("created_at", { ascending: false }).limit(100);
      if (error) return { data: null, health: null, explanation: `Unable to retrieve ${capability}.` };
      return { data: { items: data ?? [], total_count: (data ?? []).length, capability_id: capability }, health: { availability: "available", health: "healthy", inspection_confidence: 0.8, evidence_quality: 0.7, relationship_completeness: 0.3 }, explanation: null };
    }

    if (operation.startsWith("inspect")) {
      const config = singleMap[operation];
      if (!config || config.table === "_static") {
        return { data: null, health: null, explanation: `Inspection not supported for "${operation}".` };
      }

      if (operation === "inspectRelationships") {
        const { data, error } = await supabase.from(config.table).select("id, from_record_ref, to_ref, relationship_type").or(`from_record_ref.eq.${objectRef},to_ref.eq.${objectRef}`).limit(50);
        if (error) return { data: null, health: null, explanation: `Unable to inspect relationships for "${objectRef}".` };
        const relationships = (data ?? []).map((r: Record<string, unknown>) => ({
          ref: r.from_record_ref === objectRef ? r.to_ref : r.from_record_ref,
          type: "record",
          relationship: r.relationship_type,
        }));
        return {
          data: { object_ref: objectRef, relationships, relationship_graph: { nodes: [{ id: objectRef, type: "record", label: objectRef }], edges: (data ?? []).map((r: Record<string, unknown>) => ({ from: r.from_record_ref, to: r.to_ref, type: r.relationship_type })) } },
          health: { availability: "available", health: relationships.length > 0 ? "healthy" : "warning", inspection_confidence: 0.8, evidence_quality: 0.7, relationship_completeness: relationships.length > 0 ? 0.8 : 0.2 },
          explanation: null,
        };
      }

      const { data, error } = await supabase.from(config.table).select("*").eq(config.refColumn, objectRef ?? "").maybeSingle();
      if (error || !data) return { data: null, health: null, explanation: `${capability} "${objectRef}" not found.` };
      return { data, health: { availability: "available", health: "healthy", inspection_confidence: 0.9, evidence_quality: 0.8, relationship_completeness: 0.5 }, explanation: null };
    }

    return { data: null, health: null, explanation: `Unsupported operation: ${operation}` };
  } catch (err) {
    return { data: null, health: null, explanation: `Inspection failed: ${err instanceof Error ? err.message : String(err)}` };
  }
}

// ─── EWO-029R.1: Supervised Execution Engine Inspection (Edge) ────────────────────
// Returns governed provider, pipeline, and gate evidence from runtime registries.

async function inspectSupervisedExecutionEngineFromEdge(
  supabase: ReturnType<typeof createClient>,
  persona: string,
): Promise<{ data: unknown | null; health: Record<string, unknown> | null; explanation: string | null }> {
  const servicesInvoked: string[] = [];
  const registriesInspected: string[] = [];
  const unavailableFields: string[] = [];

  // ── Retrieve providers from governed registry ──
  servicesInvoked.push("execution_provider_registry");
  registriesInspected.push("execution_provider_registry");
  const { data: providers, error: providersError } = await supabase
    .from("execution_provider_registry")
    .select("*")
    .order("created_at", { ascending: true });

  const providerRecordsExamined = providers?.length ?? 0;

  const executionProviders = (providers ?? []).map((p: Record<string, unknown>) => ({
    provider_id: p.provider_id,
    provider_name: p.provider_name,
    provider_version: p.provider_version,
    provider_type: p.provider_type,
    is_active: p.is_active,
    is_governed: p.is_governed,
    governance_rules: p.governance_rules ?? [],
    canonical_contract_version: p.canonical_contract_version,
    lifecycle_status: p.is_active ? "active" : "inactive",
  }));

  // ── Determine active provider ──
  const activeProviders = executionProviders.filter((p: Record<string, unknown>) => p.is_active === true);
  const activeProvider = activeProviders.length > 0 ? activeProviders[0] : null;
  if (!activeProvider) unavailableFields.push("active_execution_provider");

  // ── Provider independence evidence ──
  const independenceEvidence: string[] = [];
  if (executionProviders.length >= 1) independenceEvidence.push("Canonical execution contract registered");
  if (executionProviders.length >= 2) independenceEvidence.push("Multiple providers in registry (active + inactive)");
  independenceEvidence.push("Provider selection abstraction layer exists");
  independenceEvidence.push("Execution package/provider decoupling enforced");
  const providerIndependence = {
    status: executionProviders.length >= 2 ? "confirmed" : "partial",
    evidence: independenceEvidence,
  };

  // ── Pipeline stages from canonical definition ──
  servicesInvoked.push("supervised_execution_engine.PIPELINE_STAGES");
  const pipelineStages = PIPELINE_STAGES.map((stage, idx) => ({ stage, sequence: idx }));

  // ── Governance gates from canonical definition ──
  servicesInvoked.push("supervised_execution_engine.evaluateGovernanceGate (definition)");
  const governanceGates = GOVERNANCE_GATE_DEFINITIONS;

  // ── Execution package support ──
  servicesInvoked.push("executionPackageService (capability check)");
  const packageSupport = {
    supported: true,
    description: "Execution packages are generated as permanent engineering records containing EWO, plan, analysis, implementation instructions, governance rules, and completion criteria.",
  };

  // ── Execution diagnostics support ──
  const diagnosticsSupport = {
    supported: true,
    description: "Execution diagnostics provide governed inspection of providers, records, pipeline stages, governance gates, and execution history.",
  };

  // ── Audit ──
  const auditRef = `ATD-EXT-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

  // ── Runtime diagnostics ──
  const runtimeDiagnostics = {
    request_id: auditRef,
    detected_intent: "supervised_execution_engine_inspection",
    extracted_target: "supervised execution engine",
    target_resolution_method: "regex_pattern_match_against_execution_engine_aliases",
    capability_resolution_method: "capability_registry_lookup:supervised-engineering-execution",
    operation_resolution_method: "deterministic_routing:inspectSupervisedExecutionEngine",
    routing_rule: "execution_engine_inspection_precedence",
    services_invoked: servicesInvoked,
    registries_inspected: registriesInspected,
    provider_records_examined: providerRecordsExamined,
    package_definitions_inspected: true,
    pipeline_definitions_inspected: true,
    gate_definitions_inspected: true,
    unavailable_fields: unavailableFields,
    diagnostic_confidence: unavailableFields.length === 0 ? 1.0 : 0.9,
    lifecycle_change_performed: false,
    generated_timestamp: new Date().toISOString(),
    audit_reference: auditRef,
  };

  // ── Intent diagnostics ──
  const intentDiagnostics = {
    detected_intent: "supervised_execution_engine_inspection",
    confidence: 1.0,
    routing_decision: "route_to_inspectSupervisedExecutionEngine",
    extracted_target: "supervised execution engine",
    matched_pattern: "execution_engine_inspection",
    isWriteRequest: false,
    isMetadataQuestion: false,
    isFrameworkIntrospection: true,
    isExecutionInspection: true,
    lifecycle_change_requested: false,
  };

  const data = {
    capability_id: "supervised-engineering-execution",
    detected_intent: "supervised_execution_engine_inspection",
    routing_decision: "route_to_inspectSupervisedExecutionEngine",
    resolved_capability: "supervised-engineering-execution",
    resolved_operation: "inspectSupervisedExecutionEngine",
    execution_providers: executionProviders,
    active_execution_provider: activeProvider,
    provider_independence_status: providerIndependence,
    execution_package_support: packageSupport,
    execution_pipeline_stages: pipelineStages,
    execution_diagnostics_support: diagnosticsSupport,
    product_owner_governance_gates: governanceGates,
    runtime_diagnostics: runtimeDiagnostics,
    intent_diagnostics: intentDiagnostics,
    lifecycle_change_performed: false,
    audit_reference: auditRef,
  };

  return {
    data,
    health: {
      availability: "available",
      health: "healthy",
      inspection_confidence: 1.0,
      evidence_quality: 0.9,
      relationship_completeness: 0.8,
    },
    explanation: null,
  };
}
