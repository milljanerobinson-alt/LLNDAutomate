/*
# EWO-049R5 — Canonical EWO Reference Correction

## Purpose

The Conversation Orchestrator was passing a descriptive slug
(e.g. "EWO-049-Change-the-New-Conversation-button-to-pi-42") as
p_reserved_ewo_ref to create_canonical_ewo_governed. The RPC used
this slug directly as the canonical ewo_ref, producing long
non-sequential references instead of the intended "EWO-049" format.

This migration changes Overload 2 so that:
  - p_reserved_ewo_ref is used ONLY for reservation/idempotency lookup
  - The canonical ewo_ref is ALWAYS generated from the sequence
    (ewo_canonical_ref_seq), producing "EWO-001", "EWO-002", etc.
  - The reservation is linked to the generated canonical ref

## Changes

### create_canonical_ewo_governed (Overload 2 — with p_reserved_ewo_ref)

Gate 2 is restructured:
  a. Check if a live EWO exists with the SAME reservation ref → block
     (this is the idempotency check — if an EWO was already created
     from this reservation, don't create another)
  b. Lock and inspect the reservation row (same orphan recovery logic
     from EWO-050R)
  c. Generate the canonical ewo_ref from the sequence (NOT from the
     reservation ref)
  d. Create the EWO with the sequential ref
  e. Update the reservation to consumed with the new ewo_id

The reservation ref (p_reserved_ewo_ref) is NEVER used as the
canonical ewo_ref. It is only used for:
  - Idempotency: checking if an EWO was already created from this plan
  - Reservation: preventing concurrent creation from the same plan

## Security
- No RLS changes
- SECURITY DEFINER maintained
- search_path = public maintained
- No data loss

## Important Notes
1. Only Overload 2 is changed
2. The reservation ref is preserved in ewo_ref_reservations for
   idempotency, but the canonical ewo_ref is always sequential
3. Existing EWOs with slug-based refs are NOT affected
4. The orphan recovery logic from EWO-050R is preserved
*/

-- ─── Replace create_canonical_ewo_governed Overload 2 ──────────────────────

DROP FUNCTION IF EXISTS create_canonical_ewo_governed(
  text, text, text, text, text, text, text, text, text, text, text, text, text, uuid, uuid
);


