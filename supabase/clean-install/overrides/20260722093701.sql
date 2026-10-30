/*
# Clean-install override for migration 20260722093701
# Original file: supabase/migrations/20260722093701_20260722120000_ewo021r6r1_repair_ewo014_7e_lineage.sql.sql
# Original SHA-256: 27723b046fb690e79ba24f0fc4ad7f1076c1add67a83c80e1462363be7d73ba1
# Treatment: environment_specific_data_not_replayed
#
# This file is used ONLY by the clean-install bootstrap
# (scripts/clean-install/bootstrap-database.sh). The historical file above is
# unchanged and remains the record of what ran on the original project.
#
# Original purpose: Repaired the lineage of one specific EIOS integrity alert in the original project and recorded the repair event. The file itself states no schema change was needed.
# Fresh-install failure: INSERT INTO engineering_integrity_reconciliation_events (line 62): foreign key to an engineering integrity alert (65f76fe6...) that exists only in the original project.
#
# Effects retained in a clean install:
#   - none
# Effects not replayed (environment-specific records of the original project):
#   - engineering_integrity_alerts: 2 updates to specific original alerts
#   - engineering_integrity_reconciliation_events: 1 repair event
#   - engineering_change_log: 1 audit row
*/
DO $$ BEGIN RAISE NOTICE 'clean install: 20260722093701 not replayed (environment-specific data of the original project)'; END $$;
