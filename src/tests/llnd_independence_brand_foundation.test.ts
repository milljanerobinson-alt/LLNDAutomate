import { afterEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import { isEiosRoute, isLlndRoute, productBaseUrl, resolveProduct } from '../lib/productContext';

afterEach(() => vi.unstubAllGlobals());

describe('LLND Automate product boundary', () => {
  function atPath(pathname: string) {
    const replaceState = vi.fn();
    vi.stubGlobal('window', {
      location: { pathname, search: '', hash: '' },
    });
    vi.stubGlobal('history', { replaceState });
    return replaceState;
  }

  it('uses LLND Automate as the root product', () => {
    atPath('/');
    expect(resolveProduct()).toBe('llnd');
  });

  it('uses EIOS under /eios', () => {
    atPath('/eios');
    expect(resolveProduct()).toBe('eios');
  });

  it('builds product-aware callback URLs', () => {
    vi.stubGlobal('window', { location: { origin: 'http://localhost:5173' } });
    expect(productBaseUrl('llnd')).toBe('http://localhost:5173/');
    expect(productBaseUrl('eios')).toBe('http://localhost:5173/eios');
  });

  it('migrates the former /llnd boundary to root', () => {
    const replaceState = atPath('/llnd');
    expect(resolveProduct()).toBe('llnd');
    expect(replaceState).toHaveBeenCalledWith(null, '', '/');
  });

  it.each([
    '#/home',
    '#/pricing',
    '#/signup',
    '#/llnd-automate/login',
    '#/rto-admin/dashboard',
    '#/candidate-support/dashboard',
    '#/technical/dashboard',
  ])('classifies %s as LLND', (route) => {
    expect(isLlndRoute(route)).toBe(true);
    expect(isEiosRoute(route)).toBe(false);
  });

  it.each(['#/login', '#/oauth/consent', '#/engineering/mission-control'])(
    'classifies %s as EIOS',
    (route) => {
      expect(isEiosRoute(route)).toBe(true);
      expect(isLlndRoute(route)).toBe(false);
    },
  );

  it('filters engineering from LLND workspace switching and command search', () => {
    const switcher = fs.readFileSync(path.resolve(__dirname, '../components/WorkspaceSwitcher.tsx'), 'utf-8');
    const palette = fs.readFileSync(path.resolve(__dirname, '../components/CommandPalette.tsx'), 'utf-8');
    expect(switcher).toContain("if (ws.key === 'engineering') return false");
    expect(palette).toContain("product === 'eios' ? EIOS_COMMANDS : LLND_COMMANDS");
  });
});