CREATE OR REPLACE FUNCTION create_canonical_ewo_governed(
  p_execution_context text,
  p_title text,
  p_executive_summary text,
  p_priority text DEFAULT 'medium',
  p_risk_level text DEFAULT 'medium',
  p_implementation_provider text DEFAULT 'codex',
  p_created_by_email text DEFAULT NULL,
  p_created_by_role text DEFAULT NULL,
  p_originating_conversation_ref text DEFAULT NULL,
  p_source_idea_id text DEFAULT NULL,
  p_source_plan_ref text DEFAULT NULL,
  p_correlation_id text DEFAULT NULL,
  p_reserved_ewo_ref text DEFAULT NULL,
  p_tenant_id uuid DEFAULT NULL,
  p_project_id uuid DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_ewo_ref text;

  v_ewo_id uuid;

  v_audit_ref text;

  v_rejection_reason text;

  v_context_enum ewo_execution_context;

  v_allowed_contexts text[] := ARRAY['canonical_production', 'product_owner_manual', 'historical_import', 'governed_migration'];

  v_reservation record;

  v_conflict_category text;

  v_previous_ewo_id uuid;

  v_previous_status text;

  v_orphan_recovered boolean := false;

BEGIN
  v_audit_ref := COALESCE(p_correlation_id, 'EWO-GATEWAY-' || extract(epoch from now())::bigint || '-' || md5(random()::text));


  -- ─── Gate 0: Validate ownership context ───
  IF p_tenant_id IS NULL THEN
    v_rejection_reason := 'Tenant (organisation) ID is required for canonical EWO creation';

    INSERT INTO ewo_creation_attempt_log (
      caller_email, caller_role, execution_context, creation_pathway,
      rejection_reason, correlation_id, was_blocked, was_created, metadata
    ) VALUES (
      p_created_by_email, p_created_by_role, COALESCE(p_execution_context, 'NULL'),
      'create_canonical_ewo_governed', v_rejection_reason, v_audit_ref,
      true, false, jsonb_build_object('gate', 'tenant_required')
    );

    RETURN jsonb_build_object(
      'success', false, 'blocked', true, 'rejection_reason', v_rejection_reason,
      'conflict_category', 'tenant_required'
    );

  END IF;


  IF p_project_id IS NULL THEN
    v_rejection_reason := 'Project ID is required for canonical EWO creation';

    INSERT INTO ewo_creation_attempt_log (
      caller_email, caller_role, execution_context, creation_pathway,
      rejection_reason, correlation_id, was_blocked, was_created, metadata
    ) VALUES (
      p_created_by_email, p_created_by_role, COALESCE(p_execution_context, 'NULL'),
      'create_canonical_ewo_governed', v_rejection_reason, v_audit_ref,
      true, false, jsonb_build_object('gate', 'project_required')
    );

    RETURN jsonb_build_object(
      'success', false, 'blocked', true, 'rejection_reason', v_rejection_reason,
      'conflict_category', 'project_required'
    );

  END IF;


  IF NOT EXISTS (SELECT 1 FROM eios_tenants WHERE id = p_tenant_id AND status = 'active') THEN
    v_rejection_reason := 'Tenant ID does not reference an active organisation';

    INSERT INTO ewo_creation_attempt_log (
      caller_email, caller_role, execution_context, creation_pathway,
      rejection_reason, correlation_id, was_blocked, was_created, metadata
    ) VALUES (
      p_created_by_email, p_created_by_role, COALESCE(p_execution_context, 'NULL'),
      'create_canonical_ewo_governed', v_rejection_reason, v_audit_ref,
      true, false, jsonb_build_object('gate', 'tenant_invalid', 'tenant_id', p_tenant_id)
    );

    RETURN jsonb_build_object(
      'success', false, 'blocked', true, 'rejection_reason', v_rejection_reason,
      'conflict_category', 'tenant_invalid'
    );

  END IF;


  IF NOT EXISTS (SELECT 1 FROM ecc_projects WHERE id = p_project_id AND status = 'active') THEN
    v_rejection_reason := 'Project ID does not reference an active engineering project';

    INSERT INTO ewo_creation_attempt_log (
      caller_email, caller_role, execution_context, creation_pathway,
      rejection_reason, correlation_id, was_blocked, was_created, metadata
    ) VALUES (
      p_created_by_email, p_created_by_role, COALESCE(p_execution_context, 'NULL'),
      'create_canonical_ewo_governed', v_rejection_reason, v_audit_ref,
      true, false, jsonb_build_object('gate', 'project_invalid', 'project_id', p_project_id)
    );

    RETURN jsonb_build_object(
      'success', false, 'blocked', true, 'rejection_reason', v_rejection_reason,
      'conflict_category', 'project_invalid'
    );

  END IF;


  -- ─── Gate 1: Validate execution context ───
  IF p_execution_context IS NULL OR btrim(p_execution_context) = '' THEN
    v_rejection_reason := 'Execution context is required and must not be null or empty';

    INSERT INTO ewo_creation_attempt_log (
      caller_email, caller_role, execution_context, creation_pathway,
      rejection_reason, correlation_id, was_blocked, was_created, metadata
    ) VALUES (
      p_created_by_email, p_created_by_role, 'NULL',
      'create_canonical_ewo_governed', v_rejection_reason, v_audit_ref,
      true, false, jsonb_build_object('gate', 'context_required')
    );

    RETURN jsonb_build_object('success', false, 'blocked', true, 'rejection_reason', v_rejection_reason, 'conflict_category', 'context_required');

  END IF;


  IF NOT (p_execution_context = ANY(v_allowed_contexts)) THEN
    v_rejection_reason := 'Execution context ''' || p_execution_context || ''' is not authorised for canonical EWO creation';

    INSERT INTO ewo_creation_attempt_log (
      caller_email, caller_role, execution_context, creation_pathway,
      rejection_reason, correlation_id, was_blocked, was_created, metadata
    ) VALUES (
      p_created_by_email, p_created_by_role, p_execution_context,
      'create_canonical_ewo_governed', v_rejection_reason, v_audit_ref,
      true, false, jsonb_build_object('gate', 'context_not_authorised')
    );

    RETURN jsonb_build_object('success', false, 'blocked', true, 'rejection_reason', v_rejection_reason, 'conflict_category', 'context_not_authorised');

  END IF;


  v_context_enum := p_execution_context::ewo_execution_context;


  -- ─── Gate 2: Resolve reservation (SAFE ORPHAN RECOVERY) ───
  -- p_reserved_ewo_ref is used ONLY for idempotency/reservation,
  -- NOT as the canonical ewo_ref. The canonical ref is always sequential.
  IF p_reserved_ewo_ref IS NOT NULL AND btrim(p_reserved_ewo_ref) != '' THEN

    -- 2a. Idempotency check: if a consumed reservation links to a LIVE EWO,
    -- that means an EWO was already created from this plan. Return it.
    SELECT * INTO v_reservation FROM ewo_ref_reservations
    WHERE ewo_ref = p_reserved_ewo_ref
    FOR UPDATE;


    IF FOUND THEN
      IF v_reservation.status = 'consumed' AND v_reservation.ewo_id IS NOT NULL THEN
        -- Check if the linked EWO still exists
        IF EXISTS (SELECT 1 FROM engineering_work_orders WHERE id = v_reservation.ewo_id) THEN
          -- EWO exists — this is an idempotent retry. Return the existing EWO.
          SELECT ewo_ref INTO v_ewo_ref FROM engineering_work_orders WHERE id = v_reservation.ewo_id;

          SELECT id INTO v_ewo_id FROM engineering_work_orders WHERE id = v_reservation.ewo_id;


          INSERT INTO ewo_creation_attempt_log (
            caller_email, caller_role, execution_context, creation_pathway,
            rejection_reason, correlation_id, was_blocked, was_created,
            attempted_ewo_ref, created_ewo_id, metadata
          ) VALUES (
            p_created_by_email, p_created_by_role, p_execution_context,
            'create_canonical_ewo_governed', NULL, v_audit_ref,
            false, true, v_ewo_ref, v_ewo_id,
            jsonb_build_object('gate', 'idempotent_reuse', 'reserved_ref', p_reserved_ewo_ref, 'reused_ewo_id', v_ewo_id)
          );


          RETURN jsonb_build_object(
            'success', true,
            'blocked', false,
            'ewo_id', v_ewo_id,
            'ewo_ref', v_ewo_ref,
            'reserved_ref_used', true,
            'idempotent_reuse', true
          );

        ELSE
          -- EWO does NOT exist — orphan. Safe to recover.
          v_previous_ewo_id := v_reservation.ewo_id;

          v_previous_status := v_reservation.status;

          v_orphan_recovered := true;


          UPDATE ewo_ref_reservations
          SET status = 'reserved',
              consumed_at = NULL,
              ewo_id = NULL,
              reserved_at = now(),
              reserved_by = COALESCE(p_created_by_email, 'system'),
              reservation_context = 'governed_gateway_orphan_recovery',
              correlation_id = v_audit_ref
          WHERE ewo_ref = p_reserved_ewo_ref;

        END IF;


      ELSIF v_reservation.status = 'reserved' THEN
        -- Active reservation — safe to reuse (same caller retrying)
        NULL;
 -- do nothing, reservation is ready

      ELSIF v_reservation.status = 'consumed' AND v_reservation.ewo_id IS NULL THEN
        v_rejection_reason := 'Reservation for ''' || p_reserved_ewo_ref || ''' is consumed but has no linked EWO';

        v_conflict_category := 'unclassified_reservation_conflict';

        INSERT INTO ewo_creation_attempt_log (
          caller_email, caller_role, execution_context, creation_pathway,
          rejection_reason, correlation_id, was_blocked, was_created, metadata
        ) VALUES (
          p_created_by_email, p_created_by_role, p_execution_context,
          'create_canonical_ewo_governed', v_rejection_reason, v_audit_ref,
          true, false, jsonb_build_object('gate', 'reservation_conflict', 'conflict_category', v_conflict_category,
            'reserved_ref', p_reserved_ewo_ref)
        );

        RETURN jsonb_build_object('success', false, 'blocked', true, 'rejection_reason', v_rejection_reason, 'conflict_category', v_conflict_category);


      ELSE
        v_rejection_reason := 'Reservation for ''' || p_reserved_ewo_ref || ''' has unrecognised status ''' || v_reservation.status || '''';

        v_conflict_category := 'unclassified_reservation_conflict';

        INSERT INTO ewo_creation_attempt_log (
          caller_email, caller_role, execution_context, creation_pathway,
          rejection_reason, correlation_id, was_blocked, was_created, metadata
        ) VALUES (
          p_created_by_email, p_created_by_role, p_execution_context,
          'create_canonical_ewo_governed', v_rejection_reason, v_audit_ref,
          true, false, jsonb_build_object('gate', 'reservation_conflict', 'conflict_category', v_conflict_category,
            'reserved_ref', p_reserved_ewo_ref, 'reservation_status', v_reservation.status)
        );

        RETURN jsonb_build_object('success', false, 'blocked', true, 'rejection_reason', v_rejection_reason, 'conflict_category', v_conflict_category);

      END IF;


    ELSE
      -- No reservation row exists. Safe to INSERT a new one.
      BEGIN
        INSERT INTO ewo_ref_reservations (ewo_ref, reserved_by, reservation_context, correlation_id)
        VALUES (p_reserved_ewo_ref, COALESCE(p_created_by_email, 'system'), 'governed_gateway_auto_reserve', v_audit_ref);

      EXCEPTION WHEN unique_violation THEN
        v_rejection_reason := 'Reservation for ''' || p_reserved_ewo_ref || ''' was concurrently created by another request';

        v_conflict_category := 'reservation_owned_by_other_active_attempt';

        INSERT INTO ewo_creation_attempt_log (
          caller_email, caller_role, execution_context, creation_pathway,
          rejection_reason, correlation_id, was_blocked, was_created, metadata
        ) VALUES (
          p_created_by_email, p_created_by_role, p_execution_context,
          'create_canonical_ewo_governed', v_rejection_reason, v_audit_ref,
          true, false, jsonb_build_object('gate', 'reservation_conflict', 'conflict_category', v_conflict_category,
            'reserved_ref', p_reserved_ewo_ref)
        );

        RETURN jsonb_build_object('success', false, 'blocked', true, 'rejection_reason', v_rejection_reason, 'conflict_category', v_conflict_category);

      END;

    END IF;


  END IF;


  -- ─── Gate 3: Generate canonical EWO reference (ALWAYS sequential) ───
  v_ewo_ref := 'EWO-' || lpad(nextval('ewo_canonical_ref_seq')::text, 3, '0');


  -- ─── Gate 4: Create the canonical EWO ───
  INSERT INTO engineering_work_orders (
    ewo_ref, title, executive_summary, status, priority, risk_level,
    implementation_provider, implementation_status, engineering_package_status,
    execution_context, created_at, tenant_id, project_id
  ) VALUES (
    v_ewo_ref, p_title, p_executive_summary, 'ready',
    p_priority, p_risk_level, p_implementation_provider,
    'Assigned', 'Generated', v_context_enum, now(),
    p_tenant_id, p_project_id
  ) RETURNING id INTO v_ewo_id;


  -- ─── Consume reservation if used ───
  IF p_reserved_ewo_ref IS NOT NULL THEN
    UPDATE ewo_ref_reservations
    SET status = 'consumed', consumed_at = now(), ewo_id = v_ewo_id
    WHERE ewo_ref = p_reserved_ewo_ref AND status = 'reserved';

  END IF;


  -- ─── Record lifecycle event ───
  INSERT INTO ewo_lifecycle_events (ewo_id, from_status, to_status, actor, notes, metadata, created_at)
  VALUES (
    v_ewo_id, NULL, 'ready',
    COALESCE(p_created_by_email, 'system'),
    'Canonical EWO ' || v_ewo_ref || ' created via governed gateway. Execution context: ' || p_execution_context ||
    CASE WHEN p_reserved_ewo_ref IS NOT NULL THEN '. Plan reservation: ' || p_reserved_ewo_ref ELSE '' END,
    jsonb_build_object(
      'source', 'create_canonical_ewo_governed',
      'execution_context', p_execution_context,
      'correlation_id', v_audit_ref,
      'plan_reservation_ref', p_reserved_ewo_ref,
      'canonical_ewo_ref', v_ewo_ref,
      'tenant_id', p_tenant_id,
      'project_id', p_project_id,
      'orphan_recovered', v_orphan_recovered,
      'previous_ewo_id', v_previous_ewo_id,
      'previous_reservation_status', v_previous_status
    ),
    now()
  );


  -- ─── Record creation attempt (success) ───
  INSERT INTO ewo_creation_attempt_log (
    caller_email, caller_role, execution_context, creation_pathway,
    rejection_reason, correlation_id, was_blocked, was_created,
    attempted_ewo_ref, created_ewo_id, metadata
  ) VALUES (
    p_created_by_email, p_created_by_role, p_execution_context,
    'create_canonical_ewo_governed', NULL, v_audit_ref,
    false, true, v_ewo_ref, v_ewo_id,
    jsonb_build_object('gate', 'success', 'plan_reservation_ref', p_reserved_ewo_ref,
      'canonical_ewo_ref', v_ewo_ref,
      'orphan_recovered', v_orphan_recovered,
      'previous_ewo_id', v_previous_ewo_id,
      'previous_reservation_status', v_previous_status)
  );


  RETURN jsonb_build_object(
    'success', true,
    'blocked', false,
    'ewo_id', v_ewo_id,
    'ewo_ref', v_ewo_ref,
    'reserved_ref_used', p_reserved_ewo_ref IS NOT NULL,
    'orphan_recovered', v_orphan_recovered
  );

END;

$function$;

;
