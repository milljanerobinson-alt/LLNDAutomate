import { useEffect, useState, useCallback, useRef } from 'react';
import {
  GraduationCap, CheckCircle2, Circle, ArrowRight, ArrowLeft,
  Clock, UserCheck, Award, BookOpen, Calculator, Monitor,
} from 'lucide-react';
import { createQuizClient } from '../lib/supabase';
import { logAuditAnon } from '../lib/audit';
import type {
  AssessmentInvitation, InvitationAssessment, Assessment,
  Domain,
} from '../lib/types';
import { DOMAIN_LABELS } from '../lib/types';

interface QuizQuestion {
  id: string;
  assessment_id: string;
  question_text: string;
  domain: Domain;
  acsf_skill: string;
  acsf_level_target: number | null;
  question_type: 'multiple_choice' | 'short_answer' | 'scale';
  options: string[];
  order_index: number;
  points: number;
  mapping_rationale: string | null;
  version: string;
  created_at: string;
}

const DOMAIN_ICONS: Record<Domain, typeof BookOpen> = {
  language: BookOpen,
  literacy: BookOpen,
  numeracy: Calculator,
  digital: Monitor,
};

export function QuizPage({ token }: { token: string }) {
  const [invitation, setInvitation] = useState<AssessmentInvitation | null>(null);
  const [invAssessments, setInvAssessments] = useState<(InvitationAssessment & { assessment: Assessment })[]>([]);
  const [loading, setLoading] = useState(true);
  const [activeAssessmentId, setActiveAssessmentId] = useState<string | null>(null);
  const [questions, setQuestions] = useState<QuizQuestion[]>([]);
  const [currentQ, setCurrentQ] = useState(0);
  const [answers, setAnswers] = useState<Record<string, any>>({});
  const [identityForm, setIdentityForm] = useState({ name: '', dob: '' });
  const [identityVerified, setIdentityVerified] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [completedAssessmentIds, setCompletedAssessmentIds] = useState<Set<string>>(new Set());
  const [showResults, setShowResults] = useState(false);

  const quizClient = createQuizClient(token);

  // Refs to track current quiz state inside event listeners (avoids stale closures)
  const abandonRef = useRef({
    invitation: null as AssessmentInvitation | null,
    activeAssessmentId: null as string | null,
    invAssessments: [] as (InvitationAssessment & { assessment: Assessment })[],
    answers: {} as Record<string, any>,
    questions: [] as QuizQuestion[],
    showResults: false,
    lastRecordedAt: 0,
  });

  // Keep ref in sync with state
  useEffect(() => {
    abandonRef.current.invitation = invitation;
    abandonRef.current.activeAssessmentId = activeAssessmentId;
    abandonRef.current.invAssessments = invAssessments;
    abandonRef.current.answers = answers;
    abandonRef.current.questions = questions;
    abandonRef.current.showResults = showResults;
  }, [invitation, activeAssessmentId, invAssessments, answers, questions, showResults]);

  // Abandonment detection: fires when tab is hidden or page unloads mid-quiz
  useEffect(() => {
    async function recordAbandonment() {
      const ref = abandonRef.current;
      if (!ref.invitation || !ref.activeAssessmentId || ref.showResults) return;
      // Debounce: don't fire twice within 10 seconds
      if (Date.now() - ref.lastRecordedAt < 10_000) return;
      ref.lastRecordedAt = Date.now();

      const progressPercent = ref.questions.length > 0
        ? Math.round((Object.keys(ref.answers).length / ref.questions.length) * 100)
        : 0;
      const assessmentType = ref.invAssessments.find(
        (a) => a.assessment_id === ref.activeAssessmentId
      )?.assessment?.type;
      const eventType = assessmentType === 'digital' ? 'digital.abandoned' : 'lln.abandoned';

      await logAuditAnon(
        {
          event_type: eventType,
          category: 'assessment',
          description: `Quiz left at ${progressPercent}% completion`,
          source: 'student',
          invitation_id: ref.invitation.id,
          event_data: { progress_percent: progressPercent, assessment_type: assessmentType ?? 'lln' },
        },
        token,
      );
    }

    function onVisibilityChange() {
      if (document.visibilityState === 'hidden') recordAbandonment();
    }
    function onPageHide() { recordAbandonment(); }

    document.addEventListener('visibilitychange', onVisibilityChange);
    window.addEventListener('pagehide', onPageHide);
    return () => {
      document.removeEventListener('visibilitychange', onVisibilityChange);
      window.removeEventListener('pagehide', onPageHide);
    };
  }, [token]);

  useEffect(() => {
    loadInvitation();
  }, [token]);

  async function loadInvitation() {
    const { data: inv } = await quizClient
      .from('assessment_invitations')
      .select('*')
      .eq('unique_token', token)
      .maybeSingle();

    if (!inv) {
      setLoading(false);
      return;
    }

    setInvitation(inv as AssessmentInvitation);
    setIdentityVerified(inv.identity_verified);
    if (inv.identity_verified) {
      setIdentityForm({ name: inv.candidate_name, dob: '' });
    }

    const { data: invAsses } = await quizClient
      .from('invitation_assessments')
      .select('*, assessment:assessments(*)')
      .eq('invitation_id', inv.id);

    if (invAsses) {
      setInvAssessments(invAsses as any);
      const completed = new Set(
        invAsses.filter((a) => a.individual_status === 'completed').map((a) => a.assessment_id)
      );
      setCompletedAssessmentIds(completed);
    }

    if (inv.status === 'sent' && !inv.opened_at) {
      await quizClient
        .from('assessment_invitations')
        .update({ status: 'opened', opened_at: new Date().toISOString() })
        .eq('id', inv.id);
    }

    setLoading(false);
  }

  const startAssessment = useCallback(async (assessmentId: string) => {
    setActiveAssessmentId(assessmentId);
    setAnswers({});
    setShowResults(false);
    setCurrentQ(0); // will be overridden below if prior answers exist

    const { data: qs } = await quizClient
      .from('assessment_questions_public')
      .select('*')
      .eq('assessment_id', assessmentId)
      .order('order_index', { ascending: true });

    if (qs) setQuestions(qs as QuizQuestion[]);

    const { data: existing } = await quizClient
      .from('assessment_responses')
      .select('*')
      .eq('invitation_id', invitation!.id)
      .eq('assessment_id', assessmentId);

    if (existing && existing.length > 0) {
      const ansMap: Record<string, any> = {};
      existing.forEach((r) => { ansMap[r.question_id] = r.answer; });
      setAnswers(ansMap);

      // Resume at first unanswered question; fall back to last answered if all done
      if (qs) {
        const firstUnanswered = qs.findIndex((q) => !ansMap[q.id]);
        setCurrentQ(firstUnanswered === -1 ? qs.length - 1 : firstUnanswered);
      }
    }

    const invAss = invAssessments.find((a) => a.assessment_id === assessmentId);
    if (invAss && invAss.individual_status === 'pending') {
      await quizClient
        .from('invitation_assessments')
        .update({ individual_status: 'in_progress' })
        .eq('id', invAss.id);

      // Queue aXcelerate contact note when quiz is first started
      const assessmentType = (invAss as any).assessment?.type;
      const eventType =
        assessmentType === 'lln' ? 'lln_assessment_opened' :
        assessmentType === 'digital' ? 'digital_assessment_opened' :
        null;
      if (eventType && invitation) {
        await quizClient.from('axcelerate_writeback_queue').upsert(
          {
            invitation_id: invitation.id,
            event_type: eventType,
            status: 'pending',
            idempotency_key: `${invitation.id}:${eventType}`,
            extra_data: { opened_at: new Date().toISOString() },
          },
          { onConflict: 'idempotency_key', ignoreDuplicates: true },
        );
      }
    }

    if (invitation && invitation.status === 'opened') {
      await quizClient
        .from('assessment_invitations')
        .update({ status: 'in_progress', started_at: new Date().toISOString() })
        .eq('id', invitation.id);
    }
  }, [invitation, invAssessments, token]);

  async function saveAnswer(questionId: string, answer: any) {
    const newAnswers = { ...answers, [questionId]: answer };
    setAnswers(newAnswers);

    const q = questions.find((q) => q.id === questionId);
    if (!q || !invitation || !activeAssessmentId) return;

    const { data: existing } = await quizClient
      .from('assessment_responses')
      .select('id')
      .eq('invitation_id', invitation.id)
      .eq('question_id', questionId)
      .maybeSingle();

    if (existing) {
      await quizClient
        .from('assessment_responses')
        .update({ answer, submitted_at: new Date().toISOString() })
        .eq('id', existing.id);
    } else {
      await quizClient.from('assessment_responses').insert({
        invitation_id: invitation.id,
        assessment_id: activeAssessmentId,
        question_id: questionId,
        question_version: q.version,
        answer,
      });
    }

    const progress = Math.round((Object.keys(newAnswers).length / questions.length) * 100);
    await quizClient
      .from('assessment_invitations')
      .update({ progress_percent: progress })
      .eq('id', invitation.id);
  }

  async function submitAssessment() {
    if (!invitation || !activeAssessmentId || !questions.length) return;
    setSubmitting(true);

    const score = Math.round((Object.keys(answers).length / questions.length) * 100);
    const passed = score >= (invAssessments.find((a) => a.assessment_id === activeAssessmentId)?.assessment?.pass_threshold || 50);

    const acsfOutcomes: Record<string, number> = {};
    const domainCounts: Record<string, number> = {};
    questions.forEach((q) => {
      if (answers[q.id]) {
        if (!domainCounts[q.domain]) domainCounts[q.domain] = 0;
        domainCounts[q.domain]++;
      }
    });
    Object.entries(domainCounts).forEach(([domain, count]) => {
      const total = questions.filter((q) => q.domain === domain).length;
      const pct = total > 0 ? (count / total) * 100 : 0;
      acsfOutcomes[domain] = pct >= 80 ? 4 : pct >= 60 ? 3 : pct >= 40 ? 2 : 1;
    });

    const invAss = invAssessments.find((a) => a.assessment_id === activeAssessmentId);
    if (invAss) {
      await quizClient
        .from('invitation_assessments')
        .update({
          individual_status: 'completed',
          individual_score: score,
          individual_passed: passed,
          individual_completed_at: new Date().toISOString(),
          acsf_outcomes: acsfOutcomes,
        })
        .eq('id', invAss.id);
    }

    setCompletedAssessmentIds((prev) => new Set([...prev, activeAssessmentId]));

    // Queue aXcelerate contact note for quiz completion
    const completedInvAss = invAssessments.find((a) => a.assessment_id === activeAssessmentId);
    const completedType = (completedInvAss as any)?.assessment?.type;
    const completionEvent =
      completedType === 'lln' ? 'lln_assessment_completed' :
      completedType === 'digital' ? 'digital_assessment_completed' :
      null;
    if (completionEvent && invitation) {
      await quizClient.from('axcelerate_writeback_queue').upsert(
        {
          invitation_id: invitation.id,
          assessment_id: activeAssessmentId,
          event_type: completionEvent,
          status: 'pending',
          idempotency_key: `${invitation.id}:${activeAssessmentId}:${completionEvent}`,
          extra_data: { completed_at: new Date().toISOString(), score, passed, acsf_outcomes: acsfOutcomes },
        },
        { onConflict: 'idempotency_key', ignoreDuplicates: true },
      );
    }

    setSubmitting(false);
    setShowResults(true);
  }

  async function verifyIdentity() {
    if (!invitation || !identityForm.name || !identityForm.dob) return;
    await quizClient
      .from('assessment_invitations')
      .update({
        identity_verified: true,
        identity_verification_method: 'name_and_dob',
        identity_verified_at: new Date().toISOString(),
      })
      .eq('id', invitation.id);
    setIdentityVerified(true);
  }

  if (loading) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-slate-50">
        <div className="text-slate-400">Loading assessment...</div>
      </div>
    );
  }

  if (!invitation) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-slate-50">
        <div className="text-center">
          <div className="text-2xl font-bold text-slate-900 mb-2">Invalid Assessment Link</div>
          <div className="text-slate-500">This assessment link is not valid or has expired.</div>
        </div>
      </div>
    );
  }

  if (!identityVerified) {
    return (
      <div className="min-h-screen bg-slate-50 flex items-center justify-center p-4">
        <div className="card p-8 max-w-md w-full">
          <div className="flex items-center gap-3 mb-6">
            <div className="w-11 h-11 bg-primary-600 rounded-xl flex items-center justify-center">
              <UserCheck className="w-6 h-6 text-white" />
            </div>
            <div>
              <h1 className="text-xl font-bold text-slate-900">Identity Verification</h1>
              <p className="text-sm text-slate-500">Required before starting your assessment</p>
            </div>
          </div>
          <div className="space-y-4">
            <div>
              <label className="label">Full Name</label>
              <input
                className="input"
                value={identityForm.name}
                onChange={(e) => setIdentityForm({ ...identityForm, name: e.target.value })}
                placeholder="Enter your full name"
              />
            </div>
            <div>
              <label className="label">Date of Birth</label>
              <input
                type="date"
                className="input"
                value={identityForm.dob}
                onChange={(e) => setIdentityForm({ ...identityForm, dob: e.target.value })}
              />
            </div>
            <button onClick={verifyIdentity} className="btn-primary w-full">
              Verify Identity
            </button>
          </div>
        </div>
      </div>
    );
  }

  if (activeAssessmentId && !showResults) {
    const q = questions[currentQ];
    const assessment = invAssessments.find((a) => a.assessment_id === activeAssessmentId)?.assessment;
    const progress = questions.length > 0 ? ((currentQ + 1) / questions.length) * 100 : 0;

    return (
      <div className="min-h-screen bg-slate-50">
        <div className="max-w-3xl mx-auto p-4 lg:p-8">
          <div className="flex items-center justify-between mb-6">
            <div className="flex items-center gap-3">
              <div className="w-10 h-10 bg-primary-600 rounded-lg flex items-center justify-center">
                <GraduationCap className="w-5 h-5 text-white" />
              </div>
              <div>
                <div className="font-semibold text-slate-900">{assessment?.title}</div>
                <div className="text-sm text-slate-500">{invitation.candidate_name}</div>
              </div>
            </div>
            <div className="text-sm text-slate-500">
              Question {currentQ + 1} of {questions.length}
            </div>
          </div>

          <div className="h-2 bg-slate-200 rounded-full overflow-hidden mb-6">
            <div className="h-full bg-primary-600 rounded-full transition-all duration-300" style={{ width: `${progress}%` }} />
          </div>

          {q && (
            <div className="card p-6 lg:p-8 animate-slide-up">
              <div className="flex items-center gap-2 mb-4">
                <span className="badge bg-primary-50 text-primary-700">{DOMAIN_LABELS[q.domain]}</span>
                <span className="badge bg-slate-100 text-slate-600">{q.acsf_skill}</span>
                <span className="badge bg-slate-100 text-slate-600">ACSF Level {q.acsf_level_target}</span>
              </div>
              <h2 className="text-lg font-semibold text-slate-900 mb-6">{q.question_text}</h2>

              {q.question_type === 'multiple_choice' && (
                <div className="space-y-2">
                  {q.options.map((opt, i) => (
                    <button
                      key={i}
                      onClick={() => saveAnswer(q.id, opt)}
                      className={`w-full text-left px-4 py-3 rounded-lg border transition-all ${
                        answers[q.id] === opt
                          ? 'border-primary-500 bg-primary-50 text-primary-900'
                          : 'border-slate-200 hover:border-slate-300 hover:bg-slate-50'
                      }`}
                    >
                      <div className="flex items-center gap-3">
                        {answers[q.id] === opt ? (
                          <CheckCircle2 className="w-5 h-5 text-primary-600 shrink-0" />
                        ) : (
                          <Circle className="w-5 h-5 text-slate-300 shrink-0" />
                        )}
                        <span className="text-sm">{opt}</span>
                      </div>
                    </button>
                  ))}
                </div>
              )}

              {q.question_type === 'short_answer' && (
                <textarea
                  className="input min-h-[120px]"
                  value={answers[q.id] || ''}
                  onChange={(e) => saveAnswer(q.id, e.target.value)}
                  placeholder="Type your answer here..."
                />
              )}

              {q.question_type === 'scale' && (
                <div className="flex gap-2">
                  {q.options.map((opt, i) => (
                    <button
                      key={i}
                      onClick={() => saveAnswer(q.id, opt)}
                      className={`flex-1 py-3 rounded-lg border text-sm font-medium transition-all ${
                        answers[q.id] === opt
                          ? 'border-primary-500 bg-primary-50 text-primary-700'
                          : 'border-slate-200 hover:border-slate-300'
                      }`}
                    >
                      {opt}
                    </button>
                  ))}
                </div>
              )}

              <div className="flex items-center justify-between mt-8">
                <button
                  onClick={() => setCurrentQ(Math.max(0, currentQ - 1))}
                  disabled={currentQ === 0}
                  className="btn-secondary"
                >
                  <ArrowLeft className="w-4 h-4" /> Previous
                </button>
                {currentQ < questions.length - 1 ? (
                  <button onClick={() => setCurrentQ(currentQ + 1)} className="btn-primary">
                    Next <ArrowRight className="w-4 h-4" />
                  </button>
                ) : (
                  <button onClick={submitAssessment} disabled={submitting} className="btn-primary">
                    {submitting ? 'Submitting...' : 'Submit Assessment'}
                  </button>
                )}
              </div>
            </div>
          )}
        </div>
      </div>
    );
  }

  if (activeAssessmentId && showResults) {
    const invAss = invAssessments.find((a) => a.assessment_id === activeAssessmentId);
    const assessment = invAss?.assessment;
    return (
      <div className="min-h-screen bg-slate-50 flex items-center justify-center p-4">
        <div className="card p-8 max-w-lg w-full text-center">
          <div className={`w-16 h-16 rounded-full mx-auto mb-4 flex items-center justify-center ${invAss?.individual_passed ? 'bg-emerald-100' : 'bg-amber-100'}`}>
            <Award className={`w-8 h-8 ${invAss?.individual_passed ? 'text-emerald-600' : 'text-amber-600'}`} />
          </div>
          <h2 className="text-2xl font-bold text-slate-900 mb-2">Assessment Complete</h2>
          <p className="text-slate-500 mb-6">{assessment?.title}</p>
          <div className="grid grid-cols-2 gap-4 mb-6">
            <div className="bg-slate-50 rounded-lg p-4">
              <div className="text-3xl font-bold text-slate-900">{invAss?.individual_score}%</div>
              <div className="text-sm text-slate-500">Score</div>
            </div>
            <div className="bg-slate-50 rounded-lg p-4">
              <div className={`text-3xl font-bold ${invAss?.individual_passed ? 'text-emerald-600' : 'text-amber-600'}`}>
                {invAss?.individual_passed ? 'Passed' : 'Below threshold'}
              </div>
              <div className="text-sm text-slate-500">Result</div>
            </div>
          </div>
          {invAss?.acsf_outcomes && (
            <div className="mb-6">
              <div className="text-sm font-medium text-slate-700 mb-2">ACSF Level Outcomes</div>
              <div className="flex justify-center gap-2 flex-wrap">
                {Object.entries(invAss.acsf_outcomes).map(([domain, level]) => {
                  const Icon = DOMAIN_ICONS[domain as Domain] || BookOpen;
                  return (
                    <div key={domain} className="flex items-center gap-1.5 bg-slate-50 rounded-lg px-3 py-2">
                      <Icon className="w-4 h-4 text-slate-400" />
                      <span className="text-sm text-slate-600">{DOMAIN_LABELS[domain as Domain] || domain}:</span>
                      <span className="text-sm font-semibold text-slate-900">Level {level}</span>
                    </div>
                  );
                })}
              </div>
            </div>
          )}
          <button
            onClick={() => { setActiveAssessmentId(null); setShowResults(false); }}
            className="btn-primary w-full"
          >
            Return to Assessments
          </button>
        </div>
      </div>
    );
  }

  const allCompleted = invAssessments.length > 0 && invAssessments.every((a) => a.individual_status === 'completed');
  return (
    <div className="min-h-screen bg-slate-50">
      <div className="max-w-3xl mx-auto p-4 lg:p-8">
        <div className="flex items-center gap-3 mb-8">
          <div className="w-11 h-11 bg-primary-600 rounded-xl flex items-center justify-center">
            <GraduationCap className="w-6 h-6 text-white" />
          </div>
          <div>
            <h1 className="text-xl font-bold text-slate-900">Welcome, {invitation.candidate_name}</h1>
            <p className="text-sm text-slate-500">Complete the following assessments at your own pace</p>
          </div>
        </div>

        {allCompleted && (
          <div className="card p-6 mb-6 bg-emerald-50 border-emerald-200">
            <div className="flex items-center gap-3">
              <CheckCircle2 className="w-6 h-6 text-emerald-600" />
              <div>
                <div className="font-semibold text-emerald-900">All assessments completed</div>
                <div className="text-sm text-emerald-700">Your results have been submitted for review.</div>
              </div>
            </div>
          </div>
        )}

        <div className="space-y-4">
          {invAssessments.map((invAss) => {
            const assessment = invAss.assessment;
            const isCompleted = completedAssessmentIds.has(assessment.id);
            const Icon = assessment.type === 'lln' ? BookOpen : Monitor;
            return (
              <div key={invAss.id} className="card p-6">
                <div className="flex items-start justify-between">
                  <div className="flex items-start gap-4">
                    <div className={`w-12 h-12 rounded-xl flex items-center justify-center ${assessment.type === 'lln' ? 'bg-primary-50' : 'bg-accent-50'}`}>
                      <Icon className={`w-6 h-6 ${assessment.type === 'lln' ? 'text-primary-600' : 'text-accent-600'}`} />
                    </div>
                    <div>
                      <h3 className="font-semibold text-slate-900">{assessment.title}</h3>
                      <p className="text-sm text-slate-500 mt-0.5">{assessment.description}</p>
                      <div className="flex items-center gap-3 mt-2">
                        <span className="text-xs text-slate-400">{assessment.total_questions} questions</span>
                        {isCompleted ? (
                          <span className="badge bg-emerald-100 text-emerald-700">
                            <CheckCircle2 className="w-3 h-3" /> Completed
                          </span>
                        ) : invAss.individual_status === 'in_progress' ? (
                          <span className="badge bg-amber-100 text-amber-700">
                            <Clock className="w-3 h-3" /> In Progress
                          </span>
                        ) : (
                          <span className="badge bg-slate-100 text-slate-600">Not started</span>
                        )}
                      </div>
                    </div>
                  </div>
                  {!isCompleted && (
                    <button
                      onClick={() => startAssessment(assessment.id)}
                      className="btn-primary shrink-0"
                    >
                      {invAss.individual_status === 'in_progress' ? 'Continue' : 'Start'} <ArrowRight className="w-4 h-4" />
                    </button>
                  )}
                </div>
                {isCompleted && invAss.individual_score != null && (
                  <div className="mt-4 pt-4 border-t border-slate-100 flex items-center gap-4">
                    <span className="text-sm text-slate-500">Score: <span className="font-semibold text-slate-900">{invAss.individual_score}%</span></span>
                    <span className={`text-sm font-medium ${invAss.individual_passed ? 'text-emerald-600' : 'text-amber-600'}`}>
                      {invAss.individual_passed ? 'Passed' : 'Below threshold'}
                    </span>
                  </div>
                )}
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}
