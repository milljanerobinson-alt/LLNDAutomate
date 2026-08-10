/*
# EWO-014.8 — Engineering Action Verification Standard (EVS-002)

## Purpose

Introduces EVS-002 as a constitutional engineering standard. Every engineering
action performed inside EIOS must produce independent, objective verification
evidence before it is considered complete. This migration creates the database
foundation: the engineering action log, verification methods registry, and
seeds the constitutional standard.

## New Tables

### 1. engineering_action_log
Immutable log of every engineering action with its verification lifecycle.
- id (uuid PK)
- action_ref (text UNIQUE) — e.g. 'ACT-20260716-001'
- ewo_id (uuid FK→engineering_work_orders, nullable) — linked EWO if applicable
- ewo_ref (text, nullable) — denormalised for display
- action_type (text) — 'database'|'file'|'api'|'ui'|'process'|'deployment'|'migration'|'custom'
- action_title (text) — human-readable description
- action_context (jsonb) — structured context
- status (text) — 'requested'|'attempted'|'verified'|'failed_verification'
- started_at, completed_at (timestamptz)
- verification_type, verification_result, verification_evidence, verified_by, verified_at
- failure_reason (text, nullable)
- confidence (numeric(3,2), nullable) — 0.00–1.00
- retry_count (integer, default 0)
- metadata (jsonb)
- timestamps

### 2. engineering_verification_methods
Registry of verification method definitions — extensible for future providers.
- method_key (text UNIQUE)
- method_type, name, description, evidence_schema (jsonb)
- is_automated, provider_name, is_active, sort_order
- timestamps

## Security

- RLS enabled on both tables.
- engineering_action_log: SELECT + INSERT + UPDATE only (no DELETE — immutability).
- engineering_verification_methods: full CRUD.

## Seeding

- Seeds 12 verification method definitions covering all 6 core types.
- Seeds EVS-002 as CONST-001-AMD-004 in constitutional_documents (8 sections).
- Seeds EVS-002 in ecc_engineering_standards.

## Important Notes

1. Action log is append-only (no DELETE) to preserve audit integrity.
2. Status transitions: requested → attempted → verified | failed_verification.
3. Future verification providers supported by adding rows to registry — no schema change.
*/

-- ═══════════════════════════════════════════════════════════════════════
-- 1. ENGINEERING ACTION LOG
-- ═══════════════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS engineering_action_log (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  action_ref            text UNIQUE NOT NULL,
  ewo_id                uuid REFERENCES engineering_work_orders(id) ON DELETE SET NULL,
  ewo_ref               text,
  action_type           text NOT NULL DEFAULT 'custom',
  action_title          text NOT NULL,
  action_context        jsonb NOT NULL DEFAULT '{}'::jsonb,
  status                text NOT NULL DEFAULT 'requested',
  started_at            timestamptz NOT NULL DEFAULT now(),
  completed_at          timestamptz,
  verification_type    text,
  verification_result   text,
  verification_evidence jsonb,
  verified_by           text,
  verified_at           timestamptz,
  failure_reason        text,
  confidence            numeric(3,2),
  retry_count           integer NOT NULL DEFAULT 0,
  metadata              jsonb DEFAULT '{}'::jsonb,
  created_at            timestamptz NOT NULL DEFAULT now(),
  updated_at            timestamptz NOT NULL DEFAULT now()
);


ALTER TABLE engineering_action_log ENABLE ROW LEVEL SECURITY;


DROP POLICY IF EXISTS "select_action_log_authenticated" ON engineering_action_log;

CREATE POLICY "select_action_log_authenticated"
  ON engineering_action_log FOR SELECT
  TO authenticated USING (true);


DROP POLICY IF EXISTS "insert_action_log_authenticated" ON engineering_action_log;

CREATE POLICY "insert_action_log_authenticated"
  ON engineering_action_log FOR INSERT
  TO authenticated WITH CHECK (true);


DROP POLICY IF EXISTS "update_action_log_authenticated" ON engineering_action_log;

CREATE POLICY "update_action_log_authenticated"
  ON engineering_action_log FOR UPDATE
  TO authenticated USING (true) WITH CHECK (true);


-- No DELETE policy — immutability enforced at RLS level.

CREATE INDEX IF NOT EXISTS idx_action_log_ewo_id ON engineering_action_log(ewo_id);

CREATE INDEX IF NOT EXISTS idx_action_log_status ON engineering_action_log(status);

