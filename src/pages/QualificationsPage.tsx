import { useEffect, useState, useCallback, useMemo } from 'react';
import { MappingApprovalPanel } from '../components/qualifications/MappingApprovalPanel';
import {
  Award, Plus, Pencil, Trash2, X, ChevronDown, ChevronRight,
  AlertCircle, Loader2, Download, CheckCircle2, RefreshCw,
  Search, ArrowRight, ArrowLeft, RotateCcw, Info, Filter,
  Cpu, ShieldAlert, BarChart2, Square, CheckSquare, Minus,
  BookOpen,
} from 'lucide-react';
import { supabase } from '../lib/supabase';
import { logAudit } from '../lib/audit';
import type {
  Qualification, QualificationLLNRequirement, QualificationMappingLibrary,
  MappingStatus, Domain,
} from '../lib/types';
import {
  SIX_SKILLS, MAPPING_STATUS_CONFIG, LEVEL_COLORS, CONFIDENCE_CONFIG, MAPPING_METHOD_LABELS,
} from '../lib/types';
import { MappingEvidencePage } from './MappingEvidencePage';

// ── Types ────────────────────────────────────────────────────────────────────

interface QualFormState {
  code: string;
  name: string;
  axcelerate_course_id: string;
  active: boolean;
}

interface EditMetaState {
  reviewed_by: string;
  reviewed_at: string;
  internal_notes: string;
}

interface PreviewCourse {
  courseId: number;
  code: string;
  name: string;
  type: string;
  status: 'new' | 'update' | 'exists';
}

const EMPTY_QUAL_FORM: QualFormState = { code: '', name: '', axcelerate_course_id: '', active: true };
const EMPTY_META: EditMetaState = { reviewed_by: '', reviewed_at: '', internal_notes: '' };
const EMPTY_LEVELS: Record<string, number> = Object.fromEntries(SIX_SKILLS.map((s) => [s.key, 0]));

const ACSF_LEVELS = [1, 2, 3, 4, 5];

// ── Helpers ──────────────────────────────────────────────────────────────────

function buildLevelsFromReqs(reqs: QualificationLLNRequirement[]): Record<string, number> {
  const levels = { ...EMPTY_LEVELS };
  for (const r of reqs) {
    const skill = SIX_SKILLS.find((s) => s.skill === r.acsf_skill);
    if (skill) levels[skill.key] = r.minimum_acsf_level;
  }
  return levels;
}

function levelsMatch(a: Record<string, number>, b: Record<string, number>): boolean {
  return SIX_SKILLS.every((s) => (a[s.key] ?? 0) === (b[s.key] ?? 0));
}

function computeDisplayStatus(
  qual: Qualification,
  reqs: QualificationLLNRequirement[]
): MappingStatus {
  if (reqs.length === 0) return 'mapping_required';
  // An approved mapping stays approved until a training.gov.au change is
  // recorded for this qualification — there is no time-based review expiry.
  if ((qual as Qualification & { mapping_change_detected_at?: string | null }).mapping_change_detected_at) return 'review_required';
  return (qual.mapping_status as MappingStatus) || 'custom_mapping';
}

function levelLabel(level: number): string {
  if (!level) return '—';
  return `Level ${level}`;
}

// ── Component ────────────────────────────────────────────────────────────────

