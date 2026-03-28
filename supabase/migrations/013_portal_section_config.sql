-- Portal Section Configuration
-- Controls which sections couples can see, which are admin-only, and which are off
CREATE TABLE IF NOT EXISTS portal_section_config (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  venue_id uuid NOT NULL REFERENCES venues(id) ON DELETE CASCADE,
  section_key text NOT NULL,
  label text NOT NULL,
  description text,
  visibility text NOT NULL DEFAULT 'both' CHECK (visibility IN ('admin_only', 'both', 'off')),
  sort_order integer DEFAULT 0,
  icon text, -- lucide icon name
  created_at timestamptz DEFAULT now(),
  updated_at timestamptz DEFAULT now(),
  UNIQUE(venue_id, section_key)
);

CREATE INDEX IF NOT EXISTS idx_portal_section_config_venue ON portal_section_config(venue_id);
