import { useEffect, useState } from 'react';
import { AlertTriangle, XCircle } from 'lucide-react';
import { fetchPlanUsage, formatResetDate, type PlanUsageState } from '../lib/planUsage';

/**
 * Staff notice beside invitations. Shows only when the server confirms the RTO is
 * near or at its monthly allowance, or that the plan could not be confirmed.
 * It never blocks sending an invitation; the server decides whether a learner can start.
 */
export function UsageAllowanceNoticeView({ state }: { state: PlanUsageState }) {
  if (state.kind === 'no_entitlement') {
    return (
      <div className="rounded-xl border border-error-200 bg-error-50 p-4 flex gap-3 text-sm text-error-900" role="alert">
        <AlertTriangle className="w-5 h-5 flex-shrink-0" aria-hidden="true" />
        <p><span className="font-semibold">Your plan could not be confirmed.</span> Invited learners can’t start new assessments until this is fixed. See <a className="underline font-semibold" href="#/rto-admin/billing">Plan &amp; usage</a>.</p>
      </div>
    );
  }
  if (state.kind !== 'ok' || (state.level !== 'near' && state.level !== 'exhausted')) return null;
  const reset = formatResetDate(state.resetDate);
  if (state.level === 'exhausted') {
    return (
      <div className="rounded-xl border border-error-200 bg-error-50 p-4 flex gap-3 text-sm text-error-900" role="alert">
        <XCircle className="w-5 h-5 flex-shrink-0" aria-hidden="true" />
        <p>
          <span className="font-semibold">All {state.allowance} free assessments for this month are used.</span>{' '}
          You can still send invitations, but new assessments can’t be started until {reset}. Learners who have already started can finish.{' '}
          <a className="underline font-semibold" href="#/rto-admin/billing">Plan &amp; usage</a>
        </p>
      </div>
    );
  }
  return (
    <div className="rounded-xl border border-amber-200 bg-amber-50 p-4 flex gap-3 text-sm text-amber-900" role="status">
      <AlertTriangle className="w-5 h-5 flex-shrink-0" aria-hidden="true" />
      <p>
        <span className="font-semibold">{state.remaining} of {state.allowance} free assessments left this month.</span>{' '}
        An invitation doesn’t reserve an assessment: learners can start only while the allowance has room. Resets {reset}.{' '}
        <a className="underline font-semibold" href="#/rto-admin/billing">Plan &amp; usage</a>
      </p>
    </div>
  );
}

export function UsageAllowanceNotice() {
  const [state, setState] = useState<PlanUsageState>({ kind: 'loading' });
  useEffect(() => { let live = true; void fetchPlanUsage().then((s) => { if (live) setState(s); }); return () => { live = false; }; }, []);
  return <UsageAllowanceNoticeView state={state} />;
}
