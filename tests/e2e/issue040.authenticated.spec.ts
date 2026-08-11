import { expect, test as base, type Page } from 'playwright/test';
import {
  authenticatePage,
  authenticatedEnvironment as env,
  passwordClient,
  removeDisposableInvitationFixture,
  serviceClient,
} from './helpers/authenticated-session';

type RuntimeEvidence = {
  consoleErrors: string[];
  pageErrors: string[];
  criticalFailures: string[];
};

function observeRuntime(page: Page): RuntimeEvidence {
  const evidence: RuntimeEvidence = { consoleErrors: [], pageErrors: [], criticalFailures: [] };
  page.on('console', message => { if (message.type() === 'error') evidence.consoleErrors.push(message.text()); });
  page.on('pageerror', error => evidence.pageErrors.push(error.message));
  page.on('requestfailed', request => {
    if (['document', 'script', 'stylesheet'].includes(request.resourceType()) || request.url().includes('/invite-rto-staff')) {
      evidence.criticalFailures.push(`${request.method()} ${request.url()}: ${request.failure()?.errorText ?? 'failed'}`);
    }
  });
  page.on('response', response => {
    const resourceType = response.request().resourceType();
    const isCritical = ['document', 'script', 'stylesheet'].includes(resourceType)
      || response.url().includes('/functions/v1/');
    if (isCritical && response.status() >= 400) {
      evidence.criticalFailures.push(`${response.request().method()} ${response.url()}: HTTP ${response.status()}`);
    }
  });
  return evidence;
}

const test = base.extend<{ runtimeEvidence: RuntimeEvidence }>({
  runtimeEvidence: async ({ page }, use) => {
    const evidence = observeRuntime(page);
    await use(evidence);
    expect(evidence.pageErrors, 'unexpected uncaught page exceptions').toEqual([]);
    expect(evidence.consoleErrors, 'unexpected browser console errors').toEqual([]);
    expect(evidence.criticalFailures, 'critical authenticated request failures').toEqual([]);
  },
});

const WORKSPACE_ORDER = ['administration', 'candidate_support', 'technical'] as const;

async function expectWorkspaceMenu(page: Page, expected: readonly string[]) {
  await page.locator('header').getByTestId('workspace-switcher-trigger').click();
  const menu = page.getByTestId('workspace-switcher-menu');
  await expect(menu).toBeVisible();
  await expect(menu.locator('[data-workspace]')).toHaveCount(expected.length);
  expect(await menu.locator('[data-workspace]').evaluateAll(elements =>
    elements.map(element => element.getAttribute('data-workspace')),
  )).toEqual(expected);
  await expect(menu).not.toContainText('Candidate Assessment');
  return menu;
}

