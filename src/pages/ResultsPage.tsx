import { useEffect, useState, useMemo, useCallback } from 'react';
import {
  Search, Filter, Loader2, X, ChevronRight, Mail, Calendar,
  CheckCircle2, XCircle, AlertCircle, ShieldCheck, ShieldAlert,
  Award, ClipboardList, Edit3, Save, TrendingUp, FileText,
  ListChecks, BookOpen, Hash, GraduationCap,
} from 'lucide-react';
import { supabase } from '../lib/supabase';
import type {
  AssessmentInvitation, InvitationAssessment, AssessmentResponse,
  AssessmentQuestion, CourseRecommendation, Domain, Qualification, Assessment,
} from '../lib/types';
import { DOMAIN_LABELS, RECOMMENDATION_COLORS, RECOMMENDATION_LABELS } from '../lib/types';
import { useAuth } from '../lib/auth';
import { logAudit, enqueueAxcelerateWriteback } from '../lib/audit';

interface InvitationWithQualification extends AssessmentInvitation {
  qualification: Pick<Qualification, 'id' | 'code' | 'name'> | null;
}

interface InvitationAssessmentWithDetails extends InvitationAssessment {
  assessment: Pick<Assessment, 'id' | 'title' | 'type' | 'pass_threshold'> | null;
}

interface ResponseWithQuestion extends AssessmentResponse {
  question: Pick<AssessmentQuestion, 'id' | 'question_text' | 'domain' | 'acsf_skill' | 'correct_answer' | 'points' | 'question_type' | 'options'> | null;
}

type RecFilter = CourseRecommendation | 'all' | 'overridden';

