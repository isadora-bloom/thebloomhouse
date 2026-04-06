-- ============================================
-- 001: SHARED TABLES
-- Owner: platform (read by all three products)
-- ============================================

-- Organisations (for multi-venue groups)
CREATE TABLE IF NOT EXISTS organisations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text NOT NULL,
  owner_id uuid,
  plan_tier text DEFAULT 'starter',
  stripe_customer_id text,
  created_at timestamptz DEFAULT now()
);

-- Venues
CREATE TABLE IF NOT EXISTS venues (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text NOT NULL,
  slug text UNIQUE NOT NULL,
  org_id uuid REFERENCES organisations(id),
  plan_tier text DEFAULT 'starter' CHECK (plan_tier IN ('starter', 'intelligence', 'enterprise')),
  status text DEFAULT 'trial' CHECK (status IN ('active', 'trial', 'suspended', 'churned')),
  created_at timestamptz DEFAULT now(),
  updated_at timestamptz DEFAULT now()
);

-- Venue Config
CREATE TABLE IF NOT EXISTS venue_config (
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

-- Venue AI Config (THE PERSONALITY ENGINE TABLE)
CREATE TABLE IF NOT EXISTS venue_ai_config (
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

-- Users (extends Supabase auth.users)
CREATE TABLE IF NOT EXISTS user_profiles (
  id uuid PRIMARY KEY,
  venue_id uuid REFERENCES venues(id),
  org_id uuid REFERENCES organisations(id),
  role text NOT NULL DEFAULT 'coordinator' CHECK (role IN ('super_admin', 'org_admin', 'venue_manager', 'coordinator', 'couple')),
  first_name text,
  last_name text,
  avatar_url text,
  created_at timestamptz DEFAULT now()
);

-- Weddings
CREATE TABLE IF NOT EXISTS weddings (
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

-- People
CREATE TABLE IF NOT EXISTS people (
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

-- Contacts
CREATE TABLE IF NOT EXISTS contacts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  person_id uuid NOT NULL REFERENCES people(id) ON DELETE CASCADE,
  type text NOT NULL CHECK (type IN ('email', 'phone', 'instagram')),
  value text NOT NULL,
  is_primary boolean DEFAULT false,
  created_at timestamptz DEFAULT now()
);

-- Knowledge Base
CREATE TABLE IF NOT EXISTS knowledge_base (
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

-- Booked Dates
CREATE TABLE IF NOT EXISTS booked_dates (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  venue_id uuid NOT NULL REFERENCES venues(id) ON DELETE CASCADE,
  date date NOT NULL,
  wedding_id uuid REFERENCES weddings(id) ON DELETE SET NULL,
  block_type text DEFAULT 'wedding' CHECK (block_type IN ('wedding', 'private_event', 'maintenance', 'hold')),
  notes text,
  created_at timestamptz DEFAULT now()
);

-- Indexes
CREATE INDEX IF NOT EXISTS idx_weddings_venue_id ON weddings(venue_id);
CREATE INDEX IF NOT EXISTS idx_weddings_status ON weddings(status);
CREATE INDEX IF NOT EXISTS idx_weddings_source ON weddings(source);
CREATE INDEX IF NOT EXISTS idx_people_venue_id ON people(venue_id);
CREATE INDEX IF NOT EXISTS idx_people_wedding_id ON people(wedding_id);
CREATE INDEX IF NOT EXISTS idx_contacts_person_id ON contacts(person_id);
CREATE INDEX IF NOT EXISTS idx_contacts_value ON contacts(value);
CREATE INDEX IF NOT EXISTS idx_knowledge_base_venue_id ON knowledge_base(venue_id);
CREATE INDEX IF NOT EXISTS idx_booked_dates_venue_id_date ON booked_dates(venue_id, date);
CREATE INDEX IF NOT EXISTS idx_user_profiles_venue_id ON user_profiles(venue_id);
-- ============================================
-- 002: AGENT-OWNED TABLES
-- Owner: agent (email pipeline, drafts, lead scoring, learning)
-- Depends on: 001_shared_tables.sql
-- ============================================

-- Interactions — every email/call/voicemail
CREATE TABLE IF NOT EXISTS interactions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  venue_id uuid NOT NULL REFERENCES venues(id) ON DELETE CASCADE,
  wedding_id uuid REFERENCES weddings(id) ON DELETE SET NULL,
  person_id uuid REFERENCES people(id) ON DELETE SET NULL,
  type text NOT NULL CHECK (type IN ('email', 'call', 'voicemail', 'sms')),
  direction text NOT NULL CHECK (direction IN ('inbound', 'outbound')),
  subject text,
  body_preview text,
  full_body text,
  gmail_message_id text,
  gmail_thread_id text,
  timestamp timestamptz NOT NULL DEFAULT now(),
  created_at timestamptz DEFAULT now()
);

-- Drafts — AI-generated responses
CREATE TABLE IF NOT EXISTS drafts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  venue_id uuid NOT NULL REFERENCES venues(id) ON DELETE CASCADE,
  wedding_id uuid REFERENCES weddings(id) ON DELETE SET NULL,
  interaction_id uuid REFERENCES interactions(id) ON DELETE SET NULL,
  to_email text,
  subject text,
  draft_body text NOT NULL,
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'approved', 'rejected', 'sent')),
  context_type text CHECK (context_type IN ('inquiry', 'client')),
  brain_used text,
  model_used text,
  tokens_used integer,
  cost decimal,
  confidence_score integer,
  auto_sent boolean DEFAULT false,
  auto_send_source text,
  feedback_notes text,
  approved_by uuid REFERENCES user_profiles(id) ON DELETE SET NULL,
  approved_at timestamptz,
  created_at timestamptz DEFAULT now()
);

-- Engagement Events — lead scoring events
CREATE TABLE IF NOT EXISTS engagement_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  venue_id uuid NOT NULL REFERENCES venues(id) ON DELETE CASCADE,
  wedding_id uuid REFERENCES weddings(id) ON DELETE SET NULL,
  event_type text NOT NULL,
  points integer NOT NULL DEFAULT 0,
  metadata jsonb DEFAULT '{}',
  created_at timestamptz DEFAULT now()
);

-- Lead Score History — score snapshots
CREATE TABLE IF NOT EXISTS lead_score_history (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  venue_id uuid NOT NULL REFERENCES venues(id) ON DELETE CASCADE,
  wedding_id uuid NOT NULL REFERENCES weddings(id) ON DELETE CASCADE,
  score integer NOT NULL,
  temperature_tier text,
  calculated_at timestamptz DEFAULT now()
);

-- Heat Score Config — per-venue event point values
CREATE TABLE IF NOT EXISTS heat_score_config (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  venue_id uuid NOT NULL REFERENCES venues(id) ON DELETE CASCADE,
  event_type text NOT NULL,
  points integer NOT NULL DEFAULT 0,
  decay_rate decimal
);

