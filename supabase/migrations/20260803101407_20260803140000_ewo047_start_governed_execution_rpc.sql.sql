/*
# EWO-047 — Governed Execution-Start RPC

Creates the `start_governed_execution` SECURITY DEFINER RPC that atomically
validates all execution-start prerequisites and transitions the EWO from
`ready` to `in_progress`.

## Purpose
Called by the prepare-execution-request edge function when the intent is
`engineering_execution_start`. Loads the existing approved Execution Request
as canonical — does NOT create a second request, re-resolve context, or
replace frozen values.

## Atomicity
The function body is a single PL/pgSQL transaction. If any gate fails, no
writes persist. The EWO lifecycle transition, execution request update,
and audit log are all written within the same transaction.

## Gates
1. EWO exists
2. EWO status = 'ready'
3. Exactly one approved Execution Request exists
4. Execution Request po_status = 'approved'
5. Matching ewo_execution_approvals record exists
6. No conflicting active execution (running/in_progress/executing)
7. Repository metadata complete
8. Provider enabled and configured
9. Tenant/project ownership match EWO
*/

CREATE OR REPLACE FUNCTION public.start_governed_execution(
  p_ewo_id uuid,
  p_execution_request_id uuid DEFAULT NULL,
  p_product_owner text DEFAULT NULL,
  p_conversation_id text DEFAULT NULL,
  p_audit_ref text DEFAULT NULL
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_ewo RECORD;

  v_exec RECORD;

  v_approval RECORD;

  v_active_exec RECORD;

  v_provider_config RECORD;

  v_repo_config RECORD;

  v_audit_ref text;

  v_proposed_branch text;

  v_execution_session_id uuid;

BEGIN
  v_audit_ref := COALESCE(p_audit_ref, format('EWO-EXEC-START-%s-%s',
    extract(epoch from now())::bigint,
    substr(md5(random()::text), 1, 8)));


  -- 1. Validate EWO exists
  SELECT id, ewo_ref, status, project_id, tenant_id, title
  INTO v_ewo
  FROM engineering_work_orders
  WHERE id = p_ewo_id;


  IF NOT FOUND THEN
    RETURN jsonb_build_object(
      'success', false,
      'error', 'EWO not found',
      'code', 'ewo_not_found',
      'audit_reference', v_audit_ref
    );

  END IF;


  -- 2. EWO status must be 'ready'
  IF v_ewo.status <> 'ready' THEN
    RETURN jsonb_build_object(
      'success', false,
      'error', format('EWO status must be ready, got %s', v_ewo.status),
      'code', 'ewo_not_ready',
      'current_status', v_ewo.status,
      'ewo_ref', v_ewo.ewo_ref,
      'audit_reference', v_audit_ref
    );

  END IF;


  -- 3. Load the approved Execution Request (canonical source of truth)
  IF p_execution_request_id IS NOT NULL THEN
    SELECT id, execution_ref, implementation_provider, implementation_status,
           po_status, metadata, created_at
    INTO v_exec
    FROM engineering_executions
    WHERE id = p_execution_request_id
      AND ewo_id = p_ewo_id;

  ELSE
    -- Find the most recent approved request for this EWO
    SELECT id, execution_ref, implementation_provider, implementation_status,
           po_status, metadata, created_at
    INTO v_exec
    FROM engineering_executions
    WHERE ewo_id = p_ewo_id
      AND po_status = 'approved'
    ORDER BY created_at DESC
    LIMIT 1;

  END IF;


  IF NOT FOUND THEN
    RETURN jsonb_build_object(
      'success', false,
      'error', 'No approved Execution Request found for this EWO',
      'code', 'execution_request_not_found',
      'ewo_ref', v_ewo.ewo_ref,
      'audit_reference', v_audit_ref
    );

  END IF;


  -- 4. Execution Request po_status must be 'approved'
  IF v_exec.po_status <> 'approved' THEN
    RETURN jsonb_build_object(
      'success', false,
      'error', format('Execution Request po_status must be approved, got %s', v_exec.po_status),
      'code', 'execution_request_not_approved',
      'ewo_ref', v_ewo.ewo_ref,
      'execution_request_id', v_exec.id,
      'po_status', v_exec.po_status,
      'audit_reference', v_audit_ref
    );

  END IF;


  -- 5. Matching approved ewo_execution_approvals record must exist
  SELECT id, approval_ref, decision
  INTO v_approval
  FROM ewo_execution_approvals
  WHERE ewo_id = p_ewo_id
    AND decision = 'approved'
  ORDER BY created_at DESC
  LIMIT 1;


  IF NOT FOUND THEN
    RETURN jsonb_build_object(
      'success', false,
      'error', 'No approved Product Owner execution approval record found',
      'code', 'approval_record_missing',
      'ewo_ref', v_ewo.ewo_ref,
      'audit_reference', v_audit_ref
    );

  END IF;


  -- 6. No conflicting active execution
  SELECT id, implementation_status
  INTO v_active_exec
  FROM engineering_executions
  WHERE ewo_id = p_ewo_id
    AND id <> v_exec.id
    AND implementation_status IN ('running', 'in_progress', 'executing')
  LIMIT 1;


  IF FOUND THEN
    RETURN jsonb_build_object(
      'success', false,
      'error', format('Execution %s is already in progress (%s)', v_active_exec.id, v_active_exec.implementation_status),
      'code', 'execution_already_active',
      'ewo_ref', v_ewo.ewo_ref,
      'active_execution_id', v_active_exec.id,
      'audit_reference', v_audit_ref
    );

  END IF;


  -- Also check if THIS execution request is already running
  IF v_exec.implementation_status IN ('running', 'in_progress', 'executing') THEN
    RETURN jsonb_build_object(
      'success', false,
      'error', format('Execution Request %s is already in progress (%s)', v_exec.id, v_exec.implementation_status),
      'code', 'execution_already_active',
      'ewo_ref', v_ewo.ewo_ref,
      'execution_request_id', v_exec.id,
      'audit_reference', v_audit_ref
    );

  END IF;


  -- 7. Repository metadata must be complete (from frozen package)
  DECLARE
    v_repo_owner text := (v_exec.metadata->>'repository_owner');

    v_repo_name text := (v_exec.metadata->>'repository_name');

    v_base_branch text := (v_exec.metadata->>'base_branch');

  BEGIN
    IF v_repo_owner IS NULL OR v_repo_name IS NULL OR v_base_branch IS NULL THEN
      RETURN jsonb_build_object(
        'success', false,
        'error', 'Repository metadata incomplete in frozen Execution Request',
        'code', 'repository_metadata_missing',
        'ewo_ref', v_ewo.ewo_ref,
        'execution_request_id', v_exec.id,
        'audit_reference', v_audit_ref
      );

    END IF;

  END;


  -- 8. Provider must remain enabled and configured
  SELECT provider, is_enabled, has_api_key
  INTO v_provider_config
  FROM ai_provider_configs
  WHERE provider = v_exec.implementation_provider
  LIMIT 1;


  IF NOT FOUND OR NOT v_provider_config.is_enabled THEN
    RETURN jsonb_build_object(
      'success', false,
      'error', format('Provider "%s" is no longer enabled', v_exec.implementation_provider),
      'code', 'provider_not_available',
      'ewo_ref', v_ewo.ewo_ref,
      'provider', v_exec.implementation_provider,
      'audit_reference', v_audit_ref
    );

  END IF;


  IF NOT v_provider_config.has_api_key THEN
    RETURN jsonb_build_object(
      'success', false,
      'error', format('Provider "%s" no longer has a configured API key', v_exec.implementation_provider),
      'code', 'provider_credential_missing',
      'ewo_ref', v_ewo.ewo_ref,
      'provider', v_exec.implementation_provider,
      'audit_reference', v_audit_ref
    );

  END IF;


  -- 9. Narrow integrity check: repository config still active if project_id exists
  IF v_ewo.project_id IS NOT NULL THEN
    SELECT repository_owner, repository_name, default_base_branch, lifecycle_status
    INTO v_repo_config
    FROM github_repository_config
    WHERE project_id = v_ewo.project_id
    LIMIT 1;


    IF FOUND AND v_repo_config.lifecycle_status = 'active' THEN
      DECLARE
        v_frozen_repo_owner text := (v_exec.metadata->>'repository_owner');

        v_frozen_repo_name text := (v_exec.metadata->>'repository_name');

        v_frozen_base_branch text := (v_exec.metadata->>'base_branch');

      BEGIN
        IF v_frozen_repo_owner IS NOT NULL AND v_repo_config.repository_owner <> v_frozen_repo_owner THEN
          RETURN jsonb_build_object(
            'success', false,
            'error', format('Repository owner drift: frozen "%s" differs from current "%s"',
              v_frozen_repo_owner, v_repo_config.repository_owner),
            'code', 'repository_owner_drift',
            'ewo_ref', v_ewo.ewo_ref,
            'audit_reference', v_audit_ref
          );

        END IF;

        IF v_frozen_repo_name IS NOT NULL AND v_repo_config.repository_name <> v_frozen_repo_name THEN
          RETURN jsonb_build_object(
            'success', false,
            'error', format('Repository name drift: frozen "%s" differs from current "%s"',
              v_frozen_repo_name, v_repo_config.repository_name),
            'code', 'repository_name_drift',
            'ewo_ref', v_ewo.ewo_ref,
            'audit_reference', v_audit_ref
          );

        END IF;

        IF v_frozen_base_branch IS NOT NULL AND v_repo_config.default_base_branch <> v_frozen_base_branch THEN
          RETURN jsonb_build_object(
            'success', false,
            'error', format('Base branch drift: frozen "%s" differs from current "%s"',
              v_frozen_base_branch, v_repo_config.default_base_branch),
            'code', 'base_branch_drift',
            'ewo_ref', v_ewo.ewo_ref,
            'audit_reference', v_audit_ref
          );

        END IF;

      END;

    END IF;

  END IF;


  -- ════════════════════════════════════════════════════════════════════════
  -- ALL GATES PASSED — ATOMIC EXECUTION-START TRANSACTION
  -- ════════════════════════════════════════════════════════════════════════

  -- Derive proposed branch
  v_proposed_branch := format('ewo/ewo-%s', lower(regexp_replace(v_ewo.ewo_ref, '^EWO-', '')));


  -- 1. Transition EWO: ready → in_progress
  UPDATE engineering_work_orders
  SET status = 'in_progress',
      updated_at = now()
  WHERE id = p_ewo_id;


  -- 2. Update Execution Request to running state
  UPDATE engineering_executions
  SET implementation_status = 'running',
      started_at = now(),
      updated_at = now()
  WHERE id = v_exec.id;


  -- 3. Record lifecycle event
  INSERT INTO engineering_change_log (
    change_ref, change_type, ewo_ref, object_type, object_id, object_ref,
    summary, description, actor_type, actor, is_reconstructed,
    linked_artefacts, metadata, immutable, recording_source
  ) VALUES (
    v_audit_ref,
    'lifecycle_transition',
    v_ewo.ewo_ref,
    'engineering_work_order',
    p_ewo_id::text,
    v_ewo.ewo_ref,
    format('EWO %s transitioned from ready to in_progress', v_ewo.ewo_ref),
    format(
      'Governed execution started for %s. Execution Request: %s. Provider: %s. Repository: %s/%s. Base branch: %s. Proposed branch: %s. Approval: %s. Product Owner: %s.',
      v_ewo.ewo_ref,
      v_exec.id,
      v_exec.implementation_provider,
      v_exec.metadata->>'repository_owner',
      v_exec.metadata->>'repository_name',
      v_exec.metadata->>'base_branch',
      v_proposed_branch,
      v_approval.approval_ref,
      COALESCE(p_product_owner, 'unknown')
    ),
    'system',
    COALESCE(p_product_owner, 'unknown'),
    false,
    to_jsonb(ARRAY_REMOVE(ARRAY[
      v_exec.metadata->>'audit_ref',
      v_exec.metadata->>'context_audit_ref',
      v_approval.approval_ref
    ], NULL)),
    jsonb_build_object(
      'server_authoritative', true,
      'transition', 'ready_to_in_progress',
      'execution_request_id', v_exec.id,
      'execution_ref', v_exec.execution_ref,
      'approval_ref', v_approval.approval_ref,
      'provider', v_exec.implementation_provider,
      'repository_owner', v_exec.metadata->>'repository_owner',
      'repository_name', v_exec.metadata->>'repository_name',
      'base_branch', v_exec.metadata->>'base_branch',
      'proposed_branch', v_proposed_branch,
      'conversation_id', p_conversation_id,
      'product_owner', p_product_owner,
      'codex_mutation_performed', false,
      'github_mutation_performed', false
    ),
    true,
    'live'
  );


  -- 4. Return success with full execution context
  RETURN jsonb_build_object(
    'success', true,
    'ewo_ref', v_ewo.ewo_ref,
    'ewo_status', 'in_progress',
    'execution_request_id', v_exec.id,
    'execution_ref', v_exec.execution_ref,
    'approval_ref', v_approval.approval_ref,
    'provider', v_exec.implementation_provider,
    'repository_owner', v_exec.metadata->>'repository_owner',
    'repository_name', v_exec.metadata->>'repository_name',
    'base_branch', v_exec.metadata->>'base_branch',
    'proposed_branch', v_proposed_branch,
    'audit_reference', v_audit_ref,
    'message', format('Governed execution started for %s. EWO transitioned to in_progress. Execution Request %s is now running.', v_ewo.ewo_ref, v_exec.id)
  );

END;

$$;


-- Re-grant permissions
REVOKE ALL ON FUNCTION public.start_governed_execution FROM public, anon;

GRANT EXECUTE ON FUNCTION public.start_governed_execution TO authenticated;

;
