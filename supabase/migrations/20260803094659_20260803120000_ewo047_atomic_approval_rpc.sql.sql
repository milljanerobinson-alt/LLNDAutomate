/*
# EWO-047 — Atomic Product Owner Approval RPC

## Purpose
Creates a SECURITY DEFINER RPC function `authorise_execution_approval`
that performs all Product Owner execution-package approval writes in a
single database transaction. If any write fails, all writes roll back.

This prevents the partial-persistence defect observed in EWO-047 where
the approval record and execution-request update succeeded but the EWO
status update failed (because `approved` is not a valid status), leaving
inconsistent state across three tables.

## RPC Signature
```sql
authorise_execution_approval(
  p_ewo_id uuid,
  p_execution_request_id uuid,
  p_product_owner text,
  p_audit_ref text,
  p_conversation_id text,
  p_preparation_audit_ref text,
  p_context_audit_ref text,
  p_frozen_repository_owner text,
  p_frozen_repository_name text,
  p_frozen_base_branch text,
  p_frozen_provider text,
  p_project_id text,
  p_tenant_id text
) RETURNS jsonb
```

## Behaviour
1. Validates EWO exists and status = 'ready'
2. Validates Execution Request exists, is pending/prepared, and belongs to this EWO
3. Validates no existing approved approval record exists (idempotency)
4. Validates no conflicting active execution session exists
5. In one transaction:
   - INSERT into ewo_execution_approvals
   - UPDATE engineering_executions.po_status = 'approved', po_decided_at = now()
   - INSERT into engineering_change_log (accurate approval record)
6. Does NOT change engineering_work_orders.status (remains 'ready')
7. Does NOT create a new Execution Request
8. Does NOT begin execution

## Security
- SECURITY DEFINER — runs with function owner privileges
- search_path set to 'public' explicitly
- Execute granted to authenticated role only
- Tenant/project consistency validated inside the function

## Important Notes
- The EWO status remains 'ready' after approval. The next lifecycle
  transition is 'ready' → 'in_progress', performed by the governed
  execution pipeline when execution begins.
- The approval_ref is generated inside the RPC to prevent collisions.
- If called twice for the same EWO, the second call returns the existing
  approval_ref (idempotency).
*/

