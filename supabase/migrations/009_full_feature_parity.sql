-- ============================================
-- 009: FULL FEATURE PARITY
-- Adds ALL remaining tables needed for complete parity with
-- Rixey Portal, Intel app, and Agent app.
-- Depends on: 001-008
-- ============================================

-- ============================================
-- SECTION 1: ALTER EXISTING TABLES
-- ============================================

-- Add missing columns to guest_list
ALTER TABLE guest_list
  ADD COLUMN IF NOT EXISTS meal_option_id uuid,
  ADD COLUMN IF NOT EXISTS address text;

-- Add missing columns to weddings
ALTER TABLE weddings
  ADD COLUMN IF NOT EXISTS package text,
  ADD COLUMN IF NOT EXISTS hold_expires_at timestamptz,
  ADD COLUMN IF NOT EXISTS contracted_at timestamptz;


-- ============================================
-- SECTION 2: COUPLE DAY-OF OPERATIONS
-- ============================================

-- Bar Planning
CREATE TABLE IF NOT EXISTS bar_planning (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  venue_id uuid NOT NULL REFERENCES venues(id) ON DELETE CASCADE,
  wedding_id uuid NOT NULL REFERENCES weddings(id) ON DELETE CASCADE,
  bar_type text CHECK (bar_type IN ('none', 'beer_wine', 'specialty', 'modified_full', 'full')),
  guest_count integer,
  bartender_count integer,
  notes text,
  created_at timestamptz DEFAULT now(),
  updated_at timestamptz DEFAULT now()
);
COMMENT ON TABLE bar_planning IS 'owner:portal';

-- Bar Recipes
CREATE TABLE IF NOT EXISTS bar_recipes (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  venue_id uuid NOT NULL REFERENCES venues(id) ON DELETE CASCADE,
  wedding_id uuid NOT NULL REFERENCES weddings(id) ON DELETE CASCADE,
  cocktail_name text NOT NULL,
  ingredients jsonb DEFAULT '[]',
  instructions text,
  servings integer,
  scaling_factor decimal DEFAULT 1.0,
  created_at timestamptz DEFAULT now()
);
COMMENT ON TABLE bar_recipes IS 'owner:portal';

-- Bar Shopping List
CREATE TABLE IF NOT EXISTS bar_shopping_list (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  venue_id uuid NOT NULL REFERENCES venues(id) ON DELETE CASCADE,
  wedding_id uuid NOT NULL REFERENCES weddings(id) ON DELETE CASCADE,
  item_name text NOT NULL,
  category text CHECK (category IN ('beer', 'wine', 'spirits', 'mixers', 'garnish', 'supplies')),
  quantity decimal,
  unit text,
  estimated_cost decimal,
  purchased boolean DEFAULT false,
  notes text,
  created_at timestamptz DEFAULT now()
);
COMMENT ON TABLE bar_shopping_list IS 'owner:portal';

-- Ceremony Order
CREATE TABLE IF NOT EXISTS ceremony_order (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  venue_id uuid NOT NULL REFERENCES venues(id) ON DELETE CASCADE,
  wedding_id uuid NOT NULL REFERENCES weddings(id) ON DELETE CASCADE,
  participant_name text NOT NULL,
  role text CHECK (role IN ('officiant', 'bride', 'groom', 'maid_of_honor', 'best_man', 'bridesmaid', 'groomsman', 'flower_girl', 'ring_bearer', 'usher', 'reader', 'musician', 'other')),
  side text CHECK (side IN ('bride', 'groom', 'both')),
  sort_order integer,
  notes text,
  created_at timestamptz DEFAULT now()
);
COMMENT ON TABLE ceremony_order IS 'owner:portal';

-- Makeup Schedule
CREATE TABLE IF NOT EXISTS makeup_schedule (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  venue_id uuid NOT NULL REFERENCES venues(id) ON DELETE CASCADE,
  wedding_id uuid NOT NULL REFERENCES weddings(id) ON DELETE CASCADE,
  person_name text NOT NULL,
  role text,
  hair_time time,
  makeup_time time,
  notes text,
  sort_order integer,
  created_at timestamptz DEFAULT now()
);
COMMENT ON TABLE makeup_schedule IS 'owner:portal';

-- Shuttle Schedule
CREATE TABLE IF NOT EXISTS shuttle_schedule (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  venue_id uuid NOT NULL REFERENCES venues(id) ON DELETE CASCADE,
  wedding_id uuid NOT NULL REFERENCES weddings(id) ON DELETE CASCADE,
  route_name text NOT NULL,
  pickup_location text,
  dropoff_location text,
  departure_time timestamptz,
  capacity integer,
  notes text,
  created_at timestamptz DEFAULT now()
);
COMMENT ON TABLE shuttle_schedule IS 'owner:portal';

