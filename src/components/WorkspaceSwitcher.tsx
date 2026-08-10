import { useState, useEffect, useRef } from 'react';
import { GraduationCap, Terminal, ChevronDown, LogOut, Check, Wrench } from 'lucide-react';
import { useAuth } from '../lib/auth';
import { supabase } from '../lib/supabase';
import {
  useWorkspaceAccess,
  workspaceHash,
  setLastWorkspace,
  getLastPage,
  type AnyWorkspace,
  type CustomerWorkspace,
} from '../lib/workspaceAccess';
import { navigateInProduct, resolveProduct } from '../lib/productContext';

export type Workspace = AnyWorkspace;

// ─── Workspace registry ───────────────────────────────────────────────────────

interface WsDef {
  key: AnyWorkspace;
  label: string;
  sub: string;
  icon: typeof GraduationCap;
  accent: string;
  bg: string;
  border: string;
  dot: string;
}

const ALL_WORKSPACES: WsDef[] = [
  {
    key: 'administration',
    label: 'Administration Workspace',
    sub: 'Organisation oversight',
    icon: GraduationCap,
    accent: 'text-primary-600',
    bg: 'bg-primary-50',
    border: 'border-primary-200',
    dot: 'bg-primary-500',
  },
  {
    key: 'candidate_support',
    label: 'Candidate Support Workspace',
    sub: 'Candidates requiring support',
    icon: GraduationCap,
    accent: 'text-emerald-600',
    bg: 'bg-emerald-50',
    border: 'border-emerald-200',
    dot: 'bg-emerald-500',
  },
  {
    key: 'technical',
    label: 'Technical Workspace',
    sub: 'Integration and diagnostics',
    icon: Wrench,
    accent: 'text-slate-700',
    bg: 'bg-slate-100',
    border: 'border-slate-300',
    dot: 'bg-slate-600',
  },
  {
    key: 'engineering',
    label: 'Engineering Command Centre',
    sub: 'Build · Govern · Evolve',
    icon: Terminal,
    accent: 'text-blue-600',
    bg: 'bg-blue-50',
    border: 'border-blue-200',
    dot: 'bg-blue-500',
  },
];

// ─── switchTo helper ──────────────────────────────────────────────────────────

export function switchTo(workspace: AnyWorkspace) {
  setLastWorkspace(workspace);
  const page = getLastPage(workspace);
  navigateInProduct(workspace === 'engineering' ? 'eios' : 'llnd', workspaceHash(workspace, page));
}

// ─── Component ────────────────────────────────────────────────────────────────

interface WorkspaceSwitcherProps {
  currentWorkspace: AnyWorkspace;
}

