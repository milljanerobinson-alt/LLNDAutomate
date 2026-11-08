import { useState, useEffect } from 'react';
import { Menu, X, ChevronRight } from 'lucide-react';
import { useAuth } from '../../lib/auth';
import { BrandMark } from './BrandMark';
import { PRIMARY_CTA, SIGNUP_HASH, STAFF_LOGIN_HASH } from '../../lib/brand';

export const NAV_LINKS = [
  { label: 'How It Works', hash: '#/how-it-works' },
  { label: 'Features', hash: '#/features' },
  { label: 'Pricing', hash: '#/pricing' },
  { label: 'FAQ', hash: '#/resources' },
  { label: 'About', hash: '#/about' },
];

interface TopNavProps {
  currentHash: string;
}

export function TopNav({ currentHash }: TopNavProps) {
  const { user } = useAuth();
  const [scrolled, setScrolled] = useState(false);
  const [mobileOpen, setMobileOpen] = useState(false);

  useEffect(() => {
    const handler = () => setScrolled(window.scrollY > 12);
    window.addEventListener('scroll', handler, { passive: true });
    handler();
    return () => window.removeEventListener('scroll', handler);
  }, []);

  useEffect(() => { setMobileOpen(false); }, [currentHash]);

  const linkClass = (hash: string) =>
    `px-3.5 py-2 rounded-lg text-sm font-medium transition-colors ${
      currentHash === hash ? 'text-primary-700 bg-primary-50' : 'text-slate-600 hover:text-slate-900 hover:bg-slate-50'
    }`;

  return (
    <header
      className={`fixed inset-x-0 top-0 z-50 transition-colors duration-200 ${
        scrolled || mobileOpen ? 'bg-white/95 backdrop-blur-md shadow-sm border-b border-slate-100' : 'bg-white/80 backdrop-blur-sm'
      }`}
    >
      <div className="max-w-7xl mx-auto px-4 sm:px-6 h-16 flex items-center justify-between gap-6">
        <a href="#/" className="flex-shrink-0 rounded-lg focus:outline-none focus-visible:ring-2 focus-visible:ring-primary-500" aria-label="LLND Assess home">
          <BrandMark showDescriptor />
        </a>

        <nav aria-label="Main" className="hidden lg:flex items-center gap-0.5 flex-1 justify-center">
          {NAV_LINKS.map((link) => (
            <a key={link.hash} href={link.hash} className={linkClass(link.hash)} aria-current={currentHash === link.hash ? 'page' : undefined}>
              {link.label}
            </a>
          ))}
        </nav>

        <div className="hidden lg:flex items-center gap-3 flex-shrink-0">
          {user ? (
            <a href="#/assessment/dashboard" className="inline-flex items-center gap-1.5 px-4 py-2 rounded-xl bg-primary-600 text-white text-sm font-semibold hover:bg-primary-700 transition-colors shadow-sm">
              Open Dashboard <ChevronRight className="w-4 h-4" aria-hidden="true" />
            </a>
          ) : (
            <>
              <a href={STAFF_LOGIN_HASH} className="px-4 py-2 text-sm font-semibold text-slate-600 hover:text-slate-900 transition-colors">
                Sign In
              </a>
              <a href={SIGNUP_HASH} className="inline-flex items-center gap-1.5 px-5 py-2.5 rounded-xl bg-primary-600 text-white text-sm font-semibold hover:bg-primary-700 transition-colors shadow-sm">
                {PRIMARY_CTA}
              </a>
            </>
          )}
        </div>

        <button
          type="button"
          onClick={() => setMobileOpen((o) => !o)}
          className="lg:hidden p-2 rounded-lg text-slate-600 hover:bg-slate-100 transition-colors"
          aria-label={mobileOpen ? 'Close menu' : 'Open menu'}
          aria-expanded={mobileOpen}
          aria-controls="mobile-menu"
        >
          {mobileOpen ? <X className="w-5 h-5" aria-hidden="true" /> : <Menu className="w-5 h-5" aria-hidden="true" />}
        </button>
      </div>

      {mobileOpen && (
        <div id="mobile-menu" className="lg:hidden bg-white border-t border-slate-100 px-4 pb-4">
          <nav aria-label="Main" className="flex flex-col gap-0.5 py-3">
            {NAV_LINKS.map((link) => (
              <a key={link.hash} href={link.hash} className={`w-full text-left ${linkClass(link.hash)} py-2.5`}>
                {link.label}
              </a>
            ))}
          </nav>
          <div className="flex flex-col gap-2 pt-3 border-t border-slate-100">
            {user ? (
              <a href="#/assessment/dashboard" className="w-full py-3 rounded-xl bg-primary-600 text-white text-sm font-bold text-center">
                Open Dashboard
              </a>
            ) : (
              <>
                <a href={STAFF_LOGIN_HASH} className="w-full py-3 rounded-xl border border-slate-200 text-slate-700 text-sm font-semibold text-center hover:bg-slate-50">
                  Sign In
                </a>
                <a href={SIGNUP_HASH} className="w-full py-3 rounded-xl bg-primary-600 text-white text-sm font-bold text-center">
                  {PRIMARY_CTA}
                </a>
              </>
            )}
          </div>
        </div>
      )}
    </header>
  );
}
