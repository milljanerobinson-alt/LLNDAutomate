import { useEffect, useState, useCallback, useRef } from 'react';
import {
  GraduationCap, CheckCircle2, Circle, ArrowRight, Clock,
  BookOpen, Calculator, PenLine, MessageCircle, Lightbulb,
  ChevronRight, Loader2,
} from 'lucide-react';
import { createQuizClient } from '../lib/supabase';
import type { AssessmentInvitation } from '../lib/types';
import { AssessmentDeclarationScreen } from '../components/AssessmentDeclarationScreen';
import {
  LLN_SECTION_LABELS, LLN_SECTION_DESCRIPTIONS,
  LLN_SECTION_TIMES, type LLNSection, type LLNQuestion,
} from '../lib/questions/llnQuestions';
import { logAuditAnon } from '../lib/audit';

const SECTIONS: LLNSection[] = ['reading', 'numeracy', 'writing', 'oral_communication', 'learning'];

const SECTION_ICONS: Record<LLNSection, typeof BookOpen> = {
  reading: BookOpen,
  numeracy: Calculator,
  writing: PenLine,
  oral_communication: MessageCircle,
  learning: Lightbulb,
};

const SECTION_COLORS: Record<LLNSection, { bg: string; icon: string; badge: string }> = {
  reading: { bg: 'bg-blue-50', icon: 'text-blue-600', badge: 'bg-blue-100 text-blue-700' },
  numeracy: { bg: 'bg-emerald-50', icon: 'text-emerald-600', badge: 'bg-emerald-100 text-emerald-700' },
  writing: { bg: 'bg-violet-50', icon: 'text-violet-600', badge: 'bg-violet-100 text-violet-700' },
  oral_communication: { bg: 'bg-amber-50', icon: 'text-amber-600', badge: 'bg-amber-100 text-amber-700' },
  learning: { bg: 'bg-rose-50', icon: 'text-rose-600', badge: 'bg-rose-100 text-rose-700' },
};

const ENCOURAGEMENT: Record<number, { title: string; body: string }> = {
  1: { title: 'Great work!', body: "You're making excellent progress. Four more sections to go." },
  2: { title: "You're doing wonderfully!", body: 'Three sections remaining. You are more than halfway there.' },
  3: { title: 'Fantastic effort!', body: 'Only two sections remaining. Keep going!' },
  4: { title: 'Almost there!', body: 'Just one section left. You are doing an outstanding job.' },
};

const PROCESSING_MESSAGES = [
  'Analysing responses…',
  'Calculating ACSF levels…',
  'Generating trainer recommendations…',
  'Preparing your results report…',
  'Finalising your assessment…',
];

const MAX_QUESTIONS_PER_SECTION = 8;
const CONFIDENCE_THRESHOLD = 2;

interface SectionState {
  currentLevel: number;
  usedIds: string[];
  history: { questionId: string; correct: boolean; level: number }[];
  consecutiveCorrect: number;
  consecutiveIncorrect: number;
  complete: boolean;
  estimatedLevel: number | null;
}

type Phase =
  | 'loading'
  | 'invalid'
  | 'welcome'
  | 'declaration'
  | 'section_intro'
  | 'question'
  | 'section_complete'
  | 'processing'
  | 'done';

function initSectionState(): SectionState {
  return {
    currentLevel: 3,
    usedIds: [],
    history: [],
    consecutiveCorrect: 0,
    consecutiveIncorrect: 0,
    complete: false,
    estimatedLevel: null,
  };
}

function calculateEstimatedLevel(history: { correct: boolean; level: number }[]): number {
  for (let lvl = 5; lvl >= 1; lvl--) {
    const atLevel = history.filter((h) => h.level === lvl);
    if (atLevel.length === 0) continue;
    const pct = atLevel.filter((h) => h.correct).length / atLevel.length;
    if (pct >= 0.5) return lvl;
  }
  return 1;
}