-- Draft Feedback — learning from coordinator approvals/edits/rejections
CREATE TABLE IF NOT EXISTS draft_feedback (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  venue_id uuid NOT NULL REFERENCES venues(id) ON DELETE CASCADE,
  draft_id uuid NOT NULL REFERENCES drafts(id) ON DELETE CASCADE,
  action text NOT NULL CHECK (action IN ('approved', 'edited', 'rejected')),
  original_body text,
  edited_body text,
  rejection_reason text,
  coordinator_edits text,
  created_at timestamptz DEFAULT now()
);

-- Learned Preferences — aggregated patterns from feedback
CREATE TABLE IF NOT EXISTS learned_preferences (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  venue_id uuid NOT NULL REFERENCES venues(id) ON DELETE CASCADE,
  preference_type text NOT NULL,
  pattern text NOT NULL,
  confidence float,
  created_at timestamptz DEFAULT now()
);

-- Auto Send Rules — autonomous sending configuration
CREATE TABLE IF NOT EXISTS auto_send_rules (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  venue_id uuid NOT NULL REFERENCES venues(id) ON DELETE CASCADE,
  context text NOT NULL CHECK (context IN ('inquiry', 'client')),
  source text,
  enabled boolean DEFAULT false,
  confidence_threshold float DEFAULT 0.85,
  daily_limit integer DEFAULT 5,
  require_new_contact boolean DEFAULT true
);

-- Intelligence Extractions — structured data extracted from emails
CREATE TABLE IF NOT EXISTS intelligence_extractions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  venue_id uuid NOT NULL REFERENCES venues(id) ON DELETE CASCADE,
  wedding_id uuid REFERENCES weddings(id) ON DELETE SET NULL,
  interaction_id uuid REFERENCES interactions(id) ON DELETE SET NULL,
  extraction_type text NOT NULL,
  value text,
  confidence float,
  created_at timestamptz DEFAULT now()
);

-- Email Sync State — Gmail cursor per venue
CREATE TABLE IF NOT EXISTS email_sync_state (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  venue_id uuid NOT NULL REFERENCES venues(id) ON DELETE CASCADE UNIQUE,
  last_history_id text,
  last_sync_at timestamptz,
  status text,
  error_message text
);

-- API Costs — per-call cost tracking
CREATE TABLE IF NOT EXISTS api_costs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  venue_id uuid REFERENCES venues(id) ON DELETE SET NULL,
  service text NOT NULL,
  model text,
  input_tokens integer,
  output_tokens integer,
  cost decimal,
  context text,
  created_at timestamptz DEFAULT now()
);

-- ============================================
-- INDEXES
-- ============================================

-- interactions
CREATE INDEX IF NOT EXISTS idx_interactions_venue_id ON interactions(venue_id);
CREATE INDEX IF NOT EXISTS idx_interactions_wedding_id ON interactions(wedding_id);
CREATE INDEX IF NOT EXISTS idx_interactions_gmail_message_id ON interactions(gmail_message_id);
CREATE INDEX IF NOT EXISTS idx_interactions_gmail_thread_id ON interactions(gmail_thread_id);
CREATE INDEX IF NOT EXISTS idx_interactions_timestamp ON interactions(timestamp);

-- drafts
CREATE INDEX IF NOT EXISTS idx_drafts_venue_id ON drafts(venue_id);
CREATE INDEX IF NOT EXISTS idx_drafts_wedding_id ON drafts(wedding_id);
CREATE INDEX IF NOT EXISTS idx_drafts_interaction_id ON drafts(interaction_id);
CREATE INDEX IF NOT EXISTS idx_drafts_status ON drafts(status);

-- engagement_events
CREATE INDEX IF NOT EXISTS idx_engagement_events_venue_id ON engagement_events(venue_id);
CREATE INDEX IF NOT EXISTS idx_engagement_events_wedding_id ON engagement_events(wedding_id);

-- lead_score_history
CREATE INDEX IF NOT EXISTS idx_lead_score_history_venue_id ON lead_score_history(venue_id);
CREATE INDEX IF NOT EXISTS idx_lead_score_history_wedding_id ON lead_score_history(wedding_id);

-- heat_score_config
CREATE INDEX IF NOT EXISTS idx_heat_score_config_venue_id ON heat_score_config(venue_id);

-- draft_feedback
CREATE INDEX IF NOT EXISTS idx_draft_feedback_venue_id ON draft_feedback(venue_id);
CREATE INDEX IF NOT EXISTS idx_draft_feedback_draft_id ON draft_feedback(draft_id);

-- learned_preferences
CREATE INDEX IF NOT EXISTS idx_learned_preferences_venue_id ON learned_preferences(venue_id);

-- auto_send_rules
CREATE INDEX IF NOT EXISTS idx_auto_send_rules_venue_id ON auto_send_rules(venue_id);

-- intelligence_extractions
CREATE INDEX IF NOT EXISTS idx_intelligence_extractions_venue_id ON intelligence_extractions(venue_id);
CREATE INDEX IF NOT EXISTS idx_intelligence_extractions_wedding_id ON intelligence_extractions(wedding_id);

-- email_sync_state
CREATE INDEX IF NOT EXISTS idx_email_sync_state_venue_id ON email_sync_state(venue_id);

-- api_costs
CREATE INDEX IF NOT EXISTS idx_api_costs_venue_id ON api_costs(venue_id);
CREATE INDEX IF NOT EXISTS idx_api_costs_service ON api_costs(service);
-- ============================================
-- 003: INTELLIGENCE-OWNED TABLES
-- Owner: intelligence (analytics, attribution, trends, recommendations)
-- Depends on: 001_shared_tables.sql
-- ============================================

-- Marketing Spend — monthly spend per source
CREATE TABLE IF NOT EXISTS marketing_spend (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  venue_id uuid NOT NULL REFERENCES venues(id) ON DELETE CASCADE,
  source text NOT NULL,
  month date NOT NULL,
  amount decimal NOT NULL DEFAULT 0,
  notes text,
  created_at timestamptz DEFAULT now(),
  updated_at timestamptz DEFAULT now()
);

-- Source Attribution — calculated ROI by source
CREATE TABLE IF NOT EXISTS source_attribution (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  venue_id uuid NOT NULL REFERENCES venues(id) ON DELETE CASCADE,
  source text NOT NULL,
  period_start date NOT NULL,
  period_end date NOT NULL,
  spend decimal,
  inquiries integer DEFAULT 0,
  tours integer DEFAULT 0,
  bookings integer DEFAULT 0,
  revenue decimal,
  cost_per_inquiry decimal,
  cost_per_booking decimal,
  conversion_rate decimal,
  roi decimal,
  calculated_at timestamptz DEFAULT now()
);

-- Search Trends — Google Trends data
CREATE TABLE IF NOT EXISTS search_trends (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  venue_id uuid NOT NULL REFERENCES venues(id) ON DELETE CASCADE,
  metro text,
  term text NOT NULL,
  week date NOT NULL,
  interest integer,
  created_at timestamptz DEFAULT now()
);

