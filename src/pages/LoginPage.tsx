import { useState, useEffect, useRef, KeyboardEvent, ClipboardEvent } from 'react';
import { GraduationCap, AlertCircle, Loader2, Eye, EyeOff, MailCheck, CheckCircle2, ArrowLeft, ShieldCheck, RefreshCw } from 'lucide-react';
import { useAuth } from '../lib/auth';
import { supabase } from '../lib/supabase';
import { productBaseUrl } from '../lib/productContext';

const SUPABASE_URL = import.meta.env.VITE_SUPABASE_URL as string;
const SUPABASE_ANON_KEY = import.meta.env.VITE_SUPABASE_ANON_KEY as string;

export type LoginContext = 'eios' | 'eios-oauth' | 'llnd-automate';

export function LoginPage({ loginContext = 'eios', oauthRedirect }: { loginContext?: LoginContext; oauthRedirect?: string }) {
  const { signInWithGoogle, signInWithApple, isRecovery, user, markOtpVerified } = useAuth();
  const isEios = loginContext === 'eios' || loginContext === 'eios-oauth';
  const isEiosOAuth = loginContext === 'eios-oauth';
  const isLlnd = loginContext === 'llnd-automate';
  const [loading, setLoading] = useState<null | 'google' | 'apple' | 'email' | 'otp' | 'resend'>(null);
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [showPassword, setShowPassword] = useState(false);
  const [view, setView] = useState<'auth' | 'otp' | 'forgot' | 'sent' | 'recovery'>('auth');
  const [resetEmail, setResetEmail] = useState('');
  const [resetLoading, setResetLoading] = useState(false);
  const [newPassword, setNewPassword] = useState('');
  const [updateLoading, setUpdateLoading] = useState(false);
  const [updateSuccess, setUpdateSuccess] = useState(false);

  // OTP state
  const [otpDigits, setOtpDigits] = useState(['', '', '', '', '', '']);
  const [otpEmailSent, setOtpEmailSent] = useState(false);
  const [devCode, setDevCode] = useState<string | null>(null);
  const inputRefs = useRef<(HTMLInputElement | null)[]>([]);

  useEffect(() => {
    if (isRecovery) setView('recovery');
    if (window.location.hash === '#/forgot-password') setView('forgot');
  }, [isRecovery]);

  // When a session already exists (page refresh), jump straight to OTP step
  useEffect(() => {
    if (user && view === 'auth') {
      setView('otp');
    }
  }, [user, view]);

  async function sendOtp(): Promise<boolean> {
    const { data: { session } } = await supabase.auth.getSession();
    if (!session) { setError('Session expired. Please sign in again.'); return false; }

    const resp = await fetch(`${SUPABASE_URL}/functions/v1/send-admin-otp`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${session.access_token}`,
        'Content-Type': 'application/json',
        'Apikey': SUPABASE_ANON_KEY,
      },
      body: JSON.stringify({}),
    });

    const data = await resp.json();
    if (!resp.ok) {
      setError(data.error || 'Failed to send verification code');
      return false;
    }

    setOtpEmailSent(true);
    if (data.dev_code) setDevCode(data.dev_code);
    return true;
  }

  async function handleEmailAuth(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setLoading('email');
    try {
      const { error } = await supabase.auth.signInWithPassword({ email, password });
      if (error) throw error;
      // Send OTP immediately after password success
      const sent = await sendOtp();
      if (sent) setView('otp');
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'Authentication failed');
    } finally {
      setLoading(null);
    }
  }

  async function handleSendOtp() {
    setError(null);
    setLoading('otp');
    await sendOtp();
    setLoading(null);
  }

  async function handleResendOtp() {
    setError(null);
    setLoading('resend');
    setOtpDigits(['', '', '', '', '', '']);
    setDevCode(null);
    await sendOtp();
    setLoading(null);
  }

  async function handleVerifyOtp(e: React.FormEvent) {
    e.preventDefault();
    const code = otpDigits.join('');
    if (code.length !== 6) { setError('Please enter all 6 digits'); return; }

    setError(null);
    setLoading('otp');
    try {
      const { data: { session } } = await supabase.auth.getSession();
      if (!session) throw new Error('Session expired. Please sign in again.');

      const resp = await fetch(`${SUPABASE_URL}/functions/v1/verify-admin-otp`, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${session.access_token}`,
          'Content-Type': 'application/json',
          'Apikey': SUPABASE_ANON_KEY,
        },
        body: JSON.stringify({ code }),
      });

      const data = await resp.json();
      if (!resp.ok) throw new Error(data.error || 'Invalid or expired code');

      markOtpVerified();
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'Verification failed');
    } finally {
      setLoading(null);
    }
  }

  function handleOtpInput(index: number, value: string) {
    const digit = value.replace(/\D/g, '').slice(-1);
    const newDigits = [...otpDigits];
    newDigits[index] = digit;
    setOtpDigits(newDigits);
    if (digit && index < 5) inputRefs.current[index + 1]?.focus();
  }

  function handleOtpKeyDown(index: number, e: KeyboardEvent<HTMLInputElement>) {
    if (e.key === 'Backspace' && !otpDigits[index] && index > 0) {
      inputRefs.current[index - 1]?.focus();
    }
    if (e.key === 'ArrowLeft' && index > 0) inputRefs.current[index - 1]?.focus();
    if (e.key === 'ArrowRight' && index < 5) inputRefs.current[index + 1]?.focus();
  }

  function handleOtpPaste(e: ClipboardEvent<HTMLInputElement>) {
    e.preventDefault();
    const text = e.clipboardData.getData('text').replace(/\D/g, '').slice(0, 6);
    const newDigits = [...text.split(''), ...Array(6).fill('')].slice(0, 6);
    setOtpDigits(newDigits);
    const nextEmpty = newDigits.findIndex((d) => !d);
    inputRefs.current[nextEmpty === -1 ? 5 : nextEmpty]?.focus();
  }

  async function handleGoogle() {
    setError(null); setLoading('google');
    try { await signInWithGoogle(); }
    catch { setError('Google sign-in is not configured. Use email/password instead.'); setLoading(null); }
  }

  async function handleApple() {
    setError(null); setLoading('apple');
    try { await signInWithApple(); }
    catch { setError('Apple sign-in is not configured. Use email/password instead.'); setLoading(null); }
  }

  async function handleResetPassword(e: React.FormEvent) {
    e.preventDefault();
    setError(null); setResetLoading(true);
    try {
      const { error } = await supabase.auth.resetPasswordForEmail(resetEmail, {
        redirectTo: productBaseUrl(isEios ? 'eios' : 'llnd'),
      });
      if (error) throw error;
      setView('sent');
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'Failed to send reset email');
    } finally { setResetLoading(false); }
  }

  async function handleUpdatePassword(e: React.FormEvent) {
    e.preventDefault();
    setError(null); setUpdateLoading(true);
    try {
      const { error } = await supabase.auth.updateUser({ password: newPassword });
      if (error) throw error;
      setUpdateSuccess(true);
      setTimeout(() => { setView('auth'); setUpdateSuccess(false); setNewPassword(''); }, 2500);
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'Failed to update password');
    } finally { setUpdateLoading(false); }
  }

  return (
    <div className="min-h-screen flex flex-col lg:flex-row">
      {/* Left panel */}
      <div className={`lg:w-1/2 text-white p-8 lg:p-16 flex flex-col justify-between relative overflow-hidden ${isEios ? 'bg-gradient-to-br from-eios-700 via-eios-800 to-eios-950' : 'bg-gradient-to-br from-primary-700 via-primary-800 to-primary-950'}`}>
        <div className="absolute inset-0 opacity-10">
          <div className={`absolute top-20 left-10 w-72 h-72 rounded-full blur-3xl ${isEios ? 'bg-eios-400' : 'bg-accent-400'}`} />
          <div className={`absolute bottom-20 right-10 w-96 h-96 rounded-full blur-3xl ${isEios ? 'bg-eios-400' : 'bg-primary-400'}`} />
        </div>
        <div className="relative z-10">
          <button onClick={() => { window.location.href = isEiosOAuth ? '#/oauth/consent' : isLlnd ? window.location.origin : '#/login'; }} className="flex items-center gap-3 mb-12">
            <div className="w-11 h-11 bg-white/10 backdrop-blur rounded-xl flex items-center justify-center border border-white/20">
              {isEios ? <ShieldCheck className="w-6 h-6" /> : <GraduationCap className="w-6 h-6" />}
            </div>
            <span className="text-xl font-semibold">{isEios ? 'EIOS' : 'LLND Assess'}</span>
          </button>
        </div>
        <div className="relative z-10 max-w-md">
          <h1 className="text-3xl lg:text-4xl font-bold leading-tight mb-4">
            {isEiosOAuth
              ? 'Engineering Intelligence & Oversight System'
              : isEios
                ? 'Engineering Intelligence Operating System'
                : 'Adaptive LLN & Digital Assessments for Australian RTOs'}
          </h1>
          <p className={`text-lg leading-relaxed ${isEios ? 'text-eios-100' : 'text-primary-100'}`}>
            {isEiosOAuth
              ? 'Continue to authorise ChatGPT to access EIOS. Your engineering records, audit trails, and governed inspections remain protected.'
              : isEios
                ? 'Governed engineering intelligence, ATD, and secure platform integrations for the Engineering Intelligence Operating System.'
                : 'Assess learner readiness, identify support needs and track progress with LLND Assess.'}
          </p>
        </div>
        {isEios ? (
          <div className="relative z-10 flex gap-6 text-sm text-eios-200 mt-8">
            <div><div className="text-2xl font-bold text-white">EIOS</div><div>Platform</div></div>
            <div><div className="text-2xl font-bold text-white">ATD</div><div>Connect</div></div>
            <div><div className="text-2xl font-bold text-white">MCP</div><div>Enabled</div></div>
          </div>
        ) : (
          <div className="relative z-10 flex gap-6 text-sm text-primary-200 mt-8">
            <div><div className="text-2xl font-bold text-white">ACSF</div><div>Mapped</div></div>
            <div><div className="text-2xl font-bold text-white">ASQA</div><div>Compliant</div></div>
            <div><div className="text-2xl font-bold text-white">aXcelerate</div><div>Integrated</div></div>
          </div>
        )}
      </div>

      {/* Right panel */}
      <div className="lg:w-1/2 flex items-center justify-center p-8 lg:p-16 bg-white">
        <div className="w-full max-w-sm">
          {view !== 'otp' && (
            <button
              onClick={() => { window.location.href = isEiosOAuth ? '#/oauth/consent' : isLlnd ? window.location.origin : '#/login'; }}
              className="flex items-center gap-1.5 text-sm text-slate-400 hover:text-slate-600 mb-6 transition-colors"
            >
              <ArrowLeft className="w-4 h-4" /> {isEiosOAuth ? 'Back to authorisation' : isLlnd ? 'Back to website' : 'Back to EIOS'}
            </button>
          )}

          <h2 className="text-2xl font-bold text-slate-900 mb-2">
            {view === 'otp' ? 'Verify your identity' :
             view === 'recovery' ? 'Set a new password' :
             view === 'forgot' || view === 'sent' ? 'Reset your password' :
             isEios ? 'Sign in to EIOS' :
             'Sign in to your account'}
          </h2>
          <p className="text-slate-500 mb-6">
            {view === 'otp'
              ? otpEmailSent
                ? `We sent a 6-digit code to ${user?.email ?? 'your email'}`
                : 'Two-factor verification is required to access the admin portal'
              : isEiosOAuth
                ? 'Continue to authorise ChatGPT to access EIOS.'
                : isEios
                  ? 'Access the Engineering Intelligence Operating System.'
                  : 'Access the LLND Assess dashboard'}
          </p>

          {error && (
            <div className="mb-4 flex items-start gap-2 rounded-lg bg-amber-50 border border-amber-200 px-3 py-2.5 text-sm text-amber-800">
              <AlertCircle className="w-4 h-4 shrink-0 mt-0.5" />
              <span>{error}</span>
            </div>
          )}

          {/* --- AUTH VIEW --- */}
          {view === 'auth' && (
            <form onSubmit={handleEmailAuth} className="space-y-4">
              <div>
                <label className="label">Email</label>
                <input className={isEios ? 'input-eios' : 'input'} type="email" value={email} onChange={(e) => setEmail(e.target.value)} placeholder="you@example.com" required />
              </div>
              <div>
                <label className="label">Password</label>
                <div className="relative">
                  <input
                    className={`${isEios ? 'input-eios' : 'input'} pr-11`} type={showPassword ? 'text' : 'password'}
                    value={password} onChange={(e) => setPassword(e.target.value)}
                    placeholder="Your password" minLength={6} required
                  />
                  <button type="button" onClick={() => setShowPassword(!showPassword)} className="absolute right-3 top-1/2 -translate-y-1/2 text-slate-400 hover:text-slate-600" tabIndex={-1}>
                    {showPassword ? <EyeOff className="w-5 h-5" /> : <Eye className="w-5 h-5" />}
                  </button>
                </div>
              </div>
              <div className="text-right">
                <button type="button" onClick={() => { setView('forgot'); setError(null); setResetEmail(email); }} className={`text-sm font-medium ${isEios ? 'text-eios-600 hover:text-eios-700' : 'text-primary-600 hover:text-primary-700'}`}>
                  Forgot password?
                </button>
              </div>
              <button type="submit" disabled={loading !== null} className={`${isEios ? 'btn-eios' : 'btn-primary'} w-full`}>
                {loading === 'email' ? <><Loader2 className="w-4 h-4 animate-spin" /> Signing in...</> : 'Sign In'}
              </button>
            </form>
          )}

          {/* --- OTP VIEW --- */}
          {view === 'otp' && (
            <div className="space-y-6">
              {/* Security badge */}
              <div className={`flex items-center gap-3 p-3 rounded-xl border ${isEios ? 'bg-eios-50 border-eios-100' : 'bg-primary-50 border-primary-100'}`}>
                <div className={`w-9 h-9 rounded-lg flex items-center justify-center shrink-0 ${isEios ? 'bg-eios-600' : 'bg-primary-600'}`}>
                  <ShieldCheck className="w-5 h-5 text-white" />
                </div>
                <div>
                  <p className={`text-sm font-semibold ${isEios ? 'text-eios-900' : 'text-primary-900'}`}>Two-factor verification</p>
                  <p className={`text-xs ${isEios ? 'text-eios-600' : 'text-primary-600'}`}>Admin account security</p>
                </div>
              </div>

              {!otpEmailSent ? (
                /* Send code prompt (page-refresh case) */
                <div className="space-y-4">
                  <p className="text-sm text-slate-600 leading-relaxed">
                    For security, a one-time code will be sent to <span className="font-medium text-slate-800">{user?.email}</span>. Enter it to access the admin portal.
                  </p>
                  <button
                    onClick={handleSendOtp}
                    disabled={loading !== null}
                    className={`${isEios ? 'btn-eios' : 'btn-primary'} w-full`}
                  >
                    {loading === 'otp' ? <><Loader2 className="w-4 h-4 animate-spin" /> Sending...</> : 'Send verification code'}
                  </button>
                </div>
              ) : (
                /* Code entry form */
                <form onSubmit={handleVerifyOtp} className="space-y-5">
                  {devCode && (
                    <div className="flex items-start gap-2 rounded-lg bg-sky-50 border border-sky-200 px-3 py-2.5 text-sm text-sky-800">
                      <AlertCircle className="w-4 h-4 shrink-0 mt-0.5" />
                      <span>Email not configured — dev code: <strong className="font-mono">{devCode}</strong></span>
                    </div>
                  )}

                  <div>
                    <label className="label text-center block mb-3">Enter 6-digit code</label>
                    <div className="flex gap-2 justify-center">
                      {otpDigits.map((digit, i) => (
                        <input
                          key={i}
                          ref={(el) => { inputRefs.current[i] = el; }}
                          type="text"
                          inputMode="numeric"
                          maxLength={1}
                          value={digit}
                          onChange={(e) => handleOtpInput(i, e.target.value)}
                          onKeyDown={(e) => handleOtpKeyDown(i, e)}
                          onPaste={handleOtpPaste}
                          autoFocus={i === 0}
                          className={`w-11 h-13 text-center text-xl font-bold border-2 rounded-xl focus:outline-none transition-colors bg-slate-50 focus:bg-white ${isEios ? 'border-slate-200 focus:border-eios-500' : 'border-slate-200 focus:border-primary-500'}`}
                          style={{ height: '3.25rem' }}
                        />
                      ))}
                    </div>
                  </div>

                  <button
                    type="submit"
                    disabled={loading !== null || otpDigits.join('').length !== 6}
                    className={`${isEios ? 'btn-eios' : 'btn-primary'} w-full`}
                  >
                    {loading === 'otp' ? <><Loader2 className="w-4 h-4 animate-spin" /> Verifying...</> : 'Verify & Sign In'}
                  </button>

                  <div className="flex items-center justify-between pt-1">
                    <button
                      type="button"
                      onClick={handleResendOtp}
                      disabled={loading !== null}
                      className={`flex items-center gap-1.5 text-sm transition-colors ${isEios ? 'text-slate-500 hover:text-eios-600' : 'text-slate-500 hover:text-primary-600'}`}
                    >
                      <RefreshCw className="w-3.5 h-3.5" />
                      {loading === 'resend' ? 'Sending...' : 'Resend code'}
                    </button>
                    <button
                      type="button"
                      onClick={async () => { await supabase.auth.signOut(); setView('auth'); setOtpEmailSent(false); setOtpDigits(['', '', '', '', '', '']); setError(null); }}
                      className="text-sm text-slate-400 hover:text-slate-600 transition-colors"
                    >
                      Sign out
                    </button>
                  </div>
                </form>
              )}
            </div>
          )}

          {/* --- RECOVERY VIEW --- */}
          {view === 'recovery' && (
            <form onSubmit={handleUpdatePassword} className="space-y-4">
              {updateSuccess ? (
                <div className="flex items-center gap-2 rounded-lg bg-success-50 border border-success-200 px-4 py-3 text-sm text-success-700">
                  <CheckCircle2 className="w-5 h-5 shrink-0" />
                  <span>Password updated! Redirecting...</span>
                </div>
              ) : (
                <>
                  <div>
                    <label className="label">New Password</label>
                    <div className="relative">
                      <input className={`${isEios ? 'input-eios' : 'input'} pr-11`} type={showPassword ? 'text' : 'password'} value={newPassword} onChange={(e) => setNewPassword(e.target.value)} placeholder="Minimum 6 characters" minLength={6} required autoFocus />
                      <button type="button" onClick={() => setShowPassword(!showPassword)} className="absolute right-3 top-1/2 -translate-y-1/2 text-slate-400 hover:text-slate-600" tabIndex={-1}>
                        {showPassword ? <EyeOff className="w-5 h-5" /> : <Eye className="w-5 h-5" />}
                      </button>
                    </div>
                  </div>
                  <button type="submit" disabled={updateLoading} className={`${isEios ? 'btn-eios' : 'btn-primary'} w-full`}>
                    {updateLoading ? <><Loader2 className="w-4 h-4 animate-spin" /> Updating...</> : 'Update password'}
                  </button>
                </>
              )}
            </form>
          )}

          {/* --- FORGOT VIEW --- */}
          {view === 'forgot' && (
            <form onSubmit={handleResetPassword} className="space-y-4">
              <div>
                <label className="label">Email</label>
                <input className={isEios ? 'input-eios' : 'input'} type="email" value={resetEmail} onChange={(e) => setResetEmail(e.target.value)} placeholder="you@example.com" required />
              </div>
              <button type="submit" disabled={resetLoading} className={`${isEios ? 'btn-eios' : 'btn-primary'} w-full`}>
                {resetLoading ? <><Loader2 className="w-4 h-4 animate-spin" /> Sending...</> : 'Send reset link'}
              </button>
              <button type="button" onClick={() => { setView('auth'); setError(null); }} className="w-full text-sm text-slate-500 hover:text-slate-700 font-medium">
                Back to sign in
              </button>
            </form>
          )}

          {/* --- SENT VIEW --- */}
          {view === 'sent' && (
            <div className="space-y-4">
              <div className="flex flex-col items-center text-center py-4">
                <div className="w-14 h-14 rounded-full bg-success-50 flex items-center justify-center mb-4">
                  <MailCheck className="w-7 h-7 text-success-600" />
                </div>
                <h3 className="text-lg font-semibold text-slate-900 mb-1">Check your email</h3>
                <p className="text-sm text-slate-500 leading-relaxed">
                  We've sent a reset link to <span className="font-medium text-slate-700">{resetEmail}</span>.
                </p>
              </div>
              <button type="button" onClick={() => { setView('auth'); setError(null); setResetEmail(''); }} className={`${isEios ? 'btn-eios' : 'btn-primary'} w-full`}>
                Back to sign in
              </button>
            </div>
          )}

          {view === 'auth' && isLlnd && (
            <div className="mt-6 text-center">
              <button onClick={() => { window.location.href = '#/signup'; }} className="text-sm text-primary-600 hover:text-primary-700 font-medium">
                Don't have an account? Start a free trial
              </button>
            </div>
          )}

          <div className="mt-6 pt-6 border-t border-slate-200">
            <p className="text-xs text-slate-400 text-center leading-relaxed">
              {isEios
                ? 'Access is restricted to authorised EIOS users. By signing in, you agree to the Terms of Service and Privacy Policy.'
                : 'By signing in, you agree to the Terms of Service and Privacy Policy. Access is restricted to authorised RTO staff.'}
            </p>
          </div>
        </div>
      </div>
    </div>
  );
}
