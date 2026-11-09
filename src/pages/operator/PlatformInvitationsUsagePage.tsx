import { useCallback, useEffect, useState } from 'react';
import { AlertTriangle, ArrowLeft, Loader2, Lock, RefreshCw, Search } from 'lucide-react';
import { fetchRtoUsage, fetchUsageHistory, monthParam, type Loaded, type RtoUsageRow, type UsageHistoryRow } from '../../lib/platformUsage';

// Platform operator: Invitations & Usage across RTOs. "Sent" is gross and never
// decreases; "Allowance used" is net of same-month deletions. Test Test
// invitations are always shown separately and never counted as usage.

function StateNotice({ state, onRetry }: { state: Loaded<unknown>; onRetry?: () => void }) {
  if (state.kind === 'unauthorised') {
    return (
      <div className="rounded-xl border border-slate-200 bg-slate-50 p-4 flex gap-3 text-sm text-slate-800" role="alert">
        <Lock className="w-5 h-5 flex-shrink-0" aria-hidden="true" />
        <p><span className="font-semibold">Platform operator access required.</span> Sign in with an operator account and complete MFA to view cross-RTO usage.</p>
      </div>
    );
  }
  if (state.kind === 'error') {
    return (
      <div className="rounded-xl border border-slate-200 bg-slate-50 p-4 text-sm text-slate-800" role="alert">
        <p className="font-semibold">Usage could not be loaded. No figures are shown.</p>
        {onRetry && <button type="button" onClick={onRetry} className="mt-2 inline-flex items-center gap-1.5 font-semibold text-primary-700"><RefreshCw className="w-4 h-4" aria-hidden="true" /> Try again</button>}
      </div>
    );
  }
  return null;
}

