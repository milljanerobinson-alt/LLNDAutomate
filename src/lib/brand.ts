// LLND Mate — single source of truth for customer-facing brand, offer and
// plan wording. Technical identifiers (routes such as #/llnd-automate/login,
// the 'llnd-automate' login context, storage keys, database names, the
// llndautomate.pages.dev host) intentionally keep their original names; see
// docs/release-notes/llnd-assess-rebrand.md and
// docs/release-notes/llnd-mate-rebrand.md.
//
// Product family: LLND Mate is the umbrella brand AND the free tier;
// LLND Mate Plus is the paid tier without premium integration automation;
// LLND Automate is the premium automation tier. Never "LLND Mate Automate".

export const PRODUCT_NAME = 'LLND Mate';

/** Official tier names. */
export const TIER_FREE = 'LLND Mate';
export const TIER_PLUS = 'LLND Mate Plus';
export const TIER_AUTOMATE = 'LLND Automate';
export const PRODUCT_DESCRIPTOR = 'LLN & Digital assessments for Australian RTOs';

export const HOME_H1 = 'FREE LLN & Digital Assessments for Australian RTOs';
export const HOME_DESCRIPTION =
  'Smarter, shorter adaptive LLN assessments, practical digital skills checks, and clear learner support insights.';
export const PRIMARY_OFFER = 'Start free with 10 assessments every month.';
export const PRIMARY_OFFER_SUPPORT = 'Pay only when you need more.';
export const PRIMARY_CTA = 'Start Assessing for Free';
export const SECONDARY_CTA = 'See How It Works';

/** Existing self-service registration flow. */
export const SIGNUP_HASH = '#/signup';
/** Existing explanation page used by the secondary CTA. */
export const HOW_IT_WORKS_HASH = '#/how-it-works';
/** Existing canonical staff login route (technical identifier retained). */
export const STAFF_LOGIN_HASH = '#/llnd-automate/login';

export const SEO_TITLE = 'FREE LLN & Digital Assessments for RTOs | LLND Mate';
export const SEO_DESCRIPTION =
  'Start free with 10 assessments every month. Adaptive LLN assessments, practical digital skills checks and clear learner support insights for Australian RTOs.';

export const FREE_MONTHLY_COMPLETIONS = 10;

export type PlanAvailability = 'available' | 'coming_soon';

export interface PlanRow {
  id: 'free' | 'plus' | 'automate';
  name: string;
  /** Short description shown under the plan name. */
  summary: string;
  availability: PlanAvailability;
  monthlyFee: string;
  included: string;
  additional: string;
  manualWorkflow: string;
  integrationAutomation: string;
}

/**
 * Approved plan structure (Product Owner decision, 9 Nov 2026). These are
 * planning decisions, not evidence that billing exists: paid plans cannot be
 * bought and are shown as coming soon.
 */
export const PLANS: PlanRow[] = [
  {
    id: 'free', name: TIER_FREE, summary: 'Free for Australian RTOs', availability: 'available',
    monthlyFee: 'A$0 a month', included: '10 completed assessment assignments a month', additional: 'Not available',
    manualWorkflow: 'Included', integrationAutomation: 'Not included',
  },
  {
    id: 'plus', name: TIER_PLUS, summary: 'For RTOs that need more assessment volume', availability: 'coming_soon',
    monthlyFee: 'A$15 a month', included: '20 completed assessment assignments a month', additional: 'A$0.75 each',
    manualWorkflow: 'Included', integrationAutomation: 'Not included',
  },
  {
    id: 'automate', name: TIER_AUTOMATE, summary: 'For RTOs that want premium integration automation', availability: 'coming_soon',
    monthlyFee: 'A$35 a month', included: '20 completed assessment assignments a month', additional: 'A$0.85 each',
    manualWorkflow: 'Included', integrationAutomation: 'Planned',
  },
];

/** Plain explanation of how paid base fees and additional completions work. */
export const PAID_PLAN_EXPLANATION =
  `The ${TIER_PLUS} and ${TIER_AUTOMATE} base fees each include 20 completed assessment assignments per month. ` +
  `Each additional completed assignment is charged at A$0.75 on ${TIER_PLUS} or A$0.85 on ${TIER_AUTOMATE}.`;

/** Approved billing rules, worded for customers. */
export const BILLING_RULES: string[] = [
  'An LLN and a Digital assessment completed by the same learner under the same assignment count as one completion.',
  'Invitations, reminders and abandoned assessments do not count.',
  `Learners already in progress can finish after the ${TIER_FREE} monthly allowance is reached.`,
  `New assessment starts are restricted once the ${TIER_FREE} allowance for the month is reached.`,
  `${TIER_PLUS} and ${TIER_AUTOMATE} have no fixed monthly assessment cap.`,
  `On ${TIER_PLUS} and ${TIER_AUTOMATE}, additional charges apply only to completed assignments above the 20 included each month.`,
];

/** Page titles for the public website and product (browser tab, bookmarks, search results). */
export function llndDocumentTitle(routeKind: string): string {
  switch (routeKind) {
    case 'root':
    case 'home': return SEO_TITLE;
    case 'pricing': return `Pricing | ${PRODUCT_NAME}`;
    case 'how-it-works': return `How It Works | ${PRODUCT_NAME}`;
    case 'features': return `Features | ${PRODUCT_NAME}`;
    case 'about': return `About | ${PRODUCT_NAME}`;
    case 'resources': return `FAQ | ${PRODUCT_NAME}`;
    case 'contact': return `Contact | ${PRODUCT_NAME}`;
    case 'signup': return `Create a free account | ${PRODUCT_NAME}`;
    case 'llnd-login':
    case 'login':
    case 'forgot-password': return `Sign in | ${PRODUCT_NAME}`;
    default: return PRODUCT_NAME;
  }
}
