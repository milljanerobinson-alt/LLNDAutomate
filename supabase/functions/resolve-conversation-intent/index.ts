// EWO-040 — AI-Assisted Contextual Intent Resolution
// Server-side edge function that uses AI reasoning to interpret engineering
// conversation intent according to overall meaning, not isolated keywords.
//
// Architecture:
//   1. Deterministic lifecycle command detection (exact commands take precedence)
//   2. Contextual AI intent resolution for complex/mixed conversations
//   3. Structured Intent Object returned to client
//   4. Governance validation remains server-side (AI proposes, EIOS authorises)
//
// Reuses: _shared/ai-service.ts (generate function)
// Does NOT: create authority, bypass PO approval, execute code, modify lifecycle state

import { createClient } from "jsr:@supabase/supabase-js@2";
import { operatorDeniedResponse, requirePlatformOperator } from "../_shared/platform-operator.ts";
import { generate, type AIMessage } from "../_shared/ai-service.ts";

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

// ─── Structured Intent Contract ────────────────────────────────────────────────

export interface StructuredIntent {
  primaryIntent:
    | "create_ewo"
    | "prepare_execution"
    | "authorise_execution"
    | "cancel_execution"
    | "inspect_status"
    | "inspect_execution_package"
    | "review_completion"
    | "accept_ewo"
    | "advisory"
    | "clarification_required";
  referencedObjects: string[];
  requestedActions: string[];
  rejectedProposals: string[];
  replacementTask: string | null;
  constraints: string[];
  executionAuthorised: boolean;
  requiredNextStage: string | null;
  confidence: number;
  clarificationRequired: boolean;
  reasoningSummary: string;
}

export interface IntentResolutionResponse {
  routing_method: "deterministic" | "ai_assisted" | "clarification" | "fallback";
  intent: StructuredIntent;
  ewo_ref: string | null;
  audit_reference: string;
  latency_ms: number;
  provider_used: string | null;
  model_used: string | null;
  error: string | null;
}

// ─── Deterministic Lifecycle Command Detection ─────────────────────────────────