export function UsageDetailView({ row, history, onBack }: { row: RtoUsageRow; history: Loaded<UsageHistoryRow[]> | null; onBack: () => void }) {
  return (
    <div className="space-y-5">
      <button type="button" onClick={onBack} className="inline-flex items-center gap-1.5 text-sm font-semibold text-primary-700"><ArrowLeft className="w-4 h-4" aria-hidden="true" /> All RTOs</button>
      <div>
        <h2 className="text-xl font-bold text-slate-900">{row.organisationName}</h2>
        <p className="text-sm text-slate-500">{row.planCode === 'llnd_mate_free' ? 'LLND Mate (Free)' : 'No confirmed plan'}</p>
      </div>
      <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
        {[
          ['Allowance used this month', row.monthlyAllowance == null ? '—' : `${row.monthNetUsage}/${row.monthlyAllowance}`],
          ['Sent this month (gross)', String(row.monthInvitationsSent)],
          ['Total sent (all time)', String(row.totalInvitationsSent)],
          ['Test Test (all time)', String(row.totalTestInvitations)],
          ['Deleted (currently)', String(row.deletedInvitations)],
          ['Restored', String(row.restoredAssessments)],
          ['Completed (genuine)', String(row.completedAssessments)],
          ['Remaining this month', row.monthRemaining == null ? '—' : String(row.monthRemaining)],
        ].map(([label, value]) => (
          <div key={label} className="rounded-xl border border-slate-200 bg-white p-3">
            <p className="text-[11px] font-semibold uppercase tracking-wide text-slate-500">{label}</p>
            <p className="text-lg font-bold text-slate-900 mt-1">{value}</p>
          </div>
        ))}
      </div>
      <div className="rounded-xl border border-slate-200 bg-white overflow-x-auto">
        <table className="w-full text-sm">
          <caption className="text-left font-bold text-slate-900 p-3">Last 12 months</caption>
          <thead className="bg-slate-50 text-slate-600 text-xs uppercase tracking-wide">
            <tr><th className="text-left p-2.5">Month</th><th className="text-right p-2.5">Sent</th><th className="text-right p-2.5">Returned by deletion</th><th className="text-right p-2.5">Allowance used</th><th className="text-right p-2.5">Test Test</th><th className="text-right p-2.5">Completed</th></tr>
          </thead>
          <tbody>
            {history?.kind === 'ok' ? history.data.map((h) => (
              <tr key={h.month} className="border-t border-slate-100">
                <td className="p-2.5">{new Date(h.month + 'T00:00:00Z').toLocaleDateString('en-AU', { month: 'long', year: 'numeric', timeZone: 'UTC' })}</td>
                <td className="p-2.5 text-right">{h.sent}</td><td className="p-2.5 text-right">{h.refunded}</td>
                <td className="p-2.5 text-right font-semibold">{h.net}</td><td className="p-2.5 text-right">{h.tests}</td><td className="p-2.5 text-right">{h.completed}</td>
              </tr>
            )) : (
              <tr><td colSpan={6} className="p-4 text-slate-500">{history ? 'History could not be loaded.' : 'Loading…'}</td></tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}

export function UsageTableView({ state, onOpen }: { state: Loaded<RtoUsageRow[]> | { kind: 'loading' }; onOpen: (row: RtoUsageRow) => void }) {
  if (state.kind === 'loading') return <div className="p-6 flex items-center gap-2 text-slate-500" role="status"><Loader2 className="w-4 h-4 animate-spin" aria-hidden="true" /> Loading…</div>;
  if (state.kind !== 'ok') return <StateNotice state={state} />;
  if (state.data.length === 0) return <p className="p-6 text-sm text-slate-500">No RTOs match this search.</p>;
  return (
    <div className="rounded-xl border border-slate-200 bg-white overflow-x-auto">
      <table className="w-full text-sm min-w-[900px]">
        <thead className="bg-slate-50 text-slate-600 text-xs uppercase tracking-wide">
          <tr>
            <th className="text-left p-2.5">RTO</th><th className="text-left p-2.5">Plan</th>
            <th className="text-right p-2.5">Total sent</th><th className="text-right p-2.5">Sent in month</th>
            <th className="text-right p-2.5">Allowance used</th><th className="text-right p-2.5">Remaining</th>
            <th className="text-right p-2.5">Test Test</th><th className="text-right p-2.5">Deleted</th>
            <th className="text-right p-2.5">Completed</th><th className="text-right p-2.5">Restored</th>
          </tr>
        </thead>
        <tbody>
          {state.data.map((r) => (
            <tr key={r.organisationId} className="border-t border-slate-100 hover:bg-slate-50">
              <td className="p-2.5">
                <button type="button" onClick={() => onOpen(r)} className="font-semibold text-primary-700 hover:underline text-left">{r.organisationName}</button>
                {!r.counterConsistent && <span className="ml-2 inline-flex items-center gap-1 text-[11px] font-semibold text-error-700"><AlertTriangle className="w-3 h-3" aria-hidden="true" />Check counts</span>}
              </td>
              <td className="p-2.5">{r.planCode === 'llnd_mate_free' ? 'LLND Mate (Free)' : <span className="text-error-700">Not confirmed</span>}</td>
              <td className="p-2.5 text-right">{r.totalInvitationsSent}</td>
              <td className="p-2.5 text-right">{r.monthInvitationsSent}</td>
              <td className="p-2.5 text-right font-semibold">{r.monthlyAllowance == null ? '—' : `${r.monthNetUsage}/${r.monthlyAllowance}`}</td>
              <td className="p-2.5 text-right">{r.monthRemaining ?? '—'}</td>
              <td className="p-2.5 text-right"><span className="text-amber-800">{r.monthTestInvitations}</span><span className="text-slate-400"> / {r.totalTestInvitations}</span></td>
              <td className="p-2.5 text-right">{r.deletedInvitations}</td>
              <td className="p-2.5 text-right">{r.completedAssessments}</td>
              <td className="p-2.5 text-right">{r.restoredAssessments}</td>
            </tr>
          ))}
        </tbody>
      </table>
      <p className="text-xs text-slate-500 p-3 border-t border-slate-100">
        Sent in month is gross (never reduced by deletion). Allowance used is net of deletions in the same month. Test Test shows this month / all time and never counts as usage.
      </p>
    </div>
  );
}

export function PlatformInvitationsUsagePage() {
  const [month, setMonth] = useState('');
  const [search, setSearch] = useState('');
  const [state, setState] = useState<Loaded<RtoUsageRow[]> | { kind: 'loading' }>({ kind: 'loading' });
  const [detail, setDetail] = useState<RtoUsageRow | null>(null);
  const [history, setHistory] = useState<Loaded<UsageHistoryRow[]> | null>(null);

  const load = useCallback(async () => {
    setState({ kind: 'loading' });
    setState(await fetchRtoUsage(monthParam(month), search));
  }, [month, search]);
  useEffect(() => { void load(); }, [load]);

  async function open(row: RtoUsageRow) {
    setDetail(row); setHistory(null);
    setHistory(await fetchUsageHistory(row.organisationId));
  }

  return (
    <div className="space-y-5 max-w-7xl">
      <div>
        <h1 className="text-2xl font-bold text-slate-900">Invitations &amp; Usage</h1>
        <p className="text-sm text-slate-500 mt-1">LLND Mate invitation usage by RTO. Platform operators only.</p>
      </div>
      {detail ? <UsageDetailView row={detail} history={history} onBack={() => setDetail(null)} /> : (
        <>
          <form className="flex flex-wrap gap-3 items-end" onSubmit={(e) => { e.preventDefault(); void load(); }}>
            <label className="text-sm"><span className="block text-xs font-semibold text-slate-600 mb-1">Search RTO</span>
              <span className="relative block"><Search className="w-4 h-4 absolute left-2.5 top-2.5 text-slate-400" aria-hidden="true" />
                <input value={search} onChange={(e) => setSearch(e.target.value)} className="input pl-8" placeholder="Organisation name" /></span></label>
            <label className="text-sm"><span className="block text-xs font-semibold text-slate-600 mb-1">Month</span>
              <input type="month" value={month} onChange={(e) => setMonth(e.target.value)} className="input" aria-label="Month (blank for the current month)" /></label>
          </form>
          <UsageTableView state={state} onOpen={open} />
        </>
      )}
    </div>
  );
}
