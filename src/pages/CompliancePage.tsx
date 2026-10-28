import { useEffect, useState, useMemo, useCallback } from 'react';
import {
  Search, Loader2, X, Mail, Calendar,
  CheckCircle2, XCircle, AlertCircle, ShieldCheck, ShieldAlert,
  Award, ClipboardList, FileText, Printer, Download, TrendingUp,
  ListChecks, BookOpen, Hash, GraduationCap, Building2, Clock,
  History, AlertTriangle, BarChart3, Users, PieChart,
} from 'lucide-react';
import { supabase } from '../lib/supabase';
import type {
  AssessmentInvitation, AuditTrailEntry, SupportPlan, InterventionCase,
  InvitationAssessment, AssessmentResponse, AssessmentQuestion,
  Assessment, Qualification, CourseRecommendation, Domain,
} from '../lib/types';
import { DOMAIN_LABELS, RECOMMENDATION_LABELS, RECOMMENDATION_COLORS } from '../lib/types';

interface InvitationWithQualification extends AssessmentInvitation {
  qualification: Pick<Qualification, 'id' | 'code' | 'name'> | null;
}

interface InvitationAssessmentWithDetails extends InvitationAssessment {
  assessment: Pick<Assessment, 'id' | 'title' | 'type' | 'pass_threshold' | 'acsf_level_mapping'> | null;
}

interface ResponseWithQuestion extends AssessmentResponse {
  question: Pick<AssessmentQuestion, 'id' | 'question_text' | 'domain' | 'acsf_skill' | 'correct_answer' | 'points' | 'question_type' | 'options'> | null;
}

interface OrgBranding {
  name: string;
  rto_number: string;
  logo_url: string | null;
}

interface ReportData {
  invitation: InvitationWithQualification;
  invAssessments: InvitationAssessmentWithDetails[];
  responses: ResponseWithQuestion[];
  auditTrail: AuditTrailEntry[];
  supportPlans: SupportPlan[];
  interventionCases: InterventionCase[];
  orgBranding: OrgBranding | null;
}

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

function acsfLevelLabel(level: number): string {
  const labels: Record<number, string> = {
    1: 'Level 1',
    2: 'Level 2',
    3: 'Level 3',
    4: 'Level 4',
    5: 'Level 5',
  };
  return labels[level] || `Level ${level}`;
}

function downloadCSV(filename: string, rows: string[][]) {
  const csv = rows
    .map((row) => row.map((cell) => {
      const c = String(cell ?? '');
      if (c.includes(',') || c.includes('"') || c.includes('\n')) {
        return `"${c.replace(/"/g, '""')}"`;
      }
      return c;
    }).join(','))
    .join('\n');
  const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
  URL.revokeObjectURL(url);
}

