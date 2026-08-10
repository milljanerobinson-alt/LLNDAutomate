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
const invite = read('../supabase/functions/invite-rto-staff/index.ts');
const originPolicy = read('../supabase/functions/invite-rto-staff/origin-policy.ts');

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
  it('supports reversible activation without permanent deletion', () => {
    expect(migration).toContain("new_status NOT IN ('active','inactive')");
    expect(read('pages/workspace/UsersPage.tsx')).not.toMatch(/\.from\(['"]profiles['"]\)\.delete/);
  });
  it('sends invitations through a server-side admin API', () => {
    expect(invite).toContain('auth.admin.inviteUserByEmail');
    expect(invite).toContain('SUPABASE_SERVICE_ROLE_KEY');
    expect(read('pages/workspace/UsersPage.tsx')).not.toContain('SUPABASE_SERVICE_ROLE_KEY');
  });
  it('keeps invited accounts inactive until confirmed auth state activates them', () => {
    expect(migration).toContain("VALUES (grant_row.organisation_id,p_user_id,'invited'");
    expect(migration).toContain('is_active=false');
    expect(migration).toContain('AFTER UPDATE OF email_confirmed_at ON auth.users');
    expect(migration).toContain("SET status='active',activated_at=now()");
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
