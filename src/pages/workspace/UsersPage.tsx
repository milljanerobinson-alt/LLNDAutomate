import { useEffect, useState } from 'react';
import { MailPlus, Shield, UserCheck, UserX, Users } from 'lucide-react';
import { supabase } from '../../lib/supabase';
import type { CustomerWorkspace } from '../../lib/workspaceAccess';

const OPTIONS: Array<{ id: CustomerWorkspace; label: string }> = [
  { id: 'administration', label: 'Administration' },
  { id: 'candidate_support', label: 'Candidate Support' },
  { id: 'technical', label: 'Technical' },
];

type Member = {
  user_id: string;
  status: string;
  invited_email: string | null;
  full_name: string;
  email: string;
  workspaces: CustomerWorkspace[];
};

export function UsersPage() {
  const [members, setMembers] = useState<Member[]>([]);
  const [email, setEmail] = useState('');
  const [name, setName] = useState('');
  const [inviteAccess, setInviteAccess] = useState<CustomerWorkspace[]>(['candidate_support']);
  const [editing, setEditing] = useState<Member | null>(null);
  const [editAccess, setEditAccess] = useState<CustomerWorkspace[]>([]);
  const [message, setMessage] = useState('');
  const [busy, setBusy] = useState(false);

  useEffect(() => { void load(); }, []);

  async function load() {
    const { data: memberships } = await supabase.from('organisation_memberships').select('user_id,status,invited_email').order('created_at');
    const ids = (memberships ?? []).map(item => item.user_id);
    if (!ids.length) { setMembers([]); return; }
    const [{ data: profiles }, { data: access }] = await Promise.all([
      supabase.from('profiles').select('id,full_name,email').in('id', ids),
      supabase.from('user_workspace_access').select('user_id,workspace').in('user_id', ids),
    ]);
    setMembers((memberships ?? []).map(item => {
      const profile = profiles?.find(row => row.id === item.user_id);
      return { ...item, full_name: profile?.full_name ?? '', email: profile?.email ?? item.invited_email ?? '', workspaces: (access ?? []).filter(row => row.user_id === item.user_id).map(row => row.workspace as CustomerWorkspace) };
    }));
  }

  function toggle(value: CustomerWorkspace, values: CustomerWorkspace[], update: (next: CustomerWorkspace[]) => void) {
    update(values.includes(value) ? values.filter(item => item !== value) : [...values, value]);
  }

  async function invite(event: React.FormEvent) {
    event.preventDefault();
    if (!email.trim() || inviteAccess.length === 0) return;
    setBusy(true); setMessage('');
    const { error } = await supabase.functions.invoke('invite-rto-staff', { body: { email: email.trim(), fullName: name.trim(), workspaces: inviteAccess } });
    setMessage(error ? error.message : 'Invitation email sent.');
    if (!error) { setEmail(''); setName(''); await load(); }
    setBusy(false);
  }

  async function save(member: Member, status = member.status) {
    if (editAccess.length === 0) return;
    setBusy(true); setMessage('');
    const { error } = await supabase.rpc('update_organisation_member', { target_user: member.user_id, new_status: status, new_workspaces: editAccess });
    setMessage(error ? error.message : 'Staff access updated.');
    if (!error) { setEditing(null); await load(); }
    setBusy(false);
  }

  async function setStatus(member: Member, status: 'active' | 'inactive') {
    setEditAccess(member.workspaces);
    setBusy(true); setMessage('');
    const { error } = await supabase.rpc('update_organisation_member', { target_user: member.user_id, new_status: status, new_workspaces: member.workspaces });
    setMessage(error ? error.message : status === 'inactive' ? 'Staff user deactivated.' : 'Staff user reactivated.');
    if (!error) await load();
    setBusy(false);
  }

  return <div className="max-w-5xl mx-auto space-y-6">
    <div><h1 className="text-2xl font-bold text-slate-900">Users</h1><p className="text-sm text-slate-500 mt-1">Manage organisation staff and their workspace permissions. Accounts are deactivated, never permanently deleted.</p></div>
    {message && <div className="bg-primary-50 border border-primary-200 text-primary-800 rounded-xl px-4 py-3 text-sm">{message}</div>}
    <form onSubmit={invite} className="bg-white border border-slate-200 rounded-2xl p-5 space-y-4">
      <div className="flex items-center gap-2"><MailPlus className="w-5 h-5 text-primary-600" /><h2 className="font-semibold text-slate-900">Invite staff user</h2></div>
      <div className="grid sm:grid-cols-2 gap-3"><input value={name} onChange={event => setName(event.target.value)} placeholder="Full name" className="border border-slate-300 rounded-lg px-3 py-2 text-sm" /><input type="email" required value={email} onChange={event => setEmail(event.target.value)} placeholder="Email address" className="border border-slate-300 rounded-lg px-3 py-2 text-sm" /></div>
      <WorkspaceChecks values={inviteAccess} onToggle={value => toggle(value, inviteAccess, setInviteAccess)} />
      <button disabled={busy || !inviteAccess.length} className="px-4 py-2 bg-primary-600 text-white rounded-lg text-sm font-semibold disabled:opacity-50">Send invitation now</button>
    </form>
    <div className="bg-white border border-slate-200 rounded-2xl overflow-hidden">
      <div className="px-5 py-4 border-b border-slate-200 flex items-center gap-2"><Users className="w-5 h-5 text-primary-600" /><h2 className="font-semibold text-slate-900">Organisation staff</h2></div>
      {members.map(member => <div key={member.user_id} className="p-5 border-b last:border-b-0 flex flex-col sm:flex-row sm:items-center gap-4"><div className="flex-1"><p className="font-semibold text-slate-900">{member.full_name || member.email}</p><p className="text-xs text-slate-500">{member.email} · {member.status}</p><div className="flex flex-wrap gap-1 mt-2">{member.workspaces.map(item => <span key={item} className="text-[10px] bg-slate-100 text-slate-600 rounded-full px-2 py-1">{OPTIONS.find(option => option.id === item)?.label}</span>)}</div></div><div className="flex gap-2"><button onClick={() => { setEditing(member); setEditAccess(member.workspaces); }} className="px-3 py-2 border border-slate-300 rounded-lg text-xs font-medium"><Shield className="w-3.5 h-3.5 inline mr-1" />Access</button>{member.status === 'inactive' ? <button disabled={busy} onClick={() => setStatus(member, 'active')} className="px-3 py-2 border border-emerald-300 text-emerald-700 rounded-lg text-xs font-medium"><UserCheck className="w-3.5 h-3.5 inline mr-1" />Reactivate</button> : <button disabled={busy} onClick={() => setStatus(member, 'inactive')} className="px-3 py-2 border border-red-200 text-red-600 rounded-lg text-xs font-medium"><UserX className="w-3.5 h-3.5 inline mr-1" />Deactivate</button>}</div></div>)}
    </div>
    {editing && <div className="fixed inset-0 z-50 bg-slate-900/50 flex items-center justify-center p-4"><div className="bg-white rounded-2xl max-w-md w-full p-6"><h2 className="font-bold text-slate-900">Edit workspace access</h2><p className="text-sm text-slate-500 mt-1 mb-4">{editing.email}</p><WorkspaceChecks values={editAccess} onToggle={value => toggle(value, editAccess, setEditAccess)} /><div className="flex justify-end gap-2 mt-6"><button onClick={() => setEditing(null)} className="px-4 py-2 text-sm">Cancel</button><button disabled={busy || !editAccess.length} onClick={() => save(editing)} className="px-4 py-2 bg-primary-600 text-white rounded-lg text-sm font-semibold disabled:opacity-50">Save access</button></div></div></div>}
  </div>;
}

function WorkspaceChecks({ values, onToggle }: { values: CustomerWorkspace[]; onToggle: (value: CustomerWorkspace) => void }) {
  return <div className="flex flex-wrap gap-3">{OPTIONS.map(option => <label key={option.id} className="flex items-center gap-2 text-sm text-slate-700"><input type="checkbox" checked={values.includes(option.id)} onChange={() => onToggle(option.id)} className="rounded border-slate-300 text-primary-600" />{option.label}</label>)}</div>;
}
