import { beforeEach, describe, expect, it, vi } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import * as React from 'react';
import * as fs from 'fs';
import * as path from 'path';

const rpc = vi.fn();
vi.mock('../lib/supabase', () => ({ supabase: { rpc: (...a: unknown[]) => rpc(...a), from: vi.fn() }, createQuizClient: vi.fn() }));

import { createTestCandidate, deleteTestCandidate, isValidTestCandidateEmail, parsePlanUsage, previewNextTestCandidateName, UPGRADE_OPTIONS_HASH, type PlanUsageState } from '../lib/planUsage';
import { PlanUsageView } from '../pages/PlanStatusPage';
import { UsageAllowanceNoticeView } from '../components/UsageAllowanceNotice';
import { CreateTestCandidateDialog } from '../components/CreateTestCandidateDialog';
import { PendingTestCandidates } from '../components/PendingTestCandidates';

const ROOT = path.resolve(__dirname, '..', '..');
const read = (rel: string) => fs.readFileSync(path.join(ROOT, rel), 'utf8');
const sql = read('supabase/migrations/20261110150000_llnd_mate_test_candidates.sql');
const html = (el: React.ReactElement) => renderToStaticMarkup(el).replace(/<svg[\s\S]*?<\/svg>/g, '').replace(/&#x27;|&#39;/g, "'").replace(/&amp;/g, '&');
const usage = (used: number) => parsePlanUsage({
  state: 'ok', consistent: true,
  plan: { code: 'llnd_mate_free', name: 'LLND Mate', tier: 'Free', status: 'active', unit: 'invitations' },
  period: { reset_date: '2026-12-01' },
  usage: { used, allowance: 10, remaining: Math.max(10 - used, 0), sent_this_month: used, returned_by_deletion: 0, test_invitations: 0, new_invitations_available: used < 10 },
}) as PlanUsageState;

describe('Upgrade button', () => {
  it('appears only when the Free allowance is used up, inside the red warning, linking to the existing pricing page', () => {
    for (const n of [0, 6, 8, 9]) {
      expect(html(<PlanUsageView state={usage(n)} />)).not.toContain('Explore upgrade options');
      expect(html(<UsageAllowanceNoticeView state={usage(n)} />)).not.toContain('Explore upgrade options');
    }
    const plan = html(<PlanUsageView state={usage(10)} />);
    const notice = html(<UsageAllowanceNoticeView state={usage(10)} />);
    for (const out of [plan, notice]) {
      expect(out).toMatch(/role="alert"[\s\S]*href="#\/pricing"[^>]*>Explore upgrade options/);
      expect(out).toContain('Upgrading to a paid plan will allow additional assessments once paid plans become available.');
    }
    expect(UPGRADE_OPTIONS_HASH).toBe('#/pricing');
    expect(read('src/App.tsx')).toContain("if (parts[0] === 'pricing')");
  });

  it('opens the existing pricing page only: no checkout, subscription or entitlement change anywhere in the new code', () => {
    for (const f of ['src/components/UpgradeOptionsButton.tsx', 'src/components/CreateTestCandidateDialog.tsx', 'src/components/PendingTestCandidates.tsx']) {
      expect(read(f), f).not.toMatch(/stripe|checkout|subscriptions|subscription_plans|rpc\(/i);
    }
    const pricing = read('src/pages/PricingPage.tsx');
    expect(pricing).not.toMatch(/supabase|stripe|checkout/i);
    expect(pricing).toContain('Not yet available to purchase');
  });
});

describe('Create Test Candidate client and dialog', () => {
  beforeEach(() => rpc.mockReset());

  it('validates email like the database and reuses addresses freely', () => {
    for (const ok of ['trainer@example.com', 'a.b+c@sub.example.com.au']) expect(isValidTestCandidateEmail(ok), ok).toBe(true);
    for (const bad of ['', ' ', 'trainer', 'trainer@', '@example.com', 'a b@example.com', 'a@example']) expect(isValidTestCandidateEmail(bad), bad).toBe(false);
  });

  it('asks the server for the name; the browser never sends one', async () => {
    rpc.mockResolvedValueOnce({ data: 'Test Test2', error: null });
    expect(await previewNextTestCandidateName()).toBe('Test Test2');
    rpc.mockResolvedValueOnce({ data: { id: 'x', candidate_name: 'Test Test2', email: 'a@b.co', sequence_number: 2 }, error: null });
    const r = await createTestCandidate(' a@b.co ');
    expect(r).toMatchObject({ ok: true, candidate: { candidateName: 'Test Test2', sequenceNumber: 2 } });
    expect(rpc).toHaveBeenLastCalledWith('create_test_candidate', { p_email: 'a@b.co' });
    expect(await createTestCandidate('nope')).toEqual({ ok: false, message: 'Enter a valid email address.' });
    rpc.mockResolvedValueOnce({ data: null, error: { code: '42501', message: 'not_authorised' } });
    expect(await createTestCandidate('a@b.co')).toMatchObject({ ok: false });
    rpc.mockResolvedValueOnce({ data: null, error: { code: '22023', message: 'confirmation_required' } });
    expect(await deleteTestCandidate('x', 'yes')).toEqual({ ok: false, message: 'Type YES to confirm deletion.' });
  });

  it('dialog explains the exemption and shows the name as read-only text, not an input', () => {
    const out = html(<CreateTestCandidateDialog open onClose={() => undefined} onCreated={() => undefined} preview={async () => 'Test Test'} create={async () => ({ ok: false, message: '' })} />);
    expect(out).toContain('Create Test Candidate');
    expect(out).toContain('Their assessments are free and don’t count towards your monthly allowance');
    expect(out).toContain('Candidate name (automatically generated)');
    expect(out).toContain('The name is set by LLND Mate and can’t be changed.');
    expect((out.match(/<input/g) ?? []).length).toBe(1);
    expect(out).toContain('type="email"');
    expect(html(<CreateTestCandidateDialog open={false} onClose={() => undefined} onCreated={() => undefined} />)).toBe('');
  });

  it('pending Test Candidates show TEST and a Send assessment action', () => {
    const out = html(<PendingTestCandidates candidates={[{ id: 't', candidateName: 'Test Test3', email: 'x@y.co', sequenceNumber: 3, createdAt: '' }]} highlightId="t" onSend={() => undefined} onDelete={() => undefined} />);
    expect(out).toContain('Test Test3');
    expect(out).toContain('>TEST<');
    expect(out).toContain('Send assessment');
    expect(out).toContain('No assessment sent yet');
  });
});

describe('Candidates page reuses the existing invitation workflow', () => {
  const page = read('src/pages/CandidatesPage.tsx');
  it('Create Test Candidate sits beside New Invitation and sending opens the existing form with the Test Candidate', () => {
    expect(page).toMatch(/Create Test Candidate\s*<\/button>\s*<button onClick=\{\(\) => setShowModal\(true\)\} className="btn-primary">\s*<Plus className="w-4 h-4" \/> New Invitation/);
    expect(page).toContain('function openSendToTestCandidate(tc: TestCandidate)');
    expect(page).toContain('test_candidate_id: sendingTo?.id ?? null,');
    expect((page.match(/\.from\('assessment_invitations'\)\s*\.insert\(/g) ?? []).length).toBe(1);
    expect(page).toContain('disabled={submitting || !!editingInvitation?.is_test || !!sendingTo}');
    expect(page).toContain('disabled={submitting || !!sendingTo || !!editingInvitation?.test_candidate_id}');
  });
});

describe('Test Candidate migration (static; behaviour in tests/db)', () => {
  it('allocates names on the server from a per-RTO counter that never goes back', () => {
    expect(sql).toContain('UPDATE public.organisation_test_candidate_counters SET last_number = last_number + 1');
    expect(sql).toContain("SELECT CASE WHEN p_number = 1 THEN 'Test Test' ELSE 'Test Test' || p_number END");
    expect(sql).toContain('CONSTRAINT test_candidates_unique_number UNIQUE (organisation_id, sequence_number)');
    expect(sql).toContain('CONSTRAINT test_candidates_name_matches_sequence');
    expect(sql).not.toMatch(/last_number\s*=\s*last_number\s*-|DELETE FROM public\.organisation_test_candidate_counters/);
  });

  it('locks identity and classification; links only within the same RTO', () => {
    expect(sql).toContain("NEW.is_test := NEW.test_candidate_id IS NOT NULL OR public.llnd_is_reserved_test_name(NEW.candidate_name);");
    expect(sql).toContain('NEW.candidate_name := tc.candidate_name;');
    expect(sql).toContain('NEW.candidate_email := tc.email;');
    expect(sql).toContain("IF tc.id IS NULL OR tc.organisation_id IS DISTINCT FROM NEW.organisation_id OR tc.deleted_at IS NOT NULL THEN");
    expect(sql).toContain('IF NEW.test_candidate_id IS DISTINCT FROM OLD.test_candidate_id THEN');
    expect(sql).toContain('REVOKE ALL ON TABLE public.test_candidates FROM PUBLIC, anon, authenticated;');
    expect(sql).not.toMatch(/GRANT (INSERT|UPDATE|DELETE|ALL)[^;]*test_candidates/);
  });

  it('creating a Test Candidate is not an invitation and touches no billing', () => {
    const create = sql.slice(sql.indexOf('FUNCTION public.create_test_candidate'), sql.indexOf('FUNCTION public.delete_test_candidate'));
    expect(create).not.toMatch(/assessment_invitations|organisation_invitation_ledger|organisation_usage_periods/);
    expect(sql.replace(/--.*$/gm, '')).not.toMatch(/stripe|subscriptions|subscription_plans|billable_learners|billing_usage/i);
  });

  it('ships database and concurrency tests', () => {
    expect(read('tests/db/test_candidates.test.sql')).toContain('ALL TEST CANDIDATE CHECKS PASSED');
    expect(read('tests/db/free_tier_invitations_concurrency.sh')).toContain('C6 (Test Candidates)');
  });
});
