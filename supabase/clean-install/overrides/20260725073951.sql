/*
# Clean-install override for migration 20260725073951
# Original file: supabase/migrations/20260725073951_20260725070502_ewo028_phase_closeout.sql.sql
# Original SHA-256: b2a13490e38560ce072e7c7201b3222680812d4482b402b52d257028735affb0
# Treatment: environment_specific_data_not_replayed
#
# This file is used ONLY by the clean-install bootstrap
# (scripts/clean-install/bootstrap-database.sh). The historical file above is
# unchanged and remains the record of what ran on the original project.
#
# Original purpose: Second copy of the EWO-028 closeout data (without the constraint change). Data only.
# Fresh-install failure: INSERT INTO lifecycle_reconciliation_log (line 317): same foreign key failure as 20260725073902.
#
# Effects retained in a clean install:
#   - none
# Effects not replayed (environment-specific records of the original project):
#   - Same EWO-028 closeout, acceptance, knowledge-extraction and reconciliation rows as 20260725073902
*/
DO $$ BEGIN RAISE NOTICE 'clean install: 20260725073951 not replayed (environment-specific data of the original project)'; END $$;
