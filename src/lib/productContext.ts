// Product Context Resolution
//
// Two products are distinguished by pathname:
//   /        -> LLND Automate
//   /eios    -> EIOS
//   /llnd and /lln are legacy LLND paths, migrated to /
//
// The pathname is the product boundary. The hash route is resolved within
// the product context. The two products must never interchange routes.

export type Product = 'eios' | 'llnd';

const LLND_PATH = '/';
const EIOS_PATH = '/eios';
const LEGACY_LLND_PATH = '/llnd';
const LEGACY_LLN_PATH = '/lln';

export function productBaseUrl(product: Product): string {
  const origin = typeof window === 'undefined' ? '' : window.location.origin;
  return `${origin}${product === 'eios' ? EIOS_PATH : LLND_PATH}`;
}

/**
 * Resolve the product context from the current pathname.
 * Performs legacy /llnd and /lln -> / migration via history.replaceState
 * (no extra history entry, no redirect loop) before returning.
 */
export function resolveProduct(): Product {
  if (typeof window === 'undefined') return 'llnd';

  const pathname = window.location.pathname;

  if (pathname === EIOS_PATH || pathname.startsWith(EIOS_PATH + '/')) {
    return 'eios';
  }

  // Preserve legacy OAuth callbacks while moving them to the EIOS boundary.
  if (pathname === '/oauth/consent') return 'eios';

  // Legacy /llnd and /lln paths now resolve at the LLND root.
  const legacyPrefix = [LEGACY_LLND_PATH, LEGACY_LLN_PATH]
    .find(prefix => pathname === prefix || pathname.startsWith(prefix + '/'));
  if (legacyPrefix) {
    const suffix = pathname.slice(legacyPrefix.length);
    const fullUrl = (suffix || LLND_PATH) + window.location.search + window.location.hash;
    history.replaceState(null, '', fullUrl);
    return 'llnd';
  }

  return 'llnd';
}

/**
 * Navigate within a product context, preserving the pathname boundary.
 * Only mutates the hash; the pathname stays as-is.
 */
export function navigateInProduct(product: Product, hash: string): void {
  const target = product === 'llnd' ? LLND_PATH : EIOS_PATH;
  const current = window.location.pathname;
  const normalisedHash = hash.startsWith('#') ? hash : `#${hash}`;

  if (current !== target) {
    // Cross-product navigation: replace pathname + hash together
    history.replaceState(null, '', target + normalisedHash);
    // Trigger hashchange so React state picks it up
    window.dispatchEvent(new HashChangeEvent('hashchange'));
  } else {
    if (window.location.hash !== normalisedHash) {
      window.location.hash = normalisedHash;
    }
  }
}

/**
 * Migrate persisted legacy LLND product paths to the root product.
 * Scans localStorage and sessionStorage for known redirect/route keys.
 */
export function migrateLegacyLlnPaths(): void {
  if (typeof window === 'undefined') return;

  const keysToCheck: string[] = [];
  try {
    for (let i = 0; i < localStorage.length; i++) {
      const k = localStorage.key(i);
      if (k) keysToCheck.push(k);
    }
  } catch { /* ignore */ }

  try {
    for (let i = 0; i < sessionStorage.length; i++) {
      const k = sessionStorage.key(i);
      if (k) keysToCheck.push(k);
    }
  } catch { /* ignore */ }

  for (const key of keysToCheck) {
    try {
      // localStorage
      let value = localStorage.getItem(key);
      if (value && (/\/llnd(?:\/|#|$)/.test(value) || /\/lln(?:\/|#|$)/.test(value))) {
        const migrated = value.replace(/\/llnd(?=\/|#|$)/g, '').replace(/\/lln(?=\/|#|$)/g, '');
        localStorage.setItem(key, migrated);
        continue;
      }
    } catch { /* ignore */ }

    try {
      // sessionStorage
      let value = sessionStorage.getItem(key);
      if (value && (/\/llnd(?:\/|#|$)/.test(value) || /\/lln(?:\/|#|$)/.test(value))) {
        const migrated = value.replace(/\/llnd(?=\/|#|$)/g, '').replace(/\/lln(?=\/|#|$)/g, '');
        sessionStorage.setItem(key, migrated);
      }
    } catch { /* ignore */ }
  }
}

/**
 * Returns true if a hash route belongs to EIOS product.
 * EIOS routes: engineering, EIOS login, OAuth, and the EIOS root.
 */
export function isEiosRoute(hash: string): boolean {
  const h = hash.replace(/^#\/?/, '').split('?')[0];
  if (!h || h === '') return true;
  const first = h.split('/')[0];
  return ['engineering', 'login', 'oauth'].includes(first);
}

/**
 * Returns true if a hash route belongs to LLND Automate product.
 * LLND routes include the three permission-based RTO staff workspaces and
 * separate public candidate token flows. Legacy staff routes remain recognised
 * only so App can migrate them safely.
 */
export function isLlndRoute(hash: string): boolean {
  const h = hash.replace(/^#\/?/, '').split('?')[0];
  if (!h || h === '') return false;
  const first = h.split('/')[0];
  return ['home', 'about', 'features', 'how-it-works', 'resources', 'contact',
    'pricing', 'signup', 'forgot-password', 'rto-admin', 'candidate-support', 'technical',
    'assessment', 'trainer', 'platform',
    'candidates', 'results', 'settings', 'llnd-automate', 'lln', 'digital',
    'quiz', 'student'].includes(first);
}
