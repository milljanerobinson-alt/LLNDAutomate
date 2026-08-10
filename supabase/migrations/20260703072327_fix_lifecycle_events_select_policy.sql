
DROP POLICY IF EXISTS "lifecycle_select_staff" ON student_lifecycle_events;

DROP POLICY IF EXISTS "lifecycle_delete_staff" ON student_lifecycle_events;


CREATE POLICY "lifecycle_select_staff" ON student_lifecycle_events
  FOR SELECT TO authenticated
  USING (get_my_role() = ANY (ARRAY['admin'::text, 'trainer'::text]));


CREATE POLICY "lifecycle_delete_staff" ON student_lifecycle_events
  FOR DELETE TO authenticated
  USING (get_my_role() = ANY (ARRAY['admin'::text, 'trainer'::text]));

;
