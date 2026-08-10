/*
# BUG-003 — Regression: Restore Product Owner Accepted "Verify All" Behaviour

## 1. Purpose
Registers BUG-003 canonically and adds engineering_classification='Bug'.

## 2. Canonical Registration
Creates BUG-003 before implementation begins.
*/

INSERT INTO engineering_work_orders (
  ewo_ref, title, executive_summary, status, priority, risk_level,
  implementation_provider, implementation_status, engineering_package_status,
  engineering_classification, product_owner, created_at, updated_at
)
SELECT 'BUG-003',
  'BUG-003 — Regression: Restore Product Owner Accepted Verify All Behaviour',
  'Restores the previously accepted Verify All implementation that produces a complete diagnostic report across all verification categories, rather than terminating after the first blocked prerequisite. Identifies and fixes the regression that reintroduced legacy gate-only behaviour.',
  'in_progress', 'high', 'high',
  'bolt', 'In Progress', 'Generated',
  'Bug', 'Millie Robinson', now(), now()
WHERE NOT EXISTS (SELECT 1 FROM engineering_work_orders WHERE ewo_ref = 'BUG-003');


INSERT INTO ewo_lifecycle_events (ewo_id, from_status, to_status, actor, notes, metadata)
SELECT id, null, 'in_progress', 'system',
  'Canonical BUG registered before implementation per BUG-003.',
  jsonb_build_object('source', 'ensure_canonical_creation', 'ewo_ref', 'BUG-003')
FROM engineering_work_orders
WHERE ewo_ref = 'BUG-003'
AND NOT EXISTS (
  SELECT 1 FROM ewo_lifecycle_events ev
  WHERE ev.ewo_id = engineering_work_orders.id
  AND ev.metadata->>'source' = 'ensure_canonical_creation'
);

;
