import { TestBadge } from '../../components/TestBadge';
import { useCallback, useEffect, useState } from 'react';
import { Loader2, Lock, RotateCcw, Search } from 'lucide-react';
import { fetchDeletedAssessments, PRIOR_STATUS_LABEL, restoreAssessment, type DeletedAssessmentRow, type Loaded } from '../../lib/platformUsage';

// Platform operator: deleted assessments. Lists identification and status only:
// no answers or results. Restoration is an explicit operator action after the
// restoration fee has been arranged; it uses no allowance, sends nothing and
// starts no workflow. There is no payment step here.

const fmt = (iso: string | null) => (iso ? new Date(iso).toLocaleString('en-AU', { dateStyle: 'medium', timeStyle: 'short' }) : '—');

export function DeletedAssessmentsView({ state, onRestore, restoringId }: {
  state: Loaded<DeletedAssessmentRow[]> | { kind: 'loading' };
  onRestore: (row: DeletedAssessmentRow) => void;
  restoringId: string | null;
}) {
  if (state.kind === 'loading') return <div className="p-6 flex items-center gap-2 text-slate-500" role="status"><Loader2 className="w-4 h-4 animate-spin" aria-hidden="true" /> Loading…</div>;
  if (state.kind === 'unauthorised') {
    return <div className="rounded-xl border border-slate-200 bg-slate-50 p-4 flex gap-3 text-sm" role="alert"><Lock className="w-5 h-5" aria-hidden="true" /><p><span className="font-semibold">Platform operator access required.</span> Sign in with an operator account and complete MFA.</p></div>;
  }
  if (state.kind === 'error') return <p className="rounded-xl border border-slate-200 bg-slate-50 p-4 text-sm" role="alert">Deleted assessments could not be loaded.</p>;
  if (state.data.length === 0) return <p className="p-6 text-sm text-slate-500">No deleted assessments match this search.</p>;
  return (
    <div className="rounded-xl border border-slate-200 bg-white overflow-x-auto">
      <table className="w-full text-sm min-w-[900px]">
        <thead className="bg-slate-50 text-slate-600 text-xs uppercase tracking-wide">
          <tr><th className="text-left p-2.5">Learner</th><th className="text-left p-2.5">RTO</th><th className="text-left p-2.5">Status before deletion</th>
            <th className="text-left p-2.5">Deleted</th><th className="text-left p-2.5">Restoration</th><th className="p-2.5"><span className="sr-only">Action</span></th></tr>
        </thead>
        <tbody>
          {state.data.map((r) => (
            <tr key={r.invitationId} className="border-t border-slate-100 align-top">
              <td className="p-2.5">
                <div className="font-semibold text-slate-900">{r.learnerName}{r.isTest && <TestBadge />}</div>
                <div className="text-xs text-slate-500">{r.learnerEmail}</div>
              </td>
              <td className="p-2.5">{r.organisationName}</td>
              <td className="p-2.5">{PRIOR_STATUS_LABEL[r.priorStatus ?? ''] ?? '—'}</td>
              <td className="p-2.5"><div>{fmt(r.deletedAt)}</div><div className="text-xs text-slate-500">{r.deletedByEmail ?? 'Unknown user'}</div></td>
              <td className="p-2.5">{r.restorationStatus === 'restored'
                ? <span className="text-success-700 font-semibold">Restored {fmt(r.restoredAt)}<span className="block text-xs font-normal text-slate-500">{r.restoredByEmail}</span></span>
                : <span className="text-slate-700">Deleted</span>}</td>
              <td className="p-2.5 text-right">
                {r.restorationStatus === 'deleted' && (
                  <button type="button" onClick={() => onRestore(r)} disabled={restoringId === r.invitationId}
                    className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-semibold border border-slate-300 hover:bg-slate-50 disabled:opacity-50">
                    {restoringId === r.invitationId ? <Loader2 className="w-3.5 h-3.5 animate-spin" aria-hidden="true" /> : <RotateCcw className="w-3.5 h-3.5" aria-hidden="true" />} Restore
                  </button>
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export function PlatformDeletedAssessmentsPage() {
  const [search, setSearch] = useState('');
  const [includeRestored, setIncludeRestored] = useState(false);
  const [state, setState] = useState<Loaded<DeletedAssessmentRow[]> | { kind: 'loading' }>({ kind: 'loading' });
  const [confirmRow, setConfirmRow] = useState<DeletedAssessmentRow | null>(null);
  const [note, setNote] = useState('');
  const [feeArranged, setFeeArranged] = useState(false);
  const [restoringId, setRestoringId] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);

  const load = useCallback(async () => {
    setState({ kind: 'loading' });
    setState(await fetchDeletedAssessments(search, includeRestored));
  }, [search, includeRestored]);
  useEffect(() => { void load(); }, [load]);

  async function restore() {
    if (!confirmRow || !feeArranged) return;
    setRestoringId(confirmRow.invitationId);
    const r = await restoreAssessment(confirmRow.invitationId, note);
    setRestoringId(null);
    setMessage(r.ok ? (r.already ? 'This assessment was already active.' : `Assessment for ${confirmRow.learnerName} restored. Nothing was sent to the learner.`) : r.message);
    setConfirmRow(null); setNote(''); setFeeArranged(false);
    void load();
  }

  return (
    <div className="space-y-5 max-w-7xl">
      <div>
        <h1 className="text-2xl font-bold text-slate-900">Deleted assessments</h1>
        <p className="text-sm text-slate-500 mt-1">Restore an assessment only after the RTO has asked LLND Mate support and the restoration fee has been arranged.</p>
      </div>
      <form className="flex flex-wrap gap-3 items-end" onSubmit={(e) => { e.preventDefault(); void load(); }}>
        <label className="text-sm"><span className="block text-xs font-semibold text-slate-600 mb-1">Search RTO or learner</span>
          <span className="relative block"><Search className="w-4 h-4 absolute left-2.5 top-2.5 text-slate-400" aria-hidden="true" />
            <input value={search} onChange={(e) => setSearch(e.target.value)} className="input pl-8" placeholder="Name or email" /></span></label>
        <label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={includeRestored} onChange={(e) => setIncludeRestored(e.target.checked)} /> Include restored</label>
      </form>
      {message && <p className="rounded-xl border border-primary-200 bg-primary-50 p-3 text-sm text-primary-900" role="status">{message}</p>}
      <DeletedAssessmentsView state={state} onRestore={(r) => { setMessage(null); setConfirmRow(r); }} restoringId={restoringId} />
      {confirmRow && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/50 p-4">
          <div role="dialog" aria-modal="true" aria-labelledby="restore-title" className="w-full max-w-md rounded-2xl bg-white p-6 shadow-xl">
            <h2 id="restore-title" className="text-lg font-bold text-slate-900">Restore assessment?</h2>
            <p className="text-sm text-slate-700 mt-2">{confirmRow.learnerName} ({confirmRow.organisationName}). The original results and progress return to the RTO. No invitation is sent, no allowance is used and no integration runs.</p>
            <label className="flex items-start gap-2 text-sm mt-4"><input type="checkbox" checked={feeArranged} onChange={(e) => setFeeArranged(e.target.checked)} className="mt-1" /> The RTO requested restoration and the restoration fee has been arranged.</label>
            <label className="block text-sm mt-3"><span className="block text-xs font-semibold text-slate-600 mb-1">Note (for example, the support ticket)</span>
              <input value={note} onChange={(e) => setNote(e.target.value)} className="input w-full" /></label>
            <div className="mt-5 flex justify-end gap-2">
              <button type="button" onClick={() => setConfirmRow(null)} className="px-4 py-2 rounded-xl text-sm font-semibold border border-slate-300">Cancel</button>
              <button type="button" onClick={restore} disabled={!feeArranged || !!restoringId} className="px-4 py-2 rounded-xl text-sm font-semibold text-white bg-primary-600 disabled:opacity-40">Restore</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
