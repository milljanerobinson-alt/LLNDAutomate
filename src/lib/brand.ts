// LLND Assess — single source of truth for customer-facing brand, offer and
// plan wording. Technical identifiers (routes such as #/llnd-automate/login,
// the 'llnd-automate' login context, storage keys, database names, the
// llndautomate.pages.dev host) intentionally keep their original names; see
// docs/release-notes/llnd-assess-rebrand.md.

export const PRODUCT_NAME = 'LLND Assess';
export const PRODUCT_DESCRIPTOR = 'LLN & Digital assessments for Australian RTOs';

export const HOME_H1 = 'FREE Adaptive LLN & Digital Assessments for Australian RTOs';
export const HOME_DESCRIPTION =
  'Assess learner readiness, identify support needs and track progress with smarter, shorter adaptive assessments.';
export const PRIMARY_OFFER = 'Start free with 10 adaptive assessments every month.';
export const PRIMARY_OFFER_SUPPORT = 'Pay only when you need more.';
export const PRIMARY_CTA = 'Start Assessing for Free';
export const SECONDARY_CTA = 'See How It Works';

/** Existing self-service registration flow. */
export const SIGNUP_HASH = '#/signup';
/** Existing explanation page used by the secondary CTA. */
export const HOW_IT_WORKS_HASH = '#/how-it-works';
/** Existing canonical staff login route (technical identifier retained). */
export const STAFF_LOGIN_HASH = '#/llnd-automate/login';

export const SEO_TITLE = 'FREE LLN & Digital Assessments for RTOs | LLND Assess';
export const SEO_DESCRIPTION =
  'Start free with 10 adaptive LLN & Digital assessments every month. Track learner progress, identify support needs and download assessment reports.';

export const FREE_MONTHLY_COMPLETIONS = 10;

export type PlanAvailability = 'available' | 'coming_soon';

export interface PlanRow {
  id: 'free' | 'plus' | 'automate';
  name: string;
  availability: PlanAvailability;
  monthlyFee: string;
  included: string;
  additional: string;
  manualWorkflow: string;
  integrationAutomation: string;
}

/** Approved plan structure. Paid plans are not launch-ready and are shown as coming soon. */
export const PLANS: PlanRow[] = [
  {
    id: 'free', name: 'Free', availability: 'available',
    monthlyFee: 'A$0', included: '10 completed assessments a month', additional: 'Not available',
    manualWorkflow: 'Included', integrationAutomation: 'Not included',
  },
  {
    id: 'plus', name: 'Plus', availability: 'coming_soon',
    monthlyFee: 'A$15 a month', included: '20 completed assessments a month', additional: 'A$0.75 each',
    manualWorkflow: 'Included', integrationAutomation: 'Not included',
  },
  {
    id: 'automate', name: 'Automate', availability: 'coming_soon',
    monthlyFee: 'A$35 a month', included: '20 completed assessments a month', additional: 'A$0.85 each',
    manualWorkflow: 'Included', integrationAutomation: 'Planned',
  },
];

/** Approved billing rules, worded for customers. */
export const BILLING_RULES: string[] = [
  'A learner who completes both LLN and Digital under the same assignment counts as one completed assessment.',
  'Invitations, reminders and abandoned assessments do not count.',
  'Learners already in progress can finish after the Free allowance is reached.',
  'New assessment starts are restricted once the Free allowance for the month is reached.',
  'Paid plans have no fixed monthly assessment cap.',
  'On paid plans, additional completions are charged only for completed assignments above the included monthly allowance.',
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
