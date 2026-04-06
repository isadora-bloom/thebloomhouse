-- ============================================
-- 014: MISSING COUPLE PORTAL PAGES
-- Tables for: Wedding Details, Table Planner,
-- Venue Picks (Storefront), Venue Downloads,
-- Venue Resources
-- Depends on: 001, 004, 009
-- ============================================

-- ---------------------------------------------------------------------------
-- 1. Wedding Details — ceremony, reception, send-off preferences
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS wedding_details (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  venue_id uuid NOT NULL REFERENCES venues(id),
  wedding_id uuid NOT NULL REFERENCES weddings(id),

  -- The Basics
  wedding_colors text,
  partner1_social text,
  partner2_social text,
  dogs_coming boolean DEFAULT false,
  dogs_description text,

  -- Ceremony
  ceremony_location text CHECK (ceremony_location IN ('outside', 'inside', 'both')),
  arbor_choice text,
  unity_table boolean DEFAULT false,
  ceremony_notes text,

  -- Reception
  seating_method text,
  providing_table_numbers boolean,
  providing_charger_plates boolean,
  providing_champagne_glasses boolean,
  providing_cake_cutter boolean,
  providing_cake_topper boolean,
  favors_description text,
  reception_notes text,

  -- Send-Off
  send_off_type text,
  send_off_notes text,

  created_at timestamptz DEFAULT now(),
  updated_at timestamptz DEFAULT now(),
  UNIQUE(venue_id, wedding_id)
);

CREATE INDEX IF NOT EXISTS idx_wedding_details_venue_wedding
  ON wedding_details(venue_id, wedding_id);

-- ---------------------------------------------------------------------------
-- 2. Wedding Tables — table layout planner + linen calculator
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS wedding_tables (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  venue_id uuid NOT NULL REFERENCES venues(id),
  wedding_id uuid NOT NULL REFERENCES weddings(id),

  guest_count integer DEFAULT 0,
  table_shape text DEFAULT 'round' CHECK (table_shape IN ('round', 'rectangular', 'farm', 'mixed')),
  guests_per_table integer DEFAULT 8,
  rect_table_count integer DEFAULT 0,

  -- Special tables
  sweetheart_table boolean DEFAULT false,
  head_table boolean DEFAULT false,
  head_table_people integer DEFAULT 0,
  head_table_sided text DEFAULT 'one' CHECK (head_table_sided IN ('one', 'two')),
  kids_table boolean DEFAULT false,
  kids_count integer DEFAULT 0,
  cocktail_tables integer DEFAULT 0,

  -- Linens
  linen_color text,
  napkin_color text,
  linen_venue_choice boolean DEFAULT false,
  runner_style text DEFAULT 'none' CHECK (runner_style IN ('none', 'runner', 'overlay', 'greenery')),
  chargers boolean DEFAULT false,

  -- Layout
  checkered_dance_floor boolean DEFAULT false,
  lounge_area boolean DEFAULT false,

  -- Notes
  centerpiece_notes text,
  layout_notes text,
  linen_notes text,

  -- Extra tables (stored as JSONB for flexibility)
  extra_tables jsonb DEFAULT '{}',

  -- Draft mode (admin can save draft hidden from couple)
  is_draft boolean DEFAULT false,

  created_at timestamptz DEFAULT now(),
  updated_at timestamptz DEFAULT now(),
  UNIQUE(venue_id, wedding_id)
);

CREATE INDEX IF NOT EXISTS idx_wedding_tables_venue_wedding
  ON wedding_tables(venue_id, wedding_id);

-- ---------------------------------------------------------------------------
-- 3. Storefront / Venue Picks — curated shopping guide
-- ---------------------------------------------------------------------------
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

-- ---------------------------------------------------------------------------
-- 4. Venue Assets / Downloads — logos, sketches, brand assets
-- ---------------------------------------------------------------------------
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

-- ---------------------------------------------------------------------------
-- 5. Venue Resources — configurable links per venue
-- ---------------------------------------------------------------------------
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

-- ---------------------------------------------------------------------------
-- 6. Add couple_photo_url to weddings if not present
-- ---------------------------------------------------------------------------
ALTER TABLE weddings
  ADD COLUMN IF NOT EXISTS couple_photo_url text;
