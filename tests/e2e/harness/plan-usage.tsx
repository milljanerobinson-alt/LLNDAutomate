// Test-only harness: renders LLND Mate Plan & usage, staff notices, the delete
// dialog, the TEST label and the platform-operator screens with fixed example
// data so each state can be screenshotted without a backend. Figures are fixtures.
import { useState } from 'react';
import { createRoot } from 'react-dom/client';
import '../../../src/index.css';
import { parsePlanUsage, type PlanUsageState } from '../../../src/lib/planUsage';
import { PlanUsageView } from '../../../src/pages/PlanStatusPage';
import { UsageAllowanceNoticeView } from '../../../src/components/UsageAllowanceNotice';
import { DeleteAssessmentDialog } from '../../../src/components/DeleteAssessmentDialog';
import { TestBadge } from '../../../src/components/TestBadge';
import { CreateTestCandidateDialog } from '../../../src/components/CreateTestCandidateDialog';
import { PendingTestCandidates } from '../../../src/components/PendingTestCandidates';
import type { TestCandidate } from '../../../src/lib/planUsage';
import { FlaskConical, Plus } from 'lucide-react';
import { UsageDetailView, UsageTableView } from '../../../src/pages/operator/PlatformInvitationsUsagePage';
import { DeletedAssessmentsView } from '../../../src/pages/operator/PlatformDeletedAssessmentsPage';
import type { DeletedAssessmentRow, RtoUsageRow } from '../../../src/lib/platformUsage';

function fixture(used: number, returned = 0, tests = 2): PlanUsageState {
  return parsePlanUsage({
    state: 'ok', consistent: true,
    plan: { code: 'llnd_mate_free', name: 'LLND Mate', tier: 'Free', status: 'active', monthly_allowance: 10, unit: 'invitations' },
    period: { month: '2026-11-01', reset_date: '2026-12-01' },
    usage: { used, allowance: 10, remaining: Math.max(10 - used, 0), sent_this_month: used + returned, returned_by_deletion: returned,
             test_invitations: tests, new_invitations_available: used < 10 },
  });
}
const STATES: Record<string, PlanUsageState> = {
  empty: fixture(0, 0, 0), normal: fixture(6, 1, 3), near: fixture(8, 0, 2), exhausted: fixture(10, 5, 4),
  loading: { kind: 'loading' }, error: { kind: 'error' }, unauthorised: { kind: 'unauthorised' },
  no_entitlement: { kind: 'no_entitlement' }, inconsistent: { kind: 'inconsistent' },
};
const RTOS: RtoUsageRow[] = [
  { organisationId: '1', organisationName: 'Coastal Skills Institute', planCode: 'llnd_mate_free', monthlyAllowance: 10, totalInvitationsSent: 42, monthInvitationsSent: 15, monthNetUsage: 10, monthRemaining: 0, monthTestInvitations: 3, totalTestInvitations: 7, deletedInvitations: 5, completedAssessments: 31, restoredAssessments: 1, counterConsistent: true },
  { organisationId: '2', organisationName: 'Northside Training College', planCode: 'llnd_mate_free', monthlyAllowance: 10, totalInvitationsSent: 9, monthInvitationsSent: 6, monthNetUsage: 6, monthRemaining: 4, monthTestInvitations: 1, totalTestInvitations: 1, deletedInvitations: 0, completedAssessments: 4, restoredAssessments: 0, counterConsistent: true },
  { organisationId: '3', organisationName: 'Example RTO (no plan)', planCode: null, monthlyAllowance: null, totalInvitationsSent: 0, monthInvitationsSent: 0, monthNetUsage: 0, monthRemaining: null, monthTestInvitations: 0, totalTestInvitations: 0, deletedInvitations: 0, completedAssessments: 0, restoredAssessments: 0, counterConsistent: true },
];
const DELETED: DeletedAssessmentRow[] = [
  { invitationId: 'a', organisationName: 'Coastal Skills Institute', learnerName: 'Jordan Example', learnerEmail: 'jordan@example.invalid', isTest: false, invitedAt: '2026-11-03T01:00:00Z', priorStatus: 'completed', deletedAt: '2026-11-08T03:20:00Z', deletedByEmail: 'admin@coastal.example', restorationStatus: 'deleted', restoredAt: null, restoredByEmail: null },
  { invitationId: 'b', organisationName: 'Coastal Skills Institute', learnerName: 'Test Test', learnerEmail: 'trainer@coastal.example', isTest: true, invitedAt: '2026-11-04T01:00:00Z', priorStatus: 'in_progress', deletedAt: '2026-11-07T22:05:00Z', deletedByEmail: 'admin@coastal.example', restorationStatus: 'deleted', restoredAt: null, restoredByEmail: null },
  { invitationId: 'c', organisationName: 'Northside Training College', learnerName: 'Sam Sample', learnerEmail: 'sam@example.invalid', isTest: false, invitedAt: '2026-10-28T01:00:00Z', priorStatus: 'not_started', deletedAt: '2026-11-01T02:00:00Z', deletedByEmail: 'office@northside.example', restorationStatus: 'restored', restoredAt: '2026-11-05T04:00:00Z', restoredByEmail: 'operator@llndmate.example' },
];

