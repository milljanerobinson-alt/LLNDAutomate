/*
# EWO-047 R2 — Restructured Governed Execution-Start RPC

Replaces the previous start_governed_execution RPC. The new version:
1. Validates all gates (EWO ready, approved request, approval record, no active execution, repo metadata, provider)
2. Creates a supervised_execution_records row in 'pending' state
3. Does NOT transition the EWO to in_progress yet
4. Returns the execution record ID so the caller can dispatch the pipeline

The caller (handleExecutionStart in the edge function) is responsible for:
- Calling executeSupervisedPipeline with the returned execution record
- Calling complete_execution_start RPC on success (transitions EWO ready → in_progress)
- Calling rollback_execution_start RPC on failure (marks execution record failed, EWO stays ready)
*/

DROP FUNCTION IF EXISTS public.start_governed_execution(uuid, uuid, text, text, text);


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

  v_execution_ref text;

  v_execution_record_id uuid;

  v_proposed_branch text;

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


  -- 3. Load the approved Execution Request
  IF p_execution_request_id IS NOT NULL THEN
    SELECT id, execution_ref, implementation_provider, implementation_status,
           po_status, metadata, created_at
    INTO v_exec
    FROM engineering_executions
    WHERE id = p_execution_request_id
      AND ewo_id = p_ewo_id;

  ELSE
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


  -- 6. No conflicting active execution (neither in engineering_executions nor supervised_execution_records)
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


  -- 7. Repository metadata must be complete
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


  -- 9. Repository config drift check
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
          RETURN jsonb_build_object('success', false, 'error', format('Repository owner drift: frozen "%s" differs from current "%s"', v_frozen_repo_owner, v_repo_config.repository_owner), 'code', 'repository_owner_drift', 'ewo_ref', v_ewo.ewo_ref, 'audit_reference', v_audit_ref);

        END IF;

        IF v_frozen_repo_name IS NOT NULL AND v_repo_config.repository_name <> v_frozen_repo_name THEN
          RETURN jsonb_build_object('success', false, 'error', format('Repository name drift: frozen "%s" differs from current "%s"', v_frozen_repo_name, v_repo_config.repository_name), 'code', 'repository_name_drift', 'ewo_ref', v_ewo.ewo_ref, 'audit_reference', v_audit_ref);

        END IF;

        IF v_frozen_base_branch IS NOT NULL AND v_repo_config.default_base_branch <> v_frozen_base_branch THEN
          RETURN jsonb_build_object('success', false, 'error', format('Base branch drift: frozen "%s" differs from current "%s"', v_frozen_base_branch, v_repo_config.default_base_branch), 'code', 'base_branch_drift', 'ewo_ref', v_ewo.ewo_ref, 'audit_reference', v_audit_ref);

        END IF;

      END;

    END IF;

  END IF;


  -- ════════════════════════════════════════════════════════════════════════
  -- ALL GATES PASSED — CREATE EXECUTION RECORD (pending state)
  -- EWO is NOT transitioned yet. The caller must dispatch the pipeline
  -- and then call complete_execution_start on success or
  -- rollback_execution_start on failure.
  -- ════════════════════════════════════════════════════════════════════════

  v_execution_ref := format('SER-%s-%s', v_ewo.ewo_ref, extract(epoch from now())::bigint);

  v_proposed_branch := format('ewo/ewo-%s', lower(regexp_replace(v_ewo.ewo_ref, '^EWO-', '')));


  -- Create supervised execution record in pending state
  INSERT INTO supervised_execution_records (
    execution_ref, ewo_id, ewo_ref, provider,
    execution_status, governance_gate_passed,
    provider_request, governance_diagnostics,
    audit_reference, execution_start
  ) VALUES (
    v_execution_ref,
    p_ewo_id,
    v_ewo.ewo_ref,
    v_exec.implementation_provider,
    'pending',
    true,
    jsonb_build_object(
      'execution_request_id', v_exec.id,
      'execution_ref', v_exec.execution_ref,
      'approval_ref', v_approval.approval_ref,
      'repository_owner', v_exec.metadata->>'repository_owner',
      'repository_name', v_exec.metadata->>'repository_name',
      'base_branch', v_exec.metadata->>'base_branch',
      'proposed_branch', v_proposed_branch,
      'conversation_id', p_conversation_id,
      'product_owner', p_product_owner,
      'audit_ref', v_audit_ref
    ),
    jsonb_build_object(
      'gates_passed', true,
      'ewo_status', 'ready',
      'po_status', 'approved',
      'approval_ref', v_approval.approval_ref,
      'provider', v_exec.implementation_provider,
      'provider_enabled', true,
      'provider_has_api_key', true
    ),
    v_audit_ref,
    now()
  ) RETURNING id INTO v_execution_record_id;


  -- Return success with execution record info — caller must dispatch pipeline
  RETURN jsonb_build_object(
    'success', true,
    'ewo_ref', v_ewo.ewo_ref,
    'ewo_status', v_ewo.status,
    'execution_request_id', v_exec.id,
    'execution_ref', v_exec.execution_ref,
    'approval_ref', v_approval.approval_ref,
    'execution_record_id', v_execution_record_id,
    'execution_record_ref', v_execution_ref,
    'provider', v_exec.implementation_provider,
    'repository_owner', v_exec.metadata->>'repository_owner',
    'repository_name', v_exec.metadata->>'repository_name',
    'base_branch', v_exec.metadata->>'base_branch',
    'proposed_branch', v_proposed_branch,
    'audit_reference', v_audit_ref,
    'message', format('Execution gates passed. Execution record %s created in pending state. Caller must dispatch the supervised pipeline and then call complete_execution_start or rollback_execution_start.', v_execution_ref)
  );

