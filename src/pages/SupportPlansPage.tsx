import { useEffect, useState, useMemo, useCallback } from 'react';
import {
  FileText, Sparkles, User, CheckCircle2, Clock, X, Plus, Trash2,
  Save, Loader2, Mail, AlertCircle, Pencil, BookOpen, Calculator,
  FolderOpen, Share2, Accessibility, ListChecks, MessageSquare,
} from 'lucide-react';
import { supabase } from '../lib/supabase';
import type {
  SupportPlan, SupportPlanContent, AssessmentInvitation,
} from '../lib/types';
import { useAuth } from '../lib/auth';
import { enqueueAxcelerateWriteback } from '../lib/audit';

interface PlanWithInvitation extends SupportPlan {
  invitation: Pick<AssessmentInvitation, 'id' | 'candidate_name' | 'candidate_email'> | null;
}

const EMPTY_CONTENT: SupportPlanContent = {
  domain_findings: [],
  reading_support: [],
  numeracy_support: [],
  extra_resources: [],
  referral_recommendations: [],
  reasonable_adjustments: [],
  trainer_action_items: [],
};

const STRING_ARRAY_FIELDS: { key: keyof SupportPlanContent; label: string; icon: typeof BookOpen }[] = [
  { key: 'reading_support', label: 'Reading Support', icon: BookOpen },
  { key: 'numeracy_support', label: 'Numeracy Support', icon: Calculator },
  { key: 'extra_resources', label: 'Extra Resources', icon: FolderOpen },
  { key: 'referral_recommendations', label: 'Referral Recommendations', icon: Share2 },
  { key: 'reasonable_adjustments', label: 'Reasonable Adjustments', icon: Accessibility },
  { key: 'trainer_action_items', label: 'Trainer Action Items', icon: ListChecks },
];

function formatDate(dateStr: string | null): string {
  if (!dateStr) return '—';
  return new Date(dateStr).toLocaleDateString('en-AU', {
    day: 'numeric',
    month: 'short',
    year: 'numeric',
  });
}

