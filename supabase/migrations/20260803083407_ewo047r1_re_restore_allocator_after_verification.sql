-- EWO-047R1: Re-restore canonical EWO allocator after verification nextval() consumed 47.
-- The prior verification nextval() advanced the sequence to 47 (is_called=true).
-- Setting back to 46 with is_called=true so the next genuine nextval() returns 47.
-- No EWO created, no genuine EWO modified, no audit history deleted.

SELECT setval('ewo_canonical_ref_seq', 46, true);
;