export function CompliancePage() {
  const [invitations, setInvitations] = useState<InvitationWithQualification[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [searchQuery, setSearchQuery] = useState('');
  const [reportData, setReportData] = useState<ReportData | null>(null);
  const [reportLoading, setReportLoading] = useState(false);
  const [reportError, setReportError] = useState<string | null>(null);

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

  const generateReport = useCallback(async (inv: InvitationWithQualification) => {
    setReportLoading(true);
    setReportError(null);
    setReportData(null);

    try {
      const [
        iaRes, respRes, auditRes, supportRes, interventionRes, orgRes,
      ] = await Promise.all([
        supabase
          .from('invitation_assessments')
          .select('*, assessment:assessments(id, title, type, pass_threshold, acsf_level_mapping)')
          .eq('invitation_id', inv.id)
          .order('created_at', { ascending: true }),
        supabase
          .from('assessment_responses')
          .select('*, question:assessment_questions(id, question_text, domain, acsf_skill, correct_answer, points, question_type, options)')
          .eq('invitation_id', inv.id)
          .order('submitted_at', { ascending: true }),
        supabase
          .from('audit_trail')
          .select('*')
          .eq('invitation_id', inv.id)
          .order('timestamp', { ascending: true }),
        supabase
          .from('support_plans')
          .select('*')
          .eq('invitation_id', inv.id)
          .order('created_at', { ascending: true }),
        supabase
          .from('intervention_cases')
          .select('*')
          .eq('invitation_id', inv.id)
          .order('created_at', { ascending: true }),
        supabase
          .from('organisation_settings')
          .select('value')
          .eq('key', 'org_branding')
          .maybeSingle(),
      ]);

      if (iaRes.error) throw iaRes.error;
      if (respRes.error) throw respRes.error;
      if (auditRes.error) throw auditRes.error;
      if (supportRes.error) throw supportRes.error;
      if (interventionRes.error) throw interventionRes.error;
      if (orgRes.error) throw orgRes.error;

      let orgBranding: OrgBranding | null = null;
      if (orgRes.data?.value) {
        const v = orgRes.data.value as any;
        orgBranding = {
          name: v.name || '',
          rto_number: v.rto_number || '',
          logo_url: v.logo_url || null,
        };
      }

      setReportData({
        invitation: inv,
        invAssessments: (iaRes.data || []) as InvitationAssessmentWithDetails[],
        responses: (respRes.data || []) as ResponseWithQuestion[],
        auditTrail: (auditRes.data || []) as AuditTrailEntry[],
        supportPlans: (supportRes.data || []) as SupportPlan[],
        interventionCases: (interventionRes.data || []) as InterventionCase[],
        orgBranding,
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

  function handleExportCSV() {
    if (!reportData) return;
    const rows: string[][] = [
      ['Timestamp', 'Event Type', 'Actor', 'Actor ID', 'Event Data'],
    ];
    for (const entry of reportData.auditTrail) {
      rows.push([
        formatDateTime(entry.timestamp),
        entry.event_type,
        entry.actor,
        entry.actor_id || '',
        JSON.stringify(entry.event_data || {}),
      ]);
    }
    const filename = `audit-trail-${reportData.invitation.candidate_name.replace(/\s+/g, '-').toLowerCase()}-${reportData.invitation.id.slice(0, 8)}.csv`;
    downloadCSV(filename, rows);
  }

  const filteredInvitations = useMemo(() => {
    if (!searchQuery) return invitations;
    const q = searchQuery.toLowerCase();
    return invitations.filter((inv) => {
      const matchesName = inv.candidate_name.toLowerCase().includes(q);
      const matchesEmail = inv.candidate_email.toLowerCase().includes(q);
      const matchesQual = inv.qualification?.name.toLowerCase().includes(q);
      const matchesCode = inv.qualification?.code.toLowerCase().includes(q);
      return matchesName || matchesEmail || matchesQual || matchesCode;
    });
  }, [invitations, searchQuery]);

  const cohortSummary = useMemo(() => {
    const total = invitations.length;
    const recCounts: Record<string, number> = {
      suitable: 0,
      suitable_with_support: 0,
      not_yet_suitable: 0,
      overridden: 0,
      pending: 0,
    };
    const acsfDistribution: Record<string, number> = {};
    let verifiedCount = 0;

    for (const inv of invitations) {
      const rec = effectiveRecommendation(inv);
      if (rec && recCounts[rec] !== undefined) recCounts[rec]++;
      else if (!rec) recCounts.pending++;
      if (isOverridden(inv)) recCounts.overridden++;
      if (inv.identity_verified) verifiedCount++;
    }

    return {
      total,
      recCounts,
      acsfDistribution,
      verifiedCount,
      completionRate: total > 0 ? 100 : 0,
    };
  }, [invitations]);

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
        <h1 className="text-2xl font-bold text-slate-900">Compliance</h1>
        <p className="text-sm text-slate-500 mt-1">
          Generate ASQA audit-ready reports from completed LLND Automate assessments.
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

      <CohortSummary invitations={invitations} summary={cohortSummary} />

      <div className="card p-4 no-print">
        <div className="relative">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-slate-400" />
          <input
            type="text"
            placeholder="Search by name, email, or qualification..."
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            className="input pl-9"
          />
        </div>
      </div>

      {loading ? (
        <div className="flex items-center justify-center py-20 text-slate-400 no-print">
          <Loader2 className="w-6 h-6 animate-spin mr-2" />
          Loading completed candidates...
        </div>
      ) : filteredInvitations.length === 0 ? (
        <div className="card p-12 text-center no-print">
          <ClipboardList className="w-12 h-12 text-slate-300 mx-auto mb-4" />
          <h3 className="text-base font-semibold text-slate-900 mb-1">
            {invitations.length === 0 ? 'No completed assessments' : 'No matching candidates'}
          </h3>
          <p className="text-sm text-slate-500">
            {invitations.length === 0
              ? 'Completed assessments will appear here once candidates finish their quizzes.'
              : 'Try adjusting your search criteria.'}
          </p>
        </div>
      ) : (
        <>
          <div className="card overflow-hidden hidden md:block no-print">
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
                      <tr key={inv.id} className="hover:bg-slate-50 transition-colors">
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
                            onClick={() => generateReport(inv)}
                            disabled={reportLoading}
                            className="btn-primary text-xs px-3 py-1.5"
                          >
                            <FileText className="w-3.5 h-3.5" />
                            Generate Report
                          </button>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </div>

          <div className="md:hidden space-y-3 no-print">
            {filteredInvitations.map((inv) => {
              const rec = effectiveRecommendation(inv);
              const overridden = isOverridden(inv);
              return (
                <div key={inv.id} className="card p-4">
                  <div className="flex items-start justify-between mb-3">
                    <div>
                      <div className="font-medium text-slate-900">{inv.candidate_name}</div>
                      <div className="text-xs text-slate-500">{inv.candidate_email}</div>
                    </div>
                  </div>
                  {inv.qualification && (
                    <div className="text-xs text-slate-500 mb-2">
                      {inv.qualification.code} — {inv.qualification.name}
                    </div>
                  )}
                  <div className="flex items-center justify-between flex-wrap gap-2 mb-3">
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
                  <button
                    onClick={() => generateReport(inv)}
                    disabled={reportLoading}
                    className="btn-primary w-full text-sm"
                  >
                    <FileText className="w-4 h-4" />
                    Generate Report
                  </button>
                </div>
              );
            })}
          </div>
        </>
      )}

      {reportLoading && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/50 backdrop-blur-sm no-print">
          <div className="card p-8 flex flex-col items-center gap-3">
            <Loader2 className="w-8 h-8 animate-spin text-primary-600" />
            <p className="text-sm text-slate-600">Generating audit-ready report...</p>
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
        <ReportView
          data={reportData}
          onClose={closeReport}
          onPrint={handlePrint}
          onExportCSV={handleExportCSV}
        />
      )}
    </div>
  );
}

function CohortSummary({
  invitations,
  summary,
}: {
  invitations: InvitationWithQualification[];
  summary: {
    total: number;
    recCounts: Record<string, number>;
    acsfDistribution: Record<string, number>;
    verifiedCount: number;
    completionRate: number;
  };
}) {
  const recEntries = useMemo(() => {
    return (Object.keys(RECOMMENDATION_LABELS) as CourseRecommendation[]).map((key) => ({
      key,
      label: RECOMMENDATION_LABELS[key],
      count: summary.recCounts[key] || 0,
      color: RECOMMENDATION_COLORS[key],
    }));
  }, [summary]);

  const maxRecCount = Math.max(1, ...recEntries.map((e) => e.count));

  return (
    <div className="grid grid-cols-1 lg:grid-cols-3 gap-4 no-print">
      <div className="card p-5">
        <div className="flex items-center gap-2 mb-4">
          <div className="w-8 h-8 rounded-lg bg-primary-50 flex items-center justify-center">
            <Users className="w-4 h-4 text-primary-600" />
          </div>
          <h3 className="text-sm font-semibold text-slate-700">Completion Overview</h3>
        </div>
        <div className="space-y-3">
          <div>
            <div className="text-2xl font-bold text-slate-900 tabular-nums">{summary.total}</div>
            <div className="text-xs text-slate-500">Completed Candidates</div>
          </div>
          <div className="flex items-center gap-2">
            <div className="flex-1 h-2 rounded-full bg-slate-100 overflow-hidden">
              <div
                className="h-full bg-emerald-500 rounded-full"
                style={{ width: `${summary.total > 0 ? 100 : 0}%` }}
              />
            </div>
            <span className="text-xs font-medium text-slate-600 tabular-nums">
              {summary.completionRate.toFixed(0)}%
            </span>
          </div>
          <div className="flex items-center justify-between pt-2 border-t border-slate-100">
            <div className="flex items-center gap-1.5">
              <ShieldCheck className="w-4 h-4 text-emerald-600" />
              <span className="text-xs text-slate-600">Identity Verified</span>
            </div>
            <span className="text-sm font-semibold text-slate-900 tabular-nums">
              {summary.verifiedCount}/{summary.total}
            </span>
          </div>
        </div>
      </div>

      <div className="card p-5">
        <div className="flex items-center gap-2 mb-4">
          <div className="w-8 h-8 rounded-lg bg-amber-50 flex items-center justify-center">
            <PieChart className="w-4 h-4 text-amber-600" />
          </div>
          <h3 className="text-sm font-semibold text-slate-700">Recommendation Distribution</h3>
        </div>
        <div className="space-y-2.5">
          {recEntries.map((entry) => (
            <div key={entry.key}>
              <div className="flex items-center justify-between mb-1">
                <span className="text-xs text-slate-600">{entry.label}</span>
                <span className="text-xs font-semibold text-slate-900 tabular-nums">
                  {entry.count}
                </span>
              </div>
              <div className="h-2 rounded-full bg-slate-100 overflow-hidden">
                <div
                  className={`h-full rounded-full ${entry.color}`}
                  style={{ width: `${(entry.count / maxRecCount) * 100}%` }}
                />
              </div>
            </div>
          ))}
          {summary.recCounts.overridden > 0 && (
            <div className="flex items-center justify-between pt-2 border-t border-slate-100">
              <span className="text-xs text-slate-600 flex items-center gap-1">
                <AlertTriangle className="w-3.5 h-3.5 text-amber-500" />
                Trainer Overridden
              </span>
              <span className="text-xs font-semibold text-slate-900 tabular-nums">
                {summary.recCounts.overridden}
              </span>
            </div>
          )}
        </div>
      </div>

      <div className="card p-5">
        <div className="flex items-center gap-2 mb-4">
          <div className="w-8 h-8 rounded-lg bg-emerald-50 flex items-center justify-center">
            <BarChart3 className="w-4 h-4 text-emerald-600" />
          </div>
          <h3 className="text-sm font-semibold text-slate-700">Qualification Breakdown</h3>
        </div>
        <QualificationBreakdown invitations={invitations} />
      </div>
    </div>
  );
}

function QualificationBreakdown({ invitations }: { invitations: InvitationWithQualification[] }) {
  const qualCounts = useMemo(() => {
    const map = new Map<string, { code: string; name: string; count: number }>();
    for (const inv of invitations) {
      if (!inv.qualification) continue;
      const key = inv.qualification.id;
      const existing = map.get(key) || {
        code: inv.qualification.code,
        name: inv.qualification.name,
        count: 0,
      };
      existing.count++;
      map.set(key, existing);
    }
    return Array.from(map.values()).sort((a, b) => b.count - a.count);
  }, [invitations]);

  if (qualCounts.length === 0) {
    return <p className="text-xs text-slate-400">No qualification data available.</p>;
  }

  const maxCount = Math.max(1, ...qualCounts.map((q) => q.count));

  return (
    <div className="space-y-2.5">
      {qualCounts.slice(0, 5).map((q, idx) => (
        <div key={idx}>
          <div className="flex items-center justify-between mb-1">
            <span className="text-xs text-slate-600 truncate flex-1 mr-2">
              <span className="font-medium text-slate-700">{q.code}</span> · {q.name}
            </span>
            <span className="text-xs font-semibold text-slate-900 tabular-nums flex-shrink-0">
              {q.count}
            </span>
          </div>
          <div className="h-2 rounded-full bg-slate-100 overflow-hidden">
            <div
              className="h-full rounded-full bg-primary-500"
              style={{ width: `${(q.count / maxCount) * 100}%` }}
            />
          </div>
        </div>
      ))}
      {qualCounts.length > 5 && (
        <p className="text-xs text-slate-400 pt-1">
          +{qualCounts.length - 5} more qualifications
        </p>
      )}
    </div>
  );
}

function ReportView({
  data,
  onClose,
  onPrint,
  onExportCSV,
}: {
  data: ReportData;
  onClose: () => void;
  onPrint: () => void;
  onExportCSV: () => void;
}) {
  const { invitation, invAssessments, responses, auditTrail, supportPlans, interventionCases, orgBranding } = data;

  const responsesByAssessment = useMemo(() => {
    const map = new Map<string, ResponseWithQuestion[]>();
    for (const r of responses) {
      const list = map.get(r.assessment_id) || [];
      list.push(r);
      map.set(r.assessment_id, list);
    }
    return map;
  }, [responses]);

  const rec = effectiveRecommendation(invitation);
  const overridden = isOverridden(invitation);
  const systemRec = invitation.course_recommendation;
  const trainerComments = supportPlans
    .map((sp) => sp.trainer_comments)
    .filter(Boolean)
    .join('\n\n');

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
                Audit-Ready Report
              </h2>
              <p className="text-sm text-slate-500 truncate">
                {invitation.candidate_name} · {invitation.candidate_email}
              </p>
            </div>
          </div>
          <div className="flex items-center gap-2 flex-shrink-0">
            <button onClick={onExportCSV} className="btn-secondary text-xs px-3 py-1.5">
              <Download className="w-3.5 h-3.5" />
              Export CSV
            </button>
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
          <ReportHeader orgBranding={orgBranding} invitation={invitation} />

          <ReportStudentDetails invitation={invitation} />

          <ReportAssessmentSummary invAssessments={invAssessments} />

          <ReportSkillBreakdown invAssessments={invAssessments} />

          <ReportACSFMapping invAssessments={invAssessments} />

          <ReportCourseRecommendation
            invitation={invitation}
            rec={rec}
            overridden={overridden}
            systemRec={systemRec}
          />

          <ReportTrainerComments trainerComments={trainerComments} supportPlans={supportPlans} />

          <ReportEvidence
            invAssessments={invAssessments}
            responsesByAssessment={responsesByAssessment}
          />

          <ReportTimestamps invitation={invitation} />

          <ReportAuditTrail auditTrail={auditTrail} />

          <ReportInterventionSummary interventionCases={interventionCases} />

          <div className="pt-6 border-t border-slate-200 text-center">
            <p className="text-xs text-slate-400">
              Report generated on {formatDateTime(new Date().toISOString())} · ASQA Audit-Ready Format
            </p>
          </div>
        </div>
      </div>
    </div>
  );
}

function ReportSection({
  icon, title, children, action,
}: {
  icon: React.ReactNode;
  title: string;
  children: React.ReactNode;
  action?: React.ReactNode;
}) {
  return (
    <div className="card p-5">
      <div className="flex items-center justify-between mb-4">
        <div className="flex items-center gap-2">
          <div className="w-7 h-7 rounded-lg bg-slate-100 flex items-center justify-center">
            {icon}
          </div>
          <h3 className="text-sm font-semibold text-slate-800 uppercase tracking-wider">
            {title}
          </h3>
        </div>
        {action}
      </div>
      {children}
    </div>
  );
}

function ReportHeader({
  orgBranding,
  invitation,
}: {
  orgBranding: OrgBranding | null;
  invitation: InvitationWithQualification;
}) {
  return (
    <div className="card p-6 bg-slate-50 border-slate-300">
      <div className="flex items-start justify-between flex-wrap gap-4">
        <div className="flex items-center gap-4">
          {orgBranding?.logo_url ? (
            <img
              src={orgBranding.logo_url}
              alt={orgBranding.name}
              className="w-16 h-16 object-contain rounded-lg bg-white p-1 border border-slate-200"
            />
          ) : (
            <div className="w-16 h-16 rounded-lg bg-primary-600 flex items-center justify-center">
              <Building2 className="w-8 h-8 text-white" />
            </div>
          )}
          <div>
            <h1 className="text-xl font-bold text-slate-900">
              {orgBranding?.name || 'Registered Training Organisation'}
            </h1>
            {orgBranding?.rto_number && (
              <p className="text-sm text-slate-600">
                RTO Number: {orgBranding.rto_number}
              </p>
            )}
            <p className="text-xs text-slate-500 mt-1">
              LLND Automate Assessment Compliance Report
            </p>
          </div>
        </div>
        <div className="text-right">
          <div className="text-xs font-semibold text-slate-500 uppercase tracking-wider">
            Report ID
          </div>
          <div className="text-sm font-mono text-slate-700 mt-0.5">
            {invitation.id}
          </div>
          <div className="text-xs text-slate-500 mt-2">
            Generated: {formatDateTime(new Date().toISOString())}
          </div>
        </div>
      </div>
    </div>
  );
}

function ReportStudentDetails({ invitation }: { invitation: InvitationWithQualification }) {
  return (
    <ReportSection icon={<GraduationCap className="w-4 h-4 text-slate-600" />} title="Student Details">
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
        <div>
          <div className="text-xs font-semibold text-slate-500 uppercase tracking-wider mb-1">
            Candidate Name
          </div>
          <div className="text-sm font-medium text-slate-900">{invitation.candidate_name}</div>
        </div>
        <div>
          <div className="text-xs font-semibold text-slate-500 uppercase tracking-wider mb-1">
            Email
          </div>
          <div className="text-sm font-medium text-slate-900">{invitation.candidate_email}</div>
        </div>
        <div>
          <div className="text-xs font-semibold text-slate-500 uppercase tracking-wider mb-1">
            Qualification
          </div>
          <div className="text-sm font-medium text-slate-900">
            {invitation.qualification
              ? `${invitation.qualification.code} — ${invitation.qualification.name}`
              : 'Not specified'}
          </div>
        </div>
        <div>
          <div className="text-xs font-semibold text-slate-500 uppercase tracking-wider mb-1">
            Identity Verification
          </div>
          {invitation.identity_verified ? (
            <div className="flex items-center gap-2 flex-wrap">
              <span className="badge bg-emerald-100 text-emerald-700">
                <ShieldCheck className="w-3 h-3" />
                Verified
              </span>
              {invitation.identity_verification_method && (
                <span className="text-sm text-slate-700">
                  {invitation.identity_verification_method}
                </span>
              )}
              {invitation.identity_verified_at && (
                <span className="text-xs text-slate-500">
                  {formatDateTime(invitation.identity_verified_at)}
                </span>
              )}
            </div>
          ) : (
            <span className="badge bg-rose-100 text-rose-700">
              <ShieldAlert className="w-3 h-3" />
              Not Verified
            </span>
          )}
        </div>
      </div>
    </ReportSection>
  );
}

function ReportAssessmentSummary({
  invAssessments,
}: {
  invAssessments: InvitationAssessmentWithDetails[];
}) {
  if (invAssessments.length === 0) {
    return (
      <ReportSection icon={<ListChecks className="w-4 h-4 text-slate-600" />} title="Assessment Summary">
        <p className="text-sm text-slate-400">No assessment data available.</p>
      </ReportSection>
    );
  }

  return (
    <ReportSection icon={<ListChecks className="w-4 h-4 text-slate-600" />} title="Assessment Summary">
      <div className="overflow-x-auto">
        <table className="w-full">
          <thead className="bg-slate-50 border-b border-slate-200">
            <tr>
              <th className="table-header">Assessment</th>
              <th className="table-header">Type</th>
              <th className="table-header">Score</th>
              <th className="table-header">Threshold</th>
              <th className="table-header">Result</th>
              <th className="table-header">Completed</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-200">
            {invAssessments.map((ia) => {
              const title = ia.assessment?.title || 'Unknown Assessment';
              const type = ia.assessment?.type;
              const score = ia.individual_score != null ? Math.round(Number(ia.individual_score)) : null;
              const passed = ia.individual_passed;
              const threshold = ia.assessment?.pass_threshold;
              return (
                <tr key={ia.id}>
                  <td className="table-cell font-medium text-slate-900">{title}</td>
                  <td className="table-cell">
                    {type === 'lln' ? 'LLN' : type === 'digital' ? 'Digital Literacy' : type || '—'}
                  </td>
                  <td className="table-cell tabular-nums font-medium">
                    {score != null ? `${score}%` : '—'}
                  </td>
                  <td className="table-cell tabular-nums">
                    {threshold != null ? `${threshold}%` : '—'}
                  </td>
                  <td className="table-cell">
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
                      <span className="badge bg-slate-100 text-slate-500">Pending</span>
                    )}
                  </td>
                  <td className="table-cell text-slate-600">
                    {formatDateTime(ia.individual_completed_at)}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </ReportSection>
  );
}

function ReportSkillBreakdown({
  invAssessments,
}: {
  invAssessments: InvitationAssessmentWithDetails[];
}) {
  const hasOutcomes = invAssessments.some(
    (ia) => ia.acsf_outcomes && Object.keys(ia.acsf_outcomes).length > 0
  );

  return (
    <ReportSection icon={<BookOpen className="w-4 h-4 text-slate-600" />} title="Skill Breakdown (ACSF Outcomes per Domain)">
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
                        className="flex items-center justify-between p-3 rounded-lg bg-slate-50 border border-slate-200"
                      >
                        <div className="flex items-center gap-2 min-w-0">
                          <BookOpen className="w-3.5 h-3.5 text-slate-400 flex-shrink-0" />
                          <span className="text-sm text-slate-600 truncate">{label}</span>
                        </div>
                        <span className="badge bg-primary-100 text-primary-700 tabular-nums flex-shrink-0">
                          <Hash className="w-3 h-3" />
                          {acsfLevelLabel(lvl)}
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
    </ReportSection>
  );
}

function ReportACSFMapping({
  invAssessments,
}: {
  invAssessments: InvitationAssessmentWithDetails[];
}) {
  const mappingRows = useMemo(() => {
    const rows: { assessment: string; domain: string; skill: string; level: number }[] = [];
    for (const ia of invAssessments) {
      const title = ia.assessment?.title || 'Assessment';
      const outcomes = ia.acsf_outcomes || {};
      for (const [domain, level] of Object.entries(outcomes)) {
        const label = DOMAIN_LABELS[domain as Domain] || domain;
        rows.push({
          assessment: title,
          domain: label,
          skill: '—',
          level: Number(level),
        });
      }
    }
    return rows;
  }, [invAssessments]);

  return (
    <ReportSection icon={<TrendingUp className="w-4 h-4 text-slate-600" />} title="ACSF Level Mapping">
      {mappingRows.length === 0 ? (
        <p className="text-sm text-slate-400">No ACSF mapping data available.</p>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full">
            <thead className="bg-slate-50 border-b border-slate-200">
              <tr>
                <th className="table-header">Assessment</th>
                <th className="table-header">Domain</th>
                <th className="table-header">ACSF Level</th>
                <th className="table-header">Description</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-200">
              {mappingRows.map((row, idx) => (
                <tr key={idx}>
                  <td className="table-cell font-medium text-slate-700">{row.assessment}</td>
                  <td className="table-cell text-slate-700">{row.domain}</td>
                  <td className="table-cell">
                    <span className="badge bg-primary-100 text-primary-700 tabular-nums">
                      <Hash className="w-3 h-3" />
                      {acsfLevelLabel(row.level)}
                    </span>
                  </td>
                  <td className="table-cell text-slate-600 text-xs">
                    {acsfLevelDescription(row.level)}
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

function acsfLevelDescription(level: number): string {
  const descriptions: Record<number, string> = {
    1: 'Foundation level — highly scaffolded, familiar contexts',
    2: 'Basic level — simple, familiar contexts with support',
    3: 'Intermediate — routine tasks, some independence',
    4: 'Competent — complex tasks, independent performance',
    5: 'Advanced — complex, unfamiliar contexts, high autonomy',
  };
  return descriptions[level] || '';
}

function ReportCourseRecommendation({
  invitation, rec, overridden, systemRec,
}: {
  invitation: AssessmentInvitation;
  rec: CourseRecommendation | null;
  overridden: boolean;
  systemRec: CourseRecommendation | null;
}) {
  return (
    <ReportSection icon={<Award className="w-4 h-4 text-slate-600" />} title="Course Suitability Recommendation">
      <div className="space-y-4">
        <div className="flex items-center gap-3 flex-wrap">
          <span className="text-sm text-slate-500">Effective Recommendation:</span>
          {rec ? (
            <span className={`badge text-sm px-3 py-1 ${RECOMMENDATION_COLORS[rec]}`}>
              <Award className="w-3.5 h-3.5" />
              {RECOMMENDATION_LABELS[rec]}
            </span>
          ) : (
            <span className="text-sm text-slate-400">No recommendation</span>
          )}
          {overridden && systemRec && (
            <span className="text-xs text-slate-400">
              (System recommended: {RECOMMENDATION_LABELS[systemRec]})
            </span>
          )}
        </div>

        {(invitation as any).qualification && (
          <div>
            <div className="text-xs font-semibold text-slate-500 uppercase tracking-wider mb-1">
              Target Qualification
            </div>
            <div className="text-sm text-slate-700">
              {(invitation as any).qualification.code} — {(invitation as any).qualification.name}
            </div>
          </div>
        )}

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
          <div className="p-4 rounded-lg bg-amber-50 border border-amber-200">
            <div className="flex items-center gap-2 mb-1">
              <AlertTriangle className="w-4 h-4 text-amber-600" />
              <div className="text-xs font-semibold text-amber-700 uppercase tracking-wider">
                Trainer Override
              </div>
            </div>
            <p className="text-sm text-slate-700">{invitation.trainer_override_reason}</p>
            {invitation.trainer_override_at && (
              <p className="text-xs text-slate-500 mt-2">
                {formatDateTime(invitation.trainer_override_at)}
              </p>
            )}
          </div>
        )}
      </div>
    </ReportSection>
  );
}

function ReportTrainerComments({
  trainerComments,
  supportPlans,
}: {
  trainerComments: string;
  supportPlans: SupportPlan[];
}) {
  return (
    <ReportSection icon={<FileText className="w-4 h-4 text-slate-600" />} title="Trainer Comments">
      {trainerComments ? (
        <div className="space-y-3">
          {supportPlans
            .filter((sp) => sp.trainer_comments)
            .map((sp, idx) => (
              <div key={idx} className="p-3 rounded-lg bg-slate-50 border border-slate-200">
                <div className="text-xs text-slate-500 mb-1">
                  {sp.status === 'approved' ? 'Approved Plan' : 'Draft Plan'} · {formatDateTime(sp.updated_at)}
                </div>
                <p className="text-sm text-slate-700 whitespace-pre-wrap">{sp.trainer_comments}</p>
              </div>
            ))}
        </div>
      ) : (
        <p className="text-sm text-slate-400">No trainer comments recorded.</p>
      )}
    </ReportSection>
  );
}

function ReportEvidence({
  invAssessments,
  responsesByAssessment,
}: {
  invAssessments: InvitationAssessmentWithDetails[];
  responsesByAssessment: Map<string, ResponseWithQuestion[]>;
}) {
  const hasResponses = Array.from(responsesByAssessment.values()).some((list) => list.length > 0);

  return (
    <ReportSection icon={<ClipboardList className="w-4 h-4 text-slate-600" />} title="Evidence Used (Question Responses)">
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
                      <div key={r.id} className="p-3 rounded-lg border border-slate-200 bg-white">
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
                          {r.submitted_at && (
                            <div>
                              <span className="text-slate-400">Submitted: </span>
                              <span className="font-medium text-slate-700">
                                {formatDateTime(r.submitted_at)}
                              </span>
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
    </ReportSection>
  );
}

function ReportTimestamps({ invitation }: { invitation: AssessmentInvitation }) {
  const timestamps = [
    { label: 'Invitation Sent', value: invitation.sent_at, icon: <Mail className="w-3.5 h-3.5" /> },
    { label: 'Invitation Opened', value: invitation.opened_at, icon: <Mail className="w-3.5 h-3.5" /> },
    { label: 'Assessment Started', value: invitation.started_at, icon: <Clock className="w-3.5 h-3.5" /> },
    { label: 'Assessment Completed', value: invitation.completed_at, icon: <CheckCircle2 className="w-3.5 h-3.5" /> },
  ];

  return (
    <ReportSection icon={<Clock className="w-4 h-4 text-slate-600" />} title="Assessment Timestamps">
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-3">
        {timestamps.map((ts) => (
          <div key={ts.label} className="p-3 rounded-lg bg-slate-50 border border-slate-200">
            <div className="flex items-center gap-1.5 mb-1">
              {ts.icon}
              <span className="text-xs font-semibold text-slate-500 uppercase tracking-wider">
                {ts.label}
              </span>
            </div>
            <div className="text-sm font-medium text-slate-900">
              {formatDateTime(ts.value)}
            </div>
          </div>
        ))}
      </div>
    </ReportSection>
  );
}

function ReportAuditTrail({ auditTrail }: { auditTrail: AuditTrailEntry[] }) {
  return (
    <ReportSection
      icon={<History className="w-4 h-4 text-slate-600" />}
      title="Digital Audit Trail"
    >
      {auditTrail.length === 0 ? (
        <p className="text-sm text-slate-400">No audit trail events recorded.</p>
      ) : (
        <div className="space-y-2">
          {auditTrail.map((entry) => (
            <div
              key={entry.id}
              className="flex items-start gap-3 p-3 rounded-lg border border-slate-200 bg-white"
            >
              <div className="flex flex-col items-center flex-shrink-0">
                <div className="w-2 h-2 rounded-full bg-primary-500 mt-1.5" />
              </div>
              <div className="flex-1 min-w-0">
                <div className="flex items-center justify-between gap-2 flex-wrap">
                  <div className="flex items-center gap-2">
                    <span className="text-sm font-medium text-slate-900">
                      {entry.event_type}
                    </span>
                    <span className="badge bg-slate-100 text-slate-600 text-[10px]">
                      {entry.actor}
                    </span>
                  </div>
                  <span className="text-xs text-slate-500 tabular-nums">
                    {formatDateTime(entry.timestamp)}
                  </span>
                </div>
                {entry.event_data && Object.keys(entry.event_data).length > 0 && (
                  <pre className="mt-1.5 text-xs text-slate-500 bg-slate-50 p-2 rounded border border-slate-100 overflow-x-auto">
                    {JSON.stringify(entry.event_data, null, 2)}
                  </pre>
                )}
                {entry.ip_address && (
                  <div className="text-xs text-slate-400 mt-1">
                    IP: {entry.ip_address}
                  </div>
                )}
              </div>
            </div>
          ))}
        </div>
      )}
    </ReportSection>
  );
}

function ReportInterventionSummary({
  interventionCases,
}: {
  interventionCases: InterventionCase[];
}) {
  if (interventionCases.length === 0) {
    return (
      <ReportSection icon={<AlertTriangle className="w-4 h-4 text-slate-600" />} title="Intervention Summary">
        <p className="text-sm text-slate-400">No intervention cases recorded for this candidate.</p>
      </ReportSection>
    );
  }

  return (
    <ReportSection icon={<AlertTriangle className="w-4 h-4 text-slate-600" />} title="Intervention Summary">
      <div className="space-y-3">
        {interventionCases.map((ic) => (
          <div key={ic.id} className="p-4 rounded-lg border border-slate-200 bg-white">
            <div className="flex items-center justify-between mb-3 flex-wrap gap-2">
              <div className="flex items-center gap-2">
                <span className="text-sm font-medium text-slate-900">
                  Case {ic.id.slice(0, 8)}
                </span>
                <span className={`badge ${
                  ic.status === 'open' ? 'bg-amber-100 text-amber-700' :
                  ic.status === 'scheduled_reassessment' ? 'bg-blue-100 text-blue-700' :
                  'bg-slate-100 text-slate-600'
                }`}>
                  {ic.status.replace(/_/g, ' ')}
                </span>
              </div>
              <span className="text-xs text-slate-500">
                Opened: {formatDateTime(ic.opened_at)}
              </span>
            </div>
            {ic.trigger_reason && (
              <div className="mb-2">
                <div className="text-xs font-semibold text-slate-500 uppercase tracking-wider mb-1">
                  Trigger Reason
                </div>
                <p className="text-sm text-slate-700">{ic.trigger_reason}</p>
              </div>
            )}
            {ic.closing_summary && (
              <div className="mb-2">
                <div className="text-xs font-semibold text-slate-500 uppercase tracking-wider mb-1">
                  Closing Summary
                </div>
                <p className="text-sm text-slate-700">{ic.closing_summary}</p>
              </div>
            )}
            {ic.closed_at && (
              <div className="text-xs text-slate-500">
                Closed: {formatDateTime(ic.closed_at)}
              </div>
            )}
          </div>
        ))}
      </div>
    </ReportSection>
  );
}
