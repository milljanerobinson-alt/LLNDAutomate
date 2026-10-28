// How long completed LLN and Digital results stay valid for reuse at this RTO.
// There is no default: until a period is set, previous results are never
// accepted automatically and are held for review instead.

import { useEffect, useState } from 'react';
import { CalendarClock } from 'lucide-react';
import { supabase } from '../../lib/supabase';

const KEY = 'assessment_result_validity';
const MAX_DAYS = 3650;

function toInput(v: unknown): string {
  return typeof v === 'number' && Number.isInteger(v) ? String(v) : '';
}

function parseDays(raw: string): number | null | 'invalid' {
  const t = raw.trim();
  if (t === '') return null;
  if (!/^\d+$/.test(t)) return 'invalid';
  const n = Number(t);
  return n >= 1 && n <= MAX_DAYS ? n : 'invalid';
}

export function ResultValidityPanel() {
  const [lln, setLln] = useState('');
  const [digital, setDigital] = useState('');
  const [message, setMessage] = useState('');
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    supabase.from('organisation_settings').select('value').eq('key', KEY).maybeSingle().then(({ data }) => {
      const v = (data?.value ?? {}) as Record<string, unknown>;
      setLln(toInput(v.lln_days));
      setDigital(toInput(v.digital_days));
    });
  }, []);

  async function save() {
    const l = parseDays(lln);
    const d = parseDays(digital);
    if (l === 'invalid' || d === 'invalid') { setMessage(`Enter a whole number of days from 1 to ${MAX_DAYS}, or leave blank.`); return; }
    setSaving(true);
    const { error } = await supabase.rpc('set_organisation_setting', { p_key: KEY, p_value: { lln_days: l, digital_days: d } });
    setSaving(false);
    setMessage(error ? error.message : 'Result validity saved.');
  }

  return (
    <div className="bg-white border border-slate-200 rounded-2xl p-6" data-testid="result-validity">
      <div className="flex items-center gap-3 mb-2"><CalendarClock className="w-5 h-5 text-primary-600" /><h2 className="font-semibold">Assessment result validity</h2></div>
      <p className="text-sm text-slate-500 mb-4">
        How many days a completed result can be reused for a new enrolment, counted from that assessment's own completion date.
        Leave blank to not reuse results automatically — they'll be held for your review instead.
      </p>
      <div className="grid sm:grid-cols-2 gap-4">
        <label className="block text-sm font-medium text-slate-700">LLN results (days)
          <input value={lln} onChange={e => setLln(e.target.value)} inputMode="numeric" placeholder="Not set" aria-label="LLN validity days" className="mt-1 w-full border border-slate-300 rounded-lg px-3 py-2" />
        </label>
        <label className="block text-sm font-medium text-slate-700">Digital results (days)
          <input value={digital} onChange={e => setDigital(e.target.value)} inputMode="numeric" placeholder="Not set" aria-label="Digital validity days" className="mt-1 w-full border border-slate-300 rounded-lg px-3 py-2" />
        </label>
      </div>
      <button onClick={save} disabled={saving} className="mt-4 px-4 py-2 bg-primary-600 text-white rounded-lg text-sm font-semibold disabled:opacity-50">Save</button>
      {message && <p className="mt-3 text-sm text-slate-500">{message}</p>}
    </div>
  );
}
