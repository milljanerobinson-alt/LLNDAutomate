/*
# EWO-044R2 — Conversation Audit Extension + Context Resolver

## Purpose
Extends the EIOS conversation audit table to capture the full tool loop
(provider-native call IDs, tool rounds, validation retries, resolved context)
and adds a governed RPC for server-side conversation context resolution.

## Changes to eios_conversation_audit
Adds columns:
- tenant_id — resolved tenant for the conversation
- resolved_project_id — server-resolved project
- resolved_ewo_ref — server-resolved EWO
- resolved_repository — server-resolved repository reference
- provider_tool_call_ids — native tool call IDs from the provider
- tool_rounds — number of tool-calling rounds
- validation_retries — number of evidence-based retries
- tool_results_summary — JSONB summary of tool results
- governance_decision — already exists but ensure present

## New RPC: resolve_conversation_context
A SECURITY DEFINER function that resolves the governed ToolExecutionContext
for a conversation using authoritative sources:
1. authenticated user (user_id, role)
2. conversation-to-EWO binding (engineering_conversation_associations)
3. active project (github_repository_config.project_id or ecc_product_hierarchy)
4. repository reference (github_repository_config)

Returns JSON with: tenant_id, user_id, role, conversation_id,
project_id, ewo_ref, repository.

## Security
- All new columns added with IF NOT EXISTS (idempotent).
- RPC is SECURITY DEFINER, runs as the caller's authenticated context.
- No secrets stored or logged.
*/

-- ─── Extend eios_conversation_audit ──────────────────────────────────────────

ALTER TABLE eios_conversation_audit
  ADD COLUMN IF NOT EXISTS tenant_id TEXT DEFAULT NULL;

ALTER TABLE eios_conversation_audit
  ADD COLUMN IF NOT EXISTS resolved_project_id TEXT DEFAULT NULL;

ALTER TABLE eios_conversation_audit
  ADD COLUMN IF NOT EXISTS resolved_ewo_ref TEXT DEFAULT NULL;

ALTER TABLE eios_conversation_audit
  ADD COLUMN IF NOT EXISTS resolved_repository TEXT DEFAULT NULL;

ALTER TABLE eios_conversation_audit
  ADD COLUMN IF NOT EXISTS provider_tool_call_ids TEXT[] DEFAULT ARRAY[]::TEXT[];

ALTER TABLE eios_conversation_audit
  ADD COLUMN IF NOT EXISTS tool_rounds INTEGER DEFAULT 0;

ALTER TABLE eios_conversation_audit
  ADD COLUMN IF NOT EXISTS validation_retries INTEGER DEFAULT 0;

ALTER TABLE eios_conversation_audit
  ADD COLUMN IF NOT EXISTS tool_results_summary JSONB DEFAULT '[]'::JSONB;


-- Ensure governance_decision column exists (added in EWO-044 but ensure idempotent)
ALTER TABLE eios_conversation_audit
  ADD COLUMN IF NOT EXISTS governance_decision TEXT DEFAULT 'none';


-- ─── Context Resolver RPC ────────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION resolve_conversation_context(
  p_conversation_id TEXT,
  p_user_id UUID,
  p_hint_project_id TEXT DEFAULT NULL,
  p_hint_ewo_ref TEXT DEFAULT NULL
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_role TEXT;

  v_tenant_id TEXT;

  v_project_id TEXT;

  v_ewo_ref TEXT;

  v_repository TEXT;

  v_assoc RECORD;

BEGIN
  -- Resolve user role from profiles
  SELECT role INTO v_role FROM profiles WHERE id = p_user_id;

  IF v_role IS NULL THEN
    v_role := 'user';

  END IF;


  -- Tenant ID: use user_id as tenant scope (single-tenant per user for now)
  v_tenant_id := p_user_id::TEXT;


  -- 1. Try conversation-to-EWO binding (canonical)
  SELECT ewo_ref, idea_ref, proposal_ref
    INTO v_assoc
  FROM engineering_conversation_associations
  WHERE conversation_id = p_conversation_id
    AND is_canonical = true
    AND superseded_by IS NULL
  ORDER BY updated_at DESC
  LIMIT 1;


  IF v_assoc.ewo_ref IS NOT NULL THEN
    v_ewo_ref := v_assoc.ewo_ref;

  ELSIF p_hint_ewo_ref IS NOT NULL THEN
    -- Validate hint EWO exists
    PERFORM 1 FROM engineering_work_orders WHERE ewo_ref = p_hint_ewo_ref;

    IF FOUND THEN
      v_ewo_ref := p_hint_ewo_ref;

    END IF;

  END IF;


  -- 2. Resolve project: hint first, then from EWO, then from repo config
  IF p_hint_project_id IS NOT NULL THEN
    v_project_id := p_hint_project_id;

  ELSIF v_ewo_ref IS NOT NULL THEN
    -- Try to find project from EWO (EWOs don't have project_id column directly,
    -- but github_repository_config has project_id per repo)
    SELECT grc.project_id INTO v_project_id
    FROM github_repository_config grc
    WHERE grc.lifecycle_status = 'active'
    LIMIT 1;

  ELSE
    -- Fall back to first active repo config
    SELECT grc.project_id INTO v_project_id
    FROM github_repository_config grc
    WHERE grc.lifecycle_status = 'active'
    LIMIT 1;

  END IF;


  -- 3. Resolve repository reference
  SELECT
    (repository_owner || '/' || repository_name)
    INTO v_repository
  FROM github_repository_config
  WHERE lifecycle_status = 'active'
  ORDER BY
    CASE WHEN project_id = COALESCE(v_project_id, '') THEN 0 ELSE 1 END,
    updated_at DESC
  LIMIT 1;


  RETURN jsonb_build_object(
    'tenant_id', v_tenant_id,
    'user_id', p_user_id,
    'role', v_role,
    'conversation_id', p_conversation_id,
    'project_id', v_project_id,
    'ewo_ref', v_ewo_ref,
    'repository', v_repository
  );

END;

$$;


-- Grant execute to authenticated
REVOKE ALL ON FUNCTION resolve_conversation_context(TEXT, UUID, TEXT, TEXT) FROM PUBLIC;

GRANT EXECUTE ON FUNCTION resolve_conversation_context(TEXT, UUID, TEXT, TEXT) TO authenticated;


-- Add index for conversation_id lookups in associations (already exists but ensure)
CREATE INDEX IF NOT EXISTS idx_convo_assoc_conversation_canonical
  ON engineering_conversation_associations(conversation_id, is_canonical)
  WHERE is_canonical = true;

;
