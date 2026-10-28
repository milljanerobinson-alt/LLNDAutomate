import { useEffect, useState, useMemo, useRef } from 'react';
import {
  Users, Mail, Plus, Search, Send, Bell, Eye, PlayCircle,
  CheckCircle2, X, Calendar, Loader2, Pencil, Trash2,
  BookOpen, Monitor, Copy, Check, GraduationCap, Clock,
  Activity, ChevronRight, MoreHorizontal, FileCheck, Ban,
} from 'lucide-react';
import { supabase } from '../lib/supabase';
import type {
  AssessmentInvitation, Assessment, Qualification,
  StudentLifecycleEvent,
} from '../lib/types';
import { STATUS_COLORS, STUDENT_STATUS_CONFIG, RECOMMENDATION_LABELS, RECOMMENDATION_COLORS } from '../lib/types';
import { logAudit, enqueueAxcelerateWriteback } from '../lib/audit';

type StudentTab = 'in_progress' | 'completed';

interface InvitationWithQualification extends AssessmentInvitation {
  qualification: Pick<Qualification, 'id' | 'code' | 'name'> | null;
}

interface NewInvitationForm {
  candidateName: string;
  candidateEmail: string;
  candidateDob: string;
  qualificationId: string;
  dueDate: string;
  selectedAssessmentIds: string[];
}

const EMPTY_FORM: NewInvitationForm = {
  candidateName: '',
  candidateEmail: '',
  candidateDob: '',
  qualificationId: '',
  dueDate: '',
  selectedAssessmentIds: [],
};

function generateToken(): string {
  return crypto.randomUUID();
}

function formatDate(dateStr: string | null): string {
  if (!dateStr) return '—';
  return new Date(dateStr).toLocaleDateString('en-AU', {
    day: 'numeric', month: 'short', year: 'numeric',
  });
}

function formatDateTime(dateStr: string | null): string {
  if (!dateStr) return '—';
  return new Date(dateStr).toLocaleString('en-AU', {
    day: 'numeric', month: 'short', year: 'numeric',
    hour: '2-digit', minute: '2-digit',
  });
}

function isOverdue(inv: AssessmentInvitation): boolean {
  if (!inv.due_date || inv.status === 'completed') return false;
  return new Date(inv.due_date) < new Date();
}

function isCompleted(inv: InvitationWithQualification): boolean {
  // Terminal statuses always belong in the completed tab
  if (inv.status === 'support_generated' || inv.status === 'closed') return true;

  // When both quizzes were sent, require both to be individually complete
  if (inv.lln_token && inv.digital_token) {
    return inv.lln_status === 'completed' && inv.digital_status === 'completed';
  }

  // Single quiz or legacy invitation
  return inv.status === 'completed' || inv.course_recommendation !== null;
}

function buildAssessmentLinks(inv: AssessmentInvitation): { portal: string; lln?: string; digital?: string; legacy?: string } {
  const origin = window.location.origin;
  const links: { portal: string; lln?: string; digital?: string; legacy?: string } = {
    portal: `${origin}/#/student/${inv.unique_token}`,
  };
  if (inv.lln_token) links.lln = `${origin}/#/lln/${inv.lln_token}`;
  if (inv.digital_token) links.digital = `${origin}/#/digital/${inv.digital_token}`;
  if (!links.lln && !links.digital) links.legacy = `${origin}/#/quiz/${inv.unique_token}`;
  return links;
}

function CopyButton({ text }: { text: string }) {
  const [copied, setCopied] = useState(false);
  async function copy() {
    await navigator.clipboard.writeText(text);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  }
  return (
    <button onClick={copy} className="btn-ghost text-xs px-1.5 py-1" title="Copy link">
      {copied ? <Check className="w-3.5 h-3.5 text-emerald-600" /> : <Copy className="w-3.5 h-3.5" />}
    </button>
  );
}

function StatusBadge({ status }: { status: string }) {
  const cfg = STUDENT_STATUS_CONFIG[status as keyof typeof STUDENT_STATUS_CONFIG];
  if (cfg) {
    return (
      <span className={`inline-flex items-center gap-1.5 px-2 py-0.5 rounded-full text-xs font-medium ${cfg.color}`}>
        <span className={`w-1.5 h-1.5 rounded-full ${cfg.dotColor}`} />
        {cfg.label}
      </span>
    );
  }
  const color = STATUS_COLORS[status as keyof typeof STATUS_COLORS] ?? 'bg-slate-100 text-slate-600';
  return (
    <span className={`inline-flex items-center gap-1.5 px-2 py-0.5 rounded-full text-xs font-medium ${color}`}>
      <span className="w-1.5 h-1.5 rounded-full bg-current opacity-60" />
      {status.replace(/_/g, ' ')}
    </span>
  );
}

function AssessmentPills({ inv }: { inv: AssessmentInvitation }) {
  const hasBoth = !!(inv.lln_token && inv.digital_token);

  function quizStatusBadge(
    type: 'LLN' | 'Digital',
    status: string | null,
  ) {
    const label =
      status === 'completed' ? 'Complete' :
      status === 'in_progress' ? 'In Progress' :
      'Pending';
    const color =
      status === 'completed' ? 'bg-teal-100 text-teal-700' :
      status === 'in_progress' ? 'bg-amber-100 text-amber-700' :
      'bg-slate-100 text-slate-500';
    const Icon = type === 'LLN' ? BookOpen : Monitor;
    return (
      <span key={type} className={`inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-[11px] font-medium ${color}`}>
        <Icon className="w-2.5 h-2.5" />
        {hasBoth ? `${type}: ${label}` : label}
      </span>
    );
  }

  return (
    <div className="flex flex-col gap-1">
      {inv.lln_token && quizStatusBadge('LLN', inv.lln_status)}
      {inv.digital_token && quizStatusBadge('Digital', inv.digital_status)}
    </div>
  );
}

