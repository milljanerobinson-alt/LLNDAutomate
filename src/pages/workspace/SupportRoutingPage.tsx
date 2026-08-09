import { useEffect, useState } from 'react';
import { Route } from 'lucide-react';
import { supabase } from '../../lib/supabase';

type Case = { id: string; assigned_user_id: string | null; assignment_source: string; student?: { full_name?: string } | null };
type Agent = { id: string; full_name: string; email: string };

export function SupportRoutingPage() {
  const [cases, setCases] = useState<Case[]>([]);
  const [agents, setAgents] = useState<Agent[]>([]);
  const [message, setMessage] = useState('');
  useEffect(() => { void load(); }, []);
  async function load() {
    const [{ data: supportCases }, { data: access }] = await Promise.all([
      supabase.from('support_cases').select('id,assigned_user_id,assignment_source,student:students(full_name)').order('created_at', { ascending: false }),
      supabase.from('user_workspace_access').select('user_id').eq('workspace', 'candidate_support'),
    ]);
    const ids = [...new Set((access ?? []).map(item => item.user_id))];
    const { data: profiles } = ids.length ? await supabase.from('profiles').select('id,full_name,email,is_active').in('id', ids).eq('is_active', true) : { data: [] };
    setCases((supportCases ?? []) as unknown as Case[]);
    setAgents((profiles ?? []) as Agent[]);
  }
  async function assign(item: Case, userId: string) {
    const { error } = await supabase.from('support_cases').update({ assigned_user_id: userId || null, assignment_source: userId ? 'administration' : 'unassigned', assigned_at: userId ? new Date().toISOString() : null }).eq('id', item.id);
    setMessage(error ? error.message : 'Support routing updated.');
    if (!error) await load();
  }
  return <div className="max-w-5xl mx-auto space-y-6"><div><h1 className="text-2xl font-bold text-slate-900">Support Routing</h1><p className="text-sm text-slate-500 mt-1">Assign or reassign support cases. Automated aXcelerate assignment is disabled until an authoritative trainer relationship is available.</p></div>{message && <p className="bg-primary-50 border border-primary-200 rounded-xl p-3 text-sm text-primary-800">{message}</p>}<div className="bg-white border border-slate-200 rounded-2xl overflow-hidden">{cases.length === 0 ? <p className="p-8 text-center text-sm text-slate-500">No support cases require routing.</p> : cases.map(item => <div key={item.id} className="p-4 border-b last:border-b-0 flex flex-col sm:flex-row sm:items-center gap-3"><Route className="w-5 h-5 text-primary-600" /><div className="flex-1"><p className="font-medium text-slate-900">{item.student?.full_name ?? 'Candidate'}</p><p className="text-xs text-slate-500">Source: {item.assignment_source}</p></div><select value={item.assigned_user_id ?? ''} onChange={event => assign(item, event.target.value)} className="border border-slate-300 rounded-lg px-3 py-2 text-sm"><option value="">Unassigned Support</option>{agents.map(agent => <option key={agent.id} value={agent.id}>{agent.full_name || agent.email}</option>)}</select></div>)}</div></div>;
}
