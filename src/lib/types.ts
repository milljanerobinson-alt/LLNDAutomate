export type UserRole = 'admin' | 'trainer' | 'candidate';

export type AssessmentType = 'lln' | 'digital';
export type AssessmentStatus = 'draft' | 'active' | 'archived';
export type Domain = 'language' | 'literacy' | 'numeracy' | 'digital';
export type QuestionType = 'multiple_choice' | 'short_answer' | 'scale';

export type InvitationStatus =
  | 'sent' | 'opened' | 'in_progress' | 'completed'
  | 'lln_required' | 'invitation_sent' | 'lln_opened'
  | 'digital_invitation_sent' | 'digital_opened' | 'awaiting_submission'
  | 'lln_complete' | 'digital_complete' | 'support_generated' | 'closed';

export type StudentStatus =
  | 'lln_required' | 'invitation_sent' | 'lln_opened'
  | 'digital_invitation_sent' | 'digital_opened' | 'awaiting_submission'
  | 'lln_complete' | 'digital_complete' | 'support_generated' | 'closed';
export type IndividualStatus = 'pending' | 'opened' | 'in_progress' | 'completed';
export type CourseRecommendation = 'suitable' | 'suitable_with_support' | 'not_yet_suitable';

export type NotificationType =
  | 'sent' | 'reminder' | 'completed' | 'overdue'
  | 'trainer_review' | 'intervention' | 'support_plan';

export type InterventionStatus = 'open' | 'scheduled_reassessment' | 'closed';

export interface Profile {
  id: string;
  full_name: string;
  email: string;
  role: UserRole;
  avatar_url: string | null;
  axcelerate_contact_id: number | null;
  otp_disabled: boolean;
  is_active: boolean;
  organisation_id: string | null;
  created_at: string;
}

export type MappingStatus =
  | 'mapping_required'
  | 'default_mapping_applied'
  | 'custom_mapping'
  | 'review_required';

export type ConfidenceScore = 'high' | 'medium' | 'low';

export type MappingMethod =
  | 'qualification_library'
  | 'uoc_direct'
  | 'uoc_hybrid'
  | 'uoc_inferred'
  | 'no_uoc_data'
  | 'manual';

export interface Qualification {
  id: string;
  code: string;
  name: string;
  axcelerate_course_id: number | null;
  active: boolean;
  mapping_status: MappingStatus | null;
  mapping_source: 'default' | 'custom' | null;
  reviewed_at: string | null;
  reviewed_by: string | null;
  internal_notes: string | null;
  mapping_version: number;
  default_mapping_snapshot: Record<string, number> | null;
  confidence_score: ConfidenceScore | null;
  mapping_method: MappingMethod | null;
  needs_review: boolean;
  review_reason: string | null;
  uoc_count: number;
  uoc_matched: number;
  created_at: string;
}

export interface QualificationLLNRequirement {
  id: string;
  qualification_id: string;
  domain: Domain;
  acsf_skill: string;
  minimum_acsf_level: number;
  created_at: string;
}

export interface QualificationMappingLibrary {
  id: string;
  code: string;
  name: string;
  training_package: string | null;
  learning_level: number | null;
  reading_level: number | null;
  writing_level: number | null;
  oral_comm_level: number | null;
  numeracy_level: number | null;
  digital_level: number | null;
  mapping_notes: string | null;
  last_updated: string;
  created_at: string;
}

export interface Assessment {
  id: string;
  type: AssessmentType;
  title: string;
  description: string | null;
  total_questions: number;
  pass_threshold: number;
  acsf_level_mapping: Record<string, number>;
  version: string;
  created_by: string | null;
  created_at: string;
  updated_at: string;
  status: AssessmentStatus;
  axcelerate_course_id: number | null;
}

export interface AssessmentQuestion {
  id: string;
  assessment_id: string;
  question_text: string;
  domain: Domain;
  acsf_skill: string;
  acsf_level_target: number | null;
  question_type: QuestionType;
  options: string[];
  correct_answer: string | null;
  order_index: number;
  points: number;
  mapping_rationale: string | null;
  version: string;
  created_at: string;
}

export interface AssessmentValidation {
  id: string;
  assessment_id: string;
  validation_date: string;
  reviewer: string;
  validation_status: 'validated' | 'needs_revision';
  industry_consultation_notes: string | null;
  review_due_date: string | null;
  validation_history: any[];
  created_at: string;
}

export interface AssessmentVersionHistory {
  id: string;
  assessment_id: string;
  version: string;
  change_summary: string | null;
  changed_by: string | null;
  changed_at: string;
  snapshot: Record<string, any>;
}

