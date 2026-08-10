/*
# Restore Canonical EWO Numbering Policy

## Purpose
Restore the canonical EWO reference sequence so the next genuine EWO allocated
by ATD continues from the last genuine operational EWO (EWO-046).

## Background
During historical development, automated Bolt testing created canonical EWOs
with refs 047–213. These were identified as test artefacts and removed via
governed remediation (migration 20260730203204). Subsequently, additional
test/validation EWOs were created (214–228) and also deleted.

The PostgreSQL sequence `ewo_canonical_ref_seq` is now at 228, but the highest
genuine operational EWO currently persisted is EWO-046. The 182-value gap
(047–228) was caused entirely by test artefact creation and abandoned
reservations — no genuine engineering work occupies those refs.

## What This Migration Does

### 1. Clean up stale reservation rows
Deletes 3 rows from `ewo_ref_reservations` for refs EWO-223, EWO-224, EWO-225.
- EWO-223: consumed reservation pointing to a deleted EWO (ewo_id no longer exists)
- EWO-224: abandoned reservation, never consumed, no ewo_id
- EWO-225: abandoned reservation, never consumed, no ewo_id

These reservations have a UNIQUE constraint on ewo_ref. Without removing them,
reseeding would cause the next genuine EWO at ref 223/224/225 to collide with
the reservation table's unique constraint.

### 2. Clean up stale conversation binding
Deletes 1 row from `atd_conversation_active_objects` where active_ewo_ref = 'EWO-228'.
This is a stale binding to the deleted validation EWO-228. The table has a UNIQUE
constraint on conversation_id, not on active_ewo_ref, so this is a data cleanup
rather than a reseed blocker.

### 3. Clean up stale conversation association
Deletes 1 row from `engineering_conversation_associations` where ewo_ref = 'EWO-225'.
This is a stale association to an abandoned reservation. The row has ewo_id = NULL
and is not referenced by any superseded_by FK.

### 4. Reset the sequence
Sets `ewo_canonical_ref_seq` to 46 with is_called = true, so the next nextval()
returns 47.

## What This Migration Does NOT Do
- Does NOT delete or modify any genuine EWO in engineering_work_orders
- Does NOT delete or modify any row in engineering_change_log (audit trail preserved)
- Does NOT delete or modify any row in ewo_creation_attempt_log (audit trail preserved)
- Does NOT delete or modify any row in ewo_deletion_audit (audit trail preserved)
- Does NOT delete or modify any row in conversation_routing_diagnostics (diagnostic log preserved)
- Does NOT delete or modify any row in po_acceptance_governance_log (audit trail preserved)
- Does NOT delete or modify any row in po_acceptance_governance_tokens (audit trail preserved)
- Does NOT delete or modify any row in eios_conversation_audit (audit trail preserved)
- Does NOT modify the RPC, the allowlist, or any governance validation
- Does NOT modify any RLS policy
- Does NOT create any new EWO

## Safety Verification (performed before this migration)
- engineering_work_orders: 0 rows with numeric refs 47–228 (confirmed)
- engineering_historical_references: 0 rows with numeric refs 47–228 (confirmed)
- ewo_canonical_ref_aliases: 0 rows with former_ref or corrected_ref in 47–228 (confirmed)
- execution_locks: 0 rows with ewo_ref in 47–228 (confirmed)
- github_execution_evidence: 0 rows with ewo_ref in 47–228 (confirmed)
- All other tables with ewo_ref columns: 0 rows with numeric refs 47–228 (confirmed)
- Audit/log tables have no UNIQUE constraint on ewo_ref (confirmed)
- The only UNIQUE constraints on ewo_ref are on engineering_work_orders,
  ewo_ref_reservations, execution_locks, and github_execution_evidence

## Important Notes
1. EWO-900 (historical import) is preserved — it is outside the reseed range.
2. All genuine EWOs (EWO-001 through EWO-046) are preserved — they are below the reseed target.
3. Audit trail integrity is maintained — all log/audit tables retain their rows.
4. The sequence is NO CYCLE — it will never wrap around to reuse a number.
*/

-- ─── 1. Remove stale reservation rows ───
-- These 3 reservations are the only rows in ewo_ref_reservations with numeric
-- refs in the reseed range (47–228). All reference deleted/abandoned EWOs.
-- The UNIQUE constraint on ewo_ref_reservations.ewo_ref would block reseed.
DELETE FROM ewo_ref_reservations
WHERE ewo_ref IN ('EWO-223', 'EWO-224', 'EWO-225');


-- ─── 2. Remove stale conversation binding to deleted validation EWO-228 ───
-- This is a data cleanup, not a reseed blocker (no UNIQUE on active_ewo_ref).
-- The EWO-228 has been deleted from engineering_work_orders;
 this binding is stale.
DELETE FROM atd_conversation_active_objects
WHERE active_ewo_ref = 'EWO-228';


-- ─── 3. Remove stale conversation association to abandoned reservation EWO-225 ───
-- The row has ewo_id = NULL (never linked to a real EWO) and is not referenced
-- by any superseded_by FK.
DELETE FROM engineering_conversation_associations
WHERE ewo_ref = 'EWO-225';


-- ─── 4. Reset the sequence to 46 (is_called = true) ───
-- The next nextval() call will return 47, continuing from the last genuine
-- operational EWO (EWO-046).
SELECT setval('ewo_canonical_ref_seq', 46, true);

;