function getNextQuestion(section: LLNSection, state: SectionState, dbQuestions: LLNQuestion[]): LLNQuestion | null {
  let level = state.currentLevel;
  for (let attempt = 0; attempt < 5; attempt++) {
    const available = dbQuestions.filter(
      (q) => q.section === section && q.level === (level as 1|2|3|4|5) && !state.usedIds.includes(q.id)
    );
    if (available.length > 0) return available[0];
    if (level < 5) level++;
    else if (level > 1) level--;
    else break;
  }
  return null;
}

function processAnswer(
  state: SectionState,
  questionId: string,
  correct: boolean
): SectionState {
  const newHistory = [...state.history, { questionId, correct, level: state.currentLevel }];
  const newUsedIds = [...state.usedIds, questionId];

  let newConsecCorrect = correct ? state.consecutiveCorrect + 1 : 0;
  let newConsecIncorrect = !correct ? state.consecutiveIncorrect + 1 : 0;
  let newLevel = state.currentLevel;

  let complete = false;
  let estimatedLevel: number | null = null;

  if (newHistory.length >= MAX_QUESTIONS_PER_SECTION) {
    complete = true;
    estimatedLevel = calculateEstimatedLevel(newHistory);
  } else if (newConsecCorrect >= CONFIDENCE_THRESHOLD) {
    if (newLevel < 5) {
      newLevel = Math.min(5, newLevel + 1) as 1|2|3|4|5;
      newConsecCorrect = 0;
      newConsecIncorrect = 0;
    } else {
      complete = true;
      estimatedLevel = 5;
    }
  } else if (newConsecIncorrect >= CONFIDENCE_THRESHOLD) {
    complete = true;
    estimatedLevel = calculateEstimatedLevel(newHistory);
  }

  return {
    currentLevel: newLevel,
    usedIds: newUsedIds,
    history: newHistory,
    consecutiveCorrect: newConsecCorrect,
    consecutiveIncorrect: newConsecIncorrect,
    complete,
    estimatedLevel,
  };
}

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

