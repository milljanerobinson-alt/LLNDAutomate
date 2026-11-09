import { describe, expect, it } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import {
  BILLING_RULES, HOME_DESCRIPTION, HOME_H1, PAID_PLAN_EXPLANATION, PLANS, PRIMARY_CTA, PRIMARY_OFFER, PRIMARY_OFFER_SUPPORT,
  PRODUCT_NAME, SECONDARY_CTA, SEO_DESCRIPTION, SEO_TITLE, SIGNUP_HASH, HOW_IT_WORKS_HASH, TIER_AUTOMATE, TIER_FREE, TIER_PLUS,
  llndDocumentTitle,
} from '../lib/brand';
import { FAQS } from '../lib/marketingContent';

const ROOT = path.resolve(__dirname, '..', '..');
const read = (rel: string) => fs.readFileSync(path.join(ROOT, rel), 'utf8');
const stripComments = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

const MARKETING_FILES = [
  'src/pages/marketing/HomePage.tsx',
  'src/pages/marketing/HowItWorksPage.tsx',
  'src/pages/marketing/FeaturesPage.tsx',
  'src/pages/marketing/AboutPage.tsx',
  'src/pages/marketing/ResourcesPage.tsx',
  'src/pages/marketing/ContactPage.tsx',
  'src/pages/PricingPage.tsx',
  'src/pages/SignUpPage.tsx',
  'src/pages/PlanStatusPage.tsx',
  'src/components/marketing/TopNav.tsx',
  'src/components/marketing/Footer.tsx',
  'src/components/marketing/BrandMark.tsx',
  'src/components/marketing/MarketingShell.tsx',
  'src/lib/brand.ts',
  'src/lib/marketingContent.ts',
];

// Customer-facing surfaces that must use the LLND Mate product family names only.
const CUSTOMER_FACING_FILES = [
  ...MARKETING_FILES,
  'index.html',
  'src/pages/LoginPage.tsx',
  'src/pages/AcceptInvitePage.tsx',
  'src/components/CustomerWorkspaceLayout.tsx',
  'src/components/AdminLayout.tsx',
  'src/pages/CompliancePage.tsx',
  'src/pages/ValidationPage.tsx',
  'src/pages/ResultsPage.tsx',
  'src/pages/SupportPlansPage.tsx',
  'src/pages/AxcelerateInboundPage.tsx',
  'supabase/functions/send-email/index.ts',
  'supabase/functions/process-email-queue/index.ts',
  'supabase/functions/on-assessment-complete/index.ts',
  'supabase/functions/send-admin-otp/index.ts',
  'supabase/functions/process-axcelerate-queue/index.ts',
  'supabase/functions/axcelerate-sync/index.ts',
  'supabase/functions/upload-axcelerate-portfolio/index.ts',
  'supabase/functions/axcelerate-inbound-sync/index.ts',
  'supabase/functions/_shared/result-validity.ts',
  'supabase/functions/_shared/enrolment-policy.ts',
];

// Surfaces where the product is named but tiers are not: "LLND Automate" must not appear here.
const NON_TIER_FILES = CUSTOMER_FACING_FILES.filter((f) => !MARKETING_FILES.includes(f));