-- Rehearsal Dinner
CREATE TABLE IF NOT EXISTS rehearsal_dinner (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  venue_id uuid NOT NULL REFERENCES venues(id) ON DELETE CASCADE,
  wedding_id uuid NOT NULL REFERENCES weddings(id) ON DELETE CASCADE,
  location_name text,
  address text,
  date date,
  start_time time,
  end_time time,
  guest_count integer,
  menu_notes text,
  special_arrangements text,
  created_at timestamptz DEFAULT now()
);
COMMENT ON TABLE rehearsal_dinner IS 'owner:portal';

-- Decor Inventory
CREATE TABLE IF NOT EXISTS decor_inventory (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  venue_id uuid NOT NULL REFERENCES venues(id) ON DELETE CASCADE,
  wedding_id uuid NOT NULL REFERENCES weddings(id) ON DELETE CASCADE,
  item_name text NOT NULL,
  category text CHECK (category IN ('ceremony', 'reception', 'tables', 'entrance', 'other')),
  quantity integer DEFAULT 1,
  source text CHECK (source IN ('borrow', 'personal', 'vendor', 'diy')),
  vendor_name text,
  notes text,
  leaving_instructions text,
  created_at timestamptz DEFAULT now()
);
COMMENT ON TABLE decor_inventory IS 'owner:portal';

-- Staffing Assignments
CREATE TABLE IF NOT EXISTS staffing_assignments (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  venue_id uuid NOT NULL REFERENCES venues(id) ON DELETE CASCADE,
  wedding_id uuid NOT NULL REFERENCES weddings(id) ON DELETE CASCADE,
  role text CHECK (role IN ('bartender', 'server', 'runner', 'line_cook', 'coordinator', 'other')),
  person_name text,
  count integer DEFAULT 1,
  hourly_rate decimal,
  hours decimal,
  tip_amount decimal,
  notes text,
  created_at timestamptz DEFAULT now()
);
COMMENT ON TABLE staffing_assignments IS 'owner:portal';

-- Bedroom Assignments
CREATE TABLE IF NOT EXISTS bedroom_assignments (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  venue_id uuid NOT NULL REFERENCES venues(id) ON DELETE CASCADE,
  wedding_id uuid NOT NULL REFERENCES weddings(id) ON DELETE CASCADE,
  room_name text NOT NULL,
  room_description text,
  guests text[] DEFAULT '{}',
  notes text,
  created_at timestamptz DEFAULT now()
);
COMMENT ON TABLE bedroom_assignments IS 'owner:portal';


-- ============================================
-- SECTION 3: COUPLE ENHANCED FEATURES
-- ============================================

-- Allergy Registry
CREATE TABLE IF NOT EXISTS allergy_registry (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  venue_id uuid NOT NULL REFERENCES venues(id) ON DELETE CASCADE,
  wedding_id uuid NOT NULL REFERENCES weddings(id) ON DELETE CASCADE,
  guest_name text NOT NULL,
  allergy_type text NOT NULL,
  severity text CHECK (severity IN ('mild', 'moderate', 'severe', 'life_threatening')),
  notes text,
  is_important boolean DEFAULT false,
  created_at timestamptz DEFAULT now()
);
COMMENT ON TABLE allergy_registry IS 'owner:portal';

-- Guest Care Notes
CREATE TABLE IF NOT EXISTS guest_care_notes (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  venue_id uuid NOT NULL REFERENCES venues(id) ON DELETE CASCADE,
  wedding_id uuid NOT NULL REFERENCES weddings(id) ON DELETE CASCADE,
  guest_name text NOT NULL,
  care_type text CHECK (care_type IN ('mobility', 'dietary', 'family', 'vip', 'medical', 'other')),
  note text,
  created_at timestamptz DEFAULT now()
);
COMMENT ON TABLE guest_care_notes IS 'owner:portal';

-- Wedding Worksheets
CREATE TABLE IF NOT EXISTS wedding_worksheets (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  venue_id uuid NOT NULL REFERENCES venues(id) ON DELETE CASCADE,
  wedding_id uuid NOT NULL REFERENCES weddings(id) ON DELETE CASCADE,
  section text CHECK (section IN ('priorities', 'story', 'feelings', 'splurge', 'skip', 'memories')),
  content jsonb DEFAULT '{}',
  created_at timestamptz DEFAULT now(),
  updated_at timestamptz DEFAULT now()
);
COMMENT ON TABLE wedding_worksheets IS 'owner:portal';

