import { useEffect, useState } from 'react';
import { FileCheck2 } from 'lucide-react';
import { supabase } from '../../lib/supabase';

export function CompletionReportsPage() {
  const [rows, setRows] = useState<Array<{ id: string; candidate_name: string | null; course_recommendation: string | null; completed_at: string | null }>>([]);
  useEffect(() => { supabase.from('assessment_invitations').select('id,candidate_name,course_recommendation,completed_at').not('completed_at', 'is', null).order('completed_at', { ascending: false }).then(({ data }) => setRows(data ?? [])); }, []);
  return <div className="max-w-5xl mx-auto space-y-6"><div><h1 className="text-2xl font-bold text-slate-900">Completion Reports</h1><p className="text-sm text-slate-500 mt-1">Organisation-wide completed candidate outcomes.</p></div><div className="bg-white border border-slate-200 rounded-2xl overflow-hidden">{rows.length === 0 ? <p className="p-8 text-center text-sm text-slate-500">No completed reports available.</p> : rows.map(row => <div key={row.id} className="p-4 border-b last:border-b-0 flex items-center gap-3"><FileCheck2 className="w-5 h-5 text-primary-600" /><div><p className="font-medium text-slate-900">{row.candidate_name ?? 'Candidate'}</p><p className="text-xs text-slate-500">{row.course_recommendation ?? 'Completed'} · {row.completed_at ? new Date(row.completed_at).toLocaleDateString('en-AU') : ''}</p></div></div>)}</div></div>;
}
