-- ============================================
-- 006: ROW LEVEL SECURITY POLICIES
-- Enables RLS on every table and creates
-- venue isolation + super_admin bypass policies.
-- ============================================

-- ============================================
-- 001: SHARED TABLES
-- ============================================

-- organisations (no venue_id — super_admin only)
ALTER TABLE organisations ENABLE ROW LEVEL SECURITY;

CREATE POLICY "super_admin_access" ON organisations
  FOR ALL
  USING (EXISTS (SELECT 1 FROM user_profiles WHERE id = auth.uid() AND role = 'super_admin'));

-- venues
ALTER TABLE venues ENABLE ROW LEVEL SECURITY;

CREATE POLICY "venue_isolation" ON venues
  FOR ALL
  USING (id = (SELECT venue_id FROM user_profiles WHERE id = auth.uid()));

CREATE POLICY "super_admin_bypass" ON venues
  FOR ALL
  USING (EXISTS (SELECT 1 FROM user_profiles WHERE id = auth.uid() AND role = 'super_admin'));

-- venue_config
ALTER TABLE venue_config ENABLE ROW LEVEL SECURITY;

CREATE POLICY "venue_isolation" ON venue_config
  FOR ALL
  USING (venue_id = (SELECT venue_id FROM user_profiles WHERE id = auth.uid()));

CREATE POLICY "super_admin_bypass" ON venue_config
  FOR ALL
  USING (EXISTS (SELECT 1 FROM user_profiles WHERE id = auth.uid() AND role = 'super_admin'));

-- venue_ai_config
ALTER TABLE venue_ai_config ENABLE ROW LEVEL SECURITY;

CREATE POLICY "venue_isolation" ON venue_ai_config
  FOR ALL
  USING (venue_id = (SELECT venue_id FROM user_profiles WHERE id = auth.uid()));

CREATE POLICY "super_admin_bypass" ON venue_ai_config
  FOR ALL
  USING (EXISTS (SELECT 1 FROM user_profiles WHERE id = auth.uid() AND role = 'super_admin'));

-- user_profiles (special: own profile + super_admin)
ALTER TABLE user_profiles ENABLE ROW LEVEL SECURITY;

CREATE POLICY "own_profile" ON user_profiles
  FOR ALL
  USING (id = auth.uid());

CREATE POLICY "super_admin_bypass" ON user_profiles
  FOR ALL
  USING (EXISTS (SELECT 1 FROM user_profiles WHERE id = auth.uid() AND role = 'super_admin'));

-- weddings
ALTER TABLE weddings ENABLE ROW LEVEL SECURITY;

CREATE POLICY "venue_isolation" ON weddings
  FOR ALL
  USING (venue_id = (SELECT venue_id FROM user_profiles WHERE id = auth.uid()));

CREATE POLICY "super_admin_bypass" ON weddings
  FOR ALL
  USING (EXISTS (SELECT 1 FROM user_profiles WHERE id = auth.uid() AND role = 'super_admin'));

-- people
ALTER TABLE people ENABLE ROW LEVEL SECURITY;

CREATE POLICY "venue_isolation" ON people
  FOR ALL
  USING (venue_id = (SELECT venue_id FROM user_profiles WHERE id = auth.uid()));

CREATE POLICY "super_admin_bypass" ON people
  FOR ALL
  USING (EXISTS (SELECT 1 FROM user_profiles WHERE id = auth.uid() AND role = 'super_admin'));

-- contacts (via person_id → people.venue_id)
ALTER TABLE contacts ENABLE ROW LEVEL SECURITY;

CREATE POLICY "venue_isolation" ON contacts
  FOR ALL
  USING (EXISTS (
    SELECT 1 FROM people
    WHERE people.id = contacts.person_id
    AND people.venue_id = (SELECT venue_id FROM user_profiles WHERE id = auth.uid())
  ));

CREATE POLICY "super_admin_bypass" ON contacts
  FOR ALL
  USING (EXISTS (SELECT 1 FROM user_profiles WHERE id = auth.uid() AND role = 'super_admin'));

-- knowledge_base
ALTER TABLE knowledge_base ENABLE ROW LEVEL SECURITY;

CREATE POLICY "venue_isolation" ON knowledge_base
  FOR ALL
  USING (venue_id = (SELECT venue_id FROM user_profiles WHERE id = auth.uid()));