CREATE INDEX IF NOT EXISTS idx_action_log_action_type ON engineering_action_log(action_type);

CREATE INDEX IF NOT EXISTS idx_action_log_started_at ON engineering_action_log(started_at DESC);


-- ═══════════════════════════════════════════════════════════════════════
-- 2. VERIFICATION METHODS REGISTRY
-- ═══════════════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS engineering_verification_methods (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  method_key      text UNIQUE NOT NULL,
  method_type     text NOT NULL,
  name            text NOT NULL,
  description     text,
  evidence_schema jsonb DEFAULT '{}'::jsonb,
  is_automated    boolean NOT NULL DEFAULT false,
  provider_name   text,
  is_active       boolean NOT NULL DEFAULT true,
  sort_order      integer NOT NULL DEFAULT 0,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now()
);


ALTER TABLE engineering_verification_methods ENABLE ROW LEVEL SECURITY;


DROP POLICY IF EXISTS "select_verification_methods_authenticated" ON engineering_verification_methods;

CREATE POLICY "select_verification_methods_authenticated"
  ON engineering_verification_methods FOR SELECT
  TO authenticated USING (true);


DROP POLICY IF EXISTS "insert_verification_methods_authenticated" ON engineering_verification_methods;

CREATE POLICY "insert_verification_methods_authenticated"
  ON engineering_verification_methods FOR INSERT
  TO authenticated WITH CHECK (true);


DROP POLICY IF EXISTS "update_verification_methods_authenticated" ON engineering_verification_methods;

CREATE POLICY "update_verification_methods_authenticated"
  ON engineering_verification_methods FOR UPDATE
  TO authenticated USING (true) WITH CHECK (true);


DROP POLICY IF EXISTS "delete_verification_methods_authenticated" ON engineering_verification_methods;

CREATE POLICY "delete_verification_methods_authenticated"
  ON engineering_verification_methods FOR DELETE
  TO authenticated USING (true);


