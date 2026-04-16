-- ============================================
-- 041: INTELLIGENCE INSIGHTS
-- Owner: intelligence (core pattern detection engine)
-- Depends on: 001_shared_tables.sql
-- ============================================

CREATE TABLE IF NOT EXISTS intelligence_insights (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  venue_id uuid NOT NULL REFERENCES venues(id) ON DELETE CASCADE,
  org_id uuid REFERENCES organisations(id),

  -- Classification
  insight_type text NOT NULL CHECK (insight_type IN (
    'correlation',      -- X correlates with Y
    'anomaly',          -- something changed unexpectedly
    'prediction',       -- likely future outcome
    'recommendation',   -- specific action to take
    'benchmark',        -- how you compare to peers/self
    'trend',            -- directional change over time
    'risk',             -- something that needs attention
    'opportunity'       -- untapped potential
  )),
  category text NOT NULL CHECK (category IN (
    'lead_conversion', 'response_time', 'team_performance',
    'pricing', 'seasonal', 'source_attribution', 'couple_behavior',
    'capacity', 'competitive', 'weather', 'market'
  )),

  -- Content
  title text NOT NULL,           -- "Thursday tours convert 2x Saturday"
  body text NOT NULL,            -- full explanation
  action text,                   -- specific recommended action

  -- Scoring
  priority text DEFAULT 'medium' CHECK (priority IN ('critical', 'high', 'medium', 'low')),
  confidence float DEFAULT 0.5 CHECK (confidence BETWEEN 0 AND 1),
  impact_score float,            -- estimated revenue/time impact

  -- Data backing
  data_points jsonb DEFAULT '{}',  -- the raw numbers behind the insight
  compared_to text,               -- 'last_month', 'same_month_last_year', 'industry', 'portfolio'

  -- Lifecycle
  status text DEFAULT 'new' CHECK (status IN ('new', 'seen', 'acted_on', 'dismissed', 'expired')),
  seen_at timestamptz,
  acted_on_at timestamptz,
  dismissed_at timestamptz,
  expires_at timestamptz,

  -- Tracking
  created_at timestamptz DEFAULT now(),
  updated_at timestamptz DEFAULT now()
);

COMMENT ON TABLE intelligence_insights IS 'owner:intelligence';

CREATE INDEX idx_insights_venue ON intelligence_insights(venue_id);
CREATE INDEX idx_insights_status ON intelligence_insights(status);
CREATE INDEX idx_insights_type ON intelligence_insights(insight_type);
CREATE INDEX idx_insights_priority ON intelligence_insights(priority);
CREATE INDEX idx_insights_created ON intelligence_insights(created_at DESC);

-- RLS
ALTER TABLE intelligence_insights ENABLE ROW LEVEL SECURITY;
CREATE POLICY "auth_select_insights" ON intelligence_insights FOR SELECT TO authenticated USING (true);
CREATE POLICY "auth_insert_insights" ON intelligence_insights FOR INSERT TO authenticated WITH CHECK (true);
CREATE POLICY "auth_update_insights" ON intelligence_insights FOR UPDATE TO authenticated USING (true) WITH CHECK (true);
CREATE POLICY "anon_select_insights" ON intelligence_insights FOR SELECT TO anon USING (true);
CREATE POLICY "anon_insert_insights" ON intelligence_insights FOR INSERT TO anon WITH CHECK (true);
CREATE POLICY "anon_update_insights" ON intelligence_insights FOR UPDATE TO anon USING (true) WITH CHECK (true);
