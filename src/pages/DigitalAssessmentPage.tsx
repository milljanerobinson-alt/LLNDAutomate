import { useEffect, useState, useRef } from 'react';
import {
  Monitor, CheckCircle2, Circle, ArrowRight, Clock,
  Shield, Search, Cpu, MessageSquare, Lightbulb, Loader2, ChevronRight,
} from 'lucide-react';
import { createQuizClient } from '../lib/supabase';
import type { AssessmentInvitation } from '../lib/types';
import { AssessmentDeclarationScreen } from '../components/AssessmentDeclarationScreen';
import {
  DIGITAL_DOMAIN_LABELS, type DigitalDomain, type DigitalQuestion,
} from '../lib/questions/digitalQuestions';
import { logAuditAnon } from '../lib/audit';

const PROCESSING_MESSAGES = [
  'Analysing your responses…',
  'Evaluating digital capability…',
  'Generating trainer recommendations…',
  'Preparing your results…',
  'Finalising submission…',
];

const DOMAIN_ORDER: DigitalDomain[] = [
  'basic_skills',
  'communication',
  'information_literacy',
  'online_safety',
  'problem_solving',
];

const DOMAIN_ICONS: Record<DigitalDomain, typeof Monitor> = {
  basic_skills: Cpu,
  communication: MessageSquare,
  information_literacy: Search,
  online_safety: Shield,
  problem_solving: Lightbulb,
};

const DOMAIN_COLORS: Record<DigitalDomain, { bg: string; icon: string }> = {
  basic_skills: { bg: 'bg-blue-50', icon: 'text-blue-600' },
  communication: { bg: 'bg-emerald-50', icon: 'text-emerald-600' },
  information_literacy: { bg: 'bg-amber-50', icon: 'text-amber-600' },
  online_safety: { bg: 'bg-rose-50', icon: 'text-rose-600' },
  problem_solving: { bg: 'bg-violet-50', icon: 'text-violet-600' },
};

type Phase = 'loading' | 'invalid' | 'welcome' | 'declaration' | 'question' | 'processing' | 'done';

function ProgressBar({ value }: { value: number }) {
  return (
    <div className="h-2 bg-slate-100 rounded-full overflow-hidden">
      <div
        className="h-full bg-blue-500 rounded-full transition-all duration-500 ease-out"
        style={{ width: `${value}%` }}
      />
    </div>
  );
}

