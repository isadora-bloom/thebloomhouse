-- ============================================
-- 002: AGENT-OWNED TABLES
-- Owner: agent (email pipeline, drafts, lead scoring, learning)
-- Depends on: 001_shared_tables.sql
-- ============================================

-- Interactions — every email/call/voicemail
CREATE TABLE interactions (
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
COMMENT ON TABLE interactions IS 'owner:agent';

-- Drafts — AI-generated responses
CREATE TABLE drafts (
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
COMMENT ON TABLE drafts IS 'owner:agent';

-- Engagement Events — lead scoring events
CREATE TABLE engagement_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  venue_id uuid NOT NULL REFERENCES venues(id) ON DELETE CASCADE,
  wedding_id uuid REFERENCES weddings(id) ON DELETE SET NULL,
  event_type text NOT NULL,
  points integer NOT NULL DEFAULT 0,
  metadata jsonb DEFAULT '{}',
  created_at timestamptz DEFAULT now()
);
COMMENT ON TABLE engagement_events IS 'owner:agent';

-- Lead Score History — score snapshots
CREATE TABLE lead_score_history (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  venue_id uuid NOT NULL REFERENCES venues(id) ON DELETE CASCADE,
  wedding_id uuid NOT NULL REFERENCES weddings(id) ON DELETE CASCADE,
  score integer NOT NULL,
  temperature_tier text,
  calculated_at timestamptz DEFAULT now()
);
COMMENT ON TABLE lead_score_history IS 'owner:agent';

-- Heat Score Config — per-venue event point values
CREATE TABLE heat_score_config (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  venue_id uuid NOT NULL REFERENCES venues(id) ON DELETE CASCADE,
  event_type text NOT NULL,
  points integer NOT NULL DEFAULT 0,
  decay_rate decimal
);
COMMENT ON TABLE heat_score_config IS 'owner:agent';

-- Draft Feedback — learning from coordinator approvals/edits/rejections
CREATE TABLE draft_feedback (
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
COMMENT ON TABLE draft_feedback IS 'owner:agent';

-- Learned Preferences — aggregated patterns from feedback
CREATE TABLE learned_preferences (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  venue_id uuid NOT NULL REFERENCES venues(id) ON DELETE CASCADE,
  preference_type text NOT NULL,
  pattern text NOT NULL,
  confidence float,
  created_at timestamptz DEFAULT now()
);
COMMENT ON TABLE learned_preferences IS 'owner:agent';

-- Auto Send Rules — autonomous sending configuration
CREATE TABLE auto_send_rules (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  venue_id uuid NOT NULL REFERENCES venues(id) ON DELETE CASCADE,
  context text NOT NULL CHECK (context IN ('inquiry', 'client')),
  source text,
  enabled boolean DEFAULT false,
  confidence_threshold float DEFAULT 0.85,
  daily_limit integer DEFAULT 5,
  require_new_contact boolean DEFAULT true
);
COMMENT ON TABLE auto_send_rules IS 'owner:agent';

-- Intelligence Extractions — structured data extracted from emails
CREATE TABLE intelligence_extractions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  venue_id uuid NOT NULL REFERENCES venues(id) ON DELETE CASCADE,
  wedding_id uuid REFERENCES weddings(id) ON DELETE SET NULL,
  interaction_id uuid REFERENCES interactions(id) ON DELETE SET NULL,
  extraction_type text NOT NULL,
  value text,
  confidence float,
  created_at timestamptz DEFAULT now()
);
COMMENT ON TABLE intelligence_extractions IS 'owner:agent';

-- Email Sync State — Gmail cursor per venue
CREATE TABLE email_sync_state (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  venue_id uuid NOT NULL REFERENCES venues(id) ON DELETE CASCADE UNIQUE,
  last_history_id text,
  last_sync_at timestamptz,
  status text,
  error_message text
);
COMMENT ON TABLE email_sync_state IS 'owner:agent';

-- API Costs — per-call cost tracking
CREATE TABLE api_costs (
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
COMMENT ON TABLE api_costs IS 'owner:agent';

-- ============================================
-- INDEXES
-- ============================================

-- interactions
CREATE INDEX idx_interactions_venue_id ON interactions(venue_id);
CREATE INDEX idx_interactions_wedding_id ON interactions(wedding_id);
CREATE INDEX idx_interactions_gmail_message_id ON interactions(gmail_message_id);
CREATE INDEX idx_interactions_gmail_thread_id ON interactions(gmail_thread_id);
CREATE INDEX idx_interactions_timestamp ON interactions(timestamp);

-- drafts
CREATE INDEX idx_drafts_venue_id ON drafts(venue_id);
CREATE INDEX idx_drafts_wedding_id ON drafts(wedding_id);
CREATE INDEX idx_drafts_interaction_id ON drafts(interaction_id);
CREATE INDEX idx_drafts_status ON drafts(status);

-- engagement_events
CREATE INDEX idx_engagement_events_venue_id ON engagement_events(venue_id);
CREATE INDEX idx_engagement_events_wedding_id ON engagement_events(wedding_id);

-- lead_score_history
CREATE INDEX idx_lead_score_history_venue_id ON lead_score_history(venue_id);
CREATE INDEX idx_lead_score_history_wedding_id ON lead_score_history(wedding_id);

-- heat_score_config
CREATE INDEX idx_heat_score_config_venue_id ON heat_score_config(venue_id);

-- draft_feedback
CREATE INDEX idx_draft_feedback_venue_id ON draft_feedback(venue_id);
CREATE INDEX idx_draft_feedback_draft_id ON draft_feedback(draft_id);

-- learned_preferences
CREATE INDEX idx_learned_preferences_venue_id ON learned_preferences(venue_id);

-- auto_send_rules
CREATE INDEX idx_auto_send_rules_venue_id ON auto_send_rules(venue_id);

-- intelligence_extractions
CREATE INDEX idx_intelligence_extractions_venue_id ON intelligence_extractions(venue_id);
CREATE INDEX idx_intelligence_extractions_wedding_id ON intelligence_extractions(wedding_id);

-- email_sync_state
CREATE INDEX idx_email_sync_state_venue_id ON email_sync_state(venue_id);

-- api_costs
CREATE INDEX idx_api_costs_venue_id ON api_costs(venue_id);
CREATE INDEX idx_api_costs_service ON api_costs(service);
