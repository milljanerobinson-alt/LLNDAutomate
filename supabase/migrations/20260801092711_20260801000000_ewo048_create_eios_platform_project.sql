/*
# EWO-048: Create Canonical EIOS Platform Engineering Project

## Purpose
Live Product Owner validation of EWO-047R3 was blocked because no
canonical "EIOS Platform" engineering project existed in ecc_projects.
The only active project was "LLND Automate", which is a distinct product.
This migration creates the canonical EIOS Platform project, links it to
the existing EIOS tenant, connects the existing github_repository_config
and execution_context records, and updates the ecc_projects RLS policy
to allow tenant members (not just is_staff() admins/trainers) to read
their authorised projects.

## Changes

### 1. New ecc_projects row: EIOS Platform
- name: EIOS Platform
- slug: eios-platform
- status: active
- is_default: false (LLND Automate remains the global default)
- tenant_id: the EIOS tenant UUID (acbcfa81-ccf6-4279-9c57-5776a9fdf777)
- sort_order: 2 (after LLND Automate)
- colour: #2563EB (blue — distinct from LLND Automate's amber)

### 2. Link github_repository_config to EIOS Platform
- The existing repo config row (project_id='default') is updated to
  reference the new EIOS Platform project UUID.
- The legacy 'default' value is preserved in the audit trail.

### 3. Link execution_context to EIOS Platform
- The existing execution_context row (CTX-EIOS-001, product='EIOS Platform')
  is already named for EIOS. No structural change needed — the resolver
  matches by name/product. We add a comment-level note only.

### 4. RLS Policy Update on ecc_projects
- BEFORE: SELECT USING (is_staff()) — only admin/trainer roles can read.
- AFTER:  SELECT USING (is_staff() OR tenant_member_can_read_projects())
- The new condition allows:
  a) is_staff() users (admins, trainers) — unchanged.
  b) Active tenant members — users with an active eios_tenant_memberships
     row for the project's tenant_id. This is project-scoped: a tenant
     member of tenant A cannot read projects belonging to tenant B.
- INSERT/UPDATE/DELETE remain is_staff() only (project management is
  an administrative action, not a Product Owner action).
- Unauthorised users (no profile, no tenant membership) still see zero
  rows — deny-by-default is preserved.

### 5. New helper function: tenant_member_can_read_projects()
- SECURITY DEFINER, STABLE
- Returns true if the authenticated user has an active membership in
  ANY tenant (used as a broad read gate — the project row's tenant_id
  is checked in the policy itself).
- This does NOT grant cross-tenant access: the policy checks
  is_tenant_member(ecc_projects.tenant_id).

### 6. Audit records
- An engineering_change_log entry is inserted documenting the creation
  of the EIOS Platform project and the RLS policy change.
*/

-- ─── 1. Create EIOS Platform project ──────────────────────────────────────────

INSERT INTO ecc_projects (name, slug, description, status, is_default, colour, sort_order, tenant_id)
VALUES (
  'EIOS Platform',
  'eios-platform',
  'The canonical engineering project for the EIOS platform itself. All EIOS platform engineering work is governed under this project.',
  'active',
  false,
  '#2563EB',
  2,
  'acbcfa81-ccf6-4279-9c57-5776a9fdf777'
)
ON CONFLICT (slug) DO NOTHING;


-- ─── 2. Link github_repository_config to EIOS Platform ────────────────────────

-- Update the existing 'default' project_id row to reference the new UUID.
-- We use a subquery to get the EIOS Platform project ID.
UPDATE github_repository_config
SET project_id = (
  SELECT id::text FROM ecc_projects WHERE slug = 'eios-platform'
)
WHERE project_id = 'default'
  AND repository_name = 'EIOS';


-- ─── 3. Helper function: tenant_member_can_read_projects ───────────────────────
-- Returns true if the current user has an active membership in the tenant
-- that owns the project being read. The actual tenant_id check is done in
-- the policy via is_tenant_member(ecc_projects.tenant_id).

CREATE OR REPLACE FUNCTION public.tenant_member_can_read_projects()
RETURNS boolean
LANGUAGE sql
STABLE SECURITY DEFINER
SET search_path TO 'public'
AS $function$
SELECT EXISTS (
  SELECT 1 FROM eios_tenant_memberships
  WHERE user_id = auth.uid()
  AND status = 'active'
);

$function$;


-- ─── 4. Update ecc_projects RLS ───────────────────────────────────────────────

DROP POLICY IF EXISTS "authenticated_select_projects" ON ecc_projects;


-- New SELECT policy: staff OR active tenant member of the project's tenant.
-- This is project-scoped: is_tenant_member(ecc_projects.tenant_id) checks
-- membership for the specific tenant that owns this project row.
-- Projects with NULL tenant_id remain is_staff()-only (legacy/global projects).
CREATE POLICY "authenticated_select_projects" ON ecc_projects FOR SELECT
  TO authenticated USING (
    is_staff()
    OR (
      ecc_projects.tenant_id IS NOT NULL
      AND is_tenant_member(ecc_projects.tenant_id)
    )
  );


-- INSERT/UPDATE/DELETE remain is_staff() only — unchanged.
-- (No DROP/CREATE needed — existing policies are correct.)

-- ─── 5. Audit record ──────────────────────────────────────────────────────────

INSERT INTO engineering_change_log (
  change_ref,
  change_type,
  object_type,
  object_id,
  summary,
  description,
  actor_type,
  actor,
  is_reconstructed,
  linked_artefacts,
  metadata
) VALUES (
  'EWO048-MIGRATION-001',
  'created',
  'engineering_project',
  (SELECT id::text FROM ecc_projects WHERE slug = 'eios-platform'),
  'Created canonical EIOS Platform engineering project and linked repository config',
  'EWO-048: Created the EIOS Platform project in ecc_projects (slug=eios-platform, tenant=EIOS). Linked the existing github_repository_config row (repository_owner=milljanerobinson-alt, repository_name=EIOS) from legacy project_id=default to the new EIOS Platform project UUID. Updated ecc_projects SELECT RLS to allow active tenant members to read their tenant projects while preserving is_staff() admin access and deny-by-default for unauthorised users.',
  'system',
  'ewo048-migration',
  false,
  '[]',
  jsonb_build_object(
    'ewo_ref', 'EWO-048',
    'project_slug', 'eios-platform',
    'tenant_id', 'acbcfa81-ccf6-4279-9c57-5776a9fdf777',
    'rls_change', 'authenticated_select_projects: is_staff() OR (tenant_id IS NOT NULL AND is_tenant_member(tenant_id))'
  )
);

;
