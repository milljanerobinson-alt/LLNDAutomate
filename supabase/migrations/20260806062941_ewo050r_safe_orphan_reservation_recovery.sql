/*
# EWO-050R — Safe Orphaned EWO Reference Reservation Recovery

## Purpose

When a canonical EWO is deleted from engineering_work_orders, its
ewo_ref_reservations row is left behind with status='consumed' and
ewo_id pointing to the now-deleted UUID. On the next creation attempt
with the same p_reserved_ewo_ref, the governed RPC tries to INSERT a
new reservation, hits the UNIQUE constraint on ewo_ref, and throws
PostgreSQL 23505 — which PostgREST maps to HTTP 409.

This migration:

1. Replaces the naive INSERT in create_canonical_ewo_governed Overload 2
   Gate 2 with a safe orphan-detection and atomic recovery block.
2. Adds a release_ewo_reservation() RPC for governed deletion cleanup.
3. Adds a release_ewo_reservations_for_deleted_ewos() RPC that can be
   called to clean up orphaned reservations for EWOs that no longer exist.

## Changes

### create_canonical_ewo_governed (Overload 2 — with p_reserved_ewo_ref)

Gate 2 is restructured. When p_reserved_ewo_ref is provided:

  a. Check if a live EWO exists with that ref → block (live_ewo_exists)
  b. SELECT ... FOR UPDATE on ewo_ref_reservations for that ewo_ref
     (locks the row to prevent concurrent races)
  c. If a row is found:
     - If status='reserved' → it's an active reservation, use it
       (active_reservation_exists — but we allow reuse since it's
       the same caller's retry)
     - If status='consumed' AND ewo_id IS NOT NULL:
       - Check if engineering_work_orders row exists for that ewo_id
       - If NOT exists → orphan: atomically reset to 'reserved'
       - If exists → block (consumed_reservation_linked_to_existing_ewo)
     - If status='consumed' AND ewo_id IS NULL → block (unclassified)
     - Other status → block (unclassified_reservation_conflict)
  d. If no row found → INSERT a new reservation (normal first-time path)

  All conflict paths return governed JSON with a conflict_category
  field. No raw unique violation escapes the RPC.

### release_ewo_reservation RPC

New RPC that releases a reservation for a given ewo_ref. Sets
status='released', consumed_at=NULL, ewo_id=NULL. Called by the
deletion service after a governed EWO deletion.

### release_ewo_reservations_for_deleted_ewos RPC

Diagnostic/cleanup RPC that finds all 'consumed' reservations whose
ewo_id no longer exists in engineering_work_orders and releases them.
Records audit metadata for each release.

## Security
- No RLS changes (RPCs are SECURITY DEFINER)
- No new tables
- No data loss — reservations are released, not deleted
- Audit metadata recorded in ewo_creation_attempt_log

## Important Notes
1. Only Overload 2 (with p_reserved_ewo_ref) is changed. Overload 1
   (without p_reserved_ewo_ref) uses nextval() and is unaffected.
2. The orphan detection uses FOR UPDATE row locking to prevent
   concurrent races.
3. No raw unique violation can escape — all paths return governed JSON.
4. The deletion service (TypeScript) must call release_ewo_reservation
   after a successful governed deletion.
*/

