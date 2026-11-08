import { ArrowRight } from 'lucide-react';
import { MarketingShell } from '../../components/marketing/MarketingShell';
import { HOW_IT_WORKS_HASH, PRIMARY_CTA, SIGNUP_HASH } from '../../lib/brand';

// The previous contact form did not send messages anywhere, and its email
// address and social links were unverified, so they have been removed. A
// confirmed contact channel will be added once it is approved.
export function ContactPage({ currentHash }: { currentHash: string }) {
  return (
    <MarketingShell currentHash={currentHash}>
      <section className="bg-gradient-to-b from-primary-50/70 to-white px-4 sm:px-6 py-14 sm:py-20">
        <div className="max-w-3xl mx-auto">
          <p className="text-sm font-semibold text-primary-700 mb-3">Contact</p>
          <h1 className="text-4xl sm:text-5xl font-extrabold text-slate-900 tracking-tight mb-5">Contact LLND Assess</h1>
          <p className="text-lg text-slate-600 leading-relaxed mb-8">
            Our contact details are being finalised. In the meantime you can read how LLND Assess works or create a free account.
          </p>
          <div className="flex flex-col sm:flex-row gap-3">
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
