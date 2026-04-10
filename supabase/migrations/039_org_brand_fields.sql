ALTER TABLE organisations
  ADD COLUMN IF NOT EXISTS logo_url text,
  ADD COLUMN IF NOT EXISTS brand_description text,
  ADD COLUMN IF NOT EXISTS primary_color text,
  ADD COLUMN IF NOT EXISTS secondary_color text,
  ADD COLUMN IF NOT EXISTS accent_color text;

-- Anon RLS for demo
DROP POLICY IF EXISTS "anon_select_organisations" ON organisations;
CREATE POLICY "anon_select_organisations" ON organisations FOR SELECT TO anon USING (true);
DROP POLICY IF EXISTS "anon_update_organisations" ON organisations;
CREATE POLICY "anon_update_organisations" ON organisations FOR UPDATE TO anon USING (true) WITH CHECK (true);

-- Authenticated RLS
DROP POLICY IF EXISTS "auth_select_organisations" ON organisations;
CREATE POLICY "auth_select_organisations" ON organisations FOR SELECT TO authenticated USING (true);
DROP POLICY IF EXISTS "auth_update_organisations" ON organisations;
CREATE POLICY "auth_update_organisations" ON organisations FOR UPDATE TO authenticated USING (true) WITH CHECK (true);

-- Seed demo org with brand fields
UPDATE organisations
SET
  brand_description = 'A boutique collection of historic estates and modern venues across Virginia.',
  primary_color = '#7D8471',
  secondary_color = '#5D7A7A',
  accent_color = '#A6894A'
WHERE name = 'The Crestwood Collection';
