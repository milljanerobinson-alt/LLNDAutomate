-- EWO-032R.9: Codex Secret Vault
--
-- Secure storage for the raw OpenAI API key used by the governed Codex
-- Execution Provider. The raw key is encrypted client-side (in the edge
-- function) using AES-GCM with a key derived from the service role key
-- via HKDF-SHA256. Only the ciphertext, IV, and salt are persisted here.
--
-- RLS is enabled with NO policies: anon and authenticated roles are denied
-- all access. Only the service role (which bypasses RLS) can read/write.
-- This guarantees the raw key is never reachable from the frontend or
-- anon-key clients.

CREATE TABLE IF NOT EXISTS codex_secret_vault (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  credential_ref text UNIQUE NOT NULL,
  environment text NOT NULL DEFAULT 'staging',
  ciphertext bytea NOT NULL,
  iv bytea NOT NULL,
  salt bytea NOT NULL,
  is_current boolean NOT NULL DEFAULT true,
  created_at timestamptz DEFAULT now(),
  rotated_from text,
  rotated_at timestamptz
);


ALTER TABLE codex_secret_vault ENABLE ROW LEVEL SECURITY;


-- No policies: deny all access to anon and authenticated.
-- Only the service role (bypasses RLS) can access this table.

CREATE INDEX IF NOT EXISTS idx_codex_vault_env ON codex_secret_vault(environment);

CREATE INDEX IF NOT EXISTS idx_codex_vault_current ON codex_secret_vault(is_current) WHERE is_current = true;

CREATE INDEX IF NOT EXISTS idx_codex_vault_ref ON codex_secret_vault(credential_ref);

;