-- Trend Recommendations — proactive AI recommendations
CREATE TABLE IF NOT EXISTS trend_recommendations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  venue_id uuid NOT NULL REFERENCES venues(id) ON DELETE CASCADE,
  recommendation_type text NOT NULL,
  title text NOT NULL,
  body text,
  data_source text,
  supporting_data jsonb DEFAULT '{}',
  priority text DEFAULT 'medium',
  status text DEFAULT 'pending' CHECK (status IN ('pending', 'applied', 'dismissed')),
  applied_at timestamptz,
  dismissed_at timestamptz,
  created_at timestamptz DEFAULT now()
);

-- AI Briefings — weekly/monthly AI briefings
CREATE TABLE IF NOT EXISTS ai_briefings (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  venue_id uuid NOT NULL REFERENCES venues(id) ON DELETE CASCADE,
  briefing_type text NOT NULL CHECK (briefing_type IN ('weekly', 'monthly', 'anomaly')),
  content jsonb NOT NULL DEFAULT '{}',
  delivered_via text,
  delivered_at timestamptz,
  created_at timestamptz DEFAULT now()
);

-- Anomaly Alerts — metric deviation alerts
CREATE TABLE IF NOT EXISTS anomaly_alerts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  venue_id uuid NOT NULL REFERENCES venues(id) ON DELETE CASCADE,
  alert_type text NOT NULL,
  metric_name text NOT NULL,
  current_value decimal,
  baseline_value decimal,
  change_percent decimal,
  severity text NOT NULL CHECK (severity IN ('info', 'warning', 'critical')),
  ai_explanation text,
  causes jsonb,
  acknowledged boolean DEFAULT false,
  acknowledged_by uuid REFERENCES user_profiles(id) ON DELETE SET NULL,
  created_at timestamptz DEFAULT now()
);

-- Consultant Metrics — performance snapshots
CREATE TABLE IF NOT EXISTS consultant_metrics (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  venue_id uuid NOT NULL REFERENCES venues(id) ON DELETE CASCADE,
  consultant_id uuid NOT NULL REFERENCES user_profiles(id) ON DELETE CASCADE,
  period_start date NOT NULL,
  period_end date NOT NULL,
  inquiries_handled integer DEFAULT 0,
  tours_booked integer DEFAULT 0,
  bookings_closed integer DEFAULT 0,
  conversion_rate decimal,
  avg_response_time_minutes decimal,
  avg_booking_value decimal,
  calculated_at timestamptz DEFAULT now()
);

-- Review Language — extracted review phrases
CREATE TABLE IF NOT EXISTS review_language (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  venue_id uuid NOT NULL REFERENCES venues(id) ON DELETE CASCADE,
  phrase text NOT NULL,
  theme text,
  sentiment_score float,
  frequency integer DEFAULT 1,
  approved_for_sage boolean DEFAULT false,
  approved_for_marketing boolean DEFAULT false,
  created_at timestamptz DEFAULT now()
);

-- Weather Data — NOAA data for venue location
CREATE TABLE IF NOT EXISTS weather_data (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  venue_id uuid NOT NULL REFERENCES venues(id) ON DELETE CASCADE,
  date date NOT NULL,
  high_temp decimal,
  low_temp decimal,
  precipitation decimal,
  conditions text,
  source text
);

-- Economic Indicators — FRED data
CREATE TABLE IF NOT EXISTS economic_indicators (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  indicator_name text NOT NULL,
  date date NOT NULL,
  value decimal,
  source text
);

-- Natural Language Queries — NLQ log
CREATE TABLE IF NOT EXISTS natural_language_queries (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  venue_id uuid NOT NULL REFERENCES venues(id) ON DELETE CASCADE,
  user_id uuid REFERENCES user_profiles(id) ON DELETE SET NULL,
  query_text text NOT NULL,
  response_text text,
  model_used text,
  tokens_used integer,
  cost decimal,
  helpful boolean,
  created_at timestamptz DEFAULT now()
);

-- ============================================
-- INDEXES
-- ============================================

-- marketing_spend
CREATE INDEX IF NOT EXISTS idx_marketing_spend_venue_id ON marketing_spend(venue_id);
CREATE INDEX IF NOT EXISTS idx_marketing_spend_month ON marketing_spend(venue_id, month);

-- source_attribution
CREATE INDEX IF NOT EXISTS idx_source_attribution_venue_id ON source_attribution(venue_id);
CREATE INDEX IF NOT EXISTS idx_source_attribution_source ON source_attribution(venue_id, source);

-- search_trends
CREATE INDEX IF NOT EXISTS idx_search_trends_venue_id ON search_trends(venue_id);
CREATE INDEX IF NOT EXISTS idx_search_trends_week ON search_trends(venue_id, week);

-- trend_recommendations
CREATE INDEX IF NOT EXISTS idx_trend_recommendations_venue_id ON trend_recommendations(venue_id);
CREATE INDEX IF NOT EXISTS idx_trend_recommendations_status ON trend_recommendations(venue_id, status);

-- ai_briefings
CREATE INDEX IF NOT EXISTS idx_ai_briefings_venue_id ON ai_briefings(venue_id);
CREATE INDEX IF NOT EXISTS idx_ai_briefings_type ON ai_briefings(venue_id, briefing_type);

-- anomaly_alerts
CREATE INDEX IF NOT EXISTS idx_anomaly_alerts_venue_id ON anomaly_alerts(venue_id);
CREATE INDEX IF NOT EXISTS idx_anomaly_alerts_severity ON anomaly_alerts(venue_id, severity);

-- consultant_metrics
CREATE INDEX IF NOT EXISTS idx_consultant_metrics_venue_id ON consultant_metrics(venue_id);
CREATE INDEX IF NOT EXISTS idx_consultant_metrics_consultant_id ON consultant_metrics(consultant_id);

-- review_language

-- weather_data
CREATE INDEX IF NOT EXISTS idx_weather_data_venue_id ON weather_data(venue_id);
CREATE INDEX IF NOT EXISTS idx_weather_data_date ON weather_data(venue_id, date);

-- economic_indicators
CREATE INDEX IF NOT EXISTS idx_economic_indicators_date ON economic_indicators(date);
CREATE INDEX IF NOT EXISTS idx_economic_indicators_name ON economic_indicators(indicator_name);

-- natural_language_queries
CREATE INDEX IF NOT EXISTS idx_natural_language_queries_venue_id ON natural_language_queries(venue_id);
-- ============================================
-- 004: PORTAL-OWNED TABLES
-- Owner: portal (couple-facing planning tools, Sage chat, messaging)
-- Depends on: 001_shared_tables.sql
-- ============================================

