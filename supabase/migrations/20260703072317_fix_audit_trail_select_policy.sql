
DROP POLICY IF EXISTS "audit_trail_select_staff" ON audit_trail;


CREATE POLICY "audit_trail_select_staff" ON audit_trail
  FOR SELECT TO authenticated
  USING (get_my_role() = ANY (ARRAY['admin'::text, 'trainer'::text]));

;
