import { useCallback, useEffect, useState } from 'react';
import { AlertTriangle, CheckCircle2, Clock, Info, Loader2, Lock, RefreshCw, XCircle } from 'lucide-react';
import { FREE_TIER_RULES, PLANS, TIER_PLUS } from '../lib/brand';
import { UpgradeOptionsButton } from '../components/UpgradeOptionsButton';
import { fetchPlanUsage, formatResetDate, type PlanUsageState } from '../lib/planUsage';

// Signed-in "Plan & usage" page for RTO administrators.
//
// LLND Mate Free is counted by invitations sent. Every figure comes from the
// server (get_my_plan_usage). The page never
// computes usage, never shows a figure it could not confirm, and never treats an
// unknown entitlement as an active free plan. It reads only; nothing here can
// change a plan, an entitlement or a billing record. Paid tiers are shown as
// coming soon with no purchase or upgrade action.

function Shell({ children }: { children: React.ReactNode }) {
  return (
    <div className="space-y-6 max-w-4xl">
      <div>
        <h1 className="text-2xl font-bold text-slate-900">Plan &amp; usage</h1>
        <p className="text-sm text-slate-500 mt-1">Your LLND Mate plan and assessment invitations this month.</p>
      </div>
      {children}
    </div>
  );
}

function Notice({ tone, icon: Icon, title, children }: {
  tone: 'info' | 'warn' | 'stop' | 'error'; icon: typeof Info; title: string; children?: React.ReactNode;
}) {
  const styles = {
    info: 'border-primary-200 bg-primary-50 text-primary-900',
    warn: 'border-amber-200 bg-amber-50 text-amber-900',
    stop: 'border-error-200 bg-error-50 text-error-900',
    error: 'border-slate-200 bg-slate-50 text-slate-800',
  }[tone];
  return (
    <div className={`rounded-xl border p-4 flex gap-3 ${styles}`} role={tone === 'stop' || tone === 'error' ? 'alert' : 'status'}>
      <Icon className="w-5 h-5 flex-shrink-0 mt-0.5" aria-hidden="true" />
      <div className="text-sm leading-relaxed">
        <p className="font-semibold">{title}</p>
        {children && <div className="mt-1 space-y-1">{children}</div>}
      </div>
    </div>
  );
}

function RetryButton({ onRetry }: { onRetry?: () => void }) {
  if (!onRetry) return null;
  return (
    <button type="button" onClick={onRetry} className="inline-flex items-center gap-1.5 text-sm font-semibold text-primary-700 hover:text-primary-800 mt-2">
      <RefreshCw className="w-4 h-4" aria-hidden="true" /> Try again
    </button>
  );
}

function ComingSoon() {
  const plus = PLANS.find((p) => p.id === 'plus');
  const automate = PLANS.find((p) => p.id === 'automate');
  return (
    <div className="rounded-xl border border-slate-200 bg-white p-5">
      <p className="text-sm text-slate-700">
        <span className="font-semibold">Need more assessments? {TIER_PLUS} is coming soon.</span>{' '}
        {plus && automate && (
          <span className="text-slate-500">
            {plus.name} ({plus.monthlyFee}, {plus.included}) and {automate.name} ({automate.monthlyFee}) are not yet available to purchase.
          </span>
        )}
      </p>
    </div>
  );
}

function Rules() {
  return (
    <div className="rounded-xl border border-slate-200 bg-white p-5">
      <h2 className="font-bold text-slate-900 mb-3">How invitations are counted</h2>
      <ul className="space-y-2">
        {FREE_TIER_RULES.map((rule) => (
          <li key={rule} className="flex gap-2.5 text-sm text-slate-700 leading-relaxed">
            <CheckCircle2 className="w-4 h-4 text-success-600 flex-shrink-0 mt-0.5" aria-hidden="true" />
            {rule}
          </li>
        ))}
        <li className="flex gap-2.5 text-sm text-slate-700 leading-relaxed">
          <CheckCircle2 className="w-4 h-4 text-success-600 flex-shrink-0 mt-0.5" aria-hidden="true" />
          The allowance resets at midnight AEST (UTC+10) on the first day of each month.
        </li>
      </ul>
    </div>
  );
}