CREATE POLICY "super_admin_bypass" ON knowledge_base
  FOR ALL
  USING (EXISTS (SELECT 1 FROM user_profiles WHERE id = auth.uid() AND role = 'super_admin'));

-- booked_dates
ALTER TABLE booked_dates ENABLE ROW LEVEL SECURITY;

CREATE POLICY "venue_isolation" ON booked_dates
  FOR ALL
  USING (venue_id = (SELECT venue_id FROM user_profiles WHERE id = auth.uid()));

CREATE POLICY "super_admin_bypass" ON booked_dates
  FOR ALL
  USING (EXISTS (SELECT 1 FROM user_profiles WHERE id = auth.uid() AND role = 'super_admin'));

-- ============================================
-- 002: AGENT TABLES
-- ============================================

-- interactions
ALTER TABLE interactions ENABLE ROW LEVEL SECURITY;

CREATE POLICY "venue_isolation" ON interactions
  FOR ALL
  USING (venue_id = (SELECT venue_id FROM user_profiles WHERE id = auth.uid()));

CREATE POLICY "super_admin_bypass" ON interactions
  FOR ALL
  USING (EXISTS (SELECT 1 FROM user_profiles WHERE id = auth.uid() AND role = 'super_admin'));

-- drafts
ALTER TABLE drafts ENABLE ROW LEVEL SECURITY;

CREATE POLICY "venue_isolation" ON drafts
  FOR ALL
  USING (venue_id = (SELECT venue_id FROM user_profiles WHERE id = auth.uid()));

CREATE POLICY "super_admin_bypass" ON drafts
  FOR ALL
  USING (EXISTS (SELECT 1 FROM user_profiles WHERE id = auth.uid() AND role = 'super_admin'));

-- engagement_events
ALTER TABLE engagement_events ENABLE ROW LEVEL SECURITY;

CREATE POLICY "venue_isolation" ON engagement_events
  FOR ALL
  USING (venue_id = (SELECT venue_id FROM user_profiles WHERE id = auth.uid()));

CREATE POLICY "super_admin_bypass" ON engagement_events
  FOR ALL
  USING (EXISTS (SELECT 1 FROM user_profiles WHERE id = auth.uid() AND role = 'super_admin'));

-- lead_score_history
ALTER TABLE lead_score_history ENABLE ROW LEVEL SECURITY;

CREATE POLICY "venue_isolation" ON lead_score_history
  FOR ALL
  USING (venue_id = (SELECT venue_id FROM user_profiles WHERE id = auth.uid()));

CREATE POLICY "super_admin_bypass" ON lead_score_history
  FOR ALL
  USING (EXISTS (SELECT 1 FROM user_profiles WHERE id = auth.uid() AND role = 'super_admin'));

-- heat_score_config
ALTER TABLE heat_score_config ENABLE ROW LEVEL SECURITY;

CREATE POLICY "venue_isolation" ON heat_score_config
  FOR ALL
  USING (venue_id = (SELECT venue_id FROM user_profiles WHERE id = auth.uid()));

CREATE POLICY "super_admin_bypass" ON heat_score_config
  FOR ALL
  USING (EXISTS (SELECT 1 FROM user_profiles WHERE id = auth.uid() AND role = 'super_admin'));

-- draft_feedback
ALTER TABLE draft_feedback ENABLE ROW LEVEL SECURITY;

CREATE POLICY "venue_isolation" ON draft_feedback
  FOR ALL
  USING (venue_id = (SELECT venue_id FROM user_profiles WHERE id = auth.uid()));

CREATE POLICY "super_admin_bypass" ON draft_feedback
  FOR ALL
  USING (EXISTS (SELECT 1 FROM user_profiles WHERE id = auth.uid() AND role = 'super_admin'));

-- learned_preferences
ALTER TABLE learned_preferences ENABLE ROW LEVEL SECURITY;

CREATE POLICY "venue_isolation" ON learned_preferences
  FOR ALL
  USING (venue_id = (SELECT venue_id FROM user_profiles WHERE id = auth.uid()));

CREATE POLICY "super_admin_bypass" ON learned_preferences
  FOR ALL
  USING (EXISTS (SELECT 1 FROM user_profiles WHERE id = auth.uid() AND role = 'super_admin'));

-- auto_send_rules
ALTER TABLE auto_send_rules ENABLE ROW LEVEL SECURITY;

