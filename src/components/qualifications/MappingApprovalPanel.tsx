// ACSF mapping approval for one qualification: current state, any recorded
// training.gov.au change and what changed, an Approve action for
// Administration, and the full decision history. Approval covers the CURRENT
// ACSF levels; it lasts until a relevant change is recorded or the levels
// change — never just because time has passed.

import { useCallback, useEffect, useState } from 'react';
import { ShieldCheck, AlertTriangle } from 'lucide-react';
import { supabase } from '../../lib/supabase';

interface ApprovalRow {
  id: string;
  decision: string;
  requirements_snapshot: Array<{ acsf_skill: string | null; domain: string; minimum_acsf_level: number }>;
  source_release: string | null;
  change_details: Record<string, unknown> | null;
  reason: string | null;
  decided_by_name: string | null;
  decided_at: string;
}

interface QualSource {
  code: string;
  source_release: string | null;
  source_check_status: string | null;
  source_checked_at: string | null;
  mapping_change_detected_at: string | null;
  mapping_change_summary: { changes?: string[] } | null;
}

const DECISION_LABEL: Record<string, string> = {
  approved: 'Approved',
  migrated_approval: 'Approval carried over',
  review_required: 'Review required — training.gov.au change',
};

function levels(snapshot: ApprovalRow['requirements_snapshot']): string {
  return (snapshot ?? []).map(r => `${r.acsf_skill ?? r.domain} ${r.minimum_acsf_level}`).join(', ') || 'no levels';
}

export function MappingApprovalPanel({ qualificationId, onChanged }: { qualificationId: string; onChanged?: () => void }) {
  const [history, setHistory] = useState<ApprovalRow[]>([]);
  const [source, setSource] = useState<QualSource | null>(null);
  const [release, setRelease] = useState('');
  const [note, setNote] = useState('');
  const [message, setMessage] = useState('');
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    const [{ data: rows }, { data: q }] = await Promise.all([
      supabase.from('qualification_mapping_approvals')
        .select('id, decision, requirements_snapshot, source_release, change_details, reason, decided_by_name, decided_at')
        .eq('qualification_id', qualificationId).order('decided_at', { ascending: false }).limit(20),
      supabase.from('qualifications')
        .select('code, source_release, source_check_status, source_checked_at, mapping_change_detected_at, mapping_change_summary')
        .eq('id', qualificationId).maybeSingle(),
    ]);
    setHistory((rows ?? []) as ApprovalRow[]);
    setSource((q ?? null) as QualSource | null);
    setRelease((q as QualSource | null)?.source_release ?? '');
  }, [qualificationId]);
  useEffect(() => { load(); }, [load]);

  async function approve() {
    setBusy(true); setMessage('');
    const { error } = await supabase.rpc('approve_qualification_mapping', {
      p_qualification_id: qualificationId, p_source_release: release, p_note: note,
    });
    setBusy(false);
    if (error) { setMessage(error.message); return; }
    setNote(''); setMessage('Mapping approved.');
    await load(); onChanged?.();
  }

  const changed = !!source?.mapping_change_detected_at;
  const latestApproval = history.find(h => h.decision === 'approved' || h.decision === 'migrated_approval');

  return (
    <div className="mt-4 border border-slate-200 rounded-lg p-4 space-y-3" data-testid="mapping-approval">
      <div className="flex items-center gap-2">
        {changed ? <AlertTriangle className="w-4 h-4 text-amber-600" /> : <ShieldCheck className="w-4 h-4 text-emerald-600" />}
        <p className="text-sm font-semibold text-slate-800">ACSF mapping approval</p>
      </div>
      {changed ? (
        <div className="bg-amber-50 border border-amber-200 rounded-lg p-3 text-sm text-amber-900" role="status">
          <p className="font-medium">Needs review: this qualification changed on training.gov.au.</p>
          <ul className="list-disc ml-5 mt-1">
            {(source?.mapping_change_summary?.changes ?? ['details not recorded']).map((c, i) => <li key={i}>{c}</li>)}
          </ul>
          <p className="mt-1">Earlier results for this course aren't reused automatically until you review and approve the mapping again. Your approved levels have not been changed.</p>
        </div>
      ) : latestApproval ? (
        <p className="text-sm text-slate-600">
          Approved by {latestApproval.decided_by_name || 'RTO staff'} on {new Date(latestApproval.decided_at).toLocaleDateString('en-AU')}
          {latestApproval.source_release ? ` (release ${latestApproval.source_release})` : ''}. Levels: {levels(latestApproval.requirements_snapshot)}.
        </p>
      ) : (
        <p className="text-sm text-slate-600">Not approved yet. Earlier results aren't reused for this course until the mapping is approved.</p>
      )}
      <p className="text-xs text-slate-500">
        training.gov.au check: {source?.source_check_status ?? 'unchecked'}
        {source?.source_checked_at ? ` (${new Date(source.source_checked_at).toLocaleString('en-AU')})` : ''}.
        A failed check is shown as “unavailable” and is never treated as “no change”.
      </p>
      <div className="grid sm:grid-cols-[1fr_2fr_auto] gap-2 items-end">
        <label className="text-xs font-medium text-slate-600">Release reviewed
          <input value={release} onChange={e => setRelease(e.target.value)} placeholder="e.g. 2" aria-label="Release reviewed" className="mt-1 w-full border border-slate-300 rounded-lg px-2 py-1.5 text-sm" />
        </label>
        <label className="text-xs font-medium text-slate-600">Note (optional)
          <input value={note} onChange={e => setNote(e.target.value)} aria-label="Approval note" className="mt-1 w-full border border-slate-300 rounded-lg px-2 py-1.5 text-sm" />
        </label>
        <button onClick={approve} disabled={busy} className="px-3 py-1.5 bg-primary-600 text-white rounded-lg text-sm font-semibold disabled:opacity-50">
          Approve current levels
        </button>
      </div>
      {message && <p className="text-xs text-slate-600">{message}</p>}
      {history.length > 0 && (
        <details>
          <summary className="text-xs font-medium text-slate-600 cursor-pointer">Decision history ({history.length})</summary>
          <ul className="mt-2 space-y-1">
            {history.map(h => (
              <li key={h.id} className="text-xs text-slate-600">
                {new Date(h.decided_at).toLocaleDateString('en-AU')} — {DECISION_LABEL[h.decision] ?? h.decision}
                {h.decided_by_name ? ` by ${h.decided_by_name}` : ''}{h.source_release ? `, release ${h.source_release}` : ''}: {levels(h.requirements_snapshot)}
                {h.reason ? ` — ${h.reason}` : ''}
              </li>
            ))}
          </ul>
        </details>
      )}
    </div>
  );
}
