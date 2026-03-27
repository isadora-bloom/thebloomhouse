-- ============================================
-- 003: INTELLIGENCE-OWNED TABLES
-- Owner: intelligence (analytics, attribution, trends, recommendations)
-- Depends on: 001_shared_tables.sql
-- ============================================

-- Marketing Spend — monthly spend per source
CREATE TABLE marketing_spend (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  venue_id uuid NOT NULL REFERENCES venues(id) ON DELETE CASCADE,
  source text NOT NULL,
  month date NOT NULL,
  amount decimal NOT NULL DEFAULT 0,
  notes text,
  created_at timestamptz DEFAULT now(),
  updated_at timestamptz DEFAULT now()
);
COMMENT ON TABLE marketing_spend IS 'owner:intelligence';

-- Source Attribution — calculated ROI by source
CREATE TABLE source_attribution (
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
COMMENT ON TABLE source_attribution IS 'owner:intelligence';

-- Search Trends — Google Trends data
CREATE TABLE search_trends (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  venue_id uuid NOT NULL REFERENCES venues(id) ON DELETE CASCADE,
  metro text,
  term text NOT NULL,
  week date NOT NULL,
  interest integer,
  created_at timestamptz DEFAULT now()
);
COMMENT ON TABLE search_trends IS 'owner:intelligence';

-- Trend Recommendations — proactive AI recommendations
CREATE TABLE trend_recommendations (
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
COMMENT ON TABLE trend_recommendations IS 'owner:intelligence';

-- AI Briefings — weekly/monthly AI briefings
CREATE TABLE ai_briefings (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  venue_id uuid NOT NULL REFERENCES venues(id) ON DELETE CASCADE,
  briefing_type text NOT NULL CHECK (briefing_type IN ('weekly', 'monthly', 'anomaly')),
  content jsonb NOT NULL DEFAULT '{}',
  delivered_via text,
  delivered_at timestamptz,
  created_at timestamptz DEFAULT now()
);
COMMENT ON TABLE ai_briefings IS 'owner:intelligence';

-- Anomaly Alerts — metric deviation alerts
CREATE TABLE anomaly_alerts (
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
COMMENT ON TABLE anomaly_alerts IS 'owner:intelligence';

-- Consultant Metrics — performance snapshots
CREATE TABLE consultant_metrics (
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
COMMENT ON TABLE consultant_metrics IS 'owner:intelligence';

-- Review Language — extracted review phrases
CREATE TABLE review_language (
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
COMMENT ON TABLE review_language IS 'owner:intelligence';

-- Weather Data — NOAA data for venue location
CREATE TABLE weather_data (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  venue_id uuid NOT NULL REFERENCES venues(id) ON DELETE CASCADE,
  date date NOT NULL,
  high_temp decimal,
  low_temp decimal,
  precipitation decimal,
  conditions text,
  source text
);
COMMENT ON TABLE weather_data IS 'owner:intelligence';

-- Economic Indicators — FRED data
CREATE TABLE economic_indicators (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  indicator_name text NOT NULL,
  date date NOT NULL,
  value decimal,
  source text
);
COMMENT ON TABLE economic_indicators IS 'owner:intelligence';

-- Natural Language Queries — NLQ log
CREATE TABLE natural_language_queries (
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
COMMENT ON TABLE natural_language_queries IS 'owner:intelligence';

-- ============================================
-- INDEXES
-- ============================================

-- marketing_spend
CREATE INDEX idx_marketing_spend_venue_id ON marketing_spend(venue_id);
CREATE INDEX idx_marketing_spend_month ON marketing_spend(venue_id, month);

-- source_attribution
CREATE INDEX idx_source_attribution_venue_id ON source_attribution(venue_id);
CREATE INDEX idx_source_attribution_source ON source_attribution(venue_id, source);

-- search_trends
CREATE INDEX idx_search_trends_venue_id ON search_trends(venue_id);
CREATE INDEX idx_search_trends_week ON search_trends(venue_id, week);

-- trend_recommendations
CREATE INDEX idx_trend_recommendations_venue_id ON trend_recommendations(venue_id);
CREATE INDEX idx_trend_recommendations_status ON trend_recommendations(venue_id, status);

-- ai_briefings
CREATE INDEX idx_ai_briefings_venue_id ON ai_briefings(venue_id);
CREATE INDEX idx_ai_briefings_type ON ai_briefings(venue_id, briefing_type);

-- anomaly_alerts
CREATE INDEX idx_anomaly_alerts_venue_id ON anomaly_alerts(venue_id);
CREATE INDEX idx_anomaly_alerts_severity ON anomaly_alerts(venue_id, severity);

-- consultant_metrics
CREATE INDEX idx_consultant_metrics_venue_id ON consultant_metrics(venue_id);
CREATE INDEX idx_consultant_metrics_consultant_id ON consultant_metrics(consultant_id);

-- review_language
CREATE INDEX idx_review_language_venue_id ON review_language(venue_id);

-- weather_data
CREATE INDEX idx_weather_data_venue_id ON weather_data(venue_id);
CREATE INDEX idx_weather_data_date ON weather_data(venue_id, date);

-- economic_indicators
CREATE INDEX idx_economic_indicators_date ON economic_indicators(date);
CREATE INDEX idx_economic_indicators_name ON economic_indicators(indicator_name);

-- natural_language_queries
CREATE INDEX idx_natural_language_queries_venue_id ON natural_language_queries(venue_id);
