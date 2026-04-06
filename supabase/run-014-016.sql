-- ============================================
-- COMBINED: Migrations 014 + 015 + 016
-- Run this in Supabase SQL Editor (one-shot)
-- ============================================

-- === 014: Missing Couple Portal Pages ===

CREATE TABLE IF NOT EXISTS wedding_details (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  venue_id uuid NOT NULL REFERENCES venues(id),
  wedding_id uuid NOT NULL REFERENCES weddings(id),
  wedding_colors text,
  partner1_social text,
  partner2_social text,
  dogs_coming boolean DEFAULT false,
  dogs_description text,
  ceremony_location text CHECK (ceremony_location IN ('outside', 'inside', 'both')),
  arbor_choice text,
  unity_table boolean DEFAULT false,
  ceremony_notes text,
  seating_method text,
  providing_table_numbers boolean,
  providing_charger_plates boolean,
  providing_champagne_glasses boolean,
  providing_cake_cutter boolean,
  providing_cake_topper boolean,
  favors_description text,
  reception_notes text,
  send_off_type text,
  send_off_notes text,
  custom_field_values jsonb DEFAULT '{}',
  created_at timestamptz DEFAULT now(),
  updated_at timestamptz DEFAULT now(),
  UNIQUE(venue_id, wedding_id)
);
CREATE INDEX IF NOT EXISTS idx_wedding_details_venue_wedding ON wedding_details(venue_id, wedding_id);

CREATE TABLE IF NOT EXISTS wedding_tables (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  venue_id uuid NOT NULL REFERENCES venues(id),
  wedding_id uuid NOT NULL REFERENCES weddings(id),
  guest_count integer DEFAULT 0,
  table_shape text DEFAULT 'round' CHECK (table_shape IN ('round', 'rectangular', 'farm', 'mixed')),
  guests_per_table integer DEFAULT 8,
  rect_table_count integer DEFAULT 0,
  sweetheart_table boolean DEFAULT false,
  head_table boolean DEFAULT false,
  head_table_people integer DEFAULT 0,
  head_table_sided text DEFAULT 'one' CHECK (head_table_sided IN ('one', 'two')),
  kids_table boolean DEFAULT false,
  kids_count integer DEFAULT 0,
  cocktail_tables integer DEFAULT 0,
  linen_color text,
  napkin_color text,
  linen_venue_choice boolean DEFAULT false,
  runner_style text DEFAULT 'none' CHECK (runner_style IN ('none', 'runner', 'overlay', 'greenery')),
  chargers boolean DEFAULT false,
  checkered_dance_floor boolean DEFAULT false,
  lounge_area boolean DEFAULT false,
  centerpiece_notes text,
  layout_notes text,
  linen_notes text,
  extra_tables jsonb DEFAULT '{}',
  is_draft boolean DEFAULT false,
  created_at timestamptz DEFAULT now(),
  updated_at timestamptz DEFAULT now(),
  UNIQUE(venue_id, wedding_id)
);
CREATE INDEX IF NOT EXISTS idx_wedding_tables_venue_wedding ON wedding_tables(venue_id, wedding_id);

