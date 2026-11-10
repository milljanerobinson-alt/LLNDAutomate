import { describe, expect, it } from 'vitest';
import { checkBuildTarget, loadEnvironments, projectRef } from '../../scripts/build-env-guard.mjs';

const ORIGINAL = 'clrsckerimjturebulbk';
const STAGING = 'abcdefghijklmnopqrst';
const url = (ref: string) => `https://${ref}.supabase.co`;
const cfg = { productionBranch: 'main', production: [ORIGINAL], preview: [STAGING], protected: [ORIGINAL] };

describe('Cloudflare build target guard', () => {
  it('parses only real Supabase project addresses', () => {
    expect(projectRef(url(ORIGINAL))).toBe(ORIGINAL);
    expect(projectRef(url(ORIGINAL) + '/')).toBe(ORIGINAL);
    for (const bad of [undefined, '', 'http://clrsckerimjturebulbk.supabase.co', 'https://evil.example.com', 'https://clrsckerimjturebulbk.supabase.co.evil.com'])
      expect(projectRef(bad as string)).toBeNull();
  });

  it('blocks every preview build that points at the original database', () => {
    for (const branch of ['feature/llnd-mate-test-candidates', 'ewo/diag-x', 'staging', 'Main', ''])
      expect(checkBuildTarget({ CF_PAGES: '1', CF_PAGES_BRANCH: branch, VITE_SUPABASE_URL: url(ORIGINAL) }, cfg)).toMatchObject({ ok: false });
  });

  it('allows previews only on an approved preview project', () => {
    expect(checkBuildTarget({ CF_PAGES: '1', CF_PAGES_BRANCH: 'feature/x', VITE_SUPABASE_URL: url(STAGING) }, cfg)).toEqual({ ok: true, kind: 'preview', ref: STAGING });
    expect(checkBuildTarget({ CF_PAGES: '1', CF_PAGES_BRANCH: 'feature/x', VITE_SUPABASE_URL: url('zzzzzzzzzzzzzzzzzzzz') }, cfg)).toMatchObject({ ok: false });
    expect(checkBuildTarget({ CF_PAGES: '1', CF_PAGES_BRANCH: 'feature/x' }, cfg)).toMatchObject({ ok: false });
  });

  it('production builds must use the production project', () => {
    expect(checkBuildTarget({ CF_PAGES: '1', CF_PAGES_BRANCH: 'main', VITE_SUPABASE_URL: url(ORIGINAL) }, cfg)).toMatchObject({ ok: true, kind: 'production' });
    expect(checkBuildTarget({ CF_PAGES: '1', CF_PAGES_BRANCH: 'main', VITE_SUPABASE_URL: url(STAGING) }, cfg)).toMatchObject({ ok: false });
  });

  it('local and CI builds are not deployments', () => {
    expect(checkBuildTarget({ VITE_SUPABASE_URL: url(ORIGINAL) }, cfg)).toMatchObject({ ok: true, kind: 'local' });
  });

  it('the committed configuration allows no preview project yet and protects the original database', () => {
    const real = loadEnvironments();
    expect(real.preview).toEqual([]);
    expect(real.protected).toContain(ORIGINAL);
    expect(checkBuildTarget({ CF_PAGES: '1', CF_PAGES_BRANCH: 'feature/staging-readiness', VITE_SUPABASE_URL: url(ORIGINAL) }, real)).toMatchObject({ ok: false });
  });
});
