-- ============================================
-- 005: AI SYSTEM TABLES
-- Owner: ai_system (voice training, USPs, seasonal content)
-- ============================================

-- Venue USPs — unique selling points per venue
CREATE TABLE venue_usps (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  venue_id uuid NOT NULL REFERENCES venues(id) ON DELETE CASCADE,
  usp_text text NOT NULL,
  sort_order int DEFAULT 0,
  is_active boolean DEFAULT true,
  created_at timestamptz DEFAULT now()
);
COMMENT ON TABLE venue_usps IS 'owner:ai_system';

-- Venue Seasonal Content — seasonal imagery and phrases per venue
CREATE TABLE venue_seasonal_content (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  venue_id uuid NOT NULL REFERENCES venues(id) ON DELETE CASCADE,
  season text NOT NULL CHECK (season IN ('spring', 'summer', 'fall', 'winter')),
  imagery text,
  phrases text[],
  created_at timestamptz DEFAULT now()
);
COMMENT ON TABLE venue_seasonal_content IS 'owner:ai_system';

-- Phrase Usage — anti-duplication tracking
CREATE TABLE phrase_usage (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  venue_id uuid NOT NULL REFERENCES venues(id) ON DELETE CASCADE,
  contact_email text NOT NULL,
  phrase_category text NOT NULL,
  phrase_text text NOT NULL,
  used_at timestamptz DEFAULT now()
);
COMMENT ON TABLE phrase_usage IS 'owner:ai_system';

-- Voice Training Sessions — game sessions for training venue voice
CREATE TABLE voice_training_sessions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  venue_id uuid NOT NULL REFERENCES venues(id) ON DELETE CASCADE,
  game_type text NOT NULL CHECK (game_type IN ('would_you_send', 'cringe_or_fine', 'quick_quiz')),
  completed_rounds int DEFAULT 0,
  total_rounds int,
  staff_email text,
  started_at timestamptz DEFAULT now(),
  completed_at timestamptz
);
COMMENT ON TABLE voice_training_sessions IS 'owner:ai_system';

-- Voice Training Responses — individual round responses within a session
CREATE TABLE voice_training_responses (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  session_id uuid NOT NULL REFERENCES voice_training_sessions(id) ON DELETE CASCADE,
  round_number int,
  content_type text,
  response text,
  response_reason text,
  created_at timestamptz DEFAULT now()
);
COMMENT ON TABLE voice_training_responses IS 'owner:ai_system';

-- Voice Preferences — learned preferences from training games
CREATE TABLE voice_preferences (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  venue_id uuid NOT NULL REFERENCES venues(id) ON DELETE CASCADE,
  preference_type text NOT NULL CHECK (preference_type IN ('banned_phrase', 'approved_phrase', 'dimension')),
  content text NOT NULL,
  score float DEFAULT 0,
  sample_count int DEFAULT 1,
  UNIQUE (venue_id, preference_type, content),
  created_at timestamptz DEFAULT now()
);
COMMENT ON TABLE voice_preferences IS 'owner:ai_system';

-- Indexes
CREATE INDEX idx_venue_usps_venue_id ON venue_usps(venue_id);
CREATE INDEX idx_venue_seasonal_content_venue_id ON venue_seasonal_content(venue_id);
CREATE INDEX idx_phrase_usage_venue_id ON phrase_usage(venue_id);
CREATE INDEX idx_voice_training_sessions_venue_id ON voice_training_sessions(venue_id);
CREATE INDEX idx_voice_training_responses_session_id ON voice_training_responses(session_id);
CREATE INDEX idx_voice_preferences_venue_id ON voice_preferences(venue_id);
