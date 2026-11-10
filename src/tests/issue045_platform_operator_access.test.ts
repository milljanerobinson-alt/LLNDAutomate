import { describe, expect, it } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';

// Issue #45 — platform-operator access. Contract tests over the migration,
// Edge Function guards and the app gate. Behaviour of the SQL itself is
// exercised separately against PostgreSQL (operator scenarios P01–P43).

const read = (relative: string) => fs.readFileSync(path.resolve(__dirname, '..', relative), 'utf8');
const migration = read('../supabase/migrations/20261028140000_issue045_platform_operator_access.sql');
const guard = read('../supabase/functions/_shared/platform-operator.ts');
const support = read('../supabase/functions/operator-support/index.ts');
const mcp = read('../supabase/functions/atd-mcp-server/index.ts');
const app = read('App.tsx');
const gate = read('components/operator/PlatformOperatorGate.tsx');
const mfa = read('components/operator/OperatorMfaStep.tsx');
const supportPage = read('pages/operator/OperatorSupportPage.tsx');
const switcher = read('components/WorkspaceSwitcher.tsx');
const orgPage = read('pages/workspace/OrganisationPage.tsx');
const client = read('lib/platformOperator.ts');
const fn = (name: string) => read(`../supabase/functions/${name}/index.ts`);
const fnBody = (sql: string, name: string) => {
  const start = sql.indexOf(`FUNCTION public.${name}(`);
  expect(start, `${name} is defined`).toBeGreaterThan(-1);
  return sql.slice(start, sql.indexOf('$$;', start));
};

const SECRET_FUNCTIONS = ['save-email-secret', 'save-llm-secret', 'save-provider-key', 'save-stripe-key'];
const EIOS_FUNCTIONS = [
  'ai-health-check', 'ai-playground-execute', 'analyze-conversations', 'analyze-error', 'architecture-guardian',
  'atd-connect-bridge', 'atd-conversation-gateway', 'atd-engineering-draft', 'atd-reasoning', 'codex-dry-run',
  'codex-execute', 'codex-health-check', 'command-centre-ai', 'create-engineering-work-order',
  'engineering-intelligence', 'engineering-knowledge-extraction', 'engineering-review',
  'generate-engineering-briefing', 'generate-platform-audit', 'github-bootstrap', 'github-operations',
  'governed-acceptance', 'lifecycle-reconciliation', 'post-acceptance-pipeline', 'prepare-execution-request',
  'repository-operations', 'resolve-conversation-intent', 'save-codex-credential', 'technical-director',
  'test-ai-provider-connection',
];

describe('Issue #45 migration: operator grant', () => {
  it('runs only after the Issue #40 migrations', () => {
    expect(migration).toMatch(/20261028130000|issue040/);
  });
  it('locks platform_operators away from every API role', () => {
    expect(migration).toMatch(/REVOKE ALL ON TABLE public\.platform_operators, public\.platform_operator_audit FROM PUBLIC, anon, authenticated, service_role/);
    expect(migration).toMatch(/REVOKE ALL ON TABLE public\.operator_support_sessions, public\.operator_access_audit FROM PUBLIC, anon, authenticated, service_role/);
  });
  it('makes grant/revoke callable only from the SQL Editor, never by an app user', () => {
    for (const name of ['grant_platform_operator', 'revoke_platform_operator']) {
      const body = fnBody(migration, name);
      expect(body).toContain('SECURITY INVOKER');
      expect(body).toMatch(/auth\.uid\(\) IS NOT NULL/);
      expect(migration).toMatch(new RegExp(`REVOKE ALL ON FUNCTION public\\.${name}\\(text, text\\) FROM PUBLIC, anon, authenticated, service_role`));
    }
  });
  it('requires a reason and audits each grant and revoke', () => {
    expect(fnBody(migration, 'grant_platform_operator')).toMatch(/length\(trim\(p_reason\)\) < 10/);
    expect(fnBody(migration, 'grant_platform_operator')).toContain('platform_operator_audit');
    expect(fnBody(migration, 'revoke_platform_operator')).toContain('platform_operator_audit');
  });
  it('is_platform_operator needs an active grant AND MFA (aal2)', () => {
    const body = fnBody(migration, 'is_platform_operator');
    expect(body).toContain('revoked_at IS NULL');
    expect(body).toMatch(/auth\.jwt\(\)\s*->>\s*'aal'.*'aal2'/s);
  });
  it('never derives operator status from RTO workspaces or the legacy admin role', () => {
    const body = fnBody(migration, 'is_platform_operator');
    expect(body).not.toContain('user_workspace_access');
    expect(body).not.toContain('has_workspace_access');
    expect(body).not.toMatch(/role\s*=\s*'admin'/);
  });
});