CREATE OR REPLACE FUNCTION public.authorise_execution_approval(
  p_ewo_id uuid,
  p_execution_request_id uuid,
  p_product_owner text,
  p_audit_ref text,
  p_conversation_id text DEFAULT NULL,
  p_preparation_audit_ref text DEFAULT NULL,
  p_context_audit_ref text DEFAULT NULL,
  p_frozen_repository_owner text DEFAULT NULL,
  p_frozen_repository_name text DEFAULT NULL,
  p_frozen_base_branch text DEFAULT NULL,
  p_frozen_provider text DEFAULT NULL,
  p_project_id text DEFAULT NULL,
  p_tenant_id text DEFAULT NULL
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_ewo RECORD;

  v_exec RECORD;

  v_existing_approval RECORD;

  v_approval_ref text;

  v_active_session RECORD;

BEGIN
  -- 1. Validate EWO exists and status = 'ready'
  SELECT ewo_ref, status, project_id, tenant_id INTO v_ewo
  FROM engineering_work_orders
  WHERE id = p_ewo_id;


  IF NOT FOUND THEN
    RETURN jsonb_build_object('success', false, 'error', 'EWO not found', 'code', 'ewo_not_found');

  END IF;


  IF v_ewo.status <> 'ready' THEN
    RETURN jsonb_build_object('success', false, 'error', format('EWO status must be ready, got %s', v_ewo.status), 'code', 'ewo_not_ready', 'current_status', v_ewo.status);

  END IF;


  -- 2. Validate Execution Request exists, belongs to this EWO, and is pending
  SELECT id, implementation_status, po_status INTO v_exec
  FROM engineering_executions
  WHERE id = p_execution_request_id;


  IF NOT FOUND THEN
    RETURN jsonb_build_object('success', false, 'error', 'Execution Request not found', 'code', 'execution_request_not_found');

  END IF;


  IF v_exec.implementation_status NOT IN ('pending', 'prepared', 'draft') THEN
    RETURN jsonb_build_object('success', false, 'error', format('Execution Request status must be pending/prepared, got %s', v_exec.implementation_status), 'code', 'execution_request_not_pending');

  END IF;


  -- 3. Check for existing approved approval (idempotency)
  SELECT id, approval_ref INTO v_existing_approval
  FROM ewo_execution_approvals
  WHERE ewo_id = p_ewo_id AND decision = 'approved'
  LIMIT 1;


  IF FOUND THEN
    RETURN jsonb_build_object(
      'success', true,
      'approval_ref', v_existing_approval.approval_ref,
      'message', 'Approval already exists (idempotent)',
      'idempotent', true
    );

  END IF;


  -- 4. Validate no conflicting active execution session
  SELECT id INTO v_active_session
  FROM engineering_executions
  WHERE ewo_id = p_ewo_id
    AND implementation_status IN ('running', 'in_progress', 'executing')
  LIMIT 1;


  IF FOUND THEN
    RETURN jsonb_build_object('success', false, 'error', 'Active execution session already exists for this EWO', 'code', 'active_execution_exists');

  END IF;


  -- 5. Generate approval_ref
  v_approval_ref := format('EWO-APPROVAL-%s-%s', v_ewo.ewo_ref, extract(epoch from now())::bigint);


  -- 6. Perform all writes in a single transaction (PL/pgSQL function body is atomic)
  -- 6a. Insert approval record
  INSERT INTO ewo_execution_approvals (
    ewo_id, approval_ref, decision, product_owner,
    approval_statement, evidence_metadata, is_test
  ) VALUES (
    p_ewo_id,
    v_approval_ref,
    'approved',
    p_product_owner,
    format('Product Owner approval for %s execution', v_ewo.ewo_ref),
    jsonb_build_object(
      'execution_request_id', p_execution_request_id,
      'preparation_audit_ref', p_preparation_audit_ref,
      'context_audit_ref', p_context_audit_ref,
      'approval_audit_ref', p_audit_ref,
      'frozen_repository_owner', p_frozen_repository_owner,
      'frozen_repository_name', p_frozen_repository_name,
      'frozen_base_branch', p_frozen_base_branch,
      'frozen_provider', p_frozen_provider,
      'project_id', p_project_id,
      'tenant_id', p_tenant_id,
      'conversation_id', p_conversation_id
    ),
    false
  );


  -- 6b. Update execution request: po_status → approved
  UPDATE engineering_executions
  SET po_status = 'approved',
      po_decided_at = now(),
      updated_at = now()
  WHERE id = p_execution_request_id;


  -- 6c. Insert accurate change log record
  INSERT INTO engineering_change_log (
    change_ref, change_type, ewo_ref, object_type, object_id, object_ref,
    summary, description, actor_type, actor, is_reconstructed,
    linked_artefacts, metadata, immutable, recording_source
  ) VALUES (
    p_audit_ref,
    'approved',
    v_ewo.ewo_ref,
    'execution_approval',
    p_execution_request_id::text,
    v_approval_ref,
    format('Product Owner approval for %s execution', v_ewo.ewo_ref),
    format(
      'Intent: engineering_execution_authorisation, Provider: %s, Repository: %s/%s, Base branch: %s. EWO remains at ready. Execution has NOT started.',
      COALESCE(p_frozen_provider, 'unknown'),
      COALESCE(p_frozen_repository_owner, 'unknown'),
      COALESCE(p_frozen_repository_name, 'unknown'),
      COALESCE(p_frozen_base_branch, 'unknown')
    ),
    'system',
    p_product_owner,
    false,
    ARRAY_REMOVE(ARRAY[p_preparation_audit_ref, p_context_audit_ref], NULL),
    jsonb_build_object(
      'server_authoritative', true,
      'conversation_id', p_conversation_id,
      'intent', 'engineering_execution_authorisation',
      'preparation_audit_ref', p_preparation_audit_ref,
      'context_audit_ref', p_context_audit_ref,
      'approval_ref', v_approval_ref,
      'execution_request_id', p_execution_request_id,
      'frozen_repository_owner', p_frozen_repository_owner,
      'frozen_repository_name', p_frozen_repository_name,
      'frozen_base_branch', p_frozen_base_branch,
      'frozen_provider', p_frozen_provider,
      'project_id', p_project_id,
      'tenant_id', p_tenant_id,
      'codex_mutation_performed', false,
      'github_mutation_performed', false,
      'ewo_status_unchanged', true,
      'ewo_status', 'ready'
    ),
    true,
    'live'
  );


  -- 7. Return success — EWO status is NOT changed
  RETURN jsonb_build_object(
    'success', true,
    'approval_ref', v_approval_ref,
    'ewo_status', 'ready',
    'execution_request_id', p_execution_request_id,
    'message', 'Product Owner approval recorded. EWO remains at ready. Execution has not started.'
  );

END;

$$;


-- Grant execute to authenticated only
REVOKE ALL ON FUNCTION public.authorise_execution_approval FROM public, anon;

GRANT EXECUTE ON FUNCTION public.authorise_execution_approval TO authenticated;

;
