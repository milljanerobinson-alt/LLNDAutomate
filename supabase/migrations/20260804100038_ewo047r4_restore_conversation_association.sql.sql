-- EWO-047R4: Restore EWO-047 conversation association
-- The originating conversation ID is confirmed as 208bd22f-e413-45ff-99ac-ce22c02337e8
-- from the execution request metadata and the atd_conversation_active_objects record.
-- This restores the canonical association that was lost during execution cleanup.

INSERT INTO engineering_conversation_associations (conversation_id, ewo_ref, is_canonical, user_id, lifecycle_stage)
SELECT
  '208bd22f-e413-45ff-99ac-ce22c02337e8',
  'EWO-047',
  true,
  '8f4e2782-262d-4066-8c84-6da19025db84',
  'execution_in_progress'
WHERE NOT EXISTS (
  SELECT 1 FROM engineering_conversation_associations
  WHERE conversation_id = '208bd22f-e413-45ff-99ac-ce22c02337e8'
    AND ewo_ref = 'EWO-047'
    AND is_canonical = true
);

;