describe('LLND Mate: approved brand and offer wording', () => {
  it('uses the approved name, headline, supporting message, offer and calls to action', () => {
    expect(PRODUCT_NAME).toBe('LLND Mate');
    expect(HOME_H1).toBe('FREE LLN & Digital Assessments for Australian RTOs');
    expect(HOME_DESCRIPTION).toBe('Smarter, shorter adaptive LLN assessments, practical digital skills checks, and clear learner support insights.');
    expect(PRIMARY_OFFER).toBe('Start free with 10 assessments every month.');
    expect(PRIMARY_OFFER_SUPPORT).toBe('Pay only when you need more.');
    expect(PRIMARY_CTA).toBe('Start Assessing for Free');
    expect(SECONDARY_CTA).toBe('See How It Works');
  });

  it('uses the official tier names', () => {
    expect([TIER_FREE, TIER_PLUS, TIER_AUTOMATE]).toEqual(['LLND Mate', 'LLND Mate Plus', 'LLND Automate']);
  });

  it('sets the SEO title, description and Open Graph metadata in index.html', () => {
    expect(SEO_TITLE).toBe('FREE LLN & Digital Assessments for RTOs | LLND Mate');
    expect(SEO_DESCRIPTION).toBe('Start free with 10 assessments every month. Adaptive LLN assessments, practical digital skills checks and clear learner support insights for Australian RTOs.');
    const html = read('index.html');
    const esc = (t: string) => t.replace(/&/g, '&amp;');
    expect(html).toContain(`<title>${esc(SEO_TITLE)}</title>`);
    expect(html).toContain(`<meta name="description" content="${esc(SEO_DESCRIPTION)}" />`);
    expect(html).toContain('<meta property="og:site_name" content="LLND Mate" />');
    expect(html).toContain(`<meta property="og:title" content="${esc(SEO_TITLE)}" />`);
    expect(html).toContain(`<meta property="og:description" content="${esc(SEO_DESCRIPTION)}" />`);
    expect(html).toContain('<meta name="application-name" content="LLND Mate" />');
    expect(html).toContain('<html lang="en-AU">');
    // The production domain is unconfirmed: no canonical or og:url yet.
    expect(html.replace(/<!--[\s\S]*?-->/g, '')).not.toMatch(/rel="canonical"|og:url/);
  });

  it('renders the headline as the single H1 and points the CTAs at existing routes', () => {
    const home = read('src/pages/marketing/HomePage.tsx');
    expect((home.match(/<h1\b/g) ?? []).length).toBe(1);
    expect(home).toMatch(/<h1[^>]*>\s*\{HOME_H1\}\s*<\/h1>/);
    expect(home).toContain('href={SIGNUP_HASH}');
    expect(home).toContain('href={HOW_IT_WORKS_HASH}');
    expect(SIGNUP_HASH).toBe('#/signup');
    expect(HOW_IT_WORKS_HASH).toBe('#/how-it-works');
  });

  it('gives each public page a title and keeps the product name elsewhere', () => {
    expect(llndDocumentTitle('root')).toBe(SEO_TITLE);
    expect(llndDocumentTitle('home')).toBe(SEO_TITLE);
    expect(llndDocumentTitle('pricing')).toBe('Pricing | LLND Mate');
    expect(llndDocumentTitle('llnd-login')).toBe('Sign in | LLND Mate');
    expect(llndDocumentTitle('administration')).toBe('LLND Mate');
    const app = read('src/App.tsx');
    expect(app).toContain("document.title = product === 'llnd' ? llndDocumentTitle(parseHash(hash).kind) : 'EIOS';");
    expect(app.indexOf('llndDocumentTitle(parseHash(hash)')).toBeGreaterThan(app.indexOf('const [hash, setHash]'));
  });

  it('shows the LLND Mate wordmark in the header and footer', () => {
    expect(read('src/components/marketing/BrandMark.tsx')).toMatch(/LLND <span[^>]*>Mate<\/span>/);
    expect(read('src/components/marketing/TopNav.tsx')).toContain('<BrandMark');
    expect(read('src/components/marketing/Footer.tsx')).toContain('<BrandMark');
  });
});

