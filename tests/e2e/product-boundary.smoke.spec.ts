import { expect, test as base, type Page } from 'playwright/test';

type RuntimeEvidence = {
  consoleErrors: string[];
  pageErrors: string[];
  criticalRequestFailures: string[];
};

const criticalResourceTypes = new Set(['document', 'script', 'stylesheet']);

function observeRuntime(page: Page): RuntimeEvidence {
  const evidence: RuntimeEvidence = {
    consoleErrors: [],
    pageErrors: [],
    criticalRequestFailures: [],
  };

  page.on('console', (message) => {
    if (message.type() === 'error') evidence.consoleErrors.push(message.text());
  });
  page.on('pageerror', (error) => evidence.pageErrors.push(error.message));
  page.on('requestfailed', (request) => {
    if (criticalResourceTypes.has(request.resourceType())) {
      evidence.criticalRequestFailures.push(
        `${request.resourceType()}: ${request.failure()?.errorText ?? 'request failed'}`,
      );
    }
  });
  page.on('response', (response) => {
    const request = response.request();
    if (criticalResourceTypes.has(request.resourceType()) && response.status() >= 400) {
      evidence.criticalRequestFailures.push(
        `${request.resourceType()}: HTTP ${response.status()} ${new URL(response.url()).pathname}`,
      );
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
    expect(evidence.criticalRequestFailures, 'critical request failures').toEqual([]);
  },
});

test.describe('LLND Automate staging smoke', () => {
  test('LLND root loads with the expected product context', async ({ page, runtimeEvidence: _runtime }) => {
    const response = await page.goto('/');

    expect(response?.ok()).toBe(true);
    await expect(page).toHaveTitle('LLND Automate');
    await expect(page.locator('body')).toContainText('LLND Automate');
  });

  test('EIOS remains isolated under /eios', async ({ page, runtimeEvidence: _runtime }) => {
    const response = await page.goto('/eios');

    expect(response?.ok()).toBe(true);
    await expect(page).toHaveTitle('EIOS');
    await expect(page.locator('body')).toContainText('EIOS');
  });

  test('LLND login loads and Back to website returns to root', async ({ page, runtimeEvidence: _runtime }) => {
    await page.goto('/#/llnd-automate/login');

    const backToWebsite = page.getByText('Back to website', { exact: true }).first();
    await expect(backToWebsite).toBeVisible();
    await backToWebsite.click();
    await expect(page).toHaveURL((url) => url.origin === new URL(test.info().project.use.baseURL as string).origin && url.pathname === '/' && !url.hash);
    await expect(page).toHaveTitle('LLND Automate');
  });

  test('legacy /llnd route migrates safely to LLND root', async ({ page, runtimeEvidence: _runtime }) => {
    const response = await page.goto('/llnd');

    expect(response?.ok()).toBe(true);
    await expect(page).toHaveURL((url) => url.pathname === '/');
    await expect(page).toHaveTitle('LLND Automate');
  });

  test('legacy /lln route migrates safely to LLND root', async ({ page, runtimeEvidence: _runtime }) => {
    const response = await page.goto('/lln');

    expect(response?.ok()).toBe(true);
    await expect(page).toHaveURL((url) => url.pathname === '/');
    await expect(page).toHaveTitle('LLND Automate');
  });

  test('direct nested SPA navigation avoids a server 404', async ({ page, runtimeEvidence: _runtime }) => {
    const response = await page.goto('/#/assessment/dashboard');

    expect(response?.ok()).toBe(true);
    await expect(page.locator('body')).not.toContainText('404');
    await expect(page).toHaveURL(/#\/llnd-automate\/login$/);
  });
});
