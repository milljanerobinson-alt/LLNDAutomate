// Issue #45 — staging operator identity helpers.
//
// The operator test account is separate from the four permanent RTO test
// identities and must never be one of them. Its TOTP secret lives only in
// secure environment variables; nothing here prints it.

import { createHmac } from 'node:crypto';
import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { authenticatedEnvironment, requiredEnvironment } from './authenticated-session';

export const operatorEnvironment = {
  email: requiredEnvironment('E2E_OPERATOR_EMAIL').toLowerCase(),
  password: requiredEnvironment('E2E_OPERATOR_PASSWORD'),
  totpSecret: requiredEnvironment('E2E_OPERATOR_TOTP_SECRET').replace(/\s+/g, '').toUpperCase(),
};

const rtoIdentities = [
  authenticatedEnvironment.adminEmail,
  authenticatedEnvironment.candidateSupportEmail,
  authenticatedEnvironment.technicalEmail,
  authenticatedEnvironment.superUserEmail,
];
if (rtoIdentities.includes(operatorEnvironment.email)) {
  throw new Error('E2E_OPERATOR_EMAIL must be a dedicated operator account, not one of the RTO test identities');
}
if (operatorEnvironment.email === 'milljanerobinson@gmail.com') {
  throw new Error("E2E_OPERATOR_EMAIL must not be the Product Owner's own account");
}

function base32Decode(input: string): Buffer {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
  let bits = 0; let value = 0; const out: number[] = [];
  for (const ch of input.replace(/=+$/, '')) {
    const idx = alphabet.indexOf(ch);
    if (idx < 0) throw new Error('E2E_OPERATOR_TOTP_SECRET is not valid base32');
    value = (value << 5) | idx; bits += 5;
    if (bits >= 8) { out.push((value >>> (bits - 8)) & 0xff); bits -= 8; }
  }
  return Buffer.from(out);
}

/** RFC 6238 TOTP (SHA-1, 6 digits, 30 seconds) — the Supabase MFA defaults. */
export function totp(secret: string, now = Date.now()): string {
  const counter = Buffer.alloc(8);
  counter.writeBigUInt64BE(BigInt(Math.floor(now / 1000 / 30)));
  const hmac = createHmac('sha1', base32Decode(secret)).update(counter).digest();
  const offset = hmac[hmac.length - 1] & 0x0f;
  const code = (hmac.readUInt32BE(offset) & 0x7fffffff) % 1_000_000;
  return code.toString().padStart(6, '0');
}

export function anonClient(): SupabaseClient {
  return createClient(authenticatedEnvironment.supabaseUrl, authenticatedEnvironment.anonKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
}

export async function signIn(email: string, password: string) {
  const client = anonClient();
  const { data, error } = await client.auth.signInWithPassword({ email, password });
  if (error || !data.session) throw new Error(`Staging identity could not sign in: ${error?.message ?? 'no session'}`);
  return { client, session: data.session };
}

/** Signs the operator in and completes the TOTP step, giving an aal2 session. */
export async function signInOperatorWithMfa() {
  const { client } = await signIn(operatorEnvironment.email, operatorEnvironment.password);
  const { data: factors, error: factorError } = await client.auth.mfa.listFactors();
  const factor = factors?.totp?.find(f => f.status === 'verified');
  if (factorError || !factor) throw new Error('The operator test account has no verified authenticator factor');
  const { error } = await client.auth.mfa.challengeAndVerify({ factorId: factor.id, code: totp(operatorEnvironment.totpSecret) });
  if (error) throw new Error(`Operator MFA verification failed: ${error.message}`);
  const { data } = await client.auth.getSession();
  if (!data.session) throw new Error('Operator session missing after MFA');
  return { client, session: data.session };
}

export async function callOperatorSupport(accessToken: string, body: Record<string, unknown>) {
  const response = await fetch(`${authenticatedEnvironment.supabaseUrl}/functions/v1/operator-support`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${accessToken}`, apikey: authenticatedEnvironment.anonKey, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  return { status: response.status, body: await response.json().catch(() => null) };
}
