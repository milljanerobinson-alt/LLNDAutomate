/*
# Add 'cancelled' status to axcelerate_inbound_sync_log

Allows manually-deleted invitations to be permanently suppressed from re-sync.
When an admin deletes an invitation, the sync log is marked 'cancelled' instead
of being deleted. The inbound sync will skip any contact whose log row is 'cancelled',
preventing the bulk sync from recreating invitations the admin deliberately removed.
*/

ALTER TABLE axcelerate_inbound_sync_log
  DROP CONSTRAINT IF EXISTS axcelerate_inbound_sync_log_status_check;


ALTER TABLE axcelerate_inbound_sync_log
  ADD CONSTRAINT axcelerate_inbound_sync_log_status_check
  CHECK (status IN ('pending', 'processing', 'skipped', 'created', 'failed', 'cancelled'));


-- Also add an UPDATE policy so the frontend can mark rows cancelled
DROP POLICY IF EXISTS "inbound_sync_log_update_staff" ON axcelerate_inbound_sync_log;

CREATE POLICY "inbound_sync_log_update_staff" ON axcelerate_inbound_sync_log
  FOR UPDATE TO authenticated
  USING (EXISTS (SELECT 1 FROM profiles p WHERE p.id = auth.uid() AND p.role IN ('admin','trainer')))
  WITH CHECK (EXISTS (SELECT 1 FROM profiles p WHERE p.id = auth.uid() AND p.role IN ('admin','trainer')));

;
