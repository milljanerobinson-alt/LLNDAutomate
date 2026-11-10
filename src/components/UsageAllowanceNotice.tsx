import { useEffect, useState } from 'react';
import { AlertTriangle, XCircle } from 'lucide-react';
import { UpgradeOptionsButton } from './UpgradeOptionsButton';
import { fetchPlanUsage, formatResetDate, type PlanUsageState } from '../lib/planUsage';

/**
 * Staff notice above the invitation list. Shows only when the server confirms the
 * RTO is near or at its monthly invitation allowance, or that its plan could not
 * be confirmed. The server decides whether an invitation can be sent.
 */
export function UsageAllowanceNoticeView({ state }: { state: PlanUsageState }) {
  if (state.kind === 'no_entitlement') {
    return (
      <div className="rounded-xl border border-error-200 bg-error-50 p-4 flex gap-3 text-sm text-error-900" role="alert">
        <AlertTriangle className="w-5 h-5 flex-shrink-0" aria-hidden="true" />
        <p><span className="font-semibold">Your plan could not be confirmed.</span> New invitations can’t be sent until this is fixed. Learners already invited can still finish. See <a className="underline font-semibold" href="#/rto-admin/billing">Plan &amp; usage</a>.</p>
      </div>
    );
  }
  if (state.kind !== 'ok' || (state.level !== 'near' && state.level !== 'exhausted')) return null;
  const reset = formatResetDate(state.resetDate);
  if (state.level === 'exhausted') {
    return (
      <div className="rounded-xl border border-error-200 bg-error-50 p-4 flex gap-3 text-sm text-error-900" role="alert">
        <XCircle className="w-5 h-5 flex-shrink-0" aria-hidden="true" />
        <div>
          <p className="font-semibold">You’ve used all {state.allowance} free invitations this month.</p>
          <p className="mt-1">
            Learners already invited can still complete their assessments. Your allowance resets on {reset}. Deleting an
            assessment sent this month returns its invitation. Upgrading to a paid plan will allow additional assessments
            once paid plans become available. Test Candidates are still free.{' '}
            <a className="underline font-semibold" href="#/rto-admin/billing">Plan &amp; usage</a>
          </p>
          <UpgradeOptionsButton />
        </div>
      </div>
    );
  }
  return (
    <div className="rounded-xl border border-amber-200 bg-amber-50 p-4 flex gap-3 text-sm text-amber-900" role="status">
      <AlertTriangle className="w-5 h-5 flex-shrink-0" aria-hidden="true" />
      <p>
        <span className="font-semibold">{state.remaining} of {state.allowance} free invitations left this month.</span>{' '}
        Each new invitation uses one; resending doesn’t. Resets {reset}.{' '}
        <a className="underline font-semibold" href="#/rto-admin/billing">Plan &amp; usage</a>
      </p>
    </div>
  );
}

export function UsageAllowanceNotice({ refreshKey = 0 }: { refreshKey?: number }) {
  const [state, setState] = useState<PlanUsageState>({ kind: 'loading' });
  useEffect(() => {
    let live = true;
    void fetchPlanUsage().then((s) => { if (live) setState(s); });
    return () => { live = false; };
  }, [refreshKey]);
  return <UsageAllowanceNoticeView state={state} />;
}
