import { describe, expect, it } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import { isApprovedOrigin } from '../../supabase/functions/invite-rto-staff/origin-policy';

const read = (relative: string) => fs.readFileSync(path.resolve(__dirname, '..', relative), 'utf8');
const access = read('lib/workspaceAccess.ts');
const switcher = read('components/WorkspaceSwitcher.tsx');
const layout = read('components/CustomerWorkspaceLayout.tsx');
const palette = read('components/CommandPalette.tsx');
const app = read('App.tsx');
const migration = read('../supabase/migrations/20260809092000_issue040_rto_workspace_access.sql');
const invitationFix = read('../supabase/migrations/20260810170000_issue040_invitation_role_reconciliation.sql');
const membershipFix = read('../supabase/migrations/20260810223000_issue040_canonical_invitation_membership.sql');
const passwordActivation = read('../supabase/migrations/20260811040000_issue040_activate_invitation_after_password.sql');
const invite = read('../supabase/functions/invite-rto-staff/index.ts');
const originPolicy = read('../supabase/functions/invite-rto-staff/origin-policy.ts');
const acceptInvite = read('pages/AcceptInvitePage.tsx');
const supabaseClient = read('lib/supabase.ts');
const authenticatedE2e = read('../tests/e2e/issue040.authenticated.spec.ts');
const authenticatedHelper = read('../tests/e2e/helpers/authenticated-session.ts');
const conditionalDeletion = read('../supabase/migrations/20261028120000_issue040_conditional_staff_deletion.sql');
const usersPage = read('pages/workspace/UsersPage.tsx');
const dataScoping = read('../supabase/migrations/20261028130000_issue040_organisation_data_scoping.sql');
const fn = (name: string) => read(`../supabase/functions/${name}/index.ts`);
const organisationAccess = read('../supabase/functions/_shared/organisation-access.ts');

describe('Issue #40 workspace access model', () => {
  it('defines exactly the three customer workspace identifiers', () => {
    expect(access).toContain("'administration' | 'candidate_support' | 'technical'");
  });
  it('grants an organisation creator all three workspaces', () => {
    expect(migration).toContain("ARRAY['administration','candidate_support','technical']");
  });
  it('orders the workspace switcher Administration, Candidate Support, Technical', () => {
    const labels = ['Administration Workspace', 'Candidate Support Workspace', 'Technical Workspace'];
    expect(labels.map(label => switcher.indexOf(label))).toEqual([...labels.map(label => switcher.indexOf(label))].sort((a, b) => a - b));
  });
  it.each([
    ['administration', 'Administration Workspace'],
    ['candidate_support', 'Candidate Support Workspace'],
    ['technical', 'Technical Workspace'],
  ])('supports permission-only visibility for %s', (workspace, label) => {
    expect(switcher).toContain(`key: '${workspace}'`);
    expect(switcher).toContain(label);
    expect(switcher).toContain('customerAccess.some');
  });
  it('does not expose Candidate Assessment as a staff workspace', () => {
    expect(switcher).not.toContain("label: 'Candidate Assessment'");
    expect(layout).not.toContain("label: 'Candidate Assessment'");
  });
  it('renders permission-filtered workspace switching only in the top-right header', () => {
    expect(layout.match(/<WorkspaceSwitcher currentWorkspace=\{workspace\}/g)).toHaveLength(1);
    expect(layout.indexOf('<WorkspaceSwitcher currentWorkspace={workspace} />')).toBeGreaterThan(layout.indexOf('<header'));
    expect(layout.indexOf('<WorkspaceSwitcher currentWorkspace={workspace} />')).toBeLessThan(layout.indexOf('</header>'));
    expect(layout).not.toContain('menuPlacement="up"');
    expect(read('components/AdminLayout.tsx').match(/<WorkspaceSwitcher currentWorkspace="administration"/g)).toHaveLength(1);
    expect(switcher).toContain('customerAccess.some');
  });
  it('filters command search by assigned workspace', () => {
    expect(palette).toContain('allowed.has(command.workspace');
  });
});