-- ═══════════════════════════════════════════════════════════════════════
-- 3. SEED VERIFICATION METHODS
-- ═══════════════════════════════════════════════════════════════════════

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM engineering_verification_methods WHERE method_key = 'database_record_exists') THEN
    INSERT INTO engineering_verification_methods (method_key, method_type, name, description, evidence_schema, is_automated, sort_order)
    VALUES ('database_record_exists', 'database', 'Database Record Exists',
            'Verifies that a specific record exists in a database table by primary key or filter.',
            '{"table":"text","filter":"jsonb","expected_count":"integer"}'::jsonb, true, 1);

  END IF;


  IF NOT EXISTS (SELECT 1 FROM engineering_verification_methods WHERE method_key = 'database_record_updated') THEN
    INSERT INTO engineering_verification_methods (method_key, method_type, name, description, evidence_schema, is_automated, sort_order)
    VALUES ('database_record_updated', 'database', 'Database Record Updated',
            'Verifies that a record was updated by checking column values and updated_at timestamp.',
            '{"table":"text","filter":"jsonb","expected_columns":"text[]","timestamp_changed":"boolean"}'::jsonb, true, 2);

  END IF;


  IF NOT EXISTS (SELECT 1 FROM engineering_verification_methods WHERE method_key = 'database_row_count') THEN
    INSERT INTO engineering_verification_methods (method_key, method_type, name, description, evidence_schema, is_automated, sort_order)
    VALUES ('database_row_count', 'database', 'Database Row Count',
            'Verifies the correct number of rows match an expected count.',
            '{"table":"text","filter":"jsonb","expected_count":"integer","actual_count":"integer"}'::jsonb, true, 3);

  END IF;


  IF NOT EXISTS (SELECT 1 FROM engineering_verification_methods WHERE method_key = 'file_exists') THEN
    INSERT INTO engineering_verification_methods (method_key, method_type, name, description, evidence_schema, is_automated, sort_order)
    VALUES ('file_exists', 'file', 'File Exists',
            'Verifies that a file exists at the specified path.',
            '{"path":"text","exists":"boolean"}'::jsonb, true, 10);

  END IF;


  IF NOT EXISTS (SELECT 1 FROM engineering_verification_methods WHERE method_key = 'file_hash') THEN
    INSERT INTO engineering_verification_methods (method_key, method_type, name, description, evidence_schema, is_automated, sort_order)
    VALUES ('file_hash', 'file', 'File Hash Verification',
            'Verifies file integrity by generating and comparing a hash.',
            '{"path":"text","hash_algorithm":"text","hash_value":"text","file_size":"bigint"}'::jsonb, true, 11);

  END IF;


  IF NOT EXISTS (SELECT 1 FROM engineering_verification_methods WHERE method_key = 'api_http_status') THEN
    INSERT INTO engineering_verification_methods (method_key, method_type, name, description, evidence_schema, is_automated, sort_order)
    VALUES ('api_http_status', 'api', 'API HTTP Status Check',
            'Verifies an API endpoint returns the expected HTTP status code.',
            '{"url":"text","method":"text","expected_status":"integer","actual_status":"integer","response_body":"jsonb"}'::jsonb, true, 20);

  END IF;


  IF NOT EXISTS (SELECT 1 FROM engineering_verification_methods WHERE method_key = 'api_response_object') THEN
    INSERT INTO engineering_verification_methods (method_key, method_type, name, description, evidence_schema, is_automated, sort_order)
    VALUES ('api_response_object', 'api', 'API Response Object Verification',
            'Verifies an API response contains expected object fields and values.',
            '{"url":"text","expected_fields":"text[]","actual_response":"jsonb","retry_count":"integer"}'::jsonb, true, 21);

  END IF;


  IF NOT EXISTS (SELECT 1 FROM engineering_verification_methods WHERE method_key = 'ui_page_renders') THEN
    INSERT INTO engineering_verification_methods (method_key, method_type, name, description, evidence_schema, is_automated, sort_order)
    VALUES ('ui_page_renders', 'ui', 'UI Page Renders',
            'Verifies that a page renders without errors and key controls are visible.',
            '{"route":"text","renders":"boolean","controls_visible":"text[]","values_displayed":"jsonb"}'::jsonb, false, 30);

  END IF;


  IF NOT EXISTS (SELECT 1 FROM engineering_verification_methods WHERE method_key = 'ui_control_visible') THEN
    INSERT INTO engineering_verification_methods (method_key, method_type, name, description, evidence_schema, is_automated, sort_order)
    VALUES ('ui_control_visible', 'ui', 'UI Control Visible',
            'Verifies that a specific UI control is visible and displays the expected value.',
            '{"route":"text","control_selector":"text","visible":"boolean","displayed_value":"text"}'::jsonb, false, 31);

  END IF;


  IF NOT EXISTS (SELECT 1 FROM engineering_verification_methods WHERE method_key = 'process_queue_completed') THEN
    INSERT INTO engineering_verification_methods (method_key, method_type, name, description, evidence_schema, is_automated, sort_order)
    VALUES ('process_queue_completed', 'process', 'Process Queue Completed',
            'Verifies a background queue has been fully processed.',
            '{"queue_name":"text","total_items":"integer","processed_items":"integer","job_duration_ms":"integer"}'::jsonb, true, 40);

  END IF;


  IF NOT EXISTS (SELECT 1 FROM engineering_verification_methods WHERE method_key = 'deployment_migration_completed') THEN
    INSERT INTO engineering_verification_methods (method_key, method_type, name, description, evidence_schema, is_automated, sort_order)
    VALUES ('deployment_migration_completed', 'deployment', 'Deployment Migration Completed',
            'Verifies a database migration was applied and environment is healthy.',
            '{"migration_filename":"text","applied_at":"timestamptz","environment_healthy":"boolean","version_tag":"text","git_commit":"text"}'::jsonb, true, 50);

  END IF;


  IF NOT EXISTS (SELECT 1 FROM engineering_verification_methods WHERE method_key = 'manual_po_verification') THEN
    INSERT INTO engineering_verification_methods (method_key, method_type, name, description, evidence_schema, is_automated, sort_order)
    VALUES ('manual_po_verification', 'manual', 'Manual Product Owner Verification',
            'Manual verification by the Product Owner confirming the action achieved its intended outcome.',
            '{"verifier":"text","confirmation":"boolean","notes":"text"}'::jsonb, false, 90);

  END IF;

END $$;


-- ═══════════════════════════════════════════════════════════════════════
-- 4. SEED EVS-002 CONSTITUTIONAL AMENDMENT (CONST-001-AMD-004)
-- ═══════════════════════════════════════════════════════════════════════

DO $$
DECLARE
  v_const_001_id uuid;

