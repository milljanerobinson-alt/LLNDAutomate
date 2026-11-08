import { ArrowRight } from 'lucide-react';
import { MarketingShell } from '../../components/marketing/MarketingShell';
import { PRIMARY_CTA, SIGNUP_HASH } from '../../lib/brand';

const PRINCIPLES = [
  { title: 'Accurate results', body: 'Results are compared with the requirements your RTO approves. When a result cannot be confirmed, it is sent to your staff to review rather than accepted automatically.' },
  { title: 'Staff decide', body: 'LLND Assess reports results and highlights support needs. It never makes enrolment decisions for you.' },
  { title: 'Simple for learners', body: 'Short assessments from a personal link, on any device, with progress saved.' },
  { title: 'Clear pricing', body: 'Start free with 10 completed assessments each month. Paid plans are priced per completed assessment above the included allowance.' },
];

export function AboutPage({ currentHash }: { currentHash: string }) {
  return (
    <MarketingShell currentHash={currentHash}>
      <section className="bg-gradient-to-b from-primary-50/70 to-white px-4 sm:px-6 py-14 sm:py-20">
        <div className="max-w-3xl mx-auto">
          <p className="text-sm font-semibold text-primary-700 mb-3">About</p>
          <h1 className="text-4xl sm:text-5xl font-extrabold text-slate-900 tracking-tight mb-6">About LLND Assess</h1>
          <p className="text-lg text-slate-600 leading-relaxed mb-4">
            LLND Assess helps Australian Registered Training Organisations review prospective learners’ language, literacy,
            numeracy and digital skills, identify who may need support, and keep a clear record of the results.
          </p>
          <p className="text-lg text-slate-600 leading-relaxed">LLND Assess was previously known as LLND Automate.</p>
        </div>
      </section>
      <section className="px-4 sm:px-6 pb-16" aria-labelledby="principles-heading">
        <div className="max-w-5xl mx-auto">
          <h2 id="principles-heading" className="text-2xl font-extrabold text-slate-900 mb-6">How we approach LLND assessment</h2>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-5">
            {PRINCIPLES.map((p) => (
              <div key={p.title} className="rounded-2xl border border-slate-200 p-6">
                <h3 className="font-bold text-slate-900 mb-2">{p.title}</h3>
                <p className="text-sm text-slate-600 leading-relaxed">{p.body}</p>
              </div>
            ))}
          </div>
          <a href={SIGNUP_HASH} className="inline-flex items-center gap-2 mt-10 px-7 py-3.5 rounded-xl bg-primary-600 text-white font-bold hover:bg-primary-700 transition-colors">
            {PRIMARY_CTA} <ArrowRight className="w-5 h-5" aria-hidden="true" />
          </a>
        </div>
      </section>
    </MarketingShell>
  );
}
