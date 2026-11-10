// EWO-037R.2 — Server-Side Governed Execution Preparation (v2)
// Authoritative entry point for conversation-to-execution routing.
// All security-critical decisions (authority, EWO eligibility, provider
// policy, repository readiness, execution request creation, idempotency)
// are enforced server-side using the service role key.
//
// The client may detect execution language and call this function, but must
// NOT make authoritative decisions itself.

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

interface BlockerDetail {
  category: string;
  message: string;
}

interface ExecutionPreparationResponse {
  detected_intent: string;
  routing_decision: string;
  product_owner_authority: string;
  ewo_ref: string | null;
  ewo_title: string | null;
  ewo_status: string | null;
  execution_request_id: string | null;
  lifecycle_state: string;
  provider_selected: string | null;
  provider_policy_version: number | null;
  repository_owner: string | null;
  repository_name: string | null;
  base_branch: string | null;
  proposed_execution_branch: string | null;
  approval_status: string;
  readiness_status: string;
  fallback_permitted: boolean;
  blockers: BlockerDetail[];
  next_governed_action: string;
  audit_reference: string;
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
  authority_source: string;
}> {
  if (!authToken) {
    return { user_id: null, user_email: null, role: "anon", is_authorised: false, authority_source: "missing" };
  }

  // Create a user-scoped client to resolve the auth session
  const userClient = createClient(
    Deno.env.get("SUPABASE_URL")!,
    Deno.env.get("SUPABASE_ANON_KEY")!,
    { global: { headers: { Authorization: `Bearer ${authToken}` } } },
  );

  const { data: userData, error: authError } = await userClient.auth.getUser();
  if (authError || !userData?.user?.id) {
    return { user_id: null, user_email: null, role: "anon", is_authorised: false, authority_source: "missing" };
  }

  const userId = userData.user.id;
  const userEmail = userData.user.email ?? null;

  // Server-side role resolution using service role (bypasses RLS)
  const { data: profile } = await supabase
    .from("profiles")
    .select("role")
    .eq("id", userId)
    .maybeSingle();

  const role = profile?.role ?? "user";
  // Authority is determined server-side from the database role, not from
  // any client-supplied value. Only admin/product_owner/po/approver roles
  // are authorised to prepare execution requests.
  // Issue #45: operator status (grant + MFA) is enforced by requirePlatformOperator() in the request handler; the legacy profiles.role check is retired.
  const isAuthorised = true;

  return { user_id: userId, user_email: userEmail, role, is_authorised: isAuthorised, authority_source: "authenticated_session" };
}

// ─── Server-Side EWO Resolution ────────────────────────────────────────────────

