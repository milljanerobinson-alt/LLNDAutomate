import { beforeEach, describe, expect, it, vi } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import * as React from 'react';
import * as fs from 'fs';
import * as path from 'path';

const rpc = vi.fn();
vi.mock('../lib/supabase', () => ({ supabase: { rpc: (...a: unknown[]) => rpc(...a) }, createQuizClient: vi.fn() }));

import {
  fetchPlanUsage, formatResetDate, isAssessmentStartUnavailable, parsePlanUsage, usageLevel, type PlanUsageState,
} from '../lib/planUsage';
import { PlanUsageView } from '../pages/PlanStatusPage';
import { UsageAllowanceNoticeView } from '../components/UsageAllowanceNotice';
import { AssessmentStartUnavailable } from '../components/AssessmentStartUnavailable';

const ROOT = path.resolve(__dirname, '..', '..');
const read = (rel: string) => fs.readFileSync(path.join(ROOT, rel), 'utf8');
const MIGRATION = 'supabase/migrations/20261109120000_llnd_mate_free_tier_metering.sql';
const sql = read(MIGRATION);
const sqlCode = sql.replace(/--.*$/gm, '');
const html = (el: React.ReactElement) => renderToStaticMarkup(el).replace(/<svg[\s\S]*?<\/svg>/g, '').replace(/&#x27;|&#39;/g, "'").replace(/&amp;/g, '&');

function server(completed: number, extra: Record<string, unknown> = {}) {
  const allowance = 10;
  return {
    state: 'ok', consistent: true,
    plan: { code: 'llnd_mate_free', name: 'LLND Mate', tier: 'Free', status: 'active', monthly_allowance: allowance },
    period: { month: '2026-11-01', starts_at: '2026-10-31T14:00:00Z', resets_at: '2026-11-30T14:00:00Z', reset_date: '2026-12-01', timezone: 'AEST (UTC+10)' },
    usage: { completed, allowance, remaining: Math.max(allowance - completed, 0), in_progress: 2, new_starts_available: completed < allowance },
    ...extra,
  };
}

describe('Plan & usage: parsing the server response', () => {
  it('maps a valid response and the usage levels (8 of 10 is "nearly used")', () => {
    const s = parsePlanUsage(server(6));
    expect(s).toMatchObject({ kind: 'ok', planName: 'LLND Mate', tierLabel: 'Free', completed: 6, allowance: 10, remaining: 4, inProgress: 2, resetDate: '2026-12-01', level: 'normal' });
    expect([0, 1, 7, 8, 9, 10, 11].map((n) => usageLevel(n, 10))).toEqual(['empty', 'normal', 'normal', 'near', 'near', 'exhausted', 'exhausted']);
    expect(parsePlanUsage(server(11))).toMatchObject({ kind: 'ok', completed: 11, remaining: 0, newStartsAvailable: false, level: 'exhausted' });
  });

  it('never defaults: missing entitlement, mismatches and malformed data are not shown as a Free plan', () => {
    expect(parsePlanUsage({ ...server(0), state: 'no_entitlement', plan: null })).toEqual({ kind: 'no_entitlement' });
    const bad: unknown[] = [
      null, undefined, 'x', {}, { state: 'weird' },
      server(3, { consistent: false }),
      server(3, { plan: { code: 'llnd_mate_plus', status: 'active' } }),
      server(3, { plan: { code: 'llnd_mate_free', status: 'suspended' } }),
      { ...server(3), usage: { completed: 3, allowance: 10, remaining: 9, in_progress: 0, new_starts_available: true } },
      { ...server(3), usage: { completed: '3', allowance: 10, remaining: 7, in_progress: 0, new_starts_available: true } },
      { ...server(3), usage: { completed: 3, allowance: 0, remaining: 0, in_progress: 0, new_starts_available: false } },
      { ...server(10), usage: { completed: 10, allowance: 10, remaining: 0, in_progress: 0, new_starts_available: true } },
      { ...server(3), period: { reset_date: '2026-12-15' } },
    ];
    for (const b of bad) expect(parsePlanUsage(b).kind).toBe('inconsistent');
  });

  it('maps RPC failures to unauthorised or error without figures', async () => {
    rpc.mockResolvedValueOnce({ data: null, error: { code: '42501', message: 'not_authorised' } });
    expect(await fetchPlanUsage()).toEqual({ kind: 'unauthorised' });
    rpc.mockResolvedValueOnce({ data: null, error: { code: '08006', message: 'network' } });
    expect(await fetchPlanUsage()).toEqual({ kind: 'error' });
    rpc.mockRejectedValueOnce(new Error('offline'));
    expect(await fetchPlanUsage()).toEqual({ kind: 'error' });
    rpc.mockResolvedValueOnce({ data: server(4), error: null });
    expect(await fetchPlanUsage()).toMatchObject({ kind: 'ok', completed: 4 });
    // The browser never sends an organisation id.
    for (const call of rpc.mock.calls) expect(call).toEqual(['get_my_plan_usage']);
  });

  it('formats the reset date without time-zone drift and recognises a refused start', () => {
    expect(formatResetDate('2026-12-01')).toBe('1 December 2026');
    expect(formatResetDate('2027-01-01')).toBe('1 January 2027');
    expect(isAssessmentStartUnavailable({ message: 'assessment_start_unavailable', code: 'P0001' })).toBe(true);
    expect(isAssessmentStartUnavailable({ message: 'permission denied' })).toBe(false);
    expect(isAssessmentStartUnavailable(null)).toBe(false);
  });
});

describe('Plan & usage page states', () => {
  beforeEach(() => rpc.mockReset());
  const ok = (n: number) => parsePlanUsage(server(n)) as PlanUsageState;

  it('normal: plan, active only when confirmed, used, remaining, progress bar and reset date', () => {
    const out = html(<PlanUsageView state={ok(6)} />);
    for (const t of ['LLND Mate', 'Free', 'Active', '6 of 10 assessments used', '4 assessments remaining', 'Resets 1 December 2026', 'role="progressbar"', 'aria-valuenow="6"', 'learners have started but not finished']) {
      expect(out).toContain(t);
    }
    expect(out).toContain('Need more assessments? LLND Mate Plus is coming soon.');
  });

  it('near limit at 8 of 10', () => {
    const out = html(<PlanUsageView state={ok(8)} />);
    expect(out).toContain('Your free allowance is nearly used.');
    expect(out).toContain('2 assessments left this month');
  });

  it('exhausted at 10 of 10: no new starts until reset, in-progress learners may finish', () => {
    const out = html(<PlanUsageView state={ok(10)} />);
    expect(out).toContain('You’ve used all 10 free assessments for this month.');
    expect(out).toContain('No new assessments can be started until 1 December 2026.');
    expect(out).toContain('Learners who have already started can still finish.');
    expect(out).toContain('0 assessments remaining');
  });

  it('over the allowance after in-progress learners finished is explained, not hidden', () => {
    const out = html(<PlanUsageView state={ok(11)} />);
    expect(out).toContain('11 of 10 assessments used');
    expect(out).toContain('11 assessments were completed this month');
  });

  it('empty month', () => {
    expect(html(<PlanUsageView state={ok(0)} />)).toContain('No completed assessments yet this month.');
  });

  it('loading, error, unauthorised, missing entitlement and inconsistent show no figures and no Active badge', () => {
    const cases: [PlanUsageState, string][] = [
      [{ kind: 'loading' }, 'Loading your plan and usage'],
      [{ kind: 'error' }, 'We couldn’t load your plan and usage right now.'],
      [{ kind: 'unauthorised' }, 'You don’t have access to plan and usage details.'],
      [{ kind: 'no_entitlement' }, 'Your organisation’s plan could not be confirmed.'],
      [{ kind: 'inconsistent' }, 'Your usage figures need checking.'],
    ];
    for (const [state, text] of cases) {
      const out = html(<PlanUsageView state={state} />);
      expect(out).toContain(text);
      expect(out).not.toMatch(/ of \d+ assessments used|assessments remaining|Active</);
    }
  });

  it('offers no purchase or upgrade action for paid tiers', () => {
    for (const n of [0, 8, 10]) {
      const out = html(<PlanUsageView state={ok(n)} />);
      expect(out).not.toMatch(/<button[^>]*>[^<]*(Upgrade|Buy|Purchase|Subscribe)/i);
      expect(out).not.toMatch(/href="[^"]*(checkout|stripe|billing\/upgrade)/i);
      expect(out).toContain('not yet available to purchase');
    }
  });
});

