-- ---------------------------------------------------------------------------
-- 256_emotional_themes_insight_type.sql
-- ---------------------------------------------------------------------------
-- Wave 1C (2026-05-09). The 15th intelligence detector
-- (`detectEmotionalThemes` in src/lib/services/intel/intelligence-engine.ts)
-- writes rows under insight_type='emotional_theme' / category='emotional'
-- so the venue's strategy surface can read what couples are mentioning
-- beyond logistics. This migration widens the two CHECK constraints to
-- accept the new identifiers.
--
-- Also adds `venue_config.notify_on_sensitive_auto_context` (boolean,
-- default false) — opt-in flag for the real-time admin_notification
-- that fires when a sensitive-tagged auto-context note lands. Off by
-- default per the directive; coordinator turns on per-venue.
--
-- Same DROP+ADD pattern as 144 / 145 / 157 (constraint name discovered
-- via pg_constraint).
--
-- Idempotent. Safe to re-run.
-- ---------------------------------------------------------------------------

-- ============================================================================
-- STEP 1 — widen intelligence_insights.insight_type CHECK
-- ============================================================================

-- Postgres normalises `IN (...)` to `ANY (ARRAY[...])` inside
-- pg_get_constraintdef, so a LIKE '%IN%' lookup misses. Drop by
-- known name + fall back to a definition-text search for legacy
-- installs that may have a different constraint name.
DO $$
DECLARE
  con_name text;
BEGIN
  ALTER TABLE public.intelligence_insights
    DROP CONSTRAINT IF EXISTS intelligence_insights_insight_type_check;

  SELECT conname
    INTO con_name
    FROM pg_constraint
   WHERE conrelid = 'public.intelligence_insights'::regclass
     AND contype = 'c'
     AND pg_get_constraintdef(oid) LIKE '%insight_type%'
   LIMIT 1;

  IF con_name IS NOT NULL THEN
    EXECUTE format('ALTER TABLE public.intelligence_insights DROP CONSTRAINT %I', con_name);
  END IF;

  ALTER TABLE public.intelligence_insights
    ADD CONSTRAINT intelligence_insights_insight_type_check
      CHECK (insight_type IN (
        -- Original 8 (migration 041)
        'correlation', 'anomaly', 'prediction', 'recommendation',
        'benchmark', 'trend', 'risk', 'opportunity',
        -- Phase 4 (migration 080)
        'two_email_dropoff', 'no_response_30d', 'tour_no_show',
        'heat_dropping', 'sustained_silence',
        -- Anomaly category (migration 111)
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
        -- T5-θ.1 (migration 157)
        'correlation_narration',
        -- Wave 1C (this migration) — venue-aggregate emotional theme
        -- pulse from the 15th intelligence detector. Reads
        -- wedding_auto_context across all couples and surfaces
        -- wedding-industry-relevant theme uptakes (cultural ceremony
        -- asks doubling, vendor-preference clusters, etc.). Sensitive
        -- categories (health/grief/financial_stress/family_conflict/
        -- mental_health) report counts only — never names couples.
        'emotional_theme'
      ));
END $$;

-- ============================================================================
-- STEP 2 — widen intelligence_insights.category CHECK
-- ============================================================================
-- The detector writes category='emotional' so the dashboard / filters
-- can distinguish theme-pulse rows from operational / market / pricing
-- rows.

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
    -- Phase 2 (migration 112)
    'operations',
    -- Wave 1C (this migration) — soft-context theme rollups across
    -- couples. Distinct from 'couple_behavior' which is per-couple
    -- behavior modeling; 'emotional' is venue-aggregate.
    'emotional'
  ));

-- ============================================================================
-- STEP 3 — venue_config.notify_on_sensitive_auto_context
-- ============================================================================
-- Opt-in flag. When true, the soft-context writer fires a low-priority
-- admin_notification each time a sensitive=true note lands. Off by
-- default — coordinators may not want a real-time ping every time the
-- AI flags a grief mention. The notification body NEVER contains the
-- note body; only "a sensitive note landed for couple X" with a link
-- to the lead profile.

ALTER TABLE public.venue_config
  ADD COLUMN IF NOT EXISTS notify_on_sensitive_auto_context boolean NOT NULL DEFAULT false;

COMMENT ON COLUMN public.venue_config.notify_on_sensitive_auto_context IS
  'Wave 1C (2026-05-09). When true, fires a low-priority admin_notification '
  'each time a sensitive-tagged auto-context note lands. The notification '
  'never echoes the body, only signals that a sensitive note arrived for '
  'a specific couple. Default false — coordinator opts in per venue.';

NOTIFY pgrst, 'reload schema';
