// EWO-038 — Server-Side Governed Engineering Work Order Creation
// EWO-042S — Updated to use the governed creation gateway RPC
// EWO-044R3 — Resolves organisation (tenant) and project ownership context
//
// This edge function now calls the create_canonical_ewo_governed() RPC
// instead of direct INSERT into engineering_work_orders. The RPC:
//   - validates execution context
//   - validates tenant and project ownership context
//   - blocks automated_test context
//   - blocks test identities
//   - allocates canonical EWO number
//   - creates lifecycle event
//   - creates audit record
//   - logs all attempts (including rejections) to ewo_creation_attempt_log
//
// Direct INSERT into engineering_work_orders is no longer possible from
// anon/authenticated roles (RLS INSERT policy removed).

import { createClient } from "jsr:@supabase/supabase-js@2";
import { operatorDeniedResponse, requirePlatformOperator } from "../_shared/platform-operator.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, PUT, DELETE, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization, X-Client-Info, Apikey",
};

function err(msg: string, status = 400) {
  return new Response(JSON.stringify({ error: msg }), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

function ok(data: unknown) {
  return new Response(JSON.stringify(data), {
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

// ─── Types ────────────────────────────────────────────────────────────────────

interface EwoCreationBlocker {
  category: string;
  message: string;
}

interface EwoCreationResponse {
  detected_intent: string;
  routing_decision: string;
  product_owner_authority: string;
  ewo_ref: string | null;
  ewo_id: string | null;
  ewo_title: string | null;
  ewo_status: string | null;
  created: boolean;
  lifecycle_state: string;
  duplicate_of: string | null;
  originating_conversation_id: string | null;
  source_idea_id: string | null;
  source_plan_ref: string | null;
  execution_preparation_available: boolean;
  audit_reference: string;
  blockers: EwoCreationBlocker[];
  next_governed_action: string;
  server_authoritative: true;
  codex_mutation_performed: false;
  github_mutation_performed: false;
}

// ─── Server-Side Authority Resolution ──────────────────────────────────────────

async function resolveAuthority(
  supabase: ReturnType<typeof createClient>,
  authToken: string | null,
): Promise<{
  user_id: string | null;
  user_email: string | null;
  role: string;
  is_authorised: boolean;
}> {
  if (!authToken) {
    return { user_id: null, user_email: null, role: "anon", is_authorised: false };
  }

  const userClient = createClient(
    Deno.env.get("SUPABASE_URL")!,
    Deno.env.get("SUPABASE_ANON_KEY")!,
    { global: { headers: { Authorization: `Bearer ${authToken}` } } },
  );

  const { data: userData, error: authError } = await userClient.auth.getUser();
  if (authError || !userData?.user?.id) {
    return { user_id: null, user_email: null, role: "anon", is_authorised: false };
  }

  const userId = userData.user.id;
  const userEmail = userData.user.email ?? null;

  const { data: profile } = await supabase
    .from("profiles")
    .select("role")
    .eq("id", userId)
    .maybeSingle();

  const role = profile?.role ?? "user";
  // Issue #45: operator status (grant + MFA) is enforced by requirePlatformOperator() in the request handler; the legacy profiles.role check is retired.
  const isAuthorised = true;

  return { user_id: userId, user_email: userEmail, role, is_authorised: isAuthorised };
}

// ─── Server-Side Ownership Context Resolution ─────────────────────────────────

async function resolveOwnershipContext(
  supabase: ReturnType<typeof createClient>,
  userId: string,
): Promise<{ tenant_id: string | null; project_id: string | null }> {
  // Resolve the user's active tenant membership
  const { data: membership } = await supabase
    .from("eios_tenant_memberships")
    .select("tenant_id")
    .eq("user_id", userId)
    .eq("status", "active")
    .order("created_at", { ascending: true })
    .limit(1)
    .maybeSingle();

  if (!membership) {
    return { tenant_id: null, project_id: null };
  }

  const tenantId = membership.tenant_id;

  // Resolve the default active project for this tenant
  const { data: project } = await supabase
    .from("ecc_projects")
    .select("id")
    .eq("tenant_id", tenantId)
    .eq("status", "active")
    .order("is_default", { ascending: false })
    .limit(1)
    .maybeSingle();

  return { tenant_id: tenantId, project_id: project?.id ?? null };
}

// ─── Server-Side Duplicate Detection ───────────────────────────────────────────

async function findExistingEwo(
  supabase: ReturnType<typeof createClient>,
  params: { title: string; sourceIdeaId: string | null; sourcePlanRef: string | null },
): Promise<{ ewo_id: string; ewo_ref: string } | null> {
  if (params.title) {
    const { data } = await supabase
      .from("engineering_work_orders")
      .select("id, ewo_ref")
      .ilike("title", params.title)
      .limit(1)
      .maybeSingle();
    if (data) return { ewo_id: data.id, ewo_ref: data.ewo_ref };
  }

  return null;
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

  try {
    const supabase = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
    );

    const body = await req.json().catch(() => ({}));
    const {
      title = null,
      executive_summary: executiveSummary = null,
      conversation_id: conversationId = null,
      source_idea_id: sourceIdeaId = null,
      source_plan_ref: sourcePlanRef = null,
      priority = "medium",
      risk_level: riskLevel = "medium",
      implementation_provider: implementationProvider = "codex",
      execution_context: executionContext = null,
    } = body;

    const auditRef = `EWO038-CREATE-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

    const authToken = req.headers.get("Authorization")?.replace("Bearer ", "") ?? null;

    // 1. Authenticate and resolve authority
    const authority = await resolveAuthority(supabase, authToken);

    // 1b. Resolve ownership context (tenant + project)
    let ownershipContext: { tenant_id: string | null; project_id: string | null } = {
      tenant_id: null,
      project_id: null,
    };
    if (authority.user_id) {
      ownershipContext = await resolveOwnershipContext(supabase, authority.user_id);
    }

    const blockers: EwoCreationBlocker[] = [];

    if (!authority.is_authorised) {
      blockers.push({
        category: "product_owner_authority_missing",
        message: `Authenticated user role "${authority.role}" is not authorised to create Engineering Work Orders.`,
      });
    }

    // 2. Validate required fields
    if (!executionContext || executionContext.trim().length === 0) {
      blockers.push({
        category: "execution_context_required",
        message: "An explicit execution context is required to create an Engineering Work Order. No default is permitted.",
      });
    }

    if (!title || title.trim().length === 0) {
      blockers.push({
        category: "title_required",
        message: "A title is required to create an Engineering Work Order.",
      });
    }

    if (!executiveSummary || executiveSummary.trim().length === 0) {
      blockers.push({
        category: "executive_summary_required",
        message: "An executive summary is required to create an Engineering Work Order.",
      });
    }

    if (!ownershipContext.tenant_id) {
      blockers.push({
        category: "organisation_required",
        message: "An active organisation membership is required to create an Engineering Work Order.",
      });
    }

    if (!ownershipContext.project_id) {
      blockers.push({
        category: "project_required",
        message: "An active engineering project is required to create an Engineering Work Order.",
      });
    }

    // Return early on fundamental blockers
    if (blockers.length > 0) {
      return ok({
        detected_intent: "create_ewo",
        routing_decision: "blocked",
        product_owner_authority: authority.is_authorised ? "verified" : "missing",
        ewo_ref: null,
        ewo_id: null,
        ewo_title: null,
        ewo_status: null,
        created: false,
        lifecycle_state: "blocked",
        duplicate_of: null,
        originating_conversation_id: conversationId,
        source_idea_id: sourceIdeaId,
        source_plan_ref: sourcePlanRef,
        execution_preparation_available: false,
        audit_reference: auditRef,
        blockers,
        next_governed_action: blockers[0].message,
        server_authoritative: true,
        codex_mutation_performed: false,
        github_mutation_performed: false,
      } satisfies EwoCreationResponse);
    }

    // 3. Duplicate detection
    const existingEwo = await findExistingEwo(supabase, {
      title: title.trim(),
      sourceIdeaId,
      sourcePlanRef,
    });

    if (existingEwo) {
      return ok({
        detected_intent: "create_ewo",
        routing_decision: "duplicate_detected",
        product_owner_authority: "verified",
        ewo_ref: existingEwo.ewo_ref,
        ewo_id: existingEwo.ewo_id,
        ewo_title: title,
        ewo_status: "ready",
        created: false,
        lifecycle_state: "ready",
        duplicate_of: existingEwo.ewo_ref,
        originating_conversation_id: conversationId,
        source_idea_id: sourceIdeaId,
        source_plan_ref: sourcePlanRef,
        execution_preparation_available: true,
        audit_reference: auditRef,
        blockers: [],
        next_governed_action: `An existing Engineering Work Order (${existingEwo.ewo_ref}) already governs this work. Execution preparation is available.`,
        server_authoritative: true,
        codex_mutation_performed: false,
        github_mutation_performed: false,
      } satisfies EwoCreationResponse);
    }

    // 4. Create the canonical EWO via the governed gateway RPC
    const { data: creationResult, error: rpcError } = await supabase.rpc(
      "create_canonical_ewo_governed",
      {
        p_execution_context: executionContext,
        p_title: title.trim(),
        p_executive_summary: executiveSummary.trim(),
        p_priority: priority,
        p_risk_level: riskLevel,
        p_implementation_provider: implementationProvider,
        p_created_by_email: authority.user_email ?? "system",
        p_created_by_role: authority.role,
        p_originating_conversation_ref: conversationId,
        p_source_idea_id: sourceIdeaId,
        p_source_plan_ref: sourcePlanRef,
        p_correlation_id: auditRef,
        p_tenant_id: ownershipContext.tenant_id,
        p_project_id: ownershipContext.project_id,
      },
    );

    if (rpcError || !creationResult) {
      blockers.push({
        category: "creation_failed",
        message: `Governed creation RPC failed: ${rpcError?.message ?? "no result returned"}`,
      });
      return ok({
        detected_intent: "create_ewo",
        routing_decision: "blocked",
        product_owner_authority: "verified",
        ewo_ref: null,
        ewo_id: null,
        ewo_title: title,
        ewo_status: null,
        created: false,
        lifecycle_state: "failed",
        duplicate_of: null,
        originating_conversation_id: conversationId,
        source_idea_id: sourceIdeaId,
        source_plan_ref: sourcePlanRef,
        execution_preparation_available: false,
        audit_reference: auditRef,
        blockers,
        next_governed_action: rpcError?.message ?? "Unknown error",
        server_authoritative: true,
        codex_mutation_performed: false,
        github_mutation_performed: false,
      } satisfies EwoCreationResponse);
    }

    // 5. Check if the RPC blocked the creation
    if (creationResult.blocked) {
      blockers.push({
        category: "governed_gateway_rejection",
        message: creationResult.rejection_reason ?? "Creation blocked by governed gateway",
      });
      return ok({
        detected_intent: "create_ewo",
        routing_decision: "blocked",
        product_owner_authority: "verified",
        ewo_ref: creationResult.ewo_ref ?? null,
        ewo_id: creationResult.ewo_id ?? null,
        ewo_title: title,
        ewo_status: null,
        created: false,
        lifecycle_state: "blocked",
        duplicate_of: null,
        originating_conversation_id: conversationId,
        source_idea_id: sourceIdeaId,
        source_plan_ref: sourcePlanRef,
        execution_preparation_available: false,
        audit_reference: creationResult.correlation_id ?? auditRef,
        blockers,
        next_governed_action: creationResult.rejection_reason ?? "Blocked by governed gateway",
        server_authoritative: true,
        codex_mutation_performed: false,
        github_mutation_performed: false,
      } satisfies EwoCreationResponse);
    }

    // 6. Success — return the created EWO
    return ok({
      detected_intent: "create_ewo",
      routing_decision: "ewo_created",
      product_owner_authority: "verified",
      ewo_ref: creationResult.ewo_ref,
      ewo_id: creationResult.ewo_id,
      ewo_title: title,
      ewo_status: "ready",
      created: true,
      lifecycle_state: "ready",
      duplicate_of: null,
      originating_conversation_id: conversationId,
      source_idea_id: sourceIdeaId,
      source_plan_ref: sourcePlanRef,
      execution_preparation_available: true,
      audit_reference: creationResult.correlation_id ?? auditRef,
      blockers: [],
      next_governed_action: `Engineering Work Order ${creationResult.ewo_ref} created. Execution preparation is available. To prepare execution, send: "Prepare ${creationResult.ewo_ref} for governed execution. Stop before provider execution."`,
      server_authoritative: true,
      codex_mutation_performed: false,
      github_mutation_performed: false,
    } satisfies EwoCreationResponse);
  } catch (e) {
    return err(e instanceof Error ? e.message : "Internal error", 500);
  }
});
