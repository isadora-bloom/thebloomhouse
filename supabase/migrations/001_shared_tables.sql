-- ============================================
-- 001: SHARED TABLES
-- Owner: platform (read by all three products)
-- ============================================

-- Organisations (for multi-venue groups)
CREATE TABLE organisations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text NOT NULL,
  owner_id uuid,
  plan_tier text DEFAULT 'starter',
  stripe_customer_id text,
  created_at timestamptz DEFAULT now()
);
COMMENT ON TABLE organisations IS 'owner:platform';

-- Venues
CREATE TABLE venues (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text NOT NULL,
  slug text UNIQUE NOT NULL,
  org_id uuid REFERENCES organisations(id),
  plan_tier text DEFAULT 'starter' CHECK (plan_tier IN ('starter', 'intelligence', 'enterprise')),
  status text DEFAULT 'trial' CHECK (status IN ('active', 'trial', 'suspended', 'churned')),
  created_at timestamptz DEFAULT now(),
  updated_at timestamptz DEFAULT now()
);
COMMENT ON TABLE venues IS 'owner:shared';

-- Venue Config
CREATE TABLE venue_config (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  venue_id uuid NOT NULL REFERENCES venues(id) ON DELETE CASCADE UNIQUE,
  business_name text,
  logo_url text,
  primary_color text DEFAULT '#7D8471',
  secondary_color text DEFAULT '#5D7A7A',
  accent_color text DEFAULT '#A6894A',
  font_pair text DEFAULT 'playfair_inter',
  timezone text DEFAULT 'America/New_York',
  currency text DEFAULT 'USD',
  catering_model text DEFAULT 'byob' CHECK (catering_model IN ('in_house', 'byob', 'preferred_list')),
  bar_model text DEFAULT 'byob' CHECK (bar_model IN ('in_house', 'byob', 'hybrid')),
  capacity integer,
  base_price decimal,
  coordinator_name text,
  coordinator_email text,
  coordinator_phone text,
  gmail_tokens jsonb,
  calendly_link text,
  calendly_tokens jsonb,
  feature_flags jsonb DEFAULT '{}',
  created_at timestamptz DEFAULT now(),
  updated_at timestamptz DEFAULT now()
);
COMMENT ON TABLE venue_config IS 'owner:shared';

-- Venue AI Config (THE PERSONALITY ENGINE TABLE)
CREATE TABLE venue_ai_config (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  venue_id uuid NOT NULL REFERENCES venues(id) ON DELETE CASCADE UNIQUE,
  -- Identity
  ai_name text DEFAULT 'Sage',
  ai_email text,
  ai_emoji text,
  -- Personality dimensions (1-10)
  warmth_level integer DEFAULT 7,
  formality_level integer DEFAULT 4,
  playfulness_level integer DEFAULT 5,
  brevity_level integer DEFAULT 6,
  enthusiasm_level integer DEFAULT 6,
  -- Style
  uses_contractions boolean DEFAULT true,
  uses_exclamation_points boolean DEFAULT true,
  emoji_level text DEFAULT 'signoff_only' CHECK (emoji_level IN ('none', 'signoff_only', 'moderate', 'liberal')),
  phrase_style text DEFAULT 'warm' CHECK (phrase_style IN ('warm', 'playful', 'professional', 'enthusiastic')),
  vibe text DEFAULT 'romantic_timeless',
  -- Behavior
  follow_up_style text DEFAULT 'moderate' CHECK (follow_up_style IN ('none', 'light', 'moderate', 'persistent')),
  max_follow_ups integer DEFAULT 2,
  escalation_style text DEFAULT 'soft_offer' CHECK (escalation_style IN ('immediate', 'soft_offer', 'reassure_first')),
  sales_approach text DEFAULT 'consultative' CHECK (sales_approach IN ('direct', 'consultative', 'experience_first', 'tour_first')),
  -- Signature
  signature_greeting text,
  signature_closer text,
  signature_expressions jsonb DEFAULT '[]',
  -- Links
  tour_booking_link text,
  intro_call_link text,
  pricing_calculator_link text,
  -- Portal model details
  assistant_personality text,
  event_model text,
  alcohol_model text,
  accommodation_model text,
  vendor_policy text,
  coordinator_level text,
  staff_rate decimal,
  min_bartenders integer,
  guests_per_bartender integer,
  created_at timestamptz DEFAULT now(),
  updated_at timestamptz DEFAULT now()
);
COMMENT ON TABLE venue_ai_config IS 'owner:shared';

