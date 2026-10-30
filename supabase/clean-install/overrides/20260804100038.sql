/*
# Clean-install override for migration 20260804100038
# Original file: supabase/migrations/20260804100038_ewo047r4_restore_conversation_association.sql.sql
# Original SHA-256: 0275634a712c6ce47cfe2d88a89d1b92f24aead08e9a9c40bada442c700073e3
# Treatment: environment_specific_data_not_replayed
#
# This file is used ONLY by the clean-install bootstrap
# (scripts/clean-install/bootstrap-database.sh). The historical file above is
# unchanged and remains the record of what ran on the original project.
#
# Original purpose: Restored one EIOS conversation association (conversation 208bd22f-...) in the original project.
# Fresh-install failure: INSERT INTO engineering_conversation_associations (line 18): foreign key to an EWO-047 conversation/work order that exists only in the original project.
#
# Effects retained in a clean install:
#   - none
# Effects not replayed (environment-specific records of the original project):
#   - engineering_conversation_associations: 1 row
*/
DO $$ BEGIN RAISE NOTICE 'clean install: 20260804100038 not replayed (environment-specific data of the original project)'; END $$;
