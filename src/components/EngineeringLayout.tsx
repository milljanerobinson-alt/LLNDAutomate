import { useState, useEffect, ReactNode } from 'react';
import { Terminal, Command, Globe, Box } from 'lucide-react';
import { WorkspaceSwitcher } from './WorkspaceSwitcher';
import { CommandPalette } from './CommandPalette';
import { ActiveProjectService, type WorkspaceMode, type EccProject } from '../lib/activeProjectService';

interface EngineeringLayoutProps {
  children: ReactNode;
}

export function EngineeringLayout({ children }: EngineeringLayoutProps) {
  const [cmdOpen, setCmdOpen] = useState(false);
  const [workspaceMode, setWorkspaceMode] = useState<WorkspaceMode>(() =>
    ActiveProjectService.getWorkspaceMode()
  );
  const [activeProject, setActiveProject] = useState<EccProject | null>(null);
  const [hasProjects, setHasProjects] = useState(true);

  useEffect(() => {
    ActiveProjectService.listProjects().then(list => {
      setHasProjects(list.length > 0);
      if (list.length === 0) {
        setWorkspaceMode('platform');
        setActiveProject(null);
        return;
      }
      ActiveProjectService.resolveActiveProject().then(p => {
        setActiveProject(p);
        setWorkspaceMode(ActiveProjectService.getWorkspaceMode());
      });
    });
  }, []);

  // Re-sync on storage changes (context switches update localStorage)
  useEffect(() => {
    const onStorage = () => {
      setWorkspaceMode(ActiveProjectService.getWorkspaceMode());
      ActiveProjectService.resolveActiveProject().then(setActiveProject);
    };
    window.addEventListener('storage', onStorage);
    return () => window.removeEventListener('storage', onStorage);
  }, []);

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

  const contextLabel = workspaceMode === 'platform'
    ? 'Platform'
    : (activeProject?.name ?? 'Project');

  return (
    <div className="h-screen bg-slate-900 flex flex-col overflow-hidden">
      {/* Slim identity bar */}
      <div className="shrink-0 bg-slate-900 border-b border-slate-800 px-4 py-2 flex items-center justify-between">
        <div className="flex items-center gap-2.5">
          <div className="w-6 h-6 rounded-md bg-blue-600 flex items-center justify-center">
            <Terminal className="w-3.5 h-3.5 text-white" />
          </div>
          <div className="flex items-center gap-1.5">
            <span className="text-xs font-bold text-white">AI Technical Director</span>
            <span className="text-[10px] text-slate-500">·</span>
            <span className="text-[10px] font-semibold text-slate-400 uppercase tracking-widest">EIOS</span>
          </div>
        </div>

        <div className="flex items-center gap-2">
          {/* Active context badge — hidden in Platform-only mode (no projects) */}
          {hasProjects && (
          <div className="hidden sm:flex items-center gap-1.5 px-2.5 py-1 rounded-lg bg-slate-800 border border-slate-700/50">
            {workspaceMode === 'platform' ? (
              <Globe className="w-3 h-3 text-slate-400" />
            ) : (
              <Box className="w-3 h-3 text-blue-400" />
            )}
            <span className="text-[10px] font-semibold text-slate-300 uppercase tracking-wide">
              {workspaceMode === 'platform' ? 'Platform' : 'Project'}
            </span>
            <span className="text-[10px] text-slate-500">·</span>
            <span className="text-[10px] font-semibold text-white truncate max-w-[120px]">
              {contextLabel}
            </span>
          </div>
          )}

          {/* Command Palette trigger */}
          <button
            onClick={() => setCmdOpen(true)}
            className="hidden md:flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg bg-slate-800 hover:bg-slate-700 border border-slate-700 text-slate-400 hover:text-slate-200 transition-all text-xs font-medium"
            title="Command Palette (⌘K)"
          >
            <Command className="w-3 h-3" />
            <span className="text-[10px] text-slate-500">⌘K</span>
          </button>

          <a
            href="#/operator/support"
            data-testid="operator-support-link"
            className="px-2.5 py-1.5 rounded-lg bg-slate-800 hover:bg-slate-700 border border-slate-700 text-slate-300 hover:text-white text-xs font-medium"
          >
            RTO support
          </a>

          <WorkspaceSwitcher currentWorkspace="engineering" />
        </div>
      </div>

      {/* ECC content — full height */}
      <div className="flex-1 overflow-hidden">
        {children}
      </div>

      <CommandPalette
        isOpen={cmdOpen}
        onClose={() => setCmdOpen(false)}
        currentWorkspace="engineering"
      />
    </div>
  );
}
