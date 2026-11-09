import { useEffect, useState, useMemo, useCallback } from 'react';
import {
  Search, Loader2, X, AlertCircle, ClipboardCheck, FileText, Printer,
  CheckCircle2, XCircle, Calendar, User, History, Plus, BookOpen,
  Hash, FileCheck2, RefreshCw, ChevronRight, Building2, Clock,
} from 'lucide-react';
import { supabase } from '../lib/supabase';
import type {
  Assessment, AssessmentValidation, AssessmentVersionHistory,
  AssessmentQuestion, Domain,
} from '../lib/types';
import { DOMAIN_LABELS } from '../lib/types';

interface AssessmentWithRelations extends Assessment {
  validations: AssessmentValidation[];
  versionHistory: AssessmentVersionHistory[];
  questions: AssessmentQuestion[];
}

interface ReportData {
  assessment: Assessment;
  validations: AssessmentValidation[];
  versionHistory: AssessmentVersionHistory[];
  questions: AssessmentQuestion[];
}

interface NewValidationForm {
  validation_date: string;
  reviewer: string;
  validation_status: 'validated' | 'needs_revision';
  industry_consultation_notes: string;
  review_due_date: string;
}

const EMPTY_FORM: NewValidationForm = {
  validation_date: new Date().toISOString().slice(0, 10),
  reviewer: '',
  validation_status: 'validated',
  industry_consultation_notes: '',
  review_due_date: '',
};

const ASSESSMENT_TYPE_LABELS: Record<string, string> = {
  lln: 'LLN',
  digital: 'Digital Literacy',
};

const STATUS_BADGE_CLASSES: Record<string, string> = {
  draft: 'bg-slate-100 text-slate-700',
  active: 'bg-emerald-100 text-emerald-700',
  archived: 'bg-amber-100 text-amber-700',
};

const VALIDATION_BADGE_CLASSES: Record<string, string> = {
  validated: 'bg-emerald-100 text-emerald-700',
  needs_revision: 'bg-amber-100 text-amber-700',
};

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

function acsfLevelLabel(level: number | null): string {
  if (level == null) return '—';
  const labels: Record<number, string> = {
    1: 'Level 1',
    2: 'Level 2',
    3: 'Level 3',
    4: 'Level 4',
    5: 'Level 5',
  };
  return labels[level] || `Level ${level}`;
}

function acsfLevelDescription(level: number | null): string {
  if (level == null) return '';
  const descriptions: Record<number, string> = {
    1: 'Foundation level — highly scaffolded, familiar contexts',
    2: 'Basic level — simple, familiar contexts with support',
    3: 'Intermediate — routine tasks, some independence',
    4: 'Competent — complex tasks, independent performance',
    5: 'Advanced — complex, unfamiliar contexts, high autonomy',
  };
  return descriptions[level] || '';
}