-- Guest List
CREATE TABLE IF NOT EXISTS guest_list (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  venue_id uuid NOT NULL REFERENCES venues(id) ON DELETE CASCADE,
  wedding_id uuid NOT NULL REFERENCES weddings(id) ON DELETE CASCADE,
  person_id uuid REFERENCES people(id) ON DELETE SET NULL,
  group_name text,
  rsvp_status text DEFAULT 'pending' CHECK (rsvp_status IN ('pending', 'attending', 'declined', 'maybe')),
  meal_preference text,
  dietary_restrictions text,
  plus_one boolean DEFAULT false,
  plus_one_name text,
  table_assignment_id uuid,
  care_notes text,
  invitation_sent boolean DEFAULT false,
  rsvp_responded_at timestamptz,
  created_at timestamptz DEFAULT now(),
  updated_at timestamptz DEFAULT now()
);

-- Timeline
CREATE TABLE IF NOT EXISTS timeline (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  venue_id uuid NOT NULL REFERENCES venues(id) ON DELETE CASCADE,
  wedding_id uuid NOT NULL REFERENCES weddings(id) ON DELETE CASCADE,
  time time,
  duration_minutes integer,
  title text NOT NULL,
  description text,
  category text,
  location text,
  vendor_id uuid,
  sort_order integer,
  created_at timestamptz DEFAULT now(),
  updated_at timestamptz DEFAULT now()
);

-- Budget
CREATE TABLE IF NOT EXISTS budget (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  venue_id uuid NOT NULL REFERENCES venues(id) ON DELETE CASCADE,
  wedding_id uuid NOT NULL REFERENCES weddings(id) ON DELETE CASCADE,
  category text,
  item_name text NOT NULL,
  estimated_cost decimal,
  actual_cost decimal,
  paid_amount decimal,
  vendor_id uuid,
  notes text,
  created_at timestamptz DEFAULT now(),
  updated_at timestamptz DEFAULT now()
);

-- Seating Tables
CREATE TABLE IF NOT EXISTS seating_tables (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  venue_id uuid NOT NULL REFERENCES venues(id) ON DELETE CASCADE,
  wedding_id uuid NOT NULL REFERENCES weddings(id) ON DELETE CASCADE,
  table_name text,
  table_type text CHECK (table_type IN ('round', 'rectangle', 'head')),
  capacity integer,
  x_position float,
  y_position float,
  rotation float DEFAULT 0,
  created_at timestamptz DEFAULT now()
);

-- Seating Assignments
CREATE TABLE IF NOT EXISTS seating_assignments (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  venue_id uuid NOT NULL REFERENCES venues(id) ON DELETE CASCADE,
  wedding_id uuid NOT NULL REFERENCES weddings(id) ON DELETE CASCADE,
  guest_id uuid NOT NULL REFERENCES guest_list(id) ON DELETE CASCADE,
  table_id uuid NOT NULL REFERENCES seating_tables(id) ON DELETE CASCADE,
  seat_number integer,
  created_at timestamptz DEFAULT now()
);

-- Now add the FK from guest_list.table_assignment_id to seating_tables
ALTER TABLE guest_list
  ADD CONSTRAINT fk_guest_list_table_assignment
  FOREIGN KEY (table_assignment_id) REFERENCES seating_tables(id) ON DELETE SET NULL;

-- Sage Conversations
CREATE TABLE IF NOT EXISTS sage_conversations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  venue_id uuid NOT NULL REFERENCES venues(id) ON DELETE CASCADE,
  wedding_id uuid REFERENCES weddings(id) ON DELETE SET NULL,
  user_id uuid REFERENCES user_profiles(id) ON DELETE SET NULL,
  role text NOT NULL CHECK (role IN ('user', 'assistant')),
  content text NOT NULL,
  model_used text,
  tokens_used integer,
  cost decimal,
  confidence_score integer,
  flagged_uncertain boolean DEFAULT false,
  created_at timestamptz DEFAULT now()
);

-- Sage Uncertain Queue
CREATE TABLE IF NOT EXISTS sage_uncertain_queue (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  venue_id uuid NOT NULL REFERENCES venues(id) ON DELETE CASCADE,
  wedding_id uuid REFERENCES weddings(id) ON DELETE SET NULL,
  conversation_id uuid REFERENCES sage_conversations(id) ON DELETE SET NULL,
  question text NOT NULL,
  sage_answer text,
  confidence_score integer,
  coordinator_response text,
  resolved_by uuid REFERENCES user_profiles(id) ON DELETE SET NULL,
  resolved_at timestamptz,
  added_to_kb boolean DEFAULT false,
  created_at timestamptz DEFAULT now()
);

-- Planning Notes — extracted from chat messages
CREATE TABLE IF NOT EXISTS planning_notes (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  venue_id uuid NOT NULL REFERENCES venues(id) ON DELETE CASCADE,
  wedding_id uuid NOT NULL REFERENCES weddings(id) ON DELETE CASCADE,
  user_id uuid REFERENCES user_profiles(id) ON DELETE SET NULL,
  category text CHECK (category IN ('vendor', 'guest_count', 'decor', 'checklist')),
  content text NOT NULL,
  source_message text,
  status text DEFAULT 'extracted',
  created_at timestamptz DEFAULT now()
);

-- Contracts — uploaded documents
CREATE TABLE IF NOT EXISTS contracts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  venue_id uuid NOT NULL REFERENCES venues(id) ON DELETE CASCADE,
  wedding_id uuid NOT NULL REFERENCES weddings(id) ON DELETE CASCADE,
  filename text NOT NULL,
  file_type text,
  extracted_text text,
  storage_path text,
  created_at timestamptz DEFAULT now()
);

-- Checklist Items
CREATE TABLE IF NOT EXISTS checklist_items (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  venue_id uuid NOT NULL REFERENCES venues(id) ON DELETE CASCADE,
  wedding_id uuid NOT NULL REFERENCES weddings(id) ON DELETE CASCADE,
  title text NOT NULL,
  description text,
  due_date date,
  category text,
  is_completed boolean DEFAULT false,
  completed_at timestamptz,
  sort_order integer,
  created_at timestamptz DEFAULT now()
);

-- Messages — coordinator-couple DMs
CREATE TABLE IF NOT EXISTS messages (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  venue_id uuid NOT NULL REFERENCES venues(id) ON DELETE CASCADE,
  wedding_id uuid NOT NULL REFERENCES weddings(id) ON DELETE CASCADE,
  sender_id uuid REFERENCES user_profiles(id) ON DELETE SET NULL,
  sender_role text,
  content text NOT NULL,
  read_at timestamptz,
  created_at timestamptz DEFAULT now()
);

-- Vendor Recommendations — venue-suggested vendors
CREATE TABLE IF NOT EXISTS vendor_recommendations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  venue_id uuid NOT NULL REFERENCES venues(id) ON DELETE CASCADE,
  vendor_name text NOT NULL,
  vendor_type text,
  contact_email text,
  contact_phone text,
  website_url text,
  description text,
  logo_url text,
  is_preferred boolean DEFAULT false,
  sort_order integer,
  click_count integer DEFAULT 0,
  created_at timestamptz DEFAULT now()
);