export function DigitalAssessmentPage({ token }: { token: string }) {
  const [phase, setPhase] = useState<Phase>('loading');
  const [invitation, setInvitation] = useState<AssessmentInvitation | null>(null);
  const [rtoName, setRtoName] = useState<string>('Your Training Provider');
  const [assessmentId, setAssessmentId] = useState<string | null>(null);
  const [invAssessmentId, setInvAssessmentId] = useState<string | null>(null);
  const [dbQuestions, setDbQuestions] = useState<DigitalQuestion[]>([]);
  const [currentQIdx, setCurrentQIdx] = useState(0);
  const [selectedAnswer, setSelectedAnswer] = useState<string | null>(null);
  const [answerSubmitted, setAnswerSubmitted] = useState(false);
  const [score, setScore] = useState(0);
  const [processingMsgIdx, setProcessingMsgIdx] = useState(0);
  const processingIntervalRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const quizClient = createQuizClient(token);
  const currentQuestion = dbQuestions[currentQIdx] ?? null;
  const totalQuestions = dbQuestions.length;
  const progress = totalQuestions > 0 ? Math.round((currentQIdx / totalQuestions) * 100) : 0;

  const currentDomain = currentQuestion?.domain ?? 'basic_skills';
  const domainColors = DOMAIN_COLORS[currentDomain];
  const DomainIcon = DOMAIN_ICONS[currentDomain];

  useEffect(() => {
    loadInvitation();
    return () => {
      if (processingIntervalRef.current) clearInterval(processingIntervalRef.current);
    };
  }, [token]);

  async function loadInvitation() {
    const { data: inv } = await quizClient
      .from('assessment_invitations')
      .select('*')
      .eq('digital_token', token)
      .maybeSingle();

    if (!inv) {
      setPhase('invalid');
      return;
    }

    setInvitation(inv as AssessmentInvitation);
    const anyInv = inv as any;
    if (anyInv.rto_name) setRtoName(anyInv.rto_name);

    if (anyInv.digital_status === 'completed') {
      setPhase('done');
      return;
    }

    const resumePhase = await loadAssessmentQuestions(inv.id);

    if (inv.status === 'sent' && !inv.opened_at) {
      await quizClient
        .from('assessment_invitations')
        .update({ status: 'opened', opened_at: new Date().toISOString() })
        .eq('id', inv.id);
    }

    setPhase(resumePhase ?? 'welcome');
  }

  // Returns 'question' if prior progress was found and state restored, null otherwise
  async function loadAssessmentQuestions(invitationId: string): Promise<'question' | null> {
    const { data: iaRows } = await quizClient
      .from('invitation_assessments')
      .select('id, assessment_id, assessments(id, type, status)')
      .eq('invitation_id', invitationId) as any;

    let asmtId: string | null = null;
    let iaId: string | null = null;

    if (iaRows && iaRows.length > 0) {
      const digitalRow = iaRows.find((r: any) => r.assessments?.type === 'digital');
      if (digitalRow) {
        asmtId = digitalRow.assessment_id;
        iaId = digitalRow.id;
      }
    }

    if (!asmtId) {
      const { data: asmtData } = await quizClient
        .from('assessments')
        .select('id')
        .eq('type', 'digital')
        .eq('status', 'active')
        .limit(1)
        .maybeSingle();
      asmtId = asmtData?.id ?? null;
    }

    if (!asmtId) return null;

    setAssessmentId(asmtId);
    if (iaId) setInvAssessmentId(iaId);

    const { data: questions } = await quizClient
      .from('assessment_questions')
      .select('id, question_text, acsf_skill, options, correct_answer')
      .eq('assessment_id', asmtId)
      .order('order_index');

    if (!questions) return null;

    const mapped: DigitalQuestion[] = questions.map((q: any) => {
      const opts: string[] = Array.isArray(q.options)
        ? q.options
        : (typeof q.options === 'string' ? JSON.parse(q.options) : []);
      const correctAnswer: string = typeof q.correct_answer === 'string'
        ? q.correct_answer
        : JSON.stringify(q.correct_answer);
      const domain = q.acsf_skill as DigitalDomain;

      return {
        id: q.id,
        domain,
        domainLabel: DIGITAL_DOMAIN_LABELS[domain] ?? domain,
        text: q.question_text,
        options: opts,
        correctAnswer,
      };
    });

    setDbQuestions(mapped);

    // Load prior responses and resume from the next unanswered question
    const { data: priorResponses } = await quizClient
      .from('assessment_responses')
      .select('question_id, answer, submitted_at')
      .eq('invitation_id', invitationId)
      .eq('assessment_id', asmtId)
      .order('submitted_at', { ascending: true });

    if (!priorResponses || priorResponses.length === 0) return null;

    const answeredIds = new Set<string>();
    let resumeScore = 0;
    for (const r of priorResponses) {
      if (!answeredIds.has(r.question_id)) {
        answeredIds.add(r.question_id);
        const q = mapped.find((mq) => mq.id === r.question_id);
        if (q && r.answer === q.correctAnswer) resumeScore++;
      }
    }

    const resumeIdx = mapped.findIndex((q) => !answeredIds.has(q.id));
    if (resumeIdx <= 0) return null;

    setCurrentQIdx(resumeIdx);
    setScore(resumeScore);
    return 'question';
  }

  async function startAssessment() {
    if (!invitation) return;
    await quizClient
      .from('assessment_invitations')
      .update({
        status: 'in_progress',
        started_at: new Date().toISOString(),
        digital_status: 'in_progress',
      } as any)
      .eq('id', invitation.id);

    // Queue aXcelerate note for Digital quiz opened (idempotent — only fires once per invitation)
    await quizClient.from('axcelerate_writeback_queue').upsert(
      {
        invitation_id: invitation.id,
        event_type: 'digital_assessment_opened',
        status: 'pending',
        idempotency_key: `${invitation.id}:digital_assessment_opened`,
        extra_data: { opened_at: new Date().toISOString() },
      },
      { onConflict: 'idempotency_key', ignoreDuplicates: true },
    );

    logAuditAnon({
      event_type: 'digital_assessment.started',
      category: 'student_activity',
      description: `${invitation.candidate_name} started the Digital assessment`,
      source: 'student',
      invitation_id: invitation.id,
      assessment_id: assessmentId,
    }, token);

    setCurrentQIdx(0);
    setSelectedAnswer(null);
    setAnswerSubmitted(false);
    setPhase('question');
  }

  async function handleAnswer(answer: string) {
    if (answerSubmitted || !currentQuestion || !invitation) return;
    setSelectedAnswer(answer);
    setAnswerSubmitted(true);

    const correct = answer === currentQuestion.correctAnswer;
    if (correct) setScore((prev) => prev + 1);

    if (assessmentId) {
      await quizClient.from('assessment_responses').insert({
        invitation_id: invitation.id,
        assessment_id: assessmentId,
        question_id: currentQuestion.id,
        question_version: '1.0.0',
        answer: answer,
        submitted_at: new Date().toISOString(),
      } as any);
    }

    setTimeout(() => {
      if (currentQIdx >= totalQuestions - 1) {
        handleSubmit(correct ? score + 1 : score);
      } else {
        setCurrentQIdx((prev) => prev + 1);
        setSelectedAnswer(null);
        setAnswerSubmitted(false);
      }
    }, 800);
  }

  async function handleSubmit(finalScore: number) {
    if (!invitation) return;
    setPhase('processing');
    setProcessingMsgIdx(0);

    processingIntervalRef.current = setInterval(() => {
      setProcessingMsgIdx((prev) => Math.min(prev + 1, PROCESSING_MESSAGES.length - 1));
    }, 700);

    const pct = totalQuestions > 0 ? Math.round((finalScore / totalQuestions) * 100) : 0;

    await quizClient
      .from('assessment_invitations')
      .update({
        digital_status: 'completed',
        digital_score: pct,
        digital_completed_at: new Date().toISOString(),
        status: 'completed',
        completed_at: new Date().toISOString(),
        progress_percent: 100,
      } as any)
      .eq('id', invitation.id);

    if (invAssessmentId) {
      await quizClient
        .from('invitation_assessments')
        .update({
          individual_status: 'completed',
          individual_score: pct,
          individual_passed: pct >= 50,
          individual_completed_at: new Date().toISOString(),
        })
        .eq('id', invAssessmentId);
    }

    logAuditAnon({
      event_type: 'digital_assessment.completed',
      category: 'student_activity',
      description: `${invitation.candidate_name} completed the Digital assessment — score ${pct}%`,
      source: 'student',
      invitation_id: invitation.id,
      assessment_id: assessmentId,
      new_values: { score_percent: pct, passed: pct >= 50 },
    }, token);

    // Fire automation chain — non-blocking, never delays the student's "done" screen
    fetch(`${import.meta.env.VITE_SUPABASE_URL}/functions/v1/on-assessment-complete`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Apikey': import.meta.env.VITE_SUPABASE_ANON_KEY,
      },
      body: JSON.stringify({ invitation_id: invitation.id, token }),
    }).catch(() => { /* non-fatal */ });

    setTimeout(() => {
      if (processingIntervalRef.current) clearInterval(processingIntervalRef.current);
      setPhase('done');
    }, 3500);
  }

  // ─── LOADING ────────────────────────────────────────────────────────────────
  if (phase === 'loading') {
    return (
      <div className="min-h-screen bg-gradient-to-br from-slate-50 to-blue-50 flex items-center justify-center">
        <div className="flex flex-col items-center gap-3">
          <div className="w-12 h-12 rounded-2xl bg-blue-600 flex items-center justify-center animate-pulse">
            <Monitor className="w-6 h-6 text-white" />
          </div>
          <p className="text-slate-500 text-sm">Loading your assessment…</p>
        </div>
      </div>
    );
  }

  // ─── INVALID ────────────────────────────────────────────────────────────────
  if (phase === 'invalid') {
    return (
      <div className="min-h-screen bg-gradient-to-br from-slate-50 to-blue-50 flex items-center justify-center p-4">
        <div className="bg-white rounded-2xl shadow-sm border border-slate-200 p-10 max-w-md w-full text-center">
          <div className="w-16 h-16 rounded-2xl bg-slate-100 flex items-center justify-center mx-auto mb-4">
            <Monitor className="w-8 h-8 text-slate-400" />
          </div>
          <h1 className="text-xl font-bold text-slate-900 mb-2">Link Not Found</h1>
          <p className="text-slate-500 text-sm leading-relaxed">
            This assessment link is not valid or may have expired. Please contact your trainer for a new link.
          </p>
        </div>
      </div>
    );
  }

  // ─── DONE ───────────────────────────────────────────────────────────────────
  if (phase === 'done') {
    const portalLink = invitation ? `#/student/${invitation.unique_token}` : null;
    return (
      <div className="min-h-screen bg-gradient-to-br from-slate-50 to-blue-50 flex items-center justify-center p-4">
        <div className="bg-white rounded-2xl shadow-sm border border-slate-200 p-8 max-w-md w-full text-center">
          <div className="w-20 h-20 rounded-full bg-emerald-100 flex items-center justify-center mx-auto mb-6">
            <CheckCircle2 className="w-10 h-10 text-emerald-600" />
          </div>
          <h1 className="text-2xl font-bold text-slate-900 mb-2">Assessment Complete</h1>
          <p className="text-slate-500 text-base leading-relaxed mb-6">
            Your Digital Capability Assessment has been successfully submitted. Your trainer will review your results and be in touch with any next steps.
          </p>
          <div className="bg-slate-50 rounded-xl p-4 text-left mb-6">
            <p className="text-xs font-semibold text-slate-500 uppercase tracking-wide mb-3">Areas Covered</p>
            <div className="space-y-2">
              {DOMAIN_ORDER.map((d) => {
                const Icon = DOMAIN_ICONS[d];
                const colors = DOMAIN_COLORS[d];
                return (
                  <div key={d} className="flex items-center gap-2.5">
                    <div className={`w-6 h-6 rounded-md ${colors.bg} flex items-center justify-center shrink-0`}>
                      <Icon className={`w-3 h-3 ${colors.icon}`} />
                    </div>
                    <span className="text-sm text-slate-600">{DIGITAL_DOMAIN_LABELS[d]}</span>
                    <CheckCircle2 className="w-3.5 h-3.5 text-emerald-500 ml-auto" />
                  </div>
                );
              })}
            </div>
          </div>
          {portalLink && (
            <button
              onClick={() => { window.location.hash = portalLink; }}
              className="w-full bg-blue-600 hover:bg-blue-700 text-white font-semibold rounded-xl py-3.5 transition-all duration-200 active:scale-[0.98] flex items-center justify-center gap-2 shadow-sm shadow-blue-200 mb-3"
            >
              <ArrowRight className="w-4 h-4" />
              Return to Assessment Overview
            </button>
          )}
          <p className="text-xs text-slate-400">
            Thank you for completing your assessment.
          </p>
        </div>
      </div>
    );
  }

  // ─── PROCESSING ─────────────────────────────────────────────────────────────
  if (phase === 'processing') {
    return (
      <div className="min-h-screen bg-gradient-to-br from-slate-50 to-blue-50 flex items-center justify-center p-4">
        <div className="bg-white rounded-2xl shadow-sm border border-slate-200 p-10 max-w-md w-full text-center">
          <div className="w-16 h-16 rounded-2xl bg-blue-600 flex items-center justify-center mx-auto mb-6">
            <Loader2 className="w-8 h-8 text-white animate-spin" />
          </div>
          <h2 className="text-xl font-bold text-slate-900 mb-3">Submitting Assessment</h2>
          <p className="text-blue-600 text-sm font-medium h-5 transition-all duration-300">
            {PROCESSING_MESSAGES[processingMsgIdx]}
          </p>
          <div className="mt-6">
            <ProgressBar value={Math.round(((processingMsgIdx + 1) / PROCESSING_MESSAGES.length) * 90)} />
          </div>
        </div>
      </div>
    );
  }

  // ─── WELCOME ────────────────────────────────────────────────────────────────
  if (phase === 'welcome' && invitation) {
    return (
      <div className="min-h-screen bg-gradient-to-br from-slate-50 to-blue-50 flex items-center justify-center p-4">
        <div className="bg-white rounded-2xl shadow-sm border border-slate-200 w-full max-w-lg overflow-hidden">
          <div className="bg-blue-600 px-8 py-8">
            <div className="flex items-center gap-3 mb-6">
              <div className="w-10 h-10 bg-white/20 rounded-xl flex items-center justify-center">
                <Monitor className="w-5 h-5 text-white" />
              </div>
              <span className="text-white/80 text-sm font-medium">{rtoName}</span>
            </div>
            <h1 className="text-2xl font-bold text-white mb-1">Digital Capability Assessment</h1>
            <p className="text-blue-200 text-sm">Workplace Digital Skills</p>
          </div>
          <div className="px-8 py-8">
            <div className="mb-6">
              <p className="text-slate-500 text-xs font-semibold uppercase tracking-wide mb-1">Welcome</p>
              <p className="text-lg font-semibold text-slate-900">{invitation.candidate_name}</p>
            </div>

            <div className="grid grid-cols-2 gap-3 mb-6">
              <div className="bg-slate-50 rounded-xl p-4">
                <Clock className="w-4 h-4 text-slate-400 mb-1.5" />
                <p className="text-xs text-slate-500">Estimated time</p>
                <p className="text-sm font-semibold text-slate-900">15–20 minutes</p>
              </div>
              <div className="bg-slate-50 rounded-xl p-4">
                <Monitor className="w-4 h-4 text-slate-400 mb-1.5" />
                <p className="text-xs text-slate-500">Questions</p>
                <p className="text-sm font-semibold text-slate-900">
                  {totalQuestions > 0 ? `${totalQuestions} questions` : 'Loading…'}
                </p>
              </div>
            </div>

            <div className="bg-blue-50 border border-blue-100 rounded-xl p-4 mb-6">
              <p className="text-sm text-blue-800 leading-relaxed">
                <span className="font-semibold">There is no pass or fail.</span> This assessment helps your trainer understand your digital skills so they can support you better. Answer each question as honestly as you can.
              </p>
            </div>

            <div className="space-y-2 mb-8">
              {DOMAIN_ORDER.map((d) => {
                const Icon = DOMAIN_ICONS[d];
                const colors = DOMAIN_COLORS[d];
                return (
                  <div key={d} className="flex items-center gap-3 py-1">
                    <div className={`w-7 h-7 rounded-lg ${colors.bg} flex items-center justify-center shrink-0`}>
                      <Icon className={`w-3.5 h-3.5 ${colors.icon}`} />
                    </div>
                    <span className="text-sm text-slate-700">{DIGITAL_DOMAIN_LABELS[d]}</span>
                  </div>
                );
              })}
            </div>

            <button
              onClick={() => setPhase('declaration')}
              className="w-full bg-blue-600 hover:bg-blue-700 text-white font-semibold rounded-xl py-4 px-6 transition-all duration-200 active:scale-[0.98] flex items-center justify-center gap-2 text-base shadow-sm shadow-blue-200"
            >
              Start Digital Assessment
              <ArrowRight className="w-5 h-5" />
            </button>
          </div>
        </div>
      </div>
    );
  }

  // ─── DECLARATION ─────────────────────────────────────────────────────────────
  if (phase === 'declaration' && invitation) {
    return (
      <AssessmentDeclarationScreen
        invitationId={invitation.id}
        assessmentType="digital"
        candidateName={(invitation as any).candidate_name ?? ''}
        token={token}
        onAccepted={startAssessment}
      />
    );
  }

  // ─── QUESTION ────────────────────────────────────────────────────────────────
  if (phase === 'question' && currentQuestion && invitation) {
    return (
      <div className="min-h-screen bg-gradient-to-br from-slate-50 to-blue-50">
        {/* Header */}
        <div className="bg-white border-b border-slate-200 sticky top-0 z-10">
          <div className="max-w-2xl mx-auto px-4 sm:px-6 py-3">
            <div className="flex items-center justify-between mb-2">
              <div className="flex items-center gap-2">
                <div className={`w-7 h-7 ${domainColors.bg} rounded-lg flex items-center justify-center`}>
                  <DomainIcon className={`w-3.5 h-3.5 ${domainColors.icon}`} />
                </div>
                <span className="text-sm font-semibold text-slate-700 hidden sm:block">
                  {DIGITAL_DOMAIN_LABELS[currentDomain]}
                </span>
              </div>
              <div className="flex items-center gap-3 text-xs text-slate-400">
                <span>{currentQIdx + 1} of {totalQuestions}</span>
                <div className="flex gap-0.5">
                  {DOMAIN_ORDER.map((d) => {
                    const domainsInOrder = dbQuestions.map(q => q.domain);
                    const lastIdxForDomain = domainsInOrder.lastIndexOf(d);
                    const firstIdxForDomain = domainsInOrder.indexOf(d);
                    const domainDone = currentQIdx > lastIdxForDomain;
                    const domainActive = currentQIdx >= firstIdxForDomain && currentQIdx <= lastIdxForDomain;
                    return (
                      <div
                        key={d}
                        className={`h-1.5 w-4 rounded-full ${
                          domainDone ? 'bg-emerald-400' : domainActive ? 'bg-blue-400' : 'bg-slate-200'
                        }`}
                      />
                    );
                  })}
                </div>
              </div>
            </div>
            <ProgressBar value={progress} />
          </div>
        </div>

        {/* Question */}
        <div className="max-w-2xl mx-auto px-4 sm:px-6 py-8">
          <div className="flex items-center gap-2 mb-4 text-xs text-slate-400">
            <span>Digital Capability Assessment</span>
            <ChevronRight className="w-3 h-3" />
            <span className="text-slate-600 font-medium">{DIGITAL_DOMAIN_LABELS[currentDomain]}</span>
          </div>

          <div className="bg-white rounded-2xl shadow-sm border border-slate-200 p-6 sm:p-8">
            <p className="text-lg sm:text-xl font-semibold text-slate-900 mb-8 leading-relaxed">
              {currentQuestion.text}
            </p>

            <div className="space-y-3">
              {currentQuestion.options.map((opt) => {
                const isSelected = selectedAnswer === opt;
                const isCorrect = opt === currentQuestion.correctAnswer;
                let optClass = 'border-slate-200 hover:border-blue-300 hover:bg-blue-50 cursor-pointer';
                if (answerSubmitted) {
                  if (isCorrect) optClass = 'border-emerald-400 bg-emerald-50 cursor-default';
                  else if (isSelected) optClass = 'border-rose-300 bg-rose-50 cursor-default';
                  else optClass = 'border-slate-200 opacity-50 cursor-default';
                } else if (isSelected) {
                  optClass = 'border-blue-500 bg-blue-50';
                }

                return (
                  <button
                    key={opt}
                    onClick={() => !answerSubmitted && handleAnswer(opt)}
                    disabled={answerSubmitted}
                    className={`w-full text-left px-5 py-4 rounded-xl border-2 transition-all duration-200 ${optClass}`}
                  >
                    <div className="flex items-center gap-3">
                      <div className={`w-5 h-5 rounded-full border-2 flex items-center justify-center shrink-0 transition-all ${
                        answerSubmitted && isCorrect
                          ? 'border-emerald-500 bg-emerald-500'
                          : answerSubmitted && isSelected && !isCorrect
                          ? 'border-rose-400 bg-rose-400'
                          : isSelected
                          ? 'border-blue-500 bg-blue-500'
                          : 'border-slate-300'
                      }`}>
                        {(isSelected || (answerSubmitted && isCorrect)) && (
                          <div className="w-2 h-2 rounded-full bg-white" />
                        )}
                      </div>
                      <span className="text-sm sm:text-base text-slate-800">{opt}</span>
                    </div>
                  </button>
                );
              })}
            </div>

            {answerSubmitted && (
              <div className={`mt-6 px-4 py-3 rounded-xl text-sm font-medium ${
                selectedAnswer === currentQuestion.correctAnswer
                  ? 'bg-emerald-50 text-emerald-700 border border-emerald-200'
                  : 'bg-slate-50 text-slate-600 border border-slate-200'
              }`}>
                {selectedAnswer === currentQuestion.correctAnswer ? (
                  <div className="flex items-center gap-2">
                    <CheckCircle2 className="w-4 h-4 shrink-0" />
                    Well done!
                  </div>
                ) : (
                  <div className="flex items-start gap-2">
                    <Circle className="w-4 h-4 mt-0.5 shrink-0" />
                    <span>The correct answer was: <strong>{currentQuestion.correctAnswer}</strong></span>
                  </div>
                )}
              </div>
            )}
          </div>

          <div className="text-center mt-6 text-xs text-slate-400">
            {invitation.candidate_name} &middot; Digital Capability Assessment &middot; {rtoName}
          </div>
        </div>
      </div>
    );
  }

  return null;
}