-- Wedding Party
CREATE TABLE IF NOT EXISTS wedding_party (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  venue_id uuid NOT NULL REFERENCES venues(id) ON DELETE CASCADE,
  wedding_id uuid NOT NULL REFERENCES weddings(id) ON DELETE CASCADE,
  name text NOT NULL,
  role text CHECK (role IN ('maid_of_honor', 'best_man', 'bridesmaid', 'groomsman', 'flower_girl', 'ring_bearer', 'other')),
  side text CHECK (side IN ('bride', 'groom')),
  relationship text,
  bio text,
  photo_url text,
  sort_order integer,
  created_at timestamptz DEFAULT now()
);
COMMENT ON TABLE wedding_party IS 'owner:portal';

-- Photo Library
CREATE TABLE IF NOT EXISTS photo_library (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  venue_id uuid NOT NULL REFERENCES venues(id) ON DELETE CASCADE,
  wedding_id uuid REFERENCES weddings(id) ON DELETE SET NULL,
  image_url text NOT NULL,
  caption text,
  tags text[] DEFAULT '{}',
  is_website boolean DEFAULT false,
  uploaded_by uuid REFERENCES user_profiles(id) ON DELETE SET NULL,
  created_at timestamptz DEFAULT now()
);
COMMENT ON TABLE photo_library IS 'owner:portal';

-- Borrow Catalog (venue-level, not per-wedding)
CREATE TABLE IF NOT EXISTS borrow_catalog (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  venue_id uuid NOT NULL REFERENCES venues(id) ON DELETE CASCADE,
  item_name text NOT NULL,
  category text CHECK (category IN ('arbor', 'candelabra', 'votive', 'hurricane', 'cake_stand', 'card_box', 'table_numbers', 'signs', 'vases', 'runners', 'florals', 'other')),
  description text,
  image_url text,
  quantity_available integer DEFAULT 1,
  is_active boolean DEFAULT true,
  created_at timestamptz DEFAULT now()
);
COMMENT ON TABLE borrow_catalog IS 'owner:portal';

-- Borrow Selections (per-wedding picks from catalog)
CREATE TABLE IF NOT EXISTS borrow_selections (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  venue_id uuid NOT NULL REFERENCES venues(id) ON DELETE CASCADE,
  wedding_id uuid NOT NULL REFERENCES weddings(id) ON DELETE CASCADE,
  catalog_item_id uuid NOT NULL REFERENCES borrow_catalog(id) ON DELETE CASCADE,
  quantity integer DEFAULT 1,
  notes text,
  created_at timestamptz DEFAULT now()
);
COMMENT ON TABLE borrow_selections IS 'owner:portal';

-- Accommodations (venue-level recommended lodging)
CREATE TABLE IF NOT EXISTS accommodations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  venue_id uuid NOT NULL REFERENCES venues(id) ON DELETE CASCADE,
  name text NOT NULL,
  type text CHECK (type IN ('hotel', 'airbnb', 'vrbo', 'boutique', 'inn')),
  address text,
  website_url text,
  price_per_night decimal,
  distance_miles decimal,
  description text,
  is_recommended boolean DEFAULT true,
  sort_order integer,
  created_at timestamptz DEFAULT now()
);
COMMENT ON TABLE accommodations IS 'owner:portal';

-- Onboarding Progress
CREATE TABLE IF NOT EXISTS onboarding_progress (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  venue_id uuid NOT NULL REFERENCES venues(id) ON DELETE CASCADE,
  wedding_id uuid NOT NULL REFERENCES weddings(id) ON DELETE CASCADE,
  step text CHECK (step IN ('photo', 'chat', 'vendor', 'inspo', 'checklist')),
  completed boolean DEFAULT false,
  completed_at timestamptz,
  created_at timestamptz DEFAULT now()
);
COMMENT ON TABLE onboarding_progress IS 'owner:portal';

-- Section Finalisations
CREATE TABLE IF NOT EXISTS section_finalisations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  venue_id uuid NOT NULL REFERENCES venues(id) ON DELETE CASCADE,
  wedding_id uuid NOT NULL REFERENCES weddings(id) ON DELETE CASCADE,
  section_name text NOT NULL,
  couple_signed_off boolean DEFAULT false,
  couple_signed_off_at timestamptz,
  couple_signed_off_by uuid REFERENCES user_profiles(id) ON DELETE SET NULL,
  staff_signed_off boolean DEFAULT false,
  staff_signed_off_at timestamptz,
  staff_signed_off_by uuid REFERENCES user_profiles(id) ON DELETE SET NULL,
  created_at timestamptz DEFAULT now()
);
COMMENT ON TABLE section_finalisations IS 'owner:portal';


