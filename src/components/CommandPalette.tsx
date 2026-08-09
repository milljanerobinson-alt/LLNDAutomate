import { useEffect, useMemo, useRef, useState } from 'react';
import { ArrowRight, Search, X } from 'lucide-react';
import {
  type AnyWorkspace, type CustomerWorkspace, setLastPage, setLastWorkspace,
  useWorkspaceAccess, workspaceHash,
} from '../lib/workspaceAccess';
import { navigateInProduct, resolveProduct } from '../lib/productContext';

type Command = { workspace: AnyWorkspace; page: string; label: string; group: string };

const LLND_COMMANDS: Command[] = [
  ...['Dashboard', 'Organisation', 'Users', 'Qualifications', 'Candidates', 'Support Routing', 'Assessments', 'Results', 'Completion Reports', 'Compliance', 'ACSF Evidence', 'Audit Log', 'Billing & Usage', 'Settings'].map((label, index) => ({
    workspace: 'administration' as const,
    page: ['dashboard', 'organisation', 'users', 'qualifications', 'candidates', 'support-routing', 'assessments', 'results', 'completion-reports', 'compliance', 'acsf-evidence', 'audit-log', 'billing', 'settings'][index],
    label,
    group: 'Administration Workspace',
  })),
  ...['Support Queue', 'Candidates Requiring Support', 'Unassigned Support', 'Awaiting Review', 'Results', 'Support Plans', 'Interventions'].map((label, index) => ({
    workspace: 'candidate_support' as const,
    page: ['dashboard', 'candidates', 'unassigned-support', 'awaiting-review', 'results', 'support-plans', 'interventions'][index],
    label,
    group: 'Candidate Support Workspace',
  })),
  ...['System Health', 'aXcelerate Integration', 'aXcelerate Sync', 'aXcelerate Log', 'Email Activity', 'Validation & Diagnostics', 'Mapping', 'Technical Settings'].map((label, index) => ({
    workspace: 'technical' as const,
    page: ['dashboard', 'axcelerate-integration', 'axcelerate-inbound', 'axcelerate-log', 'email-activity', 'validation', 'mapping', 'settings'][index],
    label,
    group: 'Technical Workspace',
  })),
];

const EIOS_COMMANDS: Command[] = [
  ['mission-control', 'AI Technical Director'], ['ideas', 'Goals & Epics'], ['roadmap', 'Roadmap'],
  ['backlog', 'Ideas & Backlog'], ['dev-programme', 'Dev Programme'], ['architecture', 'Architecture'],
  ['documentation', 'Documentation'], ['qa-testing', 'Testing Framework'], ['release-centre', 'Releases'],
  ['pa-integrations', 'Platform Integrations'], ['pa-security', 'Platform Security'],
  ['pa-feature-flags', 'Platform Feature Flags'], ['pa-monitoring', 'Platform Monitoring'],
].map(([page, label]) => ({ workspace: 'engineering', page, label, group: 'Engineering Command Centre' }));

interface Props { isOpen: boolean; onClose: () => void; currentWorkspace: AnyWorkspace }

export function CommandPalette({ isOpen, onClose, currentWorkspace }: Props) {
  const [query, setQuery] = useState('');
  const inputRef = useRef<HTMLInputElement>(null);
  const { workspaces } = useWorkspaceAccess();
  const product = resolveProduct();
  const allowed = new Set(workspaces.map(item => item.workspace));
  const commands = product === 'eios' ? EIOS_COMMANDS : LLND_COMMANDS.filter(command => allowed.has(command.workspace as CustomerWorkspace));
  const filtered = useMemo(() => commands.filter(command => {
    if (!query.trim()) return command.workspace === currentWorkspace;
    const haystack = `${command.label} ${command.group}`.toLowerCase();
    return haystack.includes(query.toLowerCase());
  }), [commands, currentWorkspace, query]);

  useEffect(() => {
    if (!isOpen) return;
    setQuery('');
    setTimeout(() => inputRef.current?.focus(), 30);
    const handler = (event: KeyboardEvent) => { if (event.key === 'Escape') onClose(); };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [isOpen, onClose]);

  if (!isOpen) return null;

  function navigate(command: Command) {
    setLastWorkspace(command.workspace);
    setLastPage(command.workspace, command.page);
    navigateInProduct(command.workspace === 'engineering' ? 'eios' : 'llnd', workspaceHash(command.workspace, command.page));
    onClose();
  }

  return <div className="fixed inset-0 z-[100] flex items-start justify-center pt-20 px-4">
    <div className="absolute inset-0 bg-slate-900/60 backdrop-blur-sm" onClick={onClose} />
    <div className="relative w-full max-w-xl bg-white rounded-2xl shadow-2xl border border-slate-200 overflow-hidden">
      <div className="flex items-center gap-3 px-4 py-3.5 border-b border-slate-200"><Search className="w-4 h-4 text-slate-400" /><input ref={inputRef} value={query} onChange={event => setQuery(event.target.value)} placeholder="Search assigned workspaces…" className="flex-1 text-sm outline-none" /><button onClick={onClose}><X className="w-4 h-4 text-slate-400" /></button></div>
      <div className="max-h-96 overflow-y-auto p-2">
        {filtered.length === 0 && <p className="p-8 text-center text-sm text-slate-400">No available pages found.</p>}
        {filtered.map(command => <button key={`${command.workspace}-${command.page}`} onClick={() => navigate(command)} className="w-full flex items-center gap-3 px-3 py-2.5 rounded-lg text-left hover:bg-primary-50"><div className="flex-1"><p className="text-sm font-medium text-slate-800">{command.label}</p><p className="text-[10px] text-slate-400">{command.group}</p></div><ArrowRight className="w-4 h-4 text-slate-400" /></button>)}
      </div>
    </div>
  </div>;
}