export function WorkspaceSwitcher({ currentWorkspace }: WorkspaceSwitcherProps) {
  const { user, profile, signOut } = useAuth();
  const { workspaces: customerAccess, loading: accessLoading } = useWorkspaceAccess();
  const [open, setOpen] = useState(false);
  const [inboxCount, setInboxCount] = useState(0);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const handleClick = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', handleClick);
    return () => document.removeEventListener('mousedown', handleClick);
  }, []);

  useEffect(() => {
    if (!user || resolveProduct() !== 'eios') {
      setInboxCount(0);
      return;
    }
    async function loadCount() {
      const { count } = await supabase
        .from('ecc_ai_inbox')
        .select('*', { count: 'exact', head: true })
        .eq('status', 'pending');
      setInboxCount(count ?? 0);
    }
    loadCount();
    const id = setInterval(loadCount, 30_000);
    return () => clearInterval(id);
  }, [user]);

  // Determine which workspaces this user can see
  const isAdmin = profile?.role === 'admin';
  const product = resolveProduct();
  const availableWorkspaces = ALL_WORKSPACES.filter(ws => {
    if (product === 'eios') return ws.key === 'engineering' && isAdmin;
    if (ws.key === 'engineering') return false;
    return customerAccess.some(ca => ca.workspace === ws.key as CustomerWorkspace);
  });

  const current = ALL_WORKSPACES.find(w => w.key === currentWorkspace) ?? ALL_WORKSPACES[0];
  const CurrentIcon = current.icon;

  return (
    <div className="relative" ref={ref}>
      <button
        data-testid="workspace-switcher-trigger"
        onClick={() => setOpen(s => !s)}
        className="flex items-center gap-2 px-3 py-1.5 rounded-xl border border-slate-200 bg-white hover:bg-slate-50 hover:border-slate-300 transition-all text-sm font-medium text-slate-700 shadow-sm"
      >
        <CurrentIcon className={`w-4 h-4 ${current.accent}`} />
        <span className="hidden sm:inline max-w-36 truncate">{current.label}</span>
        {inboxCount > 0 && currentWorkspace === 'engineering' && (
          <span className="w-4 h-4 rounded-full bg-blue-500 text-white text-[9px] font-bold flex items-center justify-center shrink-0">
            {inboxCount > 9 ? '9+' : inboxCount}
          </span>
        )}
        <ChevronDown className={`w-3.5 h-3.5 text-slate-400 transition-transform ${open ? 'rotate-180' : ''}`} />
      </button>

      {open && (
        <div data-testid="workspace-switcher-menu" className="absolute top-full right-0 mt-2 w-80 max-w-[calc(100vw-2rem)] bg-white border border-slate-200 rounded-2xl shadow-xl z-50 overflow-hidden">
          {/* Header */}
          <div className="px-4 py-3 border-b border-slate-100 bg-slate-50/60">
            <p className="text-[10px] font-bold text-slate-500 uppercase tracking-widest">Switch Workspace</p>
          </div>

          {/* Workspace options */}
          <div className="p-2 space-y-0.5">
            {accessLoading ? (
              <div className="py-4 text-center text-xs text-slate-400">Loading workspaces…</div>
            ) : availableWorkspaces.length === 0 ? (
              <div className="py-4 text-center text-xs text-slate-400">No workspaces available.</div>
            ) : (
              availableWorkspaces.map(ws => {
                const Icon = ws.icon;
                const isCurrent = ws.key === currentWorkspace;
                const hasEngNotif = ws.key === 'engineering' && inboxCount > 0;
                return (
                  <button
                    key={ws.key}
                    data-workspace={ws.key}
                    onClick={() => {
                      if (!isCurrent) switchTo(ws.key);
                      setOpen(false);
                    }}
                    className={`w-full flex items-center gap-3 px-3 py-2.5 rounded-xl text-left transition-all ${
                      isCurrent
                        ? `${ws.bg} ${ws.border} border`
                        : 'hover:bg-slate-50 border border-transparent'
                    }`}
                  >
                    <div className={`w-8 h-8 rounded-lg flex items-center justify-center shrink-0 ${
                      isCurrent ? `${ws.bg} border ${ws.border}` : 'bg-slate-100'
                    }`}>
                      <Icon className={`w-4 h-4 ${isCurrent ? ws.accent : 'text-slate-500'}`} />
                    </div>
                    <div className="flex-1 min-w-0">
                      <p className={`text-sm font-semibold leading-tight ${isCurrent ? 'text-slate-900' : 'text-slate-700'}`}>
                        {ws.label}
                      </p>
                      <p className="text-[10px] text-slate-400 mt-0.5">{ws.sub}</p>
                    </div>
                    <div className="flex items-center gap-1.5 shrink-0">
                      {hasEngNotif && (
                        <span className="w-5 h-5 rounded-full bg-blue-500 text-white text-[9px] font-bold flex items-center justify-center">
                          {inboxCount > 9 ? '9+' : inboxCount}
                        </span>
                      )}
                      {isCurrent && <Check className={`w-3.5 h-3.5 ${ws.accent}`} />}
                    </div>
                  </button>
                );
              })
            )}
          </div>

          <div className="border-t border-slate-100 mx-2" />

          {/* User + sign out */}
          <div className="px-3 py-3">
            <div className="flex items-center gap-3 px-2 py-1.5 mb-1">
              <div className="w-8 h-8 rounded-full bg-primary-100 text-primary-700 flex items-center justify-center text-sm font-bold shrink-0">
                {profile?.full_name?.charAt(0).toUpperCase() || '?'}
              </div>
              <div className="flex-1 min-w-0">
                <p className="text-sm font-medium text-slate-900 truncate">{profile?.full_name || 'User'}</p>
                <p className="text-[10px] text-slate-400 capitalize">{profile?.role || ''}</p>
              </div>
            </div>
            <button
              onClick={() => { setOpen(false); signOut(); }}
              className="w-full flex items-center gap-2.5 px-3 py-2 rounded-xl text-sm text-slate-600 hover:bg-slate-50 hover:text-red-600 transition-all"
            >
              <LogOut className="w-4 h-4 text-slate-400" />
              Sign out
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
