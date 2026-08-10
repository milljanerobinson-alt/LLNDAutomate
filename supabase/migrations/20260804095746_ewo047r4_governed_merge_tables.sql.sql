-- EWO-047R4: Governed Merge Phase — Approval, Evidence, and Continuation Tables
-- These tables persist the full merge lifecycle: review → approval → execution → evidence

-- ─── Merge Approval Records ─────────────────────────────────────────────────
-- Persisted when the Product Owner explicitly approves a merge.
-- Approval does NOT perform the merge — it authorises it.
CREATE TABLE IF NOT EXISTS ewo_merge_approvals (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  ewo_id          uuid NOT NULL REFERENCES engineering_work_orders(id) ON DELETE CASCADE,
  ewo_ref         text NOT NULL,
  execution_request_id   uuid NOT NULL,
  supervised_execution_id uuid NOT NULL,
  github_evidence_id     uuid NOT NULL,
  repository_owner text NOT NULL,
  repository_name  text NOT NULL,
  base_branch      text NOT NULL,
  working_branch   text NOT NULL,
  reviewed_commit_sha text NOT NULL,
  evidence_hash    text,
  product_owner    text NOT NULL,
  approval_statement text NOT NULL,
  audit_reference  text NOT NULL,
  approved_at      timestamptz NOT NULL DEFAULT now(),
  approved_by      uuid NOT NULL,
  created_at       timestamptz NOT NULL DEFAULT now()
);


-- Idempotency: one active approval per EWO (unique on ewo_id)
CREATE UNIQUE INDEX IF NOT EXISTS ewo_merge_approvals_ewo_id_uniq
  ON ewo_merge_approvals(ewo_id);


ALTER TABLE ewo_merge_approvals ENABLE ROW LEVEL SECURITY;


CREATE POLICY "select_own_merge_approvals" ON ewo_merge_approvals FOR SELECT
  TO authenticated USING (
    auth.uid() = approved_by
    OR EXISTS (
      SELECT 1 FROM engineering_work_orders ewo
      WHERE ewo.id = ewo_merge_approvals.ewo_id
        AND ewo.product_owner = (
          SELECT email FROM profiles WHERE id = auth.uid()
        )
    )
    OR EXISTS (
      SELECT 1 FROM profiles WHERE id = auth.uid() AND role = 'admin'
    )
  );


CREATE POLICY "insert_own_merge_approvals" ON ewo_merge_approvals FOR INSERT
  TO authenticated WITH CHECK (
    auth.uid() = approved_by
    OR EXISTS (
      SELECT 1 FROM profiles WHERE id = auth.uid() AND role = 'admin'
    )
  );


-- ─── Merge Evidence Records ──────────────────────────────────────────────────
-- Persisted after the merge is performed on GitHub.
-- Records the merge commit SHA, source/target branches, and approval reference.
CREATE TABLE IF NOT EXISTS ewo_merge_evidence (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  ewo_id            uuid NOT NULL REFERENCES engineering_work_orders(id) ON DELETE CASCADE,
  ewo_ref           text NOT NULL,
  merge_commit_sha  text NOT NULL,
  source_branch     text NOT NULL,
  target_branch     text NOT NULL,
  source_commit_sha text NOT NULL,
  merge_approval_id uuid NOT NULL REFERENCES ewo_merge_approvals(id) ON DELETE CASCADE,
  merged_by         uuid NOT NULL,
  merged_by_email   text,
  audit_reference   text NOT NULL,
  merged_at         timestamptz NOT NULL DEFAULT now(),
  created_at        timestamptz NOT NULL DEFAULT now()
);


-- Idempotency: one merge evidence per EWO (unique on ewo_id)
CREATE UNIQUE INDEX IF NOT EXISTS ewo_merge_evidence_ewo_id_uniq
  ON ewo_merge_evidence(ewo_id);


ALTER TABLE ewo_merge_evidence ENABLE ROW LEVEL SECURITY;


CREATE POLICY "select_own_merge_evidence" ON ewo_merge_evidence FOR SELECT
  TO authenticated USING (
    auth.uid() = merged_by
    OR EXISTS (
      SELECT 1 FROM profiles WHERE id = auth.uid() AND role = 'admin'
    )
  );


CREATE POLICY "insert_own_merge_evidence" ON ewo_merge_evidence FOR INSERT
  TO authenticated WITH CHECK (
    auth.uid() = merged_by
    OR EXISTS (
      SELECT 1 FROM profiles WHERE id = auth.uid() AND role = 'admin'
    )
  );


-- ─── Roadmap Item: Automated Engineering Validation & Preview Environments ────
-- Deferred roadmap item recorded in the ECC roadmap table.
INSERT INTO ecc_roadmap_items (id, name, description, target_quarter, priority, status, sort_order)
VALUES (
  gen_random_uuid(),
  'Automated Engineering Validation & Preview Environments',
  'Automatically build every governed engineering branch, run tests and type-checks, create temporary branch preview environments, provide Product Owner preview URLs, capture visual and functional validation evidence, support Product Owner approval directly from the preview, perform governed merge after approval, and clean up preview environments after merge or rejection.',
  'Deferred',
  'medium',
  'deferred',
  999
)
ON CONFLICT DO NOTHING;

;