END;

$$;


-- ════════════════════════════════════════════════════════════════════════════
-- complete_execution_start: Called AFTER the pipeline succeeds.
-- Transitions EWO ready → in_progress, execution request → running,
-- supervised_execution_records → running, and records audit.
-- ════════════════════════════════════════════════════════════════════════════

CREATE OR REPLACE FUNCTION public.complete_execution_start(
  p_ewo_id uuid,
  p_execution_record_id uuid,
  p_execution_request_id uuid,
  p_product_owner text DEFAULT NULL,
  p_conversation_id text DEFAULT NULL,
  p_audit_ref text DEFAULT NULL,
  p_provider_result jsonb DEFAULT NULL
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_ewo RECORD;

  v_exec RECORD;

  v_exec_record RECORD;

  v_audit_ref text;

  v_proposed_branch text;

BEGIN
  v_audit_ref := COALESCE(p_audit_ref, format('EWO-EXEC-COMPLETE-%s-%s',
    extract(epoch from now())::bigint,
    substr(md5(random()::text), 1, 8)));


  -- Validate EWO
  SELECT id, ewo_ref, status INTO v_ewo
  FROM engineering_work_orders WHERE id = p_ewo_id;

  IF NOT FOUND THEN
    RETURN jsonb_build_object('success', false, 'error', 'EWO not found', 'code', 'ewo_not_found', 'audit_reference', v_audit_ref);

  END IF;


  -- EWO must still be 'ready' (not already transitioned)
  IF v_ewo.status <> 'ready' THEN
    RETURN jsonb_build_object('success', false, 'error', format('EWO already transitioned to %s', v_ewo.status), 'code', 'ewo_already_started', 'ewo_ref', v_ewo.ewo_ref, 'audit_reference', v_audit_ref);

  END IF;


  -- Validate execution record exists and is pending
  SELECT id, execution_ref, execution_status INTO v_exec_record
  FROM supervised_execution_records WHERE id = p_execution_record_id;

  IF NOT FOUND THEN
    RETURN jsonb_build_object('success', false, 'error', 'Execution record not found', 'code', 'execution_record_not_found', 'audit_reference', v_audit_ref);

  END IF;


  -- Validate execution request
  SELECT id, execution_ref INTO v_exec
  FROM engineering_executions WHERE id = p_execution_request_id;

  IF NOT FOUND THEN
    RETURN jsonb_build_object('success', false, 'error', 'Execution request not found', 'code', 'execution_request_not_found', 'audit_reference', v_audit_ref);

  END IF;


  v_proposed_branch := format('ewo/ewo-%s', lower(regexp_replace(v_ewo.ewo_ref, '^EWO-', '')));


  -- 1. Transition EWO: ready → in_progress
  UPDATE engineering_work_orders
  SET status = 'in_progress', updated_at = now()
  WHERE id = p_ewo_id;


  -- 2. Update Execution Request to running
  UPDATE engineering_executions
  SET implementation_status = 'running', started_at = now(), updated_at = now()
  WHERE id = p_execution_request_id;


  -- 3. Update supervised execution record to running
  UPDATE supervised_execution_records
  SET execution_status = 'running',
      provider_response = COALESCE(p_provider_result, provider_response),
      updated_at = now()
  WHERE id = p_execution_record_id;


  -- 4. Record lifecycle event
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
    format('Governed execution started. Execution Record: %s. Execution Request: %s. Provider result available: %s.', v_exec_record.execution_ref, v_exec.execution_ref, p_provider_result IS NOT NULL),
    'system',
    COALESCE(p_product_owner, 'unknown'),
    false,
    to_jsonb(ARRAY[v_exec_record.execution_ref, v_exec.execution_ref]),
    jsonb_build_object(
      'server_authoritative', true,
      'transition', 'ready_to_in_progress',
      'execution_record_id', p_execution_record_id,
      'execution_record_ref', v_exec_record.execution_ref,
      'execution_request_id', p_execution_request_id,
      'execution_request_ref', v_exec.execution_ref,
      'proposed_branch', v_proposed_branch,
      'conversation_id', p_conversation_id,
      'product_owner', p_product_owner,
      'codex_mutation_performed', false,
      'github_mutation_performed', false,
      'provider_dispatched', true
    ),
    true,
    'live'
  );


  RETURN jsonb_build_object(
    'success', true,
    'ewo_ref', v_ewo.ewo_ref,
    'ewo_status', 'in_progress',
    'execution_record_id', p_execution_record_id,
    'execution_record_ref', v_exec_record.execution_ref,
    'execution_request_id', p_execution_request_id,
    'proposed_branch', v_proposed_branch,
    'audit_reference', v_audit_ref
  );

