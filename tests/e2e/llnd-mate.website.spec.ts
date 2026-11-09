import { expect, test } from 'playwright/test';

// Public LLND Mate website checks. Run against a local preview build
// (BASE_URL=http://127.0.0.1:4173). These pages need no backend.

const H1 = 'FREE LLN & Digital Assessments for Australian RTOs';
const RETIRED = /LLND Assess|LLND Mate Automate|free trial|14-day|\$79|\$129/i;
const PAGES = [
  { hash: '#/how-it-works', h1: 'How LLND Mate works', title: 'How It Works | LLND Mate' },
  { hash: '#/features', h1: 'What’s included in LLND Mate', title: 'Features | LLND Mate' },
  { hash: '#/pricing', h1: 'Start free. Pay only when you need more.', title: 'Pricing | LLND Mate' },
  { hash: '#/resources', h1: 'Frequently asked questions', title: 'FAQ | LLND Mate' },
  { hash: '#/about', h1: 'About LLND Mate', title: 'About | LLND Mate' },
  { hash: '#/contact', h1: 'Contact LLND Mate', title: 'Contact | LLND Mate' },
  { hash: '#/signup', h1: 'Create your free account', title: 'Create a free account | LLND Mate' },
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
  await expect(page).toHaveTitle('FREE LLN & Digital Assessments for RTOs | LLND Mate');
  await expect(page.locator('header')).toContainText('LLND Mate');
  await expect(page.locator('footer')).toContainText('LLND Mate');
  await expect(page.locator('main')).toContainText('Smarter, shorter adaptive LLN assessments, practical digital skills checks, and clear learner support insights.');
  await expect(page.getByRole('heading', { level: 1 })).toHaveText(H1);
  await expect(page.locator('main')).toContainText('Start free with 10 assessments every month.');
  await expect(page.locator('main')).toContainText('Pay only when you need more.');
  await expect(page.locator('body')).not.toContainText(RETIRED);
  const meta = await page.locator('meta[name="description"]').getAttribute('content');
  expect(meta).toBe('Start free with 10 assessments every month. Adaptive LLN assessments, practical digital skills checks and clear learner support insights for Australian RTOs.');
  expect(await page.locator('meta[property="og:site_name"]').getAttribute('content')).toBe('LLND Mate');

  const primary = page.locator('main').getByRole('link', { name: 'Start Assessing for Free' }).first();
  const secondary = page.locator('main').getByRole('link', { name: 'See How It Works' }).first();
  await expect(primary).toHaveAttribute('href', '#/signup');
  await expect(secondary).toHaveAttribute('href', '#/how-it-works');
  await noHorizontalScroll(page);
  await page.screenshot({ path: `test-results/screenshots/home-${info.project.name}-fold.png` });
  await page.screenshot({ path: `test-results/screenshots/home-${info.project.name}-full.png`, fullPage: true });

  await secondary.click();
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('How LLND Mate works');
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
    await expect(page.locator('body')).not.toContainText(RETIRED);
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

test('pricing shows LLND Mate as available and LLND Mate Plus and LLND Automate as coming soon', async ({ page }) => {
  await page.goto('/#/pricing');
  for (const name of ['LLND Mate', 'LLND Mate Plus', 'LLND Automate']) {
    await expect(page.getByRole('heading', { level: 2, name, exact: true })).toBeVisible();
  }
  const table = page.getByRole('table');
  await expect(table).toContainText('LLND Mate Plus');
  await expect(table).toContainText('LLND Automate');
  await expect(table).toContainText('A$0 a month');
  await expect(table).toContainText('A$15 a month');
  await expect(table).toContainText('A$35 a month');
  await expect(table).toContainText('A$0.75 each');
  await expect(table).toContainText('A$0.85 each');
  await expect(page.getByText('Coming soon').first()).toBeVisible();
  await expect(page.getByText('Available now')).toBeVisible();
  await expect(page.locator('main')).toContainText('base fees each include 20 completed assessment assignments per month');
  await expect(page.locator('main')).toContainText('same assignment count as one completion');
  await expect(page.getByText('Not yet available to purchase', { exact: true })).toHaveCount(2);
  await expect(page.locator('main')).not.toContainText(/unlimited/i);
});

test('staff sign-in still loads from the website', async ({ page }, info) => {
  await page.goto('/');
  const signIn = page.getByRole('link', { name: 'Sign In', exact: true });
  if (await signIn.isVisible()) {
    await signIn.click();
  } else {
    await page.getByRole('button', { name: 'Open menu' }).click();
    await page.getByRole('link', { name: 'Sign In', exact: true }).click();
  }
  await expect(page).toHaveURL(/#\/llnd-automate\/login/);
  await expect(page.locator('body')).toContainText('LLND Mate');
  await expect(page.locator('body')).not.toContainText(RETIRED);
  await expect(page).toHaveTitle('Sign in | LLND Mate');
  await page.screenshot({ path: `test-results/screenshots/login-${info.project.name}.png`, fullPage: true });
});
