import { describe, expect, it } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import {
  BILLING_RULES, HOME_DESCRIPTION, HOME_H1, PLANS, PRIMARY_CTA, PRIMARY_OFFER, PRIMARY_OFFER_SUPPORT,
  PRODUCT_NAME, SECONDARY_CTA, SEO_DESCRIPTION, SEO_TITLE, SIGNUP_HASH, HOW_IT_WORKS_HASH, llndDocumentTitle,
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
  'src/components/marketing/TopNav.tsx',
  'src/components/marketing/Footer.tsx',
  'src/components/marketing/BrandMark.tsx',
  'src/components/marketing/MarketingShell.tsx',
  'src/lib/brand.ts',
  'src/lib/marketingContent.ts',
];

// Customer-facing surfaces that must show the new name only.
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

describe('LLND Assess: approved brand and offer wording', () => {
  it('uses the approved name, headline, description, offer and calls to action', () => {
    expect(PRODUCT_NAME).toBe('LLND Assess');
    expect(HOME_H1).toBe('FREE Adaptive LLN & Digital Assessments for Australian RTOs');
    expect(HOME_DESCRIPTION).toBe('Assess learner readiness, identify support needs and track progress with smarter, shorter adaptive assessments.');
    expect(PRIMARY_OFFER).toBe('Start free with 10 adaptive assessments every month.');
    expect(PRIMARY_OFFER_SUPPORT).toBe('Pay only when you need more.');
    expect(PRIMARY_CTA).toBe('Start Assessing for Free');
    expect(SECONDARY_CTA).toBe('See How It Works');
  });

  it('sets the approved SEO title and meta description in index.html', () => {
    expect(SEO_TITLE).toBe('FREE LLN & Digital Assessments for RTOs | LLND Assess');
    expect(SEO_DESCRIPTION).toBe('Start free with 10 adaptive LLN & Digital assessments every month. Track learner progress, identify support needs and download assessment reports.');
    const html = read('index.html');
    expect(html).toContain('<title>FREE LLN &amp; Digital Assessments for RTOs | LLND Assess</title>');
    expect(html).toContain(`<meta name="description" content="${SEO_DESCRIPTION.replace(/&/g, '&amp;')}" />`);
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
    expect(llndDocumentTitle('pricing')).toBe('Pricing | LLND Assess');
    expect(llndDocumentTitle('llnd-login')).toBe('Sign in | LLND Assess');
    expect(llndDocumentTitle('administration')).toBe('LLND Assess');
    const app = read('src/App.tsx');
    expect(app).toContain("document.title = product === 'llnd' ? llndDocumentTitle(parseHash(hash).kind) : 'EIOS';");
    // The title effect must run after the hash state exists.
    expect(app.indexOf('llndDocumentTitle(parseHash(hash)')).toBeGreaterThan(app.indexOf('const [hash, setHash]'));
  });
});

describe('LLND Assess: customer-facing naming', () => {
  it.each(CUSTOMER_FACING_FILES)('%s has no superseded product names in visible text', (rel) => {
    const visible = stripComments(read(rel))
      .replace(/#\/llnd-automate\/login/g, '')
      .replace(/'llnd-automate'/g, '')
      // One deliberate transition notice on the About page.
      .replace('LLND Assess was previously known as LLND Automate.', '');
    expect(visible).not.toMatch(/LLND\s*Automate|LLN\s*Automate|LLND\s*Mate/i);
    expect(visible).not.toMatch(/>\s*Automate\s*</);
  });

  it('keeps the technical identifiers that other code and integrations depend on', () => {
    const app = read('src/App.tsx');
    expect(app).toContain("if (parts[0] === 'llnd-automate' && parts[1] === 'login') return { kind: 'llnd-login' };");
    expect(read('src/pages/LoginPage.tsx')).toContain("export type LoginContext = 'eios' | 'eios-oauth' | 'llnd-automate';");
    expect(read('supabase/functions/invite-rto-staff/origin-policy.ts')).toContain("previewParentHostname = 'llndautomate.pages.dev'");
    expect(read('src/lib/productContext.ts')).toContain("'llnd-automate'");
  });
});

describe('LLND Assess: accurate marketing content', () => {
  const marketing = MARKETING_FILES.map((f) => stripComments(read(f))).join('\n');

  it('contains no fabricated testimonials, comparisons, superseded prices or trial offers', () => {
    for (const banned of [
      /testimonial/i, /Sarah Mitchell|James Nguyen|Emma Thompson|Gold Coast Training Institute|Skills First Training|Pacific Training Institute/,
      /14[- ]day/i, /free trial/i, /\$79|\$129|\$1\.50/, /RTOs love/i, /switching to/i, /Most Popular/,
    ]) {
      expect(marketing).not.toMatch(banned);
    }
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

  it('describes only the LLN assessment as adaptive and the Digital assessment as fixed', () => {
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

describe('LLND Assess: plans and billing rules', () => {
  it('matches the approved plan structure', () => {
    expect(PLANS.map((p) => [p.name, p.availability, p.monthlyFee, p.included, p.additional, p.manualWorkflow, p.integrationAutomation])).toEqual([
      ['Free', 'available', 'A$0', '10 completed assessments a month', 'Not available', 'Included', 'Not included'],
      ['Plus', 'coming_soon', 'A$15 a month', '20 completed assessments a month', 'A$0.75 each', 'Included', 'Not included'],
      ['Automate', 'coming_soon', 'A$35 a month', '20 completed assessments a month', 'A$0.85 each', 'Included', 'Planned'],
    ]);
  });

  it('states every approved billing rule', () => {
    const joined = BILLING_RULES.join(' ');
    expect(joined).toMatch(/both LLN and Digital under the same assignment counts as one completed assessment/);
    expect(joined).toMatch(/Invitations, reminders and abandoned assessments do not count/);
    expect(joined).toMatch(/already in progress can finish after the Free allowance is reached/);
    expect(joined).toMatch(/New assessment starts are restricted once the Free allowance/);
    expect(joined).toMatch(/Paid plans have no fixed monthly assessment cap/);
    expect(joined).toMatch(/completed assignments above the included monthly allowance/);
  });

  it('pricing page is static and paid plans cannot be selected or bought', () => {
    const pricing = read('src/pages/PricingPage.tsx');
    expect(pricing).not.toMatch(/supabase|subscription_plans|stripe/i);
    expect(pricing).toContain("plan.availability === 'available'");
    expect(pricing).toContain('Not yet available');
  });

  it('registration creates a free account without a paid plan or trial', () => {
    const signup = read('src/pages/SignUpPage.tsx');
    expect(signup).not.toMatch(/from\('subscriptions'\)|trial_ends_at|trialing|plan_id/);
    expect(signup).toContain('supabase.auth.signUp');
    expect(signup).toContain("supabase.rpc('set_organisation_setting', { p_key: 'org_rto_number', p_value: rtoNumber })");
    expect(signup).toContain('Create free account');
  });
});
