import { useState, useEffect } from 'react';
import { supabase } from './supabase';
import { useAuth } from './auth';

export type CustomerWorkspace = 'administration' | 'candidate_support' | 'technical';
export type AnyWorkspace = CustomerWorkspace | 'engineering';

export interface WorkspaceAccess {
  workspace: CustomerWorkspace;
  is_primary: boolean;
}

export interface UseWorkspaceAccessResult {
  workspaces: WorkspaceAccess[];
  primaryWorkspace: CustomerWorkspace;
  hasWorkspace: (ws: CustomerWorkspace) => boolean;
  loading: boolean;
}

export function useWorkspaceAccess(): UseWorkspaceAccessResult {
  const { user, profile } = useAuth();
  const [workspaces, setWorkspaces] = useState<WorkspaceAccess[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    if (!user) { setLoading(false); return; }
    load();
  }, [user?.id]);

  async function load() {
    setLoading(true);
    const { data } = await supabase
      .from('user_workspace_access')
      .select('workspace, is_primary')
      .eq('user_id', user!.id)
      .order('is_primary', { ascending: false });

    if (data && data.length > 0) {
      const legacyMap: Record<string, CustomerWorkspace> = {
        assessment: 'administration', trainer: 'candidate_support', platform_admin: 'technical',
      };
      setWorkspaces(data.map(row => ({
        workspace: legacyMap[row.workspace] ?? row.workspace as CustomerWorkspace,
        is_primary: row.is_primary,
      })));
    } else {
      // Fallback: derive from role if no DB rows exist yet
      const fallback = deriveFromRole(profile?.role ?? 'admin');
      setWorkspaces(fallback);
    }
    setLoading(false);
  }

  const primaryWorkspace: CustomerWorkspace =
    workspaces.find(w => w.is_primary)?.workspace ??
    workspaces[0]?.workspace ??
    'administration';

  function hasWorkspace(ws: CustomerWorkspace) {
    return workspaces.some(w => w.workspace === ws);
  }

  return { workspaces, primaryWorkspace, hasWorkspace, loading };
}

function deriveFromRole(role: string): WorkspaceAccess[] {
  if (role === 'admin') {
    return [
      { workspace: 'administration', is_primary: true },
      { workspace: 'candidate_support', is_primary: false },
      { workspace: 'technical', is_primary: false },
    ];
  }
  if (role === 'trainer') {
    return [
      { workspace: 'candidate_support', is_primary: true },
    ];
  }
  return [{ workspace: 'administration', is_primary: true }];
}

// Storage helpers
export function getLastWorkspace(): AnyWorkspace {
  const stored = localStorage.getItem('ecc_workspace');
  const legacy: Record<string, CustomerWorkspace> = {
    assessment: 'administration',
    trainer: 'candidate_support',
    platform_admin: 'technical',
  };
  const resolved = (stored && legacy[stored]) || stored;
  return (resolved as AnyWorkspace) || 'engineering';
}

export function setLastWorkspace(ws: AnyWorkspace) {
  localStorage.setItem('ecc_workspace', ws);
}

export function getLastPage(ws: AnyWorkspace): string {
  return localStorage.getItem(`ecc_workspace_page_${ws}`) || defaultPage(ws);
}

export function setLastPage(ws: AnyWorkspace, page: string) {
  localStorage.setItem(`ecc_workspace_page_${ws}`, page);
}

function defaultPage(ws: AnyWorkspace): string {
  switch (ws) {
    case 'administration':   return 'dashboard';
    case 'candidate_support':return 'dashboard';
    case 'technical':        return 'dashboard';
    case 'engineering':   return 'mission-control';
  }
}

export function workspaceHash(ws: AnyWorkspace, page: string): string {
  switch (ws) {
    case 'engineering':    return `#/engineering/${page}`;
    case 'administration':    return `#/rto-admin/${page}`;
    case 'candidate_support': return `#/candidate-support/${page}`;
    case 'technical':         return `#/technical/${page}`;
  }
}