CREATE POLICY "venue_isolation" ON auto_send_rules
  FOR ALL
  USING (venue_id = (SELECT venue_id FROM user_profiles WHERE id = auth.uid()));

CREATE POLICY "super_admin_bypass" ON auto_send_rules
  FOR ALL
  USING (EXISTS (SELECT 1 FROM user_profiles WHERE id = auth.uid() AND role = 'super_admin'));

-- intelligence_extractions
ALTER TABLE intelligence_extractions ENABLE ROW LEVEL SECURITY;

CREATE POLICY "venue_isolation" ON intelligence_extractions
  FOR ALL
  USING (venue_id = (SELECT venue_id FROM user_profiles WHERE id = auth.uid()));

CREATE POLICY "super_admin_bypass" ON intelligence_extractions
  FOR ALL
  USING (EXISTS (SELECT 1 FROM user_profiles WHERE id = auth.uid() AND role = 'super_admin'));

-- email_sync_state
ALTER TABLE email_sync_state ENABLE ROW LEVEL SECURITY;

CREATE POLICY "venue_isolation" ON email_sync_state
  FOR ALL
  USING (venue_id = (SELECT venue_id FROM user_profiles WHERE id = auth.uid()));

CREATE POLICY "super_admin_bypass" ON email_sync_state
  FOR ALL
  USING (EXISTS (SELECT 1 FROM user_profiles WHERE id = auth.uid() AND role = 'super_admin'));

-- api_costs (venue_id is nullable — handle with separate policies)
ALTER TABLE api_costs ENABLE ROW LEVEL SECURITY;

CREATE POLICY "venue_isolation" ON api_costs
  FOR ALL
  USING (
    venue_id IS NOT NULL
    AND venue_id = (SELECT venue_id FROM user_profiles WHERE id = auth.uid())
  );

CREATE POLICY "super_admin_bypass" ON api_costs
  FOR ALL
  USING (EXISTS (SELECT 1 FROM user_profiles WHERE id = auth.uid() AND role = 'super_admin'));

-- ============================================
-- 003: INTELLIGENCE TABLES
-- ============================================

-- marketing_spend
ALTER TABLE marketing_spend ENABLE ROW LEVEL SECURITY;

CREATE POLICY "venue_isolation" ON marketing_spend
  FOR ALL
  USING (venue_id = (SELECT venue_id FROM user_profiles WHERE id = auth.uid()));

CREATE POLICY "super_admin_bypass" ON marketing_spend
  FOR ALL
  USING (EXISTS (SELECT 1 FROM user_profiles WHERE id = auth.uid() AND role = 'super_admin'));

-- source_attribution
ALTER TABLE source_attribution ENABLE ROW LEVEL SECURITY;

CREATE POLICY "venue_isolation" ON source_attribution
  FOR ALL
  USING (venue_id = (SELECT venue_id FROM user_profiles WHERE id = auth.uid()));

CREATE POLICY "super_admin_bypass" ON source_attribution
  FOR ALL
  USING (EXISTS (SELECT 1 FROM user_profiles WHERE id = auth.uid() AND role = 'super_admin'));

-- search_trends
ALTER TABLE search_trends ENABLE ROW LEVEL SECURITY;

CREATE POLICY "venue_isolation" ON search_trends
  FOR ALL
  USING (venue_id = (SELECT venue_id FROM user_profiles WHERE id = auth.uid()));

CREATE POLICY "super_admin_bypass" ON search_trends
  FOR ALL
  USING (EXISTS (SELECT 1 FROM user_profiles WHERE id = auth.uid() AND role = 'super_admin'));

-- trend_recommendations
ALTER TABLE trend_recommendations ENABLE ROW LEVEL SECURITY;

CREATE POLICY "venue_isolation" ON trend_recommendations
  FOR ALL
  USING (venue_id = (SELECT venue_id FROM user_profiles WHERE id = auth.uid()));

CREATE POLICY "super_admin_bypass" ON trend_recommendations
  FOR ALL
  USING (EXISTS (SELECT 1 FROM user_profiles WHERE id = auth.uid() AND role = 'super_admin'));

-- ai_briefings
ALTER TABLE ai_briefings ENABLE ROW LEVEL SECURITY;

CREATE POLICY "venue_isolation" ON ai_briefings
  FOR ALL
  USING (venue_id = (SELECT venue_id FROM user_profiles WHERE id = auth.uid()));