describe('Staff and learner messaging', () => {
  const ok = (n: number) => parsePlanUsage(server(n)) as PlanUsageState;
  it('staff notice appears only near or at the limit, or when the plan is unconfirmed', () => {
    expect(html(<UsageAllowanceNoticeView state={ok(3)} />)).toBe('');
    expect(html(<UsageAllowanceNoticeView state={{ kind: 'error' }} />)).toBe('');
    expect(html(<UsageAllowanceNoticeView state={ok(8)} />)).toContain('An invitation doesn’t reserve an assessment');
    const full = html(<UsageAllowanceNoticeView state={ok(10)} />);
    expect(full).toContain('You can still send invitations, but new assessments can’t be started until 1 December 2026.');
    expect(html(<UsageAllowanceNoticeView state={{ kind: 'no_entitlement' }} />)).toContain('Your plan could not be confirmed.');
  });

  it('learner message is friendly and reveals no plan, usage or subscription details', () => {
    const out = html(<AssessmentStartUnavailable />);
    expect(out).toContain('This assessment can’t be started right now');
    expect(out).toContain('anything you have already saved is kept');
    expect(out.replace(/<[^>]+>/g, ' ')).not.toMatch(/allowance|plan|subscription|LLND Mate|limit|\b10\b/i);
  });

  it('each learner page stops on a refused start instead of continuing', () => {
    for (const f of ['src/pages/LLNAssessmentPage.tsx', 'src/pages/DigitalAssessmentPage.tsx', 'src/pages/QuizPage.tsx']) {
      const s = read(f);
      expect(s, f).toContain('isAssessmentStartUnavailable(');
      expect(s, f).toContain('<AssessmentStartUnavailable />');
    }
    expect(read('src/pages/CandidatesPage.tsx')).toContain('<UsageAllowanceNotice />');
  });
});