-- ============================================
-- SECTION 4: COUPLE GUEST ENHANCEMENTS
-- ============================================

-- Guest Tags
CREATE TABLE IF NOT EXISTS guest_tags (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  venue_id uuid NOT NULL REFERENCES venues(id) ON DELETE CASCADE,
  wedding_id uuid NOT NULL REFERENCES weddings(id) ON DELETE CASCADE,
  tag_name text NOT NULL,
  color text,
  created_at timestamptz DEFAULT now()
);
COMMENT ON TABLE guest_tags IS 'owner:portal';

-- Guest Tag Assignments
CREATE TABLE IF NOT EXISTS guest_tag_assignments (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  guest_id uuid NOT NULL REFERENCES guest_list(id) ON DELETE CASCADE,
  tag_id uuid NOT NULL REFERENCES guest_tags(id) ON DELETE CASCADE,
  created_at timestamptz DEFAULT now()
);
COMMENT ON TABLE guest_tag_assignments IS 'owner:portal';

-- Guest Meal Options
CREATE TABLE IF NOT EXISTS guest_meal_options (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  venue_id uuid NOT NULL REFERENCES venues(id) ON DELETE CASCADE,
  wedding_id uuid NOT NULL REFERENCES weddings(id) ON DELETE CASCADE,
  option_name text NOT NULL,
  description text,
  is_default boolean DEFAULT false,
  created_at timestamptz DEFAULT now()
);
COMMENT ON TABLE guest_meal_options IS 'owner:portal';

-- Now add the FK from guest_list.meal_option_id to guest_meal_options
-- (column was added above, FK added after target table exists)
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.table_constraints
    WHERE constraint_name = 'fk_guest_list_meal_option'
  ) THEN
    ALTER TABLE guest_list
      ADD CONSTRAINT fk_guest_list_meal_option
      FOREIGN KEY (meal_option_id) REFERENCES guest_meal_options(id) ON DELETE SET NULL;
  END IF;
END $$;


-- ============================================
-- SECTION 5: COUPLE WEBSITE ENHANCEMENTS
-- ============================================

-- Wedding Website Settings
CREATE TABLE IF NOT EXISTS wedding_website_settings (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  venue_id uuid NOT NULL REFERENCES venues(id) ON DELETE CASCADE,
  wedding_id uuid NOT NULL REFERENCES weddings(id) ON DELETE CASCADE,
  slug text UNIQUE,
  is_published boolean DEFAULT false,
  theme text DEFAULT 'classic' CHECK (theme IN ('classic', 'modern', 'garden', 'romantic', 'rustic')),
  accent_color text,
  couple_names text,
  sections_order text[] DEFAULT '{}',
  sections_enabled jsonb DEFAULT '{}',
  our_story text,
  dress_code text,
  registry_links jsonb DEFAULT '[]',
  faq jsonb DEFAULT '[]',
  things_to_do jsonb DEFAULT '{}',
  created_at timestamptz DEFAULT now(),
  updated_at timestamptz DEFAULT now()
);
COMMENT ON TABLE wedding_website_settings IS 'owner:portal';


-- ============================================
-- SECTION 6: INTELLIGENCE ENTERPRISE
-- ============================================

-- Tours
CREATE TABLE IF NOT EXISTS tours (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  venue_id uuid NOT NULL REFERENCES venues(id) ON DELETE CASCADE,
  wedding_id uuid REFERENCES weddings(id) ON DELETE SET NULL,
  scheduled_at timestamptz,
  tour_type text CHECK (tour_type IN ('in_person', 'virtual', 'phone')),
  conducted_by uuid REFERENCES user_profiles(id) ON DELETE SET NULL,
  source text,
  outcome text CHECK (outcome IN ('completed', 'cancelled', 'no_show', 'rescheduled')),
  booking_date date,
  competing_venues text[] DEFAULT '{}',
  notes text,
  created_at timestamptz DEFAULT now()
);
COMMENT ON TABLE tours IS 'owner:intelligence';

-- Lost Deals
CREATE TABLE IF NOT EXISTS lost_deals (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  venue_id uuid NOT NULL REFERENCES venues(id) ON DELETE CASCADE,
  wedding_id uuid REFERENCES weddings(id) ON DELETE SET NULL,
  lost_at_stage text CHECK (lost_at_stage IN ('inquiry', 'tour', 'hold', 'contract')),
  reason_category text CHECK (reason_category IN ('no_response', 'pricing', 'competitor', 'date_unavailable', 'ghosted', 'changed_plans', 'venue_mismatch', 'budget_change', 'other')),
  reason_detail text,
  competitor_name text,
  recovery_attempted boolean DEFAULT false,
  recovery_outcome text,
  lost_at timestamptz,
  created_at timestamptz DEFAULT now()
);
COMMENT ON TABLE lost_deals IS 'owner:intelligence';

