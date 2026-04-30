-- ---------------------------------------------------------------------------
-- 112_intelligence_insights_operations_category.sql
-- ---------------------------------------------------------------------------
-- Phase 2 daily integrity sweep follow-up. The previous migration
-- (111) added 'data_anomaly' to insight_type. The data-integrity
-- writer also needs an 'operations' category — none of the existing
-- categories (lead_conversion, response_time, team_performance,
-- pricing, seasonal, source_attribution, couple_behavior, capacity,
-- competitive, weather, market) describe a structural data
-- integrity violation cleanly.
-- ---------------------------------------------------------------------------

DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conname = 'intelligence_insights_category_check'
       AND conrelid = 'public.intelligence_insights'::regclass
  ) THEN
    ALTER TABLE public.intelligence_insights
      DROP CONSTRAINT intelligence_insights_category_check;
  END IF;
END $$;

ALTER TABLE public.intelligence_insights
  ADD CONSTRAINT intelligence_insights_category_check CHECK (category IN (
    'lead_conversion', 'response_time', 'team_performance',
    'pricing', 'seasonal', 'source_attribution', 'couple_behavior',
    'capacity', 'competitive', 'weather', 'market',
    -- Phase 2 (multi-venue rollout): data integrity sweep writes
    -- structural anomalies under this category.
    'operations'
  ));

NOTIFY pgrst, 'reload schema';