export function LLNAssessmentPage({ token }: { token: string }) {
  const [phase, setPhase] = useState<Phase>('loading');
  const [invitation, setInvitation] = useState<AssessmentInvitation | null>(null);
  const [rtoName, setRtoName] = useState<string>('Your Training Provider');
  const [assessmentId, setAssessmentId] = useState<string | null>(null);
  const [invAssessmentId, setInvAssessmentId] = useState<string | null>(null);
  const [dbQuestions, setDbQuestions] = useState<LLNQuestion[]>([]);
  const [currentSectionIdx, setCurrentSectionIdx] = useState(0);
  const [sectionStates, setSectionStates] = useState<Record<LLNSection, SectionState>>(
    () => Object.fromEntries(SECTIONS.map((s) => [s, initSectionState()])) as Record<LLNSection, SectionState>
  );
  const [currentQuestion, setCurrentQuestion] = useState<LLNQuestion | null>(null);
  const [selectedAnswer, setSelectedAnswer] = useState<string | null>(null);
  const [answerSubmitted, setAnswerSubmitted] = useState(false);
  const [processingMsgIdx, setProcessingMsgIdx] = useState(0);
  const processingIntervalRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const quizClient = createQuizClient(token);

  const currentSection = SECTIONS[currentSectionIdx];
  const completedSections = SECTIONS.filter((_, i) => i < currentSectionIdx);
  const overallProgress = Math.round(
    (SECTIONS.filter((s) => sectionStates[s].complete).length / SECTIONS.length) * 100
  );

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
      .eq('lln_token', token)
      .maybeSingle();

    if (!inv) {
      setPhase('invalid');
      return;
    }

    setInvitation(inv as AssessmentInvitation);
    const anyInv = inv as any;
    if (anyInv.rto_name) setRtoName(anyInv.rto_name);

    if (anyInv.lln_status === 'completed') {
      setPhase('done');
      return;
    }

    // Load assessment + questions from DB; returns the phase to resume to, or null for fresh start
    const resumePhase = await loadAssessmentQuestions(inv.id);

    if (inv.status === 'sent' && !inv.opened_at) {
      await quizClient
        .from('assessment_invitations')
        .update({ status: 'opened', opened_at: new Date().toISOString() })
        .eq('id', inv.id);
    }

    setPhase(resumePhase ?? 'welcome');
  }

  // Returns the phase to resume to, or null if no prior progress
  async function loadAssessmentQuestions(invitationId: string): Promise<'question' | 'section_intro' | null> {
    // First try to find an existing invitation_assessment row for this LLN invitation
    const { data: iaRows } = await quizClient
      .from('invitation_assessments')
      .select('id, assessment_id, assessments(id, type, status)')
      .eq('invitation_id', invitationId) as any;

    let asmtId: string | null = null;
    let iaId: string | null = null;

    if (iaRows && iaRows.length > 0) {
      const llnRow = iaRows.find((r: any) => r.assessments?.type === 'lln');
      if (llnRow) {
        asmtId = llnRow.assessment_id;
        iaId = llnRow.id;
      }
    }

    // Fall back to the active LLN assessment
    if (!asmtId) {
      const { data: asmtData } = await quizClient
        .from('assessments')
        .select('id')
        .eq('type', 'lln')
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
      .select('id, question_text, acsf_skill, acsf_level_target, options, correct_answer')
      .eq('assessment_id', asmtId)
      .order('order_index');

    if (!questions) return null;

    const mapped: LLNQuestion[] = questions.map((q: any) => {
      const opts: string[] = Array.isArray(q.options)
        ? q.options
        : (typeof q.options === 'string' ? JSON.parse(q.options) : []);
      const correctAnswer: string = typeof q.correct_answer === 'string'
        ? q.correct_answer
        : JSON.stringify(q.correct_answer);

      return {
        id: q.id,
        section: q.acsf_skill as LLNSection,
        level: (q.acsf_level_target ?? 3) as 1|2|3|4|5,
        text: q.question_text,
        type: 'multiple_choice' as const,
        options: opts,
        correctAnswer,
      };
    });

    setDbQuestions(mapped);

    // Load prior responses and reconstruct adaptive section states for resume
    const { data: priorResponses } = await quizClient
      .from('assessment_responses')
      .select('question_id, answer, submitted_at')
      .eq('invitation_id', invitationId)
      .eq('assessment_id', asmtId)
      .order('submitted_at', { ascending: true });

    if (!priorResponses || priorResponses.length === 0) return null;

    const qMap = new Map(mapped.map((q) => [q.id, q]));
    const responsesBySection: Record<string, Array<{ questionId: string; answer: string }>> = {};
    SECTIONS.forEach((s) => { responsesBySection[s] = []; });

    for (const r of priorResponses) {
      const q = qMap.get(r.question_id);
      if (q && responsesBySection[q.section]) {
        responsesBySection[q.section].push({ questionId: r.question_id, answer: r.answer });
      }
    }

    // Replay processAnswer for each section to rebuild exact adaptive state
    const restoredStates: Record<LLNSection, SectionState> =
      Object.fromEntries(SECTIONS.map((s) => [s, initSectionState()])) as Record<LLNSection, SectionState>;

    for (const section of SECTIONS) {
      let state = initSectionState();
      for (const r of responsesBySection[section]) {
        const q = qMap.get(r.questionId);
        if (!q) continue;
        state = processAnswer(state, r.questionId, r.answer === q.correctAnswer);
      }
      restoredStates[section] = state;
    }

    setSectionStates(restoredStates);

    const firstIncompleteIdx = SECTIONS.findIndex((s) => !restoredStates[s].complete);
    const resumeIdx = firstIncompleteIdx === -1 ? SECTIONS.length - 1 : firstIncompleteIdx;
    setCurrentSectionIdx(resumeIdx);

    // Try to land on the exact next question rather than the section intro
    const nextQ = getNextQuestion(SECTIONS[resumeIdx], restoredStates[SECTIONS[resumeIdx]], mapped);
    if (nextQ) {
      setCurrentQuestion(nextQ);
      setSelectedAnswer(null);
      setAnswerSubmitted(false);
      return 'question';
    }

    return 'section_intro';
  }

  async function startAssessment() {
    if (!invitation) return;
    await quizClient
      .from('assessment_invitations')
      .update({ status: 'in_progress', started_at: new Date().toISOString(), lln_status: 'in_progress' } as any)
      .eq('id', invitation.id);

    // Queue aXcelerate note for LLN quiz opened (idempotent — only fires once per invitation)
    await quizClient.from('axcelerate_writeback_queue').upsert(
      {
        invitation_id: invitation.id,
        event_type: 'lln_assessment_opened',
        status: 'pending',
        idempotency_key: `${invitation.id}:lln_assessment_opened`,
        extra_data: { opened_at: new Date().toISOString() },
      },
      { onConflict: 'idempotency_key', ignoreDuplicates: true },
    );

    logAuditAnon({
      event_type: 'lln_assessment.started',
      category: 'student_activity',
      description: `${invitation.candidate_name} started the LLN assessment`,
      source: 'student',
      invitation_id: invitation.id,
      assessment_id: assessmentId,
    }, token);

    setCurrentSectionIdx(0);
    setPhase('section_intro');
  }

  function startSection() {
    const question = getNextQuestion(currentSection, sectionStates[currentSection], dbQuestions);
    setCurrentQuestion(question);
    setSelectedAnswer(null);
    setAnswerSubmitted(false);
    setPhase('question');
  }

  async function handleAnswer(answer: string) {
    if (answerSubmitted || !currentQuestion || !invitation) return;
    setSelectedAnswer(answer);
    setAnswerSubmitted(true);

    const correct = answer === currentQuestion.correctAnswer;
    const newState = processAnswer(sectionStates[currentSection], currentQuestion.id, correct);

    const updatedStates = { ...sectionStates, [currentSection]: newState };
    setSectionStates(updatedStates);

    // Write to normalised assessment_responses
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
      if (newState.complete) {
        handleSectionComplete(updatedStates, newState.estimatedLevel);
      } else {
        const nextQ = getNextQuestion(currentSection, newState, dbQuestions);
        setCurrentQuestion(nextQ);
        setSelectedAnswer(null);
        setAnswerSubmitted(false);
      }
    }, 800);
  }

  async function handleSectionComplete(
    states: Record<LLNSection, SectionState>,
    estimatedLevel: number | null
  ) {
    if (!invitation) return;

    const isLastSection = currentSectionIdx === SECTIONS.length - 1;

    if (isLastSection) {
      const outcomes: Record<string, number> = {};
      for (const s of SECTIONS) {
        outcomes[s] = states[s].estimatedLevel ?? 1;
      }
      setPhase('processing');
      startProcessingAnimation();

      // Update invitation
      await quizClient
        .from('assessment_invitations')
        .update({
          lln_status: 'completed',
          lln_acsf_outcomes: outcomes,
          lln_completed_at: new Date().toISOString(),
          status: 'completed',
          completed_at: new Date().toISOString(),
          progress_percent: 100,
        } as any)
        .eq('id', invitation.id);

      // Update invitation_assessments row
      if (invAssessmentId) {
        await quizClient
          .from('invitation_assessments')
          .update({
            individual_status: 'completed',
            individual_completed_at: new Date().toISOString(),
            acsf_outcomes: outcomes,
          })
          .eq('id', invAssessmentId);
      }

      logAuditAnon({
        event_type: 'lln_assessment.completed',
        category: 'student_activity',
        description: `${invitation.candidate_name} completed the LLN assessment`,
        source: 'student',
        invitation_id: invitation.id,
        assessment_id: assessmentId,
        new_values: { acsf_outcomes: outcomes },
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
    } else {
      setPhase('section_complete');
    }
  }

  function startProcessingAnimation() {
    setProcessingMsgIdx(0);
    processingIntervalRef.current = setInterval(() => {
      setProcessingMsgIdx((prev) => Math.min(prev + 1, PROCESSING_MESSAGES.length - 1));
    }, 700);
  }

  function continueToNextSection() {
    const nextIdx = currentSectionIdx + 1;
    setCurrentSectionIdx(nextIdx);
    setPhase('section_intro');
  }

  // ─── LOADING ────────────────────────────────────────────────────────────────
  if (phase === 'loading') {
    return (
      <div className="min-h-screen bg-gradient-to-br from-slate-50 to-blue-50 flex items-center justify-center">
        <div className="flex flex-col items-center gap-3">
          <div className="w-12 h-12 rounded-2xl bg-blue-600 flex items-center justify-center animate-pulse">
            <GraduationCap className="w-6 h-6 text-white" />
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
            <GraduationCap className="w-8 h-8 text-slate-400" />
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
            Your LLN Assessment has been successfully submitted. Your trainer will review your results and be in touch with any next steps.
          </p>
          <div className="bg-slate-50 rounded-xl p-4 text-left mb-6">
            <p className="text-xs font-semibold text-slate-500 uppercase tracking-wide mb-3">Assessment Summary</p>
            <div className="space-y-2">
              {SECTIONS.map((s) => (
                <div key={s} className="flex items-center justify-between">
                  <span className="text-sm text-slate-600">{LLN_SECTION_LABELS[s]}</span>
                  <span className="text-xs font-medium text-emerald-600 flex items-center gap-1">
                    <CheckCircle2 className="w-3.5 h-3.5" /> Completed
                  </span>
                </div>
              ))}
            </div>
          </div>
          {portalLink && (
            <button
              onClick={() => { window.location.hash = portalLink; }}
              className="w-full bg-blue-600 hover:bg-blue-700 text-white font-semibold rounded-xl py-3.5 transition-all duration-200 active:scale-[0.98] flex items-center justify-center gap-2 shadow-sm shadow-blue-200"
            >
              <ArrowRight className="w-4 h-4" />
              Return to Assessment Overview
            </button>
          )}
          <p className="text-xs text-slate-400 mt-4">
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
                <GraduationCap className="w-5 h-5 text-white" />
              </div>
              <span className="text-white/80 text-sm font-medium">{rtoName}</span>
            </div>
            <h1 className="text-2xl font-bold text-white mb-1">LLN Assessment</h1>
            <p className="text-blue-200 text-sm">Language, Literacy, Numeracy &amp; Learning</p>
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
                <p className="text-sm font-semibold text-slate-900">25–45 minutes</p>
              </div>
              <div className="bg-slate-50 rounded-xl p-4">
                <GraduationCap className="w-4 h-4 text-slate-400 mb-1.5" />
                <p className="text-xs text-slate-500">Sections</p>
                <p className="text-sm font-semibold text-slate-900">5 sections</p>
              </div>
            </div>

            <div className="bg-blue-50 border border-blue-100 rounded-xl p-4 mb-6">
              <p className="text-sm text-blue-800 leading-relaxed">
                <span className="font-semibold">There is no pass or fail.</span> This assessment helps your trainer understand your current skills so they can support you better. Just answer each question as honestly as you can.
              </p>
            </div>

            <div className="space-y-2 mb-8">
              {SECTIONS.map((s) => {
                const Icon = SECTION_ICONS[s];
                const colors = SECTION_COLORS[s];
                return (
                  <div key={s} className="flex items-center gap-3 py-1.5">
                    <div className={`w-7 h-7 rounded-lg ${colors.bg} flex items-center justify-center shrink-0`}>
                      <Icon className={`w-3.5 h-3.5 ${colors.icon}`} />
                    </div>
                    <div className="flex-1">
                      <span className="text-sm text-slate-700">{LLN_SECTION_LABELS[s]}</span>
                      <span className="text-xs text-slate-400 ml-2">{LLN_SECTION_TIMES[s]}</span>
                    </div>
                  </div>
                );
              })}
            </div>

            <button
              onClick={() => setPhase('declaration')}
              className="w-full bg-blue-600 hover:bg-blue-700 text-white font-semibold rounded-xl py-4 px-6 transition-all duration-200 active:scale-[0.98] flex items-center justify-center gap-2 text-base shadow-sm shadow-blue-200"
            >
              Start LLN Assessment
              <ArrowRight className="w-5 h-5" />
            </button>
          </div>
        </div>
      </div>
    );
  }

  // ─── SECTION COMPLETE ────────────────────────────────────────────────────────
  if (phase === 'section_complete') {
    const enc = ENCOURAGEMENT[currentSectionIdx + 1] || ENCOURAGEMENT[1];
    const completedCount = currentSectionIdx + 1;
    return (
      <div className="min-h-screen bg-gradient-to-br from-slate-50 to-blue-50 flex items-center justify-center p-4">
        <div className="bg-white rounded-2xl shadow-sm border border-slate-200 p-8 max-w-md w-full text-center">
          <div className="w-16 h-16 rounded-full bg-emerald-100 flex items-center justify-center mx-auto mb-4">
            <CheckCircle2 className="w-8 h-8 text-emerald-600" />
          </div>
          <h2 className="text-xl font-bold text-slate-900 mb-1">{enc.title}</h2>
          <p className="text-slate-500 text-sm mb-6">{enc.body}</p>

          <div className="flex justify-center gap-2 mb-6">
            {SECTIONS.map((s, i) => {
              const done = i <= currentSectionIdx;
              const active = i === currentSectionIdx + 1;
              const Icon = SECTION_ICONS[s];
              return (
                <div
                  key={s}
                  className={`w-9 h-9 rounded-full flex items-center justify-center transition-all ${
                    done
                      ? 'bg-emerald-500'
                      : active
                      ? 'bg-blue-100 ring-2 ring-blue-400'
                      : 'bg-slate-100'
                  }`}
                >
                  {done ? (
                    <CheckCircle2 className="w-4 h-4 text-white" />
                  ) : (
                    <Icon className={`w-4 h-4 ${active ? 'text-blue-600' : 'text-slate-300'}`} />
                  )}
                </div>
              );
            })}
          </div>

          <div className="mb-6">
            <div className="flex justify-between text-xs text-slate-500 mb-2">
              <span>Overall progress</span>
              <span>{completedCount} of {SECTIONS.length} sections</span>
            </div>
            <ProgressBar value={Math.round((completedCount / SECTIONS.length) * 100)} />
          </div>

          <button
            onClick={continueToNextSection}
            className="w-full bg-blue-600 hover:bg-blue-700 text-white font-semibold rounded-xl py-4 transition-all duration-200 active:scale-[0.98] flex items-center justify-center gap-2 shadow-sm shadow-blue-200"
          >
            Continue to {LLN_SECTION_LABELS[SECTIONS[currentSectionIdx + 1]]}
            <ArrowRight className="w-5 h-5" />
          </button>
        </div>
      </div>
    );
  }

  // ─── DECLARATION ─────────────────────────────────────────────────────────────
  if (phase === 'declaration' && invitation) {
    return (
      <AssessmentDeclarationScreen
        invitationId={invitation.id}
        assessmentType="lln"
        candidateName={(invitation as any).candidate_name ?? ''}
        token={token}
        onAccepted={startAssessment}
      />
    );
  }

  // ─── SECTION INTRO ───────────────────────────────────────────────────────────
  if (phase === 'section_intro') {
    const colors = SECTION_COLORS[currentSection];
    const Icon = SECTION_ICONS[currentSection];
    return (
      <div className="min-h-screen bg-gradient-to-br from-slate-50 to-blue-50 flex items-center justify-center p-4">
        <div className="bg-white rounded-2xl shadow-sm border border-slate-200 w-full max-w-lg">
          <div className="px-8 pt-8 pb-6">
            <div className="flex items-center gap-2 mb-6 text-xs text-slate-400">
              <span>LLN Assessment</span>
              <ChevronRight className="w-3 h-3" />
              <span className="text-slate-600 font-medium">{LLN_SECTION_LABELS[currentSection]}</span>
            </div>

            <div className={`w-16 h-16 ${colors.bg} rounded-2xl flex items-center justify-center mb-5`}>
              <Icon className={`w-8 h-8 ${colors.icon}`} />
            </div>

            <h2 className="text-2xl font-bold text-slate-900 mb-2">
              {LLN_SECTION_LABELS[currentSection]}
            </h2>
            <p className="text-slate-500 text-sm leading-relaxed mb-6">
              {LLN_SECTION_DESCRIPTIONS[currentSection]}
            </p>

            <div className="flex items-center gap-4 mb-6 text-sm text-slate-500">
              <div className="flex items-center gap-1.5">
                <Clock className="w-4 h-4 text-slate-400" />
                {LLN_SECTION_TIMES[currentSection]}
              </div>
            </div>

            <div className="mb-8">
              <div className="flex justify-between text-xs text-slate-500 mb-2">
                <span>Overall progress</span>
                <span>{currentSectionIdx} of {SECTIONS.length} sections complete</span>
              </div>
              <ProgressBar value={Math.round((currentSectionIdx / SECTIONS.length) * 100)} />
              <div className="flex gap-1.5 mt-2">
                {SECTIONS.map((s, i) => (
                  <div
                    key={s}
                    className={`h-1 flex-1 rounded-full transition-all ${
                      i < currentSectionIdx
                        ? 'bg-emerald-400'
                        : i === currentSectionIdx
                        ? 'bg-blue-400'
                        : 'bg-slate-100'
                    }`}
                  />
                ))}
              </div>
            </div>
          </div>

          <div className="px-8 pb-8">
            <button
              onClick={startSection}
              className="w-full bg-blue-600 hover:bg-blue-700 text-white font-semibold rounded-xl py-4 transition-all duration-200 active:scale-[0.98] flex items-center justify-center gap-2 shadow-sm shadow-blue-200"
            >
              Start {LLN_SECTION_LABELS[currentSection]}
              <ArrowRight className="w-5 h-5" />
            </button>
          </div>
        </div>
      </div>
    );
  }

  // ─── QUESTION ────────────────────────────────────────────────────────────────
  if (phase === 'question' && currentQuestion && invitation) {
    const colors = SECTION_COLORS[currentSection];
    const Icon = SECTION_ICONS[currentSection];
    const state = sectionStates[currentSection];
    const questionNum = state.history.length + 1;

    return (
      <div className="min-h-screen bg-gradient-to-br from-slate-50 to-blue-50">
        {/* Header */}
        <div className="bg-white border-b border-slate-200 sticky top-0 z-10">
          <div className="max-w-2xl mx-auto px-4 sm:px-6 py-3">
            <div className="flex items-center justify-between mb-2">
              <div className="flex items-center gap-2">
                <div className={`w-7 h-7 ${colors.bg} rounded-lg flex items-center justify-center`}>
                  <Icon className={`w-3.5 h-3.5 ${colors.icon}`} />
                </div>
                <span className="text-sm font-semibold text-slate-700">{LLN_SECTION_LABELS[currentSection]}</span>
              </div>
              <div className="flex items-center gap-3">
                <span className="text-xs text-slate-400">
                  Question {questionNum}
                </span>
                <div className="flex gap-0.5">
                  {SECTIONS.map((s, i) => (
                    <div
                      key={s}
                      className={`h-1.5 w-4 rounded-full ${
                        i < currentSectionIdx ? 'bg-emerald-400' : i === currentSectionIdx ? 'bg-blue-400' : 'bg-slate-200'
                      }`}
                    />
                  ))}
                </div>
              </div>
            </div>
            <ProgressBar value={Math.round((currentSectionIdx / SECTIONS.length) * 100)} />
          </div>
        </div>

        {/* Question card */}
        <div className="max-w-2xl mx-auto px-4 sm:px-6 py-8">
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
              <div className={`mt-6 px-4 py-3 rounded-xl text-sm font-medium transition-all ${
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
            {invitation.candidate_name} &middot; LLN Assessment &middot; {rtoName}
          </div>
        </div>
      </div>
    );
  }

  return null;
}
