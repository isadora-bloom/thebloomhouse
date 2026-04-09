-- Migration 030: Guest Tag System
-- Extends existing guest_tags and guest_tag_assignments tables with is_system flag,
-- ensures RLS policies exist for anon (demo) access, and seeds system tags for demo wedding.

-- Add is_system column if missing
ALTER TABLE guest_tags ADD COLUMN IF NOT EXISTS is_system boolean DEFAULT false;

-- Ensure wedding_id column exists (already exists per audit, but safe)
ALTER TABLE guest_tags ADD COLUMN IF NOT EXISTS wedding_id uuid;

-- Ensure unique assignment constraint (guest_id, tag_id)
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'guest_tag_assignments_guest_id_tag_id_key'
  ) THEN
    ALTER TABLE guest_tag_assignments
      ADD CONSTRAINT guest_tag_assignments_guest_id_tag_id_key UNIQUE (guest_id, tag_id);
  END IF;
END $$;

-- Make sure RLS is enabled
ALTER TABLE guest_tags ENABLE ROW LEVEL SECURITY;
ALTER TABLE guest_tag_assignments ENABLE ROW LEVEL SECURITY;

-- DELETE policies (not present per audit)
DROP POLICY IF EXISTS anon_delete_guest_tags ON guest_tags;
CREATE POLICY anon_delete_guest_tags ON guest_tags FOR DELETE TO anon USING (true);

DROP POLICY IF EXISTS anon_delete_guest_tag_assignments ON guest_tag_assignments;
CREATE POLICY anon_delete_guest_tag_assignments ON guest_tag_assignments FOR DELETE TO anon USING (true);

-- Make sure SELECT/INSERT/UPDATE policies exist (idempotent recreate)
DROP POLICY IF EXISTS anon_select_guest_tags ON guest_tags;
CREATE POLICY anon_select_guest_tags ON guest_tags FOR SELECT TO anon USING (true);

DROP POLICY IF EXISTS anon_insert_guest_tags ON guest_tags;
CREATE POLICY anon_insert_guest_tags ON guest_tags FOR INSERT TO anon WITH CHECK (true);

DROP POLICY IF EXISTS anon_update_guest_tags ON guest_tags;
CREATE POLICY anon_update_guest_tags ON guest_tags FOR UPDATE TO anon USING (true) WITH CHECK (true);

DROP POLICY IF EXISTS anon_select_guest_tag_assignments ON guest_tag_assignments;
CREATE POLICY anon_select_guest_tag_assignments ON guest_tag_assignments FOR SELECT TO anon USING (true);

DROP POLICY IF EXISTS anon_insert_guest_tag_assignments ON guest_tag_assignments;
CREATE POLICY anon_insert_guest_tag_assignments ON guest_tag_assignments FOR INSERT TO anon WITH CHECK (true);

DROP POLICY IF EXISTS anon_update_guest_tag_assignments ON guest_tag_assignments;
CREATE POLICY anon_update_guest_tag_assignments ON guest_tag_assignments FOR UPDATE TO anon USING (true) WITH CHECK (true);

-- Seed system tags for demo wedding
-- Use ON CONFLICT DO NOTHING style via NOT EXISTS
DO $$
DECLARE
  demo_wedding uuid := 'ab000000-0000-0000-0000-000000000001';
  demo_venue uuid;
BEGIN
  SELECT venue_id INTO demo_venue FROM weddings WHERE id = demo_wedding;

  INSERT INTO guest_tags (venue_id, wedding_id, tag_name, color, is_system)
  SELECT demo_venue, demo_wedding, t.tag_name, t.color, true
  FROM (VALUES
    ('Hotel', '#8B7355'),
    ('Shuttle', '#5D7A7A'),
    ('Wedding Party', '#B8908A'),
    ('Rehearsal Dinner', '#A6894A'),
    ('Brunch', '#FFB6C1'),
    ('Processional', '#7D8471'),
    ('Family Photos', '#C9748A')
  ) AS t(tag_name, color)
  WHERE NOT EXISTS (
    SELECT 1 FROM guest_tags g
    WHERE g.wedding_id = demo_wedding AND g.tag_name = t.tag_name
  );
END $$;
