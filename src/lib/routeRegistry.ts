// EWO-017R.7 — Canonical Route Registry
// Single source of truth for every routable destination in EIOS.
// All navigation must use buildRoute / parseRoute / navigate / resolve.

import { supabase } from './supabase';

// ─── Types ──────────────────────────────────────────────────────────────────────

export type Workspace = 'engineering' | 'assessment' | 'trainer' | 'platform' | 'public';

export interface RouteDefinition {
  route_key: string;
  workspace: Workspace;
  section: string;
  path_pattern: string;
  component_name: string;
  object_type?: string | null;
  requires_auth: boolean;
  requires_admin: boolean;
  requires_workspace?: string | null;
  description?: string | null;
  is_active: boolean;
}

export interface ResolvedRoute {
  route_key: string;
  workspace: Workspace;
  section: string;
  hash: string;
  object_ref: string | null;
  sub_path: string | null;
  component_name: string;
  params: Record<string, string>;
  valid: boolean;
  failure_reason?: string;
}

// ─── In-memory Registry (mirrors DB seed) ────────────────────────────────────────

const REGISTRY: RouteDefinition[] = [
  // Engineering
  { route_key: 'engineering.mission-control', workspace: 'engineering', section: 'mission-control', path_pattern: '#/engineering/mission-control', component_name: 'EngineeringControlCentrePage', object_type: null, requires_auth: true, requires_admin: true, requires_workspace: 'engineering', description: 'Engineering Mission Control', is_active: true },
  { route_key: 'engineering.work-orders', workspace: 'engineering', section: 'work-orders', path_pattern: '#/engineering/work-orders', component_name: 'ECCWorkOrdersPage', object_type: 'engineering_work_order', requires_auth: true, requires_admin: true, requires_workspace: 'engineering', description: 'Work Orders list', is_active: true },
  { route_key: 'engineering.work-order-detail', workspace: 'engineering', section: 'work-orders', path_pattern: '#/engineering/work-orders/:ref', component_name: 'ECCWorkOrdersPage', object_type: 'engineering_work_order', requires_auth: true, requires_admin: true, requires_workspace: 'engineering', description: 'Work Order Detail', is_active: true },
  { route_key: 'engineering.engineering-planning', workspace: 'engineering', section: 'engineering-planning', path_pattern: '#/engineering/engineering-planning', component_name: 'ECCEngineeringPlanningPage', object_type: 'engineering_plan', requires_auth: true, requires_admin: true, requires_workspace: 'engineering', description: 'Engineering Plans', is_active: true },
  { route_key: 'engineering.records-library', workspace: 'engineering', section: 'records-library', path_pattern: '#/engineering/records-library', component_name: 'ECCRecordsLibraryPage', object_type: 'engineering_record', requires_auth: true, requires_admin: true, requires_workspace: 'engineering', description: 'Engineering Records', is_active: true },
  { route_key: 'engineering.historical-bootstrap', workspace: 'engineering', section: 'historical-bootstrap', path_pattern: '#/engineering/historical-bootstrap', component_name: 'ECHistoricalBootstrapPage', object_type: null, requires_auth: true, requires_admin: true, requires_workspace: 'engineering', description: 'Historical Bootstrap', is_active: true },
  { route_key: 'engineering.atd-connect', workspace: 'engineering', section: 'atd-connect', path_pattern: '#/engineering/atd-connect', component_name: 'ECCATDConnectPage', object_type: null, requires_auth: true, requires_admin: true, requires_workspace: 'engineering', description: 'ATD Connect — Governed AI Integration Platform', is_active: true },
  { route_key: 'engineering.engineering-execution', workspace: 'engineering', section: 'engineering-execution', path_pattern: '#/engineering/engineering-execution', component_name: 'ECCExecutionWorkspacePage', object_type: null, requires_auth: true, requires_admin: true, requires_workspace: 'engineering', description: 'Engineering Executions', is_active: true },
  { route_key: 'engineering.execution-dashboard', workspace: 'engineering', section: 'execution-dashboard', path_pattern: '#/engineering/execution-dashboard', component_name: 'ECCExecutionDashboardPage', object_type: null, requires_auth: true, requires_admin: true, requires_workspace: 'engineering', description: 'Execution Dashboard', is_active: true },
  { route_key: 'engineering.execution-workspace', workspace: 'engineering', section: 'engineering-execution', path_pattern: '#/engineering/engineering-execution/:ref', component_name: 'ECCExecutionWorkspacePage', object_type: null, requires_auth: true, requires_admin: true, requires_workspace: 'engineering', description: 'Execution Workspace', is_active: true },
  { route_key: 'engineering.engineering-standards', workspace: 'engineering', section: 'engineering-standards', path_pattern: '#/engineering/engineering-standards', component_name: 'ECCStandardsPage', object_type: 'engineering_standard', requires_auth: true, requires_admin: true, requires_workspace: 'engineering', description: 'Engineering Standards', is_active: true },
  { route_key: 'engineering.timeline', workspace: 'engineering', section: 'timeline', path_pattern: '#/engineering/timeline', component_name: 'ECCTimelinePage', object_type: null, requires_auth: true, requires_admin: true, requires_workspace: 'engineering', description: 'Engineering Timeline', is_active: true },
  { route_key: 'engineering.engineering-ideas', workspace: 'engineering', section: 'engineering-ideas', path_pattern: '#/engineering/engineering-ideas', component_name: 'ECCIdeaWorkspacePage', object_type: 'engineering_idea', requires_auth: true, requires_admin: true, requires_workspace: 'engineering', description: 'Engineering Ideas', is_active: true },
  { route_key: 'engineering.engineering-reviews', workspace: 'engineering', section: 'engineering-reviews', path_pattern: '#/engineering/engineering-reviews', component_name: 'ECCEngineeringReviewsPage', object_type: null, requires_auth: true, requires_admin: true, requires_workspace: 'engineering', description: 'Engineering Reviews', is_active: true },
  { route_key: 'engineering.recovery-dashboard', workspace: 'engineering', section: 'recovery-dashboard', path_pattern: '#/engineering/recovery-dashboard', component_name: 'ECCRecoveryDashboardPage', object_type: null, requires_auth: true, requires_admin: true, requires_workspace: 'engineering', description: 'Recovery Dashboard', is_active: true },
  { route_key: 'engineering.recovery-workspace', workspace: 'engineering', section: 'recovery-workspace', path_pattern: '#/engineering/recovery-workspace', component_name: 'ECCRecoveryWorkspacePage', object_type: null, requires_auth: true, requires_admin: true, requires_workspace: 'engineering', description: 'Recovery Workspace', is_active: true },
  { route_key: 'engineering.constitution', workspace: 'engineering', section: 'constitution', path_pattern: '#/engineering/constitution', component_name: 'ECCConstitutionPage', object_type: 'constitutional_amendment', requires_auth: true, requires_admin: true, requires_workspace: 'engineering', description: 'Constitution', is_active: true },
  { route_key: 'engineering.roadmap', workspace: 'engineering', section: 'roadmap', path_pattern: '#/engineering/roadmap', component_name: 'ECCRoadmapPage', object_type: null, requires_auth: true, requires_admin: true, requires_workspace: 'engineering', description: 'Roadmap', is_active: true },
  { route_key: 'engineering.dashboard', workspace: 'engineering', section: 'dashboard', path_pattern: '#/engineering/dashboard', component_name: 'ECCDashboard', object_type: null, requires_auth: true, requires_admin: true, requires_workspace: 'engineering', description: 'Engineering Dashboard', is_active: true },
  { route_key: 'engineering.phases', workspace: 'engineering', section: 'phases', path_pattern: '#/engineering/phases', component_name: 'ECCPhasesPage', object_type: null, requires_auth: true, requires_admin: true, requires_workspace: 'engineering', description: 'Engineering Phases', is_active: true },
  { route_key: 'engineering.milestones', workspace: 'engineering', section: 'milestones', path_pattern: '#/engineering/milestones', component_name: 'ECCMilestonesPage', object_type: null, requires_auth: true, requires_admin: true, requires_workspace: 'engineering', description: 'Engineering Milestones', is_active: true },
  { route_key: 'engineering.release-centre', workspace: 'engineering', section: 'release-centre', path_pattern: '#/engineering/release-centre', component_name: 'ECCReleaseCentrePage', object_type: null, requires_auth: true, requires_admin: true, requires_workspace: 'engineering', description: 'Release Centre', is_active: true },
  { route_key: 'engineering.platform-admin', workspace: 'engineering', section: 'platform-admin', path_pattern: '#/engineering/platform-admin', component_name: 'ECCPlatformAdminPage', object_type: null, requires_auth: true, requires_admin: true, requires_workspace: 'engineering', description: 'Platform Administration', is_active: true },
  { route_key: 'engineering.projects', workspace: 'engineering', section: 'projects', path_pattern: '#/engineering/projects', component_name: 'ECCProjectCompassPage', object_type: null, requires_auth: true, requires_admin: true, requires_workspace: 'engineering', description: 'Projects', is_active: true },
  { route_key: 'engineering.settings', workspace: 'engineering', section: 'settings', path_pattern: '#/engineering/settings', component_name: 'SettingsPage', object_type: null, requires_auth: true, requires_admin: true, requires_workspace: 'engineering', description: 'Settings', is_active: true },
  // Governance
  { route_key: 'governance.constitution', workspace: 'engineering', section: 'constitution', path_pattern: '#/engineering/constitution', component_name: 'ECCConstitutionPage', object_type: 'constitutional_amendment', requires_auth: true, requires_admin: true, requires_workspace: 'engineering', description: 'Constitution', is_active: true },
  { route_key: 'governance.engineering-standards', workspace: 'engineering', section: 'engineering-standards', path_pattern: '#/engineering/engineering-standards', component_name: 'ECCStandardsPage', object_type: 'engineering_standard', requires_auth: true, requires_admin: true, requires_workspace: 'engineering', description: 'Engineering Standards', is_active: true },
  // Platform
  { route_key: 'platform.dashboard', workspace: 'platform', section: 'dashboard', path_pattern: '#/platform/dashboard', component_name: 'PlatformDashboardPage', object_type: null, requires_auth: true, requires_admin: false, requires_workspace: 'platform_admin', description: 'Platform Dashboard', is_active: true },
  { route_key: 'platform.settings', workspace: 'platform', section: 'settings', path_pattern: '#/platform/settings', component_name: 'SettingsPage', object_type: null, requires_auth: true, requires_admin: false, requires_workspace: 'platform_admin', description: 'Platform Settings', is_active: true },
  { route_key: 'platform.users', workspace: 'platform', section: 'users', path_pattern: '#/platform/users', component_name: 'SettingsPage', object_type: null, requires_auth: true, requires_admin: false, requires_workspace: 'platform_admin', description: 'Platform Users', is_active: true },
  { route_key: 'platform.billing', workspace: 'platform', section: 'billing', path_pattern: '#/platform/billing', component_name: 'BillingPage', object_type: null, requires_auth: true, requires_admin: false, requires_workspace: 'platform_admin', description: 'Platform Billing', is_active: true },
  { route_key: 'platform.axcelerate-inbound', workspace: 'platform', section: 'axcelerate-inbound', path_pattern: '#/platform/axcelerate-inbound', component_name: 'AxcelerateInboundPage', object_type: null, requires_auth: true, requires_admin: false, requires_workspace: 'platform_admin', description: 'Axcelerate Inbound', is_active: true },
  { route_key: 'platform.axcelerate-log', workspace: 'platform', section: 'axcelerate-log', path_pattern: '#/platform/axcelerate-log', component_name: 'AxcelerateLogPage', object_type: null, requires_auth: true, requires_admin: false, requires_workspace: 'platform_admin', description: 'Axcelerate Log', is_active: true },
  { route_key: 'platform.email-activity', workspace: 'platform', section: 'email-activity', path_pattern: '#/platform/email-activity', component_name: 'EmailActivityPage', object_type: null, requires_auth: true, requires_admin: false, requires_workspace: 'platform_admin', description: 'Email Activity', is_active: true },
  { route_key: 'platform.validation', workspace: 'platform', section: 'validation', path_pattern: '#/platform/validation', component_name: 'ValidationPage', object_type: null, requires_auth: true, requires_admin: false, requires_workspace: 'platform_admin', description: 'Validation', is_active: true },
  { route_key: 'platform.ai-providers', workspace: 'platform', section: 'ai-providers', path_pattern: '#/platform/ai-providers', component_name: 'SettingsPage', object_type: null, requires_auth: true, requires_admin: false, requires_workspace: 'platform_admin', description: 'AI Providers', is_active: true },
  { route_key: 'platform.feature-flags', workspace: 'platform', section: 'feature-flags', path_pattern: '#/platform/feature-flags', component_name: 'SettingsPage', object_type: null, requires_auth: true, requires_admin: false, requires_workspace: 'platform_admin', description: 'Feature Flags', is_active: true },
  { route_key: 'platform.system-health', workspace: 'platform', section: 'system-health', path_pattern: '#/platform/system-health', component_name: 'PlatformDashboardPage', object_type: null, requires_auth: true, requires_admin: false, requires_workspace: 'platform_admin', description: 'System Health', is_active: true },
  // Assessment
  { route_key: 'assessment.dashboard', workspace: 'assessment', section: 'dashboard', path_pattern: '#/assessment/dashboard', component_name: 'DashboardPage', object_type: null, requires_auth: true, requires_admin: false, requires_workspace: 'assessment', description: 'Assessment Dashboard', is_active: true },
  { route_key: 'assessment.assessments', workspace: 'assessment', section: 'assessments', path_pattern: '#/assessment/assessments', component_name: 'AssessmentsPage', object_type: null, requires_auth: true, requires_admin: false, requires_workspace: 'assessment', description: 'Assessments', is_active: true },
  { route_key: 'assessment.qualifications', workspace: 'assessment', section: 'qualifications', path_pattern: '#/assessment/qualifications', component_name: 'QualificationsPage', object_type: null, requires_auth: true, requires_admin: false, requires_workspace: 'assessment', description: 'Qualifications', is_active: true },
  { route_key: 'assessment.candidates', workspace: 'assessment', section: 'candidates', path_pattern: '#/assessment/candidates', component_name: 'CandidatesPage', object_type: null, requires_auth: true, requires_admin: false, requires_workspace: 'assessment', description: 'Candidates', is_active: true },
  { route_key: 'assessment.results', workspace: 'assessment', section: 'results', path_pattern: '#/assessment/results', component_name: 'ResultsPage', object_type: null, requires_auth: true, requires_admin: false, requires_workspace: 'assessment', description: 'Results', is_active: true },
  { route_key: 'assessment.support-plans', workspace: 'assessment', section: 'support-plans', path_pattern: '#/assessment/support-plans', component_name: 'SupportPlansPage', object_type: null, requires_auth: true, requires_admin: false, requires_workspace: 'assessment', description: 'Support Plans', is_active: true },
  { route_key: 'assessment.interventions', workspace: 'assessment', section: 'interventions', path_pattern: '#/assessment/interventions', component_name: 'InterventionsPage', object_type: null, requires_auth: true, requires_admin: false, requires_workspace: 'assessment', description: 'Interventions', is_active: true },
  { route_key: 'assessment.compliance', workspace: 'assessment', section: 'compliance', path_pattern: '#/assessment/compliance', component_name: 'CompliancePage', object_type: null, requires_auth: true, requires_admin: false, requires_workspace: 'assessment', description: 'Compliance', is_active: true },
  { route_key: 'assessment.acsf-evidence', workspace: 'assessment', section: 'acsf-evidence', path_pattern: '#/assessment/acsf-evidence', component_name: 'ACSFEvidencePage', object_type: null, requires_auth: true, requires_admin: false, requires_workspace: 'assessment', description: 'ACSF Evidence', is_active: true },
  { route_key: 'assessment.audit-log', workspace: 'assessment', section: 'audit-log', path_pattern: '#/assessment/audit-log', component_name: 'AuditLogPage', object_type: null, requires_auth: true, requires_admin: false, requires_workspace: 'assessment', description: 'Audit Log', is_active: true },
  { route_key: 'assessment.email-activity', workspace: 'assessment', section: 'email-activity', path_pattern: '#/assessment/email-activity', component_name: 'EmailActivityPage', object_type: null, requires_auth: true, requires_admin: false, requires_workspace: 'assessment', description: 'Email Activity', is_active: true },
  { route_key: 'assessment.axcelerate-log', workspace: 'assessment', section: 'axcelerate-log', path_pattern: '#/assessment/axcelerate-log', component_name: 'AxcelerateLogPage', object_type: null, requires_auth: true, requires_admin: false, requires_workspace: 'assessment', description: 'Axcelerate Log', is_active: true },
  { route_key: 'assessment.axcelerate-inbound', workspace: 'assessment', section: 'axcelerate-inbound', path_pattern: '#/assessment/axcelerate-inbound', component_name: 'AxcelerateInboundPage', object_type: null, requires_auth: true, requires_admin: false, requires_workspace: 'assessment', description: 'Axcelerate Inbound', is_active: true },
  { route_key: 'assessment.validation', workspace: 'assessment', section: 'validation', path_pattern: '#/assessment/validation', component_name: 'ValidationPage', object_type: null, requires_auth: true, requires_admin: false, requires_workspace: 'assessment', description: 'Validation', is_active: true },
  { route_key: 'assessment.billing', workspace: 'assessment', section: 'billing', path_pattern: '#/assessment/billing', component_name: 'PlanStatusPage', object_type: null, requires_auth: true, requires_admin: false, requires_workspace: 'assessment', description: 'Plan & usage', is_active: true },
  { route_key: 'assessment.settings', workspace: 'assessment', section: 'settings', path_pattern: '#/assessment/settings', component_name: 'SettingsPage', object_type: null, requires_auth: true, requires_admin: false, requires_workspace: 'assessment', description: 'Settings', is_active: true },
  // Trainer
  { route_key: 'trainer.dashboard', workspace: 'trainer', section: 'dashboard', path_pattern: '#/trainer/dashboard', component_name: 'TrainerDashboardPage', object_type: null, requires_auth: true, requires_admin: false, requires_workspace: 'trainer', description: 'Trainer Dashboard', is_active: true },
  { route_key: 'trainer.students', workspace: 'trainer', section: 'students', path_pattern: '#/trainer/students', component_name: 'TrainerDashboardPage', object_type: null, requires_auth: true, requires_admin: false, requires_workspace: 'trainer', description: 'Students', is_active: true },
  { route_key: 'trainer.awaiting-review', workspace: 'trainer', section: 'awaiting-review', path_pattern: '#/trainer/awaiting-review', component_name: 'TrainerDashboardPage', object_type: null, requires_auth: true, requires_admin: false, requires_workspace: 'trainer', description: 'Awaiting Review', is_active: true },
  { route_key: 'trainer.support-plans', workspace: 'trainer', section: 'support-plans', path_pattern: '#/trainer/support-plans', component_name: 'SupportPlansPage', object_type: null, requires_auth: true, requires_admin: false, requires_workspace: 'trainer', description: 'Support Plans', is_active: true },
  { route_key: 'trainer.interventions', workspace: 'trainer', section: 'interventions', path_pattern: '#/trainer/interventions', component_name: 'InterventionsPage', object_type: null, requires_auth: true, requires_admin: false, requires_workspace: 'trainer', description: 'Interventions', is_active: true },
  { route_key: 'trainer.results', workspace: 'trainer', section: 'results', path_pattern: '#/trainer/results', component_name: 'ResultsPage', object_type: null, requires_auth: true, requires_admin: false, requires_workspace: 'trainer', description: 'Results', is_active: true },
  { route_key: 'trainer.evidence', workspace: 'trainer', section: 'evidence', path_pattern: '#/trainer/evidence', component_name: 'ResultsPage', object_type: null, requires_auth: true, requires_admin: false, requires_workspace: 'trainer', description: 'Evidence', is_active: true },
  // Marketing + Public
  { route_key: 'marketing.home', workspace: 'public', section: 'home', path_pattern: '#/home', component_name: 'HomePage', object_type: null, requires_auth: false, requires_admin: false, requires_workspace: null, description: 'Home', is_active: true },
  { route_key: 'marketing.about', workspace: 'public', section: 'about', path_pattern: '#/about', component_name: 'AboutPage', object_type: null, requires_auth: false, requires_admin: false, requires_workspace: null, description: 'About', is_active: true },
  { route_key: 'marketing.features', workspace: 'public', section: 'features', path_pattern: '#/features', component_name: 'FeaturesPage', object_type: null, requires_auth: false, requires_admin: false, requires_workspace: null, description: 'Features', is_active: true },
  { route_key: 'marketing.how-it-works', workspace: 'public', section: 'how-it-works', path_pattern: '#/how-it-works', component_name: 'HowItWorksPage', object_type: null, requires_auth: false, requires_admin: false, requires_workspace: null, description: 'How It Works', is_active: true },
  { route_key: 'marketing.resources', workspace: 'public', section: 'resources', path_pattern: '#/resources', component_name: 'ResourcesPage', object_type: null, requires_auth: false, requires_admin: false, requires_workspace: null, description: 'Resources', is_active: true },
  { route_key: 'marketing.contact', workspace: 'public', section: 'contact', path_pattern: '#/contact', component_name: 'ContactPage', object_type: null, requires_auth: false, requires_admin: false, requires_workspace: null, description: 'Contact', is_active: true },
  { route_key: 'marketing.pricing', workspace: 'public', section: 'pricing', path_pattern: '#/pricing', component_name: 'PricingPage', object_type: null, requires_auth: false, requires_admin: false, requires_workspace: null, description: 'Pricing', is_active: true },
  { route_key: 'public.login', workspace: 'public', section: 'login', path_pattern: '#/login', component_name: 'LoginPage', object_type: null, requires_auth: false, requires_admin: false, requires_workspace: null, description: 'Login', is_active: true },
  { route_key: 'public.signup', workspace: 'public', section: 'signup', path_pattern: '#/signup', component_name: 'SignUpPage', object_type: null, requires_auth: false, requires_admin: false, requires_workspace: null, description: 'Sign Up', is_active: true },
  { route_key: 'public.forgot-password', workspace: 'public', section: 'forgot-password', path_pattern: '#/forgot-password', component_name: 'LoginPage', object_type: null, requires_auth: false, requires_admin: false, requires_workspace: null, description: 'Forgot Password', is_active: true },
  // Public token routes
  { route_key: 'public.lln', workspace: 'public', section: 'lln', path_pattern: '#/lln/:token', component_name: 'LLNAssessmentPage', object_type: null, requires_auth: false, requires_admin: false, requires_workspace: null, description: 'LLN Assessment', is_active: true },
  { route_key: 'public.digital', workspace: 'public', section: 'digital', path_pattern: '#/digital/:token', component_name: 'DigitalAssessmentPage', object_type: null, requires_auth: false, requires_admin: false, requires_workspace: null, description: 'Digital Assessment', is_active: true },
  { route_key: 'public.quiz', workspace: 'public', section: 'quiz', path_pattern: '#/quiz/:token', component_name: 'QuizPage', object_type: null, requires_auth: false, requires_admin: false, requires_workspace: null, description: 'Quiz', is_active: true },
  { route_key: 'public.student', workspace: 'public', section: 'student', path_pattern: '#/student/:token', component_name: 'StudentLandingPage', object_type: null, requires_auth: false, requires_admin: false, requires_workspace: null, description: 'Student Landing', is_active: true },
];