describe('Metering migration (static checks; behaviour is tested in tests/db)', () => {
  it('is server-authoritative, idempotent and isolated', () => {
    expect(sql).toContain('CONSTRAINT organisation_usage_completions_one_per_assignment UNIQUE (invitation_id)');
    expect(sql).toContain('ON CONFLICT ON CONSTRAINT organisation_usage_completions_one_per_assignment DO NOTHING');
    expect(sql).toMatch(/FOR UPDATE;\s*IF v_completed >= v_allowance THEN/);
    expect(sql).toContain("plan_code text NOT NULL CHECK (plan_code = 'llnd_mate_free')");
    for (const t of ['organisation_plan_entitlements', 'organisation_usage_completions', 'organisation_usage_periods']) {
      expect(sql).toContain(`ALTER TABLE public.${t} ENABLE ROW LEVEL SECURITY;`);
      expect(sql).toContain(`REVOKE ALL ON TABLE public.${t} FROM PUBLIC, anon, authenticated;`);
      expect(sql).not.toMatch(new RegExp(`GRANT (INSERT|UPDATE|DELETE|ALL)[^;]*ON TABLE public\\.${t}`));
    }
    expect(sql).toContain('CREATE OR REPLACE FUNCTION public.get_my_plan_usage()\nRETURNS jsonb');
    expect(sql).toContain('REVOKE ALL ON FUNCTION public.get_my_plan_usage() FROM PUBLIC, anon;');
    expect(sql).toContain("(ts AT TIME ZONE 'UTC') + interval '10 hours'");
  });

  it('covers both learner paths and both start and completion', () => {
    for (const trig of [
      'BEFORE UPDATE OF lln_status, digital_status, status ON public.assessment_invitations',
      'BEFORE INSERT ON public.assessment_invitations',
      'BEFORE UPDATE OF individual_status ON public.invitation_assessments',
      'BEFORE INSERT ON public.invitation_assessments',
      'AFTER UPDATE OF lln_status, digital_status, status ON public.assessment_invitations',
      'AFTER UPDATE OF individual_status ON public.invitation_assessments',
    ]) expect(sql).toContain(trig);
  });

  it('adds no unapproved rule and no paid billing', () => {
    expect(sqlCode).not.toMatch(/reserv|timeout|expires?_at|max_active|active_cap/i);
    expect(sqlCode).not.toMatch(/\b(subscriptions|subscription_plans|billing_usage|billing_events|billable_learners)\b/);
    expect(sqlCode).not.toMatch(/stripe/i);
    expect(sqlCode).not.toMatch(/\bDELETE FROM\b|\bDROP TABLE\b|\bTRUNCATE\b/i);
    expect(sql).toContain("RAISE EXCEPTION 'assessment_start_unavailable' USING ERRCODE = 'P0001'");
  });

  it('ships DB integration and concurrency tests and the design doc', () => {
    for (const f of ['tests/db/free_tier_metering.test.sql', 'tests/db/free_tier_metering_concurrency.sh', 'docs/billing/free-tier-metering.md']) {
      expect(fs.existsSync(path.join(ROOT, f)), f).toBe(true);
    }
  });
});