export function ValidationPage() {
  const [assessments, setAssessments] = useState<AssessmentWithRelations[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [searchQuery, setSearchQuery] = useState('');
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [modalAssessment, setModalAssessment] = useState<AssessmentWithRelations | null>(null);
  const [form, setForm] = useState<NewValidationForm>(EMPTY_FORM);
  const [saving, setSaving] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);
  const [reportData, setReportData] = useState<ReportData | null>(null);
  const [reportLoading, setReportLoading] = useState(false);
  const [reportError, setReportError] = useState<string | null>(null);

  useEffect(() => {
    loadAssessments();
  }, []);

  async function loadAssessments() {
    setLoading(true);
    setError(null);
    try {
      const [aRes, vRes, vhRes, qRes] = await Promise.all([
        supabase.from('assessments').select('*').order('created_at', { ascending: false }),
        supabase.from('assessment_validation').select('*').order('validation_date', { ascending: false }),
        supabase.from('assessment_version_history').select('*').order('changed_at', { ascending: false }),
        supabase.from('assessment_questions').select('*').order('order_index', { ascending: true }),
      ]);

      if (aRes.error) throw aRes.error;
      if (vRes.error) throw vRes.error;
      if (vhRes.error) throw vhRes.error;
      if (qRes.error) throw qRes.error;

      const list = (aRes.data || []) as Assessment[];
      const validations = (vRes.data || []) as AssessmentValidation[];
      const versionHistory = (vhRes.data || []) as AssessmentVersionHistory[];
      const questions = (qRes.data || []) as AssessmentQuestion[];

      const enriched: AssessmentWithRelations[] = list.map((a) => ({
        ...a,
        validations: validations.filter((v) => v.assessment_id === a.id),
        versionHistory: versionHistory.filter((vh) => vh.assessment_id === a.id),
        questions: questions.filter((q) => q.assessment_id === a.id),
      }));

      setAssessments(enriched);
    } catch (e: any) {
      setError(e.message || 'Failed to load assessments');
    } finally {
      setLoading(false);
    }
  }

  function openModal(a: AssessmentWithRelations) {
    setModalAssessment(a);
    setForm(EMPTY_FORM);
    setFormError(null);
  }

  function closeModal() {
    setModalAssessment(null);
    setFormError(null);
  }

  async function handleSaveValidation() {
    if (!modalAssessment) return;
    if (!form.reviewer.trim()) {
      setFormError('Reviewer name is required');
      return;
    }
    if (!form.validation_date) {
      setFormError('Validation date is required');
      return;
    }
    setSaving(true);
    setFormError(null);
    try {
      const payload = {
        assessment_id: modalAssessment.id,
        validation_date: form.validation_date,
        reviewer: form.reviewer.trim(),
        validation_status: form.validation_status,
        industry_consultation_notes: form.industry_consultation_notes.trim() || null,
        review_due_date: form.review_due_date || null,
        validation_history: [],
      };
      const { error: insertErr } = await supabase
        .from('assessment_validation')
        .insert(payload);
      if (insertErr) throw insertErr;
      closeModal();
      await loadAssessments();
    } catch (e: any) {
      setFormError(e.message || 'Failed to save validation record');
    } finally {
      setSaving(false);
    }
  }

  const generateReport = useCallback(async (a: AssessmentWithRelations) => {
    setReportLoading(true);
    setReportError(null);
    setReportData(null);
    try {
      const [vRes, vhRes, qRes] = await Promise.all([
        supabase.from('assessment_validation')
          .select('*')
          .eq('assessment_id', a.id)
          .order('validation_date', { ascending: true }),
        supabase.from('assessment_version_history')
          .select('*')
          .eq('assessment_id', a.id)
          .order('changed_at', { ascending: true }),
        supabase.from('assessment_questions')
          .select('*')
          .eq('assessment_id', a.id)
          .order('order_index', { ascending: true }),
      ]);
      if (vRes.error) throw vRes.error;
      if (vhRes.error) throw vhRes.error;
      if (qRes.error) throw qRes.error;
      setReportData({
        assessment: a,
        validations: (vRes.data || []) as AssessmentValidation[],
        versionHistory: (vhRes.data || []) as AssessmentVersionHistory[],
        questions: (qRes.data || []) as AssessmentQuestion[],
      });
    } catch (e: any) {
      setReportError(e.message || 'Failed to generate report');
    } finally {
      setReportLoading(false);
    }
  }, []);

  function closeReport() {
    setReportData(null);
    setReportError(null);
  }

  function handlePrint() {
    window.print();
  }

  const filteredAssessments = useMemo(() => {
    if (!searchQuery) return assessments;
    const q = searchQuery.toLowerCase();
    return assessments.filter((a) => {
      const matchesTitle = a.title.toLowerCase().includes(q);
      const matchesType = (ASSESSMENT_TYPE_LABELS[a.type] || a.type).toLowerCase().includes(q);
      const matchesVersion = a.version.toLowerCase().includes(q);
      const matchesReviewer = a.validations.some((v) =>
        v.reviewer.toLowerCase().includes(q)
      );
      return matchesTitle || matchesType || matchesVersion || matchesReviewer;
    });
  }, [assessments, searchQuery]);

  const summary = useMemo(() => {
    const total = assessments.length;
    let validatedCount = 0;
    let needsRevisionCount = 0;
    let neverValidatedCount = 0;
    let dueSoonCount = 0;
    const now = new Date();
    const thirtyDays = new Date(now.getTime() + 30 * 24 * 60 * 60 * 1000);
    for (const a of assessments) {
      if (a.validations.length === 0) {
        neverValidatedCount++;
        continue;
      }
      const latest = a.validations[0];
      if (latest.validation_status === 'validated') validatedCount++;
      else needsRevisionCount++;
      if (latest.review_due_date) {
        const due = new Date(latest.review_due_date);
        if (due <= thirtyDays) dueSoonCount++;
      }
    }
    return { total, validatedCount, needsRevisionCount, neverValidatedCount, dueSoonCount };
  }, [assessments]);

  return (
    <div className="space-y-6">
      <style>{`
        @media print {
          body * { visibility: hidden; }
          .print-report, .print-report * { visibility: visible; }
          .print-report {
            position: absolute;
            left: 0;
            top: 0;
            width: 100%;
            padding: 0;
            margin: 0;
            background: white;
          }
          .no-print { display: none !important; }
          .print-page-break { page-break-before: always; }
          .print-report .card {
            border: 1px solid #cbd5e1 !important;
            box-shadow: none !important;
            break-inside: avoid;
          }
          .print-report table { page-break-inside: auto; }
          .print-report tr { page-break-inside: avoid; }
        }
      `}</style>

      <div className="no-print">
        <h1 className="text-2xl font-bold text-slate-900">Validation</h1>
        <p className="text-sm text-slate-500 mt-1">
          Manage assessment validation documentation, version history, and industry consultation records.
        </p>
      </div>

      {error && (
        <div className="card p-4 border-error-200 bg-error-50 no-print">
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

      <ValidationSummary summary={summary} />

      <div className="card p-4 no-print">
        <div className="flex items-center gap-3">
          <div className="relative flex-1">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-slate-400" />
            <input
              type="text"
              placeholder="Search by title, type, version, or reviewer..."
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              className="input pl-9"
            />
          </div>
          <button
            onClick={loadAssessments}
            className="btn-secondary"
            disabled={loading}
          >
            <RefreshCw className={`w-4 h-4 ${loading ? 'animate-spin' : ''}`} />
            Refresh
          </button>
        </div>
      </div>

      {loading ? (
        <div className="flex items-center justify-center py-20 text-slate-400 no-print">
          <Loader2 className="w-6 h-6 animate-spin mr-2" />
          Loading assessments...
        </div>
      ) : filteredAssessments.length === 0 ? (
        <div className="card p-12 text-center no-print">
          <ClipboardCheck className="w-12 h-12 text-slate-300 mx-auto mb-4" />
          <h3 className="text-base font-semibold text-slate-900 mb-1">
            {assessments.length === 0 ? 'No assessments found' : 'No matching assessments'}
          </h3>
          <p className="text-sm text-slate-500">
            {assessments.length === 0
              ? 'Assessments will appear here once they are created.'
              : 'Try adjusting your search criteria.'}
          </p>
        </div>
      ) : (
        <div className="space-y-3 no-print">
          {filteredAssessments.map((a) => (
            <AssessmentValidationCard
              key={a.id}
              assessment={a}
              expanded={expandedId === a.id}
              onToggle={() => setExpandedId(expandedId === a.id ? null : a.id)}
              onAddValidation={() => openModal(a)}
              onGenerateReport={() => generateReport(a)}
              reportLoading={reportLoading}
            />
          ))}
        </div>
      )}

      {modalAssessment && (
        <AddValidationModal
          assessment={modalAssessment}
          form={form}
          setForm={setForm}
          onClose={closeModal}
          onSave={handleSaveValidation}
          saving={saving}
          error={formError}
        />
      )}

      {reportLoading && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/50 backdrop-blur-sm no-print">
          <div className="card p-8 flex flex-col items-center gap-3">
            <Loader2 className="w-8 h-8 animate-spin text-primary-600" />
            <p className="text-sm text-slate-600">Generating validation report...</p>
          </div>
        </div>
      )}

      {reportError && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-slate-900/50 backdrop-blur-sm no-print">
          <div className="card w-full max-w-md p-6">
            <div className="flex items-start gap-3 mb-4">
              <AlertCircle className="w-6 h-6 text-error-600 flex-shrink-0" />
              <div>
                <h3 className="text-base font-semibold text-slate-900">Report Error</h3>
                <p className="text-sm text-slate-600 mt-1">{reportError}</p>
              </div>
            </div>
            <button onClick={() => setReportError(null)} className="btn-secondary w-full">
              Close
            </button>
          </div>
        </div>
      )}

      {reportData && (
        <ValidationReportView
          data={reportData}
          onClose={closeReport}
          onPrint={handlePrint}
        />
      )}
    </div>
  );
}

