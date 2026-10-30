/*
# Clean-install override for migration 20260801092711
# Original file: supabase/migrations/20260801092711_20260801000000_ewo048_create_eios_platform_project.sql
# Original SHA-256: 3d748a2becab28a8944d213ec3ce33b726b180865e2255dd435810587522832f
# Treatment: schema_effects_only
#
# This file is used ONLY by the clean-install bootstrap
# (scripts/clean-install/bootstrap-database.sh). The historical file above is
# unchanged and remains the record of what ran on the original project.
#
# Original purpose: Created the "EIOS Platform" engineering project for the original EIOS tenant, linked the original repository configuration to it, and widened the ecc_projects SELECT policy to tenant members.
# Fresh-install failure: INSERT INTO ecc_projects (line 74): foreign key ecc_projects_tenant_id_fkey, EIOS tenant acbcfa81-... exists only in the original project.
#
# Effects retained in a clean install:
#   - function public.tenant_member_can_read_projects()
#   - policy authenticated_select_projects on ecc_projects (staff, or member of the owning tenant)
# Effects not replayed (environment-specific records of the original project):
#   - ecc_projects: "EIOS Platform" row for the original EIOS tenant
#   - github_repository_config: relink of the original EIOS repository row
#   - engineering_change_log: 1 audit row
*/
-- Verbatim from the original file:
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
