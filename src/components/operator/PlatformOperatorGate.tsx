// Issue #45 — single gate for EIOS and platform-operator pages.
//
// Replaces the legacy `profiles.role === 'admin'` check. Access needs an
// explicit operator grant (made only in the Supabase SQL Editor) plus MFA.
// The database enforces the same rule on every EIOS table and function, so
// this gate is for a clear experience, not the security boundary itself.

import { createContext, useCallback, useContext, useEffect, useState, type ReactNode } from 'react';
import { ShieldOff, LifeBuoy } from 'lucide-react';
import { getPlatformOperatorStatus, endSupportSession, formatTime, NOT_OPERATOR, type PlatformOperatorStatus } from '../../lib/platformOperator';
import { OperatorMfaStep } from './OperatorMfaStep';

interface OperatorContextValue { status: PlatformOperatorStatus; refresh: () => Promise<void>; }
const OperatorContext = createContext<OperatorContextValue>({ status: NOT_OPERATOR, refresh: async () => {} });
export const usePlatformOperator = () => useContext(OperatorContext);

export function SupportSessionBanner() {
  const { status, refresh } = usePlatformOperator();
  const [busy, setBusy] = useState(false);
  const session = status.session;
  if (!session) return null;
  async function end() {
    setBusy(true);
    try { await endSupportSession(); } finally { setBusy(false); await refresh(); }
  }
  return (
    <div className="sticky top-0 z-50 bg-amber-100 border-b border-amber-300 text-amber-900 text-sm px-4 py-2 flex items-center gap-3" role="status" data-testid="support-session-banner">
      <LifeBuoy className="w-4 h-4 shrink-0" />
      <span className="flex-1 min-w-0 truncate">
        Supporting: <strong>{session.organisation_name}</strong> — ends {formatTime(session.expires_at)}
      </span>
      <button onClick={end} disabled={busy} className="px-3 py-1 rounded-md bg-amber-900 text-white text-xs font-semibold disabled:opacity-50">
        End session
      </button>
    </div>
  );
}

export function PlatformOperatorGate({ children }: { children: ReactNode }) {
  const [status, setStatus] = useState<PlatformOperatorStatus | null>(null);

  const refresh = useCallback(async () => { setStatus(await getPlatformOperatorStatus()); }, []);
  useEffect(() => { refresh(); }, [refresh]);

  // Session expiry: re-check when the support session is due to end.
  useEffect(() => {
    const expires = status?.session?.expires_at;
    if (!expires) return;
    const ms = new Date(expires).getTime() - Date.now();
    const t = window.setTimeout(refresh, Math.max(1000, ms + 1000));
    return () => window.clearTimeout(t);
  }, [status?.session?.expires_at, refresh]);

  if (!status) {
    return <div className="min-h-screen flex items-center justify-center bg-slate-50 text-sm text-slate-500">Checking access…</div>;
  }
  if (!status.granted) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-slate-50 px-4">
        <div className="max-w-md bg-white border border-slate-200 rounded-2xl p-6 text-center space-y-3" data-testid="operator-access-denied">
          <ShieldOff className="w-8 h-8 text-slate-400 mx-auto" />
          <h1 className="text-lg font-semibold text-slate-900">Platform operator access required</h1>
          <p className="text-sm text-slate-600">This area is for LLND Automate platform operators. RTO workspace permissions don't include it.</p>
          <a href="/" className="inline-block text-sm text-primary-600 font-semibold">Go to LLND Automate</a>
        </div>
      </div>
    );
  }
  if (!status.mfa_verified || !status.operator) {
    return <OperatorMfaStep onVerified={refresh} />;
  }
  return (
    <OperatorContext.Provider value={{ status, refresh }}>
      <SupportSessionBanner />
      {children}
    </OperatorContext.Provider>
  );
}