export function QualificationsPage() {
  // Core data
  const [qualifications, setQualifications] = useState<Qualification[]>([]);
  const [requirements, setRequirements] = useState<Record<string, QualificationLLNRequirement[]>>({});
  const [mappingLibrary, setMappingLibrary] = useState<Record<string, QualificationMappingLibrary>>({});
  const [loading, setLoading] = useState(true);

  // Mapping evidence sub-page
  const [evidenceQualId, setEvidenceQualId] = useState<string | null>(null);

  // UI
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [remapping, setRemapping] = useState<string | null>(null); // qual id being re-mapped
  const [remapResult, setRemapResult] = useState<{ id: string; ok: boolean; msg: string } | null>(null);
  const [searchQuery, setSearchQuery] = useState('');
  const [statusFilter, setStatusFilter] = useState<'all' | MappingStatus | 'needs_review'>('all');

  // Qual modal (create + edit)
  const [showQualModal, setShowQualModal] = useState(false);
  const [editingQual, setEditingQual] = useState<Qualification | null>(null);
  const [qualForm, setQualForm] = useState<QualFormState>(EMPTY_QUAL_FORM);
  const [qualStep, setQualStep] = useState<1 | 2>(1);
  const [skillLevels, setSkillLevels] = useState<Record<string, number>>(EMPTY_LEVELS);
  const [defaultLevels, setDefaultLevels] = useState<Record<string, number> | null>(null);
  const [editMeta, setEditMeta] = useState<EditMetaState>(EMPTY_META);
  const [qualError, setQualError] = useState<string | null>(null);
  const [lookingUp, setLookingUp] = useState(false);

  // Delete confirm
  const [deleteTarget, setDeleteTarget] = useState<Qualification | null>(null);

  // Bulk selection
  const [bulkSelected, setBulkSelected] = useState<Set<string>>(new Set());
  const [bulkDeleting, setBulkDeleting] = useState(false);
  const [showBulkDeleteConfirm, setShowBulkDeleteConfirm] = useState(false);

  // Import modal
  const [importing, setImporting] = useState(false);
  const [importResult, setImportResult] = useState<{
    ok: boolean; message: string; imported?: number; updated?: number;
  } | null>(null);
  const [showImportModal, setShowImportModal] = useState(false);
  const [previewing, setPreviewing] = useState(false);
  const [previewError, setPreviewError] = useState<string | null>(null);
  const [previewCourses, setPreviewCourses] = useState<PreviewCourse[]>([]);
  const [skippedWorkshops, setSkippedWorkshops] = useState(0);
  const [selected, setSelected] = useState<Set<number>>(new Set());

  // ── Load data ──────────────────────────────────────────────────────────────

  const loadData = useCallback(async () => {
    setLoading(true);
    const [{ data: quals }, { data: reqs }, { data: lib }] = await Promise.all([
      supabase.from('qualifications').select('*').order('code', { ascending: true }),
      supabase.from('qualification_lln_requirements').select('*').order('created_at', { ascending: true }),
      supabase.from('qualification_mapping_library').select('*'),
    ]);

    const qualList = (quals as Qualification[]) || [];
    setQualifications(qualList);

    const reqMap: Record<string, QualificationLLNRequirement[]> = {};
    for (const r of (reqs as QualificationLLNRequirement[] || [])) {
      if (!reqMap[r.qualification_id]) reqMap[r.qualification_id] = [];
      reqMap[r.qualification_id].push(r);
    }
    setRequirements(reqMap);

    const libMap: Record<string, QualificationMappingLibrary> = {};
    for (const entry of (lib as QualificationMappingLibrary[] || [])) {
      libMap[entry.code.toUpperCase()] = entry;
    }
    setMappingLibrary(libMap);

    setLoading(false);
  }, []);

  useEffect(() => { loadData(); }, [loadData]);

  // ── Filtered/sorted list ───────────────────────────────────────────────────

  const filteredQuals = useMemo(() => {
    const q = searchQuery.trim().toLowerCase();
    return qualifications.filter((qual) => {
      const reqs = requirements[qual.id] || [];
      const status = computeDisplayStatus(qual, reqs);
      if (statusFilter === 'needs_review') {
        if (!qual.needs_review && status !== 'review_required') return false;
      } else if (statusFilter !== 'all' && status !== statusFilter) return false;
      if (q && !qual.code.toLowerCase().includes(q) && !qual.name.toLowerCase().includes(q)) return false;
      return true;
    });
  }, [qualifications, requirements, searchQuery, statusFilter]);

  // ── Open / close qual modal ────────────────────────────────────────────────

  function openCreateQual() {
    setEditingQual(null);
    setQualForm(EMPTY_QUAL_FORM);
    setQualStep(1);
    setSkillLevels({ ...EMPTY_LEVELS });
    setDefaultLevels(null);
    setEditMeta(EMPTY_META);
    setQualError(null);
    setShowQualModal(true);
  }

  function openEditQual(qual: Qualification) {
    setEditingQual(qual);
    setQualForm({
      code: qual.code,
      name: qual.name,
      axcelerate_course_id: qual.axcelerate_course_id?.toString() || '',
      active: qual.active,
    });
    const reqs = requirements[qual.id] || [];
    setSkillLevels(buildLevelsFromReqs(reqs));

    // Populate default levels from snapshot or library
    const snap = qual.default_mapping_snapshot;
    const libEntry = mappingLibrary[qual.code.toUpperCase()];
    if (snap && Object.keys(snap).length > 0) {
      setDefaultLevels(snap as Record<string, number>);
    } else if (libEntry) {
      setDefaultLevels({
        learning: libEntry.learning_level ?? 0,
        reading: libEntry.reading_level ?? 0,
        writing: libEntry.writing_level ?? 0,
        oral_communication: libEntry.oral_comm_level ?? 0,
        numeracy: libEntry.numeracy_level ?? 0,
        digital_literacy: libEntry.digital_level ?? 0,
      });
    } else {
      setDefaultLevels(null);
    }

    setEditMeta({
      reviewed_by: qual.reviewed_by || '',
      reviewed_at: qual.reviewed_at ? qual.reviewed_at.split('T')[0] : '',
      internal_notes: qual.internal_notes || '',
    });
    setQualStep(1);
    setQualError(null);
    setShowQualModal(true);
  }

  // ── aXcelerate lookup ──────────────────────────────────────────────────────

  async function lookupAxcelerateCode() {
    const code = qualForm.code.trim().toUpperCase();
    if (!code) return;
    setLookingUp(true);
    setQualError(null);
    try {
      const { ok, data } = await callImportFn({ action: 'preview' });
      if (ok && Array.isArray(data.qualifications)) {
        const match = (data.qualifications as PreviewCourse[]).find(
          (c) => c.code.toUpperCase() === code
        );
        if (match) {
          setQualForm((prev) => ({ ...prev, name: match.name, axcelerate_course_id: String(match.courseId) }));
        } else {
          setQualError(`"${code}" not found in aXcelerate — enter the name manually.`);
        }
      }
      // Also pre-populate levels from library if code found there
      const libEntry = mappingLibrary[code];
      if (libEntry) {
        const levels = {
          learning: libEntry.learning_level ?? 0,
          reading: libEntry.reading_level ?? 0,
          writing: libEntry.writing_level ?? 0,
          oral_communication: libEntry.oral_comm_level ?? 0,
          numeracy: libEntry.numeracy_level ?? 0,
          digital_literacy: libEntry.digital_level ?? 0,
        };
        setSkillLevels(levels);
        setDefaultLevels(levels);
      }
    } finally {
      setLookingUp(false);
    }
  }

  // ── Save qualification ─────────────────────────────────────────────────────

  async function saveQual() {
    if (!qualForm.code.trim() || !qualForm.name.trim()) {
      setQualError('Code and name are required.');
      return;
    }
    setSaving(true);
    setQualError(null);

    const code = qualForm.code.trim().toUpperCase();
    const hasLevels = SIX_SKILLS.some((s) => (skillLevels[s.key] ?? 0) > 0);

    // Determine mapping status
    let mappingStatus: MappingStatus = 'mapping_required';
    let mappingSource: 'default' | 'custom' | null = null;

    if (hasLevels) {
      const snap = editingQual?.default_mapping_snapshot as Record<string, number> | null;
      const libEntry = mappingLibrary[code];
      const refLevels = snap || (libEntry ? {
        learning: libEntry.learning_level ?? 0,
        reading: libEntry.reading_level ?? 0,
        writing: libEntry.writing_level ?? 0,
        oral_communication: libEntry.oral_comm_level ?? 0,
        numeracy: libEntry.numeracy_level ?? 0,
        digital_literacy: libEntry.digital_level ?? 0,
      } : null);

      if (refLevels && levelsMatch(skillLevels, refLevels)) {
        mappingStatus = 'default_mapping_applied';
        mappingSource = 'default';
      } else {
        mappingStatus = 'custom_mapping';
        mappingSource = 'custom';
      }
    }

    // Build default snapshot (for new quals or when restoring)
    let defaultSnapshot: Record<string, number> | null = editingQual?.default_mapping_snapshot as Record<string, number> | null ?? null;
    const libEntry = mappingLibrary[code];
    if (!defaultSnapshot && libEntry) {
      defaultSnapshot = {
        learning: libEntry.learning_level ?? 0,
        reading: libEntry.reading_level ?? 0,
        writing: libEntry.writing_level ?? 0,
        oral_communication: libEntry.oral_comm_level ?? 0,
        numeracy: libEntry.numeracy_level ?? 0,
        digital_literacy: libEntry.digital_level ?? 0,
      };
    }

    const qualPayload: Record<string, unknown> = {
      code,
      name: qualForm.name.trim(),
      axcelerate_course_id: qualForm.axcelerate_course_id ? Number(qualForm.axcelerate_course_id) : null,
      active: qualForm.active,
      mapping_status: mappingStatus,
      mapping_source: mappingSource,
      mapping_version: (editingQual?.mapping_version ?? 0) + 1,
      ...(defaultSnapshot ? { default_mapping_snapshot: defaultSnapshot } : {}),
      ...(editMeta.reviewed_by ? { reviewed_by: editMeta.reviewed_by } : {}),
      ...(editMeta.reviewed_at ? { reviewed_at: new Date(editMeta.reviewed_at).toISOString() } : {}),
      ...(editMeta.internal_notes !== undefined ? { internal_notes: editMeta.internal_notes || null } : {}),
    };

    let qualId: string;
    if (editingQual) {
      const { error } = await supabase
        .from('qualifications')
        .update(qualPayload)
        .eq('id', editingQual.id);
      if (error) { setSaving(false); setQualError(error.message); return; }
      qualId = editingQual.id;
    } else {
      const { data, error } = await supabase
        .from('qualifications')
        .insert(qualPayload)
        .select('id')
        .single();
      if (error || !data) { setSaving(false); setQualError(error?.message ?? 'Insert failed'); return; }
      qualId = data.id;
    }

    // Upsert requirements: delete all then re-insert
    await supabase.from('qualification_lln_requirements').delete().eq('qualification_id', qualId);
    if (hasLevels) {
      const reqInserts = SIX_SKILLS
        .filter((s) => (skillLevels[s.key] ?? 0) > 0)
        .map((s) => ({
          qualification_id: qualId,
          domain: s.domain as Domain,
          acsf_skill: s.skill,
          minimum_acsf_level: skillLevels[s.key],
        }));
      if (reqInserts.length > 0) {
        await supabase.from('qualification_lln_requirements').insert(reqInserts);
      }
    }

    setSaving(false);
    setShowQualModal(false);
    logAudit({
      event_type: editingQual ? 'qualification.updated' : 'qualification.created',
      category: 'qualification_management',
      description: editingQual
        ? `Qualification updated — ${code} ${qualForm.name.trim()} (mapping: ${mappingStatus})`
        : `Qualification created — ${code} ${qualForm.name.trim()}`,
      source: 'admin',
      qualification_id: qualId,
      new_values: { code, name: qualForm.name.trim(), mapping_status: mappingStatus, mapping_source: mappingSource },
      ...(editingQual ? { previous_values: { code: editingQual.code, name: editingQual.name, mapping_status: editingQual.mapping_status } } : {}),
    });
    await loadData();
  }

  // ── Restore default ────────────────────────────────────────────────────────

  function restoreDefaultMapping() {
    if (!defaultLevels) return;
    setSkillLevels({ ...EMPTY_LEVELS, ...defaultLevels });
  }

  // ── Delete ────────────────────────────────────────────────────────────────

  async function confirmDelete() {
    if (!deleteTarget) return;
    setSaving(true);
    await supabase.from('qualification_lln_requirements').delete().eq('qualification_id', deleteTarget.id);
    await supabase.from('qualifications').delete().eq('id', deleteTarget.id);
    setSaving(false);
    logAudit({
      event_type: 'qualification.deleted',
      category: 'qualification_management',
      description: `Qualification deleted — ${deleteTarget.code} ${deleteTarget.name}`,
      source: 'admin',
      qualification_id: deleteTarget.id,
      previous_values: { code: deleteTarget.code, name: deleteTarget.name },
    });
    setDeleteTarget(null);
    await loadData();
  }

  // ── Bulk delete ───────────────────────────────────────────────────────────

  async function confirmBulkDelete() {
    setBulkDeleting(true);
    const ids = Array.from(bulkSelected);
    const targets = qualifications.filter((q) => ids.includes(q.id));
    await supabase.from('qualification_lln_requirements').delete().in('qualification_id', ids);
    await supabase.from('qualifications').delete().in('id', ids);
    logAudit({
      event_type: 'qualification.bulk_deleted',
      category: 'qualification_management',
      description: `Bulk deleted ${ids.length} qualification${ids.length !== 1 ? 's' : ''}: ${targets.map((q) => q.code).join(', ')}`,
      source: 'admin',
      new_values: { deleted_ids: ids, deleted_codes: targets.map((q) => q.code) },
    });
    setBulkDeleting(false);
    setBulkSelected(new Set());
    setShowBulkDeleteConfirm(false);
    await loadData();
  }

  // ── ACSF Re-mapping ────────────────────────────────────────────────────────

  async function rerunMapping(qualId: string) {
    setRemapping(qualId);
    setRemapResult(null);
    try {
      const { data: { session } } = await supabase.auth.getSession();
      if (!session?.access_token) throw new Error('No active session.');
      const url = `${import.meta.env.VITE_SUPABASE_URL}/functions/v1/compute-acsf-mapping`;
      const res = await fetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${session.access_token}`,
          'Apikey': import.meta.env.VITE_SUPABASE_ANON_KEY,
        },
        body: JSON.stringify({ qualification_id: qualId, triggered_by: 'manual' }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || 'Mapping engine failed.');
      const msg = data.had_uoc_data
        ? `Mapping complete — ${data.uoc_count} UoCs processed, ${data.uoc_matched} direct matches (${data.confidence} confidence).`
        : 'No UoC data available from aXcelerate. Qualification flagged for review.';
      setRemapResult({ id: qualId, ok: true, msg });
      logAudit({
        event_type: 'qualification.acsf_mapping_generated',
        category: 'qualification_management',
        description: msg,
        source: 'system',
        qualification_id: qualId,
        new_values: { uoc_count: data.uoc_count, uoc_matched: data.uoc_matched, confidence: data.confidence },
      });
    } catch (e: any) {
      setRemapResult({ id: qualId, ok: false, msg: e.message });
    } finally {
      setRemapping(null);
      await loadData();
    }
  }

  // ── Import helpers ─────────────────────────────────────────────────────────

  async function callImportFn(body: object): Promise<{ ok: boolean; data: any }> {
    const { data: { session } } = await supabase.auth.getSession();
    if (!session?.access_token) return { ok: false, data: { error: 'No active session.' } };
    const url = `${import.meta.env.VITE_SUPABASE_URL}/functions/v1/import-axcelerate-qualifications`;
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${session.access_token}`,
        'Apikey': import.meta.env.VITE_SUPABASE_ANON_KEY,
      },
      body: JSON.stringify(body),
    });
    const data = await res.json().catch(() => ({}));
    return { ok: res.ok, data };
  }

  async function handleOpenImportModal() {
    setShowImportModal(true);
    setPreviewing(true);
    setPreviewError(null);
    setPreviewCourses([]);
    setSelected(new Set());
    setSkippedWorkshops(0);
    const { ok, data } = await callImportFn({ action: 'preview' });
    setPreviewing(false);
    if (!ok) { setPreviewError(data.error || 'Failed to fetch from aXcelerate.'); return; }
    const courses: PreviewCourse[] = data.qualifications ?? [];
    setPreviewCourses(courses);
    setSkippedWorkshops(data.skipped_workshops ?? 0);
    setSelected(new Set(courses.map((c) => c.courseId)));
  }

  function toggleSelect(courseId: number) {
    setSelected((prev) => { const n = new Set(prev); n.has(courseId) ? n.delete(courseId) : n.add(courseId); return n; });
  }
  function selectAll() { setSelected(new Set(previewCourses.map((c) => c.courseId))); }
  function deselectAll() { setSelected(new Set()); }

  async function handleImport() {
    const toImport = previewCourses.filter((c) => selected.has(c.courseId));
    if (toImport.length === 0) return;
    setImporting(true);
    const { ok, data } = await callImportFn({ action: 'import', course_ids: toImport.map((c) => c.courseId), courses: toImport });
    setImporting(false);
    setShowImportModal(false);
    if (!ok) {
      setImportResult({ ok: false, message: data.error || 'Import failed.' });
    } else {
      setImportResult({ ok: true, message: data.message, imported: data.imported, updated: data.updated });
      if ((data.imported ?? 0) > 0 || (data.updated ?? 0) > 0) {
        logAudit({
          event_type: 'qualification.imported_from_axcelerate',
          category: 'axcelerate_integration',
          description: `aXcelerate import — ${data.imported ?? 0} created, ${data.updated ?? 0} updated`,
          source: 'admin',
          new_values: { imported: data.imported, updated: data.updated },
        });
        await loadData();
      }
    }
  }

  // ── Render ────────────────────────────────────────────────────────────────

  // Status filter counts (must be before early return — hooks rule)
  const statusCounts = useMemo(() => {
    const counts: Record<string, number> = { all: qualifications.length, needs_review: 0 };
    for (const qual of qualifications) {
      const reqs = requirements[qual.id] || [];
      const status = computeDisplayStatus(qual, reqs);
      counts[status] = (counts[status] || 0) + 1;
      if (qual.needs_review || status === 'review_required') counts.needs_review += 1;
    }
    return counts;
  }, [qualifications, requirements]);

  if (evidenceQualId) {
    return <MappingEvidencePage qualId={evidenceQualId} onBack={() => setEvidenceQualId(null)} />;
  }

  if (loading) {
    return (
      <div className="flex items-center justify-center py-20 text-slate-400">
        <Loader2 className="w-5 h-5 animate-spin mr-2" /> Loading qualifications...
      </div>
    );
  }

  return (
    <div className="space-y-6">

      {/* ── Header ── */}
      <div className="flex items-center justify-between flex-wrap gap-4">
        <div>
          <h2 className="text-xl font-bold text-slate-900">Qualifications</h2>
          <p className="text-sm text-slate-500 mt-1">
            Manage ACSF mapping requirements for each qualification
          </p>
        </div>
        <div className="flex items-center gap-2">
          <button onClick={handleOpenImportModal} disabled={importing} className="btn-secondary" title="Import from aXcelerate">
            {importing ? <Loader2 className="w-4 h-4 animate-spin" /> : <Download className="w-4 h-4" />}
            {importing ? 'Importing…' : 'Import from aXcelerate'}
          </button>
          <button onClick={openCreateQual} className="btn-primary">
            <Plus className="w-4 h-4" /> Add Qualification
          </button>
        </div>
      </div>

      {/* ── Compliance notice ── */}
      <div className="flex items-start gap-3 bg-blue-50 border border-blue-200 rounded-lg px-4 py-3 text-xs text-blue-800">
        <Info className="w-4 h-4 mt-0.5 shrink-0 text-blue-500" />
        <p>
          <strong>Default ACSF mappings</strong> are recommended levels based on industry experience and best practice. They are intended to reduce implementation time.{' '}
          <strong>The RTO is responsible</strong> for reviewing and confirming that mapped ACSF levels accurately reflect their specific training and assessment before relying on them for compliance.
        </p>
      </div>

      {/* ── Import result banner ── */}
      {importResult && (
        <div className={`flex items-start gap-3 rounded-lg border px-4 py-3 text-sm ${importResult.ok ? 'bg-emerald-50 border-emerald-200 text-emerald-800' : 'bg-rose-50 border-rose-200 text-rose-700'}`}>
          {importResult.ok ? <CheckCircle2 className="w-4 h-4 mt-0.5 shrink-0 text-emerald-600" /> : <AlertCircle className="w-4 h-4 mt-0.5 shrink-0" />}
          <div className="flex-1">
            <p className="font-medium">{importResult.message}</p>
            {importResult.ok && importResult.imported !== undefined && (
              <p className="text-xs mt-0.5 opacity-80">
                {importResult.imported} added · {importResult.updated} updated — ACSF mappings automatically applied where available.
              </p>
            )}
          </div>
          <button onClick={() => setImportResult(null)} className="opacity-50 hover:opacity-100"><X className="w-4 h-4" /></button>
        </div>
      )}

      {/* ── Re-map result banner ── */}
      {remapResult && (
        <div className={`flex items-start gap-3 rounded-lg border px-4 py-3 text-sm ${remapResult.ok ? 'bg-emerald-50 border-emerald-200 text-emerald-800' : 'bg-rose-50 border-rose-200 text-rose-700'}`}>
          {remapResult.ok ? <Cpu className="w-4 h-4 mt-0.5 shrink-0 text-emerald-600" /> : <AlertCircle className="w-4 h-4 mt-0.5 shrink-0" />}
          <div className="flex-1">
            <p className="font-medium">{remapResult.ok ? 'ACSF Mapping Complete' : 'Mapping Failed'}</p>
            <p className="text-xs mt-0.5 opacity-80">{remapResult.msg}</p>
          </div>
          <button onClick={() => setRemapResult(null)} className="opacity-50 hover:opacity-100"><X className="w-4 h-4" /></button>
        </div>
      )}

      {/* ── Search + filter bar ── */}
      <div className="flex items-center gap-3 flex-wrap">
        <div className="relative flex-1 min-w-48">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-slate-400" />
          <input
            className="input pl-9 h-9 text-sm"
            placeholder="Search by code or name…"
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
          />
        </div>
        <div className="flex items-center gap-1.5 flex-wrap">
          <Filter className="w-4 h-4 text-slate-400" />
          {(['all', 'needs_review', 'mapping_required', 'default_mapping_applied', 'custom_mapping', 'review_required'] as const).map((s) => {
            const count = statusCounts[s] ?? 0;
            if (s !== 'all' && count === 0) return null;
            const cfg = (s !== 'all' && s !== 'needs_review') ? MAPPING_STATUS_CONFIG[s] : null;
            const isReviewQueue = s === 'needs_review';
            return (
              <button
                key={s}
                onClick={() => setStatusFilter(s)}
                className={`inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-xs font-medium transition-all border ${
                  statusFilter === s
                    ? isReviewQueue
                      ? 'border-rose-500 bg-rose-50 text-rose-700'
                      : 'border-primary-500 bg-primary-50 text-primary-700'
                    : 'border-slate-200 text-slate-600 hover:border-slate-300 hover:bg-slate-50'
                }`}
              >
                {isReviewQueue && <ShieldAlert className="w-3 h-3" />}
                {cfg && <span className={`w-1.5 h-1.5 rounded-full ${cfg.dotColor}`} />}
                {s === 'all' ? 'All' : isReviewQueue ? 'Review Queue' : cfg!.label}
                <span className="opacity-60">{count}</span>
              </button>
            );
          })}
        </div>
      </div>

      {/* ── Bulk action toolbar ── */}
      {bulkSelected.size > 0 && (
        <div className="flex items-center gap-3 bg-primary-50 border border-primary-200 rounded-xl px-4 py-3 animate-slide-up">
          <div className="flex items-center gap-2 flex-1">
            <CheckSquare className="w-4 h-4 text-primary-600" />
            <span className="text-sm font-medium text-primary-900">
              {bulkSelected.size} qualification{bulkSelected.size !== 1 ? 's' : ''} selected
            </span>
          </div>
          <button
            onClick={() => setBulkSelected(new Set(filteredQuals.map((q) => q.id)))}
            className="text-xs text-primary-700 hover:text-primary-900 font-medium"
          >
            Select all {filteredQuals.length}
          </button>
          <span className="text-primary-200">|</span>
          <button
            onClick={() => setBulkSelected(new Set())}
            className="text-xs text-slate-500 hover:text-slate-700 font-medium"
          >
            Deselect all
          </button>
          <button
            onClick={() => setShowBulkDeleteConfirm(true)}
            className="inline-flex items-center gap-1.5 px-3 py-1.5 bg-rose-600 hover:bg-rose-700 text-white text-xs font-medium rounded-lg transition-colors"
          >
            <Trash2 className="w-3.5 h-3.5" />
            Delete {bulkSelected.size}
          </button>
        </div>
      )}

      {/* ── Empty state ── */}
      {filteredQuals.length === 0 && (
        <div className="card p-12 text-center">
          <Award className="w-10 h-10 text-slate-300 mx-auto mb-3" />
          {qualifications.length === 0 ? (
            <>
              <h3 className="text-base font-semibold text-slate-900 mb-1">No qualifications yet</h3>
              <p className="text-sm text-slate-500 mb-4">Import from aXcelerate or add manually to get started.</p>
              <button onClick={openCreateQual} className="btn-primary"><Plus className="w-4 h-4" /> Add Qualification</button>
            </>
          ) : (
            <>
              <h3 className="text-base font-semibold text-slate-900 mb-1">No results</h3>
              <p className="text-sm text-slate-500">No qualifications match your current filter.</p>
            </>
          )}
        </div>
      )}

      {/* ── Qualification list ── */}
      {filteredQuals.length > 0 && (
        <div className="space-y-2">
          {/* Select-all row */}
          <div className="flex items-center gap-3 px-4 py-2">
            <button
              onClick={() => {
                const allIds = filteredQuals.map((q) => q.id);
                const allSelected = allIds.every((id) => bulkSelected.has(id));
                if (allSelected) {
                  setBulkSelected((prev) => {
                    const next = new Set(prev);
                    allIds.forEach((id) => next.delete(id));
                    return next;
                  });
                } else {
                  setBulkSelected((prev) => new Set([...prev, ...allIds]));
                }
              }}
              className="text-slate-400 hover:text-slate-600 transition-colors"
              title="Select all visible"
            >
              {filteredQuals.every((q) => bulkSelected.has(q.id)) ? (
                <CheckSquare className="w-4 h-4 text-primary-600" />
              ) : filteredQuals.some((q) => bulkSelected.has(q.id)) ? (
                <Minus className="w-4 h-4 text-primary-400" />
              ) : (
                <Square className="w-4 h-4" />
              )}
            </button>
            <span className="text-xs text-slate-400 select-none">Select all</span>
          </div>

          {filteredQuals.map((qual) => {
            const reqs = requirements[qual.id] || [];
            const status = computeDisplayStatus(qual, reqs);
            const statusCfg = MAPPING_STATUS_CONFIG[status];
            const isExpanded = expandedId === qual.id;
            const levels = buildLevelsFromReqs(reqs);
            const hasLevels = SIX_SKILLS.some((s) => levels[s.key] > 0);

            return (
              <div key={qual.id} className="card overflow-hidden">
                {/* Row header */}
                <div
                  className="flex items-center gap-4 px-4 py-3.5 cursor-pointer hover:bg-slate-50 transition-colors"
                  onClick={() => setExpandedId(isExpanded ? null : qual.id)}
                >
                  <div onClick={(e) => e.stopPropagation()}>
                    <button
                      onClick={() => setBulkSelected((prev) => {
                        const next = new Set(prev);
                        next.has(qual.id) ? next.delete(qual.id) : next.add(qual.id);
                        return next;
                      })}
                      className="text-slate-400 hover:text-primary-600 transition-colors"
                    >
                      {bulkSelected.has(qual.id)
                        ? <CheckSquare className="w-4 h-4 text-primary-600" />
                        : <Square className="w-4 h-4" />}
                    </button>
                  </div>
                  <button className="text-slate-400 hover:text-slate-600 shrink-0">
                    {isExpanded ? <ChevronDown className="w-4 h-4" /> : <ChevronRight className="w-4 h-4" />}
                  </button>

                  <div className="w-9 h-9 rounded-lg bg-primary-50 flex items-center justify-center shrink-0">
                    <Award className="w-4 h-4 text-primary-600" />
                  </div>

                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2 flex-wrap">
                      <span className="font-semibold text-slate-900 text-sm">{qual.code}</span>
                      {!qual.active && (
                        <span className="badge bg-slate-100 text-slate-500">Inactive</span>
                      )}
                      {qual.needs_review && (
                        <span className="inline-flex items-center gap-1 text-[10px] font-semibold px-1.5 py-0.5 rounded-full bg-rose-100 text-rose-700">
                          <ShieldAlert className="w-3 h-3" /> Review Required
                        </span>
                      )}
                    </div>
                    <p className="text-xs text-slate-500 truncate mt-0.5">{qual.name}</p>
                  </div>

                  {/* Status + confidence badges */}
                  <div className="hidden sm:flex items-center gap-2 shrink-0">
                    <span className={`inline-flex items-center gap-1.5 text-xs font-medium px-2.5 py-1 rounded-full ${statusCfg.color}`}>
                      <span className={`w-1.5 h-1.5 rounded-full ${statusCfg.dotColor}`} />
                      {statusCfg.label}
                    </span>
                    {qual.confidence_score && (
                      <span className={`inline-flex items-center gap-1 text-[10px] font-semibold px-1.5 py-0.5 rounded-full ${CONFIDENCE_CONFIG[qual.confidence_score].color}`}>
                        <BarChart2 className="w-3 h-3" />
                        {qual.confidence_score === 'high' ? 'High' : qual.confidence_score === 'medium' ? 'Med' : 'Low'}
                      </span>
                    )}
                  </div>

                  {/* Quick level preview */}
                  {hasLevels && (
                    <div className="hidden lg:flex items-center gap-1 shrink-0">
                      {SIX_SKILLS.map((s) => {
                        const lv = levels[s.key] || 0;
                        return (
                          <div
                            key={s.key}
                            title={`${s.label}: ${lv ? `Level ${lv}` : 'Not set'}`}
                            className={`w-6 h-6 rounded flex items-center justify-center text-[10px] font-bold border ${LEVEL_COLORS[lv]}`}
                          >
                            {lv || '—'}
                          </div>
                        );
                      })}
                    </div>
                  )}

                  <div className="flex items-center gap-1 shrink-0" onClick={(e) => e.stopPropagation()}>
                    <button
                      onClick={() => rerunMapping(qual.id)}
                      disabled={remapping === qual.id}
                      className="p-1.5 text-slate-400 hover:text-blue-600 hover:bg-blue-50 rounded-lg transition-colors"
                      title="Re-run ACSF mapping engine (fetches UoC data from aXcelerate)"
                    >
                      {remapping === qual.id ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Cpu className="w-3.5 h-3.5" />}
                    </button>
                    <button onClick={() => openEditQual(qual)} className="p-1.5 text-slate-400 hover:text-primary-600 hover:bg-primary-50 rounded-lg transition-colors" title="Edit qualification">
                      <Pencil className="w-3.5 h-3.5" />
                    </button>
                    <button onClick={() => setDeleteTarget(qual)} className="p-1.5 text-slate-400 hover:text-rose-600 hover:bg-rose-50 rounded-lg transition-colors" title="Delete qualification">
                      <Trash2 className="w-3.5 h-3.5" />
                    </button>
                  </div>
                </div>

                {/* Expanded details */}
                {isExpanded && (
                  <div className="border-t border-slate-100 bg-slate-50/40 px-4 lg:px-6 py-5 animate-slide-up">
                    {/* ACSF grid */}
                    <div className="mb-5">
                      <div className="flex items-center justify-between mb-3">
                        <h4 className="text-sm font-semibold text-slate-900">ACSF Requirements</h4>
                        <span className={`inline-flex items-center gap-1.5 text-xs font-medium px-2 py-0.5 rounded-full ${statusCfg.color}`}>
                          <span className={`w-1.5 h-1.5 rounded-full ${statusCfg.dotColor}`} />
                          {statusCfg.label}
                        </span>
                      </div>

                      {!hasLevels ? (
                        <div className="flex items-center gap-3 border border-dashed border-rose-200 bg-rose-50 rounded-lg px-4 py-3 text-sm text-rose-700">
                          <AlertCircle className="w-4 h-4 shrink-0" />
                          <span>No ACSF levels configured. <button onClick={() => openEditQual(qual)} className="underline font-medium">Edit this qualification</button> to add requirements.</span>
                        </div>
                      ) : (
                        <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-6 gap-2">
                          {SIX_SKILLS.map((s) => {
                            const lv = levels[s.key] || 0;
                            return (
                              <div key={s.key} className="bg-white rounded-xl border border-slate-200 p-3 text-center">
                                <p className="text-[10px] font-medium text-slate-500 uppercase tracking-wide mb-2 leading-tight">{s.label}</p>
                                <div className={`inline-flex items-center justify-center w-10 h-10 rounded-lg text-lg font-bold border ${LEVEL_COLORS[lv]}`}>
                                  {lv || '—'}
                                </div>
                                <p className="text-[10px] text-slate-400 mt-1.5">{lv ? `Level ${lv}` : 'Not set'}</p>
                              </div>
                            );
                          })}
                        </div>
                      )}
                    </div>

                    {/* Review notice */}
                    {(qual.needs_review || qual.review_reason) && (
                      <div className="flex items-start gap-2.5 bg-rose-50 border border-rose-200 rounded-lg px-3 py-2.5 text-xs text-rose-700 mb-4">
                        <ShieldAlert className="w-4 h-4 shrink-0 mt-0.5" />
                        <div>
                          <p className="font-semibold">Review Required</p>
                          <p className="mt-0.5">{qual.review_reason || 'This mapping has been flagged for administrator review before use.'}</p>
                        </div>
                      </div>
                    )}

                    {/* Metadata row */}
                    <div className="grid grid-cols-2 sm:grid-cols-4 gap-4 pt-4 border-t border-slate-200 text-xs">
                      <div>
                        <p className="text-slate-400 font-medium uppercase tracking-wide">Mapping Source</p>
                        <p className="text-slate-700 mt-1 font-medium">
                          {qual.mapping_source === 'default' ? 'Default Recommendation' :
                           qual.mapping_source === 'custom' ? 'Custom / Reviewed' : '—'}
                        </p>
                      </div>
                      <div>
                        <p className="text-slate-400 font-medium uppercase tracking-wide">Engine Method</p>
                        <p className="text-slate-700 mt-1">
                          {qual.mapping_method ? MAPPING_METHOD_LABELS[qual.mapping_method] : <span className="text-slate-400 italic">—</span>}
                        </p>
                      </div>
                      <div>
                        <p className="text-slate-400 font-medium uppercase tracking-wide">Confidence</p>
                        <p className="mt-1">
                          {qual.confidence_score ? (
                            <span className={`inline-flex items-center gap-1 px-1.5 py-0.5 rounded-full font-semibold ${CONFIDENCE_CONFIG[qual.confidence_score].color}`}>
                              <BarChart2 className="w-3 h-3" />
                              {CONFIDENCE_CONFIG[qual.confidence_score].label}
                            </span>
                          ) : <span className="text-slate-400 italic">—</span>}
                        </p>
                      </div>
                      <div>
                        <p className="text-slate-400 font-medium uppercase tracking-wide">UoC Coverage</p>
                        <p className="text-slate-700 mt-1">
                          {qual.uoc_count > 0
                            ? <>{qual.uoc_matched}/{qual.uoc_count} matched <span className="text-slate-400">({Math.round((qual.uoc_matched / qual.uoc_count) * 100)}%)</span></>
                            : <span className="text-slate-400 italic">Not computed</span>}
                        </p>
                      </div>
                      <div>
                        <p className="text-slate-400 font-medium uppercase tracking-wide">Last Reviewed</p>
                        <p className="text-slate-700 mt-1">
                          {qual.reviewed_at
                            ? new Date(qual.reviewed_at).toLocaleDateString('en-AU', { day: 'numeric', month: 'short', year: 'numeric' })
                            : <span className="text-slate-400 italic">Not reviewed</span>}
                        </p>
                      </div>
                      <div>
                        <p className="text-slate-400 font-medium uppercase tracking-wide">Reviewed By</p>
                        <p className="text-slate-700 mt-1">{qual.reviewed_by || <span className="text-slate-400 italic">—</span>}</p>
                      </div>
                      <div>
                        <p className="text-slate-400 font-medium uppercase tracking-wide">Version</p>
                        <p className="text-slate-700 mt-1">{qual.mapping_version || 1}</p>
                      </div>
                      {qual.axcelerate_course_id != null && (
                        <div>
                          <p className="text-slate-400 font-medium uppercase tracking-wide">aXcelerate ID</p>
                          <p className="text-slate-700 mt-1">{qual.axcelerate_course_id}</p>
                        </div>
                      )}
                      {qual.internal_notes && (
                        <div className="col-span-2 sm:col-span-4">
                          <p className="text-slate-400 font-medium uppercase tracking-wide">Internal Notes</p>
                          <p className="text-slate-700 mt-1 whitespace-pre-line">{qual.internal_notes}</p>
                        </div>
                      )}
                    </div>

                    <MappingApprovalPanel qualificationId={qual.id} onChanged={loadData} />

                    {/* Mapping Evidence link */}
                    <div className="mt-4 flex items-center justify-between bg-blue-50 border border-blue-200 rounded-lg px-4 py-3">
                      <div className="flex items-center gap-2.5">
                        <BookOpen className="w-4 h-4 text-blue-600 shrink-0" />
                        <div>
                          <p className="text-xs font-semibold text-blue-900">Mapping Evidence Record</p>
                          <p className="text-xs text-blue-700 mt-0.5">Document how this ACSF mapping was determined for compliance audits.</p>
                        </div>
                      </div>
                      <button
                        onClick={() => setEvidenceQualId(qual.id)}
                        className="btn-secondary text-xs px-3 py-1.5 shrink-0 gap-1.5"
                      >
                        <BookOpen className="w-3.5 h-3.5" /> View Evidence
                      </button>
                    </div>

                    {/* Re-run mapping CTA for unmapped quals */}
                    {!hasLevels && (
                      <div className="mt-4 flex items-center gap-3 bg-blue-50 border border-blue-200 rounded-lg px-4 py-3">
                        <Cpu className="w-4 h-4 text-blue-600 shrink-0" />
                        <p className="text-xs text-blue-800 flex-1">
                          Run the ACSF mapping engine to automatically compute recommended levels from this qualification's Units of Competency.
                        </p>
                        <button
                          onClick={() => rerunMapping(qual.id)}
                          disabled={remapping === qual.id}
                          className="btn-secondary text-xs px-3 py-1.5 shrink-0"
                        >
                          {remapping === qual.id ? <><Loader2 className="w-3.5 h-3.5 animate-spin" /> Running…</> : <><Cpu className="w-3.5 h-3.5" /> Run Mapping Engine</>}
                        </button>
                      </div>
                    )}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}

      {/* ══════════════════════════════════════════════════════════════════════
          Qual modal — create (2-step) or edit (single-page with full fields)
      ══════════════════════════════════════════════════════════════════════ */}
      {showQualModal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
          <div className="absolute inset-0 bg-slate-900/50 backdrop-blur-sm" onClick={() => !saving && setShowQualModal(false)} />
          <div className="relative card w-full max-w-xl flex flex-col max-h-[90vh] animate-slide-up">

            {/* Modal header */}
            <div className="flex items-center justify-between px-6 py-5 border-b border-slate-100 shrink-0">
              <div className="flex items-center gap-3">
                <div className="w-9 h-9 bg-primary-50 rounded-lg flex items-center justify-center">
                  <Award className="w-4 h-4 text-primary-600" />
                </div>
                <div>
                  <h3 className="text-base font-semibold text-slate-900">
                    {editingQual ? 'Edit Qualification' : 'New Qualification'}
                  </h3>
                  {!editingQual && (
                    <div className="flex items-center gap-2 mt-0.5">
                      <span className={`text-xs font-medium ${qualStep === 1 ? 'text-primary-600' : 'text-slate-400'}`}>1. Details</span>
                      <span className="text-slate-300 text-xs">›</span>
                      <span className={`text-xs font-medium ${qualStep === 2 ? 'text-primary-600' : 'text-slate-400'}`}>2. ACSF Requirements</span>
                    </div>
                  )}
                </div>
              </div>
              <button onClick={() => !saving && setShowQualModal(false)} className="text-slate-400 hover:text-slate-600"><X className="w-5 h-5" /></button>
            </div>

            {/* Modal body */}
            <div className="flex-1 overflow-y-auto px-6 py-5 space-y-5">
              {qualError && (
                <div className="flex items-center gap-2 bg-rose-50 border border-rose-200 text-rose-700 rounded-lg px-3 py-2 text-sm">
                  <AlertCircle className="w-4 h-4 shrink-0" />
                  <span className="flex-1">{qualError}</span>
                  <button onClick={() => setQualError(null)} className="opacity-60 hover:opacity-100"><X className="w-3.5 h-3.5" /></button>
                </div>
              )}

              {/* ── Step 1 / Edit: qualification details ── */}
              {(qualStep === 1) && (
                <div className="space-y-4">
                  <div>
                    <label className="label">Qualification Code</label>
                    <div className="flex gap-2">
                      <input
                        className="input flex-1"
                        value={qualForm.code}
                        onChange={(e) => setQualForm({ ...qualForm, code: e.target.value.toUpperCase() })}
                        placeholder="e.g. BSB30120"
                        autoFocus
                      />
                      {!editingQual && (
                        <button
                          type="button"
                          onClick={lookupAxcelerateCode}
                          disabled={!qualForm.code.trim() || lookingUp}
                          className="btn-secondary shrink-0 px-3"
                          title="Look up in aXcelerate"
                        >
                          {lookingUp ? <Loader2 className="w-4 h-4 animate-spin" /> : <Search className="w-4 h-4" />}
                        </button>
                      )}
                    </div>
                    {!editingQual && (
                      <p className="text-xs text-slate-400 mt-1">Enter the code then press the search button to auto-fill from aXcelerate. ACSF levels will also be pre-filled if a library mapping exists.</p>
                    )}
                  </div>
                  <div>
                    <label className="label">Name</label>
                    <input
                      className="input"
                      value={qualForm.name}
                      onChange={(e) => setQualForm({ ...qualForm, name: e.target.value })}
                      placeholder="e.g. Certificate III in Business"
                    />
                  </div>
                  <div>
                    <label className="label">aXcelerate Course ID <span className="text-slate-400 font-normal">(optional)</span></label>
                    <input
                      className="input"
                      type="number"
                      value={qualForm.axcelerate_course_id}
                      onChange={(e) => setQualForm({ ...qualForm, axcelerate_course_id: e.target.value })}
                      placeholder="Link to an aXcelerate course"
                    />
                  </div>
                  <div>
                    <label className="label">Status</label>
                    <label className="flex items-center gap-3 cursor-pointer">
                      <button
                        type="button"
                        role="switch"
                        aria-checked={qualForm.active}
                        onClick={() => setQualForm({ ...qualForm, active: !qualForm.active })}
                        className={`relative inline-flex h-6 w-11 items-center rounded-full transition-colors ${qualForm.active ? 'bg-primary-600' : 'bg-slate-300'}`}
                      >
                        <span className={`inline-block h-4 w-4 transform rounded-full bg-white transition-transform ${qualForm.active ? 'translate-x-6' : 'translate-x-1'}`} />
                      </button>
                      <span className="text-sm text-slate-700">{qualForm.active ? 'Active' : 'Inactive'}</span>
                    </label>
                  </div>
                </div>
              )}

              {/* ── Step 2 / Edit: ACSF levels ── */}
              {(qualStep === 2 || editingQual) && (
                <div className="space-y-5">
                  {/* Summary pill when editing */}
                  {editingQual && (
                    <div className="bg-slate-50 rounded-lg px-4 py-3 border border-slate-200">
                      <p className="text-sm font-semibold text-slate-900">{qualForm.code}</p>
                      <p className="text-xs text-slate-500 mt-0.5 truncate">{qualForm.name}</p>
                    </div>
                  )}

                  {/* Default mapping banner */}
                  {defaultLevels && (
                    <div className="flex items-center justify-between gap-3 bg-emerald-50 border border-emerald-200 rounded-lg px-4 py-2.5">
                      <div className="flex items-center gap-2 text-xs text-emerald-800">
                        <CheckCircle2 className="w-4 h-4 text-emerald-600 shrink-0" />
                        <span>A <strong>recommended default mapping</strong> exists for this qualification.</span>
                      </div>
                      <button
                        type="button"
                        onClick={restoreDefaultMapping}
                        className="inline-flex items-center gap-1.5 text-xs font-medium text-emerald-700 hover:text-emerald-900 whitespace-nowrap"
                      >
                        <RotateCcw className="w-3.5 h-3.5" /> Restore Default
                      </button>
                    </div>
                  )}

                  {/* 6-skill level pickers */}
                  <div>
                    <label className="label mb-3">ACSF Minimum Levels</label>
                    <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                      {SIX_SKILLS.map((s) => {
                        const current = skillLevels[s.key] || 0;
                        const isDefault = defaultLevels && defaultLevels[s.key] === current;
                        return (
                          <div key={s.key} className="bg-white rounded-xl border border-slate-200 p-3">
                            <div className="flex items-center justify-between mb-2">
                              <p className="text-xs font-semibold text-slate-700">{s.label}</p>
                              {current > 0 && (
                                <span className={`text-[10px] font-semibold px-1.5 py-0.5 rounded-full border ${LEVEL_COLORS[current]}`}>
                                  {isDefault ? 'Default' : 'Custom'}
                                </span>
                              )}
                            </div>
                            <div className="flex gap-1">
                              <button
                                type="button"
                                onClick={() => setSkillLevels((prev) => ({ ...prev, [s.key]: 0 }))}
                                className={`flex-1 py-1.5 rounded-md text-xs font-medium transition-all border ${
                                  current === 0
                                    ? 'border-slate-400 bg-slate-100 text-slate-600'
                                    : 'border-slate-200 text-slate-400 hover:border-slate-300'
                                }`}
                              >
                                —
                              </button>
                              {ACSF_LEVELS.map((lv) => (
                                <button
                                  key={lv}
                                  type="button"
                                  onClick={() => setSkillLevels((prev) => ({ ...prev, [s.key]: lv }))}
                                  className={`flex-1 py-1.5 rounded-md text-xs font-medium transition-all border ${
                                    current === lv
                                      ? `${LEVEL_COLORS[lv]} shadow-sm`
                                      : 'border-slate-200 text-slate-500 hover:border-slate-300 hover:bg-slate-50'
                                  }`}
                                >
                                  {lv}
                                </button>
                              ))}
                            </div>
                          </div>
                        );
                      })}
                    </div>
                    <p className="text-xs text-slate-400 mt-2">Select — to leave a skill unmapped. Levels 1 (basic) → 5 (advanced).</p>
                  </div>

                  {/* Review metadata (edit mode only) */}
                  {editingQual && (
                    <div className="space-y-4 pt-4 border-t border-slate-200">
                      <h4 className="text-xs font-semibold text-slate-500 uppercase tracking-wide">Review Record</h4>
                      <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                        <div>
                          <label className="label">Reviewed By</label>
                          <input
                            className="input"
                            value={editMeta.reviewed_by}
                            onChange={(e) => setEditMeta({ ...editMeta, reviewed_by: e.target.value })}
                            placeholder="Name or email"
                          />
                        </div>
                        <div>
                          <label className="label">Review Date</label>
                          <input
                            className="input"
                            type="date"
                            value={editMeta.reviewed_at}
                            onChange={(e) => setEditMeta({ ...editMeta, reviewed_at: e.target.value })}
                          />
                        </div>
                      </div>
                      <div>
                        <label className="label">Internal Notes</label>
                        <textarea
                          className="input resize-none"
                          rows={3}
                          value={editMeta.internal_notes}
                          onChange={(e) => setEditMeta({ ...editMeta, internal_notes: e.target.value })}
                          placeholder="Notes for internal use (not shown to students)"
                        />
                      </div>
                    </div>
                  )}
                </div>
              )}
            </div>

            {/* Modal footer */}
            <div className="flex items-center justify-between gap-2 px-6 py-4 border-t border-slate-100 shrink-0">
              <div>
                {!editingQual && qualStep === 2 ? (
                  <button onClick={() => setQualStep(1)} className="btn-secondary" disabled={saving}>
                    <ArrowLeft className="w-4 h-4" /> Back
                  </button>
                ) : (
                  <button onClick={() => setShowQualModal(false)} className="btn-secondary" disabled={saving}>Cancel</button>
                )}
              </div>
              <div className="flex items-center gap-2">
                {defaultLevels && (qualStep === 2 || editingQual) && (
                  <button type="button" onClick={restoreDefaultMapping} className="btn-secondary" title="Restore recommended default mapping">
                    <RotateCcw className="w-4 h-4" /> Restore Default
                  </button>
                )}
                {!editingQual && qualStep === 1 ? (
                  <button
                    onClick={() => {
                      if (!qualForm.code.trim() || !qualForm.name.trim()) { setQualError('Code and name are required.'); return; }
                      setQualError(null);
                      // Auto-populate from library if not already done
                      const code = qualForm.code.trim().toUpperCase();
                      const libEntry = mappingLibrary[code];
                      if (libEntry && !SIX_SKILLS.some((s) => (skillLevels[s.key] ?? 0) > 0)) {
                        const levels = {
                          learning: libEntry.learning_level ?? 0,
                          reading: libEntry.reading_level ?? 0,
                          writing: libEntry.writing_level ?? 0,
                          oral_communication: libEntry.oral_comm_level ?? 0,
                          numeracy: libEntry.numeracy_level ?? 0,
                          digital_literacy: libEntry.digital_level ?? 0,
                        };
                        setSkillLevels(levels);
                        setDefaultLevels(levels);
                      }
                      setQualStep(2);
                    }}
                    className="btn-primary"
                  >
                    Next <ArrowRight className="w-4 h-4" />
                  </button>
                ) : (
                  <button onClick={saveQual} className="btn-primary" disabled={saving}>
                    {saving ? (
                      <><Loader2 className="w-4 h-4 animate-spin" /> Saving...</>
                    ) : editingQual ? (
                      'Save Changes'
                    ) : (
                      <><CheckCircle2 className="w-4 h-4" /> Create Qualification</>
                    )}
                  </button>
                )}
              </div>
            </div>
          </div>
        </div>
      )}

      {/* ── Delete confirm ── */}
      {deleteTarget && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
          <div className="absolute inset-0 bg-slate-900/50 backdrop-blur-sm" onClick={() => !saving && setDeleteTarget(null)} />
          <div className="relative card w-full max-w-sm p-6 animate-slide-up">
            <div className="flex items-center gap-3 mb-4">
              <div className="w-10 h-10 bg-rose-50 rounded-lg flex items-center justify-center">
                <AlertCircle className="w-5 h-5 text-rose-600" />
              </div>
              <h3 className="text-base font-semibold text-slate-900">Confirm Deletion</h3>
            </div>
            <p className="text-sm text-slate-600 mb-5">
              Delete qualification <strong>{deleteTarget.code}</strong> — {deleteTarget.name}?{' '}
              All ACSF requirements will be removed. This cannot be undone.
            </p>
            <div className="flex items-center justify-end gap-2">
              <button onClick={() => setDeleteTarget(null)} className="btn-secondary" disabled={saving}>Cancel</button>
              <button
                onClick={confirmDelete}
                className="btn bg-rose-600 text-white hover:bg-rose-700 active:scale-[0.98] shadow-sm inline-flex items-center justify-center gap-2 rounded-lg px-4 py-2 text-sm font-medium transition-all duration-200 disabled:opacity-50"
                disabled={saving}
              >
                {saving ? <><Loader2 className="w-4 h-4 animate-spin" /> Deleting...</> : <><Trash2 className="w-4 h-4" /> Delete</>}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* ── Bulk delete confirm ── */}
      {showBulkDeleteConfirm && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
          <div className="absolute inset-0 bg-slate-900/50 backdrop-blur-sm" onClick={() => !bulkDeleting && setShowBulkDeleteConfirm(false)} />
          <div className="relative card w-full max-w-sm p-6 animate-slide-up">
            <div className="flex items-center gap-3 mb-4">
              <div className="w-10 h-10 bg-rose-50 rounded-lg flex items-center justify-center">
                <Trash2 className="w-5 h-5 text-rose-600" />
              </div>
              <h3 className="text-base font-semibold text-slate-900">Delete {bulkSelected.size} Qualification{bulkSelected.size !== 1 ? 's' : ''}?</h3>
            </div>
            <p className="text-sm text-slate-600 mb-3">
              This will permanently delete the following qualifications and all their ACSF requirements:
            </p>
            <ul className="text-sm text-slate-700 space-y-1 mb-5 max-h-40 overflow-y-auto bg-slate-50 rounded-lg p-3 border border-slate-200">
              {qualifications.filter((q) => bulkSelected.has(q.id)).map((q) => (
                <li key={q.id} className="flex items-center gap-2">
                  <span className="font-medium text-slate-900">{q.code}</span>
                  <span className="text-slate-400 text-xs truncate">{q.name}</span>
                </li>
              ))}
            </ul>
            <p className="text-xs text-slate-400 mb-5">This cannot be undone.</p>
            <div className="flex items-center justify-end gap-2">
              <button onClick={() => setShowBulkDeleteConfirm(false)} className="btn-secondary" disabled={bulkDeleting}>Cancel</button>
              <button
                onClick={confirmBulkDelete}
                className="btn bg-rose-600 text-white hover:bg-rose-700 active:scale-[0.98] shadow-sm inline-flex items-center justify-center gap-2 rounded-lg px-4 py-2 text-sm font-medium transition-all duration-200 disabled:opacity-50"
                disabled={bulkDeleting}
              >
                {bulkDeleting ? <><Loader2 className="w-4 h-4 animate-spin" /> Deleting…</> : <><Trash2 className="w-4 h-4" /> Delete {bulkSelected.size}</>}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* ── aXcelerate import modal ── */}
      {showImportModal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
          <div className="absolute inset-0 bg-slate-900/50 backdrop-blur-sm" onClick={() => !importing && !previewing && setShowImportModal(false)} />
          <div className="relative card w-full max-w-2xl flex flex-col max-h-[85vh] animate-slide-up">

            <div className="flex items-center justify-between p-6 border-b border-slate-100 shrink-0">
              <div className="flex items-center gap-3">
                <div className="w-10 h-10 bg-primary-50 rounded-lg flex items-center justify-center">
                  <Download className="w-5 h-5 text-primary-600" />
                </div>
                <div>
                  <h3 className="text-base font-semibold text-slate-900">Import from aXcelerate</h3>
                  <p className="text-xs text-slate-500 mt-0.5">
                    {previewing ? 'Fetching qualifications…' : previewError ? 'Could not load courses' : `${previewCourses.length} qualification${previewCourses.length !== 1 ? 's' : ''} found`}
                  </p>
                </div>
              </div>
              <button onClick={() => !importing && !previewing && setShowImportModal(false)} className="text-slate-400 hover:text-slate-600"><X className="w-5 h-5" /></button>
            </div>

            <div className="flex-1 overflow-y-auto p-6">
              {previewing && (
                <div className="flex flex-col items-center justify-center py-16 gap-3 text-slate-400">
                  <Loader2 className="w-8 h-8 animate-spin text-primary-500" />
                  <p className="text-sm">Connecting to aXcelerate…</p>
                </div>
              )}

              {previewError && (
                <div className="flex items-start gap-3 bg-rose-50 border border-rose-200 text-rose-700 rounded-lg p-4 text-sm">
                  <AlertCircle className="w-4 h-4 mt-0.5 shrink-0" />
                  <div className="flex-1">
                    <p className="font-medium">Failed to fetch from aXcelerate</p>
                    <p className="mt-0.5 text-rose-600">{previewError}</p>
                  </div>
                  <button onClick={handleOpenImportModal} className="ml-auto shrink-0 text-rose-500 hover:text-rose-700" title="Retry">
                    <RefreshCw className="w-4 h-4" />
                  </button>
                </div>
              )}

              {!previewing && !previewError && previewCourses.length === 0 && (
                <div className="text-center py-10 text-slate-400">
                  <Award className="w-10 h-10 mx-auto mb-3 opacity-40" />
                  <p className="text-sm font-medium text-slate-600">No qualifications found in aXcelerate.</p>
                  <p className="text-sm mt-1 max-w-xs mx-auto">
                    Only qualifications with <strong className="text-slate-700">Display Online</strong> enabled in aXcelerate are visible via the API. Enable that setting then retry.
                  </p>
                </div>
              )}

              {!previewing && !previewError && previewCourses.length > 0 && (
                <>
                  <div className="flex items-center justify-between mb-3">
                    <p className="text-xs text-slate-500"><span className="font-medium text-slate-700">{selected.size}</span> of {previewCourses.length} selected</p>
                    <div className="flex items-center gap-2">
                      <button onClick={selectAll} className="text-xs text-primary-600 hover:text-primary-800 font-medium">Select all</button>
                      <span className="text-slate-300">·</span>
                      <button onClick={deselectAll} className="text-xs text-slate-500 hover:text-slate-700 font-medium">Deselect all</button>
                    </div>
                  </div>

                  <div className="space-y-1.5">
                    {previewCourses.map((course) => {
                      const isChecked = selected.has(course.courseId);
                      const inLibrary = !!mappingLibrary[course.code.toUpperCase()];
                      const statusConfig = { new: { label: 'New', cls: 'bg-emerald-100 text-emerald-700' }, update: { label: 'Update', cls: 'bg-amber-100 text-amber-700' }, exists: { label: 'No change', cls: 'bg-slate-100 text-slate-500' } }[course.status];
                      return (
                        <label key={course.courseId} className={`flex items-center gap-3 p-3 rounded-lg border cursor-pointer transition-colors ${isChecked ? 'border-primary-200 bg-primary-50/40' : 'border-slate-200 bg-white hover:bg-slate-50'}`}>
                          <input type="checkbox" checked={isChecked} onChange={() => toggleSelect(course.courseId)} className="w-4 h-4 rounded text-primary-600 border-slate-300 cursor-pointer shrink-0" />
                          <div className="flex-1 min-w-0">
                            <div className="flex items-center gap-2 flex-wrap">
                              <span className="text-sm font-semibold text-slate-900">{course.code}</span>
                              <span className={`text-[10px] font-semibold px-1.5 py-0.5 rounded-full ${statusConfig.cls}`}>{statusConfig.label}</span>
                              {inLibrary && (
                                <span className="text-[10px] font-semibold px-1.5 py-0.5 rounded-full bg-emerald-100 text-emerald-700">ACSF mapping available</span>
                              )}
                            </div>
                            <p className="text-xs text-slate-500 mt-0.5 truncate">{course.name}</p>
                          </div>
                        </label>
                      );
                    })}
                  </div>

                  <p className="text-xs text-slate-400 mt-3 flex items-start gap-1.5">
                    <AlertCircle className="w-3.5 h-3.5 shrink-0 mt-0.5 text-amber-400" />
                    Only qualifications with <strong className="text-slate-500 mx-0.5">Display Online</strong> enabled in aXcelerate appear here. If a qualification is missing, enable that setting in aXcelerate and re-open this dialog.
                  </p>
                </>
              )}
            </div>

            {!previewing && !previewError && previewCourses.length > 0 && (
              <div className="flex items-center justify-between gap-3 p-6 border-t border-slate-100 shrink-0 bg-slate-50/50 rounded-b-xl">
                <button onClick={() => setShowImportModal(false)} className="btn-secondary" disabled={importing}>Cancel</button>
                <button onClick={handleImport} disabled={importing || selected.size === 0} className="btn-primary">
                  {importing ? <><Loader2 className="w-4 h-4 animate-spin" /> Importing…</> : <><CheckCircle2 className="w-4 h-4" /> Import Selected ({selected.size})</>}
                </button>
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
