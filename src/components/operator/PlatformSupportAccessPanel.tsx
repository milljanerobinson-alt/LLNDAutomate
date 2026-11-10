// Issue #45 — shows RTO Administration every time LLND Automate platform
// support accessed this organisation: who (as platform support), why, when,
// and which kinds of information were viewed. No secrets or internal
// diagnostics are included; the database function returns only this RTO's
// rows and only to its Administration workspace.

import { useEffect, useState } from 'react';
import { LifeBuoy } from 'lucide-react';
import { listPlatformSupportAccess, SUPPORT_VIEW_LABELS, type PlatformSupportAccessRow } from '../../lib/platformOperator';

export function PlatformSupportAccessPanel() {
  const [rows, setRows] = useState<PlatformSupportAccessRow[] | null>(null);
  const [error, setError] = useState('');
  useEffect(() => { listPlatformSupportAccess().then(setRows).catch(e => { setRows([]); setError(e.message); }); }, []);

  return (
    <div className="bg-white border border-slate-200 rounded-2xl p-6" data-testid="platform-support-access">
      <div className="flex items-center gap-3 mb-2"><LifeBuoy className="w-5 h-5 text-primary-600" /><h2 className="font-semibold">Platform support access</h2></div>
      <p className="text-sm text-slate-500 mb-4">Times LLND Automate platform support viewed your organisation's information. Support access is read-only.</p>
      {rows === null ? <p className="text-sm text-slate-500">Loading…</p>
        : error ? <p className="text-sm text-red-600">Support access history couldn't be loaded.</p>
        : rows.length === 0 ? <p className="text-sm text-slate-500">Platform support hasn't accessed your organisation.</p>
        : (
          <ul className="divide-y divide-slate-100">
            {rows.map(r => (
              <li key={r.session_id} className="py-3 text-sm">
                <p className="font-medium text-slate-900">{r.operator_name}</p>
                <p className="text-slate-600">Reason: {r.reason}</p>
                <p className="text-slate-500">{new Date(r.started_at).toLocaleString()} – {new Date(r.ended_at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</p>
                <p className="text-slate-500">Viewed: {r.information_viewed.length ? r.information_viewed.map(v => SUPPORT_VIEW_LABELS[v] ?? v).join(', ') : 'nothing'}</p>
              </li>
            ))}
          </ul>
        )}
    </div>
  );
}