export interface AssessmentInvitation {
  id: string;
  qualification_id: string | null;
  candidate_email: string;
  candidate_name: string;
  candidate_dob: string | null;
  unique_token: string;
  lln_token: string | null;
  lln_status: 'pending' | 'in_progress' | 'completed' | null;
  lln_acsf_outcomes: Record<string, number> | null;
  lln_completed_at: string | null;
  digital_token: string | null;
  digital_status: 'pending' | 'in_progress' | 'completed' | null;
  digital_score: number | null;
  digital_completed_at: string | null;
  rto_name: string | null;
  student_id: string | null;
  enrolment_id: string | null;
  status: InvitationStatus;
  sent_at: string;
  opened_at: string | null;
  started_at: string | null;
  completed_at: string | null;
  progress_percent: number;
  due_date: string | null;
  identity_verified: boolean;
  identity_verification_method: string | null;
  identity_verified_at: string | null;
  axcelerate_contact_id: number | null;
  course_recommendation: CourseRecommendation | null;
  recommendation_reasons: string[];
  trainer_override: string | null;
  trainer_override_reason: string | null;
  trainer_override_by: string | null;
  trainer_override_at: string | null;
  created_by: string | null;
  created_at: string;
}

export interface Student {
  id: string;
  axcelerate_contact_id: number | null;
  first_name: string;
  last_name: string;
  date_of_birth: string | null;
  email: string | null;
  phone: string | null;
  current_status: StudentStatus;
  latest_invitation_id: string | null;
  created_at: string;
  updated_at: string;
}

export interface Enrolment {
  id: string;
  student_id: string;
  axcelerate_course_id: number | null;
  qualification_id: string | null;
  enrolment_date: string | null;
  created_at: string;
}

export interface StudentLifecycleEvent {
  id: string;
  student_id: string | null;
  invitation_id: string | null;
  event_type: string;
  from_status: StudentStatus | null;
  to_status: StudentStatus | null;
  actor: 'system' | 'trainer' | 'candidate';
  note: string | null;
  event_data: Record<string, unknown> | null;
  created_at: string;
}

export interface InvitationAssessment {
  id: string;
  invitation_id: string;
  assessment_id: string;
  individual_status: IndividualStatus;
  individual_score: number | null;
  individual_passed: boolean | null;
  individual_completed_at: string | null;
  acsf_outcomes: Record<string, number>;
  created_at: string;
}

export interface AssessmentResponse {
  id: string;
  invitation_id: string;
  assessment_id: string;
  question_id: string;
  question_version: string | null;
  answer: any;
  submitted_at: string;
}

export interface SupportPlan {
  id: string;
  invitation_id: string;
  generated_by: 'ai' | 'trainer';
  content: SupportPlanContent;
  status: 'draft' | 'approved';
  trainer_id: string | null;
  trainer_comments: string | null;
  created_at: string;
  updated_at: string;
  approved_at: string | null;
}

export interface SupportPlanContent {
  domain_findings: { domain: string; acsf_level: number; finding: string }[];
  reading_support: string[];
  numeracy_support: string[];
  extra_resources: string[];
  referral_recommendations: string[];
  reasonable_adjustments: string[];
  trainer_action_items: string[];
}

export interface InterventionCase {
  id: string;
  invitation_id: string;
  qualification_id: string | null;
  status: InterventionStatus;
  trigger_reason: string | null;
  closing_summary: string | null;
  opened_at: string;
  closed_at: string | null;
  opened_by: string | null;
  created_at: string;
}

export interface InterventionNote {
  id: string;
  intervention_case_id: string;
  author_id: string | null;
  note_text: string;
  created_at: string;
}

export interface InterventionEvidence {
  id: string;
  intervention_case_id: string;
  file_name: string;
  file_url: string;
  file_type: string | null;
  uploaded_by: string | null;
  uploaded_at: string;
  description: string | null;
}

export interface InterventionSupportStrategy {
  id: string;
  intervention_case_id: string;
  strategy_text: string;
  status: 'active' | 'completed';
  created_at: string;
}

export interface InterventionReassessment {
  id: string;
  intervention_case_id: string;
  scheduled_date: string;
  status: 'scheduled' | 'completed' | 'no_show';
  new_invitation_id: string | null;
  created_at: string;
}

export interface NotificationLog {
  id: string;
  invitation_id: string | null;
  type: NotificationType;
  recipient_email: string;
  recipient_name: string | null;
  subject: string;
  body: string | null;
  sent_at: string;
  status: 'sent' | 'failed' | 'pending';
}

