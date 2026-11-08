import { expect, test } from 'playwright/test';

// Public LLND Assess website checks. Run against a local preview build
// (BASE_URL=http://127.0.0.1:4173). These pages need no backend.

const H1 = 'FREE Adaptive LLN & Digital Assessments for Australian RTOs';
const PAGES = [
  { hash: '#/how-it-works', h1: 'How LLND Assess works', title: 'How It Works | LLND Assess' },
  { hash: '#/features', h1: 'What’s included in LLND Assess', title: 'Features | LLND Assess' },
  { hash: '#/pricing', h1: 'Start free. Pay only when you need more.', title: 'Pricing | LLND Assess' },
  { hash: '#/resources', h1: 'Frequently asked questions', title: 'FAQ | LLND Assess' },
  { hash: '#/about', h1: 'About LLND Assess', title: 'About | LLND Assess' },
  { hash: '#/contact', h1: 'Contact LLND Assess', title: 'Contact | LLND Assess' },
  { hash: '#/signup', h1: 'Create your free account', title: 'Create a free account | LLND Assess' },
];

function trackErrors(page: import('playwright/test').Page) {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
  return errors;
}

async function noHorizontalScroll(page: import('playwright/test').Page) {
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  expect(overflow, 'page should not scroll horizontally').toBeLessThanOrEqual(1);
}

test('homepage shows the approved brand, headline, offer and CTAs', async ({ page }, info) => {
  const errors = trackErrors(page);
  await page.goto('/');
  await expect(page).toHaveTitle('FREE LLN & Digital Assessments for RTOs | LLND Assess');
  await expect(page.getByRole('heading', { level: 1 })).toHaveText(H1);
  await expect(page.locator('main')).toContainText('Start free with 10 adaptive assessments every month.');
  await expect(page.locator('main')).toContainText('Pay only when you need more.');
  await expect(page.locator('body')).not.toContainText(/LLND Automate|free trial|14-day/i);
  const meta = await page.locator('meta[name="description"]').getAttribute('content');
  expect(meta).toBe('Start free with 10 adaptive LLN & Digital assessments every month. Track learner progress, identify support needs and download assessment reports.');

  const primary = page.locator('main').getByRole('link', { name: 'Start Assessing for Free' }).first();
  const secondary = page.locator('main').getByRole('link', { name: 'See How It Works' }).first();
  await expect(primary).toHaveAttribute('href', '#/signup');
  await expect(secondary).toHaveAttribute('href', '#/how-it-works');
  await noHorizontalScroll(page);
  await page.screenshot({ path: `test-results/screenshots/home-${info.project.name}-fold.png` });
  await page.screenshot({ path: `test-results/screenshots/home-${info.project.name}-full.png`, fullPage: true });

  await secondary.click();
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('How LLND Assess works');
  await page.goto('/');
  await page.locator('main').getByRole('link', { name: 'Start Assessing for Free' }).first().click();
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('Create your free account');
  expect(errors).toEqual([]);
});

for (const p of PAGES) {
  test(`public page ${p.hash} renders with its title and one H1`, async ({ page }, info) => {
    const errors = trackErrors(page);
    await page.goto(`/${p.hash}`);
    await expect(page.getByRole('heading', { level: 1 })).toHaveText(p.h1);
    await expect(page).toHaveTitle(p.title);
    expect(await page.locator('h1').count()).toBe(1);
    await expect(page.locator('body')).not.toContainText(/LLND Automate|free trial|14-day|\$79|\$129/i);
    await noHorizontalScroll(page);
    await page.screenshot({ path: `test-results/screenshots/${p.hash.replace('#/', '')}-${info.project.name}.png`, fullPage: true });
    expect(errors).toEqual([]);
  });
}

test('every navigation and footer link on the homepage opens a real page', async ({ page }) => {
  await page.goto('/');
  const hrefs = await page.locator('header a[href^="#/"], footer a[href^="#/"]').evaluateAll((els) =>
    [...new Set(els.map((e) => e.getAttribute('href') as string))]);
  expect(hrefs.length).toBeGreaterThan(5);
  for (const href of hrefs) {
    await page.goto(`/${href}`);
    await expect(page.getByRole('heading', { level: 1 }), `${href} should have a heading`).toBeVisible();
  }
});

test('pricing shows Free as available and paid plans as coming soon', async ({ page }) => {
  await page.goto('/#/pricing');
  const table = page.getByRole('table');
  await expect(table).toContainText('A$0');
  await expect(table).toContainText('A$15 a month');
  await expect(table).toContainText('A$35 a month');
  await expect(table).toContainText('A$0.75 each');
  await expect(table).toContainText('A$0.85 each');
  await expect(page.getByText('Coming soon').first()).toBeVisible();
  await expect(page.getByText('Available now')).toBeVisible();
  await expect(page.locator('main')).not.toContainText(/unlimited/i);
});

test('staff sign-in still loads from the website', async ({ page }) => {
  await page.goto('/');
  const signIn = page.getByRole('link', { name: 'Sign In', exact: true });
  if (await signIn.isVisible()) {
    await signIn.click();
  } else {
    await page.getByRole('button', { name: 'Open menu' }).click();
    await page.getByRole('link', { name: 'Sign In', exact: true }).click();
  }
  await expect(page).toHaveURL(/#\/llnd-automate\/login/);
  await expect(page.locator('body')).toContainText('LLND Assess');
  await expect(page).toHaveTitle('Sign in | LLND Assess');
});