BEGIN
  SELECT id INTO v_const_001_id FROM constitutional_documents WHERE document_ref = 'CONST-001' LIMIT 1;


  IF NOT EXISTS (SELECT 1 FROM constitutional_documents WHERE document_ref = 'CONST-001-AMD-004') THEN
    INSERT INTO constitutional_documents (
      id, document_ref, title, document_type, version, status,
      programme, effective_from, supersedes_id, authored_by, sections, metadata
    ) VALUES (
      gen_random_uuid(),
      'CONST-001-AMD-004',
      'Engineering Action Verification Standard (EVS-002)',
      'standard',
      '1.0',
      'active',
      'EIOS Platform',
      now(),
      v_const_001_id,
      'EWO-014.8',
      jsonb_build_object(
        'executive_summary', jsonb_build_object(
          'order', 1, 'title', 'Executive Summary',
          'content', 'Every engineering action performed anywhere inside EIOS must be capable of being independently verified. An engineering action is not considered complete simply because software reports success. It must have verifiable evidence.',
          'key_principles', jsonb_build_array(
            'Every engineering action shall produce verification evidence',
            'Evidence must be objective', 'Evidence must be independently obtainable',
            'Verification shall never rely solely on application success messages'
          )
        ),
        'verification_model', jsonb_build_object(
          'order', 2, 'title', 'Verification Model',
          'content', 'Every action receives one of four states. Never skip directly from Requested to Verified.',
          'states', jsonb_build_array(
            jsonb_build_object('key','requested','label','Requested','symbol','○','description','Action has been requested but not yet attempted'),
            jsonb_build_object('key','attempted','label','Attempted','symbol','◐','description','Action has been executed but not yet verified'),
            jsonb_build_object('key','verified','label','Verified','symbol','🟢','description','Action has been independently verified with objective evidence'),
            jsonb_build_object('key','failed_verification','label','Failed Verification','symbol','🔴','description','Verification was attempted but evidence did not pass')
          ),
          'transitions', jsonb_build_array(
            'requested → attempted','attempted → verified','attempted → failed_verification',
            'failed_verification → attempted','Never: requested → verified'
          )
        ),
        'verification_methods', jsonb_build_object(
          'order', 3, 'title', 'Verification Methods',
          'content', 'The standard supports multiple verification types. Future types extendable without redesign.',
          'method_types', jsonb_build_array(
            jsonb_build_object('type','database','methods',jsonb_build_array('Record exists','Record updated','Correct row count','Timestamp changed')),
            jsonb_build_object('type','file','methods',jsonb_build_array('File exists','Hash generated','Correct size','Readable')),
            jsonb_build_object('type','api','methods',jsonb_build_array('HTTP status','Response body','Expected object returned','Retry count')),
            jsonb_build_object('type','ui','methods',jsonb_build_array('Page renders','Control visible','Value displayed','Screenshot (future)')),
            jsonb_build_object('type','process','methods',jsonb_build_array('Queue completed','Worker finished','Job duration')),
            jsonb_build_object('type','deployment','methods',jsonb_build_array('Migration completed','Environment healthy','Version updated','Git commit linked'))
          ),
          'future_types', jsonb_build_array('Visual verification','AI verification','External monitoring','Cloud provider verification','Security verification','Regression verification','Manual Product Owner verification','Automated acceptance verification')
        ),
        'engineering_action_log', jsonb_build_object(
          'order', 4, 'title', 'Engineering Action Log',
          'content', 'Every engineering action stores a complete record with verification lifecycle data.',
          'fields', jsonb_build_array('Action ID','Action Type','Started','Completed','Verification Type','Verification Result','Verification Evidence','Verified By','Verification Timestamp','Failure Reason','Confidence'),
          'table', 'engineering_action_log',
          'immutability', 'Action log records cannot be deleted — immutability enforced at RLS level'
        ),
        'verification_engine', jsonb_build_object(
          'order', 5, 'title', 'Verification Engine',
          'content', 'A reusable Verification Engine provides verifyEngineeringAction() that every engineering workflow calls.',
          'interface', 'verifyEngineeringAction(actionId, method, params) → VerificationResult',
          'responsibilities', jsonb_build_array('Determine how to verify','Collect required evidence','Calculate confidence','Produce pass/fail result','Store evidence in action log'),
          'extensibility', 'New verification providers register via the engineering_verification_methods registry — no schema change required'
        ),
        'workflow', jsonb_build_object(
          'order', 6, 'title', 'Engineering Workflow',
          'content', 'Engineering execution follows a strict verify-then-advance pattern.',
          'stages', jsonb_build_array(
            jsonb_build_object('step',1,'action','Execute Action'),
            jsonb_build_object('step',2,'action','Capture Result'),
            jsonb_build_object('step',3,'action','Run Verification'),
            jsonb_build_object('step',4,'action','Store Evidence'),
            jsonb_build_object('step',5,'action','Update Status'),
            jsonb_build_object('step',6,'action','Continue Workflow')
          ),
          'gate_rule', 'Engineering cannot advance until required verification succeeds'
        ),
        'constitutional_requirements', jsonb_build_object(
          'order', 7, 'title', 'Constitutional Requirements',
          'content', 'EVS-002 is constitutional. Engineering Completion Reports must include verification evidence.',
          'completion_report_fields', jsonb_build_array('Verification Status','Verification Evidence Summary','Verification Confidence','Overall Engineering Verification'),
          'applies_to', 'All future Engineering Work Orders'
        ),
        'success_criteria', jsonb_build_object(
          'order', 8, 'title', 'Success Criteria',
          'content', 'The standard is satisfied when all success criteria are met.',
          'criteria', jsonb_build_array('Engineering actions produce objective verification evidence','Verification Engine reusable across EIOS','Action states include verification lifecycle','Engineering reports include verification evidence','Constitutional standard EVS-002 added','Architecture extensible for future verification types')
        )
      ),
      jsonb_build_object('ewo_ref','EWO-014.8','total_sections',8,'classification','Constitutional Standard','amendment_procedure','Constitutional amendment requiring EWO registration','governed_products',jsonb_build_array('EIOS Platform','Engineering Control Centre','ATD Workspace'),'supersedes_standard','None (new standard)')
    );

  END IF;

