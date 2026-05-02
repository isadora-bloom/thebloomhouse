-- Migration 157: T5-θ.1 — correlation_narration insight type.
--
-- Per the YC-partner audit (2026-05-T4) CRITICAL #2 / Playbook USP #4:
-- the correlation engine writes 'correlation' rows whose body is a
-- template like "X and Y rise together with a 7-day lag (correlation
-- 0.62)." That's engineer-readable, not coordinator-readable. The
-- aspirational story Bloom claims is "Mortgage rates went up; tour
-- completions dropped two weeks later" — a plain-English narration
-- grounded in the same Pearson + lag the engine already computes.
--
-- This migration widens intelligence_insights.insight_type CHECK to
-- allow:
--   - 'correlation_narration' — LLM-written 2-3 sentence story for a
--     macro / cross-limb correlation, separate from the engine's
--     primary 'correlation' row. Each narration row carries its own
--     cache_key (FNV-1a hash of channel_a+channel_b+lag+r+series)
--     and surface_priority so the narration cards can sort against
--     each other.
--
-- Same DROP+ADD pattern as 144 / 145 (constraint name fingerprinted
-- via pg_constraint).
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
        -- T3-I (migration 145)
        'coordinator_override_pattern',
        'strength_area_cohort',
        -- T5-θ.1 (this migration) — LLM narration for cross-limb
        -- correlations. Companion to the existing 'correlation' rows
        -- written by correlation-engine.ts. The narration row carries
        -- its own cache_key + surface_priority so the new
        -- /intel/macro-correlations surface can sort and dedupe
        -- independently of the engine's mechanical pairs.
        'correlation_narration'
      ));
END $$;
