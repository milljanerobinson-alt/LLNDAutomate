import { useEffect, useState } from 'react';
import { MailPlus, Shield, Trash2, UserCheck, UserX, Users } from 'lucide-react';
import { supabase } from '../../lib/supabase';
import type { CustomerWorkspace } from '../../lib/workspaceAccess';

const OPTIONS: Array<{ id: CustomerWorkspace; label: string }> = [
  { id: 'administration', label: 'Administration' },
  { id: 'candidate_support', label: 'Candidate Support' },
  { id: 'technical', label: 'Technical' },
];

type Member = {
  membership_id: string;
  user_id: string;
  status: string;
  invited_email: string | null;
  full_name: string;
  email: string;
  is_active: boolean;
  workspaces: CustomerWorkspace[];
  pending_workspaces: CustomerWorkspace[];
};

type DeletionReview =
  | { member: Member; state: 'checking' }
  | { member: Member; state: 'blocked'; areas: string[] }
  | { member: Member; state: 'allowed' }
  | { member: Member; state: 'error'; message: string };

export function UsersPage() {
  const [members, setMembers] = useState<Member[]>([]);
  const [email, setEmail] = useState('');
  const [name, setName] = useState('');
  const [inviteAccess, setInviteAccess] = useState<CustomerWorkspace[]>(['candidate_support']);
  const [editing, setEditing] = useState<Member | null>(null);
  const [editAccess, setEditAccess] = useState<CustomerWorkspace[]>([]);
  const [deletion, setDeletion] = useState<DeletionReview | null>(null);
  const [message, setMessage] = useState('');
  const [busy, setBusy] = useState(false);

  useEffect(() => { void load(); }, []);

  async function load() {
    const { data, error } = await supabase.rpc('list_organisation_staff');
    if (error) { setMessage(error.message); return; }
    setMembers((data ?? []) as Member[]);
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

  async function reviewDeletion(member: Member) {
    setMessage('');
    setDeletion({ member, state: 'checking' });
    const { data, error } = await supabase.rpc('get_staff_deletion_blockers', { target_user: member.user_id });
    if (error) { setDeletion({ member, state: 'error', message: error.message }); return; }
    const areas = ((data ?? []) as Array<{ record_area: string }>).map(row => row.record_area);
    setDeletion(areas.length ? { member, state: 'blocked', areas } : { member, state: 'allowed' });
  }

  async function confirmDeletion(member: Member) {
    setBusy(true); setMessage('');
    const { error } = await supabase.rpc('delete_organisation_member', { target_user: member.user_id });
    if (error) {
      setDeletion({ member, state: 'error', message: error.message });
    } else {
      setDeletion(null);
      setMessage(`${member.full_name || member.email} was permanently deleted.`);
      await load();
    }
    setBusy(false);
  }

  const current = members.filter(member => member.status !== 'inactive');
  const deactivated = members.filter(member => member.status === 'inactive');

  function renderRow(member: Member) {
    const isInvited = member.status === 'invited';
    const isDeactivated = member.status === 'inactive';
    const displayedWorkspaces = member.status === 'invited' ? member.pending_workspaces : member.workspaces;
    return <div key={member.membership_id} data-testid="organisation-staff-row" data-user-email={member.email} data-staff-status={member.status} className="p-5 border-b last:border-b-0 flex flex-col sm:flex-row sm:items-center gap-4">
      <div className="flex-1">
        <p className="font-semibold text-slate-900">{member.full_name || member.email}</p>
        <p className="text-xs text-slate-500">{member.email} · <span data-testid="staff-status">{member.status}</span>{isInvited ? ' · inactive until they set up their account' : ''}{isDeactivated ? ' · deactivated' : ''}</p>
        <div className="flex flex-wrap gap-1 mt-2">{displayedWorkspaces.map(item => <span key={item} data-testid="staff-workspace" className="text-[10px] bg-slate-100 text-slate-600 rounded-full px-2 py-1">{OPTIONS.find(option => option.id === item)?.label}</span>)}</div>
      </div>
      <div className="flex flex-wrap gap-2">
        {!isInvited && <button onClick={() => { setEditing(member); setEditAccess(member.workspaces); }} className="px-3 py-2 border border-slate-300 rounded-lg text-xs font-medium"><Shield className="w-3.5 h-3.5 inline mr-1" />Access</button>}
        {isDeactivated && <button disabled={busy} onClick={() => setStatus(member, 'active')} className="px-3 py-2 border border-emerald-300 text-emerald-700 rounded-lg text-xs font-medium"><UserCheck className="w-3.5 h-3.5 inline mr-1" />Reactivate</button>}
        {member.status === 'active' && <button disabled={busy} onClick={() => setStatus(member, 'inactive')} className="px-3 py-2 border border-red-200 text-red-600 rounded-lg text-xs font-medium"><UserX className="w-3.5 h-3.5 inline mr-1" />Deactivate</button>}
        {(isDeactivated || isInvited) && <button disabled={busy} onClick={() => reviewDeletion(member)} data-testid="staff-delete" className="px-3 py-2 border border-red-300 text-red-700 rounded-lg text-xs font-medium"><Trash2 className="w-3.5 h-3.5 inline mr-1" />Delete</button>}
      </div>
    </div>;
  }

  return <div className="max-w-5xl mx-auto space-y-6">
    <div><h1 className="text-2xl font-bold text-slate-900">Users</h1><p className="text-sm text-slate-500 mt-1">Manage organisation staff and their workspace permissions. Deactivate staff to remove their access while keeping their history. A deactivated or invited user can be permanently deleted only when no support, intervention, compliance or audit records refer to them.</p></div>
    {message && <div className="bg-primary-50 border border-primary-200 text-primary-800 rounded-xl px-4 py-3 text-sm">{message}</div>}
    <form onSubmit={invite} className="bg-white border border-slate-200 rounded-2xl p-5 space-y-4">
      <div className="flex items-center gap-2"><MailPlus className="w-5 h-5 text-primary-600" /><h2 className="font-semibold text-slate-900">Invite staff user</h2></div>
      <div className="grid sm:grid-cols-2 gap-3"><input value={name} onChange={event => setName(event.target.value)} placeholder="Full name" className="border border-slate-300 rounded-lg px-3 py-2 text-sm" /><input type="email" required value={email} onChange={event => setEmail(event.target.value)} placeholder="Email address" className="border border-slate-300 rounded-lg px-3 py-2 text-sm" /></div>
      <WorkspaceChecks values={inviteAccess} onToggle={value => toggle(value, inviteAccess, setInviteAccess)} />
      <button disabled={busy || !inviteAccess.length} className="px-4 py-2 bg-primary-600 text-white rounded-lg text-sm font-semibold disabled:opacity-50">Send invitation now</button>
    </form>
    <section data-testid="staff-section-current" className="bg-white border border-slate-200 rounded-2xl overflow-hidden">
      <div className="px-5 py-4 border-b border-slate-200 flex items-center gap-2"><Users className="w-5 h-5 text-primary-600" /><h2 className="font-semibold text-slate-900">Active and invited staff</h2></div>
      {current.length === 0 ? <p className="p-5 text-sm text-slate-500">No active or invited staff.</p> : current.map(renderRow)}
    </section>
    <section data-testid="staff-section-deactivated" className="bg-white border border-slate-200 rounded-2xl overflow-hidden">
      <div className="px-5 py-4 border-b border-slate-200 flex items-center gap-2"><UserX className="w-5 h-5 text-slate-500" /><h2 className="font-semibold text-slate-900">Deactivated staff</h2></div>
      {deactivated.length === 0 ? <p className="p-5 text-sm text-slate-500">No deactivated staff.</p> : deactivated.map(renderRow)}
    </section>
    {editing && <div className="fixed inset-0 z-50 bg-slate-900/50 flex items-center justify-center p-4"><div className="bg-white rounded-2xl max-w-md w-full p-6"><h2 className="font-bold text-slate-900">Edit workspace access</h2><p className="text-sm text-slate-500 mt-1 mb-4">{editing.email}</p><WorkspaceChecks values={editAccess} onToggle={value => toggle(value, editAccess, setEditAccess)} /><div className="flex justify-end gap-2 mt-6"><button onClick={() => setEditing(null)} className="px-4 py-2 text-sm">Cancel</button><button disabled={busy || !editAccess.length} onClick={() => save(editing)} className="px-4 py-2 bg-primary-600 text-white rounded-lg text-sm font-semibold disabled:opacity-50">Save access</button></div></div></div>}
    {deletion && <div className="fixed inset-0 z-50 bg-slate-900/50 flex items-center justify-center p-4"><div role="dialog" aria-modal="true" aria-labelledby="delete-staff-title" data-testid="staff-delete-dialog" className="bg-white rounded-2xl max-w-md w-full p-6">
      <h2 id="delete-staff-title" className="font-bold text-slate-900">Delete staff user</h2>
      <p className="text-sm text-slate-500 mt-1 mb-4">{deletion.member.full_name || deletion.member.email}</p>
      {deletion.state === 'checking' && <p className="text-sm text-slate-600">Checking this user's recorded history…</p>}
      {deletion.state === 'blocked' && <div data-testid="staff-delete-blocked" className="text-sm text-slate-700 space-y-2"><p>This user can't be permanently deleted because they are recorded in:</p><ul className="list-disc pl-5">{deletion.areas.map(area => <li key={area}>{area}</li>)}</ul><p>Keep them deactivated so that history stays intact.</p></div>}
      {deletion.state === 'allowed' && <p data-testid="staff-delete-allowed" className="text-sm text-slate-700">No support, intervention, compliance or audit records refer to this user. Deleting removes their account and sign-in permanently. This can't be undone. You can invite them again later.</p>}
      {deletion.state === 'error' && <p className="text-sm text-red-700">{deletion.message}</p>}
      <div className="flex justify-end gap-2 mt-6">
        <button onClick={() => setDeletion(null)} className="px-4 py-2 text-sm">{deletion.state === 'allowed' ? 'Cancel' : 'Close'}</button>
        {deletion.state === 'allowed' && <button disabled={busy} onClick={() => confirmDeletion(deletion.member)} className="px-4 py-2 bg-red-600 text-white rounded-lg text-sm font-semibold disabled:opacity-50">Delete permanently</button>}
      </div>
    </div></div>}
  </div>;
}

function WorkspaceChecks({ values, onToggle }: { values: CustomerWorkspace[]; onToggle: (value: CustomerWorkspace) => void }) {
  return <div className="flex flex-wrap gap-3">{OPTIONS.map(option => <label key={option.id} className="flex items-center gap-2 text-sm text-slate-700"><input type="checkbox" checked={values.includes(option.id)} onChange={() => onToggle(option.id)} className="rounded border-slate-300 text-primary-600" />{option.label}</label>)}</div>;
}
