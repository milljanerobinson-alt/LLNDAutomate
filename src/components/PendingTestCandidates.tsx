import { Send, Trash2 } from 'lucide-react';
import { TestBadge } from './TestBadge';
import type { TestCandidate } from '../lib/planUsage';

/** Test Candidates that have no assessment yet. Once one is sent they appear as normal candidate rows. */
export function PendingTestCandidates({ candidates, highlightId, onSend, onDelete }: {
  candidates: TestCandidate[];
  highlightId: string | null;
  onSend: (tc: TestCandidate) => void;
  onDelete: (tc: TestCandidate) => void;
}) {
  if (candidates.length === 0) return null;
  return (
    <div className="card divide-y divide-slate-100" aria-label="Test Candidates waiting for an assessment">
      {candidates.map((tc) => (
        <div key={tc.id} data-testid="pending-test-candidate"
          className={`flex flex-col sm:flex-row sm:items-center justify-between gap-3 p-4 ${highlightId === tc.id ? 'bg-amber-50' : ''}`}>
          <div className="min-w-0">
            <div className="font-medium text-slate-900">{tc.candidateName}<TestBadge /></div>
            <div className="text-xs text-slate-500 truncate">{tc.email}</div>
            <div className="text-xs text-slate-500 mt-0.5">No assessment sent yet</div>
          </div>
          <div className="flex gap-2 flex-shrink-0">
            <button type="button" onClick={() => onSend(tc)} className="btn-primary text-sm">
              <Send className="w-4 h-4" /> Send assessment
            </button>
            <button type="button" onClick={() => onDelete(tc)} className="btn-ghost text-xs px-2 py-1 text-rose-600" title="Delete Test Candidate" aria-label={`Delete ${tc.candidateName}`}>
              <Trash2 className="w-3.5 h-3.5" />
            </button>
          </div>
        </div>
      ))}
    </div>
  );
}