END $$;


-- ═══════════════════════════════════════════════════════════════════════
-- 5. SEED EVS-002 IN ENGINEERING STANDARDS TABLE
-- ═══════════════════════════════════════════════════════════════════════

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM ecc_engineering_standards WHERE title = 'EVS-002: Engineering Action Verification Standard') THEN
    INSERT INTO ecc_engineering_standards (version_introduced, category, title, body, status, sort_order, tags)
    VALUES (
      'EVS-002',
      'Architecture',
      'EVS-002: Engineering Action Verification Standard',
      'Every engineering action performed anywhere inside EIOS must be capable of being independently verified. An engineering action is not considered complete simply because software reports success — it must have verifiable evidence. Actions follow a four-state lifecycle: Requested → Attempted → Verified | Failed Verification. Never skip directly from Requested to Verified. The reusable Verification Engine (verifyEngineeringAction) determines how to verify, what evidence is required, confidence level, and pass/fail. Verification methods include database, file, API, UI, process, and deployment checks, with architecture extensible for future providers without redesign. Engineering Completion Reports must include Verification Status, Evidence Summary, Confidence, and Overall Engineering Verification.',
      'active',
      100,
      ARRAY['constitutional', 'verification', 'evidence', 'evs-002', 'ewo-014.8']::text[]
    );

  END IF;

END $$;


-- ═══════════════════════════════════════════════════════════════════════
-- 6. UPDATED_AT TRIGGERS (inline function to avoid search path issues)
-- ═══════════════════════════════════════════════════════════════════════

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_proc WHERE proname = 'evs002_update_updated_at' AND pronamespace = (SELECT oid FROM pg_namespace WHERE nspname = 'public')) THEN
    CREATE FUNCTION public.evs002_update_updated_at()
    RETURNS trigger AS $func$
    BEGIN
      NEW.updated_at = now();

      RETURN NEW;

    END;

    $func$ LANGUAGE plpgsql;

  END IF;

END $$;


DROP TRIGGER IF EXISTS trg_action_log_updated_at ON engineering_action_log;

CREATE TRIGGER trg_action_log_updated_at
  BEFORE UPDATE ON engineering_action_log
  FOR EACH ROW EXECUTE FUNCTION public.evs002_update_updated_at();


DROP TRIGGER IF EXISTS trg_verification_methods_updated_at ON engineering_verification_methods;

CREATE TRIGGER trg_verification_methods_updated_at
  BEFORE UPDATE ON engineering_verification_methods
  FOR EACH ROW EXECUTE FUNCTION public.evs002_update_updated_at();

;
