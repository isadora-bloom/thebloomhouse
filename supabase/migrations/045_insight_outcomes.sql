-- ============================================
-- 043: INSIGHT OUTCOMES
-- Owner: intelligence (insight-action-result tracking)
-- Depends on: 041_intelligence_insights.sql, 001_shared_tables.sql
-- ============================================
-- Tracks the feedback loop: when a coordinator acts on an insight,
-- we record the baseline metric, wait for the measurement window,
-- then re-measure to determine if the action improved outcomes.

CREATE TABLE IF NOT EXISTS insight_outcomes (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  insight_id uuid NOT NULL REFERENCES intelligence_insights(id) ON DELETE CASCADE,
  venue_id uuid NOT NULL REFERENCES venues(id) ON DELETE CASCADE,

  -- What was done
  action_taken text NOT NULL,
  acted_at timestamptz DEFAULT now(),

  -- Baseline measurement (captured when action is taken)
  baseline_metric text NOT NULL,
  baseline_value float NOT NULL,
  baseline_period_start date NOT NULL,
  baseline_period_end date NOT NULL,

  -- Outcome measurement (filled in later by cron)
  outcome_value float,
  outcome_period_start date,
  outcome_period_end date,
  outcome_measured_at timestamptz,

  -- Assessment
  improvement_pct float,
  verdict text DEFAULT 'pending' CHECK (verdict IN ('improved', 'unchanged', 'declined', 'pending')),

  created_at timestamptz DEFAULT now()
);

COMMENT ON TABLE insight_outcomes IS 'owner:intelligence — tracks insight action outcomes for ROI measurement';

CREATE INDEX idx_insight_outcomes_insight ON insight_outcomes(insight_id);
CREATE INDEX idx_insight_outcomes_venue ON insight_outcomes(venue_id);
CREATE INDEX idx_insight_outcomes_verdict ON insight_outcomes(verdict);
CREATE INDEX idx_insight_outcomes_pending ON insight_outcomes(verdict, outcome_measured_at)
  WHERE verdict = 'pending' AND outcome_measured_at IS NULL;

-- RLS
ALTER TABLE insight_outcomes ENABLE ROW LEVEL SECURITY;

CREATE POLICY "auth_select_insight_outcomes" ON insight_outcomes
  FOR SELECT TO authenticated USING (true);
CREATE POLICY "auth_insert_insight_outcomes" ON insight_outcomes
  FOR INSERT TO authenticated WITH CHECK (true);
CREATE POLICY "auth_update_insight_outcomes" ON insight_outcomes
  FOR UPDATE TO authenticated USING (true) WITH CHECK (true);

CREATE POLICY "anon_select_insight_outcomes" ON insight_outcomes
  FOR SELECT TO anon USING (true);
CREATE POLICY "anon_insert_insight_outcomes" ON insight_outcomes
  FOR INSERT TO anon WITH CHECK (true);
CREATE POLICY "anon_update_insight_outcomes" ON insight_outcomes
  FOR UPDATE TO anon USING (true) WITH CHECK (true);