function ValidationSummary({
  summary,
}: {
  summary: {
    total: number;
    validatedCount: number;
    needsRevisionCount: number;
    neverValidatedCount: number;
    dueSoonCount: number;
  };
}) {
  const cards = [
    {
      label: 'Total Assessments',
      value: summary.total,
      icon: <ClipboardCheck className="w-4 h-4 text-primary-600" />,
      bg: 'bg-primary-50',
    },
    {
      label: 'Validated',
      value: summary.validatedCount,
      icon: <CheckCircle2 className="w-4 h-4 text-emerald-600" />,
      bg: 'bg-emerald-50',
    },
    {
      label: 'Needs Revision',
      value: summary.needsRevisionCount,
      icon: <XCircle className="w-4 h-4 text-amber-600" />,
      bg: 'bg-amber-50',
    },
    {
      label: 'Never Validated',
      value: summary.neverValidatedCount,
      icon: <AlertCircle className="w-4 h-4 text-rose-600" />,
      bg: 'bg-rose-50',
    },
    {
      label: 'Review Due ≤30d',
      value: summary.dueSoonCount,
      icon: <Clock className="w-4 h-4 text-blue-600" />,
      bg: 'bg-blue-50',
    },
  ];

  return (
    <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-5 gap-3 no-print">
      {cards.map((c) => (
        <div key={c.label} className="card p-4">
          <div className="flex items-center gap-2 mb-2">
            <div className={`w-7 h-7 rounded-lg ${c.bg} flex items-center justify-center`}>
              {c.icon}
            </div>
          </div>
          <div className="text-2xl font-bold text-slate-900 tabular-nums">{c.value}</div>
          <div className="text-xs text-slate-500 mt-0.5">{c.label}</div>
        </div>
      ))}
    </div>
  );
}

