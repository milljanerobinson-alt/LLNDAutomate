import { useEffect, useState } from 'react';
import { Building2 } from 'lucide-react';
import { supabase } from '../../lib/supabase';

export function OrganisationPage() {
  const [name, setName] = useState('');
  const [id, setId] = useState<string | null>(null);
  const [message, setMessage] = useState('');
  useEffect(() => { supabase.from('organisations').select('id,name').maybeSingle().then(({ data }) => { setId(data?.id ?? null); setName(data?.name ?? ''); }); }, []);
  async function save() {
    if (!id || !name.trim()) return;
    const { error } = await supabase.from('organisations').update({ name: name.trim() }).eq('id', id);
    setMessage(error ? error.message : 'Organisation saved.');
  }
  return <div className="max-w-3xl mx-auto space-y-6"><div><h1 className="text-2xl font-bold text-slate-900">Organisation</h1><p className="text-sm text-slate-500 mt-1">Organisation profile and branding belong here.</p></div><div className="bg-white border border-slate-200 rounded-2xl p-6"><div className="flex items-center gap-3 mb-5"><Building2 className="w-5 h-5 text-primary-600" /><h2 className="font-semibold">Organisation profile</h2></div><label className="block text-sm font-medium text-slate-700">Organisation name</label><input value={name} onChange={event => setName(event.target.value)} className="mt-2 w-full border border-slate-300 rounded-lg px-3 py-2" /><button onClick={save} className="mt-4 px-4 py-2 bg-primary-600 text-white rounded-lg text-sm font-semibold">Save</button>{message && <p className="mt-3 text-sm text-slate-500">{message}</p>}</div></div>;
}
