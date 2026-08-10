-- EWO-047R1: Restore canonical EWO allocator so the next genuine ATD-created EWO is EWO-047.
--
-- Pre-conditions verified (all zero):
--   1. No canonical EWO-047 exists in engineering_work_orders.
--   2. No active reservation for EWO-047 in ewo_ref_reservations.
--   3. No canonical alias for EWO-047 in ewo_canonical_ref_aliases.
--   4. No creation in progress for EWO-047 in engineering_change_log.
--
-- The sequence had advanced to 48 (last_value=48, is_called=true) due to
-- diagnostic nextval() calls during state verification. Setting it back
-- to 46 with is_called=true ensures the next nextval() returns 47.
--
-- This operation:
--   - Does not create an EWO.
--   - Does not modify any genuine EWO.
--   - Does not delete audit history.
--   - Does not change application code, RPCs, or governance rules.
--   - Does not reset below 46.

SELECT setval('ewo_canonical_ref_seq', 46, true);
;
