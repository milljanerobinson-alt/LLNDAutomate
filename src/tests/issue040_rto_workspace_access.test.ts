import { describe, expect, it } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';

const read = (relative: string) => fs.readFileSync(path.resolve(__dirname, '..', relative), 'utf8');
const access = read('lib/workspaceAccess.ts');
const switcher = read('components/WorkspaceSwitcher.tsx');
const layout = read('components/CustomerWorkspaceLayout.tsx');
const palette = read('components/CommandPalette.tsx');
const app = read('App.tsx');
const migration = read('../supabase/migrations/20260809092000_issue040_rto_workspace_access.sql');
const invite = read('../supabase/functions/invite-rto-staff/index.ts');

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
});

describe('Issue #40 support-case and tenancy enforcement', () => {
  it('creates support cases unassigned without inventing an aXcelerate owner', () => {
    expect(migration).toContain("assignment_source text NOT NULL DEFAULT 'unassigned'");
    expect(migration).toContain('axcelerate_relationship_source text');
  });
  it('limits Candidate Support to assigned or unassigned cases', () => {
    expect(migration).toContain('(assignee = auth.uid() OR assignee IS NULL)');
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
    expect(migration).toContain('case_org = current_organisation_id()');
    expect(migration).toContain('cross-organisation member access denied');
  });
  it('denies inactive users through membership and profile checks', () => {
    expect(migration).toContain("m.status = 'active'");
    expect(migration).toContain('JOIN profiles p ON p.id = m.user_id AND p.is_active');
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
