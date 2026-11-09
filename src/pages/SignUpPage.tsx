import { useState } from 'react';
import {
  Check, ChevronRight, ChevronLeft, Eye, EyeOff,
  Loader2, CheckCircle2, AlertCircle, ArrowRight, Building2,
} from 'lucide-react';
import { supabase } from '../lib/supabase';
import { BrandMark } from '../components/marketing/BrandMark';
import { FREE_MONTHLY_COMPLETIONS, PRODUCT_NAME, STAFF_LOGIN_HASH, TIER_FREE } from '../lib/brand';

function nav(hash: string) { window.location.href = hash; }

// Registration for LLND Mate (the free plan). Paid plans are not yet available, so there is
// no plan choice and no paid trial is created here (see the rebrand release notes).
const STEPS = ['Your organisation', 'Create account', 'Confirm'];

export function SignUpPage() {
  // Steps are numbered 1-3 to match the on-screen progress indicator.
  const [step, setStep] = useState(1);

  // Step 2
  const [orgName, setOrgName] = useState('');
  const [rtoNumber, setRtoNumber] = useState('');
  const [state, setState] = useState('');

  // Step 3
  const [fullName, setFullName] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [showPass, setShowPass] = useState(false);

  // Submission
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState(false);

  async function handleSubmit() {
    setError(null);
    setSubmitting(true);
    try {
      // 1. Create auth user
      const { data, error: signUpError } = await supabase.auth.signUp({
        email,
        password,
        options: { data: { full_name: fullName } },
      });
      if (signUpError) throw signUpError;
      if (!data.user) throw new Error('Failed to create account');

      // 2. Wait briefly for the new-RTO trigger, then save this RTO's own
      // details (organisation-scoped; never the platform-wide settings table).
      await new Promise((r) => setTimeout(r, 800));
      const { data: organisation } = await supabase.from('organisations').select('id').maybeSingle();
      if (organisation?.id && orgName.trim()) {
        await supabase.from('organisations').update({ name: orgName.trim() }).eq('id', organisation.id);
      }
      await supabase.rpc('set_organisation_setting', { p_key: 'org_rto_number', p_value: rtoNumber });
      await supabase.rpc('set_organisation_setting', { p_key: 'org_state', p_value: state });

      setDone(true);
      setTimeout(() => { nav('#/assessment/dashboard'); }, 2000);
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'Something went wrong. Please try again.');
    } finally {
      setSubmitting(false);
    }
  }

  if (done) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-gradient-to-br from-primary-50 to-white px-4">
        <div className="text-center max-w-md">
          <div className="w-20 h-20 bg-success-100 rounded-full flex items-center justify-center mx-auto mb-6">
            <CheckCircle2 className="w-10 h-10 text-success-600" />
          </div>
          <h2 className="text-3xl font-extrabold text-slate-900 mb-3">You're all set!</h2>
          <p className="text-slate-500 mb-2">Your free {PRODUCT_NAME} account is ready. The {TIER_FREE} free plan includes {FREE_MONTHLY_COMPLETIONS} completed assessment assignments each month.</p>
          <p className="text-slate-400 text-sm">Redirecting you to your dashboard...</p>
          <Loader2 className="w-6 h-6 animate-spin text-primary-400 mx-auto mt-4" />
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-gradient-to-br from-slate-50 to-white">
      {/* Header */}
      <header className="bg-white border-b border-slate-100 px-4 py-4">
        <div className="max-w-5xl mx-auto flex items-center justify-between">
          <a href="#/" aria-label={`${PRODUCT_NAME} home`}>
            <BrandMark size="sm" />
          </a>
          <a href={STAFF_LOGIN_HASH} className="text-sm text-slate-500 hover:text-slate-700 font-medium">
            Already have an account? <span className="text-primary-600 font-semibold">Sign in</span>
          </a>
        </div>
      </header>

      {/* Progress */}
      <div className="bg-white border-b border-slate-100 px-4 py-4">
        <div className="max-w-5xl mx-auto">
          <div className="flex items-center justify-between max-w-md mx-auto">
            {STEPS.map((s, i) => (
              <div key={s} className="flex items-center gap-2 flex-1 last:flex-none">
                <div className={`w-7 h-7 rounded-full flex items-center justify-center text-xs font-bold flex-shrink-0 transition-all ${
                  i < step - 1 ? 'bg-success-500 text-white' : i === step - 1 ? 'bg-primary-600 text-white' : 'bg-slate-100 text-slate-400'
                }`} aria-current={i === step - 1 ? 'step' : undefined}>
                  {i < step - 1 ? <Check className="w-3.5 h-3.5" aria-hidden="true" /> : i + 1}
                </div>
                <span className={`text-xs font-medium hidden sm:block ${i === step - 1 ? 'text-slate-900' : 'text-slate-500'}`}>{s}</span>
                {i < STEPS.length - 1 && <div className={`flex-1 h-0.5 mx-2 rounded-full ${i < step - 1 ? 'bg-success-400' : 'bg-slate-200'}`} />}
              </div>
            ))}
          </div>
        </div>
      </div>

      <main className="max-w-5xl mx-auto px-4 py-10">
        {/* Step 1: Organisation */}
        {step === 1 && (
          <div className="max-w-lg mx-auto">
            <div className="text-center mb-8">
              <div className="w-12 h-12 bg-primary-100 rounded-2xl flex items-center justify-center mx-auto mb-4">
                <Building2 className="w-6 h-6 text-primary-600" />
              </div>
              <h1 className="text-3xl font-extrabold text-slate-900 mb-2">Create your free account</h1>
              <p className="text-slate-500 text-sm">Tell us about your RTO. The {TIER_FREE} free plan includes {FREE_MONTHLY_COMPLETIONS} completed assessment assignments each month.</p>
            </div>
            <div className="bg-white rounded-2xl border border-slate-200 shadow-sm p-8 space-y-5">
              <div>
                <label className="block text-sm font-semibold text-slate-700 mb-2">Organisation Name <span className="text-rose-500">*</span></label>
                <input
                  type="text" value={orgName} onChange={(e) => setOrgName(e.target.value)}
                  placeholder="Your RTO's name"
                  className="w-full border border-slate-200 rounded-xl px-4 py-3 text-sm text-slate-900 focus:outline-none focus:ring-2 focus:ring-primary-300 placeholder-slate-400"
                />
              </div>
              <div>
                <label className="block text-sm font-semibold text-slate-700 mb-2">RTO Number <span className="text-rose-500">*</span></label>
                <input
                  type="text" value={rtoNumber} onChange={(e) => setRtoNumber(e.target.value)}
                  placeholder="e.g. 45678"
                  className="w-full border border-slate-200 rounded-xl px-4 py-3 text-sm text-slate-900 focus:outline-none focus:ring-2 focus:ring-primary-300 placeholder-slate-400"
                />
              </div>
              <div>
                <label className="block text-sm font-semibold text-slate-700 mb-2">State / Territory</label>
                <select
                  value={state} onChange={(e) => setState(e.target.value)}
                  className="w-full border border-slate-200 rounded-xl px-4 py-3 text-sm text-slate-900 focus:outline-none focus:ring-2 focus:ring-primary-300 bg-white"
                >
                  <option value="">Select state...</option>
                  {['QLD', 'NSW', 'VIC', 'SA', 'WA', 'TAS', 'ACT', 'NT'].map((s) => (
                    <option key={s} value={s}>{s}</option>
                  ))}
                </select>
              </div>
              <div className="flex gap-3 pt-2">
                <a
                  href="#/"
                  className="flex items-center gap-1.5 px-4 py-3 border border-slate-200 text-slate-600 text-sm font-semibold rounded-xl hover:bg-slate-50"
                >
                  <ChevronLeft className="w-4 h-4" aria-hidden="true" /> Back
                </a>
                <button
                  onClick={() => setStep(2)}
                  disabled={!orgName || !rtoNumber}
                  className="flex-1 flex items-center justify-center gap-2 py-3 bg-primary-600 text-white font-bold rounded-xl hover:bg-primary-700 transition-all disabled:opacity-50 disabled:cursor-not-allowed"
                >
                  Continue <ChevronRight className="w-5 h-5" />
                </button>
              </div>
            </div>
          </div>
        )}

        {/* Step 2: Account */}
        {step === 2 && (
          <div className="max-w-lg mx-auto">
            <div className="text-center mb-8">
              <h1 className="text-3xl font-extrabold text-slate-900 mb-2">Create your account</h1>
              <p className="text-slate-500 text-sm">You'll be the admin for {orgName}</p>
            </div>
            <div className="bg-white rounded-2xl border border-slate-200 shadow-sm p-8 space-y-5">
              <div>
                <label className="block text-sm font-semibold text-slate-700 mb-2">Full Name <span className="text-rose-500">*</span></label>
                <input
                  type="text" value={fullName} onChange={(e) => setFullName(e.target.value)}
                  placeholder="Jane Smith"
                  className="w-full border border-slate-200 rounded-xl px-4 py-3 text-sm text-slate-900 focus:outline-none focus:ring-2 focus:ring-primary-300 placeholder-slate-400"
                />
              </div>
              <div>
                <label className="block text-sm font-semibold text-slate-700 mb-2">Work Email <span className="text-rose-500">*</span></label>
                <input
                  type="email" value={email} onChange={(e) => setEmail(e.target.value)}
                  placeholder="jane@yourrto.edu.au"
                  className="w-full border border-slate-200 rounded-xl px-4 py-3 text-sm text-slate-900 focus:outline-none focus:ring-2 focus:ring-primary-300 placeholder-slate-400"
                />
              </div>
              <div>
                <label className="block text-sm font-semibold text-slate-700 mb-2">Password <span className="text-rose-500">*</span></label>
                <div className="relative">
                  <input
                    type={showPass ? 'text' : 'password'} value={password}
                    onChange={(e) => setPassword(e.target.value)}
                    placeholder="Minimum 8 characters"
                    minLength={8}
                    className="w-full border border-slate-200 rounded-xl px-4 py-3 text-sm text-slate-900 focus:outline-none focus:ring-2 focus:ring-primary-300 placeholder-slate-400 pr-12"
                  />
                  <button
                    type="button" onClick={() => setShowPass(!showPass)}
                    className="absolute right-3 top-1/2 -translate-y-1/2 text-slate-400 hover:text-slate-600"
                  >
                    {showPass ? <EyeOff className="w-5 h-5" /> : <Eye className="w-5 h-5" />}
                  </button>
                </div>
              </div>
              <div className="flex gap-3 pt-2">
                <button
                  onClick={() => setStep(1)}
                  className="flex items-center gap-1.5 px-4 py-3 border border-slate-200 text-slate-600 text-sm font-semibold rounded-xl hover:bg-slate-50"
                >
                  <ChevronLeft className="w-4 h-4" /> Back
                </button>
                <button
                  onClick={() => setStep(3)}
                  disabled={!fullName || !email || password.length < 8}
                  className="flex-1 flex items-center justify-center gap-2 py-3 bg-primary-600 text-white font-bold rounded-xl hover:bg-primary-700 transition-all disabled:opacity-50 disabled:cursor-not-allowed"
                >
                  Review <ChevronRight className="w-5 h-5" />
                </button>
              </div>
            </div>
          </div>
        )}

        {/* Step 3: Confirm & start */}
        {step === 3 && (
          <div className="max-w-lg mx-auto">
            <div className="text-center mb-8">
              <h1 className="text-3xl font-extrabold text-slate-900 mb-2">Check your details</h1>
              <p className="text-slate-500 text-sm">Review your details and create your free account</p>
            </div>

            <div className="bg-white rounded-2xl border border-slate-200 shadow-sm p-8 space-y-6">
              {/* Summary */}
              <div className="space-y-3">
                {[
                  { label: 'Plan', value: `${TIER_FREE} (free)` },
                  { label: 'Organisation', value: orgName },
                  { label: 'RTO Number', value: rtoNumber },
                  { label: 'Admin Account', value: email },
                ].map(({ label, value }) => (
                  <div key={label} className="flex justify-between items-center py-2 border-b border-slate-50 last:border-0">
                    <span className="text-sm text-slate-500 font-medium">{label}</span>
                    <span className="text-sm font-semibold text-slate-900">{value}</span>
                  </div>
                ))}
              </div>

              {/* Free plan notice */}
              <div className="bg-primary-50 border border-primary-100 rounded-xl px-4 py-3 flex items-start gap-3">
                <CheckCircle2 className="w-5 h-5 text-primary-500 flex-shrink-0 mt-0.5" />
                <p className="text-sm text-primary-800">
                  <strong>{TIER_FREE} free plan</strong>: {FREE_MONTHLY_COMPLETIONS} completed assessment assignments each month. No credit card needed.
                </p>
              </div>

              {error && (
                <div className="bg-rose-50 border border-rose-200 rounded-xl px-4 py-3 flex items-start gap-3">
                  <AlertCircle className="w-5 h-5 text-rose-500 flex-shrink-0 mt-0.5" />
                  <p className="text-sm text-rose-800">{error}</p>
                </div>
              )}

              <div className="flex gap-3">
                <button
                  onClick={() => setStep(2)}
                  disabled={submitting}
                  className="flex items-center gap-1.5 px-4 py-3 border border-slate-200 text-slate-600 text-sm font-semibold rounded-xl hover:bg-slate-50 disabled:opacity-50"
                >
                  <ChevronLeft className="w-4 h-4" /> Back
                </button>
                <button
                  onClick={handleSubmit}
                  disabled={submitting}
                  className="flex-1 flex items-center justify-center gap-2 py-3.5 bg-primary-600 text-white font-bold rounded-xl hover:bg-primary-700 transition-all disabled:opacity-50 shadow-md"
                >
                  {submitting ? (
                    <><Loader2 className="w-5 h-5 animate-spin" /> Creating your account...</>
                  ) : (
                    <>Create free account <ArrowRight className="w-5 h-5" aria-hidden="true" /></>
                  )}
                </button>
              </div>

            </div>
          </div>
        )}
      </main>
    </div>
  );
}