test.describe.serial('Issue #40 authenticated staging gate', () => {
  test('Administration-only identity is confined to Administration and can use Users', async ({ page, runtimeEvidence: _runtime }) => {
    const user = await authenticatePage(page, env.adminEmail, env.adminPassword);
    await page.goto('/#/rto-admin/dashboard');
    await expect(page).toHaveURL(/#\/rto-admin\/dashboard$/);
    expect(user.email?.toLowerCase()).toBe(env.adminEmail);
    await expectWorkspaceMenu(page, ['administration']);

    await page.goto('/#/candidate-support/dashboard');
    await expect(page).toHaveURL(/#\/rto-admin\/dashboard$/);
    await page.goto('/#/technical/dashboard');
    await expect(page).toHaveURL(/#\/rto-admin\/dashboard$/);

    await page.goto('/#/rto-admin/users');
    await expect(page.getByRole('heading', { name: 'Users', exact: true })).toBeVisible();
    await expect(page.getByRole('heading', { name: 'Invite staff user' })).toBeVisible();
  });

  test('Candidate Support-only identity is confined to eligible support cases', async ({ page, runtimeEvidence: _runtime }) => {
    const user = await authenticatePage(page, env.candidateSupportEmail, env.candidateSupportPassword);
    const supportResponse = page.waitForResponse(response =>
      response.url().includes('/rest/v1/support_cases') && response.request().method() === 'GET',
    );
    await page.goto('/#/candidate-support/candidates');
    await expect(page).toHaveURL(/#\/candidate-support\/candidates$/);
    await expect(page.getByRole('heading', { name: 'Candidates Requiring Support' })).toBeVisible();
    const response = await supportResponse;
    expect(response.status()).toBe(200);
    const cases = await response.json() as Array<{ assigned_user_id: string | null }>;
    expect(cases.every(item => item.assigned_user_id === null || item.assigned_user_id === user.id)).toBe(true);
    await expectWorkspaceMenu(page, ['candidate_support']);

    await page.goto('/#/rto-admin/dashboard');
    await expect(page).toHaveURL(/#\/candidate-support\/dashboard$/);
    await page.goto('/#/technical/dashboard');
    await expect(page).toHaveURL(/#\/candidate-support\/dashboard$/);
  });

  test('Technical-only identity has no Administration, Support or broad candidate browsing', async ({ page, runtimeEvidence: _runtime }) => {
    await authenticatePage(page, env.technicalEmail, env.technicalPassword);
    const candidateRequests: string[] = [];
    page.on('request', request => {
      if (/\/rest\/v1\/(students|support_cases|assessment_invitations)/.test(request.url())) candidateRequests.push(request.url());
    });
    await page.goto('/#/technical/dashboard');
    await expect(page).toHaveURL(/#\/technical\/dashboard$/);
    await expect(page.getByRole('heading', { name: 'Technical Workspace' })).toBeVisible();
    await expectWorkspaceMenu(page, ['technical']);

    await page.goto('/#/rto-admin/dashboard');
    await expect(page).toHaveURL(/#\/technical\/dashboard$/);
    await page.goto('/#/candidate-support/dashboard');
    await expect(page).toHaveURL(/#\/technical\/dashboard$/);
    await page.goto('/#/rto-admin/candidates');
    await expect(page).toHaveURL(/#\/technical\/dashboard$/);
    expect(candidateRequests).toEqual([]);
  });

  test('Super User owns ordered multi-workspace switching without route leakage', async ({ page, runtimeEvidence: _runtime }) => {
    const user = await authenticatePage(page, env.superUserEmail, env.superUserPassword);
    expect(user.email?.toLowerCase()).toBe(env.superUserEmail);
    await page.goto('/#/rto-admin/dashboard');
    const menu = await expectWorkspaceMenu(page, WORKSPACE_ORDER);

    await menu.locator('[data-workspace="candidate_support"]').click();
    await expect(page).toHaveURL(/#\/candidate-support\/dashboard$/);
    await expect(page.locator('header')).toContainText('Support Queue');
    let nextMenu = await expectWorkspaceMenu(page, WORKSPACE_ORDER);
    await nextMenu.locator('[data-workspace="technical"]').click();
    await expect(page).toHaveURL(/#\/technical\/dashboard$/);
    await expect(page.locator('header')).toContainText('System Health');
    nextMenu = await expectWorkspaceMenu(page, WORKSPACE_ORDER);
    await nextMenu.locator('[data-workspace="administration"]').click();
    await expect(page).toHaveURL(/#\/rto-admin\/dashboard$/);

    await page.goto('/#/rto-admin/users');
    await expect(page.getByRole('heading', { name: 'Users', exact: true })).toBeVisible();
  });

  test('preview preflight and invitation POST preserve canonical invited state', async ({ page, runtimeEvidence: _runtime }) => {
    await removeDisposableInvitationFixture();
    const service = serviceClient();
    try {
      await authenticatePage(page, env.adminEmail, env.adminPassword);
      await page.goto('/#/rto-admin/users');
      const { data: adminMembership, error: adminMembershipError } = await service
        .from('organisation_memberships').select('organisation_id').eq('user_id', (await service.auth.admin.listUsers({ page: 1, perPage: 1000 })).data.users.find(user => user.email?.toLowerCase() === env.adminEmail)!.id).single();
      expect(adminMembershipError).toBeNull();
      const methods: string[] = [];
      page.on('request', request => {
        if (request.url().includes('/invite-rto-staff')) methods.push(request.method());
      });

      await page.getByPlaceholder('Full name').fill('LLND E2E Invite');
      await page.getByPlaceholder('Email address').fill(env.inviteEmail);
      const invitationResponse = page.waitForResponse(response =>
        response.url().includes('/invite-rto-staff') && response.request().method() === 'POST',
      );
      await page.getByRole('button', { name: 'Send invitation now' }).click();
      const response = await invitationResponse;
      expect(response.status(), await response.text()).toBe(200);
      expect(methods).toContain('OPTIONS');
      expect(methods).toContain('POST');
      await expect(page.getByText('Invitation email sent.')).toBeVisible();

      const invitedRow = page.locator('[data-testid="organisation-staff-row"]', { hasText: env.inviteEmail });
      await expect(invitedRow).toBeVisible();
      await expect(invitedRow.getByTestId('staff-status')).toHaveText('invited');
      await expect(invitedRow).toContainText('inactive');
      await expect(invitedRow.getByTestId('staff-workspace')).toHaveText('Candidate Support');

      const { data: grant, error: grantError } = await service.from('staff_invitation_grants')
        .select('id,user_id,status,approved_workspaces').eq('invited_email', env.inviteEmail).single();
      expect(grantError).toBeNull();
      expect(grant?.status).toBe('pending');
      expect(grant?.user_id).toBeTruthy();
      expect(grant?.approved_workspaces).toEqual(['candidate_support']);

      const userId = grant!.user_id as string;
      const [{ data: memberships }, { data: profile }, { count: accessBefore }] = await Promise.all([
        service.from('organisation_memberships').select('id,organisation_id,status').eq('user_id', userId),
        service.from('profiles').select('is_active').eq('id', userId).single(),
        service.from('user_workspace_access').select('*', { count: 'exact', head: true }).eq('user_id', userId),
      ]);
      expect(memberships).toHaveLength(1);
      expect(memberships![0].status).toBe('invited');
      expect(memberships![0].organisation_id).toBe(adminMembership!.organisation_id);
      expect(profile?.is_active).toBe(false);
      expect(accessBefore).toBe(0);

      const { error: retryError } = await service.rpc('reconcile_staff_invitation', { p_grant_id: grant!.id });
      expect(retryError).toBeNull();
      const { data: retryMemberships } = await service.from('organisation_memberships').select('id,status').eq('user_id', userId);
      expect(retryMemberships).toEqual([{ id: memberships![0].id, status: 'invited' }]);
    } finally {
      await removeDisposableInvitationFixture();
    }
  });

  test('real invitation action link uses the acceptance UI and activates the same membership once', async ({ page, runtimeEvidence: _runtime }) => {
    await removeDisposableInvitationFixture();
    const service = serviceClient();
    try {
      const { data: users, error: usersError } = await service.auth.admin.listUsers({ page: 1, perPage: 1000 });
      expect(usersError).toBeNull();
      const adminUser = users.users.find(user => user.email?.toLowerCase() === env.adminEmail);
      expect(adminUser).toBeTruthy();
      const { data: adminMembership, error: adminMembershipError } = await service
        .from('organisation_memberships').select('organisation_id').eq('user_id', adminUser!.id).single();
      expect(adminMembershipError).toBeNull();

      const { data: grantId, error: grantError } = await service.rpc('prepare_staff_invitation', {
        p_email: env.inviteEmail,
        p_full_name: 'LLND E2E Invite',
        p_organisation_id: adminMembership!.organisation_id,
        p_workspaces: ['candidate_support'],
        p_inviter_id: adminUser!.id,
      });
      expect(grantError).toBeNull();

      // Supabase Admin generateLink is the deterministic substitute for reading
      // the actual mailbox. It uses the real invite verification endpoint and
      // frontend callback, but deliberately does not send a second email.
      const { data: generated, error: generateError } = await service.auth.admin.generateLink({
        type: 'invite',
        email: env.inviteEmail,
        options: {
          redirectTo: `${env.baseUrl.replace(/\/$/, '')}/accept-invite`,
          data: { full_name: 'LLND E2E Invite', invitation_grant_id: grantId },
        },
      });
      expect(generateError).toBeNull();
      expect(generated.properties?.action_link).toBeTruthy();
      expect(generated.user).toBeTruthy();

      const { error: linkError } = await service.rpc('link_staff_invitation', {
        p_grant_id: grantId,
        p_user_id: generated.user.id,
      });
      expect(linkError).toBeNull();

      const [{ data: invitedMemberships }, { data: invitedProfile }, { count: accessBefore }] = await Promise.all([
        service.from('organisation_memberships').select('id,organisation_id,status').eq('user_id', generated.user.id),
        service.from('profiles').select('is_active').eq('id', generated.user.id).single(),
        service.from('user_workspace_access').select('*', { count: 'exact', head: true }).eq('user_id', generated.user.id),
      ]);
      expect(invitedMemberships).toHaveLength(1);
      expect(invitedMemberships![0].status).toBe('invited');
      expect(invitedProfile?.is_active).toBe(false);
      expect(accessBefore).toBe(0);
      const membershipId = invitedMemberships![0].id;

      await page.goto(generated.properties!.action_link);
      await expect(page).toHaveURL(new RegExp(`${new URL(env.baseUrl).hostname.replace(/\./g, '\\.')}\/accept-invite`));
      await expect(page.getByRole('heading', { name: 'Set up your LLND Automate account' })).toBeVisible();

      // Email confirmation alone must not activate access before password setup.
      const { data: confirmedMembership } = await service.from('organisation_memberships')
        .select('id,status').eq('user_id', generated.user.id).single();
      expect(confirmedMembership).toEqual({ id: membershipId, status: 'invited' });

      await page.getByLabel('Password', { exact: true }).fill(env.invitePassword);
      await page.getByLabel('Confirm password').fill(env.invitePassword);
      await page.getByRole('button', { name: 'Set up my account' }).click();
      await expect(page).toHaveURL(/#\/candidate-support\/dashboard$/);
      await expect(page.locator('header')).toContainText('Support Queue');

      const [{ data: activeMemberships }, { data: activeProfile }, { data: workspaceRows }, { data: acceptedGrant }] = await Promise.all([
        service.from('organisation_memberships').select('id,organisation_id,status').eq('user_id', generated.user.id),
        service.from('profiles').select('is_active').eq('id', generated.user.id).single(),
        service.from('user_workspace_access').select('workspace').eq('user_id', generated.user.id),
        service.from('staff_invitation_grants').select('status').eq('id', grantId).single(),
      ]);
      expect(activeMemberships).toEqual([{ id: membershipId, organisation_id: adminMembership!.organisation_id, status: 'active' }]);
      expect(activeProfile?.is_active).toBe(true);
      expect(workspaceRows?.map(row => row.workspace)).toEqual(['candidate_support']);
      expect(acceptedGrant?.status).toBe('accepted');

      const invitedClient = passwordClient();
      const { data: invitedSignIn, error: invitedSignInError } = await invitedClient.auth.signInWithPassword({
        email: env.inviteEmail,
        password: env.invitePassword,
      });
      expect(invitedSignInError).toBeNull();
      expect(invitedSignIn.session).toBeTruthy();
      await page.locator('header').getByTestId('workspace-switcher-trigger').click();
      await expect(page.getByTestId('workspace-switcher-menu').locator('[data-workspace]')).toHaveCount(1);
      await expect(page.getByTestId('workspace-switcher-menu').locator('[data-workspace="candidate_support"]')).toBeVisible();
    } finally {
      await removeDisposableInvitationFixture();
    }
  });
});