-- Inspo Gallery — inspiration images
CREATE TABLE IF NOT EXISTS inspo_gallery (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  venue_id uuid NOT NULL REFERENCES venues(id) ON DELETE CASCADE,
  wedding_id uuid REFERENCES weddings(id) ON DELETE SET NULL,
  image_url text NOT NULL,
  caption text,
  tags text[],
  uploaded_by uuid REFERENCES user_profiles(id) ON DELETE SET NULL,
  created_at timestamptz DEFAULT now()
);

-- ============================================
-- INDEXES
-- ============================================

-- guest_list
CREATE INDEX IF NOT EXISTS idx_guest_list_venue_id ON guest_list(venue_id);
CREATE INDEX IF NOT EXISTS idx_guest_list_wedding_id ON guest_list(wedding_id);
CREATE INDEX IF NOT EXISTS idx_guest_list_rsvp_status ON guest_list(wedding_id, rsvp_status);

-- timeline
CREATE INDEX IF NOT EXISTS idx_timeline_venue_id ON timeline(venue_id);
CREATE INDEX IF NOT EXISTS idx_timeline_wedding_id ON timeline(wedding_id);

-- budget
CREATE INDEX IF NOT EXISTS idx_budget_venue_id ON budget(venue_id);
CREATE INDEX IF NOT EXISTS idx_budget_wedding_id ON budget(wedding_id);

-- seating_tables
CREATE INDEX IF NOT EXISTS idx_seating_tables_venue_id ON seating_tables(venue_id);
CREATE INDEX IF NOT EXISTS idx_seating_tables_wedding_id ON seating_tables(wedding_id);

-- seating_assignments
CREATE INDEX IF NOT EXISTS idx_seating_assignments_venue_id ON seating_assignments(venue_id);
CREATE INDEX IF NOT EXISTS idx_seating_assignments_wedding_id ON seating_assignments(wedding_id);
CREATE INDEX IF NOT EXISTS idx_seating_assignments_table_id ON seating_assignments(table_id);

-- sage_conversations
CREATE INDEX IF NOT EXISTS idx_sage_conversations_venue_id ON sage_conversations(venue_id);
CREATE INDEX IF NOT EXISTS idx_sage_conversations_wedding_id ON sage_conversations(wedding_id);

-- sage_uncertain_queue
CREATE INDEX IF NOT EXISTS idx_sage_uncertain_queue_venue_id ON sage_uncertain_queue(venue_id);
CREATE INDEX IF NOT EXISTS idx_sage_uncertain_queue_wedding_id ON sage_uncertain_queue(wedding_id);

-- planning_notes
CREATE INDEX IF NOT EXISTS idx_planning_notes_venue_id ON planning_notes(venue_id);
CREATE INDEX IF NOT EXISTS idx_planning_notes_wedding_id ON planning_notes(wedding_id);

-- contracts
CREATE INDEX IF NOT EXISTS idx_contracts_venue_id ON contracts(venue_id);
CREATE INDEX IF NOT EXISTS idx_contracts_wedding_id ON contracts(wedding_id);

-- checklist_items
CREATE INDEX IF NOT EXISTS idx_checklist_items_venue_id ON checklist_items(venue_id);
CREATE INDEX IF NOT EXISTS idx_checklist_items_wedding_id ON checklist_items(wedding_id);

-- messages
CREATE INDEX IF NOT EXISTS idx_messages_venue_id ON messages(venue_id);
CREATE INDEX IF NOT EXISTS idx_messages_wedding_id ON messages(wedding_id);
CREATE INDEX IF NOT EXISTS idx_messages_sender_id ON messages(sender_id);

-- vendor_recommendations
CREATE INDEX IF NOT EXISTS idx_vendor_recommendations_venue_id ON vendor_recommendations(venue_id);

-- inspo_gallery
CREATE INDEX IF NOT EXISTS idx_inspo_gallery_venue_id ON inspo_gallery(venue_id);
CREATE INDEX IF NOT EXISTS idx_inspo_gallery_wedding_id ON inspo_gallery(wedding_id);
-- ============================================
-- 005: AI SYSTEM TABLES
-- Owner: ai_system (voice training, USPs, seasonal content)
-- ============================================

-- Venue USPs — unique selling points per venue
CREATE TABLE IF NOT EXISTS venue_usps (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  venue_id uuid NOT NULL REFERENCES venues(id) ON DELETE CASCADE,
  usp_text text NOT NULL,
  sort_order int DEFAULT 0,
  is_active boolean DEFAULT true,
  created_at timestamptz DEFAULT now()
);

-- Venue Seasonal Content — seasonal imagery and phrases per venue
CREATE TABLE IF NOT EXISTS venue_seasonal_content (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  venue_id uuid NOT NULL REFERENCES venues(id) ON DELETE CASCADE,
  season text NOT NULL CHECK (season IN ('spring', 'summer', 'fall', 'winter')),
  imagery text,
  phrases text[],
  created_at timestamptz DEFAULT now()
);

-- Phrase Usage — anti-duplication tracking
CREATE TABLE IF NOT EXISTS phrase_usage (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  venue_id uuid NOT NULL REFERENCES venues(id) ON DELETE CASCADE,
  contact_email text NOT NULL,
  phrase_category text NOT NULL,
  phrase_text text NOT NULL,
  used_at timestamptz DEFAULT now()
);

-- Voice Training Sessions — game sessions for training venue voice
CREATE TABLE IF NOT EXISTS voice_training_sessions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  venue_id uuid NOT NULL REFERENCES venues(id) ON DELETE CASCADE,
  game_type text NOT NULL CHECK (game_type IN ('would_you_send', 'cringe_or_fine', 'quick_quiz')),
  completed_rounds int DEFAULT 0,
  total_rounds int,
  staff_email text,
  started_at timestamptz DEFAULT now(),
  completed_at timestamptz
);

-- Voice Training Responses — individual round responses within a session
CREATE TABLE IF NOT EXISTS voice_training_responses (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  session_id uuid NOT NULL REFERENCES voice_training_sessions(id) ON DELETE CASCADE,
  round_number int,
  content_type text,
  response text,
  response_reason text,
  created_at timestamptz DEFAULT now()
);

-- Voice Preferences — learned preferences from training games
CREATE TABLE IF NOT EXISTS voice_preferences (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  venue_id uuid NOT NULL REFERENCES venues(id) ON DELETE CASCADE,
  preference_type text NOT NULL CHECK (preference_type IN ('banned_phrase', 'approved_phrase', 'dimension')),
  content text NOT NULL,
  score float DEFAULT 0,
  sample_count int DEFAULT 1,
  UNIQUE (venue_id, preference_type, content),
  created_at timestamptz DEFAULT now()
);