describe('Issue #45 migration: support sessions and audit', () => {
  it('caps sessions at 60 minutes in the table and the start function', () => {
    expect(migration).toMatch(/interval '60 minutes'/);
    expect(fnBody(migration, 'start_operator_support_session')).toMatch(/minutes < 5 OR minutes > 60/);
  });
  it('requires a session reason of at least 10 characters', () => {
    expect(fnBody(migration, 'start_operator_support_session')).toMatch(/length\(trim\(p_reason\)\) < 10/);
  });
  it('allows only one open session per operator and can end it', () => {
    expect(migration).toMatch(/UNIQUE INDEX[\s\S]*operator_support_sessions[\s\S]*WHERE ended_at IS NULL/);
    expect(fnBody(migration, 'end_operator_support_session')).toContain("end_reason = 'ended'");
  });
  it('records views only within an active session, attributed from the caller token', () => {
    const body = fnBody(migration, 'record_operator_access');
    expect(body).toContain('active_operator_support_session');
    expect(body).toContain('auth.uid()');
    expect(body).toMatch(/\^\[a-z_\]\{3,40\}\$/);
  });
  it('shows the RTO log only to that RTO’s Administration, labelled as platform support', () => {
    const body = fnBody(migration, 'list_platform_support_access');
    expect(body).toContain('current_organisation_id()');
    expect(body).toContain("has_workspace_access('administration')");
    expect(body).toContain('LLND Automate platform support');
    expect(body).toContain('a.rto_visible');
  });
});

describe('Issue #45 migration: EIOS tables', () => {
  it('revokes anonymous access and restricts EIOS rows to operators', () => {
    expect(migration).toMatch(/REVOKE ALL ON .* FROM anon/);
    expect(migration).toContain('platform_operator_access');
    expect(migration).toContain('USING ((SELECT public.is_platform_operator()))');
    expect(migration).toContain('WITH CHECK ((SELECT public.is_platform_operator()))');
  });
  it('makes EIOS views run with the caller’s permissions', () => {
    expect(migration).toContain('security_invoker = true');
  });
  it('does not classify LLND customer tables as EIOS', () => {
    const fnDef = fnBody(migration, 'issue045_is_eios_relation');
    for (const table of ['students', 'enrolments', 'organisations', 'qualifications', 'support_cases', 'email_queue', 'subscriptions', 'settings']) {
      expect(fnDef).not.toMatch(new RegExp(`'${table}'`));
      expect(fnDef).not.toMatch(new RegExp(`\\^\\(.*\\b${table}_`));
    }
  });
});

