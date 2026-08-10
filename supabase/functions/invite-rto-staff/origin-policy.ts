export const previewParentHostname = 'llndautomate.pages.dev';

export function parseOrigin(value: string | undefined) {
  if (!value) return null;
  try {
    const url = new URL(value.trim());
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) return null;
    if (url.pathname !== '/' && url.pathname !== '') return null;
    return url.origin;
  } catch {
    return null;
  }
}

export function isApprovedOrigin(value: string, siteUrl: string, allowlist: string[]) {
  const origin = parseOrigin(value);
  if (!origin) return false;
  if (origin === siteUrl || allowlist.includes(origin)) return true;
  const url = new URL(origin);
  return url.protocol === 'https:' &&
    url.port === '' &&
    url.hostname.endsWith(`.${previewParentHostname}`);
}
