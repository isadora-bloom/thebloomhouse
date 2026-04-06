-- 016_wedding_details_config.sql
-- Admin-configurable wedding details: venues toggle which options appear for couples

CREATE TABLE IF NOT EXISTS wedding_detail_config (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  venue_id uuid NOT NULL REFERENCES venues(id),

  -- Ceremony options
  allow_outside_ceremony boolean DEFAULT true,
  allow_inside_ceremony boolean DEFAULT true,
  arbor_options text[] DEFAULT '{}',
  allow_unity_table boolean DEFAULT true,

  -- Reception options
  allow_charger_plates boolean DEFAULT true,
  allow_champagne_glasses boolean DEFAULT true,

  -- Send-off options
  allow_sparklers boolean DEFAULT true,
  allow_wands boolean DEFAULT true,
  allow_bubbles boolean DEFAULT true,
  custom_send_off_options text[] DEFAULT '{}',

  -- Custom sections (venue can add their own questions)
  -- Each entry: { label: string, type: 'text' | 'toggle' | 'select', options?: string[] }
  custom_fields jsonb DEFAULT '[]',

  created_at timestamptz DEFAULT now(),
  updated_at timestamptz DEFAULT now(),
  UNIQUE(venue_id)
);

-- Add custom_field_values column to wedding_details for storing custom field responses
ALTER TABLE wedding_details ADD COLUMN IF NOT EXISTS custom_field_values jsonb DEFAULT '{}';

-- RLS policies
ALTER TABLE wedding_detail_config ENABLE ROW LEVEL SECURITY;

-- Platform users (coordinators, managers, admins) can read/write their venue's config
CREATE POLICY "Platform users can read wedding detail config"
  ON wedding_detail_config FOR SELECT
  USING (
    venue_id IN (
      SELECT venue_id FROM user_profiles WHERE id = auth.uid()
    )
  );

CREATE POLICY "Platform users can insert wedding detail config"
  ON wedding_detail_config FOR INSERT
  WITH CHECK (
    venue_id IN (
      SELECT venue_id FROM user_profiles
      WHERE id = auth.uid()
        AND role IN ('coordinator', 'manager', 'org_admin', 'super_admin')
    )
  );

CREATE POLICY "Platform users can update wedding detail config"
  ON wedding_detail_config FOR UPDATE
  USING (
    venue_id IN (
      SELECT venue_id FROM user_profiles
      WHERE id = auth.uid()
        AND role IN ('coordinator', 'manager', 'org_admin', 'super_admin')
    )
  );

-- Couples can read their venue's config (to know which fields to show)
CREATE POLICY "Couples can read wedding detail config"
  ON wedding_detail_config FOR SELECT
  USING (
    venue_id IN (
      SELECT venue_id FROM user_profiles
      WHERE id = auth.uid() AND role = 'couple'
    )
  );

-- Service role bypass
CREATE POLICY "Service role full access to wedding detail config"
  ON wedding_detail_config FOR ALL
  USING (auth.role() = 'service_role');