const q = new URLSearchParams(location.search);
const view = q.get('view') ?? 'plan';
const state = STATES[q.get('state') ?? 'normal'] ?? STATES.normal;

function DeleteDemo() {
  const [open, setOpen] = useState(true);
  const [log, setLog] = useState<string[]>([]);
  return (
    <div>
      <h1 className="text-2xl font-bold text-slate-900">Candidates</h1>
      <p data-testid="delete-log">{log.join(',')}</p>
      <button type="button" onClick={() => setOpen(true)}>Open delete</button>
      <DeleteAssessmentDialog target={open ? { id: 'inv-1', learnerName: 'Jordan Example' } : null}
        onCancel={() => { setOpen(false); setLog((l) => [...l, 'cancel']); }}
        onConfirm={async (id, c) => { setLog((l) => [...l, `confirm:${id}:${c}`]); setOpen(false); return null; }} />
    </div>
  );
}

function TestRowDemo() {
  return (
    <div className="max-w-3xl space-y-4">
      <h1 className="text-2xl font-bold text-slate-900">Candidates</h1>
      <div className="rounded-xl border border-slate-200 bg-white divide-y divide-slate-100">
        {[['Jordan Example', 'jordan@example.invalid', false, 'In progress'], ['Test Test', 'trainer@coastal.example', true, 'Completed'], ['Sam Sample', 'sam@example.invalid', false, 'Sent']].map(([n, e, t, s]) => (
          <div key={String(n)} className="p-4 flex justify-between gap-3">
            <div><div className="font-medium text-slate-900">{n}{t && <TestBadge />}</div><div className="text-xs text-slate-500">{e}</div></div>
            <span className="text-sm text-slate-600">{s}</span>
          </div>
        ))}
      </div>
      <div className="rounded-xl border border-slate-200 bg-white p-4 max-w-md">
        <label className="label" htmlFor="n">Candidate Name</label>
        <input id="n" className="input" value="Test Test" disabled readOnly />
        <p className="text-xs text-slate-500 mt-1">This is a test assessment. The learner name can’t be changed.</p>
      </div>
    </div>
  );
}

function CreateTestDemo() {
  const [open, setOpen] = useState(true);
  const [calls, setCalls] = useState<string[]>([]);
  const create = async (email: string) => {
    setCalls((c) => [...c, email]);
    await new Promise((r) => setTimeout(r, 400));
    return { ok: true as const, candidate: { id: 'tc-new', candidateName: 'Test Test2', email, sequenceNumber: 2, createdAt: '2026-11-10T00:00:00Z' } };
  };
  return (
    <div>
      <h1 className="text-2xl font-bold text-slate-900">Candidates</h1>
      <p data-testid="create-calls">{calls.join(',')}</p>
      <p data-testid="created">{open ? '' : 'created'}</p>
      <CreateTestCandidateDialog open={open} onClose={() => setOpen(false)} onCreated={() => setOpen(false)}
        preview={async () => 'Test Test2'} create={create} />
    </div>
  );
}

