// Issue #45 — platform-operator access against the staging preview.
// Requires the Issue #40 and #45 migrations, the operator-support function,
// MFA enabled in Supabase Auth, and the dedicated operator test account
// (E2E_OPERATOR_EMAIL / E2E_OPERATOR_PASSWORD / E2E_OPERATOR_TOTP_SECRET).

import { expect, test } from 'playwright/test';
import { authenticatePage, authenticatedEnvironment as env } from './helpers/authenticated-session';
import { callOperatorSupport, operatorEnvironment, signIn, signInOperatorWithMfa } from './helpers/operator-session';

const rtoIdentities = [
  ['Administration', env.adminEmail, env.adminPassword],
  ['Candidate Support', env.candidateSupportEmail, env.candidateSupportPassword],
  ['Technical', env.technicalEmail, env.technicalPassword],
  ['Super User (all three workspaces)', env.superUserEmail, env.superUserPassword],
] as const;

test.describe.configure({ mode: 'serial' });

for (const [label, email, password] of rtoIdentities) {
  test(`${label} test identity is not a platform operator`, async () => {
    const { client, session } = await signIn(email, password);
    const { data: status } = await client.rpc('platform_operator_status');
    expect(status?.granted).toBe(false);
    expect(status?.operator).toBe(false);

    const { data: orgs } = await client.rpc('list_organisations_for_support');
    expect(orgs ?? []).toEqual([]);
    const { error: startError } = await client.rpc('start_operator_support_session', {
      p_organisation_id: '00000000-0000-0000-0000-000000000000', p_reason: 'should be refused for RTO staff',
    });
    expect(startError).not.toBeNull();

    const support = await callOperatorSupport(session.access_token, { resource: 'organisation_summary' });
    expect(support.status).toBe(403);

    const { data: eiosRows } = await client.from('ecc_ai_inbox').select('id').limit(1);
    expect(eiosRows ?? []).toEqual([]);
  });
}

test('RTO staff opening EIOS by direct URL see the operator-access screen', async ({ page }) => {
  await authenticatePage(page, env.superUserEmail, env.superUserPassword);
  await page.goto('/eios#/engineering');
  await expect(page.getByTestId('operator-access-denied')).toBeVisible();
  await page.goto('/eios#/operator/support');
  await expect(page.getByTestId('operator-access-denied')).toBeVisible();
});

test('operator without MFA is not yet an operator', async () => {
  const { client, session } = await signIn(operatorEnvironment.email, operatorEnvironment.password);
  const { data: status } = await client.rpc('platform_operator_status');
  expect(status?.granted).toBe(true);
  expect(status?.mfa_verified).toBe(false);
  expect(status?.operator).toBe(false);
  expect((await callOperatorSupport(session.access_token, { resource: 'organisation_summary' })).status).toBe(403);
});

test('operator support session: start, view, RTO sees it, end, access stops', async () => {
  const { client: operator, session } = await signInOperatorWithMfa();
  const { data: status } = await operator.rpc('platform_operator_status');
  expect(status?.operator).toBe(true);

  const { client: admin } = await signIn(env.adminEmail, env.adminPassword);
  const { data: org } = await admin.from('organisations').select('id, name').maybeSingle();
  expect(org?.id).toBeTruthy();

  const reason = `Issue 45 staging test ${Date.now()}`;
  const { error: tooShort } = await operator.rpc('start_operator_support_session', { p_organisation_id: org!.id, p_reason: 'short' });
  expect(tooShort).not.toBeNull();
  const { error: tooLong } = await operator.rpc('start_operator_support_session', { p_organisation_id: org!.id, p_reason: reason, p_minutes: 61 });
  expect(tooLong).not.toBeNull();
  const { error: startError } = await operator.rpc('start_operator_support_session', { p_organisation_id: org!.id, p_reason: reason, p_minutes: 15 });
  expect(startError).toBeNull();

  const summary = await callOperatorSupport(session.access_token, { resource: 'organisation_summary' });
  expect(summary.status).toBe(200);
  expect(summary.body?.organisation?.id).toBe(org!.id);
  const mismatched = await callOperatorSupport(session.access_token, { resource: 'staff_list', organisation_id: '00000000-0000-0000-0000-000000000000' });
  expect(mismatched.status).toBe(409);
  const emails = await callOperatorSupport(session.access_token, { resource: 'email_activity' });
  expect(emails.status).toBe(200);
  for (const row of emails.body?.data ?? []) expect(row.recipient === '' || row.recipient.includes('***@')).toBe(true);

  const { data: log } = await admin.rpc('list_platform_support_access');
  const entry = (log ?? []).find((r: { reason: string }) => r.reason === reason);
  expect(entry?.operator_name).toContain('LLND Automate platform support');
  expect(entry?.information_viewed).toContain('organisation_summary');

  const { client: technical } = await signIn(env.technicalEmail, env.technicalPassword);
  const { data: techLog } = await technical.rpc('list_platform_support_access');
  expect(techLog ?? []).toEqual([]);

  const { error: endError } = await operator.rpc('end_operator_support_session');
  expect(endError).toBeNull();
  expect((await callOperatorSupport(session.access_token, { resource: 'organisation_summary' })).status).toBe(409);
});

test('secret-saving functions refuse RTO Administration', async () => {
  const { session } = await signIn(env.adminEmail, env.adminPassword);
  for (const name of ['save-llm-secret', 'save-email-secret', 'save-provider-key', 'save-stripe-key']) {
    const response = await fetch(`${env.supabaseUrl}/functions/v1/${name}`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${session.access_token}`, apikey: env.anonKey, 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    });
    expect(response.status, name).toBe(403);
  }
});
