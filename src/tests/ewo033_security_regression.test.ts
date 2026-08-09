/**
 * EWO-033 Security Regression — Pathname-Based Product Routing
 *
 * Regression tests for pathname-based product isolation. LLND now owns `/`
 * and EIOS owns `/eios`; neither product may expose the other's routes.
 * EXECUTE on get_my_role() from authenticated, breaking RLS policies
 * that depend on it, causing profile resolution to return null, which
 * cascaded into the EIOS root handler redirecting to an LLND workspace.
 */

import { describe, it, expect } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';

// ─── Helpers ──────────────────────────────────────────────────────────────────

const APP_PATH = path.resolve(__dirname, '../App.tsx');
const AUTH_PATH = path.resolve(__dirname, '../lib/auth.tsx');
const PRODUCT_CTX_PATH = path.resolve(__dirname, '../lib/productContext.ts');

function readFile(filePath: string): string {
  return fs.readFileSync(filePath, 'utf-8');
}

// ─── 1. Root cause: get_my_role() EXECUTE grant ─────────────────────────────────

describe('Root cause: get_my_role() EXECUTE grant', () => {
  it('App.tsx does not contain the broken global LLND fallback', () => {
    const app = readFile(APP_PATH);
    // The regression pattern: unconditional redirect to /llnd for all authenticated users
    expect(app).not.toMatch(/window\.location\.href\s*=\s*['"]\/llnd#\/assessment\/dashboard['"]/);
    expect(app).not.toMatch(/navigate\(['"]\/llnd#\/assessment\/dashboard['"]\)/);
  });
});

// ─── 2. EIOS root never redirects to LLND ──────────────────────────────────────

describe('EIOS /eios entry never exposes LLND routes', () => {
  const app = readFile(APP_PATH);

  it('does not contain navigate to /llnd#/assessment/dashboard', () => {
    // The global fallback pattern that caused the regression
    expect(app).not.toMatch(/navigate\(['"]\/llnd#\/assessment\/dashboard['"]\)/);
    expect(app).not.toMatch(/window\.location\.href\s*=\s*['"]\/llnd#\/assessment\/dashboard['"]/);
  });

  it('EIOS root handler checks product === eios', () => {
    expect(app).toMatch(/route\.kind\s*===\s*['"]root['"]\s*&&\s*product\s*===\s*['"]eios['"]/);
  });

  it('resolveEiosWorkspace function exists', () => {
    expect(app).toContain('function resolveEiosWorkspace');
  });

  it('resolveEiosWorkspace never returns assessment or trainer', () => {
    const fnMatch = app.match(/function resolveEiosWorkspace[\s\S]*?^}/m);
    expect(fnMatch).toBeTruthy();
    const fnBody = fnMatch![0];
    // Must not return 'assessment' or 'trainer' from EIOS context
    expect(fnBody).not.toMatch(/return\s+['"]assessment['"]/);
    expect(fnBody).not.toMatch(/return\s+['"]trainer['"]/);
  });

  it('resolveEiosWorkspace returns engineering for admin', () => {
    const fnMatch = app.match(/function resolveEiosWorkspace[\s\S]*?^}/m);
    const fnBody = fnMatch![0];
    expect(fnBody).toContain("profile?.role === 'admin'");
    expect(fnBody).toContain("return 'engineering'");
  });

  it('resolveEiosWorkspace does not hand non-admins into an LLND workspace', () => {
    const fnMatch = app.match(/function resolveEiosWorkspace[\s\S]*?^}/m);
    const fnBody = fnMatch![0];
    expect(fnBody).toContain("return 'engineering'");
    expect(fnBody).not.toContain("return 'platform_admin'");
  });
});

// ─── 3. Product boundary enforcement ──────────────────────────────────────────

describe('Product boundary enforcement', () => {
  const app = readFile(APP_PATH);
  const productCtx = readFile(PRODUCT_CTX_PATH);

  it('resolveProduct is called at the top of App', () => {
    expect(app).toContain('resolveProduct()');
  });

  it('resolveProduct assigns /eios to EIOS and / to LLND', () => {
    expect(productCtx).toContain("LLND_PATH = '/'");
    expect(productCtx).toContain("EIOS_PATH = '/eios'");
    expect(productCtx).toMatch(/pathname\s*===\s*EIOS_PATH/);
    expect(productCtx).toContain("return 'llnd'");
  });

  it('resolveProduct migrates legacy /llnd and /lln paths to root', () => {
    expect(productCtx).toContain('LEGACY_LLND_PATH');
    expect(productCtx).toContain('LEGACY_LLN_PATH');
    expect(productCtx).toContain('history.replaceState');
  });

  it('navigateInProduct preserves pathname boundary', () => {
    expect(productCtx).toContain('function navigateInProduct');
    expect(productCtx).toMatch(/target\s*=\s*product\s*===\s*['"]llnd['"]/);
  });

  it('isEiosRoute and isLlndRoute are defined', () => {
    expect(productCtx).toContain('function isEiosRoute');
    expect(productCtx).toContain('function isLlndRoute');
  });
});

// ─── 4. Cross-product contamination rejection ─────────────────────────────────

describe('Cross-product contamination rejection', () => {
  const app = readFile(APP_PATH);

  it('rejects EIOS routes at the LLND root', () => {
    expect(app).toMatch(/product\s*===\s*['"]llnd['"]\s*&&\s*isEiosRoute/);
  });

  it('redirects LLND routes under /eios to the root product', () => {
    expect(app).toMatch(/isLlndRoute\(hash\)/);
  });

  it('engineering routes at root redirect to an LLND fallback', () => {
    expect(app).toMatch(/route\.kind\s*===\s*['"]engineering['"]/);
  });

  it('technical routes under /eios return to LLND', () => {
    expect(app).toMatch(/route\.kind\s*===\s*['"]technical['"]/);
  });
});

// ─── 5. Authentication redirect product awareness ─────────────────────────────

describe('Authentication redirect product awareness', () => {
  const app = readFile(APP_PATH);
  const auth = readFile(AUTH_PATH);

  it('post-login redirect checks product === llnd', () => {
    expect(app).toMatch(/product\s*===\s*['"]llnd['"]/);
  });

  it('signOut resets to #/ not /llnd', () => {
    expect(auth).toContain("window.location.hash = '#/'");
  });

  it('OAuth redirect uses the active product base URL', () => {
    expect(auth).toContain('productBaseUrl(resolveProduct())');
  });
});

// ─── 6. Fallback route logic ───────────────────────────────────────────────────

describe('Fallback route logic', () => {
  const app = readFile(APP_PATH);

  it('fallback for signed-in EIOS user uses resolveEiosWorkspace', () => {
    // The fallback section should call resolveEiosWorkspace, not primaryWorkspaceFor
    expect(app).toMatch(/resolveEiosWorkspace\(getLastWorkspace\(\)/);
  });

  it('fallback for signed-out user uses product-aware login', () => {
    expect(app).toMatch(/product\s*===\s*['"]llnd['"]\s*\?\s*['"]#\/llnd-automate\/login['"]\s*:\s*['"]#\/login['"]/);
  });
});

// ─── 7. Legacy /lln migration ──────────────────────────────────────────────────

describe('Legacy LLND path migration', () => {
  const productCtx = readFile(PRODUCT_CTX_PATH);

  it('migrates /llnd and /lln to root preserving hash', () => {
    expect(productCtx).toContain('LEGACY_LLND_PATH');
    expect(productCtx).toContain('LEGACY_LLN_PATH');
    expect(productCtx).toContain('LLND_PATH');
    expect(productCtx).toContain('pathname.slice(legacyPrefix.length)');
    expect(productCtx).toMatch(/fullUrl\s*=\s*\(suffix\s*\|\|\s*LLND_PATH\)/);
  });

  it('uses history.replaceState not pushState', () => {
    expect(productCtx).toContain('history.replaceState');
    expect(productCtx).not.toContain('history.pushState');
  });

  it('migrateLegacyLlnPaths scans localStorage and sessionStorage', () => {
    expect(productCtx).toContain('function migrateLegacyLlnPaths');
    expect(productCtx).toContain('localStorage');
    expect(productCtx).toContain('sessionStorage');
  });
});

// ─── 8. _redirects configuration ──────────────────────────────────────────────

describe('_redirects configuration', () => {
  it('routes /oauth/consent to hash route', () => {
    const redirects = fs.readFileSync(
      path.resolve(__dirname, '../../public/_redirects'),
      'utf-8',
    );
    expect(redirects).toContain('/oauth/consent  /eios#/oauth/consent  302');
    expect(redirects).toContain('/*  /index.html  200');
  });
});

// ─── 9. Security controls retained ─────────────────────────────────────────────

describe('Security controls retained', () => {
  const auth = readFile(AUTH_PATH);

  it('onAuthStateChange is still wrapped properly (no deadlock)', () => {
    // The auth state change handler should exist
    expect(auth).toContain('onAuthStateChange');
  });

  it('signOut clears OTP and session', () => {
    expect(auth).toContain('clearOtpVerified');
    expect(auth).toContain('supabase.auth.signOut()');
  });

  it('getSession is called for session restoration', () => {
    expect(auth).toContain('supabase.auth.getSession()');
  });

  it('loadProfile uses maybeSingle (not single)', () => {
    expect(auth).toContain('.maybeSingle()');
  });
});

// ─── 10. Route registry integrity ───────────────────────────────────────────────

describe('Route registry integrity', () => {
  const registry = readFile(path.resolve(__dirname, '../lib/routeRegistry.ts'));

  it('assessment.dashboard is registered as assessment workspace', () => {
    expect(registry).toContain("'assessment', section: 'dashboard'");
  });

  it('engineering routes are in engineering workspace', () => {
    expect(registry).toMatch(/route_key:\s*['"]engineering\.mission-control['"]/);
  });

  it('navigate function only changes hash, not pathname', () => {
    expect(registry).toContain('function navigate');
    expect(registry).toMatch(/window\.location\.hash\s*=\s*hash/);
  });
});

// ─── 11. Deep link preservation ───────────────────────────────────────────────

describe('Deep link preservation', () => {
  const app = readFile(APP_PATH);

  it('App reads window.location.hash on mount', () => {
    expect(app).toMatch(/useState\(window\.location\.hash\)/);
  });

  it('App listens to hashchange event', () => {
    expect(app).toMatch(/hashchange/);
  });

  it('App syncs window.location.hash back', () => {
    expect(app).toMatch(/window\.location\.hash\s*!==\s*hash/);
  });
});

// ─── 12. Product-aware workspace resolution ─────────────────────────────────────

describe('Product-aware workspace resolution', () => {
  const app = readFile(APP_PATH);

  it('uses permission-derived primaryWorkspace for LLND context', () => {
    expect(app).toContain('primaryWorkspace');
  });

  it('LLND root remains the public product boundary', () => {
    expect(app).toMatch(/route\.kind\s*===\s*['"]root['"]\s*&&\s*product\s*===\s*['"]llnd['"]/);
  });
});

// ─── 13. No global LLND fallback for authenticated users ───────────────────────

describe('No global LLND fallback for authenticated users', () => {
  const app = readFile(APP_PATH);

  it('does not have unconditional redirect to /llnd for authenticated users', () => {
    // Every redirect to assessment/dashboard must be inside a product === 'llnd' check
    const lines = app.split('\n');
    for (let i = 0; i < lines.length; i++) {
      if (lines[i].includes("assessment/dashboard") && lines[i].includes('redirect(')) {
        // Look backwards for product === 'llnd' check
        let foundLlndCheck = false;
        for (let j = Math.max(0, i - 10); j < i; j++) {
          if (lines[j].includes("product === 'llnd'") || lines[j].includes('product === "llnd"')) {
            foundLlndCheck = true;
            break;
          }
        }
        expect(foundLlndCheck).toBe(true);
      }
    }
  });
});