const FILTER_OPTIONS: { value: RecFilter; label: string }[] = [
  { value: 'all', label: 'All Recommendations' },
  { value: 'suitable', label: 'Suitable' },
  { value: 'suitable_with_support', label: 'Suitable with Support' },
  { value: 'not_yet_suitable', label: 'Not Yet Suitable' },
  { value: 'requirements_not_confirmed', label: 'Requirements Not Confirmed' },
  { value: 'overridden', label: 'Trainer Overridden' },
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

function effectiveRecommendation(inv: AssessmentInvitation): CourseRecommendation | null {
  if (inv.trainer_override) return inv.trainer_override as CourseRecommendation;
  return inv.course_recommendation;
}

function isOverridden(inv: AssessmentInvitation): boolean {
  return Boolean(inv.trainer_override);
}

function formatAnswer(answer: any, questionType: string | undefined, options: string[] | undefined): string {
  if (answer === null || answer === undefined) return 'No answer';
  if (questionType === 'multiple_choice' && options && options.length > 0) {
    const idx = typeof answer === 'number' ? answer : parseInt(String(answer), 10);
    if (!isNaN(idx) && idx >= 0 && idx < options.length) return options[idx];
  }
  if (typeof answer === 'boolean') return answer ? 'Yes' : 'No';
  if (typeof answer === 'object') return JSON.stringify(answer);
  return String(answer);
}

function isCorrect(answer: any, correctAnswer: any, questionType: string | undefined): boolean | null {
  if (correctAnswer === null || correctAnswer === undefined) return null;
  if (questionType === 'multiple_choice') {
    return String(answer) === String(correctAnswer);
  }
  if (typeof correctAnswer === 'string' && typeof answer === 'string') {
    return answer.trim().toLowerCase() === correctAnswer.trim().toLowerCase();
  }
  return String(answer) === String(correctAnswer);
}

export function ResultsPage() {
  const { user } = useAuth();
  const [invitations, setInvitations] = useState<InvitationWithQualification[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [searchQuery, setSearchQuery] = useState('');
  const [recFilter, setRecFilter] = useState<RecFilter>('all');
  const [selectedInvitation, setSelectedInvitation] = useState<InvitationWithQualification | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);
  const [detailError, setDetailError] = useState<string | null>(null);
  const [invAssessments, setInvAssessments] = useState<InvitationAssessmentWithDetails[]>([]);
  const [responses, setResponses] = useState<ResponseWithQuestion[]>([]);
  const [overrideMode, setOverrideMode] = useState(false);
  const [overrideValue, setOverrideValue] = useState<CourseRecommendation>('suitable');
  const [overrideReason, setOverrideReason] = useState('');
  const [savingOverride, setSavingOverride] = useState(false);

  useEffect(() => {
    loadInvitations();
  }, []);

  async function loadInvitations() {
    setLoading(true);
    setError(null);
    const { data, error: err } = await supabase
      .from('assessment_invitations')
      .select('*, qualification:qualifications(id, code, name)')
      .eq('status', 'completed')
      .order('completed_at', { ascending: false });

    if (err) {
      setError(err.message);
    } else {
      setInvitations((data || []) as InvitationWithQualification[]);
    }
    setLoading(false);
  }

  const loadDetail = useCallback(async (invitationId: string) => {
    setDetailLoading(true);
    setDetailError(null);
    setInvAssessments([]);
    setResponses([]);

    const [iaRes, respRes] = await Promise.all([
      supabase
        .from('invitation_assessments')
        .select('*, assessment:assessments(id, title, type, pass_threshold)')
        .eq('invitation_id', invitationId)
        .order('created_at', { ascending: true }),
      supabase
        .from('assessment_responses')
        .select('*, question:assessment_questions(id, question_text, domain, acsf_skill, correct_answer, points, question_type, options)')
        .eq('invitation_id', invitationId)
        .order('submitted_at', { ascending: true }),
    ]);

    if (iaRes.error) {
      setDetailError(iaRes.error.message);
      setDetailLoading(false);
      return;
    }
    if (respRes.error) {
      setDetailError(respRes.error.message);
      setDetailLoading(false);
      return;
    }

    setInvAssessments((iaRes.data || []) as InvitationAssessmentWithDetails[]);
    setResponses((respRes.data || []) as ResponseWithQuestion[]);
    setDetailLoading(false);
  }, []);

  function openDetail(inv: InvitationWithQualification) {
    setSelectedInvitation(inv);
    setOverrideMode(false);
    setOverrideValue(inv.trainer_override ? (inv.trainer_override as CourseRecommendation) : inv.course_recommendation || 'suitable');
    setOverrideReason(inv.trainer_override_reason || '');
    loadDetail(inv.id);
  }

  function closeDetail() {
    setSelectedInvitation(null);
    setInvAssessments([]);
    setResponses([]);
    setDetailError(null);
    setOverrideMode(false);
  }

  async function handleSaveOverride() {
    if (!selectedInvitation || !user) return;
    if (!overrideReason.trim()) {
      setDetailError('A reason is required when overriding the recommendation.');
      return;
    }

    setSavingOverride(true);
    setDetailError(null);
    const now = new Date().toISOString();

    const { data, error: updateErr } = await supabase
      .from('assessment_invitations')
      .update({
        trainer_override: overrideValue,
        trainer_override_reason: overrideReason.trim(),
        trainer_override_by: user.id,
        trainer_override_at: now,
      })
      .eq('id', selectedInvitation.id)
      .select('*, qualification:qualifications(id, code, name)')
      .single();

    setSavingOverride(false);

    if (updateErr) {
      setDetailError(updateErr.message);
      return;
    }

    const updated = data as InvitationWithQualification;
    setSelectedInvitation(updated);
    setInvitations((prev) => prev.map((inv) => (inv.id === updated.id ? updated : inv)));
    setOverrideMode(false);

    logAudit({
      event_type: 'trainer_override.applied',
      category: 'assessment_results',
      description: `Trainer override applied for ${selectedInvitation.candidate_name} — ${overrideValue}`,
      severity: 'warning',
      source: 'trainer',
      actor_id: user.id,
      invitation_id: selectedInvitation.id,
      qualification_id: selectedInvitation.qualification_id ?? null,
      previous_values: { recommendation: selectedInvitation.course_recommendation },
      new_values: { override: overrideValue, reason: overrideReason.trim() },
    });
    // Re-sync finalised outcome to aXcelerate
    enqueueAxcelerateWriteback(selectedInvitation.id, 'assessment_completed');
  }

  async function handleClearOverride() {
    if (!selectedInvitation || !user) return;

    setSavingOverride(true);
    setDetailError(null);

    const { data, error: updateErr } = await supabase
      .from('assessment_invitations')
      .update({
        trainer_override: null,
        trainer_override_reason: null,
        trainer_override_by: null,
        trainer_override_at: null,
      })
      .eq('id', selectedInvitation.id)
      .select('*, qualification:qualifications(id, code, name)')
      .single();

    setSavingOverride(false);

    if (updateErr) {
      setDetailError(updateErr.message);
      return;
    }

    const updated = data as InvitationWithQualification;
    setSelectedInvitation(updated);
    setInvitations((prev) => prev.map((inv) => (inv.id === updated.id ? updated : inv)));
    setOverrideValue(updated.course_recommendation || 'suitable');
    setOverrideReason('');
    setOverrideMode(false);

    logAudit({
      event_type: 'trainer_override.removed',
      category: 'assessment_results',
      description: `Trainer override removed for ${selectedInvitation.candidate_name}`,
      source: 'trainer',
      actor_id: user.id,
      invitation_id: selectedInvitation.id,
      qualification_id: selectedInvitation.qualification_id ?? null,
      previous_values: { override: selectedInvitation.trainer_override },
    });
  }

  const filteredInvitations = useMemo(() => {
    return invitations.filter((inv) => {
      const rec = effectiveRecommendation(inv);
      const overridden = isOverridden(inv);

      if (recFilter === 'overridden') {
        if (!overridden) return false;
      } else if (recFilter !== 'all') {
        if (rec !== recFilter) return false;
      }

      if (searchQuery) {
        const q = searchQuery.toLowerCase();
        const matchesName = inv.candidate_name.toLowerCase().includes(q);
        const matchesEmail = inv.candidate_email.toLowerCase().includes(q);
        const matchesQual = inv.qualification?.name.toLowerCase().includes(q);
        const matchesCode = inv.qualification?.code.toLowerCase().includes(q);
        if (!matchesName && !matchesEmail && !matchesQual && !matchesCode) return false;
      }

      return true;
    });
  }, [invitations, recFilter, searchQuery]);

  const recCounts = useMemo(() => {
    const counts: Record<string, number> = {
      all: invitations.length,
      suitable: 0,
      suitable_with_support: 0,
      not_yet_suitable: 0,
      requirements_not_confirmed: 0,
      overridden: 0,
    };
    for (const inv of invitations) {
      const rec = effectiveRecommendation(inv);
      if (rec && counts[rec] !== undefined) counts[rec]++;
      if (isOverridden(inv)) counts.overridden++;
    }
    return counts;
  }, [invitations]);

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold text-slate-900">Results</h1>
        <p className="text-sm text-slate-500 mt-1">
          Review completed LLND Automate assessments, ACSF outcomes, and course recommendations.
        </p>
      </div>

      {error && (
        <div className="card p-4 border-error-200 bg-error-50">
          <div className="flex items-start gap-2">
            <AlertCircle className="w-5 h-5 text-error-600 flex-shrink-0 mt-0.5" />
            <div className="flex-1">
              <p className="text-sm text-error-700">{error}</p>
              <button
                onClick={() => setError(null)}
                className="text-error-600 hover:text-error-800 text-xs font-medium mt-1"
              >
                Dismiss
              </button>
            </div>
          </div>
        </div>
      )}

      <div className="card p-4">
        <div className="flex flex-col sm:flex-row gap-3">
          <div className="relative flex-1">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-slate-400" />
            <input
              type="text"
              placeholder="Search by name, email, or qualification..."
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              className="input pl-9"
            />
          </div>
          <div className="relative">
            <Filter className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-slate-400 pointer-events-none" />
            <select
              value={recFilter}
              onChange={(e) => setRecFilter(e.target.value as RecFilter)}
              className="input pl-9 pr-8 appearance-none cursor-pointer min-w-[200px]"
            >
              {FILTER_OPTIONS.map((opt) => (
                <option key={opt.value} value={opt.value}>
                  {opt.label} ({recCounts[opt.value] || 0})
                </option>
              ))}
            </select>
          </div>
        </div>
      </div>

      {loading ? (
        <div className="flex items-center justify-center py-20 text-slate-400">
          <Loader2 className="w-6 h-6 animate-spin mr-2" />
          Loading results...
        </div>
      ) : filteredInvitations.length === 0 ? (
        <div className="card p-12 text-center">
          <ClipboardList className="w-12 h-12 text-slate-300 mx-auto mb-4" />
          <h3 className="text-base font-semibold text-slate-900 mb-1">
            {invitations.length === 0 ? 'No completed assessments' : 'No matching results'}
          </h3>
          <p className="text-sm text-slate-500">
            {invitations.length === 0
              ? 'Completed assessments will appear here once candidates finish their quizzes.'
              : 'Try adjusting your search or filter criteria.'}
          </p>
        </div>
      ) : (
        <>
          <div className="card overflow-hidden hidden md:block">
            <div className="overflow-x-auto">
              <table className="w-full">
                <thead className="bg-slate-50 border-b border-slate-200">
                  <tr>
                    <th className="table-header">Candidate</th>
                    <th className="table-header">Qualification</th>
                    <th className="table-header">Recommendation</th>
                    <th className="table-header">Completed</th>
                    <th className="table-header">Identity</th>
                    <th className="table-header text-right">Actions</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-200">
                  {filteredInvitations.map((inv) => {
                    const rec = effectiveRecommendation(inv);
                    const overridden = isOverridden(inv);
                    return (
                      <tr
                        key={inv.id}
                        onClick={() => openDetail(inv)}
                        className="hover:bg-slate-50 transition-colors cursor-pointer"
                      >
                        <td className="table-cell">
                          <div className="font-medium text-slate-900">{inv.candidate_name}</div>
                          <div className="text-xs text-slate-500 flex items-center gap-1">
                            <Mail className="w-3 h-3" />
                            {inv.candidate_email}
                          </div>
                        </td>
                        <td className="table-cell">
                          {inv.qualification ? (
                            <div>
                              <div className="text-sm font-medium text-slate-700">
                                {inv.qualification.code}
                              </div>
                              <div className="text-xs text-slate-500">
                                {inv.qualification.name}
                              </div>
                            </div>
                          ) : (
                            <span className="text-sm text-slate-400">—</span>
                          )}
                        </td>
                        <td className="table-cell">
                          {rec ? (
                            <div className="flex flex-col gap-1">
                              <span className={`badge ${RECOMMENDATION_COLORS[rec]}`}>
                                <Award className="w-3 h-3" />
                                {RECOMMENDATION_LABELS[rec]}
                              </span>
                              {overridden && (
                                <span className="badge bg-slate-200 text-slate-600 text-[10px] px-1.5 py-0.5">
                                  Overridden
                                </span>
                              )}
                            </div>
                          ) : (
                            <span className="text-sm text-slate-400">Pending</span>
                          )}
                        </td>
                        <td className="table-cell">
                          <div className="flex items-center gap-1.5">
                            <Calendar className="w-3.5 h-3.5 text-slate-400" />
                            <span className="text-slate-600">{formatDate(inv.completed_at)}</span>
                          </div>
                        </td>
                        <td className="table-cell">
                          {inv.identity_verified ? (
                            <span className="badge bg-emerald-100 text-emerald-700">
                              <ShieldCheck className="w-3 h-3" />
                              Verified
                            </span>
                          ) : (
                            <span className="badge bg-rose-100 text-rose-700">
                              <ShieldAlert className="w-3 h-3" />
                              Unverified
                            </span>
                          )}
                        </td>
                        <td className="table-cell text-right">
                          <button
                            onClick={(e) => {
                              e.stopPropagation();
                              openDetail(inv);
                            }}
                            className="btn-ghost text-xs px-2 py-1"
                          >
                            View Details
                            <ChevronRight className="w-3.5 h-3.5" />
                          </button>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </div>

          <div className="md:hidden space-y-3">
            {filteredInvitations.map((inv) => {
              const rec = effectiveRecommendation(inv);
              const overridden = isOverridden(inv);
              return (
                <div
                  key={inv.id}
                  onClick={() => openDetail(inv)}
                  className="card p-4 cursor-pointer hover:border-primary-300 transition-colors"
                >
                  <div className="flex items-start justify-between mb-3">
                    <div>
                      <div className="font-medium text-slate-900">{inv.candidate_name}</div>
                      <div className="text-xs text-slate-500">{inv.candidate_email}</div>
                    </div>
                    <ChevronRight className="w-4 h-4 text-slate-400" />
                  </div>

                  {inv.qualification && (
                    <div className="text-xs text-slate-500 mb-2">
                      {inv.qualification.code} — {inv.qualification.name}
                    </div>
                  )}

                  <div className="flex items-center justify-between flex-wrap gap-2">
                    {rec ? (
                      <div className="flex items-center gap-1.5">
                        <span className={`badge ${RECOMMENDATION_COLORS[rec]}`}>
                          <Award className="w-3 h-3" />
                          {RECOMMENDATION_LABELS[rec]}
                        </span>
                        {overridden && (
                          <span className="badge bg-slate-200 text-slate-600 text-[10px] px-1.5 py-0.5">
                            Overridden
                          </span>
                        )}
                      </div>
                    ) : (
                      <span className="text-xs text-slate-400">Pending</span>
                    )}
                    <div className="flex items-center gap-2">
                      {inv.identity_verified ? (
                        <span className="badge bg-emerald-100 text-emerald-700">
                          <ShieldCheck className="w-3 h-3" />
                          Verified
                        </span>
                      ) : (
                        <span className="badge bg-rose-100 text-rose-700">
                          <ShieldAlert className="w-3 h-3" />
                          Unverified
                        </span>
                      )}
                      <span className="text-xs text-slate-500">{formatDate(inv.completed_at)}</span>
                    </div>
                  </div>
                </div>
              );
            })}
          </div>
        </>
      )}

      {selectedInvitation && (
        <DetailModal
          invitation={selectedInvitation}
          invAssessments={invAssessments}
          responses={responses}
          detailLoading={detailLoading}
          detailError={detailError}
          overrideMode={overrideMode}
          overrideValue={overrideValue}
          overrideReason={overrideReason}
          savingOverride={savingOverride}
          onClose={closeDetail}
          onOverrideValueChange={setOverrideValue}
          onOverrideReasonChange={setOverrideReason}
          onSaveOverride={handleSaveOverride}
          onClearOverride={handleClearOverride}
          onEnterOverrideMode={() => {
            setDetailError(null);
            setOverrideMode(true);
          }}
          onCancelOverride={() => {
            setOverrideMode(false);
            setOverrideValue(
              selectedInvitation.trainer_override
                ? (selectedInvitation.trainer_override as CourseRecommendation)
                : selectedInvitation.course_recommendation || 'suitable'
            );
            setOverrideReason(selectedInvitation.trainer_override_reason || '');
          }}
        />
      )}
    </div>
  );
}

interface DetailModalProps {
  invitation: InvitationWithQualification;
  invAssessments: InvitationAssessmentWithDetails[];
  responses: ResponseWithQuestion[];
  detailLoading: boolean;
  detailError: string | null;
  overrideMode: boolean;
  overrideValue: CourseRecommendation;
  overrideReason: string;
  savingOverride: boolean;
  onClose: () => void;
  onOverrideValueChange: (v: CourseRecommendation) => void;
  onOverrideReasonChange: (v: string) => void;
  onSaveOverride: () => void;
  onClearOverride: () => void;
  onEnterOverrideMode: () => void;
  onCancelOverride: () => void;
}

function DetailModal({
  invitation, invAssessments, responses, detailLoading, detailError,
  overrideMode, overrideValue, overrideReason, savingOverride,
  onClose, onOverrideValueChange, onOverrideReasonChange, onSaveOverride,
  onClearOverride, onEnterOverrideMode, onCancelOverride,
}: DetailModalProps) {
  const rec = effectiveRecommendation(invitation);
  const overridden = isOverridden(invitation);
  const systemRec = invitation.course_recommendation;

  const responsesByAssessment = useMemo(() => {
    const map = new Map<string, ResponseWithQuestion[]>();
    for (const r of responses) {
      const list = map.get(r.assessment_id) || [];
      list.push(r);
      map.set(r.assessment_id, list);
    }
    return map;
  }, [responses]);

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-slate-900/50 backdrop-blur-sm">
      <div className="card w-full max-w-4xl max-h-[90vh] overflow-y-auto scrollbar-thin animate-slide-up">
        <div className="flex items-center justify-between p-5 border-b border-slate-200 sticky top-0 bg-white rounded-t-xl z-10">
          <div className="flex items-center gap-3 min-w-0">
            <div className="w-10 h-10 rounded-lg bg-primary-50 flex items-center justify-center flex-shrink-0">
              <FileText className="w-5 h-5 text-primary-600" />
            </div>
            <div className="min-w-0">
              <h2 className="text-lg font-bold text-slate-900 truncate">
                {invitation.candidate_name}
              </h2>
              <p className="text-sm text-slate-500 truncate">{invitation.candidate_email}</p>
            </div>
          </div>
          <button onClick={onClose} className="btn-ghost p-1.5 flex-shrink-0">
            <X className="w-5 h-5" />
          </button>
        </div>

        <div className="p-5 space-y-6">
          {detailError && (
            <div className="card p-3 border-error-200 bg-error-50">
              <div className="flex items-start gap-2">
                <AlertCircle className="w-4 h-4 text-error-600 flex-shrink-0 mt-0.5" />
                <p className="text-sm text-error-700">{detailError}</p>
              </div>
            </div>
          )}

          <CandidateSummary invitation={invitation} rec={rec} overridden={overridden} systemRec={systemRec} />

          <IdentityVerificationSection invitation={invitation} />

          <RecommendationSection
            invitation={invitation}
            rec={rec}
            overridden={overridden}
            systemRec={systemRec}
            overrideMode={overrideMode}
            overrideValue={overrideValue}
            overrideReason={overrideReason}
            savingOverride={savingOverride}
            onOverrideValueChange={onOverrideValueChange}
            onOverrideReasonChange={onOverrideReasonChange}
            onSaveOverride={onSaveOverride}
            onClearOverride={onClearOverride}
            onEnterOverrideMode={onEnterOverrideMode}
            onCancelOverride={onCancelOverride}
          />

          {detailLoading ? (
            <div className="flex items-center justify-center py-12 text-slate-400">
              <Loader2 className="w-5 h-5 animate-spin mr-2" />
              Loading assessment details...
            </div>
          ) : (
            <>
              <AssessmentScoresSection invAssessments={invAssessments} />

              <ACSFOutcomesSection invAssessments={invAssessments} />

              <QuestionResponsesSection
                invAssessments={invAssessments}
                responsesByAssessment={responsesByAssessment}
              />
            </>
          )}
        </div>
      </div>
    </div>
  );
}

function CandidateSummary({
  invitation, rec, overridden, systemRec,
}: {
  invitation: InvitationWithQualification;
  rec: CourseRecommendation | null;
  overridden: boolean;
  systemRec: CourseRecommendation | null;
}) {
  return (
    <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
      <div className="card p-4 bg-slate-50 border-slate-200">
        <div className="flex items-center gap-2 mb-3">
          <GraduationCap className="w-4 h-4 text-slate-500" />
          <h3 className="text-sm font-semibold text-slate-700">Qualification</h3>
        </div>
        {invitation.qualification ? (
          <div>
            <div className="text-base font-semibold text-slate-900">
              {invitation.qualification.code}
            </div>
            <div className="text-sm text-slate-600">{invitation.qualification.name}</div>
          </div>
        ) : (
          <div className="text-sm text-slate-400">Not specified</div>
        )}
      </div>

      <div className="card p-4 bg-slate-50 border-slate-200">
        <div className="flex items-center gap-2 mb-3">
          <Calendar className="w-4 h-4 text-slate-500" />
          <h3 className="text-sm font-semibold text-slate-700">Completion</h3>
        </div>
        <div className="text-base font-semibold text-slate-900">
          {formatDateTime(invitation.completed_at)}
        </div>
        <div className="text-sm text-slate-500 mt-0.5">
          Recommendation: {rec ? RECOMMENDATION_LABELS[rec] : 'Pending'}
          {overridden && systemRec && (
            <span className="text-xs text-slate-400 ml-1">
              (system: {RECOMMENDATION_LABELS[systemRec]})
            </span>
          )}
        </div>
      </div>
    </div>
  );
}

function IdentityVerificationSection({ invitation }: { invitation: AssessmentInvitation }) {
  return (
    <div className="card p-4">
      <div className="flex items-center gap-2 mb-3">
        {invitation.identity_verified ? (
          <ShieldCheck className="w-4 h-4 text-emerald-600" />
        ) : (
          <ShieldAlert className="w-4 h-4 text-rose-600" />
        )}
        <h3 className="text-sm font-semibold text-slate-700">Identity Verification</h3>
      </div>
      <div className="flex items-center gap-3 flex-wrap">
        {invitation.identity_verified ? (
          <>
            <span className="badge bg-emerald-100 text-emerald-700">
              <ShieldCheck className="w-3 h-3" />
              Verified
            </span>
            {invitation.identity_verification_method && (
              <span className="text-sm text-slate-600">
                Method: <span className="font-medium">{invitation.identity_verification_method}</span>
              </span>
            )}
            {invitation.identity_verified_at && (
              <span className="text-sm text-slate-500">
                {formatDateTime(invitation.identity_verified_at)}
              </span>
            )}
          </>
        ) : (
          <span className="text-sm text-rose-600">
            Identity was not verified before completing the assessment.
          </span>
        )}
      </div>
    </div>
  );
}

function RecommendationSection({
  invitation, rec, overridden, systemRec,
  overrideMode, overrideValue, overrideReason, savingOverride,
  onOverrideValueChange, onOverrideReasonChange, onSaveOverride,
  onClearOverride, onEnterOverrideMode, onCancelOverride,
}: {
  invitation: AssessmentInvitation;
  rec: CourseRecommendation | null;
  overridden: boolean;
  systemRec: CourseRecommendation | null;
  overrideMode: boolean;
  overrideValue: CourseRecommendation;
  overrideReason: string;
  savingOverride: boolean;
  onOverrideValueChange: (v: CourseRecommendation) => void;
  onOverrideReasonChange: (v: string) => void;
  onSaveOverride: () => void;
  onClearOverride: () => void;
  onEnterOverrideMode: () => void;
  onCancelOverride: () => void;
}) {
  return (
    <div className="card p-4">
      <div className="flex items-center justify-between mb-3 flex-wrap gap-2">
        <div className="flex items-center gap-2">
          <Award className="w-4 h-4 text-primary-600" />
          <h3 className="text-sm font-semibold text-slate-700">Course Recommendation</h3>
        </div>
        {!overrideMode && (
          <div className="flex items-center gap-2">
            {overridden && (
              <button
                onClick={onClearOverride}
                disabled={savingOverride}
                className="btn-ghost text-xs px-2 py-1 text-error-600 hover:bg-error-50"
              >
                {savingOverride ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <XCircle className="w-3.5 h-3.5" />}
                Clear Override
              </button>
            )}
            <button onClick={onEnterOverrideMode} className="btn-secondary text-xs px-2 py-1">
              <Edit3 className="w-3.5 h-3.5" />
              {overridden ? 'Edit Override' : 'Trainer Override'}
            </button>
          </div>
        )}
      </div>

      {!overrideMode ? (
        <div className="space-y-3">
          <div className="flex items-center gap-2 flex-wrap">
            <span className="text-sm text-slate-500">Effective:</span>
            {rec ? (
              <span className={`badge ${RECOMMENDATION_COLORS[rec]} text-sm px-3 py-1`}>
                <Award className="w-3.5 h-3.5" />
                {RECOMMENDATION_LABELS[rec]}
              </span>
            ) : (
              <span className="text-sm text-slate-400">No recommendation</span>
            )}
            {overridden && systemRec && (
              <span className="text-xs text-slate-400">
                System recommended: {RECOMMENDATION_LABELS[systemRec]}
              </span>
            )}
          </div>

          {invitation.recommendation_reasons && invitation.recommendation_reasons.length > 0 && (
            <div>
              <div className="text-xs font-semibold text-slate-500 uppercase tracking-wider mb-2">
                Reasons
              </div>
              <ul className="space-y-1.5">
                {invitation.recommendation_reasons.map((reason, idx) => (
                  <li key={idx} className="flex items-start gap-2 text-sm text-slate-600">
                    <span className="w-1.5 h-1.5 rounded-full bg-primary-400 mt-1.5 flex-shrink-0" />
                    {reason}
                  </li>
                ))}
              </ul>
            </div>
          )}

          {overridden && invitation.trainer_override_reason && (
            <div className="mt-3 p-3 rounded-lg bg-slate-50 border border-slate-200">
              <div className="text-xs font-semibold text-slate-500 uppercase tracking-wider mb-1">
                Trainer Override Reason
              </div>
              <p className="text-sm text-slate-700">{invitation.trainer_override_reason}</p>
              {invitation.trainer_override_at && (
                <p className="text-xs text-slate-400 mt-1">
                  {formatDateTime(invitation.trainer_override_at)}
                </p>
              )}
            </div>
          )}
        </div>
      ) : (
        <div className="space-y-4">
          <div>
            <label className="label">Override Recommendation</label>
            <select
              value={overrideValue}
              onChange={(e) => onOverrideValueChange(e.target.value as CourseRecommendation)}
              className="input cursor-pointer"
              disabled={savingOverride}
            >
              {(Object.keys(RECOMMENDATION_LABELS) as CourseRecommendation[]).map((key) => (
                <option key={key} value={key}>
                  {RECOMMENDATION_LABELS[key]}
                </option>
              ))}
            </select>
          </div>
          <div>
            <label className="label">Reason for Override</label>
            <textarea
              value={overrideReason}
              onChange={(e) => onOverrideReasonChange(e.target.value)}
              className="input min-h-[80px] resize-y"
              placeholder="Explain why the recommendation is being overridden..."
              disabled={savingOverride}
            />
          </div>
          <div className="flex items-center justify-end gap-2 pt-1">
            <button onClick={onCancelOverride} className="btn-secondary" disabled={savingOverride}>
              Cancel
            </button>
            <button onClick={onSaveOverride} className="btn-primary" disabled={savingOverride}>
              {savingOverride ? (
                <>
                  <Loader2 className="w-4 h-4 animate-spin" />
                  Saving...
                </>
              ) : (
                <>
                  <Save className="w-4 h-4" />
                  Save Override
                </>
              )}
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

function AssessmentScoresSection({ invAssessments }: { invAssessments: InvitationAssessmentWithDetails[] }) {
  if (invAssessments.length === 0) {
    return (
      <div className="card p-4">
        <div className="flex items-center gap-2 mb-2">
          <ListChecks className="w-4 h-4 text-slate-500" />
          <h3 className="text-sm font-semibold text-slate-700">Assessment Scores</h3>
        </div>
        <p className="text-sm text-slate-400">No assessment data available.</p>
      </div>
    );
  }

  return (
    <div className="card p-4">
      <div className="flex items-center gap-2 mb-3">
        <ListChecks className="w-4 h-4 text-slate-500" />
        <h3 className="text-sm font-semibold text-slate-700">Assessment Scores</h3>
      </div>
      <div className="space-y-3">
        {invAssessments.map((ia) => {
          const title = ia.assessment?.title || 'Unknown Assessment';
          const type = ia.assessment?.type;
          const score = ia.individual_score != null ? Math.round(Number(ia.individual_score)) : null;
          const passed = ia.individual_passed;
          const threshold = ia.assessment?.pass_threshold;
          return (
            <div key={ia.id} className="flex items-center justify-between p-3 rounded-lg bg-slate-50 border border-slate-200">
              <div className="min-w-0">
                <div className="text-sm font-medium text-slate-900 truncate">{title}</div>
                <div className="text-xs text-slate-500">
                  {type === 'lln' ? 'LLN' : type === 'digital' ? 'Digital Literacy' : type || 'Assessment'}
                  {threshold != null && ` · Pass threshold: ${threshold}%`}
                </div>
              </div>
              <div className="flex items-center gap-3 flex-shrink-0">
                {score != null && (
                  <div className="text-right">
                    <div className="text-sm font-semibold text-slate-900 tabular-nums">{score}%</div>
                    <div className="text-xs text-slate-400">Score</div>
                  </div>
                )}
                {passed === true && (
                  <span className="badge bg-emerald-100 text-emerald-700">
                    <CheckCircle2 className="w-3 h-3" />
                    Passed
                  </span>
                )}
                {passed === false && (
                  <span className="badge bg-rose-100 text-rose-700">
                    <XCircle className="w-3 h-3" />
                    Not Passed
                  </span>
                )}
                {passed === null && (
                  <span className="badge bg-slate-100 text-slate-500">
                    Pending
                  </span>
                )}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

function ACSFOutcomesSection({ invAssessments }: { invAssessments: InvitationAssessmentWithDetails[] }) {
  const allDomains = useMemo(() => {
    const domainMap = new Map<string, { levels: number[]; assessmentTitle: string }>();
    for (const ia of invAssessments) {
      const outcomes = ia.acsf_outcomes || {};
      const assessmentTitle = ia.assessment?.title || 'Assessment';
      for (const [domain, level] of Object.entries(outcomes)) {
        const existing = domainMap.get(domain) || { levels: [] as number[], assessmentTitle };
        existing.levels.push(Number(level));
        domainMap.set(domain, existing);
      }
    }
    return domainMap;
  }, [invAssessments]);

  const hasOutcomes = Array.from(allDomains.values()).some((d) => d.levels.length > 0);

  return (
    <div className="card p-4">
      <div className="flex items-center gap-2 mb-3">
        <TrendingUp className="w-4 h-4 text-slate-500" />
        <h3 className="text-sm font-semibold text-slate-700">ACSF Outcomes by Domain</h3>
      </div>
      {!hasOutcomes ? (
        <p className="text-sm text-slate-400">No ACSF outcome data recorded.</p>
      ) : (
        <div className="space-y-4">
          {invAssessments.map((ia) => {
            const outcomes = ia.acsf_outcomes || {};
            const entries = Object.entries(outcomes);
            if (entries.length === 0) return null;
            const title = ia.assessment?.title || 'Assessment';
            return (
              <div key={ia.id}>
                <div className="text-xs font-semibold text-slate-500 uppercase tracking-wider mb-2">
                  {title}
                </div>
                <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-2">
                  {entries.map(([domain, level]) => {
                    const label = DOMAIN_LABELS[domain as Domain] || domain;
                    const lvl = Number(level);
                    return (
                      <div
                        key={domain}
                        className="flex items-center justify-between p-2.5 rounded-lg bg-slate-50 border border-slate-200"
                      >
                        <div className="flex items-center gap-2 min-w-0">
                          <BookOpen className="w-3.5 h-3.5 text-slate-400 flex-shrink-0" />
                          <span className="text-sm text-slate-600 truncate">{label}</span>
                        </div>
                        <span className="badge bg-primary-100 text-primary-700 tabular-nums flex-shrink-0">
                          <Hash className="w-3 h-3" />
                          Level {lvl}
                        </span>
                      </div>
                    );
                  })}
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

function QuestionResponsesSection({
  invAssessments, responsesByAssessment,
}: {
  invAssessments: InvitationAssessmentWithDetails[];
  responsesByAssessment: Map<string, ResponseWithQuestion[]>;
}) {
  const hasResponses = Array.from(responsesByAssessment.values()).some((list) => list.length > 0);

  return (
    <div className="card p-4">
      <div className="flex items-center gap-2 mb-3">
        <FileText className="w-4 h-4 text-slate-500" />
        <h3 className="text-sm font-semibold text-slate-700">Question Responses</h3>
      </div>
      {!hasResponses ? (
        <p className="text-sm text-slate-400">No question responses recorded.</p>
      ) : (
        <div className="space-y-5">
          {invAssessments.map((ia) => {
            const respList = responsesByAssessment.get(ia.assessment_id) || [];
            if (respList.length === 0) return null;
            const title = ia.assessment?.title || 'Assessment';
            return (
              <div key={ia.id}>
                <div className="text-xs font-semibold text-slate-500 uppercase tracking-wider mb-2">
                  {title} ({respList.length} {respList.length === 1 ? 'response' : 'responses'})
                </div>
                <div className="space-y-2">
                  {respList.map((r, idx) => {
                    const q = r.question;
                    const domainLabel = q?.domain ? (DOMAIN_LABELS[q.domain as Domain] || q.domain) : null;
                    const correct = isCorrect(r.answer, q?.correct_answer, q?.question_type);
                    return (
                      <div
                        key={r.id}
                        className="p-3 rounded-lg border border-slate-200 bg-white"
                      >
                        <div className="flex items-start justify-between gap-3 mb-2">
                          <div className="flex items-start gap-2 min-w-0">
                            <span className="text-xs font-semibold text-slate-400 tabular-nums flex-shrink-0 mt-0.5">
                              Q{idx + 1}
                            </span>
                            <p className="text-sm text-slate-700">
                              {q?.question_text || 'Question text unavailable'}
                            </p>
                          </div>
                          {correct !== null && (
                            <span className={`badge flex-shrink-0 ${correct ? 'bg-emerald-100 text-emerald-700' : 'bg-rose-100 text-rose-700'}`}>
                              {correct ? (
                                <>
                                  <CheckCircle2 className="w-3 h-3" />
                                  Correct
                                </>
                              ) : (
                                <>
                                  <XCircle className="w-3 h-3" />
                                  Incorrect
                                </>
                              )}
                            </span>
                          )}
                        </div>
                        <div className="flex items-center gap-4 flex-wrap text-xs ml-6">
                          <div>
                            <span className="text-slate-400">Answer: </span>
                            <span className="font-medium text-slate-700">
                              {formatAnswer(r.answer, q?.question_type, q?.options as string[] | undefined)}
                            </span>
                          </div>
                          {q?.correct_answer != null && (
                            <div>
                              <span className="text-slate-400">Correct: </span>
                              <span className="font-medium text-slate-700">
                                {formatAnswer(q.correct_answer, q?.question_type, q?.options as string[] | undefined)}
                              </span>
                            </div>
                          )}
                          {domainLabel && (
                            <div>
                              <span className="text-slate-400">Domain: </span>
                              <span className="font-medium text-slate-700">{domainLabel}</span>
                            </div>
                          )}
                          {q?.acsf_skill && (
                            <div>
                              <span className="text-slate-400">Skill: </span>
                              <span className="font-medium text-slate-700">{q.acsf_skill}</span>
                            </div>
                          )}
                          {q?.points != null && (
                            <div>
                              <span className="text-slate-400">Points: </span>
                              <span className="font-medium text-slate-700">{q.points}</span>
                            </div>
                          )}
                        </div>
                      </div>
                    );
                  })}
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
