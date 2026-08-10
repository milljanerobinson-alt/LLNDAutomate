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
    if (response.url().includes('/invite-rto-staff') && response.status() >= 400) {
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

test.describe.serial('Issue #40 authenticated staging gate', () => {
  test('dedicated Administration identity establishes an authenticated session', async ({ page, runtimeEvidence: _runtime }) => {
    const user = await authenticatePage(page, env.adminEmail, env.adminPassword);
    await page.goto('/#/rto-admin/dashboard');
    await expect(page).toHaveURL(/#\/rto-admin\/dashboard$/);
    await expect(page.getByTestId('workspace-switcher-trigger')).toBeVisible();
    expect(user.email?.toLowerCase()).toBe(env.adminEmail);
  });

  test('top-right switcher contains only the ordered assigned staff workspaces and navigates', async ({ page, runtimeEvidence: _runtime }) => {
    await authenticatePage(page, env.adminEmail, env.adminPassword);
    await page.goto('/#/rto-admin/dashboard');
    const trigger = page.locator('header').getByTestId('workspace-switcher-trigger');
    await trigger.click();
    const menu = page.getByTestId('workspace-switcher-menu');
    await expect(menu).toBeVisible();
    await expect(menu.locator('[data-workspace]')).toHaveCount(3);
    expect(await menu.locator('[data-workspace]').evaluateAll(elements =>
      elements.map(element => element.getAttribute('data-workspace')),
    )).toEqual(['administration', 'candidate_support', 'technical']);
    await expect(menu).not.toContainText('Candidate Assessment');

    await menu.locator('[data-workspace="candidate_support"]').click();
    await expect(page).toHaveURL(/#\/candidate-support\/dashboard$/);
    await expect(page.locator('header')).toContainText('Support Queue');

    await page.locator('header').getByTestId('workspace-switcher-trigger').click();
    await page.getByTestId('workspace-switcher-menu').locator('[data-workspace="technical"]').click();
    await expect(page).toHaveURL(/#\/technical\/dashboard$/);
    await expect(page.locator('header')).toContainText('System Health');

    await page.locator('header').getByTestId('workspace-switcher-trigger').click();
    await page.getByTestId('workspace-switcher-menu').locator('[data-workspace="administration"]').click();
    await expect(page).toHaveURL(/#\/rto-admin\/dashboard$/);
  });

  test('permission-limited identity is redirected away from a direct unauthorized workspace URL', async ({ page, runtimeEvidence: _runtime }) => {
    await authenticatePage(page, env.candidateSupportEmail, env.candidateSupportPassword);
    await page.goto('/#/technical/dashboard');
    await expect(page).toHaveURL(/#\/candidate-support\/dashboard$/);
    await expect(page.locator('header')).toContainText('Support Queue');
    await page.locator('header').getByTestId('workspace-switcher-trigger').click();
    await expect(page.getByTestId('workspace-switcher-menu').locator('[data-workspace]')).toHaveCount(1);
    await expect(page.getByTestId('workspace-switcher-menu').locator('[data-workspace="candidate_support"]')).toBeVisible();

    await page.goto('/#/rto-admin/dashboard');
    await expect(page).toHaveURL(/#\/candidate-support\/dashboard$/);
  });

  test('Technical-only identity cannot enter Administration or Candidate Support', async ({ page, runtimeEvidence: _runtime }) => {
    await authenticatePage(page, env.technicalEmail, env.technicalPassword);
    await page.goto('/#/technical/dashboard');
    await expect(page).toHaveURL(/#\/technical\/dashboard$/);
    await page.locator('header').getByTestId('workspace-switcher-trigger').click();
    const menu = page.getByTestId('workspace-switcher-menu');
    await expect(menu.locator('[data-workspace]')).toHaveCount(1);
    await expect(menu.locator('[data-workspace="technical"]')).toBeVisible();

    await page.goto('/#/rto-admin/dashboard');
    await expect(page).toHaveURL(/#\/technical\/dashboard$/);
    await page.goto('/#/candidate-support/dashboard');
    await expect(page).toHaveURL(/#\/technical\/dashboard$/);
  });

  test('Administration Users page loads', async ({ page, runtimeEvidence: _runtime }) => {
    await authenticatePage(page, env.adminEmail, env.adminPassword);
    await page.goto('/#/rto-admin/users');
    await expect(page.getByRole('heading', { name: 'Users', exact: true })).toBeVisible();
    await expect(page.getByRole('heading', { name: 'Invite staff user' })).toBeVisible();
  });

  test('preview preflight, invitation POST and invited-to-active lifecycle succeed safely', async ({ page, runtimeEvidence: _runtime }) => {
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
      const membershipId = memberships![0].id;
      expect(profile?.is_active).toBe(false);
      expect(accessBefore).toBe(0);

      const { error: retryError } = await service.rpc('reconcile_staff_invitation', { p_grant_id: grant!.id });
      expect(retryError).toBeNull();
      const { data: retryMemberships } = await service.from('organisation_memberships').select('id,status').eq('user_id', userId);
      expect(retryMemberships).toEqual([{ id: membershipId, status: 'invited' }]);

      const { error: acceptanceError } = await service.auth.admin.updateUserById(userId, {
        email_confirm: true,
        password: env.invitePassword,
      });
      expect(acceptanceError).toBeNull();

      await expect.poll(async () => {
        const { data } = await service.from('organisation_memberships').select('status').eq('user_id', userId).single();
        return data?.status;
      }).toBe('active');
      const [{ data: activeMemberships }, { data: activeProfile }, { data: workspaceRows }, { data: acceptedGrant }] = await Promise.all([
        service.from('organisation_memberships').select('id,organisation_id,status').eq('user_id', userId),
        service.from('profiles').select('is_active').eq('id', userId).single(),
        service.from('user_workspace_access').select('workspace').eq('user_id', userId),
        service.from('staff_invitation_grants').select('status').eq('id', grant!.id).single(),
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

      await page.reload();
      const activeRow = page.locator('[data-testid="organisation-staff-row"]', { hasText: env.inviteEmail });
      await expect(activeRow.getByTestId('staff-status')).toHaveText('active');
      await authenticatePage(page, env.inviteEmail, env.invitePassword);
      await page.goto('/#/candidate-support/dashboard');
      await page.locator('header').getByTestId('workspace-switcher-trigger').click();
      await expect(page.getByTestId('workspace-switcher-menu').locator('[data-workspace]')).toHaveCount(1);
      await expect(page.getByTestId('workspace-switcher-menu').locator('[data-workspace="candidate_support"]')).toBeVisible();
    } finally {
      await removeDisposableInvitationFixture();
    }
  });
});
