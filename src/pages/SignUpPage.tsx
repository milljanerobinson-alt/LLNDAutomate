import { useState } from 'react';
import {
  GraduationCap, Check, ChevronRight, ChevronLeft, Eye, EyeOff,
  Loader2, CheckCircle2, AlertCircle, Star, ArrowRight, Building2,
} from 'lucide-react';
import { supabase } from '../lib/supabase';

function nav(hash: string) { window.location.href = hash; }

const PLANS = [
  {
    id: 'lln_only', name: 'LLN Only', price: 79, badge: null,
    desc: 'Language, Literacy & Numeracy',
    features: ['Unlimited trainers & campuses', 'AI-generated reports', 'ACSF mapping', 'Support plans', '50 learner assessments/month'],
  },
  {
    id: 'lln_digital', name: 'LLN + Digital', price: 129, badge: 'Most Popular',
    desc: 'Complete LLN & Digital Capability suite',
    features: ['Everything in LLN Only', 'Digital capability assessments', 'Same learner counts once', '50 learner assessments/month'],
    highlight: true,
  },
  {
    id: 'digital_only', name: 'Digital Only', price: 79, badge: null,
    desc: 'Digital Capability assessments',
    features: ['Unlimited trainers & campuses', 'AI-generated reports', 'Digital skill assessments', '50 learner assessments/month'],
  },
];

const STEPS = ['Choose Plan', 'Your Organisation', 'Create Account', 'Start Trial'];

