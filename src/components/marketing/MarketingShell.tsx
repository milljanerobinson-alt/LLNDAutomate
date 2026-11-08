import { useEffect, type ReactNode } from 'react';
import { TopNav } from './TopNav';
import { Footer } from './Footer';

/** Shared layout for LLND Assess public pages: skip link, navigation, main landmark, footer. */
export function MarketingShell({ currentHash, children }: { currentHash: string; children: ReactNode }) {
  useEffect(() => { window.scrollTo(0, 0); }, [currentHash]);
  return (
    <div className="min-h-screen bg-white text-slate-900">
      <a href="#main-content" onClick={(e) => { e.preventDefault(); document.getElementById('main-content')?.focus(); }}
        className="sr-only focus:not-sr-only focus:fixed focus:top-3 focus:left-3 focus:z-[60] focus:bg-white focus:px-4 focus:py-2 focus:rounded-lg focus:shadow">
        Skip to main content
      </a>
      <TopNav currentHash={currentHash} />
      <main id="main-content" tabIndex={-1} className="pt-16 focus:outline-none">{children}</main>
      <Footer />
    </div>
  );
}

/** Small section heading block used across the public pages. */
export function SectionIntro({ eyebrow, title, children, id }: { eyebrow?: string; title: string; children?: ReactNode; id?: string }) {
  return (
    <div className="max-w-2xl mb-10">
      {eyebrow && <p className="text-sm font-semibold text-primary-700 mb-2">{eyebrow}</p>}
      <h2 id={id} className="text-3xl sm:text-4xl font-extrabold text-slate-900 tracking-tight mb-4">{title}</h2>
      {children && <div className="text-lg text-slate-600 leading-relaxed">{children}</div>}
    </div>
  );
}
