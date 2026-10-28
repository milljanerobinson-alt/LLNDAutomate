import { useEffect, useState } from 'react';
import {
  ArrowDownToLine, Search, CheckCircle2, XCircle, Clock,
  SkipForward, RefreshCw, Loader2, ChevronDown, ChevronRight,
  User, Mail, BookOpen, Info, RotateCcw, Eye, Plus, Trash2,
} from 'lucide-react';
import { supabase } from '../lib/supabase';

interface SyncLog {
  id: string;
  axcelerate_contact_id: number;
  assessment_type: string;
  qualification_id: string | null;
  axcelerate_course_id: number | null;
  idempotency_key: string;
  status: string;
  invitation_id: string | null;
  lln_invitation_id: string | null;
  digital_invitation_id: string | null;
  contact_name: string | null;
  contact_email: string | null;
  note_text: string | null;
  note_written: boolean;
  error: string | null;
  validity_checks?: Array<{ type: string; action: string; status: string | null; reason: string | null; completed_at: string | null; valid_until: string | null }> | null;
  processed_at: string;
  created_at: string;
}

const STATUS_CONFIG: Record<string, { label: string; color: string; icon: typeof CheckCircle2 }> = {
  created:    { label: 'Created',    color: 'bg-emerald-100 text-emerald-700', icon: CheckCircle2 },
  skipped:    { label: 'Skipped',    color: 'bg-slate-100 text-slate-600',     icon: SkipForward  },
  pending:    { label: 'Pending',    color: 'bg-amber-100 text-amber-700',     icon: Clock        },
  processing: { label: 'Processing', color: 'bg-blue-100 text-blue-700',       icon: RefreshCw    },
  failed:     { label: 'Failed',     color: 'bg-red-100 text-red-700',         icon: XCircle      },
  review_required: { label: 'Review required', color: 'bg-amber-100 text-amber-800', icon: Eye },
  error:      { label: 'Error',      color: 'bg-red-100 text-red-700',         icon: XCircle      },
};

const CHECK_LABELS: Record<string, string> = {
  valid: 'Previous result reused',
  expired: 'Previous result expired — reassessed',
  insufficient: 'Previous result insufficient — reassessed',
  unverifiable: 'Not accepted automatically',
  not_configured: 'Validity period not set',
};

function StatusBadge({ status }: { status: string }) {
  const cfg = STATUS_CONFIG[status] ?? { label: status, color: 'bg-slate-100 text-slate-600', icon: Info };
  const Icon = cfg.icon;
  return (
    <span className={`inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs font-medium ${cfg.color}`}>
      <Icon className="w-3 h-3" />
      {cfg.label}
    </span>
  );
}

function fmt(ts: string) {
  return new Date(ts).toLocaleString('en-AU', {
    day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit',
  });
}