export function SignUpPage() {
  const [step, setStep] = useState(0);
  const [selectedPlan, setSelectedPlan] = useState('lln_digital');

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

  const plan = PLANS.find((p) => p.id === selectedPlan)!;

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

      // 3. Create trial subscription (best-effort; may fail if profile not ready)
      const trialEnd = new Date(Date.now() + 14 * 86_400_000).toISOString();
      const periodStart = new Date(new Date().getFullYear(), new Date().getMonth(), 1).toISOString();
      const periodEnd = new Date(new Date().getFullYear(), new Date().getMonth() + 1, 1).toISOString();
      await supabase.from('subscriptions').insert({
        plan_id: selectedPlan,
        status: 'trialing',
        trial_ends_at: trialEnd,
        current_period_start: periodStart,
        current_period_end: periodEnd,
      });

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
          <p className="text-slate-500 mb-2">Your 14-day free trial has started.</p>
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
          <button onClick={() => nav('#/')} className="flex items-center gap-2.5">
            <div className="w-8 h-8 bg-primary-600 rounded-lg flex items-center justify-center">
              <GraduationCap className="w-4.5 h-4.5 text-white" />
            </div>
            <span className="font-extrabold text-slate-900 text-sm">LLND Automate</span>
          </button>
          <button onClick={() => nav('#/llnd-automate/login')} className="text-sm text-slate-500 hover:text-slate-700 font-medium">
            Already have an account? <span className="text-primary-600 font-semibold">Sign in</span>
          </button>
        </div>
      </header>

      {/* Progress */}
      <div className="bg-white border-b border-slate-100 px-4 py-4">
        <div className="max-w-5xl mx-auto">
          <div className="flex items-center justify-between max-w-md mx-auto">
            {STEPS.map((s, i) => (
              <div key={s} className="flex items-center gap-2 flex-1 last:flex-none">
                <div className={`w-7 h-7 rounded-full flex items-center justify-center text-xs font-bold flex-shrink-0 transition-all ${
                  i < step ? 'bg-success-500 text-white' : i === step ? 'bg-primary-600 text-white' : 'bg-slate-100 text-slate-400'
                }`}>
                  {i < step ? <Check className="w-3.5 h-3.5" /> : i + 1}
                </div>
                <span className={`text-xs font-medium hidden sm:block ${i === step ? 'text-slate-900' : 'text-slate-400'}`}>{s}</span>
                {i < STEPS.length - 1 && <div className={`flex-1 h-0.5 mx-2 rounded-full ${i < step ? 'bg-success-400' : 'bg-slate-200'}`} />}
              </div>
            ))}
          </div>
        </div>
      </div>

      <main className="max-w-5xl mx-auto px-4 py-10">
        {/* Step 0: Choose Plan */}
        {step === 0 && (
          <div>
            <div className="text-center mb-8">
              <h1 className="text-3xl font-extrabold text-slate-900 mb-2">Choose your plan</h1>
              <p className="text-slate-500">14-day free trial — no credit card required</p>
            </div>
            <div className="grid grid-cols-1 md:grid-cols-3 gap-5 mb-8">
              {PLANS.map((p) => (
                <button
                  key={p.id}
                  onClick={() => setSelectedPlan(p.id)}
                  className={`relative rounded-2xl border-2 p-6 text-left transition-all ${
                    selectedPlan === p.id
                      ? 'border-primary-500 bg-primary-50/50 shadow-lg'
                      : 'border-slate-200 bg-white hover:border-primary-300'
                  }`}
                >
                  {p.badge && (
                    <div className="absolute -top-3 left-1/2 -translate-x-1/2">
                      <span className="bg-primary-600 text-white text-xs font-bold px-3 py-1 rounded-full flex items-center gap-1">
                        <Star className="w-3 h-3" /> {p.badge}
                      </span>
                    </div>
                  )}
                  <div className="flex items-start justify-between mb-4">
                    <div>
                      <h3 className="font-bold text-slate-900">{p.name}</h3>
                      <p className="text-xs text-slate-500 mt-0.5">{p.desc}</p>
                    </div>
                    <div className={`w-5 h-5 rounded-full border-2 flex-shrink-0 flex items-center justify-center transition-all ${
                      selectedPlan === p.id ? 'border-primary-500 bg-primary-500' : 'border-slate-300'
                    }`}>
                      {selectedPlan === p.id && <Check className="w-3 h-3 text-white" />}
                    </div>
                  </div>
                  <div className="flex items-end gap-1 mb-4">
                    <span className="text-3xl font-extrabold text-slate-900">${p.price}</span>
                    <span className="text-slate-400 text-sm mb-1">/month</span>
                  </div>
                  <ul className="space-y-1.5">
                    {p.features.map((f) => (
                      <li key={f} className="flex items-start gap-2 text-xs text-slate-600">
                        <Check className="w-3.5 h-3.5 text-success-500 flex-shrink-0 mt-0.5" />
                        {f}
                      </li>
                    ))}
                  </ul>
                </button>
              ))}
            </div>
            <div className="flex justify-center">
              <button
                onClick={() => setStep(1)}
                className="inline-flex items-center gap-2 px-8 py-3.5 bg-primary-600 text-white font-bold rounded-xl hover:bg-primary-700 transition-all shadow-md"
              >
                Continue with {plan.name} <ChevronRight className="w-5 h-5" />
              </button>
            </div>
          </div>
        )}

        {/* Step 1: Organisation */}
        {step === 1 && (
          <div className="max-w-lg mx-auto">
            <div className="text-center mb-8">
              <div className="w-12 h-12 bg-primary-100 rounded-2xl flex items-center justify-center mx-auto mb-4">
                <Building2 className="w-6 h-6 text-primary-600" />
              </div>
              <h1 className="text-3xl font-extrabold text-slate-900 mb-2">Your organisation</h1>
              <p className="text-slate-500 text-sm">Tell us about your RTO</p>
            </div>
            <div className="bg-white rounded-2xl border border-slate-200 shadow-sm p-8 space-y-5">
              <div>
                <label className="block text-sm font-semibold text-slate-700 mb-2">Organisation Name <span className="text-rose-500">*</span></label>
                <input
                  type="text" value={orgName} onChange={(e) => setOrgName(e.target.value)}
                  placeholder="e.g. Gold Coast Training Institute"
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
                <button
                  onClick={() => setStep(0)}
                  className="flex items-center gap-1.5 px-4 py-3 border border-slate-200 text-slate-600 text-sm font-semibold rounded-xl hover:bg-slate-50"
                >
                  <ChevronLeft className="w-4 h-4" /> Back
                </button>
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
              <h1 className="text-3xl font-extrabold text-slate-900 mb-2">Ready to go!</h1>
              <p className="text-slate-500 text-sm">Review your details and start your free trial</p>
            </div>

            <div className="bg-white rounded-2xl border border-slate-200 shadow-sm p-8 space-y-6">
              {/* Summary */}
              <div className="space-y-3">
                {[
                  { label: 'Plan', value: `${plan.name} — $${plan.price}/month` },
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

              {/* Trial notice */}
              <div className="bg-primary-50 border border-primary-100 rounded-xl px-4 py-3 flex items-start gap-3">
                <CheckCircle2 className="w-5 h-5 text-primary-500 flex-shrink-0 mt-0.5" />
                <p className="text-sm text-primary-800">
                  <strong>14-day free trial</strong> — no credit card required. You'll be reminded before your trial ends.
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
                    <>Start Free Trial <ArrowRight className="w-5 h-5" /></>
                  )}
                </button>
              </div>

              <p className="text-xs text-slate-400 text-center">
                By creating an account you agree to our{' '}
                <button onClick={() => nav('#/terms')} className="text-primary-600 hover:underline">Terms of Service</button>{' '}
                and{' '}
                <button onClick={() => nav('#/privacy')} className="text-primary-600 hover:underline">Privacy Policy</button>.
              </p>
            </div>
          </div>
        )}
      </main>
    </div>
  );
}