-- Users (extends Supabase auth.users)
CREATE TABLE user_profiles (
  id uuid PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
  venue_id uuid REFERENCES venues(id),
  org_id uuid REFERENCES organisations(id),
  role text NOT NULL DEFAULT 'coordinator' CHECK (role IN ('super_admin', 'org_admin', 'venue_manager', 'coordinator', 'couple')),
  first_name text,
  last_name text,
  avatar_url text,
  created_at timestamptz DEFAULT now()
);
COMMENT ON TABLE user_profiles IS 'owner:platform';

-- Weddings
CREATE TABLE weddings (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  venue_id uuid NOT NULL REFERENCES venues(id) ON DELETE CASCADE,
  status text DEFAULT 'inquiry' CHECK (status IN ('inquiry', 'tour_scheduled', 'tour_completed', 'proposal_sent', 'booked', 'completed', 'lost', 'cancelled')),
  source text CHECK (source IN ('the_knot', 'weddingwire', 'google', 'instagram', 'referral', 'website', 'walk_in', 'other')),
  source_detail text,
  wedding_date date,
  guest_count_estimate integer,
  booking_value decimal,
  assigned_consultant_id uuid REFERENCES user_profiles(id),
  inquiry_date timestamptz DEFAULT now(),
  first_response_at timestamptz,
  tour_date timestamptz,
  booked_at timestamptz,
  lost_at timestamptz,
  lost_reason text,
  heat_score integer DEFAULT 0,
  temperature_tier text DEFAULT 'cool',
  notes text,
  created_at timestamptz DEFAULT now(),
  updated_at timestamptz DEFAULT now()
);
COMMENT ON TABLE weddings IS 'owner:agent+portal';

-- People
CREATE TABLE people (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  venue_id uuid NOT NULL REFERENCES venues(id) ON DELETE CASCADE,
  wedding_id uuid REFERENCES weddings(id) ON DELETE SET NULL,
  role text DEFAULT 'partner1' CHECK (role IN ('partner1', 'partner2', 'guest', 'wedding_party', 'vendor', 'family')),
  first_name text,
  last_name text,
  email text,
  phone text,
  created_at timestamptz DEFAULT now(),
  updated_at timestamptz DEFAULT now()
);
COMMENT ON TABLE people IS 'owner:agent+portal';

-- Contacts
CREATE TABLE contacts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  person_id uuid NOT NULL REFERENCES people(id) ON DELETE CASCADE,
  type text NOT NULL CHECK (type IN ('email', 'phone', 'instagram')),
  value text NOT NULL,
  is_primary boolean DEFAULT false,
  created_at timestamptz DEFAULT now()
);
COMMENT ON TABLE contacts IS 'owner:agent+portal';

-- Knowledge Base
CREATE TABLE knowledge_base (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  venue_id uuid NOT NULL REFERENCES venues(id) ON DELETE CASCADE,
  category text,
  question text NOT NULL,
  answer text NOT NULL,
  keywords text[],
  priority integer DEFAULT 0,
  is_active boolean DEFAULT true,
  created_at timestamptz DEFAULT now(),
  updated_at timestamptz DEFAULT now()
);
COMMENT ON TABLE knowledge_base IS 'owner:portal';

-- Booked Dates
CREATE TABLE booked_dates (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  venue_id uuid NOT NULL REFERENCES venues(id) ON DELETE CASCADE,
  date date NOT NULL,
  wedding_id uuid REFERENCES weddings(id) ON DELETE SET NULL,
  block_type text DEFAULT 'wedding' CHECK (block_type IN ('wedding', 'private_event', 'maintenance', 'hold')),
  notes text,
  created_at timestamptz DEFAULT now()
);
COMMENT ON TABLE booked_dates IS 'owner:agent';

-- Indexes
CREATE INDEX idx_weddings_venue_id ON weddings(venue_id);
CREATE INDEX idx_weddings_status ON weddings(status);
CREATE INDEX idx_weddings_source ON weddings(source);
CREATE INDEX idx_people_venue_id ON people(venue_id);
CREATE INDEX idx_people_wedding_id ON people(wedding_id);
CREATE INDEX idx_contacts_person_id ON contacts(person_id);
CREATE INDEX idx_contacts_value ON contacts(value);
CREATE INDEX idx_knowledge_base_venue_id ON knowledge_base(venue_id);
CREATE INDEX idx_booked_dates_venue_id_date ON booked_dates(venue_id, date);
CREATE INDEX idx_user_profiles_venue_id ON user_profiles(venue_id);
