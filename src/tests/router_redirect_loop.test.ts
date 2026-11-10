import { describe, expect, it } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';


const app = fs.readFileSync(path.resolve(__dirname, '..', 'App.tsx'), 'utf8');

describe('Router never spins forever on a redirect to the current page', () => {
  it('normalises equivalent route hashes', async () => {
    const { normaliseRouteHash } = await import('../lib/routeHash');
    expect(normaliseRouteHash('#/rto-admin/dashboard')).toBe('#/rto-admin/dashboard');
    expect(normaliseRouteHash('/rto-admin/dashboard/')).toBe('#/rto-admin/dashboard');
    expect(normaliseRouteHash('rto-admin/dashboard')).toBe('#/rto-admin/dashboard');
    expect(normaliseRouteHash('#/rto-admin/dashboard?x=1')).toBe('#/rto-admin/dashboard');
    expect(normaliseRouteHash('#/rto-admin/dashboard')).not.toBe(normaliseRouteHash('#/technical/dashboard'));
  });

  it('every redirect followed by the loader goes through the loop-safe helper', () => {
    expect(app).not.toMatch(/redirect\([^;\n]+\);\n\s*return <FullScreenLoader \/>;/);
    expect(app).toContain('function redirectTo(hash: string)');
    expect(app).toMatch(/normaliseRouteHash\(window\.location\.hash\) === normaliseRouteHash\(hash\)\) \{\s*return <NoWorkspaceAccess \/>;/);
  });

  it('workspace guards use the helper (no access shows a message, not a spinner)', () => {
    for (const ws of ['administration', 'candidate_support', 'technical']) {
      expect(app).toMatch(new RegExp(`if \\(!hasWorkspace\\('${ws}'\\)\\) \\{\\s*return redirectTo\\(`));
    }
    expect(app).toContain("You don’t have access to this workspace");
  });
});