CREATE POLICY "super_admin_bypass" ON ai_briefings
  FOR ALL
  USING (EXISTS (SELECT 1 FROM user_profiles WHERE id = auth.uid() AND role = 'super_admin'));

-- anomaly_alerts
ALTER TABLE anomaly_alerts ENABLE ROW LEVEL SECURITY;

CREATE POLICY "venue_isolation" ON anomaly_alerts
  FOR ALL
  USING (venue_id = (SELECT venue_id FROM user_profiles WHERE id = auth.uid()));

CREATE POLICY "super_admin_bypass" ON anomaly_alerts
  FOR ALL
  USING (EXISTS (SELECT 1 FROM user_profiles WHERE id = auth.uid() AND role = 'super_admin'));

-- consultant_metrics
ALTER TABLE consultant_metrics ENABLE ROW LEVEL SECURITY;

CREATE POLICY "venue_isolation" ON consultant_metrics
  FOR ALL
  USING (venue_id = (SELECT venue_id FROM user_profiles WHERE id = auth.uid()));

CREATE POLICY "super_admin_bypass" ON consultant_metrics
  FOR ALL
  USING (EXISTS (SELECT 1 FROM user_profiles WHERE id = auth.uid() AND role = 'super_admin'));

-- review_language
ALTER TABLE review_language ENABLE ROW LEVEL SECURITY;

CREATE POLICY "venue_isolation" ON review_language
  FOR ALL
  USING (venue_id = (SELECT venue_id FROM user_profiles WHERE id = auth.uid()));

CREATE POLICY "super_admin_bypass" ON review_language
  FOR ALL
  USING (EXISTS (SELECT 1 FROM user_profiles WHERE id = auth.uid() AND role = 'super_admin'));

-- weather_data
ALTER TABLE weather_data ENABLE ROW LEVEL SECURITY;

CREATE POLICY "venue_isolation" ON weather_data
  FOR ALL
  USING (venue_id = (SELECT venue_id FROM user_profiles WHERE id = auth.uid()));

CREATE POLICY "super_admin_bypass" ON weather_data
  FOR ALL
  USING (EXISTS (SELECT 1 FROM user_profiles WHERE id = auth.uid() AND role = 'super_admin'));

-- economic_indicators (no venue_id — super_admin only)
ALTER TABLE economic_indicators ENABLE ROW LEVEL SECURITY;

CREATE POLICY "super_admin_access" ON economic_indicators
  FOR ALL
  USING (EXISTS (SELECT 1 FROM user_profiles WHERE id = auth.uid() AND role = 'super_admin'));

-- natural_language_queries
ALTER TABLE natural_language_queries ENABLE ROW LEVEL SECURITY;

CREATE POLICY "venue_isolation" ON natural_language_queries
  FOR ALL
  USING (venue_id = (SELECT venue_id FROM user_profiles WHERE id = auth.uid()));

CREATE POLICY "super_admin_bypass" ON natural_language_queries
  FOR ALL
  USING (EXISTS (SELECT 1 FROM user_profiles WHERE id = auth.uid() AND role = 'super_admin'));

-- ============================================
-- 004: PORTAL TABLES
-- ============================================

-- guest_list
ALTER TABLE guest_list ENABLE ROW LEVEL SECURITY;

CREATE POLICY "venue_isolation" ON guest_list
  FOR ALL
  USING (venue_id = (SELECT venue_id FROM user_profiles WHERE id = auth.uid()));

CREATE POLICY "super_admin_bypass" ON guest_list
  FOR ALL
  USING (EXISTS (SELECT 1 FROM user_profiles WHERE id = auth.uid() AND role = 'super_admin'));

-- timeline
ALTER TABLE timeline ENABLE ROW LEVEL SECURITY;

CREATE POLICY "venue_isolation" ON timeline
  FOR ALL
  USING (venue_id = (SELECT venue_id FROM user_profiles WHERE id = auth.uid()));

CREATE POLICY "super_admin_bypass" ON timeline
  FOR ALL
  USING (EXISTS (SELECT 1 FROM user_profiles WHERE id = auth.uid() AND role = 'super_admin'));

-- budget
ALTER TABLE budget ENABLE ROW LEVEL SECURITY;

CREATE POLICY "venue_isolation" ON budget
  FOR ALL
  USING (venue_id = (SELECT venue_id FROM user_profiles WHERE id = auth.uid()));

