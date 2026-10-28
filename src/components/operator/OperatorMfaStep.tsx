// Issue #45 — second factor (TOTP) for platform operators.
//
// Supabase MFA raises the session to aal2, which is_platform_operator()
// requires. An operator enrols an authenticator app once, then enters a
// six-digit code on each sign-in.

import { useEffect, useState } from 'react';
import { ShieldCheck } from 'lucide-react';
import { supabase } from '../../lib/supabase';

interface Props { onVerified: () => void; }

export function OperatorMfaStep({ onVerified }: Props) {
  const [factorId, setFactorId] = useState<string | null>(null);
  const [qr, setQr] = useState<string | null>(null);
  const [code, setCode] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    (async () => {
      const { data, error: listError } = await supabase.auth.mfa.listFactors();
      if (listError) { setError(listError.message); setLoading(false); return; }
      const verified = data?.totp?.find(f => f.status === 'verified');
      if (verified) { setFactorId(verified.id); setLoading(false); return; }
      // Remove abandoned unverified enrolments so a fresh one can start.
      for (const f of data?.all ?? []) {
        if (f.factor_type === 'totp' && f.status !== 'verified') await supabase.auth.mfa.unenroll({ factorId: f.id });
      }
      const { data: enrol, error: enrolError } = await supabase.auth.mfa.enroll({ factorType: 'totp', friendlyName: 'LLND Automate operator' });
      if (enrolError || !enrol) { setError(enrolError?.message ?? 'Could not start authenticator setup'); setLoading(false); return; }
      setFactorId(enrol.id);
      setQr(enrol.totp.qr_code);
      setLoading(false);
    })();
  }, []);

  async function verify() {
    if (!factorId || !/^\d{6}$/.test(code.trim())) { setError('Enter the six-digit code from your authenticator app.'); return; }
    setBusy(true); setError('');
    const { error: verifyError } = await supabase.auth.mfa.challengeAndVerify({ factorId, code: code.trim() });
    setBusy(false);
    if (verifyError) { setError('That code was not accepted. Check the time on your device and try again.'); return; }
    await supabase.auth.refreshSession();
    onVerified();
  }

  return (
    <div className="min-h-screen flex items-center justify-center bg-slate-50 px-4">
      <div className="w-full max-w-md bg-white border border-slate-200 rounded-2xl p-6 space-y-4" data-testid="operator-mfa">
        <div className="flex items-center gap-3">
          <ShieldCheck className="w-6 h-6 text-primary-600" />
          <h1 className="text-lg font-semibold text-slate-900">Platform operator verification</h1>
        </div>
        {loading ? <p className="text-sm text-slate-500">Loading…</p> : (
          <>
            {qr ? (
              <>
                <p className="text-sm text-slate-600">Scan this code with an authenticator app, then enter the six-digit code it shows. You only need to do this once.</p>
                <img src={qr} alt="Authenticator setup code" className="mx-auto w-44 h-44" />
              </>
            ) : (
              <p className="text-sm text-slate-600">Enter the six-digit code from your authenticator app.</p>
            )}
            <input
              value={code}
              onChange={e => setCode(e.target.value)}
              inputMode="numeric"
              autoComplete="one-time-code"
              maxLength={6}
              aria-label="Authenticator code"
              className="w-full border border-slate-300 rounded-lg px-3 py-2 tracking-widest text-center"
            />
            <button onClick={verify} disabled={busy || !factorId} className="w-full px-4 py-2 bg-primary-600 text-white rounded-lg text-sm font-semibold disabled:opacity-50">
              {busy ? 'Checking…' : 'Verify'}
            </button>
          </>
        )}
        {error && <p className="text-sm text-red-600" role="alert">{error}</p>}
      </div>
    </div>
  );
}