-- Campaigns
CREATE TABLE IF NOT EXISTS campaigns (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  venue_id uuid NOT NULL REFERENCES venues(id) ON DELETE CASCADE,
  name text NOT NULL,
  channel text,
  start_date date,
  end_date date,
  spend decimal DEFAULT 0,
  inquiries_attributed integer DEFAULT 0,
  tours_attributed integer DEFAULT 0,
  bookings_attributed integer DEFAULT 0,
  revenue_attributed decimal DEFAULT 0,
  cost_per_inquiry decimal,
  cost_per_booking decimal,
  roi_ratio decimal,
  notes text,
  created_at timestamptz DEFAULT now()
);
COMMENT ON TABLE campaigns IS 'owner:intelligence';

-- Social Posts
CREATE TABLE IF NOT EXISTS social_posts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  venue_id uuid NOT NULL REFERENCES venues(id) ON DELETE CASCADE,
  platform text CHECK (platform IN ('instagram', 'facebook', 'tiktok', 'pinterest', 'youtube')),
  posted_at timestamptz,
  caption text,
  post_url text,
  reach integer DEFAULT 0,
  impressions integer DEFAULT 0,
  saves integer DEFAULT 0,
  shares integer DEFAULT 0,
  comments integer DEFAULT 0,
  likes integer DEFAULT 0,
  website_clicks integer DEFAULT 0,
  profile_visits integer DEFAULT 0,
  engagement_rate decimal,
  is_viral boolean DEFAULT false,
  created_at timestamptz DEFAULT now()
);
COMMENT ON TABLE social_posts IS 'owner:intelligence';

-- Annotations
CREATE TABLE IF NOT EXISTS annotations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  venue_id uuid NOT NULL REFERENCES venues(id) ON DELETE CASCADE,
  annotation_type text CHECK (annotation_type IN ('system_detected', 'proactive', 'reactive', 'anomaly_response')),
  period_start date,
  period_end date,
  title text NOT NULL,
  description text,
  affects_metrics text[] DEFAULT '{}',
  anomaly_id uuid REFERENCES anomaly_alerts(id) ON DELETE SET NULL,
  created_by uuid REFERENCES user_profiles(id) ON DELETE SET NULL,
  response_category text,
  exclude_from_patterns boolean DEFAULT false,
  created_at timestamptz DEFAULT now()
);
COMMENT ON TABLE annotations IS 'owner:intelligence';

-- Venue Health
CREATE TABLE IF NOT EXISTS venue_health (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  venue_id uuid NOT NULL REFERENCES venues(id) ON DELETE CASCADE,
  calculated_at timestamptz DEFAULT now(),
  overall_score decimal,
  data_quality_score decimal,
  pipeline_score decimal,
  response_time_score decimal,
  booking_rate_score decimal,
  created_at timestamptz DEFAULT now()
);
COMMENT ON TABLE venue_health IS 'owner:intelligence';

-- Client Match Queue
CREATE TABLE IF NOT EXISTS client_match_queue (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  venue_id uuid NOT NULL REFERENCES venues(id) ON DELETE CASCADE,
  client_a_id uuid,
  client_b_id uuid,
  match_type text CHECK (match_type IN ('email', 'phone', 'name')),
  confidence decimal,
  status text DEFAULT 'pending' CHECK (status IN ('pending', 'merged', 'dismissed')),
  resolved_by uuid REFERENCES user_profiles(id) ON DELETE SET NULL,
  resolved_at timestamptz,
  created_at timestamptz DEFAULT now()
);
COMMENT ON TABLE client_match_queue IS 'owner:intelligence';


-- ============================================
-- SECTION 7: AGENT DEPTH
-- ============================================

-- Knowledge Gaps
CREATE TABLE IF NOT EXISTS knowledge_gaps (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  venue_id uuid NOT NULL REFERENCES venues(id) ON DELETE CASCADE,
  question text NOT NULL,
  category text,
  frequency integer DEFAULT 1,
  status text DEFAULT 'open' CHECK (status IN ('open', 'resolved')),
  resolution text,
  resolved_at timestamptz,
  created_at timestamptz DEFAULT now()
);
COMMENT ON TABLE knowledge_gaps IS 'owner:agent';