export interface AuditTrailEntry {
  id: string;
  invitation_id: string | null;
  event_type: string;
  event_data: Record<string, any>;
  actor: 'system' | 'trainer' | 'candidate' | 'admin';
  actor_id: string | null;
  timestamp: string;
  ip_address: string | null;
}

export interface AxcelerateSyncLog {
  id: string;
  invitation_id: string | null;
  sync_type: 'contact_search' | 'contact_create' | 'enrol' | 'note' | 'outcome';
  request_payload: Record<string, any> | null;
  response_payload: Record<string, any> | null;
  status: 'pending' | 'success' | 'failed';
  error: string | null;
  synced_at: string;
}

export const DOMAIN_LABELS: Record<Domain, string> = {
  language: 'Language',
  literacy: 'Literacy',
  numeracy: 'Numeracy',
  digital: 'Digital Literacy',
};

export const ACSF_SKILLS: Record<Domain, string[]> = {
  language: ['Oral Communication'],
  literacy: ['Learning', 'Reading', 'Writing'],
  numeracy: ['Numeracy'],
  digital: ['Digital Literacy'],
};

export const SIX_SKILLS: Array<{ domain: Domain; skill: string; key: string; label: string }> = [
  { domain: 'literacy', skill: 'Learning', key: 'learning', label: 'Learning' },
  { domain: 'literacy', skill: 'Reading', key: 'reading', label: 'Reading' },
  { domain: 'literacy', skill: 'Writing', key: 'writing', label: 'Writing' },
  { domain: 'language', skill: 'Oral Communication', key: 'oral_communication', label: 'Oral Communication' },
  { domain: 'numeracy', skill: 'Numeracy', key: 'numeracy', label: 'Numeracy' },
  { domain: 'digital', skill: 'Digital Literacy', key: 'digital_literacy', label: 'Digital Literacy' },
];

export const CONFIDENCE_CONFIG: Record<ConfidenceScore, { label: string; color: string; dotColor: string }> = {
  high:   { label: 'High Confidence',   color: 'bg-emerald-100 text-emerald-700', dotColor: 'bg-emerald-500' },
  medium: { label: 'Medium Confidence', color: 'bg-amber-100 text-amber-700',    dotColor: 'bg-amber-500'   },
  low:    { label: 'Low Confidence',    color: 'bg-rose-100 text-rose-700',       dotColor: 'bg-rose-500'    },
};

export const MAPPING_METHOD_LABELS: Record<MappingMethod, string> = {
  qualification_library: 'Qualification Library Match',
  uoc_direct:            'UoC Direct Match',
  uoc_hybrid:            'UoC Hybrid (Direct + Inferred)',
  uoc_inferred:          'UoC Inferred (Keyword Analysis)',
  no_uoc_data:           'No UoC Data Available',
  manual:                'Manually Set',
};

export const MAPPING_STATUS_CONFIG: Record<MappingStatus, { label: string; color: string; dotColor: string }> = {
  default_mapping_applied: { label: 'Default Mapping', color: 'bg-emerald-100 text-emerald-700', dotColor: 'bg-emerald-500' },
  custom_mapping:          { label: 'Custom Mapping',  color: 'bg-amber-100 text-amber-700',   dotColor: 'bg-amber-500' },
  mapping_required:        { label: 'Mapping Required', color: 'bg-rose-100 text-rose-700',    dotColor: 'bg-rose-500' },
  review_required:         { label: 'Review Required',  color: 'bg-slate-100 text-slate-600',  dotColor: 'bg-slate-400' },
};

export const LEVEL_COLORS: Record<number, string> = {
  0: 'bg-slate-100 text-slate-400 border-slate-200',
  1: 'bg-slate-200 text-slate-700 border-slate-300',
  2: 'bg-amber-100 text-amber-700 border-amber-200',
  3: 'bg-blue-100 text-blue-700 border-blue-200',
  4: 'bg-emerald-100 text-emerald-700 border-emerald-200',
  5: 'bg-teal-100 text-teal-700 border-teal-200',
};

export const STATUS_COLORS: Partial<Record<InvitationStatus, string>> = {
  sent: 'bg-slate-100 text-slate-700',
  opened: 'bg-blue-100 text-blue-700',
  in_progress: 'bg-amber-100 text-amber-700',
  completed: 'bg-emerald-100 text-emerald-700',
  lln_required: 'bg-slate-100 text-slate-600',
  invitation_sent: 'bg-blue-100 text-blue-700',
  lln_opened: 'bg-amber-100 text-amber-700',
  digital_invitation_sent: 'bg-blue-100 text-blue-700',
  digital_opened: 'bg-amber-100 text-amber-700',
  awaiting_submission: 'bg-orange-100 text-orange-700',
  lln_complete: 'bg-teal-100 text-teal-700',
  digital_complete: 'bg-teal-100 text-teal-700',
  support_generated: 'bg-emerald-100 text-emerald-700',
  closed: 'bg-slate-100 text-slate-500',
};