CREATE TABLE IF NOT EXISTS storefront (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  venue_id uuid NOT NULL REFERENCES venues(id),
  pick_name text NOT NULL,
  category text NOT NULL,
  product_type text,
  description text,
  color_options text,
  affiliate_link text,
  image_url text,
  pick_type text CHECK (pick_type IN ('Best Save', 'Best Splurge', 'Best Practical', 'Spring/Summer', 'Fall/Winter', 'Best Custom')),
  is_active boolean DEFAULT true,
  sort_order integer DEFAULT 0,
  created_at timestamptz DEFAULT now(),
  updated_at timestamptz DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_storefront_venue ON storefront(venue_id);

CREATE TABLE IF NOT EXISTS venue_assets (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  venue_id uuid NOT NULL REFERENCES venues(id),
  title text NOT NULL,
  description text,
  file_name text NOT NULL,
  storage_path text NOT NULL,
  file_type text,
  file_size integer,
  sort_order integer DEFAULT 0,
  created_at timestamptz DEFAULT now(),
  updated_at timestamptz DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_venue_assets_venue ON venue_assets(venue_id);

CREATE TABLE IF NOT EXISTS venue_resources (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  venue_id uuid NOT NULL REFERENCES venues(id),
  title text NOT NULL,
  subtitle text,
  url text NOT NULL,
  icon text DEFAULT 'link',
  is_external boolean DEFAULT true,
  sort_order integer DEFAULT 0,
  is_active boolean DEFAULT true,
  created_at timestamptz DEFAULT now(),
  updated_at timestamptz DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_venue_resources_venue ON venue_resources(venue_id);

ALTER TABLE weddings ADD COLUMN IF NOT EXISTS couple_photo_url text;

-- === 015: Vendors + Contracts Upgrade ===

CREATE TABLE IF NOT EXISTS booked_vendors (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  venue_id uuid NOT NULL REFERENCES venues(id) ON DELETE CASCADE,
  wedding_id uuid NOT NULL REFERENCES weddings(id) ON DELETE CASCADE,
  vendor_type text NOT NULL,
  vendor_name text,
  vendor_contact text,
  notes text,
  is_booked boolean DEFAULT false,
  contract_uploaded boolean DEFAULT false,
  contract_url text,
  contract_storage_path text,
  contract_date timestamptz,
  created_at timestamptz DEFAULT now(),
  updated_at timestamptz DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_booked_vendors_venue_id ON booked_vendors(venue_id);
CREATE INDEX IF NOT EXISTS idx_booked_vendors_wedding_id ON booked_vendors(wedding_id);
CREATE INDEX IF NOT EXISTS idx_booked_vendors_type ON booked_vendors(wedding_id, vendor_type);

ALTER TABLE contracts
  ADD COLUMN IF NOT EXISTS file_url text,
  ADD COLUMN IF NOT EXISTS key_terms text[],
  ADD COLUMN IF NOT EXISTS analysis text,
  ADD COLUMN IF NOT EXISTS analyzed_at timestamptz,
  ADD COLUMN IF NOT EXISTS vendor_id uuid,
  ADD COLUMN IF NOT EXISTS vendor_name text,
  ADD COLUMN IF NOT EXISTS status text DEFAULT 'uploaded',
  ADD COLUMN IF NOT EXISTS updated_at timestamptz DEFAULT now();

-- Drop and re-add planning_notes constraint if it exists
ALTER TABLE planning_notes DROP CONSTRAINT IF EXISTS planning_notes_category_check;
ALTER TABLE planning_notes
  ADD CONSTRAINT planning_notes_category_check
  CHECK (category IN ('vendor', 'guest_count', 'decor', 'checklist', 'cost', 'date', 'policy', 'note'));

-- === 016: Wedding Details Config ===

CREATE TABLE IF NOT EXISTS wedding_detail_config (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  venue_id uuid NOT NULL REFERENCES venues(id),
  allow_outside_ceremony boolean DEFAULT true,
  allow_inside_ceremony boolean DEFAULT true,
  arbor_options text[] DEFAULT '{}',
  allow_unity_table boolean DEFAULT true,
  allow_charger_plates boolean DEFAULT true,
  allow_champagne_glasses boolean DEFAULT true,
  allow_sparklers boolean DEFAULT true,
  allow_wands boolean DEFAULT true,
  allow_bubbles boolean DEFAULT true,
  custom_send_off_options text[] DEFAULT '{}',
  custom_fields jsonb DEFAULT '[]',
  created_at timestamptz DEFAULT now(),
  updated_at timestamptz DEFAULT now(),
  UNIQUE(venue_id)
);

-- === Guest care notes table (if not exists) ===
CREATE TABLE IF NOT EXISTS guest_care_notes (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  venue_id uuid NOT NULL REFERENCES venues(id),
  wedding_id uuid NOT NULL REFERENCES weddings(id),
  data jsonb DEFAULT '{}',
  created_at timestamptz DEFAULT now(),
  updated_at timestamptz DEFAULT now(),
  UNIQUE(venue_id, wedding_id)
);

-- === Staffing calculator table (if not exists) ===
CREATE TABLE IF NOT EXISTS staffing_calculator (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  venue_id uuid NOT NULL REFERENCES venues(id),
  wedding_id uuid NOT NULL REFERENCES weddings(id),
  answers jsonb DEFAULT '{}',
  friday_bartenders integer DEFAULT 0,
  friday_extra_hands integer DEFAULT 0,
  friday_total decimal DEFAULT 0,
  saturday_bartenders integer DEFAULT 0,
  saturday_extra_hands integer DEFAULT 0,
  saturday_total decimal DEFAULT 0,
  total_staff integer DEFAULT 0,
  total_cost decimal DEFAULT 0,
  created_at timestamptz DEFAULT now(),
  updated_at timestamptz DEFAULT now(),
  UNIQUE(venue_id, wedding_id)
);