-- Follow-Up Sequence Templates
CREATE TABLE IF NOT EXISTS follow_up_sequence_templates (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  venue_id uuid NOT NULL REFERENCES venues(id) ON DELETE CASCADE,
  name text NOT NULL,
  trigger text CHECK (trigger IN ('new_inquiry', 'no_response', 'post_tour', 'post_hold')),
  steps jsonb DEFAULT '[]',
  is_active boolean DEFAULT true,
  created_at timestamptz DEFAULT now()
);
COMMENT ON TABLE follow_up_sequence_templates IS 'owner:agent';

-- Wedding Sequences (active sequence instances)
CREATE TABLE IF NOT EXISTS wedding_sequences (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  venue_id uuid NOT NULL REFERENCES venues(id) ON DELETE CASCADE,
  wedding_id uuid NOT NULL REFERENCES weddings(id) ON DELETE CASCADE,
  template_id uuid REFERENCES follow_up_sequence_templates(id) ON DELETE SET NULL,
  status text DEFAULT 'active' CHECK (status IN ('active', 'paused', 'completed', 'cancelled')),
  enrolled_at timestamptz DEFAULT now(),
  paused_at timestamptz,
  completed_at timestamptz,
  current_step integer DEFAULT 0,
  created_at timestamptz DEFAULT now()
);
COMMENT ON TABLE wedding_sequences IS 'owner:agent';

-- Relationships
CREATE TABLE IF NOT EXISTS relationships (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  venue_id uuid NOT NULL REFERENCES venues(id) ON DELETE CASCADE,
  person_a_id uuid REFERENCES people(id) ON DELETE CASCADE,
  person_b_id uuid REFERENCES people(id) ON DELETE CASCADE,
  relationship_type text CHECK (relationship_type IN ('partner', 'parent', 'sibling', 'friend', 'vendor', 'planner')),
  notes text,
  created_at timestamptz DEFAULT now()
);
COMMENT ON TABLE relationships IS 'owner:agent';

-- Client Codes
CREATE TABLE IF NOT EXISTS client_codes (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  venue_id uuid NOT NULL REFERENCES venues(id) ON DELETE CASCADE,
  wedding_id uuid UNIQUE REFERENCES weddings(id) ON DELETE CASCADE,
  code text UNIQUE NOT NULL,
  format_template text,
  created_at timestamptz DEFAULT now()
);
COMMENT ON TABLE client_codes IS 'owner:agent';

-- Error Logs
CREATE TABLE IF NOT EXISTS error_logs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  venue_id uuid REFERENCES venues(id) ON DELETE SET NULL,
  error_type text,
  message text,
  stack_trace text,
  context jsonb DEFAULT '{}',
  resolved boolean DEFAULT false,
  resolved_by uuid REFERENCES user_profiles(id) ON DELETE SET NULL,
  resolved_at timestamptz,
  created_at timestamptz DEFAULT now()
);
COMMENT ON TABLE error_logs IS 'owner:platform';

-- Notification Tokens
CREATE TABLE IF NOT EXISTS notification_tokens (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES user_profiles(id) ON DELETE CASCADE,
  token text NOT NULL,
  platform text CHECK (platform IN ('web', 'ios', 'android')),
  created_at timestamptz DEFAULT now()
);
COMMENT ON TABLE notification_tokens IS 'owner:platform';


-- ============================================
-- SECTION 8: INDEXES
-- ============================================

-- Bar Planning
CREATE INDEX IF NOT EXISTS idx_bar_planning_venue_id ON bar_planning(venue_id);
CREATE INDEX IF NOT EXISTS idx_bar_planning_wedding_id ON bar_planning(wedding_id);

-- Bar Recipes
CREATE INDEX IF NOT EXISTS idx_bar_recipes_venue_id ON bar_recipes(venue_id);
CREATE INDEX IF NOT EXISTS idx_bar_recipes_wedding_id ON bar_recipes(wedding_id);

-- Bar Shopping List
CREATE INDEX IF NOT EXISTS idx_bar_shopping_list_venue_id ON bar_shopping_list(venue_id);
CREATE INDEX IF NOT EXISTS idx_bar_shopping_list_wedding_id ON bar_shopping_list(wedding_id);

-- Ceremony Order
CREATE INDEX IF NOT EXISTS idx_ceremony_order_venue_id ON ceremony_order(venue_id);
CREATE INDEX IF NOT EXISTS idx_ceremony_order_wedding_id ON ceremony_order(wedding_id);

-- Makeup Schedule
CREATE INDEX IF NOT EXISTS idx_makeup_schedule_venue_id ON makeup_schedule(venue_id);
CREATE INDEX IF NOT EXISTS idx_makeup_schedule_wedding_id ON makeup_schedule(wedding_id);