// ─── Registry Access ────────────────────────────────────────────────────────────

export function getRegistry(): RouteDefinition[] {
  return [...REGISTRY];
}

export function getRouteByKey(routeKey: string): RouteDefinition | null {
  return REGISTRY.find(r => r.route_key === routeKey) ?? null;
}

export function getRoutesByWorkspace(workspace: Workspace): RouteDefinition[] {
  return REGISTRY.filter(r => r.workspace === workspace && r.is_active);
}

export function isRouteRegistered(routeKey: string): boolean {
  return REGISTRY.some(r => r.route_key === routeKey && r.is_active);
}

// ─── buildRoute: construct canonical URL from route key + params ──────────────────

export function buildRoute(routeKey: string, params?: Record<string, string>): string {
  const def = getRouteByKey(routeKey);
  if (!def) return '#/login'; // EIOS default
  let hash = def.path_pattern;
  if (params) {
    for (const [key, value] of Object.entries(params)) {
      hash = hash.replace(`:${key}`, encodeURIComponent(value));
    }
  }
  return hash;
}

// ─── parseRoute: parse a hash into a resolved route ──────────────────────────────

export function parseRoute(hash: string): ResolvedRoute {
  const h = hash.replace(/^#\/?/, '').split('?')[0];
  if (!h) return resolveRoot();

  const parts = h.split('/');
  const workspace = parts[0] as Workspace;

  // Match against registry patterns
  for (const def of REGISTRY) {
    if (!def.is_active) continue;
    const pattern = def.path_pattern.replace(/^#\/?/, '');
    const patternParts = pattern.split('/');

    if (patternParts.length !== parts.length) continue;
    if (patternParts[0] !== parts[0]) continue;

    let matched = true;
    const params: Record<string, string> = {};
    for (let i = 0; i < patternParts.length; i++) {
      const pp = patternParts[i];
      const ap = parts[i];
      if (pp.startsWith(':')) {
        params[pp.slice(1)] = decodeURIComponent(ap);
      } else if (pp !== ap) {
        matched = false;
        break;
      }
    }
    if (matched) {
      const objectRef = params.ref ?? params.token ?? null;
      return {
        route_key: def.route_key,
        workspace: def.workspace,
        section: def.section,
        hash,
        object_ref: objectRef,
        sub_path: null,
        component_name: def.component_name,
        params,
        valid: true,
      };
    }
  }

  // Engineering routes with sub-paths (e.g. #/engineering/work-orders/EWO-001/section)
  if (workspace === 'engineering' && parts.length >= 2) {
    const section = parts[1];
    const objectRef = parts[2] ?? null;
    const subPath = parts.slice(3).join('/') || null;
    const routeKey = objectRef
      ? `engineering.${section.replace(/-/g, '_')}-detail`
      : `engineering.${section.replace(/-/g, '_')}`;
    const def = REGISTRY.find(r => r.section === section && r.workspace === 'engineering');
    if (def) {
      return {
        route_key: def.route_key,
        workspace: 'engineering',
        section,
        hash,
        object_ref: objectRef,
        sub_path: subPath,
        component_name: def.component_name,
        params: objectRef ? { ref: objectRef } : {},
        valid: true,
      };
    }
  }

  // Unmatched — return invalid resolved route (never null)
  return {
    route_key: 'unknown',
    workspace,
    section: parts[1] ?? '',
    hash,
    object_ref: null,
    sub_path: null,
    component_name: 'Unknown',
    params: {},
    valid: false,
    failure_reason: `No registered route matches hash: ${hash}`,
  };
}

function resolveRoot(): ResolvedRoute {
  return {
    route_key: 'public.root',
    workspace: 'public',
    section: '',
    hash: '',
    object_ref: null,
    sub_path: null,
    component_name: 'Root',
    params: {},
    valid: true,
  };
}

// ─── navigate: programmatic navigation ───────────────────────────────────────────

export function navigate(routeKey: string, params?: Record<string, string>): boolean {
  const hash = buildRoute(routeKey, params);
  if (!hash) return false;
  if (window.location.hash !== hash) {
    window.location.hash = hash;
  }
  return true;
}

// ─── resolve: governed route resolution engine ───────────────────────────────────

export interface RouteResolutionResult {
  resolved: ResolvedRoute;
  valid: boolean;
  failure_reason?: string;
}

export async function resolve(
  hash: string,
  options?: { validateObject?: boolean; userId?: string },
): Promise<RouteResolutionResult> {
  const resolved = parseRoute(hash);
  if (!resolved.valid) {
    return {
      resolved,
      valid: false,
      failure_reason: resolved.failure_reason ?? 'Route not registered',
    };
  }

  // Validate permissions
  const def = getRouteByKey(resolved.route_key);
  if (def?.requires_auth && !options?.userId) {
    return {
      resolved,
      valid: false,
      failure_reason: 'Authentication required',
    };
  }

  // Validate object existence (if requested and route has object_ref)
  if (options?.validateObject && resolved.object_ref && def?.object_type) {
    const { data, error } = await supabase
      .from('engineering_object_registry')
      .select('id')
      .eq('object_ref', resolved.object_ref)
      .maybeSingle();
    if (error || !data) {
      return {
        resolved,
        valid: false,
        failure_reason: `Object not found: ${resolved.object_ref}`,
      };
    }
  }

  return { resolved, valid: true };
}

// ─── Deep Link Validation ────────────────────────────────────────────────────────

export function supportsDeepLink(routeKey: string): boolean {
  const def = getRouteByKey(routeKey);
  return def?.is_active ?? false;
}

export function supportsRefresh(routeKey: string): boolean {
  const def = getRouteByKey(routeKey);
  return def?.is_active ?? false;
}

// ─── DB Sync ─────────────────────────────────────────────────────────────────────

export async function syncRegistryToDB(): Promise<void> {
  const rows = REGISTRY.map(r => ({
    route_key: r.route_key,
    workspace: r.workspace,
    section: r.section,
    path_pattern: r.path_pattern,
    component_name: r.component_name,
    object_type: r.object_type,
    requires_auth: r.requires_auth,
    requires_admin: r.requires_admin,
    requires_workspace: r.requires_workspace,
    description: r.description,
    is_active: r.is_active,
  }));
  await supabase.from('eios_route_registry').upsert(rows, { onConflict: 'route_key' });
}

export async function loadRegistryFromDB(): Promise<RouteDefinition[]> {
  const { data, error } = await supabase
    .from('eios_route_registry')
    .select('*')
    .eq('is_active', true)
    .order('route_key');
  if (error || !data) return REGISTRY;
  return data as RouteDefinition[];
}