async function resolveEwo(
  supabase: ReturnType<typeof createClient>,
  ewoRef: string | null,
  conversationId: string | null,
): Promise<{
  ewo_ref: string | null;
  ewo_id: string | null;
  ewo_title: string | null;
  status: string | null;
  resolution_method: string;
  ambiguous_candidates: string[];
  error: string | null;
}> {
  // 1. Explicit EWO reference
  if (ewoRef) {
    const { data, error } = await supabase
      .from("engineering_work_orders")
      .select("id, ewo_ref, title, status")
      .eq("ewo_ref", ewoRef)
      .maybeSingle();

    if (error) {
      return { ewo_ref: ewoRef, ewo_id: null, ewo_title: null, status: null, resolution_method: "not_found", ambiguous_candidates: [], error: error.message };
    }
    if (data) {
      return { ewo_ref: data.ewo_ref, ewo_id: data.id, ewo_title: data.title, status: data.status, resolution_method: "explicit_reference", ambiguous_candidates: [], error: null };
    }
    return { ewo_ref: ewoRef, ewo_id: null, ewo_title: null, status: null, resolution_method: "not_found", ambiguous_candidates: [], error: `Engineering Work Order ${ewoRef} not found` };
  }

  // 2. Conversation-linked EWO
  if (conversationId) {
    const { data: activeObj } = await supabase
      .from("atd_conversation_active_objects")
      .select("active_ewo_ref")
      .eq("conversation_id", conversationId)
      .maybeSingle();

    if (activeObj?.active_ewo_ref) {
      const { data, error } = await supabase
        .from("engineering_work_orders")
        .select("id, ewo_ref, title, status")
        .eq("ewo_ref", activeObj.active_ewo_ref)
        .maybeSingle();

      if (data) {
        return { ewo_ref: data.ewo_ref, ewo_id: data.id, ewo_title: data.title, status: data.status, resolution_method: "conversation_context", ambiguous_candidates: [], error: null };
      }
    }
  }

  // 3. Active in-progress execution
  const { data: activeExec } = await supabase
    .from("engineering_executions")
    .select("id, ewo_id, implementation_status, metadata")
    .in("implementation_status", ["pending", "running", "in_progress"])
    .order("created_at", { ascending: false })
    .limit(5);

  if (activeExec && activeExec.length === 1) {
    const meta = activeExec[0].metadata as Record<string, unknown> | null;
    return {
      ewo_ref: (meta?.ewo_ref as string) ?? null,
      ewo_id: activeExec[0].ewo_id as string,
      ewo_title: null,
      status: null,
      resolution_method: "active_execution",
      ambiguous_candidates: [],
      error: null,
    };
  }

  if (activeExec && activeExec.length > 1) {
    const refs = activeExec.map((e: { metadata: Record<string, unknown> | null }) => (e.metadata?.ewo_ref as string) ?? e.id);
    return {
      ewo_ref: null,
      ewo_id: null,
      ewo_title: null,
      status: null,
      resolution_method: "ambiguous",
      ambiguous_candidates: refs,
      error: `Multiple in-progress executions found: ${refs.join(", ")}. Please specify the EWO reference.`,
    };
  }

  return { ewo_ref: null, ewo_id: null, ewo_title: null, status: null, resolution_method: "not_found", ambiguous_candidates: [], error: "No Engineering Work Order reference found in message or conversation context" };
}

// ─── Server-Side Provider Policy Resolution ────────────────────────────────────

async function resolveProviderPolicy(
  supabase: ReturnType<typeof createClient>,
  ewoRef: string | null,
): Promise<{
  selected_provider_id: string | null;
  policy_version: number | null;
  fallback_permitted: boolean;
  rejection_reason: string | null;
  selection_reason: string;
}> {
  const { data: policy } = await supabase
    .from("execution_provider_policy")
    .select("*")
    .eq("lifecycle_status", "active")
    .maybeSingle();

  if (!policy) {
    return { selected_provider_id: null, policy_version: null, fallback_permitted: false, rejection_reason: "no_active_policy", selection_reason: "No active provider policy found" };
  }

  const allowedIds: string[] = Array.isArray(policy.allowed_provider_ids)
    ? policy.allowed_provider_ids
    : JSON.parse(policy.allowed_provider_ids || "[]");

  const defaultProviderId = policy.default_provider_id;

  const { data: provider } = await supabase
    .from("execution_provider_registry")
    .select("*")
    .eq("provider_id", defaultProviderId)
    .maybeSingle();

  if (!provider) {
    return { selected_provider_id: null, policy_version: policy.policy_version, fallback_permitted: policy.fallback_permitted ?? false, rejection_reason: "provider_not_registered", selection_reason: `Default provider "${defaultProviderId}" is not registered` };
  }

  if (!provider.is_active) {
    return { selected_provider_id: provider.provider_id, policy_version: policy.policy_version, fallback_permitted: policy.fallback_permitted ?? false, rejection_reason: "provider_inactive", selection_reason: `Provider "${provider.provider_id}" is not active` };
  }

  if (!provider.is_governed) {
    return { selected_provider_id: provider.provider_id, policy_version: policy.policy_version, fallback_permitted: policy.fallback_permitted ?? false, rejection_reason: "provider_not_governed", selection_reason: `Provider "${provider.provider_id}" is not governed` };
  }

  if (!allowedIds.includes(provider.provider_id)) {
    return { selected_provider_id: provider.provider_id, policy_version: policy.policy_version, fallback_permitted: policy.fallback_permitted ?? false, rejection_reason: "provider_not_allowed", selection_reason: `Provider "${provider.provider_id}" is not in the allowed providers list` };
  }

  return {
    selected_provider_id: provider.provider_id,
    policy_version: policy.policy_version,
    fallback_permitted: policy.fallback_permitted ?? false,
    rejection_reason: null,
    selection_reason: `Default governed provider "${provider.provider_id}" selected per policy v${policy.policy_version}`,
  };
}

