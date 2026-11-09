import { CheckCircle2, Clock, Info } from 'lucide-react';
import { BILLING_RULES, PLANS, TIER_AUTOMATE, TIER_FREE, TIER_PLUS } from '../lib/brand';

// Signed-in "Plan & usage" page for RTO staff.
//
// Display only. It replaces the legacy BillingPage, which read retired plans
// (lln_only / digital_only / lln_digital, $79 / $129, 14-day trial) from
// subscription_plans and let staff create or change subscription rows from the
// browser. This page reads and writes nothing, so it cannot change billing
// records, and it deliberately does not state which plan an organisation is on
// or how many completions it has used: usage metering and the LLND Mate
// monthly allowance are not implemented yet, and stating either would
// misrepresent what the product actually enforces.
export function PlanStatusPage() {
  return (
    <div className="space-y-6 max-w-4xl">
      <div>
        <h1 className="text-2xl font-bold text-slate-900">Plan &amp; usage</h1>
        <p className="text-sm text-slate-500 mt-1">
          The LLND Mate product family and how completed assessments will be counted.
        </p>
      </div>

      <div className="rounded-xl border border-primary-200 bg-primary-50 p-4 flex gap-3" role="status">
        <Info className="w-5 h-5 text-primary-700 flex-shrink-0 mt-0.5" aria-hidden="true" />
        <div className="text-sm text-primary-900 leading-relaxed">
          <p className="font-semibold">Online plan management and usage counts are not available yet.</p>
          <p className="mt-1">
            Nothing on this page changes your organisation&rsquo;s access. {TIER_PLUS} and {TIER_AUTOMATE} are
            coming soon and cannot be purchased yet.
          </p>
        </div>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
        {PLANS.map((plan) => {
          const available = plan.availability === 'available';
          return (
            <div key={plan.id} className="rounded-xl border border-slate-200 bg-white p-5">
              <div className="flex items-start justify-between gap-2">
                <h2 className="font-bold text-slate-900">{plan.name}</h2>
                <span className={`text-xs font-semibold px-2 py-0.5 rounded-full whitespace-nowrap ${available ? 'bg-success-50 text-success-700' : 'bg-slate-100 text-slate-600'}`}>
                  {available ? 'Free' : 'Coming soon'}
                </span>
              </div>
              <p className="text-xs text-slate-500 mt-1">{plan.summary}</p>
              <p className="text-xl font-extrabold text-slate-900 mt-3">{plan.monthlyFee}</p>
              <p className="text-sm text-slate-600 mt-1">{plan.included}</p>
              <p className="text-sm text-slate-600 mt-1">Additional completions: {plan.additional}</p>
            </div>
          );
        })}
      </div>

      <div className="rounded-xl border border-slate-200 bg-white p-5">
        <h2 className="font-bold text-slate-900 mb-3">How completed assessments are counted</h2>
        <ul className="space-y-2">
          {BILLING_RULES.map((rule) => (
            <li key={rule} className="flex gap-2.5 text-sm text-slate-700 leading-relaxed">
              <CheckCircle2 className="w-4 h-4 text-success-600 flex-shrink-0 mt-0.5" aria-hidden="true" />
              {rule}
            </li>
          ))}
        </ul>
        <p className="flex gap-2 text-xs text-slate-500 mt-4">
          <Clock className="w-4 h-4 flex-shrink-0" aria-hidden="true" />
          The {TIER_FREE} monthly allowance is not yet counted or enforced in the product.
        </p>
      </div>
    </div>
  );
}
