-- EWO-047R: Permit 'warning' outcome on atd_connect_inspection_log
-- The conversation gateway records outcome='warning' when a repository
-- question is answered without repository evidence but the underlying
-- request still produced a valid partial result. The existing CHECK
-- constraint rejected this value (PostgreSQL error 23514).
-- This migration replaces the constraint with an equivalent one that
-- also permits 'warning'. All existing permitted values are preserved.

ALTER TABLE atd_connect_inspection_log
  DROP CONSTRAINT IF EXISTS atd_connect_inspection_log_outcome_check;


ALTER TABLE atd_connect_inspection_log
  ADD CONSTRAINT atd_connect_inspection_log_outcome_check
  CHECK (outcome = ANY (ARRAY[
    'success'::text,
    'error'::text,
    'governed_empty'::text,
    'governed_refusal'::text,
    'unresolved'::text,
    'warning'::text
  ]));
;
