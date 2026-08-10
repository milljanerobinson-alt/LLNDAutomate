-- EWO-045R1: Close out EWO-044, register EWO-045, and create legacy endpoint defect EWO-046

-- ============================================================================
-- EWO-044: Engineering Completion Record + Product Owner Acceptance
-- ============================================================================
INSERT INTO engineering_work_orders (
  ewo_ref,
  title,
  executive_summary,
  engineering_objective,
  priority,
  status,
  implementation_status,
  implementation_provider,
  implementation_source,
  implementation_started_at,
  implementation_completed_at,
  implementation_summary,
  verification_status,
  po_accepted_at,
  po_accepted_by,
  po_acceptance_statement,
  po_acceptance_notes,
  po_testing_status,
  po_testing_completed_at,
  completion_report_status,
  product_owner_verification_status,
  closed_at,
  closed_by,
  closure_reason,
  closure_method,
  closure_eligible,
  created_at,
  updated_at
) VALUES (
  'EWO-044',
  'EIOS Tenant Infrastructure and RLS Model',
  'Established EIOS tenant infrastructure, added ownership columns, replaced EWO RLS with tenant model, and backfilled all genuine EWOs.',
  'Create tenant infrastructure, add ownership columns, replace RLS, and backfill genuine EWOs.',
  'high',
  'closed',
  'complete',
  'bolt',
  'bolt',
  '2026-07-30T00:00:00Z',
  '2026-07-31T02:35:00Z',
  'Created eios_tenant_infrastructure table, added tenant_id and project_id ownership columns to engineering_work_orders, replaced EWO RLS policies with tenant-scoped model, updated create_canonical_ewo governed RPC, and backfilled all genuine EWOs with canonical tenant and project IDs.',
  'verified',
  '2026-07-31T00:00:00Z',
  'product-owner',
  'Product Owner accepts EWO-044 as complete. Tenant infrastructure, ownership columns, RLS replacement, and EWO backfill all verified.',
  'Live validation confirmed tenant-scoped EWO queries return correct results.',
  'passed',
  '2026-07-31T00:00:00Z',
  '{"status":"generated"}'::jsonb,
  'accepted',
  '2026-07-31T00:00:00Z',
  'product-owner',
  'Engineering complete and Product Owner accepted',
  'Product Owner Acceptance',
  true,
  NOW(),
  NOW()
) ON CONFLICT (ewo_ref) DO UPDATE SET
  status = 'closed',
  implementation_status = 'complete',
  po_accepted_at = '2026-07-31T00:00:00Z',
  po_accepted_by = 'product-owner',
  po_acceptance_statement = 'Product Owner accepts EWO-044 as complete. Tenant infrastructure, ownership columns, RLS replacement, and EWO backfill all verified.',
  po_testing_status = 'passed',
  po_testing_completed_at = '2026-07-31T00:00:00Z',
  product_owner_verification_status = 'accepted',
  closed_at = '2026-07-31T00:00:00Z',
  closed_by = 'product-owner',
  closure_reason = 'Engineering complete and Product Owner accepted',
  closure_method = 'Product Owner Acceptance',
  closure_eligible = true,
  updated_at = NOW();


-- ============================================================================
-- EWO-045: Governed Repository Intelligence for Codex
-- ============================================================================
INSERT INTO engineering_work_orders (
  ewo_ref,
  title,
  executive_summary,
  engineering_objective,
  priority,
  status,
  implementation_status,
  parent_ref,
  implementation_provider,
  implementation_source,
  created_at,
  updated_at
) VALUES (
  'EWO-045',
  'Governed Repository Intelligence for Codex',
  'Establish governed repository intelligence pipeline that searches, reads, and inspects the canonical GitHub repository through provider-native tool calls.',
  'Implement repository tools (search, read, tree, history, diff, architecture records, cross-reference) with governed audit and protected-file enforcement.',
  'high',
  'in_progress',
  'in_progress',
  'EWO-044',
  'bolt',
  'bolt',
  NOW(),
  NOW()
) ON CONFLICT (ewo_ref) DO NOTHING;


-- ============================================================================
-- EWO-046: Legacy Endpoint Migration (command-centre-ai -> atd-conversation-gateway)
-- ============================================================================
INSERT INTO engineering_work_orders (
  ewo_ref,
  title,
  executive_summary,
  engineering_objective,
  priority,
  risk_level,
  status,
  implementation_status,
  parent_ref,
  scope,
  out_of_scope,
  engineering_notes,
  created_at,
  updated_at
) VALUES (
  'EWO-046',
  'Migrate ECCFeatureDetailPanel legacy command-centre-ai endpoint to atd-conversation-gateway',
  'src/pages/ecc/ECCFeatureDetailPanel.tsx line 1465 still contains a live production fetch to the legacy command-centre-ai edge function. This must be migrated to atd-conversation-gateway to complete the endpoint unification.',
  'Replace the command-centre-ai fetch call in ECCFeatureDetailPanel.tsx with a call to atd-conversation-gateway, ensuring the request/response contract is compatible.',
  'medium',
  'medium',
  'engineering_approved',
  'pending',
  'EWO-045',
  'Migrate the fetch call in ECCFeatureDetailPanel.tsx from command-centre-ai to atd-conversation-gateway. Verify the conversation gateway accepts the same request shape or adapt the payload.',
  'Do not change the UI behaviour or feature detail panel rendering logic. Do not remove the command-centre-ai edge function in this EWO.',
  'Identified during EWO-045R1 repository inspection. The legacy endpoint was missed during the original conversation gateway unification. The file is at src/pages/ecc/ECCFeatureDetailPanel.tsx line 1465.',
  NOW(),
  NOW()
) ON CONFLICT (ewo_ref) DO NOTHING;

;
