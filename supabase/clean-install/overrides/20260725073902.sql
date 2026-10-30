/*
# Clean-install override for migration 20260725073902
# Original file: supabase/migrations/20260725073902_20260725070500_ewo028_phase_closeout.sql.sql
# Original SHA-256: f9acf759cbb83f10e5cc1e9a63c4d413bf7841c4351c9d033e339b29222b9227
# Treatment: schema_effects_only
#
# This file is used ONLY by the clean-install bootstrap
# (scripts/clean-install/bootstrap-database.sh). The historical file above is
# unchanged and remains the record of what ran on the original project.
#
# Original purpose: Added the "correction" reconciliation type, then closed out EWO-028 with completion reports, Product Owner acceptance and knowledge-extraction records from the original project.
# Fresh-install failure: INSERT INTO lifecycle_reconciliation_log (line 345): foreign key to EWO-017R.2R / reconciliation records that exist only in the original project.
#
# Effects retained in a clean install:
#   - lifecycle_reconciliation_log_reconciliation_type_check constraint now allows "correction" (identical to 20260725073913, which also applies it)
# Effects not replayed (environment-specific records of the original project):
#   - engineering_work_orders: register EWO-028R.1 / R.2 and close EWO-028
#   - ewo_completion_reports, ewo_lifecycle_events: closeout and Product Owner acceptance records
#   - engineering_knowledge_extractions, engineering_knowledge_provenance, engineering_memory, engineering_records_library: knowledge extraction
#   - lifecycle_reconciliation_log, engineering_change_log: reconciliation correction and audit rows
*/
-- Verbatim from the original file:

-- ═══ PART 0: Alter reconciliation_type check constraint ═══

ALTER TABLE lifecycle_reconciliation_log DROP CONSTRAINT IF EXISTS lifecycle_reconciliation_log_reconciliation_type_check;

ALTER TABLE lifecycle_reconciliation_log ADD CONSTRAINT lifecycle_reconciliation_log_reconciliation_type_check
  CHECK (reconciliation_type = ANY (ARRAY['post_acceptance_closure'::text, 'historical_reconciliation'::text, 'correction'::text]));