export function PlanUsageView({ state, onRetry }: { state: PlanUsageState; onRetry?: () => void }) {
  if (state.kind === 'loading') {
    return (
      <Shell>
        <div className="rounded-xl border border-slate-200 bg-white p-8 flex items-center gap-3 text-slate-500" role="status" aria-live="polite">
          <Loader2 className="w-5 h-5 animate-spin" aria-hidden="true" /> Loading your plan and usage…
        </div>
      </Shell>
    );
  }
  if (state.kind === 'unauthorised') {
    return (
      <Shell>
        <Notice tone="error" icon={Lock} title="You don’t have access to plan and usage details.">
          <p>Only administrators of your RTO can see this page. Ask an administrator if you need these details.</p>
        </Notice>
      </Shell>
    );
  }
  if (state.kind === 'error') {
    return (
      <Shell>
        <Notice tone="error" icon={XCircle} title="We couldn’t load your plan and usage right now.">
          <p>No figures are shown because they could not be confirmed. Check your connection and try again.</p>
          <RetryButton onRetry={onRetry} />
        </Notice>
        <Rules />
      </Shell>
    );
  }
  if (state.kind === 'no_entitlement') {
    return (
      <Shell>
        <Notice tone="stop" icon={AlertTriangle} title="Your organisation’s plan could not be confirmed.">
          <p>New assessments can’t be started until this is fixed. Learners who have already started can still finish.</p>
          <p>Please contact LLND Mate support.</p>
        </Notice>
        <Rules />
      </Shell>
    );
  }
  if (state.kind === 'inconsistent') {
    return (
      <Shell>
        <Notice tone="error" icon={AlertTriangle} title="Your usage figures need checking.">
          <p>We found a mismatch in your usage records, so we aren’t showing figures that might be wrong. Your assessments and results are not affected.</p>
          <p>Please contact LLND Mate support.</p>
          <RetryButton onRetry={onRetry} />
        </Notice>
        <Rules />
      </Shell>
    );
  }

  const { used, allowance, remaining, sentThisMonth, returnedByDeletion, testInvitations, resetDate, level } = state;
  const reset = formatResetDate(resetDate);
  const pct = Math.min(100, Math.round((used / allowance) * 100));
  const bar = level === 'exhausted' ? 'bg-error-500' : level === 'near' ? 'bg-amber-500' : 'bg-primary-600';

  return (
    <Shell>
      <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
        <div className="rounded-xl border border-slate-200 bg-white p-5">
          <p className="text-xs font-semibold uppercase tracking-wide text-slate-500">Current plan</p>
          <p className="text-xl font-extrabold text-slate-900 mt-2">{state.planName}</p>
          <div className="flex items-center gap-2 mt-2">
            <span className="text-xs font-semibold px-2 py-0.5 rounded-full bg-slate-100 text-slate-700">{state.tierLabel}</span>
            <span className="inline-flex items-center gap-1 text-xs font-semibold px-2 py-0.5 rounded-full bg-success-50 text-success-700">
              <CheckCircle2 className="w-3.5 h-3.5" aria-hidden="true" /> Active
            </span>
          </div>
          <p className="text-sm text-slate-600 mt-3">{allowance} invitations per month</p>
        </div>

        <div className="rounded-xl border border-slate-200 bg-white p-5 md:col-span-2">
          <p className="text-xs font-semibold uppercase tracking-wide text-slate-500">This month</p>
          <p className="text-2xl font-extrabold text-slate-900 mt-2" data-testid="usage-used">
            {used} of {allowance} invitations used
          </p>
          <div className="mt-3 h-3 rounded-full bg-slate-100 overflow-hidden" role="progressbar"
            aria-label="Invitations used this month" aria-valuemin={0} aria-valuemax={allowance} aria-valuenow={Math.min(used, allowance)}>
            <div className={`h-full rounded-full ${bar}`} style={{ width: `${pct}%` }} />
          </div>
          <div className="flex flex-wrap justify-between gap-2 mt-3 text-sm">
            <span className="font-semibold text-slate-800" data-testid="usage-remaining">
              {remaining} {remaining === 1 ? 'invitation' : 'invitations'} remaining
            </span>
            <span className="inline-flex items-center gap-1.5 text-slate-600" data-testid="usage-reset">
              <Clock className="w-4 h-4" aria-hidden="true" /> Resets {reset}
            </span>
          </div>
        </div>
      </div>

      {level === 'empty' && (
        <Notice tone="info" icon={Info} title="No invitations sent yet this month.">
          <p>An invitation counts when it is sent. An LLN and a Digital assessment sent together count as one.</p>
        </Notice>
      )}
      {level === 'near' && (
        <Notice tone="warn" icon={AlertTriangle} title="Your free allowance is nearly used.">
          <p>
            {remaining} {remaining === 1 ? 'invitation' : 'invitations'} left this month. When all {allowance} are used, you
            won’t be able to send new invitations until {reset}.
          </p>
        </Notice>
      )}
      {level === 'exhausted' && (
        <Notice tone="stop" icon={XCircle} title={`You’ve used all ${allowance} free invitations this month.`}>
          <p>Learners you have already invited can still complete their assessments. Your allowance resets on {reset}.</p>
          <p>Deleting an assessment sent this month returns its invitation to your allowance.</p>
          <p>Upgrading to a paid plan will allow additional assessments once paid plans become available.</p>
          <UpgradeOptionsButton />
        </Notice>
      )}

      <div className="rounded-xl border border-slate-200 bg-white p-5 text-sm text-slate-700 leading-relaxed grid gap-3 sm:grid-cols-3">
        <div>
          <p className="text-xs font-semibold uppercase tracking-wide text-slate-500">Sent this month</p>
          <p className="text-lg font-bold text-slate-900 mt-1" data-testid="usage-sent">{sentThisMonth}</p>
        </div>
        <div>
          <p className="text-xs font-semibold uppercase tracking-wide text-slate-500">Returned by deletion</p>
          <p className="text-lg font-bold text-slate-900 mt-1" data-testid="usage-returned">{returnedByDeletion}</p>
          <p className="text-xs text-slate-500">Deleting an assessment sent this month returns its invitation.</p>
        </div>
        <div>
          <p className="text-xs font-semibold uppercase tracking-wide text-slate-500">Test invitations</p>
          <p className="text-lg font-bold text-slate-900 mt-1" data-testid="usage-tests">{testInvitations}</p>
          <p className="text-xs text-slate-500">Invitations to “Test Test” are free and don’t count.</p>
        </div>
      </div>

      <ComingSoon />
      <Rules />
    </Shell>
  );
}

export function PlanStatusPage() {
  const [state, setState] = useState<PlanUsageState>({ kind: 'loading' });
  const load = useCallback(async () => {
    setState({ kind: 'loading' });
    setState(await fetchPlanUsage());
  }, []);
  useEffect(() => { void load(); }, [load]);
  return <PlanUsageView state={state} onRetry={load} />;
}