const DETERMINISTIC_COMMANDS: Array<{
  intent: StructuredIntent["primaryIntent"];
  patterns: RegExp[];
  extractRef?: (text: string) => string | null;
}> = [
  // Cancel execution request — must be checked FIRST (explicit lifecycle command)
  {
    intent: "cancel_execution",
    patterns: [
      /^\s*cancel\s+(?:execution\s+request\s+)?(?:#?\d+|EWO-[\w.-]+)\s*\.?\s*$/i,
      /^\s*cancel\s+(?:the\s+)?execution\s+(?:request\s+)?(?:#?\d+)\s*\.?\s*$/i,
      /^\s*abort\s+(?:the\s+)?execution\s+(?:request\s+)?(?:#?\d+)\s*\.?\s*$/i,
    ],
    extractRef: (text) => {
      const m = text.match(/(?:#?(\d+)|(EWO-[\w.-]+))/i);
      return m ? (m[1] ? `EXEC-${m[1]}` : m[2]) : null;
    },
  },
  // Approve EWO for execution (exact command)
  {
    intent: "authorise_execution",
    patterns: [
      /^\s*approve\s+(EWO-[\w.-]+)\s+for\s+execution\s*\.?\s*$/i,
      /^\s*authorise?\s+(EWO-[\w.-]+)\s+for\s+(?:governed\s+)?execution\s*\.?\s*$/i,
      /^\s*authorize?\s+(EWO-[\w.-]+)\s+for\s+(?:governed\s+)?execution\s*\.?\s*$/i,
    ],
    extractRef: (text) => text.match(/(EWO-[\w.-]+)/i)?.[1] ?? null,
  },
  // Prepare EWO (exact command)
  {
    intent: "prepare_execution",
    patterns: [
      /^\s*prepare\s+(EWO-[\w.-]+)\s+for\s+(?:governed\s+)?execution\s*\.?\s*$/i,
      /^\s*prepare\s+(?:the\s+)?execution\s+(?:request\s+)?(?:for\s+)?(EWO-[\w.-]+)\s*\.?\s*$/i,
    ],
    extractRef: (text) => text.match(/(EWO-[\w.-]+)/i)?.[1] ?? null,
  },
  // Accept EWO (exact command)
  {
    intent: "accept_ewo",
    patterns: [
      /^\s*accept\s+(EWO-[\w.-]+)\s*\.?\s*$/i,
      /^\s*record\s+product\s+owner\s+acceptance\s+(?:for\s+)?(EWO-[\w.-]+)\s*\.?\s*$/i,
    ],
    extractRef: (text) => text.match(/(EWO-[\w.-]+)/i)?.[1] ?? null,
  },
  // EWO-042: Inspect execution package — read-only inspection (deterministic)
  {
    intent: "inspect_execution_package",
    patterns: [
      /^\s*show\s+me\s+(?:the\s+)?execution\s+package\s*\.?\s*$/i,
      /^\s*review\s+(?:the\s+)?execution\s+package\s*\.?\s*$/i,
      /^\s*inspect\s+(?:the\s+)?execution\s+package\s*\.?\s*$/i,
      /^\s*show\s+(?:the\s+)?planned\s+changes\s*\.?\s*$/i,
      /^\s*show\s+(?:the\s+)?execution\s+summary\s*\.?\s*$/i,
      /^\s*what\s+files\s+will\s+be\s+modified\s*\.?\s*$/i,
      /^\s*show\s+(?:the\s+)?rollback\s+plan\s*\.?\s*$/i,
      /^\s*show\s+validation\s+steps\s*\.?\s*$/i,
      /^\s*show\s+execution\s+risks\s*\.?\s*$/i,
      /^\s*why\s+was\s+(?:this\s+)?provider\s+selected\s*\.?\s*$/i,
      /^\s*show\s+everything\s+that\s+will\s+happen\s+if\s+i\s+approve\s+(?:this)?\s*\.?\s*$/i,
      /^\s*inspect\s+(?:the\s+)?execution\s+package\s+(?:for\s+)?(EWO-[\w.-]+)\s*\.?\s*$/i,
      /^\s*show\s+me\s+(?:the\s+)?execution\s+package\s+(?:for\s+)?(EWO-[\w.-]+)\s*\.?\s*$/i,
    ],
    extractRef: (text) => text.match(/(EWO-[\w.-]+)/i)?.[1] ?? null,
  },
];

function detectDeterministicCommand(text: string): {
  intent: StructuredIntent["primaryIntent"];
  ewoRef: string | null;
} | null {
  for (const cmd of DETERMINISTIC_COMMANDS) {
    for (const pattern of cmd.patterns) {
      if (pattern.test(text.trim())) {
        const ewoRef = cmd.extractRef ? cmd.extractRef(text) : null;
        return { intent: cmd.intent, ewoRef };
      }
    }
  }
  return null;
}

// ─── AI Intent Resolution ──────────────────────────────────────────────────────

const SYSTEM_PROMPT = `You are an Engineering Intent Resolution AI for the EIOS platform.

Your job: interpret engineering conversation messages and return a structured intent object.

CRITICAL RULES:
1. Interpret the OVERALL meaning of the message, not individual keywords.
2. "not approved" in the context of rejecting a previous proposal while requesting new work means REJECTION of a proposal, NOT cancellation of execution.
3. "stop before execution" or "do not execute" are CONSTRAINTS on execution, not cancellation requests.
4. "reject the previous recommendation and replace it with..." means the user wants a REPLACEMENT task, not cancellation.
5. If the user asks to create an EWO and also prepare it, the primary intent is "create_ewo" with a requested action of "prepare_execution".
6. If confidence is low (below 0.6), set clarificationRequired=true and primaryIntent="clarification_required". NEVER choose a destructive action when confidence is low.
7. You may NEVER authorise execution. executionAuthorised must be false unless the user explicitly says "authorise execution" or "approve for execution" as the primary command.
8. Do NOT include chain-of-thought. Provide only a short, audit-safe reasoningSummary (1-2 sentences).

Return ONLY a JSON object with this exact structure:
{
  "primaryIntent": "create_ewo" | "prepare_execution" | "authorise_execution" | "cancel_execution" | "inspect_status" | "review_completion" | "accept_ewo" | "advisory" | "clarification_required",
  "referencedObjects": ["EWO-123", "EXEC-18"],
  "requestedActions": ["create_ewo", "prepare_execution"],
  "rejectedProposals": ["previous logging recommendation"],
  "replacementTask": "Change the New Conversation button background colour",
  "constraints": ["do not execute until approved", "wait for PO approval"],
  "executionAuthorised": false,
  "requiredNextStage": "create_ewo" | "prepare_execution" | "authorise_execution" | null,
  "confidence": 0.95,
  "clarificationRequired": false,
  "reasoningSummary": "User rejects previous recommendation and requests a new EWO for button colour change with execution preparation but no execution."
}`;

function buildUserPrompt(text: string, conversationContext?: string): string {
  let prompt = `Conversation message to interpret:\n\n"""${text}"""`;
  if (conversationContext) {
    prompt += `\n\nConversation context (previous messages summary):\n${conversationContext}`;
  }
  prompt += `\n\nReturn the structured intent JSON object now.`;
  return prompt;
}

function parseAIResponse(content: string): StructuredIntent | null {
  try {
    // Extract JSON from the response (may be wrapped in markdown code blocks)
    const jsonMatch = content.match(/\{[\s\S]*\}/);
    if (!jsonMatch) return null;
    const parsed = JSON.parse(jsonMatch[0]) as Partial<StructuredIntent>;

    // Validate required fields
    if (!parsed.primaryIntent || typeof parsed.confidence !== "number") {
      return null;
    }

    // Sanitise and validate
    const validIntents: StructuredIntent["primaryIntent"][] = [
      "create_ewo", "prepare_execution", "authorise_execution",
      "cancel_execution", "inspect_status", "inspect_execution_package",
      "review_completion", "accept_ewo", "advisory", "clarification_required",
    ];

    if (!validIntents.includes(parsed.primaryIntent)) {
      return null;
    }

    return {
      primaryIntent: parsed.primaryIntent,
      referencedObjects: Array.isArray(parsed.referencedObjects) ? parsed.referencedObjects : [],
      requestedActions: Array.isArray(parsed.requestedActions) ? parsed.requestedActions : [],
      rejectedProposals: Array.isArray(parsed.rejectedProposals) ? parsed.rejectedProposals : [],
      replacementTask: typeof parsed.replacementTask === "string" ? parsed.replacementTask : null,
      constraints: Array.isArray(parsed.constraints) ? parsed.constraints : [],
      executionAuthorised: parsed.executionAuthorised === true,
      requiredNextStage: typeof parsed.requiredNextStage === "string" ? parsed.requiredNextStage : null,
      confidence: Math.max(0, Math.min(1, parsed.confidence)),
      clarificationRequired: parsed.clarificationRequired === true,
      reasoningSummary: typeof parsed.reasoningSummary === "string"
        ? parsed.reasoningSummary.slice(0, 500)
        : "AI intent resolution completed.",
    };
  } catch {
    return null;
  }
}

function deterministicFallback(text: string): StructuredIntent {
  // Simple keyword-based fallback when AI is unavailable
  const lower = text.toLowerCase();
  const ewoRef = text.match(/(EWO-[\w.-]+)/i)?.[1] ?? null;

  if (/\bcancel\s+(?:the\s+)?execution\b/i.test(text) || /\babort\s+(?:the\s+)?execution\b/i.test(text)) {
    return {
      primaryIntent: "cancel_execution",
      referencedObjects: ewoRef ? [ewoRef] : [],
      requestedActions: ["cancel_execution"],
      rejectedProposals: [],
      replacementTask: null,
      constraints: [],
      executionAuthorised: false,
      requiredNextStage: null,
      confidence: 0.7,
      clarificationRequired: false,
      reasoningSummary: "Deterministic fallback: cancellation keyword detected.",
    };
  }

  if (/\bcreate\s+(?:the\s+|an?\s+)?(?:ewo|engineering\s+work\s+order)\b/i.test(text)) {
    return {
      primaryIntent: "create_ewo",
      referencedObjects: ewoRef ? [ewoRef] : [],
      requestedActions: ["create_ewo"],
      rejectedProposals: [],
      replacementTask: null,
      constraints: [],
      executionAuthorised: false,
      requiredNextStage: "create_ewo",
      confidence: 0.6,
      clarificationRequired: false,
      reasoningSummary: "Deterministic fallback: EWO creation keyword detected.",
    };
  }

  if (/\bprepare\b/i.test(text)) {
    return {
      primaryIntent: "prepare_execution",
      referencedObjects: ewoRef ? [ewoRef] : [],
      requestedActions: ["prepare_execution"],
      rejectedProposals: [],
      replacementTask: null,
      constraints: [],
      executionAuthorised: false,
      requiredNextStage: "prepare_execution",
      confidence: 0.6,
      clarificationRequired: false,
      reasoningSummary: "Deterministic fallback: prepare keyword detected.",
    };
  }

  // EWO-042: Inspect execution package — read-only
  if (/show\s+me\s+(?:the\s+)?execution\s+package/i.test(text) ||
      /review\s+(?:the\s+)?execution\s+package/i.test(text) ||
      /inspect\s+(?:the\s+)?execution\s+package/i.test(text) ||
      /show\s+(?:the\s+)?planned\s+changes/i.test(text) ||
      /show\s+(?:the\s+)?execution\s+summary/i.test(text) ||
      /what\s+files\s+will\s+be\s+modified/i.test(text) ||
      /show\s+(?:the\s+)?rollback\s+plan/i.test(text) ||
      /show\s+validation\s+steps/i.test(text) ||
      /show\s+execution\s+risks/i.test(text) ||
      /why\s+was\s+(?:this\s+)?provider\s+selected/i.test(text) ||
      /show\s+everything\s+that\s+will\s+happen\s+if\s+i\s+approve/i.test(text)) {
    return {
      primaryIntent: "inspect_execution_package",
      referencedObjects: ewoRef ? [ewoRef] : [],
      requestedActions: ["inspect_execution_package"],
      rejectedProposals: [],
      replacementTask: null,
      constraints: [],
      executionAuthorised: false,
      requiredNextStage: null,
      confidence: 0.85,
      clarificationRequired: false,
      reasoningSummary: "Deterministic fallback: execution package inspection keyword detected.",
    };
  }

  return {
    primaryIntent: "advisory",
    referencedObjects: ewoRef ? [ewoRef] : [],
    requestedActions: [],
    rejectedProposals: [],
    replacementTask: null,
    constraints: [],
    executionAuthorised: false,
    requiredNextStage: null,
    confidence: 0.3,
    clarificationRequired: false,
    reasoningSummary: "Deterministic fallback: no specific intent detected.",
  };
}

// ─── Main Handler ──────────────────────────────────────────────────────────────

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { status: 200, headers: corsHeaders });
  }

  // Issue #45: platform operators with MFA only (trusted server-to-server calls with the service-role key also pass).
  {
    const operatorCheck = await requirePlatformOperator(req.headers.get("Authorization"), { allowServiceRole: true });
    if (!operatorCheck.ok) return operatorDeniedResponse(operatorCheck, corsHeaders);
  }

  const startTime = Date.now();
  const auditRef = `EWO040-INTENT-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

  try {
    const supabase = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
    );

    const body = await req.json().catch(() => ({}));
    const {
      text = "",
      conversation_context: conversationContext = null,
      conversation_id: conversationId = null,
    } = body;

    if (!text || text.trim().length === 0) {
      return err("text is required", 400);
    }

    // ── 1. Deterministic lifecycle command detection ──────────────────────────
    const deterministic = detectDeterministicCommand(text);
    if (deterministic) {
      const intent: StructuredIntent = {
        primaryIntent: deterministic.intent,
        referencedObjects: deterministic.ewoRef ? [deterministic.ewoRef] : [],
        requestedActions: [deterministic.intent],
        rejectedProposals: [],
        replacementTask: null,
        constraints: [],
        executionAuthorised: deterministic.intent === "authorise_execution",
        requiredNextStage: deterministic.intent === "authorise_execution" ? "authorise_execution" : null,
        confidence: 1.0,
        clarificationRequired: false,
        reasoningSummary: `Deterministic lifecycle command: ${deterministic.intent}.`,
      };

      // Persist routing diagnostics
      await supabase.from("conversation_routing_diagnostics").insert({
        audit_reference: auditRef,
        conversation_id: conversationId,
        routing_method: "deterministic",
        primary_intent: intent.primaryIntent,
        referenced_objects: intent.referencedObjects,
        requested_actions: intent.requestedActions,
        rejected_proposals: intent.rejectedProposals,
        replacement_task: intent.replacementTask,
        constraints: intent.constraints,
        execution_authorised: intent.executionAuthorised,
        required_next_stage: intent.requiredNextStage,
        confidence: intent.confidence,
        clarification_required: intent.clarificationRequired,
        reasoning_summary: intent.reasoningSummary,
        ewo_ref: deterministic.ewoRef,
        latency_ms: Date.now() - startTime,
      }).then(() => {});

      return ok({
        routing_method: "deterministic",
        intent,
        ewo_ref: deterministic.ewoRef,
        audit_reference: auditRef,
        latency_ms: Date.now() - startTime,
        provider_used: null,
        model_used: null,
        error: null,
      } satisfies IntentResolutionResponse);
    }

    // ── 2. AI-assisted contextual intent resolution ────────────────────────────
    let aiResponse: { content: string; provider: string; model: string } | null = null;
    let aiError: string | null = null;

    try {
      const messages: AIMessage[] = [
        { role: "system", content: SYSTEM_PROMPT },
        { role: "user", content: buildUserPrompt(text, conversationContext ?? undefined) },
      ];

      const response = await generate(supabase, {
        feature: "ewo040_intent_resolution",
        messages,
        temperature: 0.1,
        maxTokens: 1024,
        userId: conversationId ?? undefined,
      });

      aiResponse = {
        content: response.content,
        provider: response.provider,
        model: response.model,
      };
    } catch (e) {
      aiError = e instanceof Error ? e.message : String(e);
    }

    // ── 3. Parse AI response ────────────────────────────────────────────────────
    if (aiResponse) {
      const parsed = parseAIResponse(aiResponse.content);
      if (parsed) {
        // Governance enforcement: AI may NEVER authorise execution
        if (parsed.executionAuthorised && !/\bauthorise?\s+(?:this\s+)?(?:ewo|engineering\s+work\s+order)\s+for\s+(?:governed\s+)?execution\b/i.test(text) &&
            !/\bauthorize?\s+(?:this\s+)?(?:ewo|engineering\s+work\s+order)\s+for\s+(?:governed\s+)?execution\b/i.test(text)) {
          parsed.executionAuthorised = false;
          parsed.constraints.push("execution_authorisation_overridden_by_governance");
        }

        // Low confidence → clarification
        if (parsed.confidence < 0.6 && !parsed.clarificationRequired) {
          parsed.clarificationRequired = true;
          parsed.primaryIntent = "clarification_required";
          parsed.reasoningSummary += " Confidence below threshold; clarification required.";
        }

        const ewoRef = parsed.referencedObjects.find((o) => o.match(/^EWO-[\w.-]+$/)) ?? null;

        // Persist routing diagnostics
        await supabase.from("conversation_routing_diagnostics").insert({
          audit_reference: auditRef,
          conversation_id: conversationId,
          routing_method: "ai_assisted",
          primary_intent: parsed.primaryIntent,
          referenced_objects: parsed.referencedObjects,
          requested_actions: parsed.requestedActions,
          rejected_proposals: parsed.rejectedProposals,
          replacement_task: parsed.replacementTask,
          constraints: parsed.constraints,
          execution_authorised: parsed.executionAuthorised,
          required_next_stage: parsed.requiredNextStage,
          confidence: parsed.confidence,
          clarification_required: parsed.clarificationRequired,
          reasoning_summary: parsed.reasoningSummary,
          ewo_ref: ewoRef,
          latency_ms: Date.now() - startTime,
          provider_used: aiResponse.provider,
          model_used: aiResponse.model,
        }).then(() => {});

        return ok({
          routing_method: "ai_assisted",
          intent: parsed,
          ewo_ref: ewoRef,
          audit_reference: auditRef,
          latency_ms: Date.now() - startTime,
          provider_used: aiResponse.provider,
          model_used: aiResponse.model,
          error: null,
        } satisfies IntentResolutionResponse);
      }
    }

    // ── 4. Deterministic fallback (AI unavailable or malformed response) ──────
    const fallbackIntent = deterministicFallback(text);
    const ewoRef = fallbackIntent.referencedObjects[0] ?? null;

    // Persist routing diagnostics
    await supabase.from("conversation_routing_diagnostics").insert({
      audit_reference: auditRef,
      conversation_id: conversationId,
      routing_method: "fallback",
      primary_intent: fallbackIntent.primaryIntent,
      referenced_objects: fallbackIntent.referencedObjects,
      requested_actions: fallbackIntent.requestedActions,
      rejected_proposals: fallbackIntent.rejectedProposals,
      replacement_task: fallbackIntent.replacementTask,
      constraints: fallbackIntent.constraints,
      execution_authorised: fallbackIntent.executionAuthorised,
      required_next_stage: fallbackIntent.requiredNextStage,
      confidence: fallbackIntent.confidence,
      clarification_required: fallbackIntent.clarificationRequired,
      reasoning_summary: fallbackIntent.reasoningSummary,
      ewo_ref: ewoRef,
      latency_ms: Date.now() - startTime,
      error: aiError ?? "AI response could not be parsed; using deterministic fallback.",
    }).then(() => {});

    return ok({
      routing_method: "fallback",
      intent: fallbackIntent,
      ewo_ref: ewoRef,
      audit_reference: auditRef,
      latency_ms: Date.now() - startTime,
      provider_used: null,
      model_used: null,
      error: aiError ?? "AI response could not be parsed; using deterministic fallback.",
    } satisfies IntentResolutionResponse);
  } catch (e) {
    return ok({
      routing_method: "fallback",
      intent: {
        primaryIntent: "clarification_required",
        referencedObjects: [],
        requestedActions: [],
        rejectedProposals: [],
        replacementTask: null,
        constraints: [],
        executionAuthorised: false,
        requiredNextStage: null,
        confidence: 0,
        clarificationRequired: true,
        reasoningSummary: "Internal error during intent resolution.",
      },
      ewo_ref: null,
      audit_reference: auditRef,
      latency_ms: Date.now() - startTime,
      provider_used: null,
      model_used: null,
      error: e instanceof Error ? e.message : "Internal error",
    } satisfies IntentResolutionResponse);
  }
});