function formatDateTime(dateStr: string | null): string {
  if (!dateStr) return '—';
  return new Date(dateStr).toLocaleString('en-AU', {
    day: 'numeric',
    month: 'short',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}

function cloneContent(content: SupportPlanContent): SupportPlanContent {
  return {
    domain_findings: content.domain_findings.map((d) => ({ ...d })),
    reading_support: [...content.reading_support],
    numeracy_support: [...content.numeracy_support],
    extra_resources: [...content.extra_resources],
    referral_recommendations: [...content.referral_recommendations],
    reasonable_adjustments: [...content.reasonable_adjustments],
    trainer_action_items: [...content.trainer_action_items],
  };
}

export function SupportPlansPage() {
  const { user } = useAuth();
  const [plans, setPlans] = useState<PlanWithInvitation[]>([]);
  const [completedInvitations, setCompletedInvitations] = useState<AssessmentInvitation[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [searchQuery, setSearchQuery] = useState('');
  const [statusFilter, setStatusFilter] = useState<'all' | 'draft' | 'approved'>('all');
  const [editingPlan, setEditingPlan] = useState<PlanWithInvitation | null>(null);
  const [editContent, setEditContent] = useState<SupportPlanContent>(EMPTY_CONTENT);
  const [editComments, setEditComments] = useState('');
  const [saving, setSaving] = useState(false);
  const [approving, setApproving] = useState(false);
  const [generatingInvitationId, setGeneratingInvitationId] = useState<string | null>(null);
  const [showGeneratePanel, setShowGeneratePanel] = useState(false);

  const loadData = useCallback(async () => {
    setLoading(true);
    setError(null);

    const [plansRes, completedRes] = await Promise.all([
      supabase
        .from('support_plans')
        .select('*, invitation:assessment_invitations(id, candidate_name, candidate_email)')
        .order('created_at', { ascending: false }),
      supabase
        .from('assessment_invitations')
        .select('*')
        .eq('status', 'completed')
        .order('completed_at', { ascending: false }),
    ]);

    if (plansRes.error) {
      setError(plansRes.error.message);
    } else {
      setPlans((plansRes.data || []) as PlanWithInvitation[]);
    }

    if (completedRes.error) {
      setError((prev) => prev || completedRes.error.message);
    } else {
      setCompletedInvitations((completedRes.data || []) as AssessmentInvitation[]);
    }

    setLoading(false);
  }, []);

  useEffect(() => {
    loadData();
  }, [loadData]);

  const planInvitationIds = useMemo(
    () => new Set(plans.map((p) => p.invitation_id)),
    [plans],
  );

  const eligibleInvitations = useMemo(
    () => completedInvitations.filter((inv) => !planInvitationIds.has(inv.id)),
    [completedInvitations, planInvitationIds],
  );

  const filteredPlans = useMemo(() => {
    return plans.filter((plan) => {
      if (statusFilter !== 'all' && plan.status !== statusFilter) return false;
      if (searchQuery) {
        const q = searchQuery.toLowerCase();
        const name = plan.invitation?.candidate_name?.toLowerCase() ?? '';
        const email = plan.invitation?.candidate_email?.toLowerCase() ?? '';
        if (!name.includes(q) && !email.includes(q)) return false;
      }
      return true;
    });
  }, [plans, statusFilter, searchQuery]);

  const statusCounts = useMemo(() => {
    const counts: Record<string, number> = {
      all: plans.length,
      draft: 0,
      approved: 0,
    };
    for (const plan of plans) {
      counts[plan.status] = (counts[plan.status] || 0) + 1;
    }
    return counts;
  }, [plans]);

  function openEditor(plan: PlanWithInvitation) {
    setEditingPlan(plan);
    setEditContent(cloneContent(plan.content || EMPTY_CONTENT));
    setEditComments(plan.trainer_comments ?? '');
  }

  function closeEditor() {
    setEditingPlan(null);
    setEditContent(EMPTY_CONTENT);
    setEditComments('');
  }

  function updateStringArrayField(key: keyof SupportPlanContent, index: number, value: string) {
    setEditContent((prev) => {
      const next = cloneContent(prev);
      (next[key] as string[])[index] = value;
      return next;
    });
  }

  function addStringArrayItem(key: keyof SupportPlanContent) {
    setEditContent((prev) => {
      const next = cloneContent(prev);
      (next[key] as string[]).push('');
      return next;
    });
  }

  function removeStringArrayItem(key: keyof SupportPlanContent, index: number) {
    setEditContent((prev) => {
      const next = cloneContent(prev);
      (next[key] as string[]).splice(index, 1);
      return next;
    });
  }

  function updateDomainFinding(index: number, field: 'domain' | 'acsf_level' | 'finding', value: string | number) {
    setEditContent((prev) => {
      const next = cloneContent(prev);
      next.domain_findings[index] = {
        ...next.domain_findings[index],
        [field]: field === 'acsf_level' ? Number(value) : value,
      };
      return next;
    });
  }

  function addDomainFinding() {
    setEditContent((prev) => {
      const next = cloneContent(prev);
      next.domain_findings.push({ domain: '', acsf_level: 1, finding: '' });
      return next;
    });
  }

  function removeDomainFinding(index: number) {
    setEditContent((prev) => {
      const next = cloneContent(prev);
      next.domain_findings.splice(index, 1);
      return next;
    });
  }

  async function handleSave(approve: boolean = false) {
    if (!editingPlan) return;
    if (approve) {
      setApproving(true);
    } else {
      setSaving(true);
    }
    setError(null);

    try {
      const update: Record<string, any> = {
        content: editContent,
        trainer_comments: editComments || null,
        updated_at: new Date().toISOString(),
      };

      if (approve) {
        update.status = 'approved';
        update.approved_at = new Date().toISOString();
        update.trainer_id = user?.id ?? null;
      }

      const { error: updateError } = await supabase
        .from('support_plans')
        .update(update)
        .eq('id', editingPlan.id);

      if (updateError) throw updateError;

      if (approve && editingPlan.invitation_id) {
        enqueueAxcelerateWriteback(editingPlan.invitation_id, 'support_plan_generated');
      }

      await loadData();
      closeEditor();
    } catch (err: any) {
      setError(err.message || 'Failed to save support plan.');
    } finally {
      setSaving(false);
      setApproving(false);
    }
  }

  async function handleGenerateDraft(invitation: AssessmentInvitation) {
    setGeneratingInvitationId(invitation.id);
    setError(null);

    try {
      const apiUrl = `${import.meta.env.VITE_SUPABASE_URL}/functions/v1/generate-support-plan`;
      const { data: { session } } = await supabase.auth.getSession();
      const headers = {
        Authorization: `Bearer ${session?.access_token || ''}`,
        'Content-Type': 'application/json',
      };
      const response = await fetch(apiUrl, {
        method: 'POST',
        headers,
        body: JSON.stringify({ invitation_id: invitation.id }),
      });

      if (!response.ok) {
        const text = await response.text();
        let message = `Edge function returned ${response.status}`;
        try {
          const json = JSON.parse(text);
          if (json.error) message = json.error;
        } catch {
          if (text) message = text;
        }
        throw new Error(message);
      }

      await loadData();
    } catch (err: any) {
      setError(err.message || 'Failed to generate AI support plan draft.');
    } finally {
      setGeneratingInvitationId(null);
    }
  }

  const statusFilterOptions: { value: 'all' | 'draft' | 'approved'; label: string }[] = [
    { value: 'all', label: 'All' },
    { value: 'draft', label: 'Draft' },
    { value: 'approved', label: 'Approved' },
  ];

  return (
    <div className="space-y-6">
      <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4">
        <div>
          <h1 className="text-2xl font-bold text-slate-900">Support Plans</h1>
          <p className="text-sm text-slate-500 mt-1">
            Review, edit and approve learner support plans generated from LLND Mate assessment outcomes.
          </p>
        </div>
        {eligibleInvitations.length > 0 && (
          <button
            onClick={() => setShowGeneratePanel((v) => !v)}
            className="btn-primary"
          >
            <Sparkles className="w-4 h-4" />
            Generate AI Draft
            {eligibleInvitations.length > 0 && (
              <span className="ml-1 inline-flex items-center justify-center min-w-[20px] h-5 px-1.5 rounded-full bg-white/25 text-xs font-semibold">
                {eligibleInvitations.length}
              </span>
            )}
          </button>
        )}
      </div>

      {error && (
        <div className="card p-4 border-error-200 bg-error-50">
          <div className="flex items-start gap-2">
            <AlertCircle className="w-4 h-4 text-error-600 mt-0.5 shrink-0" />
            <p className="text-sm text-error-700 flex-1">{error}</p>
            <button
              onClick={() => setError(null)}
              className="text-error-600 hover:text-error-800 text-xs font-medium"
            >
              Dismiss
            </button>
          </div>
        </div>
      )}

      {showGeneratePanel && eligibleInvitations.length > 0 && (
        <div className="card p-5">
          <div className="flex items-center gap-2 mb-1">
            <Sparkles className="w-4 h-4 text-primary-600" />
            <h2 className="text-base font-semibold text-slate-900">Generate AI Support Plan Draft</h2>
          </div>
          <p className="text-sm text-slate-500 mb-4">
            Completed assessments without an existing plan are eligible. Select a candidate to generate a draft.
          </p>
          <div className="space-y-2">
            {eligibleInvitations.map((inv) => (
              <div
                key={inv.id}
                className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3 p-3 rounded-lg border border-slate-200 bg-slate-50/50"
              >
                <div className="min-w-0">
                  <div className="font-medium text-slate-900 truncate">{inv.candidate_name}</div>
                  <div className="text-xs text-slate-500 flex items-center gap-1.5 mt-0.5">
                    <Mail className="w-3 h-3" />
                    <span className="truncate">{inv.candidate_email}</span>
                    <span className="text-slate-300">·</span>
                    <span>Completed {formatDate(inv.completed_at)}</span>
                  </div>
                </div>
                <button
                  onClick={() => handleGenerateDraft(inv)}
                  disabled={generatingInvitationId === inv.id}
                  className="btn-primary text-xs shrink-0"
                >
                  {generatingInvitationId === inv.id ? (
                    <>
                      <Loader2 className="w-3.5 h-3.5 animate-spin" />
                      Generating...
                    </>
                  ) : (
                    <>
                      <Sparkles className="w-3.5 h-3.5" />
                      Generate Draft
                    </>
                  )}
                </button>
              </div>
            ))}
          </div>
        </div>
      )}

      <div className="card p-4">
        <div className="flex flex-col sm:flex-row gap-3">
          <div className="relative flex-1">
            <input
              type="text"
              placeholder="Search by candidate name or email..."
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              className="input"
            />
          </div>
          <div className="relative">
            <select
              value={statusFilter}
              onChange={(e) => setStatusFilter(e.target.value as 'all' | 'draft' | 'approved')}
              className="input pr-8 appearance-none cursor-pointer min-w-[160px]"
            >
              {statusFilterOptions.map((opt) => (
                <option key={opt.value} value={opt.value}>
                  {opt.label} ({statusCounts[opt.value] || 0})
                </option>
              ))}
            </select>
          </div>
        </div>
      </div>

      {loading ? (
        <div className="flex items-center justify-center py-20 text-slate-400">
          <Loader2 className="w-6 h-6 animate-spin mr-2" />
          Loading support plans...
        </div>
      ) : filteredPlans.length === 0 ? (
        <div className="card p-12 text-center">
          <FileText className="w-12 h-12 text-slate-300 mx-auto mb-4" />
          <h3 className="text-base font-semibold text-slate-900 mb-1">
            {plans.length === 0 ? 'No support plans yet' : 'No matching plans'}
          </h3>
          <p className="text-sm text-slate-500 mb-4">
            {plans.length === 0
              ? 'Generate an AI draft from a completed assessment to get started.'
              : 'Try adjusting your search or filter criteria.'}
          </p>
          {plans.length === 0 && eligibleInvitations.length > 0 && (
            <button onClick={() => setShowGeneratePanel(true)} className="btn-primary">
              <Sparkles className="w-4 h-4" />
              Generate AI Draft
            </button>
          )}
        </div>
      ) : (
        <>
          <div className="card overflow-hidden hidden md:block">
            <div className="overflow-x-auto">
              <table className="w-full">
                <thead className="bg-slate-50 border-b border-slate-200">
                  <tr>
                    <th className="table-header">Candidate</th>
                    <th className="table-header">Source</th>
                    <th className="table-header">Status</th>
                    <th className="table-header">Created</th>
                    <th className="table-header">Approved</th>
                    <th className="table-header text-right">Actions</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-200">
                  {filteredPlans.map((plan) => (
                    <PlanRow key={plan.id} plan={plan} onEdit={() => openEditor(plan)} />
                  ))}
                </tbody>
              </table>
            </div>
          </div>

          <div className="md:hidden space-y-3">
            {filteredPlans.map((plan) => (
              <PlanCard key={plan.id} plan={plan} onEdit={() => openEditor(plan)} />
            ))}
          </div>
        </>
      )}

      {editingPlan && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-slate-900/50 backdrop-blur-sm">
          <div className="card w-full max-w-3xl max-h-[90vh] overflow-y-auto scrollbar-thin">
            <div className="flex items-center justify-between p-5 border-b border-slate-200 sticky top-0 bg-white rounded-t-xl z-10">
              <div className="min-w-0">
                <h2 className="text-lg font-bold text-slate-900 truncate">
                  {editingPlan.invitation?.candidate_name ?? 'Unknown candidate'}
                </h2>
                <p className="text-sm text-slate-500 mt-0.5 flex items-center gap-1.5">
                  <Mail className="w-3.5 h-3.5" />
                  <span className="truncate">{editingPlan.invitation?.candidate_email ?? '—'}</span>
                </p>
              </div>
              <button
                onClick={closeEditor}
                className="btn-ghost p-1.5 shrink-0"
                disabled={saving || approving}
              >
                <X className="w-5 h-5" />
              </button>
            </div>

            <div className="p-5 space-y-6">
              <div className="flex flex-wrap items-center gap-2">
                {editingPlan.status === 'approved' ? (
                  <span className="badge bg-emerald-100 text-emerald-700">
                    <CheckCircle2 className="w-3 h-3" />
                    Approved
                  </span>
                ) : (
                  <span className="badge bg-amber-100 text-amber-700">
                    <Clock className="w-3 h-3" />
                    Draft
                  </span>
                )}
                <span className="badge bg-slate-100 text-slate-600">
                  {editingPlan.generated_by === 'ai' ? (
                    <>
                      <Sparkles className="w-3 h-3" />
                      AI-generated
                    </>
                  ) : (
                    <>
                      <User className="w-3 h-3" />
                      Trainer-created
                    </>
                  )}
                </span>
                <span className="text-xs text-slate-400">
                  Created {formatDateTime(editingPlan.created_at)}
                </span>
              </div>

              <div>
                <div className="flex items-center justify-between mb-3">
                  <div className="flex items-center gap-2">
                    <FileText className="w-4 h-4 text-slate-500" />
                    <h3 className="text-sm font-semibold text-slate-900">Domain Findings</h3>
                  </div>
                  <button
                    type="button"
                    onClick={addDomainFinding}
                    className="btn-ghost text-xs px-2 py-1"
                  >
                    <Plus className="w-3.5 h-3.5" />
                    Add Finding
                  </button>
                </div>
                {editContent.domain_findings.length === 0 ? (
                  <p className="text-sm text-slate-400 italic px-3 py-2 border border-dashed border-slate-200 rounded-lg">
                    No domain findings recorded.
                  </p>
                ) : (
                  <div className="space-y-3">
                    {editContent.domain_findings.map((finding, index) => (
                      <div
                        key={index}
                        className="grid grid-cols-1 sm:grid-cols-12 gap-2 p-3 rounded-lg border border-slate-200 bg-slate-50/50"
                      >
                        <div className="sm:col-span-4">
                          <label className="label text-xs">Domain</label>
                          <input
                            type="text"
                            value={finding.domain}
                            onChange={(e) => updateDomainFinding(index, 'domain', e.target.value)}
                            className="input"
                            placeholder="e.g. Numeracy"
                          />
                        </div>
                        <div className="sm:col-span-2">
                          <label className="label text-xs">ACSF Level</label>
                          <input
                            type="number"
                            min={1}
                            max={5}
                            step={0.5}
                            value={finding.acsf_level}
                            onChange={(e) => updateDomainFinding(index, 'acsf_level', e.target.value)}
                            className="input"
                          />
                        </div>
                        <div className="sm:col-span-5">
                          <label className="label text-xs">Finding</label>
                          <input
                            type="text"
                            value={finding.finding}
                            onChange={(e) => updateDomainFinding(index, 'finding', e.target.value)}
                            className="input"
                            placeholder="Summary of the finding..."
                          />
                        </div>
                        <div className="sm:col-span-1 flex sm:items-end sm:justify-end">
                          <button
                            type="button"
                            onClick={() => removeDomainFinding(index)}
                            className="btn-ghost p-2 text-rose-500 hover:text-rose-700 hover:bg-rose-50"
                            title="Remove finding"
                          >
                            <Trash2 className="w-4 h-4" />
                          </button>
                        </div>
                      </div>
                    ))}
                  </div>
                )}
              </div>

              {STRING_ARRAY_FIELDS.map(({ key, label, icon: Icon }) => (
                <StringArrayEditor
                  key={key}
                  label={label}
                  icon={Icon}
                  items={editContent[key] as string[]}
                  onChange={(index, value) => updateStringArrayField(key, index, value)}
                  onAdd={() => addStringArrayItem(key)}
                  onRemove={(index) => removeStringArrayItem(key, index)}
                />
              ))}

              <div>
                <div className="flex items-center gap-2 mb-3">
                  <MessageSquare className="w-4 h-4 text-slate-500" />
                  <h3 className="text-sm font-semibold text-slate-900">Trainer Comments</h3>
                </div>
                <textarea
                  value={editComments}
                  onChange={(e) => setEditComments(e.target.value)}
                  className="input min-h-[100px] resize-y"
                  placeholder="Add any overall comments about this support plan..."
                  rows={4}
                />
              </div>
            </div>

            <div className="flex flex-col sm:flex-row items-center justify-end gap-3 p-5 border-t border-slate-200 sticky bottom-0 bg-white rounded-b-xl">
              <button
                type="button"
                onClick={closeEditor}
                className="btn-secondary w-full sm:w-auto"
                disabled={saving || approving}
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={() => handleSave(false)}
                className="btn-secondary w-full sm:w-auto"
                disabled={saving || approving}
              >
                {saving ? (
                  <>
                    <Loader2 className="w-4 h-4 animate-spin" />
                    Saving...
                  </>
                ) : (
                  <>
                    <Save className="w-4 h-4" />
                    Save Changes
                  </>
                )}
              </button>
              <button
                type="button"
                onClick={() => handleSave(true)}
                className="btn-primary w-full sm:w-auto"
                disabled={saving || approving}
              >
                {approving ? (
                  <>
                    <Loader2 className="w-4 h-4 animate-spin" />
                    Approving...
                  </>
                ) : (
                  <>
                    <CheckCircle2 className="w-4 h-4" />
                    Approve Plan
                  </>
                )}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

function PlanRow({ plan, onEdit }: { plan: PlanWithInvitation; onEdit: () => void }) {
  return (
    <tr className="hover:bg-slate-50 transition-colors cursor-pointer" onClick={onEdit}>
      <td className="table-cell">
        <div className="font-medium text-slate-900">
          {plan.invitation?.candidate_name ?? 'Unknown candidate'}
        </div>
        <div className="text-xs text-slate-500">{plan.invitation?.candidate_email ?? '—'}</div>
      </td>
      <td className="table-cell">
        <span className="badge bg-slate-100 text-slate-600">
          {plan.generated_by === 'ai' ? (
            <>
              <Sparkles className="w-3 h-3" />
              AI
            </>
          ) : (
            <>
              <User className="w-3 h-3" />
              Trainer
            </>
          )}
        </span>
      </td>
      <td className="table-cell">
        {plan.status === 'approved' ? (
          <span className="badge bg-emerald-100 text-emerald-700">
            <CheckCircle2 className="w-3 h-3" />
            Approved
          </span>
        ) : (
          <span className="badge bg-amber-100 text-amber-700">
            <Clock className="w-3 h-3" />
            Draft
          </span>
        )}
      </td>
      <td className="table-cell text-slate-600">{formatDate(plan.created_at)}</td>
      <td className="table-cell text-slate-600">{formatDate(plan.approved_at)}</td>
      <td className="table-cell text-right">
        <button onClick={onEdit} className="btn-ghost text-xs px-2 py-1" title="Edit plan">
          <Pencil className="w-3.5 h-3.5" />
          Edit
        </button>
      </td>
    </tr>
  );
}

function PlanCard({ plan, onEdit }: { plan: PlanWithInvitation; onEdit: () => void }) {
  return (
    <div className="card p-4 cursor-pointer hover:border-slate-300 transition-colors" onClick={onEdit}>
      <div className="flex items-start justify-between mb-3">
        <div className="min-w-0">
          <div className="font-medium text-slate-900 truncate">
            {plan.invitation?.candidate_name ?? 'Unknown candidate'}
          </div>
          <div className="text-xs text-slate-500 truncate">{plan.invitation?.candidate_email ?? '—'}</div>
        </div>
        {plan.status === 'approved' ? (
          <span className="badge bg-emerald-100 text-emerald-700 shrink-0">
            <CheckCircle2 className="w-3 h-3" />
            Approved
          </span>
        ) : (
          <span className="badge bg-amber-100 text-amber-700 shrink-0">
            <Clock className="w-3 h-3" />
            Draft
          </span>
        )}
      </div>
      <div className="flex items-center justify-between">
        <span className="badge bg-slate-100 text-slate-600">
          {plan.generated_by === 'ai' ? (
            <>
              <Sparkles className="w-3 h-3" />
              AI
            </>
          ) : (
            <>
              <User className="w-3 h-3" />
              Trainer
            </>
          )}
        </span>
        <span className="text-xs text-slate-400">Created {formatDate(plan.created_at)}</span>
      </div>
    </div>
  );
}

function StringArrayEditor({
  label,
  icon: Icon,
  items,
  onChange,
  onAdd,
  onRemove,
}: {
  label: string;
  icon: typeof BookOpen;
  items: string[];
  onChange: (index: number, value: string) => void;
  onAdd: () => void;
  onRemove: (index: number) => void;
}) {
  return (
    <div>
      <div className="flex items-center justify-between mb-3">
        <div className="flex items-center gap-2">
          <Icon className="w-4 h-4 text-slate-500" />
          <h3 className="text-sm font-semibold text-slate-900">{label}</h3>
          {items.length > 0 && (
            <span className="text-xs text-slate-400">({items.length})</span>
          )}
        </div>
        <button type="button" onClick={onAdd} className="btn-ghost text-xs px-2 py-1">
          <Plus className="w-3.5 h-3.5" />
          Add
        </button>
      </div>
      {items.length === 0 ? (
        <p className="text-sm text-slate-400 italic px-3 py-2 border border-dashed border-slate-200 rounded-lg">
          No items yet.
        </p>
      ) : (
        <div className="space-y-2">
          {items.map((item, index) => (
            <div key={index} className="flex items-center gap-2">
              <input
                type="text"
                value={item}
                onChange={(e) => onChange(index, e.target.value)}
                className="input"
                placeholder={`Add ${label.toLowerCase()}...`}
              />
              <button
                type="button"
                onClick={() => onRemove(index)}
                className="btn-ghost p-2 text-rose-500 hover:text-rose-700 hover:bg-rose-50 shrink-0"
                title="Remove item"
              >
                <Trash2 className="w-4 h-4" />
              </button>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
