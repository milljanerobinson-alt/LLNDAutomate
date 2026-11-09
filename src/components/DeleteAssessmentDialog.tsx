import { useEffect, useId, useRef, useState } from 'react';
import { Loader2, Trash2 } from 'lucide-react';

export const DELETE_CONFIRMATION_WORD = 'YES';

interface Props {
  /** The assessment being deleted; null closes the dialog. */
  target: { id: string; learnerName: string } | null;
  onCancel: () => void;
  /** Called with the target id and the typed confirmation. The server checks both again. */
  onConfirm: (invitationId: string, confirmation: string) => Promise<string | null>;
}

/**
 * "Delete assessment?" confirmation. Delete stays disabled until the user types
 * exactly YES. The typed value and any error reset whenever a different
 * assessment is opened, so a stale dialog can never confirm another deletion.
 */
export function DeleteAssessmentDialog({ target, onCancel, onConfirm }: Props) {
  const [typed, setTyped] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const titleId = useId();
  const descId = useId();
  const targetId = target?.id ?? null;

  useEffect(() => {
    setTyped('');
    setError(null);
    setBusy(false);
    if (targetId) setTimeout(() => inputRef.current?.focus(), 0);
  }, [targetId]);

  if (!target) return null;
  const confirmed = typed === DELETE_CONFIRMATION_WORD;

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!target || !confirmed || busy) return;
    setBusy(true);
    setError(null);
    const message = await onConfirm(target.id, typed);
    setBusy(false);
    if (message) setError(message);
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/50 p-4" role="presentation"
      onKeyDown={(e) => { if (e.key === 'Escape' && !busy) onCancel(); }}>
      <form onSubmit={submit} role="dialog" aria-modal="true" aria-labelledby={titleId} aria-describedby={descId}
        className="w-full max-w-md rounded-2xl bg-white shadow-xl border border-slate-200 p-6">
        <div className="flex items-start gap-3">
          <div className="w-10 h-10 rounded-xl bg-error-50 flex items-center justify-center flex-shrink-0">
            <Trash2 className="w-5 h-5 text-error-600" aria-hidden="true" />
          </div>
          <div>
            <h2 id={titleId} className="text-lg font-bold text-slate-900">Delete assessment?</h2>
            <p className="text-xs text-slate-500 mt-0.5">{target.learnerName}</p>
          </div>
        </div>
        <div id={descId} className="mt-4 space-y-3 text-sm text-slate-700 leading-relaxed">
          <p>This assessment will disappear from your dashboard. Its results and progress will no longer be accessible to your organisation.</p>
          <p>If you need this assessment restored later, a restoration fee will apply.</p>
          <p>To confirm deletion, type YES below.</p>
        </div>
        <label className="block mt-4">
          <span className="sr-only">Type YES to confirm deletion</span>
          <input ref={inputRef} value={typed} onChange={(e) => setTyped(e.target.value)} autoComplete="off" spellCheck={false}
            aria-label="Type YES to confirm deletion" data-testid="delete-confirmation-input"
            className="w-full rounded-xl border border-slate-300 px-3 py-2.5 text-sm focus:outline-none focus:ring-2 focus:ring-error-500" placeholder="YES" />
        </label>
        {error && <p className="mt-2 text-sm text-error-700" role="alert">{error}</p>}
        <div className="mt-5 flex justify-end gap-2">
          <button type="button" onClick={onCancel} disabled={busy}
            className="px-4 py-2 rounded-xl text-sm font-semibold text-slate-700 border border-slate-300 hover:bg-slate-50 disabled:opacity-50">
            Cancel
          </button>
          <button type="submit" disabled={!confirmed || busy}
            className="inline-flex items-center gap-2 px-4 py-2 rounded-xl text-sm font-semibold text-white bg-error-600 hover:bg-error-700 disabled:opacity-40 disabled:cursor-not-allowed">
            {busy && <Loader2 className="w-4 h-4 animate-spin" aria-hidden="true" />} Delete
          </button>
        </div>
      </form>
    </div>
  );
}
