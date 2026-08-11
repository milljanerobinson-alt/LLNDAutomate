import { FormEvent, ReactNode, useMemo, useState } from 'react';
import { AlertCircle, CheckCircle2, Eye, EyeOff, GraduationCap, Loader2 } from 'lucide-react';
import { useAuth } from '../lib/auth';
import { accountPasswordError, ACCOUNT_PASSWORD_MIN_LENGTH } from '../lib/accountPassword';
import { getInitialAuthCallback, supabase } from '../lib/supabase';
import { type CustomerWorkspace, workspaceHash } from '../lib/workspaceAccess';

const WORKSPACE_ORDER: CustomerWorkspace[] = ['administration', 'candidate_support', 'technical'];

function invalidInvitation() {
  return (
    <InviteShell>
      <AlertCircle className="h-12 w-12 text-amber-500 mb-5" aria-hidden="true" />
      <h1 className="text-2xl font-bold text-slate-900">This invitation link is invalid or has expired</h1>
      <p className="mt-3 text-slate-600">
        For your security, invitation links can only be used while they are valid. Contact your RTO administrator and ask them to send you a new invitation.
      </p>
      <a href="/" className="mt-7 inline-flex text-primary-700 font-semibold hover:text-primary-800">Return to LLND Automate</a>
    </InviteShell>
  );
}

export function AcceptInvitePage() {
  const { session, markOtpVerified } = useAuth();
  const callback = useMemo(() => getInitialAuthCallback(), []);
  const [password, setPassword] = useState('');
  const [confirmation, setConfirmation] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [complete, setComplete] = useState(false);

  const validInviteSession = callback.type === 'invite' && !callback.errorCode && Boolean(session?.user);
  if (!validInviteSession) return invalidInvitation();

  async function handleSubmit(event: FormEvent) {
    event.preventDefault();
    const validationError = accountPasswordError(password, confirmation);
    if (validationError) {
      setError(validationError);
      return;
    }

    setSaving(true);
    setError(null);
    const { error: updateError } = await supabase.auth.updateUser({ password });
    if (updateError) {
      setError('We could not finish setting up your account. Please request a new invitation from your RTO administrator.');
      setSaving(false);
      return;
    }

    let destination: CustomerWorkspace | null = null;
    for (let attempt = 0; attempt < 20 && !destination; attempt += 1) {
      const [{ data: profile }, { data: access }] = await Promise.all([
        supabase.from('profiles').select('is_active').eq('id', session!.user.id).maybeSingle(),
        supabase.from('user_workspace_access').select('workspace,is_primary').eq('user_id', session!.user.id),
      ]);
      if (profile?.is_active && access?.length) {
        const authorised = access
          .filter(row => WORKSPACE_ORDER.includes(row.workspace as CustomerWorkspace))
          .sort((a, b) => {
            if (a.is_primary !== b.is_primary) return a.is_primary ? -1 : 1;
            return WORKSPACE_ORDER.indexOf(a.workspace as CustomerWorkspace) - WORKSPACE_ORDER.indexOf(b.workspace as CustomerWorkspace);
          });
        destination = authorised[0]?.workspace as CustomerWorkspace | null;
      }
      if (!destination) await new Promise(resolve => setTimeout(resolve, 250));
    }

    if (!destination) {
      setError('Your account was confirmed, but workspace access is not ready. Please contact your RTO administrator.');
      setSaving(false);
      return;
    }

    markOtpVerified();
    setComplete(true);
    const target = workspaceHash(destination, 'dashboard');
    window.setTimeout(() => window.location.replace(`/${target}`), 700);
  }

  return (
    <InviteShell>
      {complete ? (
        <>
          <CheckCircle2 className="h-12 w-12 text-emerald-500 mb-5" aria-hidden="true" />
          <h1 className="text-2xl font-bold text-slate-900">Your LLND Automate account is ready</h1>
          <p className="mt-3 text-slate-600">Opening your authorised workspace…</p>
        </>
      ) : (
        <>
          <h1 className="text-2xl font-bold text-slate-900">Set up your LLND Automate account</h1>
          <p className="mt-3 text-slate-600">Choose a secure password to finish accepting your RTO staff invitation.</p>
          <form className="mt-7 space-y-5" onSubmit={handleSubmit}>
            <label className="block">
              <span className="text-sm font-medium text-slate-700">Password</span>
              <span className="relative mt-1.5 block">
                <input
                  type={showPassword ? 'text' : 'password'}
                  value={password}
                  onChange={event => setPassword(event.target.value)}
                  autoComplete="new-password"
                  className="w-full rounded-lg border border-slate-300 px-3 py-2.5 pr-11 focus:border-primary-500 focus:outline-none focus:ring-2 focus:ring-primary-200"
                  required
                />
                <button type="button" onClick={() => setShowPassword(value => !value)} aria-label={showPassword ? 'Hide password' : 'Show password'} className="absolute inset-y-0 right-0 px-3 text-slate-500">
                  {showPassword ? <EyeOff className="h-5 w-5" /> : <Eye className="h-5 w-5" />}
                </button>
              </span>
            </label>
            <label className="block">
              <span className="text-sm font-medium text-slate-700">Confirm password</span>
              <input
                type={showPassword ? 'text' : 'password'}
                value={confirmation}
                onChange={event => setConfirmation(event.target.value)}
                autoComplete="new-password"
                className="mt-1.5 w-full rounded-lg border border-slate-300 px-3 py-2.5 focus:border-primary-500 focus:outline-none focus:ring-2 focus:ring-primary-200"
                required
              />
            </label>
            <p className="text-xs text-slate-500">Use at least {ACCOUNT_PASSWORD_MIN_LENGTH} characters with uppercase, lowercase and a number.</p>
            {error && <p role="alert" className="rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700">{error}</p>}
            <button disabled={saving} className="flex w-full items-center justify-center rounded-lg bg-primary-600 px-4 py-3 font-semibold text-white hover:bg-primary-700 disabled:opacity-60">
              {saving ? <><Loader2 className="mr-2 h-5 w-5 animate-spin" /> Setting up account…</> : 'Set up my account'}
            </button>
          </form>
        </>
      )}
    </InviteShell>
  );
}

function InviteShell({ children }: { children: ReactNode }) {
  return (
    <main className="min-h-screen bg-slate-50 px-5 py-12 flex items-center justify-center">
      <section className="w-full max-w-lg rounded-2xl bg-white p-8 shadow-lg border border-slate-200">
        <div className="mb-8 flex items-center gap-3 text-primary-700">
          <span className="flex h-11 w-11 items-center justify-center rounded-xl bg-primary-50"><GraduationCap className="h-6 w-6" /></span>
          <span className="text-xl font-bold">LLND Automate</span>
        </div>
        {children}
      </section>
    </main>
  );
}
