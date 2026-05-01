-- Migration 145: T3-I insight types — coordinator override pattern +
-- strength area cohort.
--
-- Per Playbook INS-19.6.2 (strength-area identification) + INS-19.6.4
-- (coordinator time/behavior insights): Bloom should surface insights
-- about ITSELF (data quality, AI-coordinator collaboration health,
-- venue strength areas) — not just outward-facing lead/pricing analysis.
--
-- This migration widens the intelligence_insights.insight_type CHECK
-- to allow:
--   - 'coordinator_override_pattern' — drift in coordinator's accept/
--     edit/reject mix on AI drafts; weekly trend with day-of-week
--     anomaly detection
--   - 'strength_area_cohort'         — per-guest-count band conversion
--     comparison; identifies which segment the venue's track record
--     strongest at vs weakest
--
-- Same DROP+ADD pattern as 144 (constraint name fingerprinted via
-- pg_constraint).
--
-- Idempotent.

ALTER TABLE public.intelligence_insights
  DROP CONSTRAINT IF EXISTS intelligence_insights_insight_type_check;

DO $$
DECLARE
  con_name text;
BEGIN
  SELECT conname
    INTO con_name
    FROM pg_constraint
   WHERE conrelid = 'public.intelligence_insights'::regclass
     AND contype = 'c'
     AND pg_get_constraintdef(oid) LIKE '%insight_type%IN%'
   LIMIT 1;

  IF con_name IS NOT NULL THEN
    EXECUTE format('ALTER TABLE public.intelligence_insights DROP CONSTRAINT %I', con_name);
  END IF;

  ALTER TABLE public.intelligence_insights
    ADD CONSTRAINT intelligence_insights_insight_type_check
      CHECK (insight_type IN (
        -- Original 8
        'correlation', 'anomaly', 'prediction', 'recommendation',
        'benchmark', 'trend', 'risk', 'opportunity',
        -- Phase 4 (migration 080)
        'two_email_dropoff', 'no_response_30d', 'tour_no_show',
        'heat_dropping', 'sustained_silence',
        -- Anomaly category (T2-B Phase 2)
        'data_anomaly',
        -- Operations (T2 era)
        'operations',
        -- T3 first wave (migration 144)
        'heat_narration',
        'negotiation_state',
        'cohort_match',
        'risk_flag',
        'pricing_elasticity',
        'source_mix_counterfactual',
        'decay_re_engagement',
        -- T3-I (this migration)
        'coordinator_override_pattern',
        'strength_area_cohort'
      ));
END $$;