function AssessmentValidationCard({
  assessment,
  expanded,
  onToggle,
  onAddValidation,
  onGenerateReport,
  reportLoading,
}: {
  assessment: AssessmentWithRelations;
  expanded: boolean;
  onToggle: () => void;
  onAddValidation: () => void;
  onGenerateReport: () => void;
  reportLoading: boolean;
}) {
  const latest = assessment.validations[0] || null;
  const typeLabel = ASSESSMENT_TYPE_LABELS[assessment.type] || assessment.type;
  const statusBadge = STATUS_BADGE_CLASSES[assessment.status] || 'bg-slate-100 text-slate-700';

  return (
    <div className="card overflow-hidden">
      <button
        onClick={onToggle}
        className="w-full flex items-center justify-between p-4 text-left hover:bg-slate-50 transition-colors"
      >
        <div className="flex items-center gap-3 min-w-0">
          <div className="w-10 h-10 rounded-lg bg-primary-50 flex items-center justify-center flex-shrink-0">
            <FileCheck2 className="w-5 h-5 text-primary-600" />
          </div>
          <div className="min-w-0">
            <div className="flex items-center gap-2 flex-wrap">
              <h3 className="text-sm font-semibold text-slate-900 truncate">
                {assessment.title}
              </h3>
              <span className={`badge ${statusBadge}`}>{assessment.status}</span>
            </div>
            <div className="flex items-center gap-3 mt-1 text-xs text-slate-500 flex-wrap">
              <span className="font-medium">{typeLabel}</span>
              <span>·</span>
              <span>v{assessment.version}</span>
              <span>·</span>
              <span>{assessment.questions.length} questions</span>
              <span>·</span>
              <span>{assessment.validations.length} validation{assessment.validations.length === 1 ? '' : 's'}</span>
            </div>
          </div>
        </div>
        <div className="flex items-center gap-3 flex-shrink-0">
          {latest ? (
            <span className={`badge ${VALIDATION_BADGE_CLASSES[latest.validation_status] || 'bg-slate-100 text-slate-700'}`}>
              {latest.validation_status === 'validated' ? (
                <CheckCircle2 className="w-3 h-3" />
              ) : (
                <XCircle className="w-3 h-3" />
              )}
              {latest.validation_status === 'validated' ? 'Validated' : 'Needs Revision'}
            </span>
          ) : (
            <span className="badge bg-slate-100 text-slate-500">Not validated</span>
          )}
          <ChevronRight
            className={`w-5 h-5 text-slate-400 transition-transform ${expanded ? 'rotate-90' : ''}`}
          />
        </div>
      </button>

      {expanded && (
        <div className="border-t border-slate-200 p-4 space-y-4 bg-slate-50/50">
          <div className="flex items-center justify-end gap-2 flex-wrap">
            <button onClick={onAddValidation} className="btn-secondary text-xs px-3 py-1.5">
              <Plus className="w-3.5 h-3.5" />
              Add Validation
            </button>
            <button
              onClick={onGenerateReport}
              disabled={reportLoading}
              className="btn-primary text-xs px-3 py-1.5"
            >
              <FileText className="w-3.5 h-3.5" />
              Generate Report
            </button>
          </div>

          <ValidationRecordsList validations={assessment.validations} />

          <VersionHistoryList history={assessment.versionHistory} />

          <QuestionRationaleList questions={assessment.questions} />
        </div>
      )}
    </div>
  );
}