// ─── Server-Side Repository Resolution ────────────────────────────────────────

async function resolveRepository(
  supabase: ReturnType<typeof createClient>,
): Promise<{
  repository_owner: string | null;
  repository_name: string | null;
  base_branch: string | null;
  error: string | null;
}> {
  const { data: repoConfig } = await supabase
    .from("github_repository_config")
    .select("repository_owner, repository_name, default_base_branch")
    .limit(1)
    .maybeSingle();

  if (!repoConfig) {
    return { repository_owner: null, repository_name: null, base_branch: null, error: "GitHub repository configuration not found" };
  }

  return {
    repository_owner: repoConfig.repository_owner,
    repository_name: repoConfig.repository_name,
    base_branch: repoConfig.default_base_branch,
    error: null,
  };
}

// ─── Server-Side Idempotent Execution Request Creation ─────────────────────────

async function findOrCreateExecutionRequest(
  supabase: ReturnType<typeof createClient>,
  params: {
    ewoId: string;
    ewoRef: string;
    conversationId: string | null;
    userId: string;
    intent: string;
    providerSelected: string | null;
    repositoryOwner: string | null;
    repositoryName: string | null;
    baseBranch: string | null;
    auditRef: string;
  },
): Promise<{ execution_request_id: string; lifecycle_state: string; created: boolean; error: string | null }> {
  // Idempotency: check for existing pending/prepared request for this EWO.
  // The table uses implementation_status (not status) and stores ewo_ref in metadata.
  const { data: existing } = await supabase
    .from("engineering_executions")
    .select("id, implementation_status, metadata")
    .eq("ewo_id", params.ewoId)
    .in("implementation_status", ["pending", "prepared", "awaiting_approval"])
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();

  if (existing) {
    return { execution_request_id: existing.id, lifecycle_state: existing.implementation_status, created: false, error: null };
  }

  // Create new pending execution request (preparation only — no execution).
  // Repository/provider/EWO ref go into metadata since the table schema
  // uses implementation_status, implementation_provider, and metadata.
  const executionRef = `EXEC-${params.ewoRef}-${Date.now()}`;
  const { data: newReq, error } = await supabase
    .from("engineering_executions")
    .insert({
      execution_ref: executionRef,
      ewo_id: params.ewoId,
      implementation_provider: params.providerSelected,
      implementation_status: "pending",
      po_status: "pending",
      metadata: {
        source: "server_side_execution_preparation",
        ewo_ref: params.ewoRef,
        conversation_id: params.conversationId,
        intent: params.intent,
        audit_ref: params.auditRef,
        server_authoritative: true,
        repository_owner: params.repositoryOwner,
        repository_name: params.repositoryName,
        base_branch: params.baseBranch,
        created_by: params.userId,
        created_at: new Date().toISOString(),
      },
    })
    .select("id, implementation_status")
    .single();

  if (error || !newReq) {
    return { execution_request_id: "", lifecycle_state: "failed", created: false, error: error?.message ?? "Failed to create execution request" };
  }

  return { execution_request_id: newReq.id, lifecycle_state: newReq.implementation_status, created: true, error: null };
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
      ewo_ref: ewoRefParam = null,
      conversation_id: conversationId = null,
      intent: clientIntent = "engineering_execution_prepare",
      stop_before_execution: stopBeforeExecution = true,
    } = body;

    const auditRef = `EWO037R2-PREP-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

    // Extract auth token from header
    const authToken = req.headers.get("Authorization")?.replace("Bearer ", "") ?? null;

    // 1. Authenticate and resolve authority (SERVER-SIDE)
    const authority = await resolveAuthority(supabase, authToken);

    const blockers: BlockerDetail[] = [];

    if (!authority.is_authorised) {
      blockers.push({
        category: "product_owner_authority_missing",
        message: `Authenticated user role "${authority.role}" is not authorised to prepare execution. Only Product Owner or authorised approver roles may initiate execution preparation.`,
      });
    }

    // 2. Resolve EWO (SERVER-SIDE)
    const ewoResolution = await resolveEwo(supabase, ewoRefParam, conversationId);

    if (ewoResolution.resolution_method === "not_found") {
      blockers.push({
        category: "engineering_work_order_not_found",
        message: ewoResolution.error ?? "No Engineering Work Order reference found.",
      });
    } else if (ewoResolution.resolution_method === "ambiguous") {
      blockers.push({
        category: "engineering_work_order_ambiguous",
        message: ewoResolution.error ?? "Multiple Engineering Work Orders found.",
      });
    }

    // Return early if fundamental blockers
    if (blockers.some(b => b.category === "product_owner_authority_missing" || b.category === "engineering_work_order_not_found" || b.category === "engineering_work_order_ambiguous")) {
      return ok({
        detected_intent: clientIntent,
        routing_decision: "blocked",
        product_owner_authority: authority.is_authorised ? "verified" : "missing",
        ewo_ref: ewoResolution.ewo_ref,
        ewo_title: ewoResolution.ewo_title,
        ewo_status: ewoResolution.status,
        execution_request_id: null,
        lifecycle_state: "blocked",
        provider_selected: null,
        provider_policy_version: null,
        repository_owner: null,
        repository_name: null,
        base_branch: null,
        proposed_execution_branch: null,
        approval_status: "not_applicable",
        readiness_status: "blocked",
        fallback_permitted: false,
        blockers,
        next_governed_action: blockers[0].message,
        audit_reference: auditRef,
        server_authoritative: true as const,
        codex_mutation_performed: false as const,
        github_mutation_performed: false as const,
      } satisfies ExecutionPreparationResponse);
    }

    // 3. Check EWO lifecycle state (SERVER-SIDE)
    const eligibleStatuses = ["in_progress", "engineering_complete", "verified", "po_acceptance", "approved", "draft", "new", "ready"];
    if (ewoResolution.status && !eligibleStatuses.includes(ewoResolution.status)) {
      blockers.push({
        category: "engineering_work_order_not_executable",
        message: `EWO ${ewoResolution.ewo_ref} is in status "${ewoResolution.status}". Execution requires one of: ${eligibleStatuses.join(", ")}.`,
      });
    }

    // 4. Check for existing in-progress execution (SERVER-SIDE)
    if (ewoResolution.ewo_id) {
      const { data: activeExec } = await supabase
        .from("engineering_executions")
        .select("id, implementation_status")
        .eq("ewo_id", ewoResolution.ewo_id)
        .in("implementation_status", ["running", "in_progress", "executing"])
        .limit(1)
        .maybeSingle();

      if (activeExec) {
        blockers.push({
          category: "execution_already_in_progress",
          message: `Execution ${activeExec.id} is already in progress for ${ewoResolution.ewo_ref}.`,
        });
      }
    }

    // 5. Resolve provider policy (SERVER-SIDE)
    const providerResult = await resolveProviderPolicy(supabase, ewoResolution.ewo_ref);
    if (providerResult.rejection_reason) {
      blockers.push({
        category: "provider_not_ready",
        message: `Provider selection failed: ${providerResult.selection_reason}`,
      });
    }

    // 6. Resolve repository (SERVER-SIDE)
    const repoResult = await resolveRepository(supabase);
    if (repoResult.error) {
      blockers.push({
        category: "repository_not_ready",
        message: repoResult.error,
      });
    }

    // 7. Check approval state (SERVER-SIDE)
    let approvalStatus = "not_applicable";
    if (clientIntent === "engineering_execution_authorisation") {
      if (ewoResolution.ewo_ref) {
        const { data: execApproval } = await supabase
          .from("ewo_execution_approvals")
          .select("decision")
          .eq("ewo_ref", ewoResolution.ewo_ref)
          .order("approved_at", { ascending: false })
          .limit(1)
          .maybeSingle();

        if (execApproval?.decision === "approved") {
          approvalStatus = "approved";
        } else {
          approvalStatus = "required";
          blockers.push({
            category: "approval_required",
            message: `Product Owner execution approval is required for ${ewoResolution.ewo_ref}.`,
          });
        }
      }
    } else if (clientIntent === "engineering_execution_prepare") {
      approvalStatus = "pending";
    }

    // 8. Create idempotent execution request (SERVER-SIDE, only if no blockers)
    let executionRequestId: string | null = null;
    let lifecycleState = "not_checked";

    if (blockers.length === 0 && ewoResolution.ewo_id && authority.is_authorised) {
      const execReq = await findOrCreateExecutionRequest(supabase, {
        ewoId: ewoResolution.ewo_id,
        ewoRef: ewoResolution.ewo_ref!,
        conversationId,
        userId: authority.user_id!,
        intent: clientIntent,
        providerSelected: providerResult.selected_provider_id,
        repositoryOwner: repoResult.repository_owner,
        repositoryName: repoResult.repository_name,
        baseBranch: repoResult.base_branch,
        auditRef,
      });

      if (execReq.error) {
        blockers.push({ category: "runtime_error", message: `Failed to create execution request: ${execReq.error}` });
      } else {
        executionRequestId = execReq.execution_request_id;
        lifecycleState = execReq.lifecycle_state;
      }
    }

    // 9. Determine readiness and next action
    const readinessStatus = blockers.length === 0 ? "ready" : "blocked";
    const isPrepare = clientIntent === "engineering_execution_prepare" || stopBeforeExecution;

    let nextGovernedAction: string;
    if (blockers.length > 0) {
      nextGovernedAction = blockers[0].message;
    } else if (isPrepare) {
      nextGovernedAction = "Execution request prepared server-side. Product Owner approval is required before governed execution can proceed. No source changes or GitHub mutations have been performed.";
    } else {
      nextGovernedAction = "Execution authorisation verified server-side. Ready to proceed with governed execution through the canonical pipeline.";
    }

    // Derive proposed branch name (does NOT create the branch)
    let proposedBranch: string | null = null;
    if (ewoResolution.ewo_ref) {
      const ewoNum = ewoResolution.ewo_ref.replace(/^EWO-/i, "").toLowerCase();
      proposedBranch = `ewo/ewo-${ewoNum}`;
    }

    // 10. Persist audit evidence
    await supabase.from("engineering_change_log").insert({
      change_ref: auditRef,
      change_type: "created",
      ewo_ref: ewoResolution.ewo_ref,
      object_type: "execution_request",
      object_id: executionRequestId,
      summary: `Server-side execution preparation for ${ewoResolution.ewo_ref ?? "unknown EWO"}`,
      description: `Intent: ${clientIntent}, Authority: ${authority.authority_source} (${authority.role}), Provider: ${providerResult.selected_provider_id ?? "not resolved"}, Readiness: ${readinessStatus}, Blockers: ${blockers.length}`,
      actor_type: "system",
      actor: authority.user_email ?? authority.user_id ?? "unknown",
      is_reconstructed: false,
      linked_artefacts: [],
      metadata: {
        server_authoritative: true,
        user_id: authority.user_id,
        user_role: authority.role,
        conversation_id: conversationId,
        intent: clientIntent,
        provider_policy_version: providerResult.policy_version,
        fallback_permitted: providerResult.fallback_permitted,
        codex_mutation_performed: false,
        github_mutation_performed: false,
      },
    });

    const response: ExecutionPreparationResponse = {
      detected_intent: clientIntent,
      routing_decision: blockers.length === 0 ? "route_to_execution_pipeline" : "blocked",
      product_owner_authority: authority.is_authorised ? "verified" : "missing",
      ewo_ref: ewoResolution.ewo_ref,
      ewo_title: ewoResolution.ewo_title,
      ewo_status: ewoResolution.status,
      execution_request_id: executionRequestId,
      lifecycle_state: lifecycleState,
      provider_selected: providerResult.selected_provider_id,
      provider_policy_version: providerResult.policy_version,
      repository_owner: repoResult.repository_owner,
      repository_name: repoResult.repository_name,
      base_branch: repoResult.base_branch,
      proposed_execution_branch: proposedBranch,
      approval_status: approvalStatus,
      readiness_status: readinessStatus,
      fallback_permitted: providerResult.fallback_permitted,
      blockers,
      next_governed_action: nextGovernedAction,
      audit_reference: auditRef,
      server_authoritative: true,
      codex_mutation_performed: false,
      github_mutation_performed: false,
    };

    return ok(response);
  } catch (e) {
    return err(e instanceof Error ? e.message : "Internal error", 500);
  }
});
