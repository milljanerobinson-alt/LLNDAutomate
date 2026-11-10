/** Normalises '#/a/b', '/a/b' and 'a/b' to '#/a/b' (query part and trailing slash ignored). */
export function normaliseRouteHash(hash: string): string {
  const h = hash.startsWith('#') ? hash.slice(1) : hash;
  const path = h.split('?')[0].replace(/\/+$/, '');
  return '#' + (path.startsWith('/') ? path : '/' + path);
}
