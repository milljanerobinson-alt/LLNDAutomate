import { expect, test } from 'playwright/test';

// Plan & usage UI states, rendered by the test harness with fixed example data
// (no backend). Server behaviour is covered by tests/db.
const H = '/tests/e2e/harness/plan-usage.html';

const CASES: { state: string; text: string; noFigures?: boolean }[] = [
  { state: 'normal', text: '6 of 10 assessments used' },
  { state: 'near', text: 'Your free allowance is nearly used.' },
  { state: 'exhausted', text: 'No new assessments can be started until 1 December 2026.' },
  { state: 'empty', text: 'No completed assessments yet this month.' },
  { state: 'error', text: 'We couldn’t load your plan and usage right now.', noFigures: true },
  { state: 'no_entitlement', text: 'Your organisation’s plan could not be confirmed.', noFigures: true },
  { state: 'inconsistent', text: 'Your usage figures need checking.', noFigures: true },
  { state: 'unauthorised', text: 'You don’t have access to plan and usage details.', noFigures: true },
  { state: 'loading', text: 'Loading your plan and usage', noFigures: true },
];

for (const c of CASES) {
  test(`Plan & usage: ${c.state}`, async ({ page }, info) => {
    await page.goto(`${H}?state=${c.state}`);
    await expect(page.getByRole('heading', { level: 1, name: 'Plan & usage' })).toBeVisible();
    await expect(page.locator('body')).toContainText(c.text);
    if (c.noFigures) await expect(page.locator('body')).not.toContainText(/of 10 assessments used|remaining|Active/);
    await expect(page.getByRole('button', { name: /upgrade|buy|purchase|subscribe/i })).toHaveCount(0);
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
    expect(overflow).toBeLessThanOrEqual(1);
    await page.screenshot({ path: `test-results/screenshots/plan-usage-${c.state}-${info.project.name}.png`, fullPage: true });
  });
}

test('progress bar reflects server figures', async ({ page }) => {
  await page.goto(`${H}?state=near`);
  const bar = page.getByRole('progressbar', { name: 'Completed assessments this month' });
  await expect(bar).toHaveAttribute('aria-valuenow', '8');
  await expect(bar).toHaveAttribute('aria-valuemax', '10');
  await expect(page.getByTestId('usage-remaining')).toHaveText('2 assessments remaining');
  await expect(page.getByTestId('usage-reset')).toHaveText('Resets 1 December 2026');
});

for (const s of ['near', 'exhausted']) {
  test(`staff notice on Candidates: ${s}`, async ({ page }, info) => {
    await page.goto(`${H}?view=notice&state=${s}`);
    await expect(page.locator('body')).toContainText(s === 'near' ? 'An invitation doesn’t reserve an assessment' : 'You can still send invitations');
    await page.screenshot({ path: `test-results/screenshots/staff-notice-${s}-${info.project.name}.png`, fullPage: true });
  });
}

test('learner cannot start: friendly message, no plan details', async ({ page }, info) => {
  await page.goto(`${H}?view=learner`);
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('This assessment can’t be started right now');
  await expect(page.locator('body')).not.toContainText(/allowance|plan|subscription|LLND Mate/i);
  await page.screenshot({ path: `test-results/screenshots/learner-start-unavailable-${info.project.name}.png`, fullPage: true });
});