END;

$$;


-- ════════════════════════════════════════════════════════════════════════════
-- rollback_execution_start: Called if the pipeline fails AFTER gates passed.
-- Marks execution record as failed, EWO stays ready, execution request stays approved.
-- ════════════════════════════════════════════════════════════════════════════

CREATE OR REPLACE FUNCTION public.rollback_execution_start(
  p_ewo_id uuid,
  p_execution_record_id uuid,
  p_execution_request_id uuid,
  p_failure_reason text,
  p_failure_stage text DEFAULT NULL,
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

  v_exec_record RECORD;

  v_audit_ref text;

BEGIN
  v_audit_ref := COALESCE(p_audit_ref, format('EWO-EXEC-ROLLBACK-%s-%s',
    extract(epoch from now())::bigint,
    substr(md5(random()::text), 1, 8)));


  SELECT id, ewo_ref, status INTO v_ewo
  FROM engineering_work_orders WHERE id = p_ewo_id;

  IF NOT FOUND THEN
    RETURN jsonb_build_object('success', false, 'error', 'EWO not found', 'audit_reference', v_audit_ref);

  END IF;


  SELECT id, execution_ref, execution_status INTO v_exec_record
  FROM supervised_execution_records WHERE id = p_execution_record_id;

  IF NOT FOUND THEN
    RETURN jsonb_build_object('success', false, 'error', 'Execution record not found', 'audit_reference', v_audit_ref);

  END IF;


  -- Mark execution record as failed
  UPDATE supervised_execution_records
  SET execution_status = 'failed',
      execution_finish = now(),
      updated_at = now(),
      governance_diagnostics = governance_diagnostics || jsonb_build_object(
        'failure_reason', p_failure_reason,
        'failure_stage', p_failure_stage,
        'rollback_performed', true
      )
  WHERE id = p_execution_record_id;


  -- EWO stays at 'ready' — no transition
  -- Execution request stays at 'approved' — no change

  -- Record rollback audit
  INSERT INTO engineering_change_log (
    change_ref, change_type, ewo_ref, object_type, object_id, object_ref,
    summary, description, actor_type, actor, is_reconstructed,
    linked_artefacts, metadata, immutable, recording_source
  ) VALUES (
    v_audit_ref,
    'execution_start_failed',
    v_ewo.ewo_ref,
    'supervised_execution_record',
    p_execution_record_id::text,
    v_exec_record.execution_ref,
    format('Execution start failed for %s — rolled back', v_ewo.ewo_ref),
    format('Failure stage: %s. Reason: %s. EWO remains at ready. Execution request remains approved.', COALESCE(p_failure_stage, 'unknown'), p_failure_reason),
    'system',
    COALESCE(p_product_owner, 'unknown'),
    false,
    to_jsonb(ARRAY[v_exec_record.execution_ref]),
    jsonb_build_object(
      'server_authoritative', true,
      'rollback_performed', true,
      'failure_reason', p_failure_reason,
      'failure_stage', p_failure_stage,
      'ewo_status', 'ready',
      'execution_request_status', 'approved',
      'conversation_id', p_conversation_id
    ),
    true,
    'live'
  );


  RETURN jsonb_build_object(
    'success', true,
    'ewo_ref', v_ewo.ewo_ref,
    'ewo_status', v_ewo.status,
    'execution_record_id', p_execution_record_id,
    'execution_record_ref', v_exec_record.execution_ref,
    'rolled_back', true,
    'failure_reason', p_failure_reason,
    'audit_reference', v_audit_ref
  );

END;

$$;


-- Grant permissions
REVOKE ALL ON FUNCTION public.start_governed_execution FROM public, anon;

GRANT EXECUTE ON FUNCTION public.start_governed_execution TO authenticated;


REVOKE ALL ON FUNCTION public.complete_execution_start FROM public, anon;

GRANT EXECUTE ON FUNCTION public.complete_execution_start TO authenticated;


REVOKE ALL ON FUNCTION public.rollback_execution_start FROM public, anon;

GRANT EXECUTE ON FUNCTION public.rollback_execution_start TO authenticated;

;
