-- Table map layout: canvas elements positioned on venue floor plan
CREATE TABLE IF NOT EXISTS table_map_layouts (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  wedding_id UUID NOT NULL UNIQUE REFERENCES weddings(id) ON DELETE CASCADE,
  elements JSONB DEFAULT '[]',
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_table_map_layouts_wedding ON table_map_layouts(wedding_id);

ALTER TABLE table_map_layouts ENABLE ROW LEVEL SECURITY;

CREATE POLICY "couples_read_own_table_map" ON table_map_layouts
  FOR SELECT USING (
    wedding_id IN (SELECT wedding_id FROM people WHERE email = (SELECT email FROM auth.users WHERE id = auth.uid()))
  );
CREATE POLICY "couples_write_own_table_map" ON table_map_layouts
  FOR INSERT WITH CHECK (
    wedding_id IN (SELECT wedding_id FROM people WHERE email = (SELECT email FROM auth.users WHERE id = auth.uid()))
  );
CREATE POLICY "couples_update_own_table_map" ON table_map_layouts
  FOR UPDATE USING (
    wedding_id IN (SELECT wedding_id FROM people WHERE email = (SELECT email FROM auth.users WHERE id = auth.uid()))
  );
