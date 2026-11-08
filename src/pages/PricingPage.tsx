import { ArrowRight, CheckCircle2 } from 'lucide-react';
import { MarketingShell } from '../components/marketing/MarketingShell';
import { BILLING_RULES, PLANS, PRIMARY_CTA, SIGNUP_HASH } from '../lib/brand';

// Static, approved plan structure. Billing for paid plans is not implemented
// yet, so Plus and Automate are shown as coming soon and cannot be selected.
const ROWS: { label: string; key: 'monthlyFee' | 'included' | 'additional' | 'manualWorkflow' | 'integrationAutomation' }[] = [
  { label: 'Monthly base fee', key: 'monthlyFee' },
  { label: 'Included completed assessments', key: 'included' },
  { label: 'Additional completions', key: 'additional' },
  { label: 'Manual assessment workflow', key: 'manualWorkflow' },
  { label: 'Premium integration automation', key: 'integrationAutomation' },
];

export function PricingPage({ currentHash }: { currentHash: string }) {
  return (
    <MarketingShell currentHash={currentHash}>
      <section className="bg-gradient-to-b from-primary-50/70 to-white px-4 sm:px-6 py-14 sm:py-20">
        <div className="max-w-3xl mx-auto text-center">
          <p className="text-sm font-semibold text-primary-700 mb-3">Pricing</p>
          <h1 className="text-4xl sm:text-5xl font-extrabold text-slate-900 tracking-tight mb-5">Start free. Pay only when you need more.</h1>
          <p className="text-lg text-slate-600 leading-relaxed">
            The Free plan includes 10 completed assessments every month. Paid plans are coming soon.
          </p>
        </div>
      </section>

      <section className="px-4 sm:px-6 pb-14" aria-label="Plans">
        <div className="max-w-6xl mx-auto grid grid-cols-1 md:grid-cols-3 gap-5">
          {PLANS.map((plan) => {
            const available = plan.availability === 'available';
            return (
              <div key={plan.id} className={`rounded-2xl border-2 p-6 flex flex-col ${available ? 'border-primary-500 shadow-lg' : 'border-slate-200'}`}>
                <div className="flex items-center justify-between mb-4">
                  <h2 className="text-xl font-extrabold text-slate-900">{plan.name}</h2>
                  <span className={`text-xs font-semibold px-2.5 py-1 rounded-full ${available ? 'bg-success-50 text-success-700 border border-success-200' : 'bg-slate-100 text-slate-600'}`}>
                    {available ? 'Available now' : 'Coming soon'}
                  </span>
                </div>
                <p className="text-3xl font-extrabold text-slate-900 mb-1">{plan.monthlyFee}</p>
                <p className="text-sm text-slate-600 mb-5">{plan.included}</p>
                <dl className="space-y-2 text-sm mb-6 flex-1">
                  <div className="flex justify-between gap-3"><dt className="text-slate-600">Additional completions</dt><dd className="font-semibold text-slate-900 text-right">{plan.additional}</dd></div>
                  <div className="flex justify-between gap-3"><dt className="text-slate-600">Manual assessment workflow</dt><dd className="font-semibold text-slate-900 text-right">{plan.manualWorkflow}</dd></div>
                  <div className="flex justify-between gap-3"><dt className="text-slate-600">Premium integration automation</dt><dd className="font-semibold text-slate-900 text-right">{plan.integrationAutomation}</dd></div>
                </dl>
                {available ? (
                  <a href={SIGNUP_HASH} className="inline-flex items-center justify-center gap-2 px-5 py-3 rounded-xl bg-primary-600 text-white font-bold hover:bg-primary-700 transition-colors">
                    {PRIMARY_CTA} <ArrowRight className="w-4 h-4" aria-hidden="true" />
                  </a>
                ) : (
                  <p className="text-sm text-slate-500 text-center py-3 rounded-xl bg-slate-50">Not yet available</p>
                )}
              </div>
            );
          })}
        </div>
      </section>

      <section className="px-4 sm:px-6 pb-14" aria-labelledby="compare-heading">
        <div className="max-w-6xl mx-auto">
          <h2 id="compare-heading" className="text-2xl font-extrabold text-slate-900 mb-5">Compare plans</h2>
          <div className="overflow-x-auto rounded-2xl border border-slate-200">
            <table className="w-full text-sm text-left min-w-[560px]">
              <caption className="sr-only">LLND Assess plan comparison</caption>
              <thead className="bg-slate-50 text-slate-700">
                <tr>
                  <th scope="col" className="px-4 py-3 font-semibold">Feature</th>
                  {PLANS.map((p) => (
                    <th key={p.id} scope="col" className="px-4 py-3 font-semibold">
                      {p.name}{p.availability === 'coming_soon' && <span className="block text-xs font-normal text-slate-500">Coming soon</span>}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {ROWS.map((row) => (
                  <tr key={row.key}>
                    <th scope="row" className="px-4 py-3 font-medium text-slate-700">{row.label}</th>
                    {PLANS.map((p) => <td key={p.id} className="px-4 py-3 text-slate-900">{p[row.key]}</td>)}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      </section>

      <section className="bg-slate-50 px-4 sm:px-6 py-14" aria-labelledby="rules-heading">
        <div className="max-w-3xl mx-auto">
          <h2 id="rules-heading" className="text-2xl font-extrabold text-slate-900 mb-5">How completed assessments are counted</h2>
          <ul className="space-y-3">
            {BILLING_RULES.map((rule) => (
              <li key={rule} className="flex gap-3 text-slate-700 leading-relaxed">
                <CheckCircle2 className="w-5 h-5 text-success-600 flex-shrink-0 mt-0.5" aria-hidden="true" />
                {rule}
              </li>
            ))}
          </ul>
          <p className="text-sm text-slate-500 mt-6">Prices are in Australian dollars. Paid plans are not yet available to purchase.</p>
        </div>
      </section>
    </MarketingShell>
  );
}