export type StudentTab = 'in_progress' | 'completed';

export const STUDENT_STATUS_CONFIG: Record<StudentStatus, {
  label: string;
  tab: StudentTab;
  color: string;
  dotColor: string;
}> = {
  lln_required:           { label: 'LLN Required',          tab: 'in_progress', color: 'bg-slate-100 text-slate-600',    dotColor: 'bg-slate-400' },
  invitation_sent:        { label: 'Invitation Sent',        tab: 'in_progress', color: 'bg-blue-100 text-blue-700',      dotColor: 'bg-blue-500' },
  lln_opened:             { label: 'LLN In Progress',        tab: 'in_progress', color: 'bg-amber-100 text-amber-700',    dotColor: 'bg-amber-500' },
  digital_invitation_sent:{ label: 'Digital Invited',        tab: 'in_progress', color: 'bg-blue-100 text-blue-700',      dotColor: 'bg-blue-500' },
  digital_opened:         { label: 'Digital In Progress',    tab: 'in_progress', color: 'bg-amber-100 text-amber-700',    dotColor: 'bg-amber-500' },
  awaiting_submission:    { label: 'Awaiting Submission',    tab: 'in_progress', color: 'bg-orange-100 text-orange-700',  dotColor: 'bg-orange-500' },
  lln_complete:           { label: 'LLN Complete',           tab: 'in_progress', color: 'bg-teal-100 text-teal-700',      dotColor: 'bg-teal-500' },
  digital_complete:       { label: 'Digital Complete',       tab: 'completed',   color: 'bg-teal-100 text-teal-700',      dotColor: 'bg-teal-500' },
  support_generated:      { label: 'Support Plan Ready',     tab: 'completed',   color: 'bg-emerald-100 text-emerald-700',dotColor: 'bg-emerald-500' },
  closed:                 { label: 'Closed',                 tab: 'completed',   color: 'bg-slate-100 text-slate-500',    dotColor: 'bg-slate-400' },
};

export const RECOMMENDATION_COLORS: Record<CourseRecommendation, string> = {
  suitable: 'bg-emerald-100 text-emerald-700',
  suitable_with_support: 'bg-amber-100 text-amber-700',
  not_yet_suitable: 'bg-rose-100 text-rose-700',
};

export const RECOMMENDATION_LABELS: Record<CourseRecommendation, string> = {
  suitable: 'Suitable',
  suitable_with_support: 'Suitable with Support',
  not_yet_suitable: 'Not Yet Suitable',
};

// ─── Mapping Evidence ───────────────────────────────────────────────────────

export type EvidenceStatus = 'draft' | 'active' | 'archived';
export type EvidenceOutcome = 'approved' | 'requires_changes' | 'archived';
export type EvidenceMethodology =
  | 'highest_across_mandatory_units'
  | 'highest_across_all_units'
  | 'professional_judgement'
  | 'manual_moderation'
  | 'industry_validation'
  | 'imported_mapping'
  | 'other';

export type EvidenceAttachmentType =
  | 'training_package_docs'
  | 'companion_volume'
  | 'unit_of_competency'
  | 'qualification_rules'
  | 'moderation_notes'
  | 'pdf'
  | 'docx'
  | 'spreadsheet'
  | 'external_url'
  | 'other';

export interface MappingEvidence {
  id: string;
  qualification_id: string;
  version_number: number;
  status: EvidenceStatus;
  methodology: EvidenceMethodology;
  methodology_notes: string | null;
  mapping_notes: string | null;
  acsf_learning: number | null;
  acsf_reading: number | null;
  acsf_writing: number | null;
  acsf_oral_comm: number | null;
  acsf_numeracy: number | null;
  review_interval_months: 12 | 24 | 36;
  last_reviewed_at: string | null;
  next_review_date: string | null;
  created_by_name: string | null;
  reviewed_by_name: string | null;
  approved_by_name: string | null;
  previous_version_id: string | null;
  change_reason: string | null;
  created_at: string;
  updated_at: string;
}

export interface MappingUnitEvidence {
  id: string;
  evidence_id: string;
  uoc_code: string;
  uoc_title: string;
  unit_type: 'core' | 'elective';
  learning_level: number | null;
  reading_level: number | null;
  writing_level: number | null;
  oral_comm_level: number | null;
  numeracy_level: number | null;
  evidence_notes: string | null;
  reasoning: string | null;
  created_at: string;
}