describe('LLND Mate: customer-facing naming', () => {
  const visibleText = (rel: string) => stripComments(read(rel))
    .replace(/#\/llnd-automate\/login/g, '')
    .replace(/'llnd-automate'/g, '');

  it.each(CUSTOMER_FACING_FILES)('%s has no retired or invalid product names', (rel) => {
    const visible = visibleText(rel);
    expect(visible).not.toMatch(/LLND\s*Assess|LLN\s*Automate|LLND\s*Mate\s*Automate/i);
    expect(visible).not.toMatch(/>\s*(Assess|Automate|Plus)\s*</);
  });

  it.each(NON_TIER_FILES)('%s does not use the LLND Automate tier name as the product name', (rel) => {
    expect(visibleText(rel)).not.toMatch(/LLND\s*Automate/i);
  });

  it('learner and staff emails and aXcelerate notes use LLND Mate', () => {
    expect(read('supabase/functions/send-email/index.ts')).toContain('Your LLND Mate assessment Invitation');
    expect(read('supabase/functions/process-email-queue/index.ts')).toContain('reminder_1: "Reminder: Complete Your LLND Mate assessment"');
    expect(read('supabase/functions/process-axcelerate-queue/index.ts')).toContain('"Source: LLND Mate"');
    expect(read('supabase/functions/upload-axcelerate-portfolio/index.ts')).toContain('This report was generated automatically by LLND Mate.');
    expect(read('supabase/functions/_shared/result-validity.ts')).toContain('"LLND Mate — LLND assessment status"');
    expect(read('src/pages/CompliancePage.tsx')).toContain('LLND Mate Assessment Compliance Report');
  });

  it('keeps the technical identifiers that other code and integrations depend on', () => {
    const app = read('src/App.tsx');
    expect(app).toContain("if (parts[0] === 'llnd-automate' && parts[1] === 'login') return { kind: 'llnd-login' };");
    expect(read('src/pages/LoginPage.tsx')).toContain("export type LoginContext = 'eios' | 'eios-oauth' | 'llnd-automate';");
    expect(read('supabase/functions/invite-rto-staff/origin-policy.ts')).toContain("previewParentHostname = 'llndautomate.pages.dev'");
    expect(read('src/lib/productContext.ts')).toContain("'llnd-automate'");
  });
});

describe('LLND Mate: accurate marketing content', () => {
  const marketing = MARKETING_FILES.map((f) => stripComments(read(f))).join('\n');
  const customer = CUSTOMER_FACING_FILES.map((f) => stripComments(read(f))).join('\n');

  it('contains no fabricated testimonials, comparisons, superseded prices or trial offers', () => {
    for (const banned of [
      /testimonial/i, /Sarah Mitchell|James Nguyen|Emma Thompson|Gold Coast Training Institute|Skills First Training|Pacific Training Institute/,
      /14[- ]day/i, /free trial/i, /\$79|\$129|\$1\.50/, /RTOs love/i, /switching to/i, /Most Popular/,
    ]) {
      expect(marketing).not.toMatch(banned);
    }
    expect(stripComments(read('src/pages/LoginPage.tsx'))).not.toMatch(/free trial/i);
  });

  it('makes no compliance guarantee, exclusivity or unlimited-usage claims', () => {
    for (const banned of [
      /ASQA[- ](compliant|approved|audit-ready)/i, /\b(guarantees|guaranteed|we guarantee)\b/i, /only adaptive/i,
      /\bunlimited\b/i, /annual (discount|plan|subscription)/i, /\bGST\b/, /AI[- ](generated|drafted)/i,
      /colleges|universit/i,
    ]) {
      expect(marketing).not.toMatch(banned);
    }
    expect(FAQS.some((f) => /cannot guarantee compliance|No tool can guarantee compliance/.test(f.a))).toBe(true);
  });

  it('never describes the Digital assessment as adaptive', () => {
    expect(HOME_H1).not.toMatch(/adaptive/i);
    expect(customer).not.toMatch(/adaptive\s+(LLN\s*)?(&|&amp;|and)\s*Digital/i);
    expect(customer).not.toMatch(/Adaptive LLN (&|and) Digital/i);
    const home = read('src/pages/marketing/HomePage.tsx');
    expect(home).toContain('A short, fixed set of practical questions');
    expect(FAQS.find((f) => f.q === 'Are the assessments adaptive?')?.a).toMatch(/The Digital assessment is a short, fixed set/);
    // The behaviour described matches the adaptive engine.
    const lln = read('src/pages/LLNAssessmentPage.tsx');
    expect(lln).toContain('const MAX_QUESTIONS_PER_SECTION = 8;');
    expect(lln).toContain("const SECTIONS: LLNSection[] = ['reading', 'numeracy', 'writing', 'oral_communication', 'learning'];");
    expect(lln).toMatch(/currentLevel: 3,/);
    expect(read('src/pages/DigitalAssessmentPage.tsx')).toContain(".order('order_index')");
  });

  it('only links to routes that exist', () => {
    const allowed = new Set([
      '#/', '#/home', '#/how-it-works', '#/features', '#/pricing', '#/resources', '#/about', '#/contact',
      '#/signup', '#/llnd-automate/login', '#/assessment/dashboard', '#main-content',
    ]);
    const hrefs = [...marketing.matchAll(/href="([^"]+)"/g)].map((m) => m[1]);
    const hashes = [...marketing.matchAll(/hash: '([^']+)'/g)].map((m) => m[1]);
    for (const h of [...hrefs, ...hashes]) expect(allowed.has(h), `unexpected link ${h}`).toBe(true);
    expect(marketing).not.toMatch(/mailto:|linkedin\.com|#\/privacy|#\/terms|llnd\.com\.au/);
    const app = read('src/App.tsx');
    for (const r of ['home', 'about', 'features', 'how-it-works', 'resources', 'contact', 'pricing', 'signup']) {
      expect(app).toContain(`if (parts[0] === '${r}')`);
    }
  });
});

describe('LLND Mate: plans and billing rules', () => {
  it('matches the approved plan structure with full tier names', () => {
    expect(PLANS.map((p) => [p.name, p.availability, p.monthlyFee, p.included, p.additional, p.manualWorkflow, p.integrationAutomation])).toEqual([
      ['LLND Mate', 'available', 'A$0 a month', '10 completed assessment assignments a month', 'Not available', 'Included', 'Not included'],
      ['LLND Mate Plus', 'coming_soon', 'A$15 a month', '20 completed assessment assignments a month', 'A$0.75 each', 'Included', 'Not included'],
      ['LLND Automate', 'coming_soon', 'A$35 a month', '20 completed assessment assignments a month', 'A$0.85 each', 'Included', 'Planned'],
    ]);
  });

  it('explains paid base fees and the additional completion rates', () => {
    expect(PAID_PLAN_EXPLANATION).toBe('The LLND Mate Plus and LLND Automate base fees each include 20 completed assessment assignments per month. Each additional completed assignment is charged at A$0.75 on LLND Mate Plus or A$0.85 on LLND Automate.');
    expect(read('src/pages/PricingPage.tsx')).toContain('{PAID_PLAN_EXPLANATION}');
  });

  it('states every approved billing rule', () => {
    const joined = BILLING_RULES.join(' ');
    expect(joined).toMatch(/An LLN and a Digital assessment completed by the same learner under the same assignment count as one completion/);
    expect(joined).toMatch(/Invitations, reminders and abandoned assessments do not count/);
    expect(joined).toMatch(/already in progress can finish after the LLND Mate monthly allowance is reached/);
    expect(joined).toMatch(/New assessment starts are restricted once the LLND Mate allowance/);
    expect(joined).toMatch(/LLND Mate Plus and LLND Automate have no fixed monthly assessment cap/);
    expect(joined).toMatch(/additional charges apply only to completed assignments above the 20 included each month/);
  });

  it('pricing page is static and paid plans cannot be selected or bought', () => {
    const pricing = read('src/pages/PricingPage.tsx');
    expect(pricing).not.toMatch(/supabase|subscription_plans|stripe/i);
    expect(pricing).toContain("plan.availability === 'available'");
    expect(pricing).toContain('Not yet available to purchase');
  });

  it('registration creates a free LLND Mate account without a paid plan or trial', () => {
    const signup = read('src/pages/SignUpPage.tsx');
    expect(signup).not.toMatch(/from\('subscriptions'\)|trial_ends_at|trialing|plan_id/);
    expect(signup).toContain('supabase.auth.signUp');
    expect(signup).toContain("supabase.rpc('set_organisation_setting', { p_key: 'org_rto_number', p_value: rtoNumber })");
    expect(signup).toContain('Create free account');
    expect(signup).toContain('{TIER_FREE} free plan');
  });

  it('signed-in Plan & usage page is display only and shows no legacy plans', () => {
    const page = read('src/pages/PlanStatusPage.tsx');
    expect(stripComments(page)).not.toMatch(/supabase|from\(|insert|update\(|stripe|subscription_plans/i);
    expect(stripComments(page)).not.toMatch(/\$79|\$129|trial|lln_only|digital_only|lln_digital/i);
    expect(page).toContain('Online plan management and usage counts are not available yet.');
    const app = read('src/App.tsx');
    expect(app).toContain("case 'billing':           return <PlanStatusPage />;");
    expect(app).not.toMatch(/<BillingPage\s*\/>/);
    // The legacy page and its database records are untouched.
    expect(fs.existsSync(path.join(ROOT, 'src/pages/BillingPage.tsx'))).toBe(true);
    expect(read('src/components/CustomerWorkspaceLayout.tsx')).toContain("label: 'Plan & usage'");
  });
});
