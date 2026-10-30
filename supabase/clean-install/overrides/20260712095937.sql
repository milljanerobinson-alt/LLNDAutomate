/*
# Clean-install override for migration 20260712095937
# Original file: supabase/migrations/20260712095937_20260712_ewo009_1_memory_seed_canonical.sql
# Original SHA-256: 5e8f3251c0d2871e1093d8b8dfb233ed4597cf8ce8a6fd66144ef1f12aad83bd
# Treatment: environment_specific_data_not_replayed
#
# This file is used ONLY by the clean-install bootstrap
# (scripts/clean-install/bootstrap-database.sh). The historical file above is
# unchanged and remains the record of what ran on the original project.
#
# Original purpose: Seeded 33 EIOS engineering-memory entries and lineage links describing engineering records that existed only in the original project.
# Fresh-install failure: INSERT INTO engineering_memory inside the DO block (lines 19-223; error reported at line 223): foreign key engineering_memory_record_id_fkey. The rows reference engineering_records_library records (BATCH-A, BUG-BF-001, ERC-001 ... EWO-007R.1) that no migration creates.
#
# Effects retained in a clean install:
#   - none
# Effects not replayed (environment-specific records of the original project):
#   - engineering_memory: 33 knowledge rows
#   - engineering_record_lineage: delete + insert of lineage links
#   - engineering_records_library: engineering_memory_extracted flag update
*/
DO $$ BEGIN RAISE NOTICE 'clean install: 20260712095937 not replayed (environment-specific data of the original project)'; END $$;
