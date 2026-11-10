// Issue #45 — read-only RTO support for platform operators.
//
// The operator picks one RTO and gives a reason; the session lasts up to 60
// minutes. Views come from the operator-support Edge Function, which takes the
// RTO from the session (never from the browser), records every view in the
// RTO-visible log, and returns customer-safe summaries only.

import { useEffect, useState } from 'react';
import { LifeBuoy } from 'lucide-react';
import { usePlatformOperator } from '../../components/operator/PlatformOperatorGate';
import {
  SUPPORT_VIEWS, fetchSupportView, listOrganisationsForSupport, startSupportSession, type SupportViewId,
} from '../../lib/platformOperator';

export function OperatorSupportPage() {
  const { status, refresh } = usePlatformOperator();
  const session = status.session;
  const [orgs, setOrgs] = useState<Array<{ organisation_id: string; organisation_name: string }>>([]);
  const [orgId, setOrgId] = useState('');
  const [reason, setReason] = useState('');
  const [minutes, setMinutes] = useState(60);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [view, setView] = useState<SupportViewId | null>(null);
  const [viewData, setViewData] = useState<unknown>(null);

  useEffect(() => { listOrganisationsForSupport().then(setOrgs).catch(e => setError(e.message)); }, []);
  useEffect(() => { setView(null); setViewData(null); }, [session?.session_id]);

  async function start() {
    if (!orgId) { setError('Choose the RTO you are supporting.'); return; }
    if (reason.trim().length < 10) { setError('Give a reason of at least 10 characters. The RTO can see it.'); return; }
    setBusy(true); setError('');
    try { await startSupportSession(orgId, reason.trim(), minutes); setReason(''); await refresh(); }
    catch (e) { setError((e as Error).message); }
    finally { setBusy(false); }
  }

  async function open(id: SupportViewId) {
    if (!session) return;
    setView(id); setViewData(null); setError('');
    try { setViewData(await fetchSupportView(id, session.organisation_id)); }
    catch (e) { setError((e as Error).message); await refresh(); }
  }

  return (
    <div className="max-w-5xl mx-auto px-4 py-8 space-y-6" data-testid="operator-support-page">
      <div className="flex items-center gap-3">
        <LifeBuoy className="w-6 h-6 text-primary-600" />
        <div>
          <h1 className="text-2xl font-bold text-slate-900">RTO support</h1>
          <p className="text-sm text-slate-500">Read-only. Each view is recorded and shown to the RTO's Administration team.</p>
        </div>
      </div>

      {!session ? (
        <div className="bg-white border border-slate-200 rounded-2xl p-6 space-y-4">
          <h2 className="font-semibold">Start a support session</h2>
          <label className="block text-sm font-medium text-slate-700">RTO
            <select value={orgId} onChange={e => setOrgId(e.target.value)} className="mt-1 w-full border border-slate-300 rounded-lg px-3 py-2" aria-label="RTO">
              <option value="">Choose an RTO…</option>
              {orgs.map(o => <option key={o.organisation_id} value={o.organisation_id}>{o.organisation_name}</option>)}
            </select>
          </label>
          <label className="block text-sm font-medium text-slate-700">Reason (visible to the RTO)
            <textarea value={reason} onChange={e => setReason(e.target.value)} rows={2} className="mt-1 w-full border border-slate-300 rounded-lg px-3 py-2" aria-label="Reason" />
          </label>
          <label className="block text-sm font-medium text-slate-700">Length
            <select value={minutes} onChange={e => setMinutes(Number(e.target.value))} className="mt-1 border border-slate-300 rounded-lg px-3 py-2" aria-label="Length">
              {[15, 30, 45, 60].map(m => <option key={m} value={m}>{m} minutes</option>)}
            </select>
          </label>
          <button onClick={start} disabled={busy} className="px-4 py-2 bg-primary-600 text-white rounded-lg text-sm font-semibold disabled:opacity-50">
            {busy ? 'Starting…' : 'Start support session'}
          </button>
        </div>
      ) : (
        <div className="grid md:grid-cols-[220px_1fr] gap-4">
          <nav className="bg-white border border-slate-200 rounded-2xl p-2 space-y-1" aria-label="Support views">
            {SUPPORT_VIEWS.map(v => (
              <button key={v.id} onClick={() => open(v.id)}
                className={`w-full text-left px-3 py-2 rounded-lg text-sm ${view === v.id ? 'bg-primary-50 text-primary-700 font-semibold' : 'text-slate-700 hover:bg-slate-50'}`}>
                {v.label}
              </button>
            ))}
          </nav>
          <section className="bg-white border border-slate-200 rounded-2xl p-4 min-h-[200px] overflow-auto" data-testid="support-view">
            {!view && <p className="text-sm text-slate-500">Choose a view. Reason for this session: {session.reason}</p>}
            {view && viewData === null && !error && <p className="text-sm text-slate-500">Loading…</p>}
            {view && viewData !== null && <SupportViewData data={viewData} />}
          </section>
        </div>
      )}
      {error && <p className="text-sm text-red-600" role="alert">{error}</p>}
    </div>
  );
}

function SupportViewData({ data }: { data: unknown }) {
  if (Array.isArray(data)) {
    if (data.length === 0) return <p className="text-sm text-slate-500">Nothing to show.</p>;
    const cols = Array.from(new Set(data.flatMap(r => Object.keys(r as object))));
    return (
      <table className="w-full text-sm">
        <thead><tr>{cols.map(c => <th key={c} className="text-left font-semibold text-slate-600 px-2 py-1 border-b">{c.replace(/_/g, ' ')}</th>)}</tr></thead>
        <tbody>{data.map((r, i) => <tr key={i}>{cols.map(c => <td key={c} className="px-2 py-1 border-b border-slate-100">{display((r as Record<string, unknown>)[c])}</td>)}</tr>)}</tbody>
      </table>
    );
  }
  if (data && typeof data === 'object') {
    return (
      <dl className="grid grid-cols-[max-content_1fr] gap-x-4 gap-y-1 text-sm">
        {Object.entries(data as Record<string, unknown>).map(([k, v]) => (
          <div key={k} className="contents"><dt className="text-slate-500">{k.replace(/_/g, ' ')}</dt><dd className="text-slate-900">{display(v)}</dd></div>
        ))}
      </dl>
    );
  }
  return <p className="text-sm">{display(data)}</p>;
}

function display(v: unknown): string {
  if (v === null || v === undefined || v === '') return '—';
  if (typeof v === 'boolean') return v ? 'Yes' : 'No';
  if (Array.isArray(v)) return v.join(', ');
  if (typeof v === 'object') return Object.entries(v as Record<string, unknown>).map(([k, x]) => `${k}: ${display(x)}`).join('; ');
  return String(v);
}
