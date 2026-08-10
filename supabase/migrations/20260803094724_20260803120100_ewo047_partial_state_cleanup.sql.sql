/*
# EWO-047 — Partial Approval State Cleanup

## Purpose
Reverts EWO-047 to a clean pre-approval state after a failed approval
attempt left partial state across three tables.

The failed approval attempt:
1. INSERTed an ewo_execution_approvals record (succeeded)
2. UPDATEd engineering_executions.po_status to 'approved' (succeeded)
3. Attempted to UPDATE engineering_work_orders.status to 'approved' (FAILED —
   'approved' is not permitted by engineering_work_orders_status_check)
4. Skipped the ewo_lifecycle_events INSERT (blocker added)
5. INSERTed an engineering_change_log record (succeeded — inaccurate)

Additionally, the prepare step had incorrectly transitioned the EWO from
'ready' to 'po_acceptance' (a post-implementation state). This migration
reverts that defective transition.

## Changes
1. Revert engineering_work_orders.status from 'po_acceptance' to 'ready'
2. Delete the defective lifecycle event: ready → po_acceptance
3. Reset engineering_executions.po_status to 'pending', po_decided_at to null
4. Delete the partial ewo_execution_approvals record
5. Delete the inaccurate engineering_change_log record (requires temporarily
   disabling the immutability trigger, then re-enabling it)

## Preserved
- EWO-047 itself
- Its prepared Execution Request (19b1da3a-...)
- Repository/provider/branch metadata
- The successful preparation audit
- The EWO creation audit
- All unrelated lifecycle and audit records

## Safety
- All changes are scoped to EWO-047 by ewo_ref or specific IDs
- Idempotent — safe to re-run
- The immutability trigger is re-enabled immediately after the corrective delete
- No data loss beyond the defective partial state
*/

-- 1. Revert EWO-047 status from po_acceptance to ready
UPDATE engineering_work_orders
SET status = 'ready',
    updated_at = now()
WHERE ewo_ref = 'EWO-047'
  AND status = 'po_acceptance';


-- 2. Delete the defective lifecycle event: ready → po_acceptance
DELETE FROM ewo_lifecycle_events
WHERE ewo_id = (SELECT id FROM engineering_work_orders WHERE ewo_ref = 'EWO-047')
  AND from_status = 'ready'
  AND to_status = 'po_acceptance';


-- 3. Reset Execution Request po_status to pending
UPDATE engineering_executions
SET po_status = 'pending',
    po_decided_at = null,
    updated_at = now()
WHERE id = '19b1da3a-773e-45fb-8e98-3339ba012134'
  AND po_status = 'approved';


-- 4. Delete the partial approval record
DELETE FROM ewo_execution_approvals
WHERE id = '8e5c6dfd-ac6e-4843-9163-3da4cef2efa2';


-- 5. Delete the inaccurate approval change-log record
--    The immutability trigger must be temporarily disabled for this
--    corrective operation, then immediately re-enabled.
ALTER TABLE engineering_change_log DISABLE TRIGGER prevent_ecl_delete;


DELETE FROM engineering_change_log
WHERE change_ref = 'EWO037R2-PREP-1785749239259-ml0ixy';


ALTER TABLE engineering_change_log ENABLE TRIGGER prevent_ecl_delete;

;