-- Indexes
CREATE INDEX IF NOT EXISTS idx_venue_usps_venue_id ON venue_usps(venue_id);
CREATE INDEX IF NOT EXISTS idx_venue_seasonal_content_venue_id ON venue_seasonal_content(venue_id);
CREATE INDEX IF NOT EXISTS idx_phrase_usage_venue_id ON phrase_usage(venue_id);
CREATE INDEX IF NOT EXISTS idx_voice_training_sessions_venue_id ON voice_training_sessions(venue_id);
CREATE INDEX IF NOT EXISTS idx_voice_training_responses_session_id ON voice_training_responses(session_id);
CREATE INDEX IF NOT EXISTS idx_voice_preferences_venue_id ON voice_preferences(venue_id);
-- ============================================
-- 007: HELPER FUNCTIONS & TRIGGERS
-- Utility functions used by RLS policies,
-- application code, and automated triggers.
-- ============================================

-- ============================================
-- HELPER FUNCTIONS
-- ============================================

-- get_venue_id_for_user() — returns the venue_id for the current auth user
CREATE OR REPLACE FUNCTION get_venue_id_for_user()
RETURNS uuid
LANGUAGE sql
STABLE
SECURITY DEFINER
AS $$
  SELECT venue_id FROM user_profiles WHERE id = auth.uid();
$$;

-- get_org_id_for_user() — returns the org_id for the current auth user
CREATE OR REPLACE FUNCTION get_org_id_for_user()
RETURNS uuid
LANGUAGE sql
STABLE
SECURITY DEFINER
AS $$
  SELECT org_id FROM user_profiles WHERE id = auth.uid();
$$;

-- is_super_admin() — returns true if the current auth user is a super_admin
CREATE OR REPLACE FUNCTION is_super_admin()
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
AS $$
  SELECT EXISTS (
    SELECT 1 FROM user_profiles
    WHERE id = auth.uid()
    AND role = 'super_admin'
  );
$$;

-- ============================================
-- TRIGGER FUNCTION: update_updated_at
-- Sets updated_at = now() on every UPDATE
-- ============================================

CREATE OR REPLACE FUNCTION update_updated_at()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$;

-- ============================================
-- APPLY update_updated_at TRIGGER
-- ============================================










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

-- Guest Tag Assignments
CREATE TABLE IF NOT EXISTS guest_tag_assignments (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  guest_id uuid NOT NULL REFERENCES guest_list(id) ON DELETE CASCADE,
  tag_id uuid NOT NULL REFERENCES guest_tags(id) ON DELETE CASCADE,
  created_at timestamptz DEFAULT now()
);

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

-- Client Codes
CREATE TABLE IF NOT EXISTS client_codes (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  venue_id uuid NOT NULL REFERENCES venues(id) ON DELETE CASCADE,
  wedding_id uuid UNIQUE REFERENCES weddings(id) ON DELETE CASCADE,
  code text UNIQUE NOT NULL,
  format_template text,
  created_at timestamptz DEFAULT now()
);

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

-- Notification Tokens
CREATE TABLE IF NOT EXISTS notification_tokens (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES user_profiles(id) ON DELETE CASCADE,
  token text NOT NULL,
  platform text CHECK (platform IN ('web', 'ios', 'android')),
  created_at timestamptz DEFAULT now()
);


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

-- Lost Deals

-- Campaigns

-- Social Posts

-- Annotations

-- Venue Health

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
-- ============================================
-- 010: VENDOR PORTAL TOKENS
-- Adds self-service vendor portal columns to vendor_recommendations
-- Depends on: 004_portal_tables.sql
-- ============================================

ALTER TABLE vendor_recommendations
  ADD COLUMN IF NOT EXISTS portal_token text UNIQUE,
  ADD COLUMN IF NOT EXISTS bio text,
  ADD COLUMN IF NOT EXISTS instagram_url text,
  ADD COLUMN IF NOT EXISTS facebook_url text,
  ADD COLUMN IF NOT EXISTS pricing_info text,
  ADD COLUMN IF NOT EXISTS special_offer text,
  ADD COLUMN IF NOT EXISTS offer_expires_at date,
  ADD COLUMN IF NOT EXISTS portfolio_photos text[] DEFAULT '{}',
  ADD COLUMN IF NOT EXISTS last_updated_by_vendor timestamptz;

CREATE INDEX IF NOT EXISTS idx_vendor_recommendations_portal_token ON vendor_recommendations(portal_token);
-- ============================================
-- 011: ACTIVITY LOGGING & ADMIN NOTIFICATIONS
-- Tracks couple actions and surfaces admin alerts
-- Depends on: 001_shared_tables.sql, 004_portal_tables.sql
-- ============================================