export interface MappingEvidenceAttachment {
  id: string;
  evidence_id: string;
  title: string;
  evidence_type: EvidenceAttachmentType;
  description: string | null;
  file_url: string | null;
  external_url: string | null;
  uploaded_by_name: string | null;
  uploaded_at: string;
}

export interface MappingEvidenceReview {
  id: string;
  evidence_id: string;
  review_date: string;
  reviewer_name: string;
  reason: string | null;
  summary: string | null;
  outcome: EvidenceOutcome;
  created_at: string;
}

export interface MappingEvidenceAudit {
  id: string;
  evidence_id: string | null;
  qualification_id: string | null;
  actor: string | null;
  action: string;
  previous_value: Record<string, any> | null;
  new_value: Record<string, any> | null;
  ip_address: string | null;
  created_at: string;
}

export const METHODOLOGY_LABELS: Record<EvidenceMethodology, string> = {
  highest_across_mandatory_units: 'Highest ACSF level across mandatory units',
  highest_across_all_units:       'Highest ACSF level across all selected units',
  professional_judgement:         'Professional judgement',
  manual_moderation:              'Manual moderation',
  industry_validation:            'Industry validation',
  imported_mapping:               'Imported mapping',
  other:                          'Other',
};

export const ATTACHMENT_TYPE_LABELS: Record<EvidenceAttachmentType, string> = {
  training_package_docs: 'Training Package Documentation',
  companion_volume:      'Companion Volume Implementation Guide',
  unit_of_competency:   'Unit of Competency',
  qualification_rules:  'Qualification Rules',
  moderation_notes:     'Internal Moderation Notes',
  pdf:                  'Uploaded PDF',
  docx:                 'Uploaded DOCX',
  spreadsheet:          'Uploaded Spreadsheet',
  external_url:         'External URL',
  other:                'Other',
};

export const EVIDENCE_STATUS_CONFIG: Record<EvidenceStatus, { label: string; color: string; dot: string }> = {
  draft:    { label: 'Draft',    color: 'bg-slate-100 text-slate-600',    dot: 'bg-slate-400' },
  active:   { label: 'Active',   color: 'bg-emerald-100 text-emerald-700', dot: 'bg-emerald-500' },
  archived: { label: 'Archived', color: 'bg-rose-100 text-rose-600',      dot: 'bg-rose-400' },
};

// ─── Billing ────────────────────────────────────────────────────────────────

export type SubscriptionStatus =
  | 'trialing' | 'active' | 'past_due' | 'paused' | 'cancelled' | 'incomplete';

export interface SubscriptionPlan {
  id: string;
  name: string;
  description: string | null;
  badge: string | null;
  platform_fee_cents: number;
  included_assessments: number;
  additional_assessment_cents: number;
  features: string[];
  active: boolean;
  sort_order: number;
  created_at: string;
}

export interface Subscription {
  id: string;
  plan_id: string | null;
  status: SubscriptionStatus;
  trial_ends_at: string | null;
  current_period_start: string | null;
  current_period_end: string | null;
  stripe_customer_id: string | null;
  stripe_subscription_id: string | null;
  stripe_payment_method_id: string | null;
  payment_method_last4: string | null;
  payment_method_brand: string | null;
  payment_method_exp_month: number | null;
  payment_method_exp_year: number | null;
  cancel_at_period_end: boolean;
  cancelled_at: string | null;
  paused_at: string | null;
  metadata: Record<string, unknown>;
  created_at: string;
  updated_at: string;
}

export interface BillingUsage {
  id: string;
  subscription_id: string;
  period_start: string;
  period_end: string;
  completed_learners: number;
  notified_75: boolean;
  notified_90: boolean;
  notified_100: boolean;
  last_notification_milestone: number;
  created_at: string;
  updated_at: string;
}

export interface BillableLearner {
  id: string;
  billing_period_id: string;
  invitation_id: string | null;
  learner_email: string;
  learner_name: string | null;
  completed_lln: boolean;
  completed_digital: boolean;
  first_completed_at: string;
  created_at: string;
}

export interface BillingEvent {
  id: string;
  stripe_event_id: string | null;
  event_type: string;
  amount_cents: number | null;
  currency: string;
  description: string | null;
  invoice_url: string | null;
  invoice_pdf: string | null;
  payload: Record<string, unknown> | null;
  processed: boolean;
  processed_at: string | null;
  error: string | null;
  created_at: string;
}