function ActivityTimelineModal({
  invitation,
  onClose,
}: {
  invitation: InvitationWithQualification;
  onClose: () => void;
}) {
  const [events, setEvents] = useState<StudentLifecycleEvent[]>([]);
  const [auditEvents, setAuditEvents] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    loadTimeline();
  }, []);

  async function loadTimeline() {
    setLoading(true);

    if (invitation.student_id) {
      const { data } = await supabase
        .from('student_lifecycle_events')
        .select('*')
        .eq('student_id', invitation.student_id)
        .order('created_at', { ascending: false });
      if (data && data.length > 0) {
        setEvents(data as StudentLifecycleEvent[]);
      } else {
        // Fall back to audit_trail when lifecycle events aren't populated yet
        const { data: auditData } = await supabase
          .from('audit_trail')
          .select('*')
          .eq('invitation_id', invitation.id)
          .order('timestamp', { ascending: false })
          .limit(20);
        setAuditEvents(auditData || []);
      }
    } else {
      const { data } = await supabase
        .from('audit_trail')
        .select('*')
        .eq('invitation_id', invitation.id)
        .order('timestamp', { ascending: false })
        .limit(20);
      setAuditEvents(data || []);
    }

    setLoading(false);
  }

  const labelMap: Record<string, string> = {
    'contact.created': 'Contact created',
    'lln.sent': 'LLN quiz sent',
    'digital.sent': 'Digital quiz sent',
    'lln_digital.sent': 'LLN quiz & Digital quiz sent',
    'invitation.sent': 'Invitation sent',
    'reminder.sent': 'Reminder sent',
    'invitation.created': 'Invitation created',
    'email.invitation.failed': 'Invitation email failed',
    'axcelerate.inbound_sync.created': 'Synced from aXcelerate',
    'lln.abandoned': 'LLN quiz abandoned',
    'digital.abandoned': 'Digital quiz abandoned',
    'lln.declaration_accepted': 'LLN declaration agreed',
    'digital.declaration_accepted': 'Digital declaration agreed',
  };
  const colorMap: Record<string, string> = {
    'contact.created': 'bg-emerald-500',
    'lln.sent': 'bg-blue-500',
    'digital.sent': 'bg-violet-500',
    'lln_digital.sent': 'bg-blue-500',
    'invitation.sent': 'bg-blue-500',
    'reminder.sent': 'bg-amber-500',
    'email.invitation.failed': 'bg-rose-400',
    'axcelerate.inbound_sync.created': 'bg-teal-500',
    'lln.abandoned': 'bg-orange-400',
    'digital.abandoned': 'bg-orange-400',
    'lln.declaration_accepted': 'bg-emerald-500',
    'digital.declaration_accepted': 'bg-teal-500',
  };

  const timelineItems = events.length > 0
    ? events.map((e: any) => ({
        id: e.id,
        label: e.event_type.replace(/_/g, ' '),
        detail: e.description ?? '',
        time: e.created_at,
        actor: (e.metadata as any)?.actor ?? 'system',
        color: 'bg-slate-400',
        progress: undefined as number | undefined,
      }))
    : auditEvents.map((e) => ({
        id: e.id,
        label: labelMap[e.event_type] ?? e.event_type.replace(/\./g, ' › '),
        detail: e.description ?? '',
        time: e.timestamp,
        actor: e.actor ?? 'system',
        color: colorMap[e.event_type] ?? 'bg-slate-400',
        progress: (e.event_type === 'lln.abandoned' || e.event_type === 'digital.abandoned')
          ? ((e.event_data as any)?.progress_percent as number | undefined)
          : undefined,
      }));

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-slate-900/50 backdrop-blur-sm">
      <div className="card w-full max-w-lg max-h-[85vh] flex flex-col">
        <div className="flex items-center justify-between p-5 border-b border-slate-200">
          <div>
            <h2 className="text-lg font-bold text-slate-900">Activity Timeline</h2>
            <p className="text-sm text-slate-500 mt-0.5">{invitation.candidate_name}</p>
          </div>
          <button onClick={onClose} className="btn-ghost p-1.5"><X className="w-5 h-5" /></button>
        </div>

        <div className="flex-1 overflow-y-auto p-5">
          {loading ? (
            <div className="flex items-center justify-center py-12 text-slate-400">
              <Loader2 className="w-5 h-5 animate-spin mr-2" /> Loading timeline...
            </div>
          ) : timelineItems.length === 0 ? (
            <div className="text-center py-12 text-slate-400">
              <Clock className="w-8 h-8 mx-auto mb-2 opacity-40" />
              <p className="text-sm">No activity recorded yet.</p>
            </div>
          ) : (
            <div className="relative">
              <div className="absolute left-3.5 top-0 bottom-0 w-px bg-slate-200" />
              <div className="space-y-5">
                {timelineItems.map((item) => (
                  <div key={item.id} className="relative flex gap-4 pl-10">
                    <div className={`absolute left-0 w-7 h-7 rounded-full flex items-center justify-center ${item.color}`}>
                      <Activity className="w-3 h-3 text-white" />
                    </div>
                    <div className="flex-1 min-w-0 pt-0.5">
                      <p className="text-sm font-medium text-slate-800 capitalize">{item.label}</p>
                      {item.detail && <p className="text-xs text-slate-500 mt-0.5">{item.detail}</p>}
                      {item.progress !== undefined && (
                        <div className="mt-1.5 flex items-center gap-2">
                          <div className="flex-1 h-1.5 bg-slate-200 rounded-full overflow-hidden">
                            <div
                              className="h-full bg-orange-400 rounded-full transition-all"
                              style={{ width: `${item.progress}%` }}
                            />
                          </div>
                          <span className="text-xs font-medium text-orange-600 shrink-0">{item.progress}%</span>
                        </div>
                      )}
                      <p className="text-xs text-slate-400 mt-1">{formatDateTime(item.time)} · {item.actor}</p>
                    </div>
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

// ─── Admin quick-action dropdown ──────────────────────────────────────────────

function RowActionsDropdown({ inv, onEnqueued }: {
  inv: InvitationWithQualification;
  onEnqueued: (msg: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    function handleOutside(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    }
    if (open) document.addEventListener('mousedown', handleOutside);
    return () => document.removeEventListener('mousedown', handleOutside);
  }, [open]);

  async function enqueue(eventType: string, label: string) {
    setBusy(true);
    setOpen(false);
    try {
      await supabase.from('axcelerate_writeback_queue').upsert(
        {
          invitation_id: inv.id,
          event_type: eventType,
          status: 'pending',
          attempts: 0,
          idempotency_key: `${inv.id}:${eventType}`,
          extra_data: { triggered_by: 'admin', triggered_at: new Date().toISOString() },
        },
        { onConflict: 'idempotency_key', ignoreDuplicates: true },
      );
      onEnqueued(`"${label}" queued for ${inv.candidate_name}`);
    } catch (e: any) {
      onEnqueued(`Failed to queue event: ${e.message}`);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="relative" ref={ref}>
      <button
        onClick={() => setOpen((s) => !s)}
        disabled={busy}
        className="btn-ghost text-xs px-2 py-1"
        title="More actions"
      >
        {busy ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <MoreHorizontal className="w-3.5 h-3.5" />}
      </button>
      {open && (
        <div className="absolute right-0 top-full mt-1 z-30 bg-white border border-slate-200 rounded-xl shadow-lg py-1 w-56">
          <p className="px-3 py-1 text-[10px] font-semibold text-slate-400 uppercase tracking-wider">aXcelerate note</p>
          <button
            onClick={() => enqueue('report_found_no_resend', 'Report found — no resend')}
            className="w-full text-left flex items-center gap-2.5 px-3 py-2 text-sm text-slate-700 hover:bg-slate-50 transition-colors"
          >
            <FileCheck className="w-3.5 h-3.5 text-teal-500 shrink-0" />
            Report found — no resend
          </button>
          <button
            onClick={() => enqueue('no_lln_required', 'No LLN/Digital required')}
            className="w-full text-left flex items-center gap-2.5 px-3 py-2 text-sm text-slate-700 hover:bg-slate-50 transition-colors"
          >
            <Ban className="w-3.5 h-3.5 text-slate-400 shrink-0" />
            No LLN/Digital required
          </button>
        </div>
      )}
    </div>
  );
}

export function CandidatesPage() {
  const [invitations, setInvitations] = useState<InvitationWithQualification[]>([]);
  const [qualifications, setQualifications] = useState<Qualification[]>([]);
  const [assessments, setAssessments] = useState<Assessment[]>([]);
  const [loading, setLoading] = useState(true);
  const [activeTab, setActiveTab] = useState<StudentTab>('in_progress');
  const [showModal, setShowModal] = useState(false);
  const [editingInvitation, setEditingInvitation] = useState<InvitationWithQualification | null>(null);
  const [timelineInvitation, setTimelineInvitation] = useState<InvitationWithQualification | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [deletingId, setDeletingId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [form, setForm] = useState<NewInvitationForm>(EMPTY_FORM);
  const [searchQuery, setSearchQuery] = useState('');
  const [remindingId, setRemindingId] = useState<string | null>(null);
  const [orgName, setOrgName] = useState<string>('');
  const [enqueueMsg, setEnqueueMsg] = useState<string | null>(null);

  useEffect(() => { loadData(); }, []);

  async function loadData() {
    setLoading(true);
    const [invRes, qualRes, assessRes, settingsRes] = await Promise.all([
      supabase
        .from('assessment_invitations')
        .select('*, qualification:qualifications(id, code, name)')
        .order('created_at', { ascending: false }),
      supabase.from('qualifications').select('*').eq('active', true).order('name'),
      supabase.from('assessments').select('*').eq('status', 'active').order('title'),
      supabase.from('organisation_settings').select('key, value').eq('key', 'org_branding').maybeSingle(),
    ]);

    if (invRes.error) {
      setError(invRes.error.message);
    } else {
      setInvitations((invRes.data || []) as InvitationWithQualification[]);
    }
    setQualifications((qualRes.data || []) as Qualification[]);
    setAssessments((assessRes.data || []) as Assessment[]);
    if (settingsRes.data?.value) {
      setOrgName((settingsRes.data.value as any)?.name || '');
    }
    setLoading(false);
  }

  const { inProgress, completed } = useMemo(() => {
    const q = searchQuery.toLowerCase();
    const filtered = invitations.filter((inv) => {
      if (!q) return true;
      return inv.candidate_name.toLowerCase().includes(q) || inv.candidate_email.toLowerCase().includes(q);
    });
    return {
      inProgress: filtered.filter((inv) => !isCompleted(inv)),
      completed: filtered.filter((inv) => isCompleted(inv)),
    };
  }, [invitations, searchQuery]);

  const tabItems = activeTab === 'in_progress' ? inProgress : completed;

  function toggleAssessment(id: string) {
    setForm((prev) => {
      const ids = prev.selectedAssessmentIds;
      return { ...prev, selectedAssessmentIds: ids.includes(id) ? ids.filter((a) => a !== id) : [...ids, id] };
    });
  }

  function resetForm() { setForm(EMPTY_FORM); setError(null); }
  function closeModal() { setShowModal(false); setEditingInvitation(null); resetForm(); }

  async function openEdit(inv: InvitationWithQualification) {
    const { data } = await supabase
      .from('invitation_assessments').select('assessment_id').eq('invitation_id', inv.id);
    const selectedIds = (data || []).map((r: any) => r.assessment_id as string);
    setForm({
      candidateName: inv.candidate_name,
      candidateEmail: inv.candidate_email,
      candidateDob: inv.candidate_dob ? inv.candidate_dob.slice(0, 10) : '',
      qualificationId: inv.qualification_id || '',
      dueDate: inv.due_date ? inv.due_date.slice(0, 10) : '',
      selectedAssessmentIds: selectedIds,
    });
    setEditingInvitation(inv);
    setShowModal(true);
  }

  async function handleDelete(inv: InvitationWithQualification) {
    const axNote = inv.axcelerate_contact_id
      ? `\n\nNote: this candidate was synced from aXcelerate (ID ${inv.axcelerate_contact_id}). You must also remove or inactivate the contact in aXcelerate, or clear the quiz flags — otherwise the sync will recreate this invitation automatically.`
      : '';
    if (!confirm(`Delete invitation for ${inv.candidate_name}?${axNote}\n\nThis action cannot be undone.`)) return;
    setDeletingId(inv.id);
    const { error: delErr } = await supabase.from('assessment_invitations').delete().eq('id', inv.id);
    if (delErr) {
      setError(delErr.message);
    } else {
      if (inv.axcelerate_contact_id) {
        await supabase.from('axcelerate_inbound_sync_log').delete().eq('axcelerate_contact_id', inv.axcelerate_contact_id);
      }
      logAudit({
        event_type: 'invitation.cancelled',
        category: 'candidate_management',
        description: `Invitation for ${inv.candidate_name} (${inv.candidate_email}) deleted`,
        severity: 'warning',
        source: 'admin',
        invitation_id: inv.id,
        qualification_id: inv.qualification_id ?? null,
        event_data: { candidate_name: inv.candidate_name, candidate_email: inv.candidate_email },
      });
      setInvitations((prev) => prev.filter((i) => i.id !== inv.id));
    }
    setDeletingId(null);
  }

  async function scheduleReminders(
    invitationId: string, recipientEmail: string, recipientName: string,
    portalUrl: string, dueDate: string | null,
  ) {
    try {
      const { data: settingsRow } = await supabase.from('organisation_settings').select('value').eq('key', 'email_settings').maybeSingle();
      const emailSettings = (settingsRow?.value as Record<string, unknown>) ?? {};
      const now = Date.now();
      const r1Hours = typeof emailSettings.reminder_1_hours === 'number' ? emailSettings.reminder_1_hours : 48;
      const r2Days = typeof emailSettings.reminder_2_days === 'number' ? emailSettings.reminder_2_days : 5;
      const r3Days = typeof emailSettings.reminder_3_days === 'number' ? emailSettings.reminder_3_days : 7;
      const extras = { portal_url: portalUrl, due_date: dueDate || undefined };
      const rows = [
        { email_type: 'reminder_1', scheduled_at: new Date(now + r1Hours * 3_600_000).toISOString(), key: `${invitationId}:reminder_1`, enabled: emailSettings.send_reminder_1 !== false },
        { email_type: 'reminder_2', scheduled_at: new Date(now + r2Days * 86_400_000).toISOString(), key: `${invitationId}:reminder_2`, enabled: emailSettings.send_reminder_2 !== false },
        { email_type: 'reminder_3', scheduled_at: new Date(now + r3Days * 86_400_000).toISOString(), key: `${invitationId}:reminder_3`, enabled: emailSettings.send_reminder_3 !== false },
      ]
        .filter((r) => r.enabled)
        .map(({ email_type, scheduled_at, key }) => ({
          invitation_id: invitationId, email_type, recipient_email: recipientEmail,
          recipient_name: recipientName, scheduled_at, idempotency_key: key, extra_data: extras,
        }));
      if (rows.length > 0) {
        await supabase.from('email_queue').upsert(rows, { onConflict: 'idempotency_key', ignoreDuplicates: true });
      }
    } catch (e) {
      console.warn('[email-queue] Failed to schedule reminders:', e);
    }
  }

  async function callSendEmail(payload: Record<string, unknown>): Promise<{ ok: boolean; message?: string }> {
    try {
      const { data: { session } } = await supabase.auth.getSession();
      if (!session?.access_token) return { ok: false, message: 'No active session' };
      const res = await fetch(`${import.meta.env.VITE_SUPABASE_URL}/functions/v1/send-email`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${session.access_token}`,
          'Apikey': import.meta.env.VITE_SUPABASE_ANON_KEY,
        },
        body: JSON.stringify(payload),
      });
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        return { ok: false, message: (err as any).error || `HTTP ${res.status}` };
      }
      return { ok: true };
    } catch (e: any) {
      return { ok: false, message: e.message };
    }
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    if (!form.qualificationId) { setError('Please select a qualification.'); return; }
    if (form.selectedAssessmentIds.length === 0) { setError('Please select at least one assessment.'); return; }
    setSubmitting(true);

    try {
      if (editingInvitation) {
        const { error: updateError } = await supabase
          .from('assessment_invitations')
          .update({
            candidate_name: form.candidateName.trim(),
            candidate_email: form.candidateEmail.trim(),
            qualification_id: form.qualificationId || null,
            due_date: form.dueDate || null,
          })
          .eq('id', editingInvitation.id);
        if (updateError) throw updateError;

        logAudit({
          event_type: 'invitation.edited', category: 'candidate_management',
          description: `Invitation for ${form.candidateName.trim()} updated`,
          source: 'admin', invitation_id: editingInvitation.id,
          qualification_id: form.qualificationId || null,
          previous_values: { candidate_name: editingInvitation.candidate_name, candidate_email: editingInvitation.candidate_email, due_date: editingInvitation.due_date },
          new_values: { candidate_name: form.candidateName.trim(), candidate_email: form.candidateEmail.trim(), due_date: form.dueDate || null },
        });

        await supabase.from('invitation_assessments').delete().eq('invitation_id', editingInvitation.id);
        const rows = form.selectedAssessmentIds.map((assessmentId) => ({
          invitation_id: editingInvitation.id, assessment_id: assessmentId,
          individual_status: 'pending' as const, individual_score: null, individual_passed: null,
          individual_completed_at: null, acsf_outcomes: {},
        }));
        if (rows.length > 0) {
          const { error: iaError } = await supabase.from('invitation_assessments').insert(rows);
          if (iaError) throw iaError;
        }
      } else {
        const { data: { user } } = await supabase.auth.getUser();
        const token = generateToken();
        const now = new Date().toISOString();
        const selectedAssessments = assessments.filter((a) => form.selectedAssessmentIds.includes(a.id));
        const hasLLN = selectedAssessments.some((a) => a.type === 'lln');
        const hasDigital = selectedAssessments.some((a) => a.type === 'digital');
        const llnToken = hasLLN ? generateToken() : null;
        const digitalToken = hasDigital ? generateToken() : null;

        const { data: invData, error: invError } = await supabase
          .from('assessment_invitations')
          .insert({
            qualification_id: form.qualificationId || null,
            candidate_email: form.candidateEmail.trim(),
            candidate_name: form.candidateName.trim(),
            candidate_dob: form.candidateDob || null,
            unique_token: token, status: 'sent', sent_at: now, progress_percent: 0,
            due_date: form.dueDate || null, created_by: user?.id || null,
            lln_token: llnToken, lln_status: hasLLN ? 'pending' : null,
            digital_token: digitalToken, digital_status: hasDigital ? 'pending' : null,
            rto_name: orgName || null,
          } as any)
          .select().single();
        if (invError) throw invError;
        const invitation = invData as AssessmentInvitation;

        logAudit({
          event_type: 'invitation.created', category: 'candidate_management',
          description: `Invitation created for ${form.candidateName.trim()} (${form.candidateEmail.trim()})`,
          source: 'admin', invitation_id: invitation.id,
          qualification_id: form.qualificationId || null,
          new_values: { candidate_name: form.candidateName.trim(), candidate_email: form.candidateEmail.trim(), due_date: form.dueDate || null, assessment_ids: form.selectedAssessmentIds },
        });

        if (hasLLN || hasDigital) {
          const quizEventType = hasLLN && hasDigital ? 'lln_digital.sent' : hasLLN ? 'lln.sent' : 'digital.sent';
          const quizDesc = hasLLN && hasDigital
            ? `LLN quiz and Digital quiz sent to ${form.candidateName.trim()}`
            : hasLLN ? `LLN quiz sent to ${form.candidateName.trim()}`
            : `Digital quiz sent to ${form.candidateName.trim()}`;
          logAudit({ event_type: quizEventType, category: 'candidate_management', description: quizDesc, source: 'system', invitation_id: invitation.id });
        }

        const invAssessmentRows = form.selectedAssessmentIds.map((assessmentId) => ({
          invitation_id: invitation.id, assessment_id: assessmentId,
          individual_status: 'pending' as const, individual_score: null, individual_passed: null,
          individual_completed_at: null, acsf_outcomes: {},
        }));
        if (invAssessmentRows.length > 0) {
          const { error: iaError } = await supabase.from('invitation_assessments').insert(invAssessmentRows);
          if (iaError) throw iaError;
        }

        const origin = window.location.origin;
        const portalUrl = `${origin}/#/student/${token}`;

        const emailResult = await callSendEmail({
          type: 'sent', invitation_id: invitation.id,
          recipient_email: form.candidateEmail.trim(), recipient_name: form.candidateName.trim(),
          quiz_links: { 'Assessment Portal': portalUrl },
          due_date: form.dueDate ? formatDate(form.dueDate) : null,
        });
        if (emailResult.ok) {
          logAudit({ event_type: 'invitation.sent', category: 'candidate_management', description: `Invitation email sent to ${form.candidateEmail.trim()}`, source: 'system', invitation_id: invitation.id });
        } else {
          console.warn('Email send failed:', emailResult.message);
        }

        void scheduleReminders(invitation.id, form.candidateEmail.trim(), form.candidateName.trim(), portalUrl, form.dueDate || null);

        enqueueAxcelerateWriteback(invitation.id, 'invitation_sent');
        const { data: { session: sess } } = await supabase.auth.getSession();
        if (sess?.access_token) {
          fetch(`${import.meta.env.VITE_SUPABASE_URL}/functions/v1/process-axcelerate-queue`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${sess.access_token}`, 'Apikey': import.meta.env.VITE_SUPABASE_ANON_KEY },
            body: JSON.stringify({ invitation_id: invitation.id }),
          }).catch(() => {});
        }
      }

      await loadData();
      closeModal();
    } catch (err: any) {
      setError(err.message || 'Failed to save invitation.');
    } finally {
      setSubmitting(false);
    }
  }

  async function handleSendReminder(inv: AssessmentInvitation) {
    setRemindingId(inv.id);
    try {
      const links = buildAssessmentLinks(inv);
      const emailResult = await callSendEmail({
        type: 'reminder', invitation_id: inv.id,
        recipient_email: inv.candidate_email, recipient_name: inv.candidate_name,
        quiz_links: { 'Assessment Portal': links.portal },
      });
      if (!emailResult.ok) {
        setError(`Reminder saved but email could not be sent: ${emailResult.message}. Copy the portal link to share manually.`);
      } else {
        logAudit({ event_type: 'reminder.sent', category: 'candidate_management', description: `Reminder sent to ${inv.candidate_name} (${inv.candidate_email})`, source: 'admin', invitation_id: inv.id });
      }
      if (inv.status === 'sent') {
        await supabase.from('assessment_invitations').update({ sent_at: new Date().toISOString() }).eq('id', inv.id);
      }
      await loadData();
    } catch (err: any) {
      setError(err.message || 'Failed to send reminder.');
    } finally {
      setRemindingId(null);
    }
  }

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4">
        <div>
          <h1 className="text-2xl font-bold text-slate-900">Candidates</h1>
          <p className="text-sm text-slate-500 mt-1">
            Track learner progress through LLN and Digital assessments.
          </p>
        </div>
        <button onClick={() => setShowModal(true)} className="btn-primary">
          <Plus className="w-4 h-4" /> New Invitation
        </button>
      </div>

      {error && (
        <div className="card p-4 border-rose-200 bg-rose-50">
          <p className="text-sm text-rose-700">{error}</p>
          <button onClick={() => setError(null)} className="text-rose-600 hover:text-rose-800 text-xs font-medium mt-1">Dismiss</button>
        </div>
      )}

      {enqueueMsg && (
        <div className="card p-3 border-teal-200 bg-teal-50">
          <p className="text-sm text-teal-700">{enqueueMsg}</p>
        </div>
      )}

      {/* Search + Tabs */}
      <div className="card p-1.5">
        <div className="flex flex-col sm:flex-row gap-2">
          <div className="flex gap-1 p-0.5 bg-slate-100 rounded-lg self-start sm:self-auto">
            <button
              onClick={() => setActiveTab('in_progress')}
              className={`px-4 py-1.5 rounded-md text-sm font-medium transition-all ${
                activeTab === 'in_progress'
                  ? 'bg-white text-slate-900 shadow-sm'
                  : 'text-slate-500 hover:text-slate-700'
              }`}
            >
              In Progress
              <span className={`ml-1.5 px-1.5 py-0.5 rounded-full text-xs ${
                activeTab === 'in_progress' ? 'bg-slate-100 text-slate-600' : 'bg-slate-200 text-slate-500'
              }`}>
                {inProgress.length}
              </span>
            </button>
            <button
              onClick={() => setActiveTab('completed')}
              className={`px-4 py-1.5 rounded-md text-sm font-medium transition-all ${
                activeTab === 'completed'
                  ? 'bg-white text-slate-900 shadow-sm'
                  : 'text-slate-500 hover:text-slate-700'
              }`}
            >
              Completed
              <span className={`ml-1.5 px-1.5 py-0.5 rounded-full text-xs ${
                activeTab === 'completed' ? 'bg-slate-100 text-slate-600' : 'bg-slate-200 text-slate-500'
              }`}>
                {completed.length}
              </span>
            </button>
          </div>
          <div className="relative flex-1">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-slate-400" />
            <input
              type="text"
              placeholder="Search by name or email..."
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              className="input pl-9 border-transparent bg-transparent focus:bg-white focus:border-slate-300"
            />
          </div>
        </div>
      </div>

      {/* List */}
      {loading ? (
        <div className="flex items-center justify-center py-20 text-slate-400">
          <Loader2 className="w-6 h-6 animate-spin mr-2" /> Loading candidates...
        </div>
      ) : tabItems.length === 0 ? (
        <div className="card p-12 text-center">
          <Users className="w-12 h-12 text-slate-300 mx-auto mb-4" />
          <h3 className="text-base font-semibold text-slate-900 mb-1">
            {invitations.length === 0 ? 'No candidates yet' : `No ${activeTab === 'in_progress' ? 'in-progress' : 'completed'} candidates`}
          </h3>
          <p className="text-sm text-slate-500 mb-4">
            {invitations.length === 0
              ? 'Send your first assessment invitation to get started.'
              : searchQuery
                ? 'Try adjusting your search.'
                : activeTab === 'in_progress'
                  ? 'All candidates have completed their assessments.'
                  : 'No candidates have completed their assessments yet.'}
          </p>
          {invitations.length === 0 && (
            <button onClick={() => setShowModal(true)} className="btn-primary">
              <Plus className="w-4 h-4" /> New Invitation
            </button>
          )}
        </div>
      ) : (
        <>
          {/* Desktop table */}
          <div className="card overflow-hidden hidden md:block">
            <div className="overflow-x-auto">
              <table className="w-full">
                <thead className="bg-slate-50 border-b border-slate-200">
                  <tr>
                    <th className="table-header">Candidate</th>
                    <th className="table-header">Qualification</th>
                    <th className="table-header">Status</th>
                    <th className="table-header">Assessments</th>
                    <th className="table-header">Links</th>
                    <th className="table-header">Due</th>
                    <th className="table-header text-right">Actions</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-200">
                  {tabItems.map((inv) => {
                    const overdue = isOverdue(inv);
                    const links = buildAssessmentLinks(inv);
                    return (
                      <tr key={inv.id} className="hover:bg-slate-50 transition-colors">
                        <td className="table-cell">
                          <div className="font-medium text-slate-900">{inv.candidate_name}</div>
                          <div className="text-xs text-slate-500">{inv.candidate_email}</div>
                          {inv.candidate_dob && (
                            <div className="text-xs text-slate-400 mt-0.5">DOB: {formatDate(inv.candidate_dob)}</div>
                          )}
                          {inv.axcelerate_contact_id && (
                            <div className="flex items-center gap-1 mt-1">
                              <span className="text-[10px] font-medium text-slate-400 uppercase tracking-wide">aX ID</span>
                              <span className="text-xs text-slate-600 font-mono">{inv.axcelerate_contact_id}</span>
                              <CopyButton text={String(inv.axcelerate_contact_id)} />
                            </div>
                          )}
                        </td>
                        <td className="table-cell">
                          {inv.qualification ? (
                            <div>
                              <div className="text-sm font-medium text-slate-700">{inv.qualification.code}</div>
                              <div className="text-xs text-slate-500">{inv.qualification.name}</div>
                            </div>
                          ) : (
                            <span className="text-sm text-slate-400">—</span>
                          )}
                        </td>
                        <td className="table-cell">
                          <div className="space-y-1.5">
                            <StatusBadge status={inv.status} />
                            {inv.course_recommendation && (
                              <span className={`badge text-[11px] ${RECOMMENDATION_COLORS[inv.course_recommendation]}`}>
                                {RECOMMENDATION_LABELS[inv.course_recommendation]}
                              </span>
                            )}
                          </div>
                        </td>
                        <td className="table-cell">
                          <AssessmentPills inv={inv} />
                        </td>
                        <td className="table-cell">
                          <div className="space-y-1 min-w-[140px]">
                            <div className="flex items-center gap-1">
                              <GraduationCap className="w-3 h-3 text-blue-500 shrink-0" />
                              <span className="text-xs text-slate-500">Portal</span>
                              <CopyButton text={links.portal} />
                            </div>
                            {links.lln && (
                              <div className="flex items-center gap-1">
                                <BookOpen className="w-3 h-3 text-slate-400 shrink-0" />
                                <span className="text-xs text-slate-400">LLN</span>
                                <CopyButton text={links.lln} />
                              </div>
                            )}
                            {links.digital && (
                              <div className="flex items-center gap-1">
                                <Monitor className="w-3 h-3 text-slate-400 shrink-0" />
                                <span className="text-xs text-slate-400">Digital</span>
                                <CopyButton text={links.digital} />
                              </div>
                            )}
                          </div>
                        </td>
                        <td className="table-cell">
                          <div className="flex items-center gap-1.5">
                            <Calendar className="w-3.5 h-3.5 text-slate-400" />
                            <span className={overdue ? 'text-rose-600 font-medium text-sm' : 'text-slate-600 text-sm'}>
                              {formatDate(inv.due_date)}
                            </span>
                            {overdue && (
                              <span className="badge bg-rose-100 text-rose-700 text-[10px] px-1.5 py-0.5">Overdue</span>
                            )}
                          </div>
                        </td>
                        <td className="table-cell text-right">
                          <div className="flex items-center justify-end gap-1">
                            <button
                              onClick={() => setTimelineInvitation(inv)}
                              className="btn-ghost text-xs px-2 py-1"
                              title="View activity timeline"
                            >
                              <Activity className="w-3.5 h-3.5" />
                            </button>
                            <button onClick={() => openEdit(inv)} className="btn-ghost text-xs px-2 py-1" title="Edit">
                              <Pencil className="w-3.5 h-3.5" />
                            </button>
                            <button
                              onClick={() => handleSendReminder(inv)}
                              disabled={remindingId === inv.id || inv.status === 'completed'}
                              className="btn-ghost text-xs px-2 py-1 disabled:opacity-40"
                              title="Send reminder"
                            >
                              {remindingId === inv.id ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Bell className="w-3.5 h-3.5" />}
                            </button>
                            <button
                              onClick={() => handleDelete(inv)}
                              disabled={deletingId === inv.id}
                              className="btn-ghost text-xs px-2 py-1 text-rose-600 hover:bg-rose-50 disabled:opacity-40"
                              title="Delete"
                            >
                              {deletingId === inv.id ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Trash2 className="w-3.5 h-3.5" />}
                            </button>
                            <RowActionsDropdown
                              inv={inv}
                              onEnqueued={(msg) => { setEnqueueMsg(msg); setTimeout(() => setEnqueueMsg(null), 4000); }}
                            />
                          </div>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </div>

          {/* Mobile cards */}
          <div className="md:hidden space-y-3">
            {tabItems.map((inv) => {
              const overdue = isOverdue(inv);
              return (
                <div key={inv.id} className="card p-4">
                  <div className="flex items-start justify-between mb-2">
                    <div>
                      <div className="font-medium text-slate-900">{inv.candidate_name}</div>
                      <div className="text-xs text-slate-500">{inv.candidate_email}</div>
                      {inv.axcelerate_contact_id && (
                        <div className="flex items-center gap-1 mt-0.5">
                          <span className="text-[10px] font-medium text-slate-400 uppercase tracking-wide">aX ID</span>
                          <span className="text-xs text-slate-600 font-mono">{inv.axcelerate_contact_id}</span>
                          <CopyButton text={String(inv.axcelerate_contact_id)} />
                        </div>
                      )}
                    </div>
                    <StatusBadge status={inv.status} />
                  </div>

                  {inv.qualification && (
                    <div className="text-xs text-slate-500 mb-2">
                      {inv.qualification.code} — {inv.qualification.name}
                    </div>
                  )}

                  <div className="mb-2"><AssessmentPills inv={inv} /></div>

                  {inv.course_recommendation && (
                    <div className="mb-2">
                      <span className={`badge text-[11px] ${RECOMMENDATION_COLORS[inv.course_recommendation]}`}>
                        {RECOMMENDATION_LABELS[inv.course_recommendation]}
                      </span>
                    </div>
                  )}

                  <div className="flex items-center justify-between mt-3">
                    <div className="flex items-center gap-1.5 text-xs">
                      <Calendar className="w-3.5 h-3.5 text-slate-400" />
                      <span className={overdue ? 'text-rose-600 font-medium' : 'text-slate-600'}>{formatDate(inv.due_date)}</span>
                      {overdue && <span className="badge bg-rose-100 text-rose-700 text-[10px] px-1.5 py-0.5">Overdue</span>}
                    </div>
                    <div className="flex items-center gap-1">
                      <button onClick={() => setTimelineInvitation(inv)} className="btn-ghost text-xs px-2 py-1" title="Timeline">
                        <Activity className="w-3.5 h-3.5" />
                      </button>
                      <button onClick={() => openEdit(inv)} className="btn-ghost text-xs px-2 py-1">
                        <Pencil className="w-3.5 h-3.5" />
                      </button>
                      <button
                        onClick={() => handleSendReminder(inv)}
                        disabled={remindingId === inv.id || inv.status === 'completed'}
                        className="btn-ghost text-xs px-2 py-1 disabled:opacity-40"
                      >
                        {remindingId === inv.id ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Bell className="w-3.5 h-3.5" />}
                      </button>
                      <button
                        onClick={() => handleDelete(inv)}
                        disabled={deletingId === inv.id}
                        className="btn-ghost text-xs px-2 py-1 text-rose-600 hover:bg-rose-50 disabled:opacity-40"
                      >
                        {deletingId === inv.id ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Trash2 className="w-3.5 h-3.5" />}
                      </button>
                    </div>
                  </div>
                </div>
              );
            })}
          </div>
        </>
      )}

      {/* New/Edit invitation modal */}
      {showModal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-slate-900/50 backdrop-blur-sm">
          <div className="card w-full max-w-2xl max-h-[90vh] overflow-y-auto scrollbar-thin">
            <div className="flex items-center justify-between p-5 border-b border-slate-200 sticky top-0 bg-white rounded-t-xl">
              <div>
                <h2 className="text-lg font-bold text-slate-900">
                  {editingInvitation ? 'Edit Invitation' : 'New Assessment Invitation'}
                </h2>
                <p className="text-sm text-slate-500 mt-0.5">
                  {editingInvitation
                    ? 'Update candidate details and assessment selection.'
                    : 'Send a combined LLN + Digital quiz invitation to a candidate.'}
                </p>
              </div>
              <button onClick={closeModal} className="btn-ghost p-1.5" disabled={submitting}>
                <X className="w-5 h-5" />
              </button>
            </div>

            <form onSubmit={handleSubmit} className="p-5 space-y-5">
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                <div>
                  <label className="label" htmlFor="candidate-name">Candidate Name</label>
                  <input
                    id="candidate-name" type="text" required
                    value={form.candidateName}
                    onChange={(e) => setForm({ ...form, candidateName: e.target.value })}
                    className="input" placeholder="Jane Smith" disabled={submitting}
                  />
                </div>
                <div>
                  <label className="label" htmlFor="candidate-email">Candidate Email</label>
                  <input
                    id="candidate-email" type="email" required
                    value={form.candidateEmail}
                    onChange={(e) => setForm({ ...form, candidateEmail: e.target.value })}
                    className="input" placeholder="jane.smith@example.com" disabled={submitting}
                  />
                </div>
              </div>

              <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                <div>
                  <label className="label" htmlFor="candidate-dob">
                    Date of Birth <span className="text-slate-400 font-normal">(for learner matching)</span>
                  </label>
                  <input
                    id="candidate-dob" type="date"
                    value={form.candidateDob}
                    onChange={(e) => setForm({ ...form, candidateDob: e.target.value })}
                    className="input" disabled={submitting}
                  />
                </div>
                <div>
                  <label className="label" htmlFor="qualification">Qualification</label>
                  <select
                    id="qualification"
                    value={form.qualificationId}
                    onChange={(e) => setForm({ ...form, qualificationId: e.target.value })}
                    className="input cursor-pointer" disabled={submitting}
                  >
                    <option value="">Select a qualification...</option>
                    {qualifications.map((q) => (
                      <option key={q.id} value={q.id}>{q.code} — {q.name}</option>
                    ))}
                  </select>
                </div>
                <div>
                  <label className="label" htmlFor="due-date">Due Date</label>
                  <input
                    id="due-date" type="date"
                    value={form.dueDate}
                    onChange={(e) => setForm({ ...form, dueDate: e.target.value })}
                    className="input" disabled={submitting}
                  />
                </div>
              </div>

              <div>
                <label className="label">Assessments to Include</label>
                <p className="text-xs text-slate-500 mb-3">
                  Select one or more assessments. The candidate will receive a portal link with access to all selected assessments.
                </p>
                {assessments.length === 0 ? (
                  <p className="text-sm text-slate-400 italic">No active assessments found. Add assessments in the Assessment Builder first.</p>
                ) : (
                  <div className="space-y-2">
                    {assessments.map((a) => {
                      const selected = form.selectedAssessmentIds.includes(a.id);
                      const Icon = a.type === 'lln' ? BookOpen : Monitor;
                      return (
                        <label
                          key={a.id}
                          className={`flex items-center gap-3 p-3 rounded-lg border cursor-pointer transition-all ${
                            selected ? 'border-primary-500 bg-primary-50' : 'border-slate-200 hover:border-slate-300 hover:bg-slate-50'
                          }`}
                        >
                          <input
                            type="checkbox" checked={selected}
                            onChange={() => toggleAssessment(a.id)}
                            className="w-4 h-4 rounded border-slate-300 text-primary-600 focus:ring-primary-500"
                            disabled={submitting}
                          />
                          <div className={`w-7 h-7 rounded-lg flex items-center justify-center shrink-0 ${selected ? 'bg-primary-100' : 'bg-slate-100'}`}>
                            <Icon className={`w-3.5 h-3.5 ${selected ? 'text-primary-600' : 'text-slate-400'}`} />
                          </div>
                          <div className="flex-1 min-w-0">
                            <div className="text-sm font-medium text-slate-900">{a.title}</div>
                            <div className="text-xs text-slate-500 capitalize">
                              {a.type === 'lln' ? 'LLN — Adaptive · ACSF Levels 1–5' : 'Digital Literacy'}
                              {a.total_questions ? ` · ${a.total_questions} questions` : ''}
                            </div>
                          </div>
                          {selected && <CheckCircle2 className="w-4 h-4 text-primary-600 shrink-0" />}
                        </label>
                      );
                    })}
                  </div>
                )}
              </div>

              {error && (
                <div className="card p-3 border-rose-200 bg-rose-50">
                  <p className="text-sm text-rose-700">{error}</p>
                </div>
              )}

              <div className="flex items-center justify-end gap-3 pt-2 border-t border-slate-200">
                <button type="button" onClick={closeModal} className="btn-secondary" disabled={submitting}>Cancel</button>
                <button
                  type="submit" className="btn-primary"
                  disabled={submitting || form.selectedAssessmentIds.length === 0 || !form.qualificationId}
                >
                  {submitting ? (
                    <><Loader2 className="w-4 h-4 animate-spin" /> Sending...</>
                  ) : (
                    <><Send className="w-4 h-4" />{editingInvitation ? 'Save Changes' : 'Send Invitation'}</>
                  )}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* Activity Timeline modal */}
      {timelineInvitation && (
        <ActivityTimelineModal
          invitation={timelineInvitation}
          onClose={() => setTimelineInvitation(null)}
        />
      )}
    </div>
  );
}
