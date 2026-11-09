// Test-only harness: renders Plan & usage, the staff notice and the learner
// "can't start" screen with fixed example data so each state can be screenshotted
// without a backend. Figures here are fixtures, not real usage.
import { createRoot } from 'react-dom/client';
import '../../../src/index.css';
import { parsePlanUsage, type PlanUsageState } from '../../../src/lib/planUsage';
import { PlanUsageView } from '../../../src/pages/PlanStatusPage';
import { UsageAllowanceNoticeView } from '../../../src/components/UsageAllowanceNotice';
import { AssessmentStartUnavailable } from '../../../src/components/AssessmentStartUnavailable';

function fixture(completed: number, inProgress = 2): PlanUsageState {
  return parsePlanUsage({
    state: 'ok', consistent: true,
    plan: { code: 'llnd_mate_free', name: 'LLND Mate', tier: 'Free', status: 'active', monthly_allowance: 10 },
    period: { month: '2026-11-01', reset_date: '2026-12-01' },
    usage: { completed, allowance: 10, remaining: Math.max(10 - completed, 0), in_progress: inProgress, new_starts_available: completed < 10 },
  });
}
const STATES: Record<string, PlanUsageState> = {
  empty: fixture(0, 0), normal: fixture(6), near: fixture(8), exhausted: fixture(10, 3),
  loading: { kind: 'loading' }, error: { kind: 'error' }, unauthorised: { kind: 'unauthorised' },
  no_entitlement: { kind: 'no_entitlement' }, inconsistent: { kind: 'inconsistent' },
};
const q = new URLSearchParams(location.search);
const state = STATES[q.get('state') ?? 'normal'] ?? STATES.normal;
const view = q.get('view') ?? 'plan';

createRoot(document.getElementById('root')!).render(
  view === 'learner' ? <AssessmentStartUnavailable /> : (
    <div className="min-h-screen bg-slate-50 p-4 sm:p-8">
      {view === 'notice' ? (
        <div className="max-w-4xl space-y-4">
          <h1 className="text-2xl font-bold text-slate-900">Candidates</h1>
          <UsageAllowanceNoticeView state={state} />
        </div>
      ) : <PlanUsageView state={state} onRetry={() => undefined} />}
    </div>
  ),
);