CREATE POLICY "super_admin_bypass" ON budget
  FOR ALL
  USING (EXISTS (SELECT 1 FROM user_profiles WHERE id = auth.uid() AND role = 'super_admin'));

-- seating_tables
ALTER TABLE seating_tables ENABLE ROW LEVEL SECURITY;

CREATE POLICY "venue_isolation" ON seating_tables
  FOR ALL
  USING (venue_id = (SELECT venue_id FROM user_profiles WHERE id = auth.uid()));

CREATE POLICY "super_admin_bypass" ON seating_tables
  FOR ALL
  USING (EXISTS (SELECT 1 FROM user_profiles WHERE id = auth.uid() AND role = 'super_admin'));

-- seating_assignments
ALTER TABLE seating_assignments ENABLE ROW LEVEL SECURITY;

CREATE POLICY "venue_isolation" ON seating_assignments
  FOR ALL
  USING (venue_id = (SELECT venue_id FROM user_profiles WHERE id = auth.uid()));

CREATE POLICY "super_admin_bypass" ON seating_assignments
  FOR ALL
  USING (EXISTS (SELECT 1 FROM user_profiles WHERE id = auth.uid() AND role = 'super_admin'));

-- sage_conversations
ALTER TABLE sage_conversations ENABLE ROW LEVEL SECURITY;

CREATE POLICY "venue_isolation" ON sage_conversations
  FOR ALL
  USING (venue_id = (SELECT venue_id FROM user_profiles WHERE id = auth.uid()));

CREATE POLICY "super_admin_bypass" ON sage_conversations
  FOR ALL
  USING (EXISTS (SELECT 1 FROM user_profiles WHERE id = auth.uid() AND role = 'super_admin'));

-- sage_uncertain_queue
ALTER TABLE sage_uncertain_queue ENABLE ROW LEVEL SECURITY;

CREATE POLICY "venue_isolation" ON sage_uncertain_queue
  FOR ALL
  USING (venue_id = (SELECT venue_id FROM user_profiles WHERE id = auth.uid()));

CREATE POLICY "super_admin_bypass" ON sage_uncertain_queue
  FOR ALL
  USING (EXISTS (SELECT 1 FROM user_profiles WHERE id = auth.uid() AND role = 'super_admin'));

-- planning_notes
ALTER TABLE planning_notes ENABLE ROW LEVEL SECURITY;

CREATE POLICY "venue_isolation" ON planning_notes
  FOR ALL
  USING (venue_id = (SELECT venue_id FROM user_profiles WHERE id = auth.uid()));

CREATE POLICY "super_admin_bypass" ON planning_notes
  FOR ALL
  USING (EXISTS (SELECT 1 FROM user_profiles WHERE id = auth.uid() AND role = 'super_admin'));

-- contracts
ALTER TABLE contracts ENABLE ROW LEVEL SECURITY;

CREATE POLICY "venue_isolation" ON contracts
  FOR ALL
  USING (venue_id = (SELECT venue_id FROM user_profiles WHERE id = auth.uid()));

CREATE POLICY "super_admin_bypass" ON contracts
  FOR ALL
  USING (EXISTS (SELECT 1 FROM user_profiles WHERE id = auth.uid() AND role = 'super_admin'));

-- checklist_items
ALTER TABLE checklist_items ENABLE ROW LEVEL SECURITY;

CREATE POLICY "venue_isolation" ON checklist_items
  FOR ALL
  USING (venue_id = (SELECT venue_id FROM user_profiles WHERE id = auth.uid()));

CREATE POLICY "super_admin_bypass" ON checklist_items
  FOR ALL
  USING (EXISTS (SELECT 1 FROM user_profiles WHERE id = auth.uid() AND role = 'super_admin'));

-- messages
ALTER TABLE messages ENABLE ROW LEVEL SECURITY;

CREATE POLICY "venue_isolation" ON messages
  FOR ALL
  USING (venue_id = (SELECT venue_id FROM user_profiles WHERE id = auth.uid()));

CREATE POLICY "super_admin_bypass" ON messages
  FOR ALL
  USING (EXISTS (SELECT 1 FROM user_profiles WHERE id = auth.uid() AND role = 'super_admin'));

-- vendor_recommendations
ALTER TABLE vendor_recommendations ENABLE ROW LEVEL SECURITY;

