import { expect, test } from 'playwright/test';

// LLND Mate invitation allowance UI, delete dialog, TEST label and platform-operator
// screens, rendered by the test harness with fixed example data (no backend).
// Server behaviour is covered by tests/db.
const H = '/tests/e2e/harness/plan-usage.html';
const shot = (name: string, project: string) => `test-results/screenshots/${name}-${project}.png`;

const CASES: { state: string; text: string; noFigures?: boolean }[] = [
  { state: 'normal', text: '6 of 10 invitations used' },
  { state: 'near', text: 'Your free allowance is nearly used.' },
  { state: 'exhausted', text: 'You’ve used all 10 free invitations this month.' },
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
    await expect(page.locator('body')).toContainText(s === 'near' ? 'resending doesn’t' : 'Your allowance resets on 1 December 2026');
    await expect(page.getByTestId('upgrade-options')).toHaveCount(s === 'exhausted' ? 1 : 0);
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

test('upgrade button: shown only at 10/10, in the red warning, linking to the existing pricing page', async ({ page }, info) => {
  for (const s of ['empty', 'normal', 'near']) {
    await page.goto(`${H}?state=${s}`);
    await expect(page.getByTestId('upgrade-options'), s).toHaveCount(0);
  }
  await page.goto(`${H}?state=exhausted`);
  const warning = page.getByRole('alert').filter({ hasText: 'You’ve used all 10 free invitations this month.' });
  const button = warning.getByRole('link', { name: 'Explore upgrade options' });
  await expect(button).toBeVisible();
  await expect(button).toHaveAttribute('href', '#/pricing');
  for (const t of ['Learners you have already invited can still complete their assessments.', 'Your allowance resets on 1 December 2026.',
    'Deleting an assessment sent this month returns its invitation to your allowance.',
    'Upgrading to a paid plan will allow additional assessments once paid plans become available.']) await expect(warning).toContainText(t);
  await page.screenshot({ path: shot('upgrade-plan-usage', info.project.name), fullPage: true });
  await page.goto(`${H}?view=notice&state=exhausted`);
  await expect(page.getByRole('link', { name: 'Explore upgrade options' })).toHaveAttribute('href', '#/pricing');
  await page.screenshot({ path: shot('upgrade-candidates-notice', info.project.name), fullPage: true });
});

test('upgrade destination: existing pricing page shows accurate paid plans as Coming soon with no checkout', async ({ page }, info) => {
  await page.goto('/#/pricing');
  const table = page.getByRole('table');
  for (const t of ['LLND Mate Plus', 'LLND Automate', 'A$15 a month', 'A$35 a month', 'A$0.75 each', 'A$0.85 each', '20 completed assessment assignments a month']) await expect(table).toContainText(t);
  await expect(page.getByText('Not yet available to purchase', { exact: true })).toHaveCount(2);
  await expect(page.getByRole('button', { name: /buy|checkout|subscribe|purchase|upgrade now/i })).toHaveCount(0);
  await expect(page.getByRole('link', { name: /buy|checkout|subscribe|purchase/i })).toHaveCount(0);
  await page.screenshot({ path: shot('upgrade-destination-pricing', info.project.name), fullPage: true });
});

test('Create Test Candidate: generated read-only name, email validation, single submission', async ({ page }, info) => {
  await page.goto(`${H}?view=create-test`);
  const dialog = page.getByRole('dialog', { name: 'Create Test Candidate' });
  await expect(dialog).toContainText('Their assessments are free and don’t count towards your monthly allowance');
  await expect(page.getByTestId('test-candidate-name')).toHaveText('Test Test2TEST');
  await expect(dialog.getByRole('textbox', { name: /candidate name/i })).toHaveCount(0);
  await page.screenshot({ path: shot('create-test-candidate', info.project.name), fullPage: true });
  const submit = dialog.getByRole('button', { name: 'Create Test Candidate' });
  await submit.click();
  await expect(dialog).toContainText('Enter a valid email address.');
  await dialog.getByLabel('Email address').fill('not-an-email');
  await expect(submit).toBeDisabled();
  await dialog.getByLabel('Email address').fill('trainer@coastal.example');
  await page.screenshot({ path: shot('create-test-candidate-filled', info.project.name), fullPage: true });
  await submit.dblclick();
  await expect(page.getByTestId('created')).toHaveText('created');
  await expect(page.getByTestId('create-calls')).toHaveText('trainer@coastal.example');
});

test('Candidates list: new Test Candidate is easy to find and sends through the normal form', async ({ page }, info) => {
  await page.goto(`${H}?view=candidates`);
  await expect(page.getByRole('button', { name: 'Create Test Candidate' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'New Invitation' })).toBeVisible();
  const row = page.getByTestId('pending-test-candidate');
  await expect(row).toContainText('Test Test3TEST');
  await expect(row).toContainText('No assessment sent yet');
  await expect(page.getByTestId('test-badge')).toHaveCount(3);
  await page.screenshot({ path: shot('candidates-test-candidates', info.project.name), fullPage: true });
  await row.getByRole('button', { name: 'Send assessment' }).click();
  await expect(page.getByTestId('send-target')).toHaveText('Test Test3');
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  expect(overflow).toBeLessThanOrEqual(1);
});