function ValidationRecordsList({ validations }: { validations: AssessmentValidation[] }) {
  return (
    <div>
      <div className="flex items-center gap-2 mb-2">
        <FileCheck2 className="w-4 h-4 text-slate-600" />
        <h4 className="text-xs font-semibold text-slate-700 uppercase tracking-wider">
          Validation Records
        </h4>
      </div>
      {validations.length === 0 ? (
        <p className="text-sm text-slate-400 px-1">No validation records yet.</p>
      ) : (
        <div className="space-y-2">
          {validations.map((v) => (
            <div key={v.id} className="card p-3 bg-white">
              <div className="flex items-center justify-between gap-2 flex-wrap mb-2">
                <div className="flex items-center gap-2 flex-wrap">
                  <span className={`badge ${VALIDATION_BADGE_CLASSES[v.validation_status] || 'bg-slate-100 text-slate-700'}`}>
                    {v.validation_status === 'validated' ? (
                      <CheckCircle2 className="w-3 h-3" />
                    ) : (
                      <XCircle className="w-3 h-3" />
                    )}
                    {v.validation_status === 'validated' ? 'Validated' : 'Needs Revision'}
                  </span>
                  <span className="text-sm font-medium text-slate-900 flex items-center gap-1">
                    <User className="w-3.5 h-3.5 text-slate-400" />
                    {v.reviewer}
                  </span>
                </div>
                <div className="flex items-center gap-3 text-xs text-slate-500">
                  <span className="flex items-center gap-1">
                    <Calendar className="w-3.5 h-3.5" />
                    {formatDate(v.validation_date)}
                  </span>
                  <span className="flex items-center gap-1">
                    <Clock className="w-3.5 h-3.5" />
                    Review due: {formatDate(v.review_due_date)}
                  </span>
                </div>
              </div>
              {v.industry_consultation_notes && (
                <div className="mt-2 pt-2 border-t border-slate-100">
                  <div className="text-xs font-semibold text-slate-500 uppercase tracking-wider mb-1">
                    Industry Consultation Notes
                  </div>
                  <p className="text-sm text-slate-700 whitespace-pre-wrap">
                    {v.industry_consultation_notes}
                  </p>
                </div>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function VersionHistoryList({ history }: { history: AssessmentVersionHistory[] }) {
  return (
    <div>
      <div className="flex items-center gap-2 mb-2">
        <History className="w-4 h-4 text-slate-600" />
        <h4 className="text-xs font-semibold text-slate-700 uppercase tracking-wider">
          Version History
        </h4>
      </div>
      {history.length === 0 ? (
        <p className="text-sm text-slate-400 px-1">No version history recorded.</p>
      ) : (
        <div className="space-y-2">
          {history.map((vh) => (
            <div key={vh.id} className="card p-3 bg-white">
              <div className="flex items-center justify-between gap-2 flex-wrap">
                <div className="flex items-center gap-2">
                  <span className="badge bg-primary-100 text-primary-700 tabular-nums">
                    v{vh.version}
                  </span>
                  {vh.changed_by && (
                    <span className="text-xs text-slate-500 flex items-center gap-1">
                      <User className="w-3 h-3" />
                      {vh.changed_by}
                    </span>
                  )}
                </div>
                <span className="text-xs text-slate-500 flex items-center gap-1">
                  <Calendar className="w-3.5 h-3.5" />
                  {formatDateTime(vh.changed_at)}
                </span>
              </div>
              {vh.change_summary && (
                <p className="text-sm text-slate-700 mt-2 whitespace-pre-wrap">
                  {vh.change_summary}
                </p>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function QuestionRationaleList({ questions }: { questions: AssessmentQuestion[] }) {
  return (
    <div>
      <div className="flex items-center gap-2 mb-2">
        <BookOpen className="w-4 h-4 text-slate-600" />
        <h4 className="text-xs font-semibold text-slate-700 uppercase tracking-wider">
          Question Mapping Rationale
        </h4>
      </div>
      {questions.length === 0 ? (
        <p className="text-sm text-slate-400 px-1">No questions defined for this assessment.</p>
      ) : (
        <div className="card overflow-hidden bg-white">
          <div className="overflow-x-auto">
            <table className="w-full">
              <thead className="bg-slate-50 border-b border-slate-200">
                <tr>
                  <th className="table-header w-8">#</th>
                  <th className="table-header">Question</th>
                  <th className="table-header">Domain</th>
                  <th className="table-header">ACSF Skill</th>
                  <th className="table-header">Level</th>
                  <th className="table-header">Mapping Rationale</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-200">
                {questions.map((q, idx) => (
                  <tr key={q.id} className="hover:bg-slate-50 transition-colors">
                    <td className="table-cell text-slate-400 tabular-nums">{idx + 1}</td>
                    <td className="table-cell font-medium text-slate-900 max-w-xs">
                      <div className="truncate" title={q.question_text}>
                        {q.question_text}
                      </div>
                    </td>
                    <td className="table-cell">
                      <span className="badge bg-slate-100 text-slate-700">
                        {DOMAIN_LABELS[q.domain as Domain] || q.domain}
                      </span>
                    </td>
                    <td className="table-cell text-slate-700">{q.acsf_skill || '—'}</td>
                    <td className="table-cell">
                      <span className="badge bg-primary-100 text-primary-700 tabular-nums">
                        <Hash className="w-3 h-3" />
                        {acsfLevelLabel(q.acsf_level_target)}
                      </span>
                    </td>
                    <td className="table-cell text-slate-600 text-xs max-w-sm">
                      <div className="line-clamp-2" title={q.mapping_rationale || ''}>
                        {q.mapping_rationale || '—'}
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </div>
  );
}

function AddValidationModal({
  assessment,
  form,
  setForm,
  onClose,
  onSave,
  saving,
  error,
}: {
  assessment: AssessmentWithRelations;
  form: NewValidationForm;
  setForm: React.Dispatch<React.SetStateAction<NewValidationForm>>;
  onClose: () => void;
  onSave: () => void;
  saving: boolean;
  error: string | null;
}) {
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-slate-900/50 backdrop-blur-sm no-print">
      <div className="card w-full max-w-lg max-h-[95vh] overflow-y-auto scrollbar-thin">
        <div className="flex items-center justify-between p-5 border-b border-slate-200 sticky top-0 bg-white rounded-t-xl z-10">
          <div className="flex items-center gap-3 min-w-0">
            <div className="w-9 h-9 rounded-lg bg-primary-50 flex items-center justify-center flex-shrink-0">
              <Plus className="w-5 h-5 text-primary-600" />
            </div>
            <div className="min-w-0">
              <h2 className="text-base font-bold text-slate-900 truncate">
                Add Validation Record
              </h2>
              <p className="text-xs text-slate-500 truncate">
                {assessment.title} · v{assessment.version}
              </p>
            </div>
          </div>
          <button onClick={onClose} className="btn-ghost p-1.5">
            <X className="w-5 h-5" />
          </button>
        </div>

        <div className="p-5 space-y-4">
          {error && (
            <div className="p-3 rounded-lg border border-error-200 bg-error-50 flex items-start gap-2">
              <AlertCircle className="w-4 h-4 text-error-600 flex-shrink-0 mt-0.5" />
              <p className="text-sm text-error-700">{error}</p>
            </div>
          )}

          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            <div>
              <label className="label">Validation Date</label>
              <input
                type="date"
                value={form.validation_date}
                onChange={(e) => setForm({ ...form, validation_date: e.target.value })}
                className="input"
              />
            </div>
            <div>
              <label className="label">Review Due Date</label>
              <input
                type="date"
                value={form.review_due_date}
                onChange={(e) => setForm({ ...form, review_due_date: e.target.value })}
                className="input"
              />
            </div>
          </div>

          <div>
            <label className="label">Reviewer</label>
            <input
              type="text"
              placeholder="Reviewer name"
              value={form.reviewer}
              onChange={(e) => setForm({ ...form, reviewer: e.target.value })}
              className="input"
            />
          </div>

          <div>
            <label className="label">Validation Status</label>
            <div className="grid grid-cols-2 gap-2">
              <button
                type="button"
                onClick={() => setForm({ ...form, validation_status: 'validated' })}
                className={`flex items-center justify-center gap-2 px-3 py-2 rounded-lg border text-sm font-medium transition-all ${
                  form.validation_status === 'validated'
                    ? 'border-emerald-500 bg-emerald-50 text-emerald-700'
                    : 'border-slate-300 bg-white text-slate-600 hover:bg-slate-50'
                }`}
              >
                <CheckCircle2 className="w-4 h-4" />
                Validated
              </button>
              <button
                type="button"
                onClick={() => setForm({ ...form, validation_status: 'needs_revision' })}
                className={`flex items-center justify-center gap-2 px-3 py-2 rounded-lg border text-sm font-medium transition-all ${
                  form.validation_status === 'needs_revision'
                    ? 'border-amber-500 bg-amber-50 text-amber-700'
                    : 'border-slate-300 bg-white text-slate-600 hover:bg-slate-50'
                }`}
              >
                <XCircle className="w-4 h-4" />
                Needs Revision
              </button>
            </div>
          </div>

          <div>
            <label className="label">Industry Consultation Notes</label>
            <textarea
              placeholder="Document industry consultation feedback, stakeholder input, and validation outcomes..."
              value={form.industry_consultation_notes}
              onChange={(e) => setForm({ ...form, industry_consultation_notes: e.target.value })}
              rows={5}
              className="input resize-y"
            />
          </div>
        </div>

        <div className="flex items-center justify-end gap-2 p-5 border-t border-slate-200 sticky bottom-0 bg-white rounded-b-xl">
          <button onClick={onClose} className="btn-secondary" disabled={saving}>
            Cancel
          </button>
          <button onClick={onSave} className="btn-primary" disabled={saving}>
            {saving ? (
              <>
                <Loader2 className="w-4 h-4 animate-spin" />
                Saving...
              </>
            ) : (
              <>
                <CheckCircle2 className="w-4 h-4" />
                Save Validation
              </>
            )}
          </button>
        </div>
      </div>
    </div>
  );
}

function ValidationReportView({
  data,
  onClose,
  onPrint,
}: {
  data: ReportData;
  onClose: () => void;
  onPrint: () => void;
}) {
  const { assessment, validations, versionHistory, questions } = data;
  const typeLabel = ASSESSMENT_TYPE_LABELS[assessment.type] || assessment.type;
  const latest = validations[validations.length - 1] || null;
  const nextReview = latest?.review_due_date || null;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-slate-900/50 backdrop-blur-sm no-print">
      <div className="card w-full max-w-5xl max-h-[95vh] overflow-y-auto scrollbar-thin">
        <div className="flex items-center justify-between p-5 border-b border-slate-200 sticky top-0 bg-white rounded-t-xl z-10 no-print">
          <div className="flex items-center gap-3 min-w-0">
            <div className="w-10 h-10 rounded-lg bg-primary-50 flex items-center justify-center flex-shrink-0">
              <FileText className="w-5 h-5 text-primary-600" />
            </div>
            <div className="min-w-0">
              <h2 className="text-lg font-bold text-slate-900 truncate">
                Validation Report
              </h2>
              <p className="text-sm text-slate-500 truncate">
                {assessment.title} · v{assessment.version}
              </p>
            </div>
          </div>
          <div className="flex items-center gap-2 flex-shrink-0">
            <button onClick={onPrint} className="btn-primary text-xs px-3 py-1.5">
              <Printer className="w-3.5 h-3.5" />
              Print Report
            </button>
            <button onClick={onClose} className="btn-ghost p-1.5">
              <X className="w-5 h-5" />
            </button>
          </div>
        </div>

        <div className="print-report p-8 space-y-6">
          <ReportHeader assessment={assessment} typeLabel={typeLabel} />

          <ReportAssessmentDetails assessment={assessment} typeLabel={typeLabel} />

          <ReportQuestions questions={questions} />

          <ReportValidationHistory validations={validations} />

          <ReportVersionHistory history={versionHistory} />

          <ReportIndustryConsultation validations={validations} />

          <ReportNextReview nextReview={nextReview} latest={latest} />

          <div className="pt-6 border-t border-slate-200 text-center">
            <p className="text-xs text-slate-400">
              Report generated on {formatDateTime(new Date().toISOString())} · LLND Mate Assessment Validation
            </p>
          </div>
        </div>
      </div>
    </div>
  );
}

function ReportSection({
  icon,
  title,
  children,
}: {
  icon: React.ReactNode;
  title: string;
  children: React.ReactNode;
}) {
  return (
    <div className="card p-5">
      <div className="flex items-center gap-2 mb-4">
        <div className="w-7 h-7 rounded-lg bg-slate-100 flex items-center justify-center">
          {icon}
        </div>
        <h3 className="text-sm font-semibold text-slate-800 uppercase tracking-wider">
          {title}
        </h3>
      </div>
      {children}
    </div>
  );
}

function ReportHeader({
  assessment,
  typeLabel,
}: {
  assessment: Assessment;
  typeLabel: string;
}) {
  return (
    <div className="card p-6 bg-slate-50 border-slate-300">
      <div className="flex items-start justify-between flex-wrap gap-4">
        <div className="flex items-center gap-4">
          <div className="w-14 h-14 rounded-lg bg-primary-600 flex items-center justify-center">
            <Building2 className="w-7 h-7 text-white" />
          </div>
          <div>
            <h1 className="text-xl font-bold text-slate-900">
              Assessment Validation Report
            </h1>
            <p className="text-sm text-slate-600 mt-0.5">
              {assessment.title}
            </p>
            <p className="text-xs text-slate-500 mt-1">
              {typeLabel} · Version {assessment.version}
            </p>
          </div>
        </div>
        <div className="text-right">
          <div className="text-xs font-semibold text-slate-500 uppercase tracking-wider">
            Report ID
          </div>
          <div className="text-sm font-mono text-slate-700 mt-0.5">
            {assessment.id}
          </div>
          <div className="text-xs text-slate-500 mt-2">
            Generated: {formatDateTime(new Date().toISOString())}
          </div>
        </div>
      </div>
    </div>
  );
}

function ReportAssessmentDetails({
  assessment,
  typeLabel,
}: {
  assessment: Assessment;
  typeLabel: string;
}) {
  const rows = [
    { label: 'Title', value: assessment.title },
    { label: 'Type', value: typeLabel },
    { label: 'Version', value: `v${assessment.version}` },
    { label: 'Status', value: assessment.status },
    { label: 'Created', value: formatDate(assessment.created_at) },
    { label: 'Total Questions', value: String(assessment.total_questions ?? '—') },
  ];
  return (
    <ReportSection icon={<ClipboardCheck className="w-4 h-4 text-slate-600" />} title="Assessment Details">
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
        {rows.map((r) => (
          <div key={r.label}>
            <div className="text-xs font-semibold text-slate-500 uppercase tracking-wider mb-1">
              {r.label}
            </div>
            <div className="text-sm font-medium text-slate-900">{r.value}</div>
          </div>
        ))}
      </div>
      {assessment.description && (
        <div className="mt-4 pt-4 border-t border-slate-100">
          <div className="text-xs font-semibold text-slate-500 uppercase tracking-wider mb-1">
            Description
          </div>
          <p className="text-sm text-slate-700 whitespace-pre-wrap">
            {assessment.description}
          </p>
        </div>
      )}
    </ReportSection>
  );
}

function ReportQuestions({ questions }: { questions: AssessmentQuestion[] }) {
  return (
    <ReportSection icon={<BookOpen className="w-4 h-4 text-slate-600" />} title="Questions & Mapping Rationale">
      {questions.length === 0 ? (
        <p className="text-sm text-slate-400">No questions defined for this assessment.</p>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full">
            <thead className="bg-slate-50 border-b border-slate-200">
              <tr>
                <th className="table-header w-8">#</th>
                <th className="table-header">Question</th>
                <th className="table-header">Domain</th>
                <th className="table-header">ACSF Skill</th>
                <th className="table-header">ACSF Level Target</th>
                <th className="table-header">Mapping Rationale</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-200">
              {questions.map((q, idx) => (
                <tr key={q.id}>
                  <td className="table-cell text-slate-400 tabular-nums">{idx + 1}</td>
                  <td className="table-cell font-medium text-slate-900">
                    {q.question_text}
                  </td>
                  <td className="table-cell">
                    <span className="badge bg-slate-100 text-slate-700">
                      {DOMAIN_LABELS[q.domain as Domain] || q.domain}
                    </span>
                  </td>
                  <td className="table-cell text-slate-700">{q.acsf_skill || '—'}</td>
                  <td className="table-cell">
                    <div className="flex flex-col gap-0.5">
                      <span className="badge bg-primary-100 text-primary-700 tabular-nums w-fit">
                        <Hash className="w-3 h-3" />
                        {acsfLevelLabel(q.acsf_level_target)}
                      </span>
                      <span className="text-xs text-slate-500">
                        {acsfLevelDescription(q.acsf_level_target)}
                      </span>
                    </div>
                  </td>
                  <td className="table-cell text-slate-600 text-xs">
                    {q.mapping_rationale || '—'}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </ReportSection>
  );
}

function ReportValidationHistory({ validations }: { validations: AssessmentValidation[] }) {
  return (
    <ReportSection icon={<FileCheck2 className="w-4 h-4 text-slate-600" />} title="Validation History">
      {validations.length === 0 ? (
        <p className="text-sm text-slate-400">No validation records on file.</p>
      ) : (
        <div className="space-y-3">
          {validations.map((v) => (
            <div key={v.id} className="p-4 rounded-lg border border-slate-200 bg-white">
              <div className="flex items-center justify-between gap-2 flex-wrap mb-2">
                <div className="flex items-center gap-2 flex-wrap">
                  <span className={`badge ${VALIDATION_BADGE_CLASSES[v.validation_status] || 'bg-slate-100 text-slate-700'}`}>
                    {v.validation_status === 'validated' ? (
                      <CheckCircle2 className="w-3 h-3" />
                    ) : (
                      <XCircle className="w-3 h-3" />
                    )}
                    {v.validation_status === 'validated' ? 'Validated' : 'Needs Revision'}
                  </span>
                  <span className="text-sm font-medium text-slate-900 flex items-center gap-1">
                    <User className="w-3.5 h-3.5 text-slate-400" />
                    {v.reviewer}
                  </span>
                </div>
                <div className="flex items-center gap-3 text-xs text-slate-500">
                  <span className="flex items-center gap-1">
                    <Calendar className="w-3.5 h-3.5" />
                    {formatDate(v.validation_date)}
                  </span>
                  <span className="flex items-center gap-1">
                    <Clock className="w-3.5 h-3.5" />
                    Review due: {formatDate(v.review_due_date)}
                  </span>
                </div>
              </div>
            </div>
          ))}
        </div>
      )}
    </ReportSection>
  );
}

function ReportVersionHistory({ history }: { history: AssessmentVersionHistory[] }) {
  return (
    <ReportSection icon={<History className="w-4 h-4 text-slate-600" />} title="Version History">
      {history.length === 0 ? (
        <p className="text-sm text-slate-400">No version history recorded.</p>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full">
            <thead className="bg-slate-50 border-b border-slate-200">
              <tr>
                <th className="table-header">Version</th>
                <th className="table-header">Change Summary</th>
                <th className="table-header">Changed By</th>
                <th className="table-header">Changed At</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-200">
              {history.map((vh) => (
                <tr key={vh.id}>
                  <td className="table-cell">
                    <span className="badge bg-primary-100 text-primary-700 tabular-nums">
                      v{vh.version}
                    </span>
                  </td>
                  <td className="table-cell text-slate-700">
                    {vh.change_summary || '—'}
                  </td>
                  <td className="table-cell text-slate-600">
                    {vh.changed_by || '—'}
                  </td>
                  <td className="table-cell text-slate-600">
                    {formatDateTime(vh.changed_at)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </ReportSection>
  );
}

function ReportIndustryConsultation({ validations }: { validations: AssessmentValidation[] }) {
  const withNotes = validations.filter((v) => v.industry_consultation_notes);
  return (
    <ReportSection icon={<BookOpen className="w-4 h-4 text-slate-600" />} title="Industry Consultation Notes">
      {withNotes.length === 0 ? (
        <p className="text-sm text-slate-400">No industry consultation notes recorded.</p>
      ) : (
        <div className="space-y-3">
          {withNotes.map((v) => (
            <div key={v.id} className="p-3 rounded-lg bg-slate-50 border border-slate-200">
              <div className="flex items-center justify-between gap-2 flex-wrap mb-2">
                <span className="text-xs font-semibold text-slate-500 uppercase tracking-wider">
                  {v.reviewer} · {formatDate(v.validation_date)}
                </span>
                <span className={`badge ${VALIDATION_BADGE_CLASSES[v.validation_status] || 'bg-slate-100 text-slate-700'}`}>
                  {v.validation_status === 'validated' ? 'Validated' : 'Needs Revision'}
                </span>
              </div>
              <p className="text-sm text-slate-700 whitespace-pre-wrap">
                {v.industry_consultation_notes}
              </p>
            </div>
          ))}
        </div>
      )}
    </ReportSection>
  );
}

function ReportNextReview({
  nextReview,
  latest,
}: {
  nextReview: string | null;
  latest: AssessmentValidation | null;
}) {
  let badgeClass = 'bg-slate-100 text-slate-700';
  let label = 'No review scheduled';
  if (nextReview) {
    const due = new Date(nextReview);
    const now = new Date();
    const thirtyDays = new Date(now.getTime() + 30 * 24 * 60 * 60 * 1000);
    if (due < now) {
      badgeClass = 'bg-rose-100 text-rose-700';
      label = 'Overdue';
    } else if (due <= thirtyDays) {
      badgeClass = 'bg-amber-100 text-amber-700';
      label = 'Due soon';
    } else {
      badgeClass = 'bg-emerald-100 text-emerald-700';
      label = 'On track';
    }
  }

  return (
    <ReportSection icon={<Clock className="w-4 h-4 text-slate-600" />} title="Next Review Due">
      <div className="flex items-center justify-between gap-4 flex-wrap">
        <div>
          <div className="text-xs font-semibold text-slate-500 uppercase tracking-wider mb-1">
            Next Review Date
          </div>
          <div className="text-lg font-bold text-slate-900">
            {formatDate(nextReview)}
          </div>
        </div>
        <div className="flex flex-col items-end gap-1">
          <span className={`badge text-sm px-3 py-1 ${badgeClass}`}>
            {label}
          </span>
          {latest && (
            <span className="text-xs text-slate-500">
              Last validated {formatDate(latest.validation_date)} by {latest.reviewer}
            </span>
          )}
        </div>
      </div>
    </ReportSection>
  );
}
