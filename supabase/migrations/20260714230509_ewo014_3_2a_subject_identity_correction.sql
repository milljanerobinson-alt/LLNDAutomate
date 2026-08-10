/*
# EWO-014.3.2A — Subject Identity and Execution Readiness Correction

## Summary

Corrects the Governed Migration Planner and Ownership Migration Engine so that
a Migration Plan cannot be marked Ready or executed unless it contains a valid,
resolvable subject engineering object identity.

## Changes

### 1. ecc_governed_reviews — add record_purpose column
- `record_purpose` (text, NOT NULL DEFAULT 'production', CHECK in ('production', 'validation', 'test'))
- Allows distinguishing production ECRs from test/validation data.
- Test/validation records may use synthetic subjects but cannot execute production changes.

### 2. ecc_migration_plans — add record_purpose column, add 'blocked' status
- `record_purpose` (text, NOT NULL DEFAULT 'production', CHECK in ('production', 'validation', 'test'))
- Status CHECK constraint expanded to include 'blocked' (in addition to draft, ready, frozen, superseded).
- Blocked plans cannot be executed.

### 3. resolve_subject_identity function
- Postgres function that takes object_id + object_type and checks whether the
  object exists in the ownership metadata registry.
- Returns jsonb with resolved: boolean, exists: boolean, metadata_id: uuid|null.
- Used by the planner validation and execution engine.

### 4. delete_review_and_extensions function
- Governed deletion of draft or test ECRs.
- Only allows deletion when status = 'draft' OR record_purpose IN ('test', 'validation').
- Deletes the ECR extension row, evidence, participants, audit events, then the review.
- Returns success/failure.

### 5. delete_migration_plan function
- Governed deletion of test/validation migration plans.
- Only allows deletion when record_purpose IN ('test', 'validation') AND status != 'frozen'.
- Also deletes associated executions.
- Production plans linked to approved governance decisions cannot be deleted.
- Returns success/failure.

## Security
- No RLS policy changes — existing anon/authenticated policies cover new columns.

## Important Notes
1. MP-2026-001 is preserved as-is — no data migration or silent repair.
2. The 'blocked' status is a new plan status that prevents execution.
3. Test/validation plans are clearly labelled and cannot execute production changes.
4. References are never reused (sequences continue incrementing).
*/

-- ============================================================
-- 1. Add record_purpose to ecc_governed_reviews
-- ============================================================

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'ecc_governed_reviews' AND column_name = 'record_purpose'
  ) THEN
    ALTER TABLE ecc_governed_reviews
      ADD COLUMN record_purpose text NOT NULL DEFAULT 'production'
      CHECK (record_purpose IN ('production', 'validation', 'test'));

  END IF;

END $$;


-- ============================================================
-- 2. Add record_purpose to ecc_migration_plans + expand status CHECK
-- ============================================================

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'ecc_migration_plans' AND column_name = 'record_purpose'
  ) THEN
    ALTER TABLE ecc_migration_plans
      ADD COLUMN record_purpose text NOT NULL DEFAULT 'production'
      CHECK (record_purpose IN ('production', 'validation', 'test'));

  END IF;

END $$;


-- Expand the status CHECK to include 'blocked'
ALTER TABLE ecc_migration_plans DROP CONSTRAINT IF EXISTS ecc_migration_plans_status_check;

ALTER TABLE ecc_migration_plans ADD CONSTRAINT ecc_migration_plans_status_check
  CHECK (status IN ('draft', 'ready', 'frozen', 'superseded', 'blocked'));


-- ============================================================
-- 3. resolve_subject_identity function
-- ============================================================

CREATE OR REPLACE FUNCTION resolve_subject_identity(
  p_object_id uuid,
  p_object_type text
)
RETURNS jsonb
LANGUAGE sql
STABLE
AS $$
  SELECT jsonb_build_object(
    'resolved', EXISTS(
      SELECT 1 FROM ecc_ownership_metadata
      WHERE object_id = p_object_id
        AND object_type = p_object_type
        AND deleted_at IS NULL
    ),
    'exists', EXISTS(
      SELECT 1 FROM ecc_ownership_metadata
      WHERE object_id = p_object_id
        AND object_type = p_object_type
    ),
    'metadata_id', (
      SELECT id FROM ecc_ownership_metadata
      WHERE object_id = p_object_id
        AND object_type = p_object_type
        AND deleted_at IS NULL
      LIMIT 1
    )
  );

$$;


-- ============================================================
-- 4. delete_review_and_extensions function
-- Governed deletion of draft or test/validation ECRs.
-- ============================================================

CREATE OR REPLACE FUNCTION delete_review_and_extensions(
  p_review_id uuid
)
RETURNS jsonb
LANGUAGE plpgsql
AS $$
DECLARE
  v_review RECORD;

BEGIN
  SELECT * INTO v_review FROM ecc_governed_reviews WHERE id = p_review_id;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Review not found';

  END IF;


  -- Only draft or test/validation records can be deleted
  IF v_review.status NOT IN ('draft') AND v_review.record_purpose NOT IN ('test', 'validation') THEN
    RAISE EXCEPTION 'Only draft reviews or test/validation records can be deleted. This review has status "%" and purpose "%".', v_review.status, v_review.record_purpose;

  END IF;


  -- Production reviews that have entered Open or later cannot be deleted
  IF v_review.record_purpose = 'production' AND v_review.status NOT IN ('draft') THEN
    RAISE EXCEPTION 'Production reviews that have entered Open or later cannot be deleted.';

  END IF;


  -- Delete child records
  DELETE FROM ecc_review_evidence WHERE review_id = p_review_id;

  DELETE FROM ecc_review_participants WHERE review_id = p_review_id;

  DELETE FROM ecc_review_audit_events WHERE review_id = p_review_id;

  DELETE FROM ecc_ecr_extensions WHERE review_id = p_review_id;

  DELETE FROM ecc_governed_reviews WHERE id = p_review_id;


  RETURN jsonb_build_object('success', true, 'deleted_review_id', p_review_id);

END;

$$;


-- ============================================================
-- 5. delete_migration_plan function
-- Governed deletion of test/validation migration plans.
-- ============================================================

CREATE OR REPLACE FUNCTION delete_migration_plan(
  p_plan_id uuid
)
RETURNS jsonb
LANGUAGE plpgsql
AS $$
DECLARE
  v_plan RECORD;

BEGIN
  SELECT * INTO v_plan FROM ecc_migration_plans WHERE id = p_plan_id;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Migration plan not found';

  END IF;


  -- Only test/validation plans can be deleted, and only if not frozen
  IF v_plan.record_purpose NOT IN ('test', 'validation') THEN
    RAISE EXCEPTION 'Only test or validation migration plans can be deleted. This plan has purpose "%".', v_plan.record_purpose;

  END IF;


  IF v_plan.status = 'frozen' THEN
    RAISE EXCEPTION 'Frozen plans cannot be deleted. This plan has been executed and is immutable.';

  END IF;


  -- Delete associated executions
  DELETE FROM ecc_migration_executions WHERE migration_plan_id = p_plan_id;


  -- Delete the plan
  DELETE FROM ecc_migration_plans WHERE id = p_plan_id;


  RETURN jsonb_build_object('success', true, 'deleted_plan_id', p_plan_id);

END;

$$;

;
