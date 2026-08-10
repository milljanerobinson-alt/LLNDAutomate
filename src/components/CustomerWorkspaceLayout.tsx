import { useEffect, useState, type ReactNode } from 'react';
import {
  Activity, AlertTriangle, ArrowDownToLine, Award, BarChart3, BookOpen,
  CheckCircle2, ClipboardList, Command, CreditCard, FileText, GraduationCap,
  LayoutDashboard, Mail, Menu, Plug, ScrollText, Settings, ShieldCheck,
  UserCheck, Users, Wrench, X,
} from 'lucide-react';
import { WorkspaceSwitcher } from './WorkspaceSwitcher';
import { CommandPalette } from './CommandPalette';
import type { CustomerWorkspace } from '../lib/workspaceAccess';
import { setLastPage, setLastWorkspace } from '../lib/workspaceAccess';

type NavItem = { key: string; label: string; icon: typeof LayoutDashboard };

const ADMINISTRATION_NAV: NavItem[] = [
  { key: 'dashboard', label: 'Dashboard', icon: LayoutDashboard },
  { key: 'organisation', label: 'Organisation', icon: Settings },
  { key: 'users', label: 'Users', icon: Users },
  { key: 'qualifications', label: 'Qualifications', icon: Award },
  { key: 'candidates', label: 'Candidates', icon: Users },
  { key: 'support-routing', label: 'Support Routing', icon: UserCheck },
  { key: 'assessments', label: 'Assessments', icon: FileText },
  { key: 'results', label: 'Results', icon: BarChart3 },
  { key: 'completion-reports', label: 'Completion Reports', icon: ClipboardList },
  { key: 'compliance', label: 'Compliance', icon: ShieldCheck },
  { key: 'acsf-evidence', label: 'ACSF Evidence', icon: BookOpen },
  { key: 'audit-log', label: 'Audit Log', icon: ScrollText },
  { key: 'billing', label: 'Billing & Usage', icon: CreditCard },
  { key: 'settings', label: 'Settings', icon: Settings },
];

const SUPPORT_NAV: NavItem[] = [
  { key: 'dashboard', label: 'Support Queue', icon: LayoutDashboard },
  { key: 'candidates', label: 'Candidates Requiring Support', icon: Users },
  { key: 'unassigned-support', label: 'Unassigned Support', icon: UserCheck },
  { key: 'awaiting-review', label: 'Awaiting Review', icon: CheckCircle2 },
  { key: 'results', label: 'Results', icon: BarChart3 },
  { key: 'support-plans', label: 'Support Plans', icon: ClipboardList },
  { key: 'interventions', label: 'Interventions', icon: AlertTriangle },
];

const TECHNICAL_NAV: NavItem[] = [
  { key: 'dashboard', label: 'System Health', icon: Activity },
  { key: 'axcelerate-integration', label: 'aXcelerate Integration', icon: Plug },
  { key: 'axcelerate-inbound', label: 'aXcelerate Sync', icon: ArrowDownToLine },
  { key: 'axcelerate-log', label: 'aXcelerate Log', icon: Plug },
  { key: 'email-activity', label: 'Email Activity', icon: Mail },
  { key: 'validation', label: 'Validation & Diagnostics', icon: CheckCircle2 },
  { key: 'mapping', label: 'Mapping', icon: Wrench },
  { key: 'settings', label: 'Technical Settings', icon: Settings },
];

const CONFIG = {
  administration: { label: 'Administration Workspace', icon: GraduationCap, nav: ADMINISTRATION_NAV },
  candidate_support: { label: 'Candidate Support Workspace', icon: UserCheck, nav: SUPPORT_NAV },
  technical: { label: 'Technical Workspace', icon: Wrench, nav: TECHNICAL_NAV },
} satisfies Record<CustomerWorkspace, { label: string; icon: typeof LayoutDashboard; nav: NavItem[] }>;

interface Props {
  workspace: CustomerWorkspace;
  currentPage: string;
  onPageChange: (page: string) => void;
  children: ReactNode;
}

export function CustomerWorkspaceLayout({ workspace, currentPage, onPageChange, children }: Props) {
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [cmdOpen, setCmdOpen] = useState(false);
  const cfg = CONFIG[workspace];
  const WorkspaceIcon = cfg.icon;
  const currentNav = cfg.nav.find(item => item.key === currentPage);

  useEffect(() => {
    const handle = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key === 'k') {
        event.preventDefault();
        setCmdOpen(value => !value);
      }
    };
    window.addEventListener('keydown', handle);
    return () => window.removeEventListener('keydown', handle);
  }, []);

  function navigate(page: string) {
    setLastWorkspace(workspace);
    setLastPage(workspace, page);
    onPageChange(page);
    setSidebarOpen(false);
  }

  return (
    <div className="h-screen bg-slate-50 flex overflow-hidden">
      {sidebarOpen && <div className="fixed inset-0 bg-slate-900/50 z-30 lg:hidden" onClick={() => setSidebarOpen(false)} />}
      <aside className={`fixed lg:sticky top-0 left-0 h-screen w-64 bg-white border-r border-slate-200 z-40 flex flex-col transition-transform duration-300 ${sidebarOpen ? 'translate-x-0' : '-translate-x-full lg:translate-x-0'}`}>
        <div className="flex items-center justify-between px-5 py-5 border-b border-slate-200">
          <div className="flex items-center gap-2.5">
            <div className="w-9 h-9 bg-primary-600 rounded-lg flex items-center justify-center"><WorkspaceIcon className="w-5 h-5 text-white" /></div>
            <div><div className="text-sm font-bold text-slate-900">LLND Automate</div><div className="text-xs text-slate-400">{cfg.label}</div></div>
          </div>
          <button onClick={() => setSidebarOpen(false)} className="lg:hidden text-slate-400"><X className="w-5 h-5" /></button>
        </div>
        <nav className="flex-1 px-3 py-4 space-y-0.5 overflow-y-auto">
          {cfg.nav.map(item => {
            const Icon = item.icon;
            const active = currentPage === item.key;
            return <button key={item.key} onClick={() => navigate(item.key)} className={`w-full flex items-center gap-3 px-3 py-2.5 rounded-lg text-sm font-medium ${active ? 'bg-primary-50 text-primary-700' : 'text-slate-600 hover:bg-slate-50 hover:text-slate-900'}`}><Icon className={`w-4 h-4 ${active ? 'text-primary-600' : 'text-slate-400'}`} /><span>{item.label}</span></button>;
          })}
        </nav>
      </aside>
      <div className="flex-1 min-w-0 flex flex-col h-screen">
        <header className="h-16 bg-white border-b border-slate-200 flex items-center justify-between px-4 lg:px-6 shrink-0">
          <div className="flex items-center gap-3"><button onClick={() => setSidebarOpen(true)} className="lg:hidden"><Menu className="w-5 h-5" /></button><h1 className="font-semibold text-slate-900">{currentNav?.label ?? cfg.label}</h1></div>
          <div className="flex items-center gap-2">
            <button onClick={() => setCmdOpen(true)} className="flex items-center gap-2 px-3 py-1.5 text-xs text-slate-500 border border-slate-200 rounded-lg"><Command className="w-3.5 h-3.5" /><span className="hidden sm:inline">Search</span></button>
            <WorkspaceSwitcher currentWorkspace={workspace} />
          </div>
        </header>
        <main className="flex-1 overflow-auto p-4 lg:p-8">{children}</main>
      </div>
      <CommandPalette isOpen={cmdOpen} onClose={() => setCmdOpen(false)} currentWorkspace={workspace} />
    </div>
  );
}