export function AxcelerateInboundPage() {
  const [logs, setLogs] = useState<SyncLog[]>([]);
  const [loading, setLoading] = useState(true);
  const [expandedId, setExpandedId] = useState<string | null>(null);

  // Sync form
  const [contactId, setContactId] = useState('');
  const [courseId, setCourseId] = useState('');
  const [syncing, setSyncing] = useState(false);
  const [syncResult, setSyncResult] = useState<{ ok: boolean; message: string } | null>(null);

  // Watch list
  const [watchList, setWatchList] = useState<number[]>([]);
  const [watchListLoading, setWatchListLoading] = useState(true);
  const [addWatchId, setAddWatchId] = useState('');
  const [addingWatch, setAddingWatch] = useState(false);
  const [watchResult, setWatchResult] = useState<{ ok: boolean; message: string } | null>(null);
  const [removingId, setRemovingId] = useState<number | null>(null);

  // Per-row reset state
  const [resettingId, setResettingId] = useState<string | null>(null);
  const [resetResults, setResetResults] = useState<Record<string, { ok: boolean; message: string }>>({});

  useEffect(() => {
    loadLogs();
    loadWatchList();
  }, []);

  async function loadLogs() {
    setLoading(true);
    const { data } = await supabase
      .from('axcelerate_inbound_sync_log')
      .select('*')
      .order('processed_at', { ascending: false })
      .limit(100);
    setLogs((data || []) as SyncLog[]);
    setLoading(false);
  }

  async function loadWatchList() {
    setWatchListLoading(true);
    const { data } = await supabase
      .from('organisation_settings')
      .select('value')
      .eq('key', 'axcelerate_contact_watch_list')
      .maybeSingle();
    const ids = Array.isArray(data?.value) ? (data.value as number[]) : [];
    setWatchList(ids);
    setWatchListLoading(false);
  }

  async function saveWatchList(ids: number[]) {
    const { error } = await supabase.rpc('set_organisation_setting', { p_key: 'axcelerate_contact_watch_list', p_value: ids });
    if (error) throw error;
  }

  async function handleAddWatch(e: React.FormEvent) {
    e.preventDefault();
    const id = parseInt(addWatchId.trim(), 10);
    if (!id || isNaN(id) || id <= 0) {
      setWatchResult({ ok: false, message: 'Please enter a valid numeric Contact ID.' });
      return;
    }
    if (watchList.includes(id)) {
      setWatchResult({ ok: false, message: `Contact ${id} is already in the watch list.` });
      return;
    }

    setAddingWatch(true);
    setWatchResult(null);

    try {
      const newList = [...watchList, id];
      await saveWatchList(newList);
      setWatchList(newList);
      setAddWatchId('');

      // Immediately trigger inbound sync so the contact appears in the log
      const { data: { session } } = await supabase.auth.getSession();
      if (session?.access_token) {
        const res = await fetch(
          `${import.meta.env.VITE_SUPABASE_URL}/functions/v1/axcelerate-inbound-sync`,
          {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              'Authorization': `Bearer ${session.access_token}`,
              'Apikey': import.meta.env.VITE_SUPABASE_ANON_KEY,
            },
            body: JSON.stringify({ contact_id: id }),
          },
        );
        const data = await res.json();
        if (res.ok) {
          const lln = data.lln_action || 'none';
          const digital = data.digital_action || 'none';
          const msg = data.message === 'No action required'
            ? `Contact ${id} added to watch list. No assessment fields set yet — will be checked automatically every 5 minutes.`
            : `Contact ${id} added and synced: ${data.contact_name || `Contact ${id}`} — LLN: ${lln}, Digital: ${digital}.${data.new_invitation_id ? ' Invitation created.' : ''}`;
          setWatchResult({ ok: true, message: msg });
          await loadLogs();
        } else {
          setWatchResult({ ok: true, message: `Contact ${id} added to watch list. Initial sync failed: ${data.error || 'unknown error'} — will retry automatically.` });
        }
      } else {
        setWatchResult({ ok: true, message: `Contact ${id} added to watch list. Bulk sync will check it within 5 minutes.` });
      }
    } catch (err: any) {
      setWatchResult({ ok: false, message: err.message || 'Failed to add contact.' });
    } finally {
      setAddingWatch(false);
    }
  }

  async function handleRemoveWatch(id: number) {
    setRemovingId(id);
    try {
      const newList = watchList.filter(w => w !== id);
      await saveWatchList(newList);
      setWatchList(newList);
    } finally {
      setRemovingId(null);
    }
  }

  async function handleSync(e: React.FormEvent) {
    e.preventDefault();
    const id = parseInt(contactId.trim(), 10);
    if (!id || isNaN(id)) {
      setSyncResult({ ok: false, message: 'Please enter a valid numeric Contact ID.' });
      return;
    }

    setSyncing(true);
    setSyncResult(null);

    try {
      const { data: { session } } = await supabase.auth.getSession();
      if (!session?.access_token) throw new Error('No active session');

      const body: Record<string, unknown> = { contact_id: id };
      const parsed = parseInt(courseId.trim(), 10);
      if (!isNaN(parsed) && parsed > 0) body.axcelerate_course_id = parsed;

      const res = await fetch(
        `${import.meta.env.VITE_SUPABASE_URL}/functions/v1/axcelerate-inbound-sync`,
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${session.access_token}`,
            'Apikey': import.meta.env.VITE_SUPABASE_ANON_KEY,
          },
          body: JSON.stringify(body),
        },
      );

      const data = await res.json();

      if (res.ok) {
        let msg: string;
        if (data.message === 'No action required') {
          const debug = data.custom_fields_debug;
          const debugStr = debug
            ? ` (custom fields: ${JSON.stringify(debug).slice(0, 200)})`
            : '';
          msg = `No action taken for contact ${id} — neither lln_quiz_required nor digital_quiz_required was "Yes".${debugStr}`;
        } else if (data.status === 'review_required') {
          msg = `Held for review — a previous result could not be accepted automatically (LLN: ${data.lln_action || 'none'}, Digital: ${data.digital_action || 'none'}). See the log entry for the reason.`;
        } else if (data.status === 'skipped' || data.message === 'Already processed') {
          msg = `Already processed — no new action taken (${data.lln_action || 'none'} / ${data.digital_action || 'none'}).`;
        } else {
          const lln = data.lln_action || 'none';
          const digital = data.digital_action || 'none';
          msg = `Success: ${data.contact_name || `Contact ${id}`} — LLN: ${lln}, Digital: ${digital}.${data.new_invitation_id ? ' New invitation created.' : ''}`;
        }
        setSyncResult({ ok: true, message: msg });
        await loadLogs();
      } else {
        setSyncResult({ ok: false, message: data.error || `HTTP ${res.status}` });
      }
    } catch (err: any) {
      setSyncResult({ ok: false, message: err.message || 'Request failed' });
    } finally {
      setSyncing(false);
    }
  }

  async function handleReset(log: SyncLog) {
    setResettingId(log.id);
    setResetResults((prev) => {
      const next = { ...prev };
      delete next[log.id];
      return next;
    });

    try {
      const { error: delError } = await supabase
        .from('axcelerate_inbound_sync_log')
        .delete()
        .eq('id', log.id);

      if (delError) throw new Error(delError.message);

      const { data: { session } } = await supabase.auth.getSession();
      if (!session?.access_token) throw new Error('No active session');

      const body: Record<string, unknown> = { contact_id: log.axcelerate_contact_id };
      if (log.axcelerate_course_id) body.axcelerate_course_id = log.axcelerate_course_id;

      const res = await fetch(
        `${import.meta.env.VITE_SUPABASE_URL}/functions/v1/axcelerate-inbound-sync`,
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${session.access_token}`,
            'Apikey': import.meta.env.VITE_SUPABASE_ANON_KEY,
          },
          body: JSON.stringify(body),
        },
      );

      const data = await res.json();
      await loadLogs();
      setExpandedId(null);

      if (res.ok) {
        const lln = data.lln_action || 'none';
        const digital = data.digital_action || 'none';
        const msg = data.message === 'No action required'
          ? `No action taken — custom fields not set to "Yes".`
          : `Re-sync complete: ${data.contact_name || `Contact ${log.axcelerate_contact_id}`} — LLN: ${lln}, Digital: ${digital}.${data.new_invitation_id ? ' New invitation created.' : ''}`;
        setSyncResult({ ok: true, message: msg });
      } else {
        setSyncResult({ ok: false, message: data.error || `HTTP ${res.status}` });
      }
    } catch (err: any) {
      setResetResults((prev) => ({
        ...prev,
        [log.id]: { ok: false, message: err.message || 'Reset failed' },
      }));
    } finally {
      setResettingId(null);
    }
  }

  // Get names for watch list entries from the sync log
  const logByContactId = Object.fromEntries(
    logs
      .filter(l => l.contact_name)
      .map(l => [l.axcelerate_contact_id, l])
  );

  return (
    <div className="space-y-6">
      {/* Header */}
      <div>
        <h2 className="text-xl font-semibold text-slate-900">aXcelerate Inbound Sync</h2>
        <p className="text-sm text-slate-500 mt-1">
          Sync learners from aXcelerate into the LLND Automate Portal based on their custom field settings.
          Checks <code className="font-mono bg-slate-100 px-1 rounded">lln_quiz_required</code> and{' '}
          <code className="font-mono bg-slate-100 px-1 rounded">digital_quiz_required</code> and
          issues only the assessments required.
        </p>
      </div>

      {/* Watch List */}
      <div className="bg-white border border-slate-200 rounded-xl p-5">
        <div className="flex items-center justify-between mb-1">
          <h3 className="text-sm font-semibold text-slate-900 flex items-center gap-2">
            <Eye className="w-4 h-4 text-slate-500" />
            Contact Watch List
          </h3>
          <span className="text-xs text-slate-400">
            Checked automatically every 5 minutes
          </span>
        </div>
        <p className="text-xs text-slate-500 mb-4">
          Contacts added here are always monitored by the bulk sync, regardless of whether they appear in the aXcelerate API list. Add a contact once — the portal will automatically detect when their quiz fields are set.
        </p>

        <form onSubmit={handleAddWatch} className="flex gap-2 mb-4">
          <input
            type="number"
            min="1"
            value={addWatchId}
            onChange={(e) => setAddWatchId(e.target.value)}
            className="input flex-1"
            placeholder="aXcelerate Contact ID"
            disabled={addingWatch}
          />
          <button
            type="submit"
            disabled={addingWatch || !addWatchId.trim()}
            className="btn-primary flex items-center gap-1.5 flex-shrink-0"
          >
            {addingWatch
              ? <Loader2 className="w-4 h-4 animate-spin" />
              : <Plus className="w-4 h-4" />}
            {addingWatch ? 'Adding…' : 'Add & Sync'}
          </button>
        </form>

        {watchResult && (
          <div className={`flex items-start gap-2 p-3 rounded-lg text-sm mb-3 ${
            watchResult.ok
              ? 'bg-emerald-50 border border-emerald-200 text-emerald-800'
              : 'bg-red-50 border border-red-200 text-red-700'
          }`}>
            {watchResult.ok
              ? <CheckCircle2 className="w-4 h-4 mt-0.5 flex-shrink-0" />
              : <XCircle className="w-4 h-4 mt-0.5 flex-shrink-0" />}
            <span>{watchResult.message}</span>
          </div>
        )}

        {watchListLoading ? (
          <div className="flex items-center gap-2 text-sm text-slate-400 py-2">
            <Loader2 className="w-4 h-4 animate-spin" />
            Loading watch list…
          </div>
        ) : watchList.length === 0 ? (
          <div className="text-center py-6 border border-dashed border-slate-200 rounded-lg">
            <Eye className="w-6 h-6 text-slate-300 mx-auto mb-2" />
            <p className="text-sm text-slate-400">No contacts in watch list.</p>
            <p className="text-xs text-slate-400 mt-0.5">Add a Contact ID above to start monitoring.</p>
          </div>
        ) : (
          <div className="divide-y divide-slate-100 border border-slate-200 rounded-lg overflow-hidden">
            {watchList.map((id) => {
              const log = logByContactId[id];
              return (
                <div key={id} className="flex items-center gap-3 px-4 py-3 bg-white hover:bg-slate-50">
                  <User className="w-4 h-4 text-slate-400 flex-shrink-0" />
                  <div className="flex-1 min-w-0">
                    <span className="text-sm font-medium text-slate-900">
                      {log?.contact_name || `Contact ${id}`}
                    </span>
                    <span className="text-xs text-slate-400 ml-2">#{id}</span>
                    {log?.contact_email && (
                      <span className="text-xs text-slate-400 ml-2">· {log.contact_email}</span>
                    )}
                  </div>
                  {log && (
                    <StatusBadge status={log.status} />
                  )}
                  <button
                    onClick={() => handleRemoveWatch(id)}
                    disabled={removingId === id}
                    className="p-1.5 rounded-md text-slate-400 hover:text-red-500 hover:bg-red-50 transition-colors disabled:opacity-50"
                    title="Remove from watch list"
                  >
                    {removingId === id
                      ? <Loader2 className="w-3.5 h-3.5 animate-spin" />
                      : <Trash2 className="w-3.5 h-3.5" />}
                  </button>
                </div>
              );
            })}
          </div>
        )}
      </div>

      {/* Manual Sync form */}
      <div className="bg-white border border-slate-200 rounded-xl p-5">
        <h3 className="text-sm font-semibold text-slate-900 mb-4 flex items-center gap-2">
          <ArrowDownToLine className="w-4 h-4 text-slate-500" />
          Manual One-Off Sync
        </h3>

        <form onSubmit={handleSync} className="space-y-4">
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            <div>
              <label className="label" htmlFor="contact-id">
                aXcelerate Contact ID <span className="text-red-500">*</span>
              </label>
              <input
                id="contact-id"
                type="number"
                min="1"
                required
                value={contactId}
                onChange={(e) => setContactId(e.target.value)}
                className="input"
                placeholder="e.g. 123456"
                disabled={syncing}
              />
              <p className="text-xs text-slate-400 mt-1">
                Found on the aXcelerate contact record.
              </p>
            </div>
            <div>
              <label className="label" htmlFor="course-id">
                aXcelerate Course ID <span className="text-slate-400 font-normal">(recommended)</span>
              </label>
              <input
                id="course-id"
                type="number"
                min="1"
                value={courseId}
                onChange={(e) => setCourseId(e.target.value)}
                className="input"
                placeholder="e.g. 789012"
                disabled={syncing}
              />
              <p className="text-xs text-slate-400 mt-1">
                Used to match the qualification and check ACSF requirements.
              </p>
            </div>
          </div>

          {syncResult && (
            <div className={`flex items-start gap-2 p-3 rounded-lg text-sm ${
              syncResult.ok
                ? 'bg-emerald-50 border border-emerald-200 text-emerald-800'
                : 'bg-red-50 border border-red-200 text-red-700'
            }`}>
              {syncResult.ok
                ? <CheckCircle2 className="w-4 h-4 mt-0.5 flex-shrink-0" />
                : <XCircle className="w-4 h-4 mt-0.5 flex-shrink-0" />}
              <span>{syncResult.message}</span>
            </div>
          )}

          <div className="flex items-center gap-3">
            <button type="submit" className="btn-primary flex items-center gap-2" disabled={syncing}>
              {syncing ? <Loader2 className="w-4 h-4 animate-spin" /> : <ArrowDownToLine className="w-4 h-4" />}
              {syncing ? 'Syncing…' : 'Sync Now'}
            </button>
            <button type="button" onClick={() => { setContactId(''); setCourseId(''); setSyncResult(null); }}
              className="btn-ghost text-sm" disabled={syncing}>
              Clear
            </button>
          </div>
        </form>
      </div>

      {/* How it works */}
      <div className="bg-blue-50 border border-blue-200 rounded-xl p-4">
        <h4 className="text-sm font-semibold text-blue-900 mb-2 flex items-center gap-2">
          <Info className="w-4 h-4" />
          How inbound sync works
        </h4>
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 text-xs text-blue-800">
          <div className="space-y-1">
            <p className="font-medium">Trigger logic</p>
            <p>• <code className="bg-blue-100 px-1 rounded">lln_quiz_required = Yes</code> → issues LLN assessment</p>
            <p>• <code className="bg-blue-100 px-1 rounded">digital_quiz_required = Yes</code> → issues Digital assessment</p>
            <p>• Both set → issues both (one invitation record)</p>
            <p>• Neither set → no action taken</p>
          </div>
          <div className="space-y-1">
            <p className="font-medium">Duplicate protection</p>
            <p>• Matches learners by name + date of birth (or email fallback)</p>
            <p>• Checks if a current valid assessment already exists</p>
            <p>• Validates existing results meet the qualification's ACSF requirements</p>
            <p>• Fully idempotent — safe to re-run</p>
          </div>
        </div>
      </div>

      {/* Log table */}
      <div className="bg-white border border-slate-200 rounded-xl overflow-hidden">
        <div className="flex items-center justify-between px-5 py-4 border-b border-slate-200">
          <h3 className="text-sm font-semibold text-slate-900">Sync History</h3>
          <button onClick={loadLogs} className="btn-ghost text-sm flex items-center gap-1.5" disabled={loading}>
            <RefreshCw className={`w-3.5 h-3.5 ${loading ? 'animate-spin' : ''}`} />
            Refresh
          </button>
        </div>

        {loading ? (
          <div className="flex items-center justify-center py-12 text-slate-400">
            <Loader2 className="w-5 h-5 animate-spin mr-2" />
            Loading sync history…
          </div>
        ) : logs.filter(l => l.assessment_type !== 'none').length === 0 ? (
          <div className="text-center py-12">
            <Search className="w-8 h-8 text-slate-300 mx-auto mb-3" />
            <p className="text-slate-500 text-sm">No sync records yet.</p>
            <p className="text-slate-400 text-xs mt-1">Add a contact to the watch list or use Manual Sync above.</p>
          </div>
        ) : (
          <div className="divide-y divide-slate-100">
            {logs.filter(l => l.assessment_type !== 'none').map((log) => {
              const expanded = expandedId === log.id;
              return (
                <div key={log.id}>
                  <button
                    onClick={() => setExpandedId(expanded ? null : log.id)}
                    className="w-full flex items-center gap-3 px-5 py-3.5 hover:bg-slate-50 transition-colors text-left"
                  >
                    {expanded
                      ? <ChevronDown className="w-4 h-4 text-slate-400 flex-shrink-0" />
                      : <ChevronRight className="w-4 h-4 text-slate-400 flex-shrink-0" />}

                    <div className="flex-1 min-w-0 grid grid-cols-1 sm:grid-cols-4 gap-2 items-center">
                      <div className="flex items-center gap-2 min-w-0">
                        <User className="w-3.5 h-3.5 text-slate-400 flex-shrink-0" />
                        <span className="text-sm font-medium text-slate-900 truncate">
                          {log.contact_name || `Contact ${log.axcelerate_contact_id}`}
                        </span>
                      </div>
                      <div className="flex items-center gap-1.5 text-xs text-slate-500">
                        <Mail className="w-3 h-3 flex-shrink-0" />
                        <span className="truncate">{log.contact_email || '—'}</span>
                      </div>
                      <div className="flex items-center gap-2">
                        <span className="text-xs text-slate-400">
                          #{log.axcelerate_contact_id}
                          {log.axcelerate_course_id ? ` · Course ${log.axcelerate_course_id}` : ''}
                        </span>
                        <span className={`inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs font-medium ${
                          log.assessment_type === 'both' ? 'bg-violet-100 text-violet-700' :
                          log.assessment_type === 'lln' ? 'bg-blue-100 text-blue-700' :
                          log.assessment_type === 'digital' ? 'bg-teal-100 text-teal-700' :
                          'bg-slate-100 text-slate-600'
                        }`}>
                          <BookOpen className="w-3 h-3" />
                          {log.assessment_type.toUpperCase()}
                        </span>
                      </div>
                      <div className="flex items-center justify-between gap-2">
                        <StatusBadge status={log.status} />
                        <span className="text-xs text-slate-400 flex-shrink-0">{fmt(log.processed_at)}</span>
                      </div>
                    </div>
                  </button>

                  {expanded && (
                    <div className="px-12 pb-4 space-y-3 bg-slate-50 border-t border-slate-100">
                      <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 pt-3">
                        <div>
                          <p className="text-xs font-medium text-slate-500 mb-0.5">Contact ID</p>
                          <p className="text-sm text-slate-800 font-mono">{log.axcelerate_contact_id}</p>
                        </div>
                        {log.axcelerate_course_id && (
                          <div>
                            <p className="text-xs font-medium text-slate-500 mb-0.5">Course ID</p>
                            <p className="text-sm text-slate-800 font-mono">{log.axcelerate_course_id}</p>
                          </div>
                        )}
                        <div>
                          <p className="text-xs font-medium text-slate-500 mb-0.5">Note Written</p>
                          <p className={`text-sm font-medium ${log.note_written ? 'text-emerald-600' : 'text-amber-600'}`}>
                            {log.note_written ? 'Yes' : 'No'}
                          </p>
                        </div>
                        <div>
                          <p className="text-xs font-medium text-slate-500 mb-0.5">New Invitation</p>
                          <p className="text-sm text-slate-800 font-mono text-xs">
                            {log.invitation_id ? log.invitation_id.slice(0, 8) + '…' : '—'}
                          </p>
                        </div>
                      </div>

                      {(log.validity_checks ?? []).some(c => c.status) && (
                        <div className="bg-white border border-slate-200 rounded-lg p-3 space-y-1" data-testid="validity-checks">
                          <p className="text-xs font-semibold text-slate-600">Previous result checks</p>
                          {(log.validity_checks ?? []).filter(c => c.status).map(c => (
                            <p key={c.type} className="text-xs text-slate-600">
                              <span className="font-medium">{c.type === 'lln' ? 'LLN' : 'Digital'}:</span>{' '}
                              {CHECK_LABELS[c.status!] ?? c.status} — {c.reason}
                              {c.completed_at ? ` (completed ${fmt(c.completed_at)}${c.valid_until ? `, valid until ${fmt(c.valid_until)}` : ''})` : ''}
                            </p>
                          ))}
                        </div>
                      )}

                      {log.error && (
                        <div className="bg-red-50 border border-red-200 rounded-lg p-3">
                          <p className="text-xs font-semibold text-red-700 mb-1">Error</p>
                          <p className="text-xs text-red-600 font-mono">{log.error}</p>
                        </div>
                      )}

                      {resetResults[log.id] && (
                        <div className={`flex items-start gap-2 p-3 rounded-lg text-xs ${
                          resetResults[log.id].ok
                            ? 'bg-emerald-50 border border-emerald-200 text-emerald-800'
                            : 'bg-red-50 border border-red-200 text-red-700'
                        }`}>
                          {resetResults[log.id].ok
                            ? <CheckCircle2 className="w-3.5 h-3.5 mt-0.5 flex-shrink-0" />
                            : <XCircle className="w-3.5 h-3.5 mt-0.5 flex-shrink-0" />}
                          <span>{resetResults[log.id].message}</span>
                        </div>
                      )}

                      <div className="pt-1">
                        <button
                          onClick={(e) => { e.stopPropagation(); handleReset(log); }}
                          disabled={resettingId === log.id}
                          className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium bg-amber-50 border border-amber-200 text-amber-800 hover:bg-amber-100 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
                        >
                          {resettingId === log.id
                            ? <Loader2 className="w-3.5 h-3.5 animate-spin" />
                            : <RotateCcw className="w-3.5 h-3.5" />}
                          {resettingId === log.id ? 'Resetting…' : 'Reset & Re-sync'}
                        </button>
                        <p className="text-xs text-slate-400 mt-1">
                          Clears this log entry and re-runs the sync for this contact from scratch.
                        </p>
                      </div>

                      {log.note_text && (
                        <div>
                          <p className="text-xs font-semibold text-slate-600 mb-1">{log.note_written ? 'Contact note written to aXcelerate' : 'Contact note (not yet written to aXcelerate)'}</p>
                          <pre className="text-xs text-slate-600 bg-white border border-slate-200 rounded-lg p-3 whitespace-pre-wrap font-mono leading-relaxed">
                            {log.note_text}
                          </pre>
                        </div>
                      )}
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}
