import { useEffect, useState } from 'react';
import { ClipboardList, Clock, UserCheck, Users } from 'lucide-react';
import { supabase } from '../../lib/supabase';
import { useAuth } from '../../lib/auth';

type View = 'assigned' | 'unassigned' | 'awaiting_review';
type SupportCase = {
  id: string;
  status: string;
  assigned_user_id: string | null;
  created_at: string;
  student?: { full_name?: string; course_name?: string | null } | null;
  invitation?: { course_recommendation?: string | null } | null;
};

export function CandidateSupportPage({ view }: { view: View }) {
  const { user } = useAuth();
  const [cases, setCases] = useState<SupportCase[]>([]);
  const [loading, setLoading] = useState(true);
  const [expanded, setExpanded] = useState<string | null>(null);

  useEffect(() => { void load(); }, [view, user?.id]);

  async function load() {
    setLoading(true);
    let query = supabase.from('support_cases').select('id,status,assigned_user_id,created_at,student:students(full_name,course_name),invitation:assessment_invitations(course_recommendation)').order('created_at', { ascending: false });
    if (view === 'assigned') query = query.eq('assigned_user_id', user?.id ?? '');
    if (view === 'unassigned') query = query.is('assigned_user_id', null);
    if (view === 'awaiting_review') query = query.eq('status', 'awaiting_review');
    const { data } = await query;
    setCases((data ?? []) as unknown as SupportCase[]);
    setLoading(false);
  }

  const title = view === 'unassigned' ? 'Unassigned Support' : view === 'awaiting_review' ? 'Awaiting Review' : 'Candidates Requiring Support';
  return <div className="max-w-5xl mx-auto space-y-6">
    <div><h1 className="text-2xl font-bold text-slate-900">{title}</h1><p className="text-sm text-slate-500 mt-1">Only assigned cases and the shared eligible unassigned queue are available here.</p></div>
    <div className="grid sm:grid-cols-3 gap-3">
      <Metric icon={Users} label="Visible cases" value={cases.length} />
      <Metric icon={UserCheck} label="Assigned to you" value={cases.filter(item => item.assigned_user_id === user?.id).length} />
      <Metric icon={Clock} label="Unassigned" value={cases.filter(item => !item.assigned_user_id).length} />
    </div>
    <div className="bg-white border border-slate-200 rounded-2xl overflow-hidden">
      {loading ? <p className="p-8 text-center text-sm text-slate-400">Loading support cases…</p> : cases.length === 0 ? <p className="p-8 text-center text-sm text-slate-500">No eligible support cases in this queue.</p> : cases.map(item => <div key={item.id} className="border-b last:border-b-0 border-slate-100">
        <button onClick={() => setExpanded(expanded === item.id ? null : item.id)} className="w-full p-4 text-left flex items-center gap-4 hover:bg-slate-50"><ClipboardList className="w-5 h-5 text-primary-600" /><div className="flex-1"><p className="font-semibold text-slate-900">{item.student?.full_name ?? 'Candidate'}</p><p className="text-xs text-slate-500">{item.student?.course_name ?? 'Course not supplied'} · {item.status.replace('_', ' ')}</p></div><span className="text-xs text-slate-400">View case</span></button>
        {expanded === item.id && <div className="px-12 pb-4 text-sm text-slate-600"><h3 className="font-semibold text-slate-800">Completion report</h3><p className="mt-1">Outcome: {item.invitation?.course_recommendation ?? 'Pending completion'}</p><p className="mt-2 text-xs text-slate-400">Assignment and reassignment are controlled by Administration.</p></div>}
      </div>)}
    </div>
  </div>;
}

function Metric({ icon: Icon, label, value }: { icon: typeof Users; label: string; value: number }) {
  return <div className="bg-white border border-slate-200 rounded-xl p-4 flex items-center gap-3"><Icon className="w-5 h-5 text-primary-600" /><div><p className="text-xl font-bold text-slate-900">{value}</p><p className="text-xs text-slate-500">{label}</p></div></div>;
}