-- Shuttle Schedule
CREATE INDEX IF NOT EXISTS idx_shuttle_schedule_venue_id ON shuttle_schedule(venue_id);
CREATE INDEX IF NOT EXISTS idx_shuttle_schedule_wedding_id ON shuttle_schedule(wedding_id);

-- Rehearsal Dinner
CREATE INDEX IF NOT EXISTS idx_rehearsal_dinner_venue_id ON rehearsal_dinner(venue_id);
CREATE INDEX IF NOT EXISTS idx_rehearsal_dinner_wedding_id ON rehearsal_dinner(wedding_id);

-- Decor Inventory
CREATE INDEX IF NOT EXISTS idx_decor_inventory_venue_id ON decor_inventory(venue_id);
CREATE INDEX IF NOT EXISTS idx_decor_inventory_wedding_id ON decor_inventory(wedding_id);

-- Staffing Assignments
CREATE INDEX IF NOT EXISTS idx_staffing_assignments_venue_id ON staffing_assignments(venue_id);
CREATE INDEX IF NOT EXISTS idx_staffing_assignments_wedding_id ON staffing_assignments(wedding_id);

-- Bedroom Assignments
CREATE INDEX IF NOT EXISTS idx_bedroom_assignments_venue_id ON bedroom_assignments(venue_id);
CREATE INDEX IF NOT EXISTS idx_bedroom_assignments_wedding_id ON bedroom_assignments(wedding_id);

-- Allergy Registry
CREATE INDEX IF NOT EXISTS idx_allergy_registry_venue_id ON allergy_registry(venue_id);
CREATE INDEX IF NOT EXISTS idx_allergy_registry_wedding_id ON allergy_registry(wedding_id);

-- Guest Care Notes
CREATE INDEX IF NOT EXISTS idx_guest_care_notes_venue_id ON guest_care_notes(venue_id);
CREATE INDEX IF NOT EXISTS idx_guest_care_notes_wedding_id ON guest_care_notes(wedding_id);

-- Wedding Worksheets
CREATE INDEX IF NOT EXISTS idx_wedding_worksheets_venue_id ON wedding_worksheets(venue_id);
CREATE INDEX IF NOT EXISTS idx_wedding_worksheets_wedding_id ON wedding_worksheets(wedding_id);

-- Wedding Party
CREATE INDEX IF NOT EXISTS idx_wedding_party_venue_id ON wedding_party(venue_id);
CREATE INDEX IF NOT EXISTS idx_wedding_party_wedding_id ON wedding_party(wedding_id);

-- Photo Library
CREATE INDEX IF NOT EXISTS idx_photo_library_venue_id ON photo_library(venue_id);
CREATE INDEX IF NOT EXISTS idx_photo_library_wedding_id ON photo_library(wedding_id);

-- Borrow Catalog
CREATE INDEX IF NOT EXISTS idx_borrow_catalog_venue_id ON borrow_catalog(venue_id);

-- Borrow Selections
CREATE INDEX IF NOT EXISTS idx_borrow_selections_venue_id ON borrow_selections(venue_id);
CREATE INDEX IF NOT EXISTS idx_borrow_selections_wedding_id ON borrow_selections(wedding_id);
CREATE INDEX IF NOT EXISTS idx_borrow_selections_catalog_item_id ON borrow_selections(catalog_item_id);

-- Accommodations
CREATE INDEX IF NOT EXISTS idx_accommodations_venue_id ON accommodations(venue_id);

-- Onboarding Progress
CREATE INDEX IF NOT EXISTS idx_onboarding_progress_venue_id ON onboarding_progress(venue_id);
CREATE INDEX IF NOT EXISTS idx_onboarding_progress_wedding_id ON onboarding_progress(wedding_id);

-- Section Finalisations
CREATE INDEX IF NOT EXISTS idx_section_finalisations_venue_id ON section_finalisations(venue_id);
CREATE INDEX IF NOT EXISTS idx_section_finalisations_wedding_id ON section_finalisations(wedding_id);

-- Guest Tags
CREATE INDEX IF NOT EXISTS idx_guest_tags_venue_id ON guest_tags(venue_id);
CREATE INDEX IF NOT EXISTS idx_guest_tags_wedding_id ON guest_tags(wedding_id);

-- Guest Tag Assignments
CREATE INDEX IF NOT EXISTS idx_guest_tag_assignments_guest_id ON guest_tag_assignments(guest_id);
CREATE INDEX IF NOT EXISTS idx_guest_tag_assignments_tag_id ON guest_tag_assignments(tag_id);