const PENDING: TestCandidate[] = [
  { id: 'tc3', candidateName: 'Test Test3', email: 'trainer@coastal.example', sequenceNumber: 3, createdAt: '2026-11-10T01:00:00Z' },
];

function CandidatesDemo() {
  const [sent, setSent] = useState('');
  return (
    <div className="max-w-6xl space-y-6">
      <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4">
        <div><h1 className="text-2xl font-bold text-slate-900">Candidates</h1><p className="text-sm text-slate-500 mt-1">Track learner progress through LLN and Digital assessments.</p></div>
        <div className="flex flex-wrap gap-2">
          <button className="btn-secondary"><FlaskConical className="w-4 h-4" /> Create Test Candidate</button>
          <button className="btn-primary"><Plus className="w-4 h-4" /> New Invitation</button>
        </div>
      </div>
      <div className="rounded-xl border border-success-200 bg-success-50 p-3 text-sm text-success-800" role="status">Test Test3 created. Select “Send assessment” to choose LLN, Digital or both.</div>
      <p data-testid="send-target">{sent}</p>
      <PendingTestCandidates candidates={PENDING} highlightId="tc3" onSend={(tc) => setSent(tc.candidateName)} onDelete={() => undefined} />
      <div className="card divide-y divide-slate-100">
        {[['Jordan Example', 'jordan@example.invalid', false, 'In progress'], ['Test Test2', 'trainer@coastal.example', true, 'Sent · LLN + Digital'], ['Test Test', 'trainer@coastal.example', true, 'Completed']].map(([n, e, t, st]) => (
          <div key={String(n)} className="p-4 flex justify-between gap-3">
            <div><div className="font-medium text-slate-900">{n}{t && <TestBadge />}</div><div className="text-xs text-slate-500">{e}</div></div>
            <span className="text-sm text-slate-600">{st}</span>
          </div>
        ))}
      </div>
    </div>
  );
}

const content = (() => {
  switch (view) {
    case 'notice': return <div className="max-w-4xl space-y-4"><h1 className="text-2xl font-bold text-slate-900">Candidates</h1><UsageAllowanceNoticeView state={state} /></div>;
    case 'delete': return <DeleteDemo />;
    case 'create-test': return <CreateTestDemo />;
    case 'candidates': return <CandidatesDemo />;
    case 'test': return <TestRowDemo />;
    case 'operator-usage': return <div className="space-y-4"><h1 className="text-2xl font-bold text-slate-900">Invitations &amp; Usage</h1><UsageTableView state={q.get('denied') ? { kind: 'unauthorised' } : { kind: 'ok', data: RTOS }} onOpen={() => undefined} /></div>;
    case 'operator-detail': return <UsageDetailView row={RTOS[0]} onBack={() => undefined} history={{ kind: 'ok', data: [
      { month: '2026-11-01', sent: 15, refunded: 5, net: 10, tests: 3, completed: 8 }, { month: '2026-10-01', sent: 12, refunded: 2, net: 10, tests: 2, completed: 11 },
      { month: '2026-09-01', sent: 9, refunded: 0, net: 9, tests: 2, completed: 9 }] }} />;
    case 'operator-deleted': return <div className="space-y-4"><h1 className="text-2xl font-bold text-slate-900">Deleted assessments</h1><DeletedAssessmentsView state={{ kind: 'ok', data: DELETED }} onRestore={() => undefined} restoringId={null} /></div>;
    default: return <PlanUsageView state={state} onRetry={() => undefined} />;
  }
})();

createRoot(document.getElementById('root')!).render(<div className="min-h-screen bg-slate-50 p-4 sm:p-8">{content}</div>);
