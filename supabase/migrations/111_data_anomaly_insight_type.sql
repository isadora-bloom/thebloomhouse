-- ---------------------------------------------------------------------------
-- 111_data_anomaly_insight_type.sql
-- ---------------------------------------------------------------------------
-- Phase 2 daily integrity sweep (2026-04-30). The cron job runs the
-- data-integrity invariants per venue and writes one
-- intelligence_insights row per violated invariant so coordinators
-- see anomalies on /intel/anomalies without having to read script
-- output. Adds 'data_anomaly' to the insight_type CHECK so the cron
-- writer doesn't fail the constraint.
--
-- All other insight_type values are preserved.
-- ---------------------------------------------------------------------------

DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conname = 'intelligence_insights_insight_type_check'
       AND conrelid = 'public.intelligence_insights'::regclass
  ) THEN
    ALTER TABLE public.intelligence_insights
      DROP CONSTRAINT intelligence_insights_insight_type_check;
  END IF;
END $$;

ALTER TABLE public.intelligence_insights
  ADD CONSTRAINT intelligence_insights_insight_type_check CHECK (insight_type IN (
    'correlation',
    'anomaly',
    'prediction',
    'recommendation',
    'benchmark',
    'trend',
    'risk',
    'opportunity',
    -- Phase 4 additions
    'two_email_dropoff',
    'tour_attendee_signal',
    'friction_warning',
    'availability_pattern',
    'source_quality',
    -- Phase 2 (multi-venue rollout) addition: structural data
    -- integrity violations from the daily integrity sweep cron.
    'data_anomaly'
  ));

NOTIFY pgrst, 'reload schema';