describe('Issue #45 Edge Function guards', () => {
  it('asks the database with the caller’s own token', () => {
    expect(guard).toContain('rpc("is_platform_operator")');
    expect(guard).toContain('SUPABASE_ANON_KEY');
    expect(guard).not.toMatch(/role\s*===?\s*["']admin["']/);
  });
  it.each(SECRET_FUNCTIONS)('%s requires an MFA operator with no service-role bypass', name => {
    const src = fn(name);
    expect(src).toContain('requirePlatformOperator');
    expect(src).toMatch(/allowServiceRole:\s*false/);
  });
  it.each(SECRET_FUNCTIONS)('%s never returns a stored secret value', name => {
    const src = fn(name);
    expect(src).not.toMatch(/JSON\.stringify\(\{[^}]*\b(secret|apiKey|api_key|value)\s*[:,}]/);
  });
  it.each(EIOS_FUNCTIONS)('%s is guarded by the operator check', name => {
    expect(fn(name)).toContain('requirePlatformOperator');
  });
  it.each(EIOS_FUNCTIONS)('%s no longer authorises by profiles.role = admin', name => {
    expect(fn(name)).not.toMatch(/role\s*===?\s*["']admin["']/);
  });
  it('the MCP server refuses non-operators', () => {
    expect(mcp).toContain('rpc("is_platform_operator")');
  });
});

describe('Issue #45 operator-support function', () => {
  it('is read-only: no writes to RTO tables', () => {
    expect(support).not.toMatch(/\.(insert|update|upsert|delete)\(/);
  });
  it('takes the RTO from the operator’s session, not the request', () => {
    expect(support).toContain('active_operator_support_session');
    expect(support).toContain('session.organisation_id');
    expect(support).toMatch(/body\.organisation_id !== session\.organisation_id/);
  });
  it('records each view before returning, and fails closed', () => {
    const recordAt = support.indexOf('record_operator_access');
    const returnAt = support.lastIndexOf('return json({\n    organisation');
    expect(recordAt).toBeGreaterThan(-1);
    expect(returnAt).toBeGreaterThan(recordAt);
    expect(support).toMatch(/if \(auditError\) return json\(.*500\)/);
  });
  it('never reads setting values, Stripe identifiers or raw payloads', () => {
    const code = support.split('\n').filter(l => !l.trim().startsWith('//')).join('\n');
    expect(code).not.toMatch(/stripe_customer_id|stripe_subscription_id|payload|error_message|response_body/);
    expect(code).not.toMatch(/from\("settings"\)\.select\("(\*|[^"]*key[^"]*value)/);
  });
  it('masks email recipients', () => {
    expect(support).toContain('maskEmail(e.recipient_email)');
  });
  it('rejects unknown views', () => {
    expect(support).toContain('SUPPORT_RESOURCES.includes(resource)');
  });
});

describe('Issue #45 app', () => {
  it('gates EIOS and RTO support behind PlatformOperatorGate', () => {
    expect(app).toMatch(/<PlatformOperatorGate>\s*<EngineeringLayout>/);
    expect(app).toMatch(/<PlatformOperatorGate>[\s\S]*<OperatorSupportPage \/>/);
    expect(app).not.toContain("profile?.role !== 'admin'");
  });
  it('the gate uses the database status and asks for MFA before entry', () => {
    expect(gate).toContain('getPlatformOperatorStatus');
    expect(gate).toContain('OperatorMfaStep');
    expect(client).toContain("rpc('platform_operator_status')");
    expect(mfa).toContain('mfa.challengeAndVerify');
  });
  it('shows a persistent banner with the RTO, end time and End session', () => {
    expect(gate).toContain('Supporting:');
    expect(gate).toContain('End session');
    expect(gate).toContain('endSupportSession');
  });
  it('support page requires an RTO and a reason', () => {
    expect(supportPage).toContain('reason.trim().length < 10');
    expect(supportPage).toContain('startSupportSession');
  });
  it('the switcher shows EIOS only to operators', () => {
    expect(switcher).toContain('operatorStatus.operator');
    expect(switcher).not.toContain("profile?.role === 'admin'");
  });
  it('RTO Administration sees the platform support access log', () => {
    expect(orgPage).toContain('PlatformSupportAccessPanel');
    expect(client).toContain("rpc('list_platform_support_access')");
  });
  it('the browser never calls the grant or revoke functions', () => {
    expect(client).not.toMatch(/grant_platform_operator|revoke_platform_operator/);
    expect(gate + supportPage).not.toMatch(/grant_platform_operator|revoke_platform_operator/);
  });
});