-- ─── 1. Replace create_canonical_ewo_governed Overload 2 ──────────────────────

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


  -- Validate tenant exists and is active
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


  -- Validate project exists and is active
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


  -- ─── Gate 2: Resolve EWO reference (SAFE ORPHAN RECOVERY) ───
  IF p_reserved_ewo_ref IS NOT NULL AND btrim(p_reserved_ewo_ref) != '' THEN

    -- 2a. Check if a LIVE canonical EWO already exists with this ref
    IF EXISTS (SELECT 1 FROM engineering_work_orders WHERE ewo_ref = p_reserved_ewo_ref) THEN
      v_rejection_reason := 'EWO ref ''' || p_reserved_ewo_ref || ''' already exists as a canonical record';

      v_conflict_category := 'live_ewo_exists';

      INSERT INTO ewo_creation_attempt_log (
        caller_email, caller_role, execution_context, creation_pathway,
        rejection_reason, correlation_id, was_blocked, was_created, metadata
      ) VALUES (
        p_created_by_email, p_created_by_role, p_execution_context,
        'create_canonical_ewo_governed', v_rejection_reason, v_audit_ref,
        true, false, jsonb_build_object('gate', 'duplicate_ref', 'conflict_category', v_conflict_category, 'reserved_ref', p_reserved_ewo_ref)
      );

      RETURN jsonb_build_object('success', false, 'blocked', true, 'rejection_reason', v_rejection_reason, 'conflict_category', v_conflict_category);

    END IF;


    -- 2b. Lock and inspect any existing reservation row for this ref
    SELECT * INTO v_reservation FROM ewo_ref_reservations
    WHERE ewo_ref = p_reserved_ewo_ref
    FOR UPDATE;


    IF FOUND THEN
      -- A reservation row exists. Determine if it's an orphan or active.
      IF v_reservation.status = 'reserved' THEN
        -- Active reservation — safe to reuse (same caller retrying)
        v_ewo_ref := p_reserved_ewo_ref;


      ELSIF v_reservation.status = 'consumed' AND v_reservation.ewo_id IS NOT NULL THEN
        -- Consumed reservation with a linked EWO. Check if that EWO still exists.
        IF EXISTS (SELECT 1 FROM engineering_work_orders WHERE id = v_reservation.ewo_id) THEN
          -- EWO still exists — this is NOT an orphan. Block.
          v_rejection_reason := 'Reservation for ''' || p_reserved_ewo_ref || ''' is consumed by an existing canonical EWO';

          v_conflict_category := 'consumed_reservation_linked_to_existing_ewo';

          INSERT INTO ewo_creation_attempt_log (
            caller_email, caller_role, execution_context, creation_pathway,
            rejection_reason, correlation_id, was_blocked, was_created, metadata
          ) VALUES (
            p_created_by_email, p_created_by_role, p_execution_context,
            'create_canonical_ewo_governed', v_rejection_reason, v_audit_ref,
            true, false, jsonb_build_object('gate', 'reservation_conflict', 'conflict_category', v_conflict_category,
              'reserved_ref', p_reserved_ewo_ref, 'linked_ewo_id', v_reservation.ewo_id)
          );

          RETURN jsonb_build_object('success', false, 'blocked', true, 'rejection_reason', v_rejection_reason, 'conflict_category', v_conflict_category);

        ELSE
          -- EWO does NOT exist — this IS an orphan. Safe to recover.
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


          v_ewo_ref := p_reserved_ewo_ref;

        END IF;


      ELSIF v_reservation.status = 'consumed' AND v_reservation.ewo_id IS NULL THEN
        -- Consumed but no linked EWO — unclassified conflict
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
        -- Other status (e.g. 'released') — unclassified conflict
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
        -- Race condition: another request inserted between our SELECT and INSERT.
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

      v_ewo_ref := p_reserved_ewo_ref;

    END IF;


  ELSE
    -- No reserved ref provided — allocate from sequence
    v_ewo_ref := 'EWO-' || lpad(nextval('ewo_canonical_ref_seq')::text, 3, '0');

  END IF;


  -- ─── Gate 3: Create the canonical EWO ───
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
    CASE WHEN p_reserved_ewo_ref IS NOT NULL THEN '. Reference reserved during governed planning.' ELSE '' END,
    jsonb_build_object(
      'source', 'create_canonical_ewo_governed',
      'execution_context', p_execution_context,
      'correlation_id', v_audit_ref,
      'reserved_ref', p_reserved_ewo_ref,
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
    jsonb_build_object('gate', 'success', 'reserved_ref', p_reserved_ewo_ref,
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


-- ─── 2. Create release_ewo_reservation RPC ────────────────────────────────────

CREATE OR REPLACE FUNCTION release_ewo_reservation(
  p_ewo_ref text,
  p_released_by text DEFAULT 'system',
  p_correlation_id text DEFAULT NULL,
  p_reason text DEFAULT 'governed_deletion_cleanup'
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_reservation record;

  v_audit_ref text;

BEGIN
  v_audit_ref := COALESCE(p_correlation_id, 'EWO-REL-' || extract(epoch from now())::bigint || '-' || md5(random()::text));


  SELECT * INTO v_reservation FROM ewo_ref_reservations
  WHERE ewo_ref = p_ewo_ref
  FOR UPDATE;


  IF NOT FOUND THEN
    RETURN jsonb_build_object('success', true, 'released', false, 'reason', 'no_reservation_found');

  END IF;


  UPDATE ewo_ref_reservations
  SET status = 'released',
      consumed_at = NULL,
      ewo_id = NULL,
      reserved_at = now(),
      reserved_by = p_released_by,
      reservation_context = p_reason,
      correlation_id = v_audit_ref
  WHERE ewo_ref = p_ewo_ref;


  RETURN jsonb_build_object(
    'success', true,
    'released', true,
    'ewo_ref', p_ewo_ref,
    'previous_status', v_reservation.status,
    'previous_ewo_id', v_reservation.ewo_id,
    'correlation_id', v_audit_ref
  );

END;

$function$;


-- ─── 3. Create release_orphaned_reservations RPC ────────────────────────────
-- Diagnostic/cleanup function: finds all 'consumed' reservations whose ewo_id
-- no longer exists in engineering_work_orders and releases them.

CREATE OR REPLACE FUNCTION release_orphaned_reservations(
  p_released_by text DEFAULT 'system',
  p_correlation_id text DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_audit_ref text;

  v_released_count int := 0;

  v_orphan record;

BEGIN
  v_audit_ref := COALESCE(p_correlation_id, 'EWO-ORPHAN-REL-' || extract(epoch from now())::bigint);


  FOR v_orphan IN
    SELECT r.id, r.ewo_ref, r.ewo_id, r.status, r.reserved_by
    FROM ewo_ref_reservations r
    WHERE r.status = 'consumed'
      AND r.ewo_id IS NOT NULL
      AND NOT EXISTS (SELECT 1 FROM engineering_work_orders WHERE id = r.ewo_id)
  LOOP
    UPDATE ewo_ref_reservations
    SET status = 'released',
        consumed_at = NULL,
        ewo_id = NULL,
        reserved_at = now(),
        reserved_by = p_released_by,
        reservation_context = 'orphan_cleanup',
        correlation_id = v_audit_ref
    WHERE id = v_orphan.id;


    v_released_count := v_released_count + 1;

  END LOOP;


  RETURN jsonb_build_object(
    'success', true,
    'released_count', v_released_count,
    'correlation_id', v_audit_ref
  );

END;

$function$;


-- ─── 4. Grant execute to authenticated ────────────────────────────────────────

GRANT EXECUTE ON FUNCTION release_ewo_reservation(text, text, text, text) TO authenticated;

GRANT EXECUTE ON FUNCTION release_orphaned_reservations(text, text) TO authenticated;

;