describe('Issue #40 Administration controls', () => {
  it('provides Users and Completion Reports routes', () => {
    expect(layout).toContain("label: 'Users'");
    expect(layout).toContain("label: 'Completion Reports'");
    expect(app).toContain('<UsersPage />');
    expect(app).toContain('<CompletionReportsPage />');
  });
  it('protects the final active Administration user server-side', () => {
    expect(migration).toContain('active_admins <= 1');
    expect(migration).toContain('final Administration user cannot be removed, demoted or deactivated');
  });
  it('supports reversible activation and never deletes staff directly from the browser', () => {
    expect(migration).toContain("new_status NOT IN ('active','inactive')");
    expect(usersPage).not.toMatch(/\.from\(['"](profiles|organisation_memberships|user_workspace_access)['"]\)\.delete/);
    expect(usersPage).not.toContain('auth.admin');
  });
  it('sends invitations through a server-side admin API', () => {
    expect(invite).toContain('auth.admin.inviteUserByEmail');
    expect(invite).toContain('SUPABASE_SERVICE_ROLE_KEY');
    expect(read('pages/workspace/UsersPage.tsx')).not.toContain('SUPABASE_SERVICE_ROLE_KEY');
  });
  it('keeps invited accounts inactive until confirmed auth and password setup activate them', () => {
    expect(migration).toContain("VALUES (grant_row.organisation_id,p_user_id,'invited'");
    expect(migration).toContain('is_active=false');
    expect(passwordActivation).toContain('NEW.email_confirmed_at IS NULL');
    expect(passwordActivation).toContain("NEW.encrypted_password = ''");
    expect(passwordActivation).toContain('AFTER UPDATE OF email_confirmed_at, encrypted_password ON auth.users');
    expect(passwordActivation).toContain("SET status='active',activated_at=now()");
    expect(passwordActivation).toContain("AND status='pending'");
  });
  it('uses server-controlled invitation grants instead of browser tenant metadata', () => {
    expect(migration).toContain('CREATE TABLE IF NOT EXISTS staff_invitation_grants');
    expect(migration).toContain('REVOKE ALL ON TABLE staff_invitation_grants FROM anon, authenticated');
    expect(invite).toContain('prepare_staff_invitation');
    expect(invite).toContain('link_staff_invitation');
    expect(invite).toContain('reconciled: true');
    expect(invite).not.toContain('organisation_id: access.organisation_id, workspaces: selected');
    expect(migration).not.toContain("org_id := nullif(NEW.raw_user_meta_data->>'organisation_id'");
  });
  it('permits only the exact pending-grant role transition in the legacy role trigger', () => {
    expect(invitationFix).toContain('authorised_invitation_transition');
    expect(invitationFix).toContain("grant_row.status = 'pending'");
    expect(invitationFix).toContain("NEW.role = 'trainer'");
    expect(invitationFix).toContain('NEW.is_active = false');
    expect(invitationFix).toContain("RAISE EXCEPTION 'Only admins can change user roles'");
    expect(invitationFix).toContain('REVOKE ALL ON FUNCTION public.check_profile_role_unchanged() FROM PUBLIC, anon, authenticated, service_role');
  });
  it('reconciles an already-sent auth invitation from the server grant email only', () => {
    expect(invitationFix).toContain('public.reconcile_staff_invitation');
    expect(invitationFix).toContain('lower(invited_user.email) = grant_row.invited_email');
    expect(invitationFix).toContain("grant_row.status <> 'pending'");
    expect(invitationFix).toContain('coalesce(cardinality(matching_users), 0) <> 1');
    expect(invitationFix).toContain('PERFORM public.link_staff_invitation(p_grant_id, invited_user_id)');
    expect(invitationFix).toContain('GRANT EXECUTE ON FUNCTION public.reconcile_staff_invitation(uuid) TO service_role');
    expect(invite).toContain('service.rpc("reconcile_staff_invitation"');
    expect(invite).not.toContain('.from("staff_invitation_grants").select("user_id,status")');
  });
  it('selects a trusted pending invitation grant before inspecting invited_at', () => {
    const grantLookup = membershipFix.indexOf('SELECT g.id INTO grant_id');
    const invitedFallback = membershipFix.indexOf('IF NEW.invited_at IS NOT NULL THEN');
    const directSignup = membershipFix.indexOf('Legitimate self-signup remains separate');
    expect(grantLookup).toBeGreaterThan(-1);
    expect(grantLookup).toBeLessThan(invitedFallback);
    expect(invitedFallback).toBeLessThan(directSignup);
    expect(membershipFix).toContain("g.id=nullif(NEW.raw_user_meta_data->>'invitation_grant_id','')::uuid");
    expect(membershipFix).toContain('g.invited_email=lower(NEW.email)');
    expect(membershipFix).toContain("nullif(raw_user_meta_data->>'invitation_grant_id','')::uuid=p_grant_id");
  });
  it('retains one membership row and fails closed for unrelated cross-RTO membership', () => {
    expect(membershipFix).toContain('WHERE user_id=p_user_id\n  FOR UPDATE');
    expect(membershipFix).toContain('UPDATE public.organisation_memberships\n    SET organisation_id=grant_row.organisation_id');
    expect(membershipFix).toContain("RAISE EXCEPTION 'invited account already belongs to another RTO'");
    expect(membershipFix).not.toContain('DROP INDEX organisation_memberships_one_rto_per_user');
    expect(membershipFix).not.toContain('ON CONFLICT DO NOTHING');
  });
  it('provides an Administration-only canonical pending staff register', () => {
    expect(membershipFix).toContain('public.list_organisation_staff()');
    expect(membershipFix).toContain("g.status='pending'");
    expect(membershipFix).toContain("public.has_workspace_access('administration')");
    expect(read('pages/workspace/UsersPage.tsx')).toContain("supabase.rpc('list_organisation_staff')");
    expect(read('pages/workspace/UsersPage.tsx')).toContain("member.status === 'invited' ? member.pending_workspaces : member.workspaces");
  });
  it('creates a new RTO for direct signup without accepting an existing organisation', () => {
    expect(migration).toContain("IF NEW.invited_at IS NOT NULL THEN");
    expect(migration).toContain('INSERT INTO public.organisations (name,created_by)');
  });
  it('fails invitation redirects closed to configured URLs', () => {
    expect(invite).toContain('PUBLIC_SITE_URL is required and must be a valid HTTP(S) origin');
    expect(invite).toContain('Invitation origin is not approved');
    expect(invite).not.toContain('req.headers.get("origin") ?? ""');
  });
  it('allows the standard Supabase browser headers without weakening CORS origins', () => {
    expect(invite).toContain('"Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type"');
    expect(invite).toContain('"Access-Control-Allow-Methods": "POST, OPTIONS"');
    expect(invite).toContain('headers["Access-Control-Allow-Origin"] = parseOrigin(origin)!');
    expect(invite).not.toContain('"Access-Control-Allow-Origin": "*"');
  });
  it('accepts only HTTPS LLND Automate Cloudflare preview subdomains automatically', () => {
    const siteUrl = 'https://llndautomate.pages.dev';
    expect(isApprovedOrigin('https://ff2d0669.llndautomate.pages.dev', siteUrl, [])).toBe(true);
    expect(isApprovedOrigin('https://cc28056b.llndautomate.pages.dev', siteUrl, [])).toBe(true);
    expect(isApprovedOrigin('http://ff2d0669.llndautomate.pages.dev', siteUrl, [])).toBe(false);
    expect(isApprovedOrigin('https://llndautomate.pages.dev.attacker.example', siteUrl, [])).toBe(false);
    expect(isApprovedOrigin('https://evil-llndautomate.pages.dev', siteUrl, [])).toBe(false);
    expect(isApprovedOrigin('https://another-project.pages.dev', siteUrl, [])).toBe(false);
    expect(originPolicy).toContain('url.hostname.endsWith(`.${previewParentHostname}`)');
    expect(originPolicy).not.toContain("includes('llndautomate.pages.dev')");
  });
  it('keeps PUBLIC_SITE_URL and the explicit origin allowlist approved', () => {
    const siteUrl = 'https://llndautomate.pages.dev';
    const allowlist = ['http://localhost:5173'];
    expect(isApprovedOrigin(siteUrl, siteUrl, allowlist)).toBe(true);
    expect(isApprovedOrigin('http://localhost:5173', siteUrl, allowlist)).toBe(true);
    expect(invite).toContain('INVITATION_REDIRECT_ALLOWLIST');
    expect(invite).toContain('return siteUrl;');
  });
  it('uses a trusted pathname callback that cannot be replaced by the Auth fragment', () => {
    expect(invite).toContain('/accept-invite`');
    expect(invite).not.toContain('/#/llnd-automate/login');
    expect(app).toContain("window.location.pathname === '/accept-invite'");
  });
  it('captures no Auth tokens and renders a dedicated invitation setup experience', () => {
    expect(supabaseClient).toContain("type: params.get('type')");
    expect(supabaseClient).toContain("errorCode: params.get('error_code')");
    expect(supabaseClient).not.toContain("params.get('access_token')");
    expect(acceptInvite).toContain('Set up your LLND Automate account');
    expect(acceptInvite).toContain('supabase.auth.updateUser({ password })');
    expect(acceptInvite).toContain('This invitation link is invalid or has expired');
    expect(acceptInvite).not.toContain('error_description');
  });
  it('does not derive staff workspace access for an inactive invited profile', () => {
    expect(access).toContain('} else if (profile?.is_active) {');
    expect(access).toContain('Inactive invited');
    expect(access).toContain('setWorkspaces([])');
  });
  it('uses four distinct permanent staging identities and a disposable invite identity', () => {
    for (const variable of [
      'E2E_ADMIN_EMAIL', 'E2E_CANDIDATE_SUPPORT_EMAIL', 'E2E_TECHNICAL_EMAIL',
      'E2E_SUPER_USER_EMAIL', 'E2E_INVITE_EMAIL',
    ]) expect(authenticatedHelper).toContain(variable);
    expect(authenticatedHelper).toContain('milljanerobinson+admin@gmail.com');
    expect(authenticatedHelper).toContain('milljanerobinson+cs@gmail.com');
    expect(authenticatedHelper).toContain('milljanerobinson+tech@gmail.com');
    expect(authenticatedHelper).toContain('milljanerobinson+super@gmail.com');
    expect(authenticatedHelper).toContain("inviteEmail.includes('+e2e')");
  });
  it('assigns single-workspace boundaries and ordered switching to the correct identities', () => {
    expect(authenticatedE2e).toContain("expectWorkspaceMenu(page, ['administration'])");
    expect(authenticatedE2e).toContain("expectWorkspaceMenu(page, ['candidate_support'])");
    expect(authenticatedE2e).toContain("expectWorkspaceMenu(page, ['technical'])");
    expect(authenticatedE2e).toContain('authenticatePage(page, env.superUserEmail, env.superUserPassword)');
    expect(authenticatedE2e).toContain('expectWorkspaceMenu(page, WORKSPACE_ORDER)');
    expect(authenticatedE2e).not.toContain('updateUserById');
  });
});

describe('Issue #40 support-case and tenancy enforcement', () => {
  it('creates support cases unassigned without inventing an aXcelerate owner', () => {
    expect(migration).toContain("assignment_source text NOT NULL DEFAULT 'unassigned'");
    expect(migration).toContain('axcelerate_relationship_source text');
  });
  it('limits Candidate Support to assigned or unassigned cases', () => {
    expect(migration).toContain('(assignee = auth.uid() OR assignee IS NULL)');
  });
  it('requires an actual support case before Candidate Support can reach dependent records', () => {
    expect(migration).toContain("public.has_workspace_access('candidate_support') AND sc.id IS NOT NULL");
  });
  it('limits candidate and invitation direct reads to accessible support cases', () => {
    expect(migration).toContain('students_workspace_select');
    expect(migration).toContain('invitations_workspace_select');
    expect(migration).toContain('can_access_support_case');
  });
  it('scopes results, plans, interventions and child records', () => {
    expect(migration).toContain('inv_assessments_workspace_select');
    expect(migration).toContain('support_plans_workspace_select');
    expect(migration).toContain('intervention_cases_workspace_select');
    expect(migration).toContain('can_manage_intervention');
  });
  it('allows only Administration to reassign a support case', () => {
    expect(migration).toContain('support_case_admin_update');
    expect(migration).not.toContain('support_case_candidate_support_update');
  });
  it('enforces organisation tenancy in helpers and member mutation', () => {
    expect(migration).toContain('case_org = public.current_organisation_id()');
    expect(migration).toContain('cross-organisation member access denied');
  });
  it('denies inactive users through membership and profile checks', () => {
    expect(migration).toContain("m.status = 'active'");
    expect(migration).toContain('JOIN public.profiles p ON p.id = m.user_id AND p.is_active');
  });
  it('prevents self-service mutation of tenant, role and activation state', () => {
    expect(migration).toContain('REVOKE UPDATE ON TABLE profiles FROM authenticated');
    expect(migration).toContain('GRANT UPDATE (full_name,avatar_url) ON profiles TO authenticated');
  });
  it('enforces one RTO membership per user without unordered tenant selection', () => {
    expect(migration).toContain('organisation_memberships_one_rto_per_user');
    expect(migration).toContain('ON organisation_memberships(user_id)');
    expect(migration).not.toMatch(/current_organisation_id\(\)[\s\S]{0,300}LIMIT 1/);
  });
  it('aborts ambiguous tenant backfills and preserves an active administrator', () => {
    expect(migration).toContain('multiple organisations exist; legacy ownership is ambiguous');
    expect(migration).toContain('Legacy invitations may pre-date student linking');
    expect(migration).toContain('migration would leave the RTO without an active Administration user');
  });
  it('blocks public tokens from updating tenant and ownership columns', () => {
    expect(migration).toContain('REVOKE UPDATE ON TABLE assessment_invitations FROM anon');
    const anonInvitationGrant = migration.match(/REVOKE UPDATE ON TABLE assessment_invitations FROM anon;\s*(GRANT UPDATE \([\s\S]*?\) ON assessment_invitations TO anon;)/)?.[1] ?? '';
    for (const protectedColumn of ['organisation_id', 'student_id', 'enrolment_id', 'created_by', 'trainer_override_by']) {
      expect(anonInvitationGrant).not.toContain(protectedColumn);
    }
    expect(migration).toContain('GRANT UPDATE (answer, submitted_at) ON assessment_responses TO anon');
    expect(migration).toContain('enforce_candidate_token_update_boundary');
    expect(migration).toContain('assessment token cannot modify tenant, ownership or structural fields');
    expect(migration).toContain('REVOKE INSERT ON TABLE invitation_assessments FROM anon');
    expect(migration).toContain('validate_candidate_token_response_insert');
  });
  it('hardens privileged helpers and keeps trigger functions private', () => {
    expect(migration).toContain('SET search_path = pg_catalog, public');
    expect(migration).toContain('REVOKE ALL ON FUNCTION public.handle_new_user() FROM PUBLIC');
    expect(migration).toContain('REVOKE ALL ON FUNCTION public.activate_confirmed_staff_invitation() FROM PUBLIC');
  });
  it('wraps the migration atomically and documents rollback preflight', () => {
    expect(migration.trimStart().startsWith('/*')).toBe(true);
    expect(migration).toContain('\nBEGIN;');
    expect(migration.trimEnd().endsWith('COMMIT;')).toBe(true);
    expect(migration).toContain('take a Supabase backup/PITR recovery point');
  });
});

describe('Issue #40 Technical boundary', () => {
  it('places aXcelerate logs and email activity only in Technical navigation', () => {
    expect(layout).toContain("label: 'aXcelerate Log'");
    expect(layout).toContain("label: 'Email Activity'");
    expect(layout.indexOf("const TECHNICAL_NAV")).toBeLessThan(layout.indexOf("label: 'aXcelerate Log'"));
  });
  it('does not expose internal AI providers or feature flags to LLND workspaces', () => {
    expect(layout).not.toContain("label: 'AI Providers'");
    expect(layout).not.toContain("label: 'Feature Flags'");
    expect(palette).not.toContain("label: 'AI Providers'");
  });
  it('does not grant Technical general candidate access in RLS', () => {
    const studentPolicy = migration.match(/CREATE POLICY students_workspace_select[\s\S]*?\n\);/)?.[0] ?? '';
    expect(studentPolicy).not.toContain("has_workspace_access('technical')");
  });
});

describe('Issue #40 Product Owner refinement — Users list and conditional deletion', () => {
  it('shows Active/Invited and Deactivated staff in separate sections', () => {
    expect(usersPage).toContain("member.status !== 'inactive'");
    expect(usersPage).toContain("member.status === 'inactive'");
    expect(usersPage).toContain('Active and invited staff');
    expect(usersPage).toContain('Deactivated staff');
    expect(usersPage).toContain('inactive until they set up their account');
    expect(usersPage).toContain(' · deactivated');
    expect(usersPage).not.toContain('never permanently deleted');
  });
  it('offers deletion only for deactivated or invited staff and explains blockers first', () => {
    expect(usersPage).toContain('(isDeactivated || isInvited) &&');
    expect(usersPage).toContain("supabase.rpc('get_staff_deletion_blockers'");
    expect(usersPage).toContain("supabase.rpc('delete_organisation_member'");
    expect(usersPage.indexOf("rpc('get_staff_deletion_blockers'")).toBeLessThan(usersPage.indexOf("rpc('delete_organisation_member'"));
    expect(usersPage).not.toMatch(/window\.confirm|\bconfirm\(/);
  });
  it('is a forward-only atomic migration that leaves earlier Issue #40 migrations untouched', () => {
    expect(conditionalDeletion.trimStart().startsWith('/*')).toBe(true);
    expect(conditionalDeletion).toContain('\nBEGIN;');
    expect(conditionalDeletion.trimEnd().endsWith('COMMIT;')).toBe(true);
    expect(conditionalDeletion).toContain('take a Supabase backup/PITR recovery');
    expect(conditionalDeletion).not.toMatch(/CREATE OR REPLACE FUNCTION public\.(update_organisation_member|link_staff_invitation|handle_new_user|activate_confirmed_staff_invitation)\b/);
  });
  it('restricts deletion to same-RTO Administration, never self, and only after deactivation', () => {
    expect(conditionalDeletion).toContain("IF NOT public.has_workspace_access('administration') THEN");
    expect(conditionalDeletion).toContain('target_user = auth.uid()');
    expect(conditionalDeletion).toContain("cross-organisation member access denied");
    expect(conditionalDeletion).toContain("target_membership.status NOT IN ('inactive','invited')");
    expect(conditionalDeletion).toContain('PERFORM 1 FROM public.organisations o WHERE o.id = org_id FOR UPDATE');
  });
  it('preserves last-Administration protection', () => {
    expect(conditionalDeletion).toContain('other_active_admins < 1');
    expect(conditionalDeletion).toContain('final Administration user cannot be removed, demoted or deactivated');
  });
  it('blocks deletion while any foreign-key or actor column records the user', () => {
    expect(conditionalDeletion).toContain("k.confrelid IN ('auth.users'::regclass, 'public.profiles'::regclass)");
    expect(conditionalDeletion).toMatch(/\.\+_by\|/);
    expect(conditionalDeletion).toContain("c.relname = 'objects' AND a.attname IN ('owner','owner_id')");
    expect(conditionalDeletion).toContain('IF blocking_areas IS NOT NULL THEN');
    expect(conditionalDeletion.indexOf('IF blocking_areas IS NOT NULL THEN'))
      .toBeLessThan(conditionalDeletion.indexOf('DELETE FROM auth.users'));
  });
  it('excludes only the user\'s own identity rows from the provenance scan', () => {
    const exclusions = conditionalDeletion.slice(conditionalDeletion.indexOf('NOT IN (VALUES'), conditionalDeletion.indexOf('ORDER BY u.sch'));
    expect(exclusions.match(/\('public','[a-z_]+','[a-z_]+'\)/g)).toEqual([
      "('public','profiles','id')",
      "('public','organisation_memberships','user_id')",
      "('public','user_workspace_access','user_id')",
      "('public','staff_invitation_grants','user_id')",
    ]);
  });
  it('records an organisation-scoped deletion audit that only Administration can read', () => {
    expect(conditionalDeletion).toContain('CREATE TABLE IF NOT EXISTS public.staff_deletion_audit');
    expect(conditionalDeletion).toContain('REVOKE ALL ON TABLE public.staff_deletion_audit FROM PUBLIC, anon, authenticated;');
    expect(conditionalDeletion).toContain('GRANT SELECT ON TABLE public.staff_deletion_audit TO authenticated;');
    expect(conditionalDeletion).toMatch(/USING \(organisation_id = public\.current_organisation_id\(\)\s+AND public\.has_workspace_access\('administration'\)\)/);
    expect(conditionalDeletion.indexOf('INSERT INTO public.staff_deletion_audit'))
      .toBeLessThan(conditionalDeletion.indexOf('DELETE FROM auth.users'));
  });
  it('keeps the provenance scanner private and exposes only customer-safe areas', () => {
    expect(conditionalDeletion).toContain('REVOKE ALL ON FUNCTION public.staff_provenance_references(uuid) FROM PUBLIC, anon, authenticated, service_role;');
    expect(conditionalDeletion).toContain('RETURNS TABLE (record_area text)');
    expect(conditionalDeletion).toContain('REVOKE ALL ON FUNCTION public.delete_organisation_member(uuid) FROM PUBLIC, anon;');
  });
  it('exercises UI deletion in the authenticated staging gate', () => {
    expect(authenticatedE2e).toContain('deletes an unreferenced invited user through the UI');
    expect(authenticatedE2e).toContain("from('staff_deletion_audit')");
  });
});

describe('Issue #40 Product Owner refinement — organisation-scoped Administration and Technical data', () => {
  it('requires the base Issue #40 migration and never guesses legacy ownership', () => {
    expect(dataScoping.trimStart().startsWith('/*')).toBe(true);
    expect(dataScoping).toContain('\nBEGIN;');
    expect(dataScoping.trimEnd().endsWith('COMMIT;')).toBe(true);
    expect(dataScoping).toContain('the base Issue #40 migration (20260809092000) is not installed');
    expect(dataScoping).toContain("current_setting('llnd.legacy_organisation_id', true)");
    expect(dataScoping).toContain('IF org_count = 1 THEN');
    expect(dataScoping).toContain('take a Supabase backup/PITR recovery');
  });
  it('replaces every existing policy on the in-scope tables but leaves the public plan catalogue alone', () => {
    const dropList = dataScoping.slice(dataScoping.indexOf("WHERE schemaname = 'public' AND tablename IN ("), dataScoping.indexOf('EXECUTE format(\'DROP POLICY'));
    for (const table of ['qualifications', 'qualification_lln_requirements', 'qualification_mapping_evidence', 'settings', 'subscriptions', 'billing_usage', 'billable_learners', 'billing_events']) {
      expect(dropList).toContain(`'${table}'`);
    }
    expect(dropList).not.toContain('subscription_plans');
  });
  it('makes qualifications organisation-owned: staff read, Administration writes', () => {
    expect(dataScoping).toContain('ALTER TABLE public.qualifications ALTER COLUMN organisation_id SET NOT NULL;');
    expect(dataScoping).toContain('CREATE TRIGGER issue040_qualification_org BEFORE INSERT OR UPDATE ON public.qualifications');
    expect(dataScoping).toMatch(/qualifications_org_select ON public\.qualifications FOR SELECT TO authenticated\s+USING \(organisation_id = public\.current_organisation_id\(\) AND public\.is_active_organisation_staff\(\)\)/);
    expect(dataScoping).toMatch(/qualifications_org_admin_update[\s\S]*?has_workspace_access\('administration'\)/);
    expect(dataScoping).toContain("FOREACH tbl IN ARRAY ARRAY['qualification_lln_requirements','qualification_mapping_evidence']");
    expect(dataScoping).toContain("FOREACH tbl IN ARRAY ARRAY['mapping_unit_evidence','mapping_evidence_attachments','mapping_evidence_reviews']");
  });
  it('never lets an end user write into another organisation or move ownership', () => {
    expect(dataScoping).toContain("RAISE EXCEPTION 'cross-organisation write denied'");
    expect(dataScoping).toContain("RAISE EXCEPTION 'organisation ownership cannot be changed'");
    expect(dataScoping).toContain("RAISE EXCEPTION 'organisation ownership must be supplied by the server'");
  });
  it('locks platform settings to the server except the non-secret environment key', () => {
    expect(dataScoping).toContain('REVOKE INSERT, UPDATE, DELETE, TRUNCATE ON TABLE public.settings FROM anon, authenticated;');
    expect(dataScoping).toMatch(/settings_public_environment_select ON public\.settings FOR SELECT TO authenticated\s+USING \(key = 'environment'\)/);
  });
  it('stores RTO configuration per organisation through an allow-listed, permission-checked function', () => {
    expect(dataScoping).toContain('PRIMARY KEY (organisation_id, key)');
    expect(dataScoping).toContain('CHECK (public.organisation_setting_category(key) IS NOT NULL)');
    expect(dataScoping).toContain('REVOKE ALL ON TABLE public.organisation_settings FROM PUBLIC, anon, authenticated;');
    expect(dataScoping).toContain("OR (category = 'technical' AND public.has_workspace_access('technical'))");
    expect(dataScoping).not.toMatch(/organisation_setting_category[\s\S]{0,600}(token|secret|password|api_key)/i);
  });
  it('mirrors only the legacy RTO into the server copy as a documented temporary bridge', () => {
    expect(dataScoping).toContain('legacy_server_settings_organisation_id');
    expect(dataScoping).toContain('ELSIF NEW.organisation_id = legacy_org THEN');
  });
  it('scopes subscriptions, usage, billable learners and billing events to Administration of the owning RTO', () => {
    expect(dataScoping).toContain('ALTER TABLE public.subscriptions ALTER COLUMN organisation_id SET NOT NULL;');
    expect(dataScoping).toContain('CREATE POLICY billing_usage_org_admin_select');
    expect(dataScoping).toContain('CREATE POLICY billable_learners_org_admin_select');
    expect(dataScoping).toContain('CREATE POLICY billing_events_org_admin_select');
  });
  it('bills a completion to the candidate\'s own organisation, not the newest subscription', () => {
    const fnBody = dataScoping.slice(dataScoping.indexOf('CREATE OR REPLACE FUNCTION public.record_billable_completion'));
    expect(fnBody).toContain('SELECT ai.organisation_id INTO v_org_id FROM assessment_invitations ai WHERE ai.id = p_invitation_id;');
    expect(fnBody).toContain("WHERE organisation_id = v_org_id AND status IN ('trialing', 'active', 'past_due')");
  });
  it('moves RTO pages off the platform settings table', () => {
    for (const page of ['CandidatesPage', 'CompliancePage', 'AxcelerateInboundPage', 'SignUpPage']) {
      expect(read(`pages/${page}.tsx`)).not.toMatch(/from\(['"]settings['"]\)/);
    }
    expect(read('pages/AxcelerateInboundPage.tsx')).toContain("supabase.rpc('set_organisation_setting'");
  });
  it('decides Edge Function staff access by membership and workspace, not the legacy role', () => {
    expect(organisationAccess).toContain('.from("organisation_memberships")');
    expect(organisationAccess).toContain('.eq("status", "active")');
    expect(organisationAccess).not.toMatch(/profiles"\)\.select\("role"/);
    for (const name of ['axcelerate-bulk-sync', 'axcelerate-inbound-sync', 'axcelerate-sync', 'import-axcelerate-qualifications', 'compute-acsf-mapping', 'process-axcelerate-queue', 'upload-axcelerate-portfolio']) {
      expect(fn(name)).not.toMatch(/\["admin", "trainer"\]\.includes/);
      expect(fn(name)).toContain('../_shared/organisation-access.ts');
    }
  });
  it('keeps the shared aXcelerate credentials inside the RTO that owns them', () => {
    expect(fn('process-axcelerate-queue').match(/\.eq\("organisation_id", integrationOrganisationId\)/g)).toHaveLength(3);
    expect(fn('axcelerate-sync')).toContain('invitation.organisation_id !== integrationOrganisationId');
    expect(fn('upload-axcelerate-portfolio')).toContain('invitation.organisation_id !== integrationOrganisationId');
    expect(fn('import-axcelerate-qualifications')).toContain('organisation_id: auth.organisationId');
    expect(fn('compute-acsf-mapping')).toContain('.eq("organisation_id", auth.organisationId)');
    expect(fn('save-axcelerate-secrets')).toContain('integrationOrganisationId !== staff!.organisationId');
  });
  it('requires Administration of the caller\'s own RTO for Stripe checkout and portal', () => {
    for (const name of ['stripe-checkout', 'stripe-portal']) {
      expect(fn(name)).toContain('hasAnyWorkspace(staff, ["administration"])');
      expect(fn(name)).toContain('.eq("organisation_id", staff!.organisationId)');
    }
    expect(fn('stripe-checkout')).toContain('"metadata[organisation_id]": staff!.organisationId');
  });
  it('verifies Stripe webhook signatures and never updates the newest subscription on the platform', () => {
    const webhook = fn('stripe-webhook');
    expect(webhook).toContain('crypto.subtle.importKey');
    expect(webhook).toContain('Stripe webhook secret is not configured');
    expect(webhook).toContain('resolveEventOrganisation(supabase, obj)');
    expect(webhook).toContain('.eq("organisation_id", organisationId)');
    expect(fn('save-stripe-key')).toContain('isIntegrationStaff(req.headers.get("Authorization"), ["administration"])');
  });
});

describe('Issue #40 — emails and Technical logs use the owning RTO', () => {
  it('brands and configures emails from the RTO\'s own settings, not the platform table', () => {
    for (const name of ['send-email', 'on-assessment-complete', 'process-email-queue', 'send-admin-otp']) {
      const source = fn(name);
      expect(source).toMatch(/getOrganisationEmailProfile|createEmailProfileCache/);
      expect(source).not.toMatch(/\.in\("key", \[[^\]]*"(org_branding|email_settings|notification_settings)"/);
    }
    expect(organisationAccess).toContain('.from("organisation_settings")');
  });
  it('lets staff send or process emails only for their own RTO', () => {
    expect(fn('send-email')).toContain('invitationOrg.organisation_id !== auth.organisationId');
    expect(fn('send-email')).not.toMatch(/\["admin", "trainer"\]\.includes/);
    expect(fn('process-email-queue')).toContain('if (callerOrganisationId) queueQuery = queueQuery.eq("organisation_id", callerOrganisationId);');
    expect(fn('process-email-queue')).toContain('organisation_id: inv.organisation_id,');
  });
  it('stamps server-written logs and queues with the related invitation\'s RTO', () => {
    const trigger = dataScoping.slice(dataScoping.indexOf('CREATE OR REPLACE FUNCTION public.set_diagnostic_organisation()'));
    expect(trigger).toContain("to_jsonb(NEW) ->> 'invitation_id'");
    expect(trigger).toContain("RAISE EXCEPTION 'diagnostic organisation does not match the invitation'");
    expect(trigger).toContain("RAISE EXCEPTION 'cross-organisation diagnostic write denied'");
    expect(trigger).toContain("RAISE EXCEPTION 'diagnostic organisation cannot be resolved safely'");
  });
});

describe('Issue #40 — candidate ownership for server-created candidates', () => {
  it('keeps every aXcelerate inbound candidate, invitation and qualification query inside the integration RTO', () => {
    const inbound = fn('axcelerate-inbound-sync');
    const unscoped = [...inbound.matchAll(/\.from\("(students|enrolments|assessment_invitations|qualifications)"\)\s*\.(select|update)\(/g)]
      .filter(m => !inbound.slice(m.index!, m.index! + 400).includes('.eq("organisation_id", INTEGRATION_ORGANISATION_ID)'));
    expect(unscoped).toEqual([]);
    // students, enrolments and invitations inserts, plus the inbound-sync log
    // upsert (assessment-result validity), all name the integration RTO.
    expect(inbound.match(/organisation_id: INTEGRATION_ORGANISATION_ID,/g)).toHaveLength(4);
    expect(inbound).toContain('INTEGRATION_ORGANISATION_ID = integrationOrganisationId;');
  });
  it('lets a trusted server name the owning RTO and never lets users cross RTOs', () => {
    const trigger = dataScoping.slice(dataScoping.indexOf('CREATE OR REPLACE FUNCTION public.set_candidate_organisation()'));
    expect(trigger).toContain('IF resolved IS NULL AND auth.uid() IS NULL AND NEW.organisation_id IS NOT NULL THEN');
    expect(trigger).toContain("RAISE EXCEPTION 'cross-organisation candidate write denied'");
    expect(trigger).toContain("RAISE EXCEPTION 'client-supplied organisation ownership does not match trusted context'");
  });
  it('does not reference student_id on the students table in a combined condition', () => {
    const trigger = dataScoping.slice(dataScoping.indexOf('CREATE OR REPLACE FUNCTION public.set_candidate_organisation()'));
    expect(trigger).toMatch(/IF TG_TABLE_NAME IN \('enrolments','assessment_invitations'\) THEN\s+IF NEW\.student_id IS NOT NULL THEN/);
    expect(trigger).not.toMatch(/TG_TABLE_NAME[^\n]*AND NEW\.student_id/);
  });
});

describe('Issue #40 — no legacy role-wide access to remaining candidate records', () => {
  const section = dataScoping.slice(dataScoping.indexOf('-- ── 8. Remaining candidate records'));
  it('drops only legacy role-based staff policies, keeping candidate token policies', () => {
    for (const table of ['enrolments', 'audit_trail', 'student_lifecycle_events', 'student_responses', 'notifications', 'axcelerate_portfolio_uploads', 'axcelerate_sync_log', 'axcelerate_inbound_sync_log', 'axcelerate_writeback_queue', 'email_queue']) {
      expect(section).toContain(`'${table}'`);
    }
    expect(section).toContain("AND 'authenticated' = ANY(roles)");
    expect(section).toContain('get_my_role');
  });
  it('scopes enrolments, answers, audit, notifications, lifecycle and uploads to the owning RTO', () => {
    expect(section).toContain('CREATE POLICY enrolments_workspace_select ON public.enrolments');
    expect(section).toContain('USING (public.can_manage_support_invitation(invitation_id));');
    expect(section).toContain('CREATE POLICY audit_trail_workspace_select');
    expect(section).toContain('CREATE POLICY lifecycle_workspace_select');
    expect(section).toContain('CREATE POLICY portfolio_uploads_workspace_select');
  });
  it('limits staff writes to Technical queues and logs to their own RTO', () => {
    expect(section).toContain("|| '_org_staff_insert'");
    expect(section).toContain("|| '_org_admin_select'");
    expect(section).not.toMatch(/FOR (INSERT|UPDATE|DELETE)[^;]*USING \(true\)/);
  });
});

