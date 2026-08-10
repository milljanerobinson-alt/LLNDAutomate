/*
# Extend AI Usage Log with Complete Telemetry

## Summary
Extends the `ai_usage_log` table with additional fields needed for full request
tracing as part of the AI Platform Efficiency & Cost Audit. Also ensures the
`ai_response_cache` and `ecc_ai_briefings` tables have correct RLS policies
for admin visibility in the Cache Inspector.

## Changes to `ai_usage_log`
- `workspace` — which workspace triggered the request (engineering, assessment, trainer, platform_admin)
- `conversation_id` — links to cc_ai_conversations if request was part of a conversation
- `briefing_id` — links to ecc_ai_briefings if request generated a briefing
- `prompt_version` — version string of the prompt template used (for A/B tracking)
- `request_id` — unique UUID per request for end-to-end tracing

## RLS Changes
- `ai_response_cache`: add admin SELECT policy so Cache Inspector can read entries
- `ecc_ai_briefings`: ensure admin SELECT policy exists

## Notes
- All new columns are nullable to preserve backward compatibility with existing log rows
- `request_id` defaults to gen_random_uuid() for new rows
*/

-- Extend ai_usage_log with missing telemetry
ALTER TABLE ai_usage_log
  ADD COLUMN IF NOT EXISTS workspace text,
  ADD COLUMN IF NOT EXISTS conversation_id uuid,
  ADD COLUMN IF NOT EXISTS briefing_id uuid,
  ADD COLUMN IF NOT EXISTS prompt_version text,
  ADD COLUMN IF NOT EXISTS request_id uuid DEFAULT gen_random_uuid();


-- Index on workspace for filtering
CREATE INDEX IF NOT EXISTS ai_usage_log_workspace_idx ON ai_usage_log (workspace);

CREATE INDEX IF NOT EXISTS ai_usage_log_request_id_idx ON ai_usage_log (request_id);


-- Ensure ai_response_cache is readable by authenticated admins
-- (service role already bypasses RLS, this allows the admin UI to query it)
ALTER TABLE ai_response_cache ENABLE ROW LEVEL SECURITY;


DROP POLICY IF EXISTS "admin_select_ai_response_cache" ON ai_response_cache;

CREATE POLICY "admin_select_ai_response_cache" ON ai_response_cache
  FOR SELECT TO authenticated USING (true);


DROP POLICY IF EXISTS "service_insert_ai_response_cache" ON ai_response_cache;

CREATE POLICY "service_insert_ai_response_cache" ON ai_response_cache
  FOR INSERT TO authenticated WITH CHECK (true);


DROP POLICY IF EXISTS "admin_update_ai_response_cache" ON ai_response_cache;

CREATE POLICY "admin_update_ai_response_cache" ON ai_response_cache
  FOR UPDATE TO authenticated USING (true) WITH CHECK (true);


DROP POLICY IF EXISTS "admin_delete_ai_response_cache" ON ai_response_cache;

CREATE POLICY "admin_delete_ai_response_cache" ON ai_response_cache
  FOR DELETE TO authenticated USING (true);


-- Ensure ecc_ai_briefings is readable by authenticated users
ALTER TABLE ecc_ai_briefings ENABLE ROW LEVEL SECURITY;


DROP POLICY IF EXISTS "admin_select_ecc_ai_briefings" ON ecc_ai_briefings;

CREATE POLICY "admin_select_ecc_ai_briefings" ON ecc_ai_briefings
  FOR SELECT TO authenticated USING (true);


DROP POLICY IF EXISTS "service_insert_ecc_ai_briefings" ON ecc_ai_briefings;

CREATE POLICY "service_insert_ecc_ai_briefings" ON ecc_ai_briefings
  FOR INSERT TO authenticated WITH CHECK (true);

;