-- Activity Log
CREATE TABLE IF NOT EXISTS activity_log (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  venue_id uuid NOT NULL REFERENCES venues(id) ON DELETE CASCADE,
  wedding_id uuid REFERENCES weddings(id) ON DELETE SET NULL,
  user_id uuid REFERENCES user_profiles(id) ON DELETE SET NULL,
  activity_type text NOT NULL,
  entity_type text,
  entity_id uuid,
  details jsonb DEFAULT '{}',
  created_at timestamptz DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_activity_log_venue_id ON activity_log(venue_id);
CREATE INDEX IF NOT EXISTS idx_activity_log_wedding_id ON activity_log(wedding_id);
CREATE INDEX IF NOT EXISTS idx_activity_log_created_at ON activity_log(venue_id, created_at);
CREATE INDEX IF NOT EXISTS idx_activity_log_type ON activity_log(venue_id, activity_type);

-- Admin Notifications
CREATE TABLE IF NOT EXISTS admin_notifications (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  venue_id uuid NOT NULL REFERENCES venues(id) ON DELETE CASCADE,
  wedding_id uuid REFERENCES weddings(id) ON DELETE SET NULL,
  type text NOT NULL,
  title text NOT NULL,
  body text,
  read boolean DEFAULT false,
  read_at timestamptz,
  email_sent boolean DEFAULT false,
  created_at timestamptz DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_admin_notifications_venue_id ON admin_notifications(venue_id);
CREATE INDEX IF NOT EXISTS idx_admin_notifications_read ON admin_notifications(venue_id, read);
CREATE INDEX IF NOT EXISTS idx_admin_notifications_created_at ON admin_notifications(venue_id, created_at);
-- ============================================
-- 012: Add 'rule' to voice_preferences preference_type
-- Allows storing venue rules (always/never/when-then) alongside
-- banned phrases, approved phrases, and voice dimensions.
-- ============================================

ALTER TABLE voice_preferences
  DROP CONSTRAINT voice_preferences_preference_type_check;

ALTER TABLE voice_preferences
  ADD CONSTRAINT voice_preferences_preference_type_check
  CHECK (preference_type IN ('banned_phrase', 'approved_phrase', 'dimension', 'rule'));
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
-- ============================================
-- 015: VENDORS + CONTRACTS UPGRADE
-- Adds booked_vendors table for couple vendor tracking,
-- and expands contracts table for AI analysis pipeline.
-- Depends on: 004_portal_tables.sql
-- ============================================

-- ---------------------------------------------------------------------------
-- 1. Booked Vendors — couple's own vendor records with contract tracking
-- ---------------------------------------------------------------------------
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

-- ---------------------------------------------------------------------------
-- 2. Expand contracts table for AI analysis pipeline
-- ---------------------------------------------------------------------------
ALTER TABLE contracts
  ADD COLUMN IF NOT EXISTS file_url text,
  ADD COLUMN IF NOT EXISTS key_terms text[],
  ADD COLUMN IF NOT EXISTS analysis text,
  ADD COLUMN IF NOT EXISTS analyzed_at timestamptz,
  ADD COLUMN IF NOT EXISTS vendor_id uuid REFERENCES booked_vendors(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS vendor_name text,
  ADD COLUMN IF NOT EXISTS status text DEFAULT 'uploaded',
  ADD COLUMN IF NOT EXISTS updated_at timestamptz DEFAULT now();

-- ---------------------------------------------------------------------------
-- 3. Expand planning_notes category constraint for contract extraction
-- ---------------------------------------------------------------------------
ALTER TABLE planning_notes
  DROP CONSTRAINT IF EXISTS planning_notes_category_check;

ALTER TABLE planning_notes
  ADD CONSTRAINT planning_notes_category_check
  CHECK (category IN ('vendor', 'guest_count', 'decor', 'checklist', 'cost', 'date', 'policy', 'note'));
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

-- ============================================
-- 017: MISSING TABLES
-- Tables referenced in code but not yet created.
-- Some are new, some fix name mismatches.
-- ============================================

-- Budget items — individual line items in the budget
CREATE TABLE IF NOT EXISTS budget_items (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  venue_id uuid NOT NULL REFERENCES venues(id),
  wedding_id uuid NOT NULL REFERENCES weddings(id),
  category text NOT NULL,
  item_name text NOT NULL,
  budgeted decimal DEFAULT 0,
  committed decimal DEFAULT 0,
  paid decimal DEFAULT 0,
  payment_source text,
  payment_due_date date,
  vendor_name text,
  notes text,
  sort_order integer DEFAULT 0,
  created_at timestamptz DEFAULT now(),
  updated_at timestamptz DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_budget_items_wedding ON budget_items(venue_id, wedding_id);

-- Budget payments — individual payment records per budget item
CREATE TABLE IF NOT EXISTS budget_payments (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  budget_item_id uuid NOT NULL REFERENCES budget_items(id) ON DELETE CASCADE,
  venue_id uuid NOT NULL REFERENCES venues(id),
  wedding_id uuid NOT NULL REFERENCES weddings(id),
  amount decimal NOT NULL,
  payment_date date,
  payment_method text,
  notes text,
  created_at timestamptz DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_budget_payments_item ON budget_payments(budget_item_id);

-- Wedding config — per-wedding settings (budget total, share toggle, meal mode, etc.)
CREATE TABLE IF NOT EXISTS wedding_config (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  venue_id uuid NOT NULL REFERENCES venues(id),
  wedding_id uuid NOT NULL REFERENCES weddings(id),
  total_budget decimal DEFAULT 0,
  budget_shared boolean DEFAULT false,
  plated_meal boolean DEFAULT false,
  custom_categories jsonb DEFAULT '[]',
  created_at timestamptz DEFAULT now(),
  updated_at timestamptz DEFAULT now(),
  UNIQUE(venue_id, wedding_id)
);
CREATE INDEX IF NOT EXISTS idx_wedding_config_wedding ON wedding_config(venue_id, wedding_id);

-- Wedding timeline — stores the full timeline JSON (separate from timeline items)
CREATE TABLE IF NOT EXISTS wedding_timeline (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  venue_id uuid NOT NULL REFERENCES venues(id),
  wedding_id uuid NOT NULL REFERENCES weddings(id),
  timeline_data jsonb DEFAULT '{}',
  ceremony_start text,
  reception_end text,
  notes text,
  created_at timestamptz DEFAULT now(),
  updated_at timestamptz DEFAULT now(),
  UNIQUE(venue_id, wedding_id)
);
CREATE INDEX IF NOT EXISTS idx_wedding_timeline_wedding ON wedding_timeline(venue_id, wedding_id);

-- Notifications — in-app notifications for coordinators
CREATE TABLE IF NOT EXISTS notifications (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  venue_id uuid NOT NULL REFERENCES venues(id),
  user_id uuid,
  type text NOT NULL,
  title text NOT NULL,
  body text,
  read boolean DEFAULT false,
  created_at timestamptz DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_notifications_venue ON notifications(venue_id, read);

-- Couple budget — simplified budget summary (used by chat context)
CREATE TABLE IF NOT EXISTS couple_budget (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  venue_id uuid NOT NULL REFERENCES venues(id),
  wedding_id uuid NOT NULL REFERENCES weddings(id),
  total_budget decimal DEFAULT 0,
  total_committed decimal DEFAULT 0,
  total_paid decimal DEFAULT 0,
  categories jsonb DEFAULT '{}',
  created_at timestamptz DEFAULT now(),
  updated_at timestamptz DEFAULT now(),
  UNIQUE(venue_id, wedding_id)
);
-- ============================================
-- 018: CEREMONY ORDER & BEAUTY SCHEDULE FIXES
-- Fix ceremony_order column mismatches (code uses 'section', DB had 'side' with wrong CHECK)
-- Add duration column to makeup_schedule for time estimation
-- ============================================

-- 1) ceremony_order: Add 'section' column for processional/family_escort/recessional
ALTER TABLE ceremony_order ADD COLUMN IF NOT EXISTS section text;

-- 2) ceremony_order: Drop restrictive CHECK on 'role' — code sends free-text roles
ALTER TABLE ceremony_order DROP CONSTRAINT IF EXISTS ceremony_order_role_check;

-- 3) ceremony_order: Drop restrictive CHECK on 'side' — code sends 'center' and others
ALTER TABLE ceremony_order DROP CONSTRAINT IF EXISTS ceremony_order_side_check;

-- 4) makeup_schedule: Add duration column (minutes per service)
ALTER TABLE makeup_schedule ADD COLUMN IF NOT EXISTS duration integer DEFAULT 45;

-- 5) makeup_schedule: Add hair_duration and makeup_duration for per-service durations
ALTER TABLE makeup_schedule ADD COLUMN IF NOT EXISTS hair_duration integer DEFAULT 45;
ALTER TABLE makeup_schedule ADD COLUMN IF NOT EXISTS makeup_duration integer DEFAULT 45;
-- ============================================
-- 019: GUEST DATA FIXES
-- Fix column naming, add missing plus-one fields,
-- link allergies to guests, add RSVP configuration
-- ============================================

-- ---------------------------------------------------------------------------
-- 1. Add missing plus-one columns to guest_list
-- ---------------------------------------------------------------------------
ALTER TABLE guest_list
  ADD COLUMN IF NOT EXISTS plus_one_rsvp text,
  ADD COLUMN IF NOT EXISTS plus_one_meal_choice text,
  ADD COLUMN IF NOT EXISTS plus_one_dietary text;

-- Add meal_choice as alias/replacement for meal_preference
-- (keep meal_preference for backward compat, add meal_choice)
ALTER TABLE guest_list
  ADD COLUMN IF NOT EXISTS meal_choice text;

-- Add has_plus_one as alias for plus_one boolean
ALTER TABLE guest_list
  ADD COLUMN IF NOT EXISTS has_plus_one boolean DEFAULT false;

-- Add phone and email directly on guest_list (not just on people table)
ALTER TABLE guest_list
  ADD COLUMN IF NOT EXISTS email text,
  ADD COLUMN IF NOT EXISTS phone text,
  ADD COLUMN IF NOT EXISTS first_name text,
  ADD COLUMN IF NOT EXISTS last_name text;

-- Add accommodation tracking per guest
ALTER TABLE guest_list
  ADD COLUMN IF NOT EXISTS accommodation text;

-- ---------------------------------------------------------------------------
-- 2. Link allergy_registry to guest_list
-- ---------------------------------------------------------------------------
ALTER TABLE allergy_registry
  ADD COLUMN IF NOT EXISTS guest_id uuid REFERENCES guest_list(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_allergy_registry_guest ON allergy_registry(guest_id);

-- ---------------------------------------------------------------------------
-- 3. RSVP Configuration — what fields to ask on public RSVP form
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS rsvp_config (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  venue_id uuid NOT NULL REFERENCES venues(id),
  wedding_id uuid NOT NULL REFERENCES weddings(id),

  -- Which fields to show on public RSVP
  ask_meal_choice boolean DEFAULT true,
  ask_dietary boolean DEFAULT true,
  ask_allergies boolean DEFAULT false,
  ask_phone boolean DEFAULT false,
  ask_email boolean DEFAULT false,
  ask_address boolean DEFAULT false,
  ask_hotel boolean DEFAULT false,
  ask_shuttle boolean DEFAULT false,
  ask_accessibility boolean DEFAULT false,
  ask_song_request boolean DEFAULT false,
  ask_message boolean DEFAULT false,

  -- Allow "maybe" as RSVP option
  allow_maybe boolean DEFAULT false,

  -- Custom questions (JSONB array of {label, type: 'text'|'select'|'boolean', options?: string[]})
  custom_questions jsonb DEFAULT '[]',

  -- RSVP deadline
  rsvp_deadline date,

  -- Confirmation messages
  attending_message text DEFAULT 'Thank you for confirming! We can''t wait to celebrate with you.',
  declined_message text DEFAULT 'We''ll miss you! Thank you for letting us know.',

  created_at timestamptz DEFAULT now(),
  updated_at timestamptz DEFAULT now(),
  UNIQUE(venue_id, wedding_id)
);

-- ---------------------------------------------------------------------------
-- 4. Guest RSVP responses — stores answers to custom/optional questions
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS rsvp_responses (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  venue_id uuid NOT NULL REFERENCES venues(id),
  wedding_id uuid NOT NULL REFERENCES weddings(id),
  guest_id uuid NOT NULL REFERENCES guest_list(id) ON DELETE CASCADE,

  -- Standard optional fields
  phone text,
  email text,
  address text,
  hotel_name text,
  shuttle_needed boolean,
  accessibility_needs text,
  song_request text,
  message_to_couple text,
  allergies text,

  -- Custom question answers (JSONB: {question_label: answer})
  custom_answers jsonb DEFAULT '{}',

  responded_at timestamptz DEFAULT now(),
  created_at timestamptz DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_rsvp_responses_guest ON rsvp_responses(guest_id);
CREATE INDEX IF NOT EXISTS idx_rsvp_responses_wedding ON rsvp_responses(venue_id, wedding_id);

-- ---------------------------------------------------------------------------
-- 5. Per-guest care flags (lightweight, queryable by other pages)
-- ---------------------------------------------------------------------------
ALTER TABLE guest_list
  ADD COLUMN IF NOT EXISTS needs_accessibility boolean DEFAULT false,
  ADD COLUMN IF NOT EXISTS accessibility_notes text,
  ADD COLUMN IF NOT EXISTS staying_overnight boolean,
  ADD COLUMN IF NOT EXISTS needs_shuttle boolean DEFAULT false;
-- ============================================
-- 020: SYNC FIXES
-- Fix CHECK constraints, add table_assignment text column,
-- allow side='both' in wedding_party
-- ============================================

-- Allow 'both' in wedding_party side
ALTER TABLE wedding_party DROP CONSTRAINT IF EXISTS wedding_party_side_check;

-- Add table_assignment text to guest_list (for simple name-based assignment)
ALTER TABLE guest_list ADD COLUMN IF NOT EXISTS table_assignment text;

-- Drop strict role checks on ceremony_order (already done in 018 but be safe)
ALTER TABLE ceremony_order DROP CONSTRAINT IF EXISTS ceremony_order_role_check;
ALTER TABLE ceremony_order DROP CONSTRAINT IF EXISTS ceremony_order_side_check;
-- ============================================
-- 021: SEATING TABLE FIXES
-- Drop restrictive table_type CHECK, add sort_order column
-- ============================================

-- Drop the old CHECK constraint that only allowed 'round', 'rectangle', 'head'
ALTER TABLE seating_tables DROP CONSTRAINT IF EXISTS seating_tables_table_type_check;

-- Add sort_order column for ordering tables in the list view
ALTER TABLE seating_tables ADD COLUMN IF NOT EXISTS sort_order integer DEFAULT 0;

-- ============================================
-- PATCH: Ensure required columns on existing tables  
-- ============================================
ALTER TABLE venues ADD COLUMN IF NOT EXISTS org_id uuid;
ALTER TABLE venues ADD COLUMN IF NOT EXISTS plan_tier text DEFAULT 'enterprise';
ALTER TABLE venues ADD COLUMN IF NOT EXISTS slug text;
ALTER TABLE venues ADD COLUMN IF NOT EXISTS google_trends_metro text;
ALTER TABLE venues ADD COLUMN IF NOT EXISTS noaa_station_id text;
ALTER TABLE venues ADD COLUMN IF NOT EXISTS briefing_email text;
ALTER TABLE venues ADD COLUMN IF NOT EXISTS address_line1 text;
ALTER TABLE venues ADD COLUMN IF NOT EXISTS city text;
ALTER TABLE venues ADD COLUMN IF NOT EXISTS state text;
ALTER TABLE venues ADD COLUMN IF NOT EXISTS zip text;
ALTER TABLE venues ADD COLUMN IF NOT EXISTS latitude double precision;
ALTER TABLE venues ADD COLUMN IF NOT EXISTS longitude double precision;

ALTER TABLE organisations ADD COLUMN IF NOT EXISTS owner_id uuid;
ALTER TABLE organisations ADD COLUMN IF NOT EXISTS plan_tier text DEFAULT 'enterprise';

UPDATE venues SET plan_tier = 'enterprise' WHERE plan_tier IS NULL;
UPDATE venues SET org_id = 'de000000-0000-0000-0000-000000000001' WHERE org_id IS NULL;

NOTIFY pgrst, 'reload schema';
