import { BrandMark } from './BrandMark';
import { PRODUCT_NAME, SIGNUP_HASH, STAFF_LOGIN_HASH, PRIMARY_CTA } from '../../lib/brand';

// Only pages that exist are linked. Privacy Policy and Terms of Service will be
// added when the documents are approved (see the rebrand release notes).
const COLS = [
  {
    heading: 'Product',
    links: [
      { label: 'How It Works', hash: '#/how-it-works' },
      { label: 'Features', hash: '#/features' },
      { label: 'Pricing', hash: '#/pricing' },
      { label: 'FAQ', hash: '#/resources' },
    ],
  },
  {
    heading: 'Get started',
    links: [
      { label: PRIMARY_CTA, hash: SIGNUP_HASH },
      { label: 'Staff sign in', hash: STAFF_LOGIN_HASH },
      { label: 'About', hash: '#/about' },
    ],
  },
];

export function Footer() {
  return (
    <footer className="bg-slate-950 text-slate-400">
      <div className="max-w-7xl mx-auto px-4 sm:px-6 pt-14 pb-10">
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-10 mb-10">
          <div className="lg:col-span-2">
            <a href="#/" className="inline-flex mb-5" aria-label={`${PRODUCT_NAME} home`}>
              <BrandMark tone="light" />
            </a>
            <p className="text-sm leading-relaxed max-w-sm">
              Adaptive LLN and Digital assessments for Australian Registered Training Organisations.
              Start free with 10 completed assessments every month.
            </p>
          </div>
          {COLS.map((col) => (
            <nav key={col.heading} aria-label={col.heading}>
              <h2 className="text-white text-sm font-semibold mb-4">{col.heading}</h2>
              <ul className="space-y-2.5">
                {col.links.map((link) => (
                  <li key={link.label}>
                    <a href={link.hash} className="text-sm hover:text-white transition-colors">{link.label}</a>
                  </li>
                ))}
              </ul>
            </nav>
          ))}
        </div>
        <div className="border-t border-slate-800 pt-6 flex flex-col sm:flex-row items-start sm:items-center justify-between gap-3 text-xs">
          <p>© {new Date().getFullYear()} {PRODUCT_NAME}. All rights reserved.</p>
          <p>Prices in Australian dollars.</p>
        </div>
      </div>
    </footer>
  );
}
