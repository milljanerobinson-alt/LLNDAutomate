import { useState, useEffect, ReactNode } from 'react';
import {
  LayoutDashboard, FileText, Award, Users, BarChart3,
  ClipboardList, AlertTriangle, ShieldCheck, Settings,
  Menu, X, GraduationCap, CheckCircle2, CreditCard, ScrollText, Mail, Plug,
  ArrowDownToLine, Brain, Command,
} from 'lucide-react';
import { WorkspaceSwitcher } from './WorkspaceSwitcher';
import { CommandPalette } from './CommandPalette';

export type AdminPage =
  | 'dashboard' | 'assessments' | 'qualifications' | 'candidates'
  | 'results' | 'support-plans' | 'interventions' | 'compliance'
  | 'audit-log' | 'email-activity' | 'axcelerate-log' | 'axcelerate-inbound'
  | 'validation' | 'billing' | 'settings' | 'acsf-evidence';

interface NavItem {
  key: AdminPage;
  label: string;
  icon: typeof LayoutDashboard;
}

const NAV_ITEMS: NavItem[] = [
  { key: 'dashboard',           label: 'Dashboard',        icon: LayoutDashboard },
  { key: 'assessments',         label: 'Assessments',      icon: FileText },
  { key: 'qualifications',      label: 'Qualifications',   icon: Award },
  { key: 'candidates',          label: 'Candidates',       icon: Users },
  { key: 'results',             label: 'Results',          icon: BarChart3 },
  { key: 'support-plans',       label: 'Support Plans',    icon: ClipboardList },
  { key: 'interventions',       label: 'Interventions',    icon: AlertTriangle },
  { key: 'compliance',          label: 'Compliance',       icon: ShieldCheck },
  { key: 'acsf-evidence',       label: 'ACSF Evidence',    icon: Brain },
  { key: 'audit-log',           label: 'Audit Log',        icon: ScrollText },
  { key: 'email-activity',      label: 'Email Activity',   icon: Mail },
  { key: 'axcelerate-log',      label: 'aXcelerate Log',   icon: Plug },
  { key: 'axcelerate-inbound',  label: 'aXcelerate Sync',  icon: ArrowDownToLine },
  { key: 'validation',          label: 'Validation',       icon: CheckCircle2 },
  { key: 'billing',             label: 'Billing',          icon: CreditCard },
  { key: 'settings',            label: 'Settings',         icon: Settings },
];

interface AdminLayoutProps {
  currentPage: AdminPage;
  onPageChange: (page: AdminPage) => void;
  children: ReactNode;
}

export function AdminLayout({ currentPage, onPageChange, children }: AdminLayoutProps) {
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [cmdOpen, setCmdOpen] = useState(false);

  const currentNav = NAV_ITEMS.find(n => n.key === currentPage);

  useEffect(() => {
    const handle = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key === 'k') {
        e.preventDefault();
        setCmdOpen(s => !s);
      }
    };
    window.addEventListener('keydown', handle);
    return () => window.removeEventListener('keydown', handle);
  }, []);

  return (
    <div className="h-screen bg-slate-50 flex overflow-hidden">
      {/* Mobile overlay */}
      {sidebarOpen && (
        <div
          className="fixed inset-0 bg-slate-900/50 z-30 lg:hidden"
          onClick={() => setSidebarOpen(false)}
        />
      )}

      {/* Sidebar */}
      <aside className={`
        fixed lg:sticky top-0 left-0 h-screen w-64 bg-white border-r border-slate-200 z-40
        flex flex-col transition-transform duration-300
        ${sidebarOpen ? 'translate-x-0' : '-translate-x-full lg:translate-x-0'}
      `}>
        <div className="flex items-center justify-between px-5 py-5 border-b border-slate-200">
          <div className="flex items-center gap-2.5">
            <div className="w-9 h-9 bg-primary-600 rounded-lg flex items-center justify-center">
              <GraduationCap className="w-5 h-5 text-white" />
            </div>
            <div>
              <div className="text-sm font-bold text-slate-900">LLND Automate</div>
              <div className="text-xs text-slate-400">Candidate Assessment</div>
            </div>
          </div>
          <button
            onClick={() => setSidebarOpen(false)}
            className="lg:hidden text-slate-400 hover:text-slate-600"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        <nav className="flex-1 px-3 py-4 space-y-1 overflow-y-auto scrollbar-thin">
          {NAV_ITEMS.map(item => {
            const Icon = item.icon;
            const active = currentPage === item.key;
            return (
              <button
                key={item.key}
                onClick={() => { onPageChange(item.key); setSidebarOpen(false); }}
                className={`w-full flex items-center gap-3 px-3 py-2.5 rounded-lg text-sm font-medium transition-all ${
                  active
                    ? 'bg-primary-50 text-primary-700'
                    : 'text-slate-600 hover:bg-slate-50 hover:text-slate-900'
                }`}
              >
                <Icon className={`w-4 h-4 shrink-0 ${active ? 'text-primary-600' : 'text-slate-400'}`} />
                {item.label}
              </button>
            );
          })}
        </nav>

      </aside>

      {/* Main content */}
      <div className="flex-1 flex flex-col min-w-0 overflow-hidden">
        <header className="sticky top-0 z-20 bg-white/80 backdrop-blur border-b border-slate-200 px-4 lg:px-8 py-4 flex items-center justify-between">
          <div className="flex items-center gap-3">
            <button
              onClick={() => setSidebarOpen(true)}
              className="lg:hidden text-slate-500 hover:text-slate-700"
            >
              <Menu className="w-6 h-6" />
            </button>
            <h1 className="text-lg font-semibold text-slate-900">{currentNav?.label}</h1>
          </div>
          <div className="flex items-center gap-2">
            {/* Command Palette trigger */}
            <button
              onClick={() => setCmdOpen(true)}
              className="hidden md:flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-slate-100 hover:bg-slate-200 text-slate-500 text-xs font-medium transition-colors"
              title="Command Palette (⌘K)"
            >
              <Command className="w-3.5 h-3.5" />
              <span className="text-[10px] text-slate-400">⌘K</span>
            </button>
            {/* Workspace switcher in header (desktop) */}
            <div className="hidden lg:block">
              <WorkspaceSwitcher currentWorkspace="administration" />
            </div>
          </div>
        </header>

        <main className="flex-1 overflow-auto p-4 lg:p-8 animate-fade-in">{children}</main>
      </div>

      <CommandPalette
        isOpen={cmdOpen}
        onClose={() => setCmdOpen(false)}
        currentWorkspace="administration"
      />
    </div>
  );
}
