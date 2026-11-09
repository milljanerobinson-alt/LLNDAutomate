import { ArrowRight } from 'lucide-react';
import { MarketingShell } from '../../components/marketing/MarketingShell';
import { FaqList } from './HomePage';
import { HOW_IT_WORKS_HASH, PRIMARY_CTA, SIGNUP_HASH } from '../../lib/brand';

/** Served at the existing #/resources route, labelled FAQ in navigation. */
export function ResourcesPage({ currentHash }: { currentHash: string }) {
  return (
    <MarketingShell currentHash={currentHash}>
      <section className="bg-gradient-to-b from-primary-50/70 to-white px-4 sm:px-6 py-14 sm:py-20">
        <div className="max-w-3xl mx-auto">
          <p className="text-sm font-semibold text-primary-700 mb-3">FAQ</p>
          <h1 className="text-4xl sm:text-5xl font-extrabold text-slate-900 tracking-tight mb-5">Frequently asked questions</h1>
          <p className="text-lg text-slate-600 leading-relaxed">
            Answers about the assessments, the LLND Mate free allowance and how results are used.
          </p>
        </div>
      </section>
      <section className="px-4 sm:px-6 pb-16">
        <div className="max-w-3xl mx-auto">
          <FaqList />
          <div className="flex flex-col sm:flex-row gap-3 mt-10">
            <a href={SIGNUP_HASH} className="inline-flex items-center justify-center gap-2 px-7 py-3.5 rounded-xl bg-primary-600 text-white font-bold hover:bg-primary-700 transition-colors">
              {PRIMARY_CTA} <ArrowRight className="w-5 h-5" aria-hidden="true" />
            </a>
            <a href={HOW_IT_WORKS_HASH} className="inline-flex items-center justify-center px-7 py-3.5 rounded-xl border-2 border-slate-200 text-slate-800 font-bold hover:bg-slate-50 transition-colors">
              How it works
            </a>
          </div>
        </div>
      </section>
    </MarketingShell>
  );
}
