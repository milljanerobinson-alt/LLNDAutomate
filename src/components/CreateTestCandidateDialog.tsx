import { useEffect, useId, useRef, useState } from 'react';
import { FlaskConical, Loader2, X } from 'lucide-react';
import { TestBadge } from './TestBadge';
import { createTestCandidate, isValidTestCandidateEmail, previewNextTestCandidateName, type TestCandidate } from '../lib/planUsage';

interface Props {
  open: boolean;
  onClose: () => void;
  onCreated: (candidate: TestCandidate) => void;
  /** Injectable for tests and previews; defaults to the server calls. */
  preview?: () => Promise<string | null>;
  create?: (email: string) => Promise<{ ok: true; candidate: TestCandidate } | { ok: false; message: string }>;
}

/**
 * Create Test Candidate. The name is generated and allocated by the server
 * ("Test Test", "Test Test2", ...) and cannot be edited here. The preview is the
 * next free name at the time the form opens; if someone else in the RTO creates a
 * Test Candidate first, the server gives the next number and that is shown after creation.
 */
export function CreateTestCandidateDialog({ open, onClose, onCreated, preview = previewNextTestCandidateName, create = createTestCandidate }: Props) {
  const [nextName, setNextName] = useState<string | null>(null);
  const [email, setEmail] = useState('');
  const [touched, setTouched] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const submitting = useRef(false);
  const titleId = useId();
  const emailId = useId();

  useEffect(() => {
    if (!open) return;
    setEmail(''); setTouched(false); setError(null); setBusy(false); submitting.current = false; setNextName(null);
    let live = true;
    void preview().then((n) => { if (live) setNextName(n); });
    return () => { live = false; };
  }, [open, preview]);

  if (!open) return null;
  const valid = isValidTestCandidateEmail(email);
  const showEmailError = touched && !valid;

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setTouched(true);
    if (!valid || submitting.current) return;   // one request per submission, even on double-click
    submitting.current = true;
    setBusy(true);
    setError(null);
    const r = await create(email);
    setBusy(false);
    submitting.current = false;
    if (!r.ok) { setError(r.message); return; }
    onCreated(r.candidate);
  }

  return (
    <div className="fixed inset-0 z-50 flex items-end sm:items-center justify-center bg-slate-900/50 p-0 sm:p-4" role="presentation"
      onKeyDown={(e) => { if (e.key === 'Escape' && !busy) onClose(); }}>
      <form onSubmit={submit} noValidate role="dialog" aria-modal="true" aria-labelledby={titleId}
        className="w-full sm:max-w-lg bg-white rounded-t-2xl sm:rounded-2xl shadow-xl border border-slate-200 p-5 sm:p-6 max-h-[100dvh] overflow-y-auto">
        <div className="flex items-start justify-between gap-3">
          <div className="flex items-center gap-3">
            <div className="w-10 h-10 rounded-xl bg-amber-50 flex items-center justify-center flex-shrink-0">
              <FlaskConical className="w-5 h-5 text-amber-700" aria-hidden="true" />
            </div>
            <h2 id={titleId} className="text-lg font-bold text-slate-900">Create Test Candidate</h2>
          </div>
          <button type="button" onClick={onClose} disabled={busy} className="btn-ghost p-1.5" aria-label="Close"><X className="w-5 h-5" /></button>
        </div>

        <p className="text-sm text-slate-600 mt-3 leading-relaxed">
          Test Candidates let you try the full learner experience. Their assessments are free and don’t count towards your
          monthly allowance, and their results are kept out of your reports, exports and integrations.
        </p>

        <div className="mt-4">
          <p className="label">Candidate name (automatically generated)</p>
          <div className="mt-1 flex items-center rounded-xl border border-slate-200 bg-slate-50 px-3 py-2.5 text-sm text-slate-900" aria-live="polite" data-testid="test-candidate-name">
            {nextName ? <>{nextName}<TestBadge /></> : <span className="text-slate-400">Generating name…</span>}
          </div>
          <p className="text-xs text-slate-500 mt-1">The name is set by LLND Mate and can’t be changed.</p>
        </div>

        <div className="mt-4">
          <label className="label" htmlFor={emailId}>Email address</label>
          <input id={emailId} type="email" inputMode="email" autoComplete="email" required value={email}
            onChange={(e) => { setEmail(e.target.value); setError(null); }} onBlur={() => setTouched(true)}
            aria-invalid={showEmailError} aria-describedby={showEmailError ? `${emailId}-err` : `${emailId}-help`}
            className="input w-full" placeholder="trainer@example.com" disabled={busy} />
          {showEmailError
            ? <p id={`${emailId}-err`} className="text-xs text-error-700 mt-1" role="alert">Enter a valid email address.</p>
            : <p id={`${emailId}-help`} className="text-xs text-slate-500 mt-1">Assessment invitations for this Test Candidate go to this address. You can use the same address for several Test Candidates.</p>}
        </div>

        {error && <p className="text-sm text-error-700 mt-3" role="alert">{error}</p>}

        <div className="mt-5 flex flex-col-reverse sm:flex-row sm:justify-end gap-2">
          <button type="button" onClick={onClose} disabled={busy} className="btn-secondary">Cancel</button>
          <button type="submit" disabled={busy || (touched && !valid)} className="btn-primary justify-center">
            {busy ? <Loader2 className="w-4 h-4 animate-spin" aria-hidden="true" /> : <FlaskConical className="w-4 h-4" aria-hidden="true" />}
            Create Test Candidate
          </button>
        </div>
      </form>
    </div>
  );
}
