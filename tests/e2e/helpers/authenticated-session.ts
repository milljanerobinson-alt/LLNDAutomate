import { createClient, type Session } from '@supabase/supabase-js';
import type { Page } from 'playwright/test';

export function requiredEnvironment(name: string) {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is required for authenticated staging Playwright tests`);
  return value;
}

export const authenticatedEnvironment = {
  baseUrl: requiredEnvironment('BASE_URL'),
  supabaseUrl: requiredEnvironment('E2E_SUPABASE_URL'),
  anonKey: requiredEnvironment('E2E_SUPABASE_ANON_KEY'),
  serviceRoleKey: requiredEnvironment('E2E_SUPABASE_SERVICE_ROLE_KEY'),
  adminEmail: requiredEnvironment('E2E_ADMIN_EMAIL').toLowerCase(),
  adminPassword: requiredEnvironment('E2E_ADMIN_PASSWORD'),
  candidateSupportEmail: requiredEnvironment('E2E_CANDIDATE_SUPPORT_EMAIL').toLowerCase(),
  candidateSupportPassword: requiredEnvironment('E2E_CANDIDATE_SUPPORT_PASSWORD'),
  technicalEmail: requiredEnvironment('E2E_TECHNICAL_EMAIL').toLowerCase(),
  technicalPassword: requiredEnvironment('E2E_TECHNICAL_PASSWORD'),
  superUserEmail: requiredEnvironment('E2E_SUPER_USER_EMAIL').toLowerCase(),
  superUserPassword: requiredEnvironment('E2E_SUPER_USER_PASSWORD'),
  inviteEmail: requiredEnvironment('E2E_INVITE_EMAIL').toLowerCase(),
  invitePassword: requiredEnvironment('E2E_INVITE_PASSWORD'),
};

const permanentIdentities = [
  ['E2E_ADMIN_EMAIL', authenticatedEnvironment.adminEmail, 'milljanerobinson+admin@gmail.com'],
  ['E2E_CANDIDATE_SUPPORT_EMAIL', authenticatedEnvironment.candidateSupportEmail, 'milljanerobinson+cs@gmail.com'],
  ['E2E_TECHNICAL_EMAIL', authenticatedEnvironment.technicalEmail, 'milljanerobinson+tech@gmail.com'],
  ['E2E_SUPER_USER_EMAIL', authenticatedEnvironment.superUserEmail, 'milljanerobinson+super@gmail.com'],
] as const;

for (const [name, actual, expected] of permanentIdentities) {
  if (actual !== expected) throw new Error(`${name} must use the permanent staging identity ${expected}`);
}
if (new Set(permanentIdentities.map(([, email]) => email)).size !== permanentIdentities.length) {
  throw new Error('Permanent authenticated staging identities must be distinct');
}

const previewUrl = new URL(authenticatedEnvironment.baseUrl);
if (previewUrl.protocol !== 'https:' || !previewUrl.hostname.endsWith('.llndautomate.pages.dev')) {
  throw new Error('Authenticated Issue #40 tests require an HTTPS LLND Automate Cloudflare branch preview BASE_URL');
}
if (!authenticatedEnvironment.inviteEmail.includes('+e2e')) {
  throw new Error('E2E_INVITE_EMAIL must be a dedicated disposable +e2e address');
}
if (permanentIdentities.some(([, email]) => email === authenticatedEnvironment.inviteEmail)) {
  throw new Error('The disposable invitation identity must differ from the authenticated test identities');
}

export function serviceClient() {
  return createClient(authenticatedEnvironment.supabaseUrl, authenticatedEnvironment.serviceRoleKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
}

export function passwordClient() {
  return createClient(authenticatedEnvironment.supabaseUrl, authenticatedEnvironment.anonKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
}

export async function authenticatePage(page: Page, email: string, password: string) {
  const authClient = passwordClient();
  const { data, error } = await authClient.auth.signInWithPassword({ email, password });
  if (error || !data.session || !data.user) {
    throw new Error(`Dedicated staging identity could not sign in: ${error?.message ?? 'session missing'}`);
  }
  await installSession(page, data.session);
  return data.user;
}

async function installSession(page: Page, session: Session) {
  const projectRef = new URL(authenticatedEnvironment.supabaseUrl).hostname.split('.')[0];
  await page.addInitScript(({ storageKey, otpKey, storedSession }) => {
    localStorage.setItem(storageKey, JSON.stringify(storedSession));
    localStorage.setItem(otpKey, JSON.stringify({ expires: Date.now() + 60 * 60 * 1000 }));
  }, {
    storageKey: `sb-${projectRef}-auth-token`,
    otpKey: `ax_otp_verified_${session.user.id}`,
    storedSession: session,
  });
}

export async function removeDisposableInvitationFixture() {
  const service = serviceClient();
  const email = authenticatedEnvironment.inviteEmail;
  const matchingUsers = [];
  for (let page = 1; ; page += 1) {
    const { data: users, error: usersError } = await service.auth.admin.listUsers({ page, perPage: 100 });
    if (usersError) throw usersError;
    matchingUsers.push(...users.users.filter(user => user.email?.toLowerCase() === email));
    if (users.users.length < 100) break;
  }
  for (const user of matchingUsers) {
    const { error } = await service.auth.admin.deleteUser(user.id);
    if (error) throw error;
  }
  const { error: grantError } = await service.from('staff_invitation_grants').delete().eq('invited_email', email);
  if (grantError) throw grantError;
}
