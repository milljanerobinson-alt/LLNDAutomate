import { expect, test } from 'playwright/test';

// LLND Mate invitation allowance UI, delete dialog, TEST label and platform-operator
// screens, rendered by the test harness with fixed example data (no backend).
// Server behaviour is covered by tests/db.
const H = '/tests/e2e/harness/plan-usage.html';
const shot = (name: string, project: string) => `test-results/screenshots/${name}-${project}.png`;

const CASES: { state: string; text: string; noFigures?: boolean }[] = [
  { state: 'normal', text: '6 of 10 invitations used' },
  { state: 'near', text: 'Your free allowance is nearly used.' },
  { state: 'exhausted', text: 'New invitations can’t be sent until 1 December 2026.' },
  { state: 'empty', text: 'No invitations sent yet this month.' },
  { state: 'error', text: 'We couldn’t load your plan and usage right now.', noFigures: true },
  { state: 'no_entitlement', text: 'Your organisation’s plan could not be confirmed.', noFigures: true },
  { state: 'inconsistent', text: 'Your usage figures need checking.', noFigures: true },
  { state: 'unauthorised', text: 'You don’t have access to plan and usage details.', noFigures: true },
  { state: 'loading', text: 'Loading your plan and usage', noFigures: true },
];

async function noHorizontalScroll(page: import('playwright/test').Page) {
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  expect(overflow).toBeLessThanOrEqual(1);
}

for (const c of CASES) {
  test(`Plan & usage: ${c.state}`, async ({ page }, info) => {
    await page.goto(`${H}?state=${c.state}`);
    await expect(page.getByRole('heading', { level: 1, name: 'Plan & usage' })).toBeVisible();
    await expect(page.locator('body')).toContainText(c.text);
    if (c.noFigures) await expect(page.locator('body')).not.toContainText(/of 10 invitations used|remaining|Active/);
    await expect(page.getByRole('button', { name: /upgrade|buy|purchase|subscribe/i })).toHaveCount(0);
    await noHorizontalScroll(page);
    await page.screenshot({ path: shot(`plan-usage-${c.state}`, info.project.name), fullPage: true });
  });
}

test('Plan & usage shows sent, returned by deletion and test invitations from the server', async ({ page }) => {
  await page.goto(`${H}?state=exhausted`);
  await expect(page.getByTestId('usage-used')).toHaveText('10 of 10 invitations used');
  await expect(page.getByTestId('usage-remaining')).toHaveText('0 invitations remaining');
  await expect(page.getByTestId('usage-reset')).toHaveText('Resets 1 December 2026');
  await expect(page.getByTestId('usage-sent')).toHaveText('15');
  await expect(page.getByTestId('usage-returned')).toHaveText('5');
  await expect(page.getByTestId('usage-tests')).toHaveText('4');
  await expect(page.locator('body')).toContainText('Invitations to “Test Test” are free and don’t count.');
  await expect(page.getByRole('progressbar', { name: 'Invitations used this month' })).toHaveAttribute('aria-valuenow', '10');
});

for (const s of ['near', 'exhausted']) {
  test(`staff notice: ${s}`, async ({ page }, info) => {
    await page.goto(`${H}?view=notice&state=${s}`);
    await expect(page.locator('body')).toContainText(s === 'near' ? 'resending doesn’t' : 'New invitations can’t be sent until 1 December 2026');
    await page.screenshot({ path: shot(`staff-notice-${s}`, info.project.name), fullPage: true });
  });
}

test('delete dialog: Delete stays disabled until exactly YES is typed', async ({ page }, info) => {
  await page.goto(`${H}?view=delete`);
  const dialog = page.getByRole('dialog', { name: 'Delete assessment?' });
  await expect(dialog).toContainText('This assessment will disappear from your dashboard. Its results and progress will no longer be accessible to your organisation.');
  await expect(dialog).toContainText('If you need this assessment restored later, a restoration fee will apply.');
  await expect(dialog).toContainText('To confirm deletion, type YES below.');
  const input = page.getByTestId('delete-confirmation-input');
  const del = dialog.getByRole('button', { name: 'Delete' });
  await expect(del).toBeDisabled();
  await input.press('Enter');
  for (const v of ['yes', 'Yes', 'YES ', ' YES', 'YE', 'NO']) {
    await input.fill(v);
    await expect(del, `"${v}" must not enable Delete`).toBeDisabled();
    await input.press('Enter');
  }
  await expect(page.getByTestId('delete-log')).toHaveText('');
  await page.screenshot({ path: shot('delete-dialog-empty', info.project.name), fullPage: true });
  await input.fill('YES');
  await expect(del).toBeEnabled();
  await page.screenshot({ path: shot('delete-dialog-yes', info.project.name), fullPage: true });
  await del.click();
  await expect(page.getByTestId('delete-log')).toHaveText('confirm:inv-1:YES');
});

test('delete dialog: reopening starts empty (no stale confirmation); Cancel deletes nothing', async ({ page }) => {
  await page.goto(`${H}?view=delete`);
  await page.getByTestId('delete-confirmation-input').fill('YES');
  await page.getByRole('button', { name: 'Cancel' }).click();
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await page.getByRole('button', { name: 'Open delete' }).click();
  await expect(page.getByTestId('delete-confirmation-input')).toHaveValue('');
  await expect(page.getByRole('dialog').getByRole('button', { name: 'Delete' })).toBeDisabled();
  await expect(page.getByTestId('delete-log')).toHaveText('cancel');
});

test('TEST label and locked test identity', async ({ page }, info) => {
  await page.goto(`${H}?view=test`);
  await expect(page.getByTestId('test-badge')).toHaveCount(1);
  await expect(page.getByTestId('test-badge')).toHaveText('TEST');
  await expect(page.getByLabel('Candidate Name')).toBeDisabled();
  await page.screenshot({ path: shot('test-test-label', info.project.name), fullPage: true });
});

test('platform: Invitations & Usage table, detail and deleted assessments', async ({ page }, info) => {
  await page.goto(`${H}?view=operator-usage`);
  const row = page.getByRole('row', { name: /Coastal Skills Institute/ });
  await expect(row).toContainText('10/10');
  await expect(row).toContainText('15');
  await expect(page.locator('body')).toContainText('Sent in month is gross');
  await page.screenshot({ path: shot('operator-usage', info.project.name), fullPage: true });
  await page.goto(`${H}?view=operator-detail`);
  await expect(page.locator('body')).toContainText('Allowance used this month');
  await page.screenshot({ path: shot('operator-usage-detail', info.project.name), fullPage: true });
  await page.goto(`${H}?view=operator-deleted`);
  await expect(page.getByRole('button', { name: 'Restore' })).toHaveCount(2);
  await expect(page.locator('body')).toContainText('Completed');
  await expect(page.locator('body')).not.toContainText(/answer|score|ACSF/i);
  await page.screenshot({ path: shot('operator-deleted', info.project.name), fullPage: true });
  await page.goto(`${H}?view=operator-usage&denied=1`);
  await expect(page.locator('body')).toContainText('Platform operator access required.');
});
