import { beforeEach, describe, expect, it, vi } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import * as React from 'react';
import * as fs from 'fs';
import * as path from 'path';

const rpc = vi.fn();
vi.mock('../lib/supabase', () => ({ supabase: { rpc: (...a: unknown[]) => rpc(...a) }, createQuizClient: vi.fn() }));

import {
  deleteAssessmentAssignment, fetchPlanUsage, formatResetDate, isInvitationAllowanceReached, isInvitationPlanUnconfirmed,
  looksLikeReservedTestName, parsePlanUsage, usageLevel, type PlanUsageState,
} from '../lib/planUsage';
import { fetchRtoUsage, mapUsageRow, monthParam, restoreAssessment } from '../lib/platformUsage';
import { PlanUsageView } from '../pages/PlanStatusPage';
import { UsageAllowanceNoticeView } from '../components/UsageAllowanceNotice';
import { DeleteAssessmentDialog, DELETE_CONFIRMATION_WORD } from '../components/DeleteAssessmentDialog';
import { FREE_TIER_RULES, PLANS } from '../lib/brand';

const ROOT = path.resolve(__dirname, '..', '..');
const read = (rel: string) => fs.readFileSync(path.join(ROOT, rel), 'utf8');
const MIGRATION = 'supabase/migrations/20261110090000_llnd_mate_free_tier_invitations.sql';
const sql = read(MIGRATION);
const sqlCode = sql.replace(/--.*$/gm, '');
const html = (el: React.ReactElement) => renderToStaticMarkup(el).replace(/<svg[\s\S]*?<\/svg>/g, '').replace(/&#x27;|&#39;/g, "'").replace(/&amp;/g, '&');

function server(used: number, extra: { returned?: number; tests?: number; consistent?: boolean } = {}) {
  const returned = extra.returned ?? 0;
  return {
    state: 'ok', consistent: extra.consistent ?? true,
    plan: { code: 'llnd_mate_free', name: 'LLND Mate', tier: 'Free', status: 'active', monthly_allowance: 10, unit: 'invitations' },
    period: { month: '2026-11-01', reset_date: '2026-12-01' },
    usage: { used, allowance: 10, remaining: Math.max(10 - used, 0), sent_this_month: used + returned, returned_by_deletion: returned,
             test_invitations: extra.tests ?? 0, new_invitations_available: used < 10 },
  };
}

describe('Plan & usage (invitations): parsing the server response', () => {
  it('maps a valid response; 8 of 10 is "nearly used"', () => {
    expect(parsePlanUsage(server(6, { returned: 2, tests: 3 }))).toMatchObject({
      kind: 'ok', used: 6, allowance: 10, remaining: 4, sentThisMonth: 8, returnedByDeletion: 2, testInvitations: 3, level: 'normal', resetDate: '2026-12-01',
    });
    expect([0, 1, 7, 8, 9, 10].map((n) => usageLevel(n, 10))).toEqual(['empty', 'normal', 'normal', 'near', 'near', 'exhausted']);
  });

  it('never defaults: missing entitlement and malformed or inconsistent data are not shown as a Free plan', () => {
    expect(parsePlanUsage({ state: 'no_entitlement' })).toEqual({ kind: 'no_entitlement' });
    const ok = server(3, { returned: 1 });
    const bad: unknown[] = [
      null, {}, { state: 'x' },
      server(3, { consistent: false }),
      { ...ok, plan: { ...ok.plan, unit: 'completions' } },
      { ...ok, plan: { ...ok.plan, code: 'llnd_mate_plus' } },
      { ...ok, usage: { ...ok.usage, remaining: 9 } },
      { ...ok, usage: { ...ok.usage, sent_this_month: 7 } },
      { ...ok, usage: { ...ok.usage, test_invitations: -1 } },
      { ...ok, usage: { ...ok.usage, new_invitations_available: false } },
      { ...ok, period: { reset_date: '2026-12-15' } },
    ];
    for (const b of bad) expect(parsePlanUsage(b).kind).toBe('inconsistent');
  });

  it('maps RPC failures and never sends an organisation id', async () => {
    rpc.mockResolvedValueOnce({ data: null, error: { code: '42501', message: 'not_authorised' } });
    expect(await fetchPlanUsage()).toEqual({ kind: 'unauthorised' });
    rpc.mockResolvedValueOnce({ data: null, error: { code: '08006', message: 'down' } });
    expect(await fetchPlanUsage()).toEqual({ kind: 'error' });
    rpc.mockRejectedValueOnce(new Error('offline'));
    expect(await fetchPlanUsage()).toEqual({ kind: 'error' });
    for (const call of rpc.mock.calls) expect(call).toEqual(['get_my_plan_usage']);
  });

  it('recognises server refusals and the reserved test name exactly like the database', () => {
    expect(isInvitationAllowanceReached({ message: 'invitation_allowance_reached' })).toBe(true);
    expect(isInvitationPlanUnconfirmed({ message: 'invitation_plan_unconfirmed' })).toBe(true);
    expect(isInvitationAllowanceReached({ message: 'duplicate key' })).toBe(false);
    for (const yes of ['Test Test', 'test test', '  TEST   test ', 'Test Test', 'Test​ Test', 'Ｔest Ｔest']) expect(looksLikeReservedTestName(yes), yes).toBe(true);
    for (const no of ['Test Testerson', 'Testa Test', 'Test Test Smith', 'TestTest', 'Test-Test', 'Test', '']) expect(looksLikeReservedTestName(no), no).toBe(false);
    expect(formatResetDate('2026-12-01')).toBe('1 December 2026');
  });
});

describe('Plan & usage page (invitations)', () => {
  beforeEach(() => rpc.mockReset());
  const ok = (n: number, returned = 0, tests = 0) => parsePlanUsage(server(n, { returned, tests })) as PlanUsageState;

  it('shows LLND Mate Free, 10 invitations per month, used, remaining, reset, tests excluded, deletion returns', () => {
    const out = html(<PlanUsageView state={ok(6, 1, 3)} />);
    for (const t of ['LLND Mate', 'Free', 'Active', '10 invitations per month', '6 of 10 invitations used', '4 invitations remaining',
      'Resets 1 December 2026', 'Invitations to “Test Test” are free and don’t count.', 'Deleting an assessment sent this month returns its invitation.',
      'Need more assessments? LLND Mate Plus is coming soon.']) expect(out).toContain(t);
  });

  it('near limit and exhausted messages; invited learners can still finish', () => {
    expect(html(<PlanUsageView state={ok(8)} />)).toContain('Your free allowance is nearly used.');
    const full = html(<PlanUsageView state={ok(10)} />);
    expect(full).toContain('You’ve used all 10 free invitations for this month.');
    expect(full).toContain('New invitations can’t be sent until 1 December 2026. Learners you have already invited can still start and finish their assessments.');
  });

  it('error states show no figures and no Active badge', () => {
    for (const state of [{ kind: 'loading' }, { kind: 'error' }, { kind: 'unauthorised' }, { kind: 'no_entitlement' }, { kind: 'inconsistent' }] as PlanUsageState[]) {
      expect(html(<PlanUsageView state={state} />)).not.toMatch(/ of \d+ invitations used|invitations remaining|Active</);
    }
  });

  it('no purchase or upgrade action', () => {
    expect(html(<PlanUsageView state={ok(10)} />)).not.toMatch(/<button[^>]*>[^<]*(Upgrade|Buy|Purchase|Subscribe)/i);
  });

  it('staff notice reflects invitation-based enforcement', () => {
    expect(html(<UsageAllowanceNoticeView state={ok(3)} />)).toBe('');
    expect(html(<UsageAllowanceNoticeView state={ok(8)} />)).toContain('resending doesn’t');
    expect(html(<UsageAllowanceNoticeView state={ok(10)} />)).toContain('New invitations can’t be sent until 1 December 2026. Learners already invited can still start and finish.');
  });

  it('public plan wording counts invitations for LLND Mate and completions for paid tiers', () => {
    expect(PLANS[0].included).toBe('10 assessment invitations a month');
    expect(PLANS[1].included).toBe('20 completed assessment assignments a month');
    expect(FREE_TIER_RULES.join(' ')).not.toMatch(/start(s)? (is|are) restricted|completed assessment/i);
  });
});

describe('Delete dialog', () => {
  it('uses the approved wording and starts with Delete disabled', () => {
    const out = html(<DeleteAssessmentDialog target={{ id: 'x', learnerName: 'Jordan' }} onCancel={() => undefined} onConfirm={async () => null} />);
    for (const t of ['Delete assessment?',
      'This assessment will disappear from your dashboard. Its results and progress will no longer be accessible to your organisation.',
      'If you need this assessment restored later, a restoration fee will apply.', 'To confirm deletion, type YES below.', 'Cancel']) expect(out).toContain(t);
    expect(out).toMatch(/<button type="submit" disabled=""/);
    expect(DELETE_CONFIRMATION_WORD).toBe('YES');
    expect(html(<DeleteAssessmentDialog target={null} onCancel={() => undefined} onConfirm={async () => null} />)).toBe('');
  });

  it('client sends the typed confirmation to the server, which checks it again', async () => {
    rpc.mockResolvedValueOnce({ data: { status: 'deleted', allowance_refunded: true }, error: null });
    expect(await deleteAssessmentAssignment('inv', 'YES')).toEqual({ ok: true, refunded: true, alreadyDeleted: false });
    expect(rpc).toHaveBeenLastCalledWith('delete_assessment_assignment', { p_invitation_id: 'inv', p_confirmation: 'YES' });
    rpc.mockResolvedValueOnce({ data: null, error: { code: '22023', message: 'confirmation_required' } });
    expect(await deleteAssessmentAssignment('inv', 'yes')).toEqual({ ok: false, message: 'Type YES to confirm deletion.' });
    rpc.mockResolvedValueOnce({ data: { status: 'already_deleted', allowance_refunded: false }, error: null });
    expect(await deleteAssessmentAssignment('inv', 'YES')).toEqual({ ok: true, refunded: false, alreadyDeleted: true });
  });

  it('Candidates uses the dialog and the server RPC; hard delete is gone', () => {
    const c = read('src/pages/CandidatesPage.tsx');
    expect(c).toContain('<DeleteAssessmentDialog');
    expect(c).toContain('deleteAssessmentAssignment(invitationId, confirmation)');
    expect(c).not.toMatch(/from\('assessment_invitations'\)\.delete\(\)/);
    expect(c).not.toContain('This action cannot be undone');
    expect(c).toContain('<TestBadge />');
    expect(c).toContain("disabled={submitting || !!editingInvitation?.is_test}");
  });
});

describe('Platform operator client', () => {
  beforeEach(() => rpc.mockReset());
  it('maps rows and handles refusal', async () => {
    const row = mapUsageRow({ organisation_id: 'o', organisation_name: 'RTO', plan_code: 'llnd_mate_free', monthly_allowance: 10, total_invitations_sent: 15,
      month_invitations_sent: 15, month_net_usage: 10, month_remaining: 0, month_test_invitations: 3, total_test_invitations: 3, deleted_invitations: 5,
      completed_assessments: 2, restored_assessments: 1, counter_consistent: true });
    expect(row).toMatchObject({ monthInvitationsSent: 15, monthNetUsage: 10, monthRemaining: 0, deletedInvitations: 5 });
    rpc.mockResolvedValueOnce({ data: null, error: { code: '42501', message: 'not_authorised' } });
    expect(await fetchRtoUsage('2026-11-01', '')).toEqual({ kind: 'unauthorised' });
    rpc.mockResolvedValueOnce({ data: null, error: { code: '42501', message: 'not_authorised' } });
    expect(await restoreAssessment('x', '')).toMatchObject({ ok: false });
    expect(monthParam('2026-11')).toBe('2026-11-01');
    expect(monthParam('')).toBeNull();
  });
});

describe('Invitation metering migration (static; behaviour in tests/db)', () => {
  it('counts invitations at issue, transactionally and idempotently, with paid plans impossible', () => {
    expect(sql).toContain('CREATE TRIGGER llnd_mate_issue_invitation BEFORE INSERT ON public.assessment_invitations');
    expect(sql).toMatch(/FOR UPDATE;\s*\n\s*IF NEW\.is_test THEN/);
    expect(sql).toContain("RAISE EXCEPTION 'invitation_allowance_reached'");
    expect(sql).toContain("plan_code text NOT NULL CHECK (plan_code = 'llnd_mate_free')");
    expect(sql).toContain('invitation_id uuid PRIMARY KEY,');
    expect(sql).toContain('CONSTRAINT invitation_ledger_test_not_chargeable CHECK (NOT (is_test AND chargeable))');
    expect(sql).toContain('NEW.is_test := public.llnd_is_reserved_test_name(NEW.candidate_name);');
  });

  it('soft deletion: YES checked on the server, refund once and only for this month, hidden by restrictive RLS, no hard delete', () => {
    expect(sql).toContain("IF p_confirmation IS DISTINCT FROM 'YES' THEN");
    expect(sql).toMatch(/refunded_at IS NULL AND period_month = v_period/);
    expect(sql).toContain('CREATE POLICY llnd_mate_hide_deleted ON public.assessment_invitations AS RESTRICTIVE');
    expect(sql).toContain('CREATE POLICY llnd_mate_no_hard_delete ON public.assessment_invitations AS RESTRICTIVE');
    expect(sql).toContain("'invitation_assessments', 'assessment_responses', 'assessment_declarations'");
  });

  it('restoration and platform reporting require the Issue #45 operator check', () => {
    for (const fn of ['restore_assessment_assignment', 'platform_invitation_usage', 'platform_invitation_usage_history', 'platform_deleted_assessments']) {
      const body = sql.slice(sql.indexOf(`FUNCTION public.${fn}(`));
      expect(body.slice(0, 1500), fn).toContain('NOT public.llnd_is_platform_operator()');
    }
    expect(sql).toContain("IF to_regprocedure('public.is_platform_operator()') IS NULL THEN RETURN false; END IF;");
  });

  it('tests and deleted assignments trigger no integration, support case or legacy billing', () => {
    for (const t of ['BEFORE INSERT ON public.axcelerate_writeback_queue', 'BEFORE INSERT ON public.email_queue', 'BEFORE INSERT ON public.support_cases']) expect(sql).toContain(t);
    expect(sql).toContain('IF coalesce(v_skip, false) THEN RETURN NEW; END IF;');
    expect(sqlCode).not.toMatch(/stripe/i);
    expect(sqlCode).not.toMatch(/\b(INSERT INTO|UPDATE|DELETE FROM) (public\.)?(subscriptions|subscription_plans|billing_usage|billable_learners)\b/);
    expect(sqlCode).not.toMatch(/reservation|expires?_at|max_active/i);
  });

  it('edge functions skip tests and deleted assignments for integrations and result reuse', () => {
    const sync = read('supabase/functions/axcelerate-inbound-sync/index.ts');
    expect((sync.match(/\.is\("deleted_at", null\)\.eq\("is_test", false\)/g) ?? []).length).toBe(3);
    const complete = read('supabase/functions/on-assessment-complete/index.ts');
    expect(complete).toContain('if (inv.deleted_at) {');
    expect(complete).toContain('if (inv.student_id && !isTest) {');
    expect(complete).toContain('if (isTest) return;');
    expect(read('supabase/functions/upload-axcelerate-portfolio/index.ts')).toContain('invitation.deleted_at || invitation.is_test === true');
  });

  it('reports exclude tests; learner pages no longer carry the old start restriction', () => {
    expect(read('src/pages/CompliancePage.tsx')).toContain(".eq('is_test', false)");
    expect(read('src/pages/SupportPlansPage.tsx')).toContain(".eq('is_test', false)");
    expect(read('src/pages/DashboardPage.tsx')).toContain('.filter((i: any) => !i.is_test)');
    for (const f of ['src/pages/LLNAssessmentPage.tsx', 'src/pages/DigitalAssessmentPage.tsx', 'src/pages/QuizPage.tsx']) {
      expect(read(f), f).not.toContain('AssessmentStartUnavailable');
    }
    expect(fs.existsSync(path.join(ROOT, 'supabase/migrations/20261109120000_llnd_mate_free_tier_metering.sql'))).toBe(false);
  });

  it('ships DB integration and concurrency tests', () => {
    for (const f of ['tests/db/free_tier_invitations.test.sql', 'tests/db/free_tier_invitations_concurrency.sh']) expect(fs.existsSync(path.join(ROOT, f)), f).toBe(true);
  });
});