-- Guest Meal Options
CREATE INDEX IF NOT EXISTS idx_guest_meal_options_venue_id ON guest_meal_options(venue_id);
CREATE INDEX IF NOT EXISTS idx_guest_meal_options_wedding_id ON guest_meal_options(wedding_id);

-- Wedding Website Settings
CREATE INDEX IF NOT EXISTS idx_wedding_website_settings_venue_id ON wedding_website_settings(venue_id);
CREATE INDEX IF NOT EXISTS idx_wedding_website_settings_wedding_id ON wedding_website_settings(wedding_id);
CREATE INDEX IF NOT EXISTS idx_wedding_website_settings_slug ON wedding_website_settings(slug);

-- Tours
CREATE INDEX IF NOT EXISTS idx_tours_venue_id ON tours(venue_id);
CREATE INDEX IF NOT EXISTS idx_tours_wedding_id ON tours(wedding_id);
CREATE INDEX IF NOT EXISTS idx_tours_scheduled_at ON tours(venue_id, scheduled_at);

-- Lost Deals
CREATE INDEX IF NOT EXISTS idx_lost_deals_venue_id ON lost_deals(venue_id);
CREATE INDEX IF NOT EXISTS idx_lost_deals_wedding_id ON lost_deals(wedding_id);
CREATE INDEX IF NOT EXISTS idx_lost_deals_reason ON lost_deals(venue_id, reason_category);

-- Campaigns
CREATE INDEX IF NOT EXISTS idx_campaigns_venue_id ON campaigns(venue_id);
CREATE INDEX IF NOT EXISTS idx_campaigns_dates ON campaigns(venue_id, start_date, end_date);

-- Social Posts
CREATE INDEX IF NOT EXISTS idx_social_posts_venue_id ON social_posts(venue_id);
CREATE INDEX IF NOT EXISTS idx_social_posts_platform ON social_posts(venue_id, platform);
CREATE INDEX IF NOT EXISTS idx_social_posts_posted_at ON social_posts(venue_id, posted_at);

-- Annotations
CREATE INDEX IF NOT EXISTS idx_annotations_venue_id ON annotations(venue_id);
CREATE INDEX IF NOT EXISTS idx_annotations_anomaly_id ON annotations(anomaly_id);
CREATE INDEX IF NOT EXISTS idx_annotations_period ON annotations(venue_id, period_start, period_end);

-- Venue Health
CREATE INDEX IF NOT EXISTS idx_venue_health_venue_id ON venue_health(venue_id);
CREATE INDEX IF NOT EXISTS idx_venue_health_calculated_at ON venue_health(venue_id, calculated_at);

-- Client Match Queue
CREATE INDEX IF NOT EXISTS idx_client_match_queue_venue_id ON client_match_queue(venue_id);
CREATE INDEX IF NOT EXISTS idx_client_match_queue_status ON client_match_queue(venue_id, status);

-- Knowledge Gaps
CREATE INDEX IF NOT EXISTS idx_knowledge_gaps_venue_id ON knowledge_gaps(venue_id);
CREATE INDEX IF NOT EXISTS idx_knowledge_gaps_status ON knowledge_gaps(venue_id, status);

-- Follow-Up Sequence Templates
CREATE INDEX IF NOT EXISTS idx_follow_up_sequence_templates_venue_id ON follow_up_sequence_templates(venue_id);

-- Wedding Sequences
CREATE INDEX IF NOT EXISTS idx_wedding_sequences_venue_id ON wedding_sequences(venue_id);
CREATE INDEX IF NOT EXISTS idx_wedding_sequences_wedding_id ON wedding_sequences(wedding_id);
CREATE INDEX IF NOT EXISTS idx_wedding_sequences_status ON wedding_sequences(venue_id, status);

-- Relationships
CREATE INDEX IF NOT EXISTS idx_relationships_venue_id ON relationships(venue_id);
CREATE INDEX IF NOT EXISTS idx_relationships_person_a ON relationships(person_a_id);
CREATE INDEX IF NOT EXISTS idx_relationships_person_b ON relationships(person_b_id);

-- Client Codes
CREATE INDEX IF NOT EXISTS idx_client_codes_venue_id ON client_codes(venue_id);
CREATE INDEX IF NOT EXISTS idx_client_codes_code ON client_codes(code);

-- Error Logs
CREATE INDEX IF NOT EXISTS idx_error_logs_venue_id ON error_logs(venue_id);
CREATE INDEX IF NOT EXISTS idx_error_logs_created_at ON error_logs(created_at);
CREATE INDEX IF NOT EXISTS idx_error_logs_resolved ON error_logs(resolved);

-- Notification Tokens
CREATE INDEX IF NOT EXISTS idx_notification_tokens_user_id ON notification_tokens(user_id);