CREATE POLICY "venue_isolation" ON vendor_recommendations
  FOR ALL
  USING (venue_id = (SELECT venue_id FROM user_profiles WHERE id = auth.uid()));

CREATE POLICY "super_admin_bypass" ON vendor_recommendations
  FOR ALL
  USING (EXISTS (SELECT 1 FROM user_profiles WHERE id = auth.uid() AND role = 'super_admin'));

-- inspo_gallery
ALTER TABLE inspo_gallery ENABLE ROW LEVEL SECURITY;

CREATE POLICY "venue_isolation" ON inspo_gallery
  FOR ALL
  USING (venue_id = (SELECT venue_id FROM user_profiles WHERE id = auth.uid()));

CREATE POLICY "super_admin_bypass" ON inspo_gallery
  FOR ALL
  USING (EXISTS (SELECT 1 FROM user_profiles WHERE id = auth.uid() AND role = 'super_admin'));

-- ============================================
-- 005: AI SYSTEM TABLES
-- ============================================

-- venue_usps
ALTER TABLE venue_usps ENABLE ROW LEVEL SECURITY;

CREATE POLICY "venue_isolation" ON venue_usps
  FOR ALL
  USING (venue_id = (SELECT venue_id FROM user_profiles WHERE id = auth.uid()));

CREATE POLICY "super_admin_bypass" ON venue_usps
  FOR ALL
  USING (EXISTS (SELECT 1 FROM user_profiles WHERE id = auth.uid() AND role = 'super_admin'));

-- venue_seasonal_content
ALTER TABLE venue_seasonal_content ENABLE ROW LEVEL SECURITY;

CREATE POLICY "venue_isolation" ON venue_seasonal_content
  FOR ALL
  USING (venue_id = (SELECT venue_id FROM user_profiles WHERE id = auth.uid()));

CREATE POLICY "super_admin_bypass" ON venue_seasonal_content
  FOR ALL
  USING (EXISTS (SELECT 1 FROM user_profiles WHERE id = auth.uid() AND role = 'super_admin'));

-- phrase_usage
ALTER TABLE phrase_usage ENABLE ROW LEVEL SECURITY;

CREATE POLICY "venue_isolation" ON phrase_usage
  FOR ALL
  USING (venue_id = (SELECT venue_id FROM user_profiles WHERE id = auth.uid()));

CREATE POLICY "super_admin_bypass" ON phrase_usage
  FOR ALL
  USING (EXISTS (SELECT 1 FROM user_profiles WHERE id = auth.uid() AND role = 'super_admin'));

-- voice_training_sessions
ALTER TABLE voice_training_sessions ENABLE ROW LEVEL SECURITY;

CREATE POLICY "venue_isolation" ON voice_training_sessions
  FOR ALL
  USING (venue_id = (SELECT venue_id FROM user_profiles WHERE id = auth.uid()));

CREATE POLICY "super_admin_bypass" ON voice_training_sessions
  FOR ALL
  USING (EXISTS (SELECT 1 FROM user_profiles WHERE id = auth.uid() AND role = 'super_admin'));

-- voice_training_responses (via session_id → voice_training_sessions.venue_id)
ALTER TABLE voice_training_responses ENABLE ROW LEVEL SECURITY;

CREATE POLICY "venue_isolation" ON voice_training_responses
  FOR ALL
  USING (EXISTS (
    SELECT 1 FROM voice_training_sessions
    WHERE voice_training_sessions.id = voice_training_responses.session_id
    AND voice_training_sessions.venue_id = (SELECT venue_id FROM user_profiles WHERE id = auth.uid())
  ));

CREATE POLICY "super_admin_bypass" ON voice_training_responses
  FOR ALL
  USING (EXISTS (SELECT 1 FROM user_profiles WHERE id = auth.uid() AND role = 'super_admin'));

-- voice_preferences
ALTER TABLE voice_preferences ENABLE ROW LEVEL SECURITY;

CREATE POLICY "venue_isolation" ON voice_preferences
  FOR ALL
  USING (venue_id = (SELECT venue_id FROM user_profiles WHERE id = auth.uid()));

CREATE POLICY "super_admin_bypass" ON voice_preferences
  FOR ALL
  USING (EXISTS (SELECT 1 FROM user_profiles WHERE id = auth.uid() AND role = 'super_admin'));
