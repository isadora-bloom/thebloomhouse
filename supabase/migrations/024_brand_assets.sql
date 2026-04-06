-- ============================================
-- 024: BRAND ASSETS
-- Venue-level brand assets (watercolor images, photography, textures)
-- usable across the platform (emails, proposals, client portal)
-- ============================================

CREATE TABLE IF NOT EXISTS brand_assets (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  venue_id uuid NOT NULL REFERENCES venues(id) ON DELETE CASCADE,
  asset_type text NOT NULL CHECK (asset_type IN ('logo', 'hero_image', 'watercolor', 'photography', 'texture', 'icon', 'other')),
  label text,
  url text NOT NULL,
  sort_order integer DEFAULT 0,
  created_at timestamptz DEFAULT now()
);

COMMENT ON TABLE brand_assets IS 'owner:platform';

CREATE INDEX IF NOT EXISTS idx_brand_assets_venue_id ON brand_assets(venue_id);

-- RLS
ALTER TABLE brand_assets ENABLE ROW LEVEL SECURITY;

CREATE POLICY "venue_isolation" ON brand_assets
  FOR ALL
  USING (venue_id = (SELECT venue_id FROM user_profiles WHERE id = auth.uid()));

CREATE POLICY "super_admin_bypass" ON brand_assets
  FOR ALL
  USING (EXISTS (SELECT 1 FROM user_profiles WHERE id = auth.uid() AND role = 'super_admin'));
