// Build-time guard: decides whether this build may use the Supabase project it
// was given. Fails closed, so a Cloudflare preview build can never be pointed at
// the original (reference) database or at production by accident.
//
// Cloudflare Pages sets CF_PAGES=1 and CF_PAGES_BRANCH during builds.
// Local builds and CI test builds (no CF_PAGES) are not deployments and are allowed,
// except that they may still not target a protected project unless explicitly local.

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));

export function loadEnvironments(path = join(here, '..', 'deploy', 'supabase-environments.json')) {
  return JSON.parse(readFileSync(path, 'utf8'));
}

/** Returns the project ref from a Supabase URL, or null if it is not one. */
export function projectRef(url) {
  if (!url) return null;
  const m = /^https:\/\/([a-z0-9]{20})\.supabase\.co\/?$/.exec(String(url).trim());
  return m ? m[1] : null;
}

/**
 * @returns {{ ok: true, kind: string, ref: string|null } | { ok: false, reason: string }}
 */
export function checkBuildTarget(env, cfg) {
  const url = env.VITE_SUPABASE_URL;
  const onCloudflare = env.CF_PAGES === '1';
  if (!onCloudflare) {
    return { ok: true, kind: 'local', ref: projectRef(url) };
  }
  const ref = projectRef(url);
  if (!ref) {
    return { ok: false, reason: 'VITE_SUPABASE_URL is missing or is not a https://<ref>.supabase.co address.' };
  }
  const branch = env.CF_PAGES_BRANCH ?? '';
  if (branch === cfg.productionBranch) {
    if (!cfg.production.includes(ref)) {
      return { ok: false, reason: `Production build (${branch}) may not use Supabase project ${ref}.` };
    }
    return { ok: true, kind: 'production', ref };
  }
  if (cfg.protected.includes(ref) || cfg.production.includes(ref)) {
    return { ok: false, reason: `Preview build for branch "${branch}" is pointed at protected Supabase project ${ref}. Set the Cloudflare Pages preview environment to the staging project.` };
  }
  if (!cfg.preview.includes(ref)) {
    return { ok: false, reason: `Preview build for branch "${branch}" uses Supabase project ${ref}, which is not an approved preview project.` };
  }
  return { ok: true, kind: 'preview', ref };
}

/** Vite plugin wrapper: aborts the build when the target is not allowed. */
export function buildEnvGuard() {
  return {
    name: 'llnd-build-env-guard',
    apply: 'build',
    configResolved() {
      const result = checkBuildTarget(process.env, loadEnvironments());
      if (!result.ok) {
        throw new Error(`[build-env-guard] ${result.reason}`);
      }
      console.log(`[build-env-guard] ${result.kind} build, Supabase project ${result.ref ?? '(none)'}`);
    },
  };
}
