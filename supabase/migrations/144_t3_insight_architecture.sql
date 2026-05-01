-- Migration 144: T3 insight-architecture columns + new insight_type values
--
-- Per Playbook Part 20 + ARCH-19.x: every insight follows a shared
-- pattern — classical compute (the numbers) → LLM narration (the
-- 1-2 sentence reasoning) → cache (so we don't re-narrate on every
-- read). T3 builds 9+ named insights on this pattern.
--
-- This migration adds the columns that pattern needs:
--   - surface_layer / surface_priority: per Part 20.4.1 four-layer grid.
--     'inline' = at-work-surface badges, 'pulse' = pulse drawer,
--     'digest' = email/weekly digest, 'on_demand' = /intel/* dashboard
--     only. surface_priority is the 5-component composite score that
--     ranks rows within a layer.
--   - cache_key: stable hash of the classical inputs. Used as part of
--     the (venue_id, insight_type, context_id, cache_key) idempotent
--     upsert key so re-running with the same numbers no-ops.
--   - last_classical_signature: jsonb snapshot of the classical
--     numbers at last narration. Lets the cache decide "regenerate"
--     vs "still fresh" without redoing the LLM call.
--   - llm_model_used: which Claude model produced the narration.
--     Drift detection ('claude-sonnet-4' → 'claude-sonnet-5' bump)
--     becomes an audit query.
--   - prompt_version_used: same idea but for the prompt revision
--     (matches the T1-E api_costs.prompt_version pattern).
--
-- Plus widens insight_type CHECK to allow the T3 subtypes:
--   - 'heat_narration'      — T3-A
--   - 'negotiation_state'   — T3-C
--   - 'cohort_match'        — T3-D
--   - 'risk_flag'           — T3-H
--
-- Idempotent: ADD COLUMN IF NOT EXISTS, DROP/CREATE the CHECK.

ALTER TABLE public.intelligence_insights
  ADD COLUMN IF NOT EXISTS surface_layer text,
  ADD COLUMN IF NOT EXISTS surface_priority numeric,
  ADD COLUMN IF NOT EXISTS cache_key text,
  ADD COLUMN IF NOT EXISTS last_classical_signature jsonb,
  ADD COLUMN IF NOT EXISTS llm_model_used text,
  ADD COLUMN IF NOT EXISTS prompt_version_used text;

ALTER TABLE public.intelligence_insights
  DROP CONSTRAINT IF EXISTS intelligence_insights_surface_layer_check;
ALTER TABLE public.intelligence_insights
  ADD CONSTRAINT intelligence_insights_surface_layer_check
    CHECK (surface_layer IS NULL OR surface_layer IN (
      'inline', 'pulse', 'digest', 'on_demand'
    ));

COMMENT ON COLUMN public.intelligence_insights.surface_layer IS
  'Part 20.4.1 four-layer grid. inline = at-work-surface badge; '
  'pulse = pulse drawer / top-bar; digest = email digest only; '
  'on_demand = /intel/* dashboard only. NULL = legacy / unrouted.';

COMMENT ON COLUMN public.intelligence_insights.surface_priority IS
  'Numeric composite priority for sort within a surface_layer. '
  'Higher = more prominent. Computed at write time per Part 20.4.1 '
  '(5 components: impact + confidence + recency + actionability + '
  'staleness penalty).';

COMMENT ON COLUMN public.intelligence_insights.cache_key IS
  'Stable hash of the classical inputs. Used as part of the '
  '(venue_id, insight_type, context_id, cache_key) upsert key so '
  're-running with the same numbers no-ops; changing numbers '
  'produces a new cache_key and forces regeneration.';

COMMENT ON COLUMN public.intelligence_insights.last_classical_signature IS
  'jsonb snapshot of the numbers the LLM was given at last '
  'narration. Cache freshness check compares current classical '
  'against this; mismatch triggers regeneration.';

COMMENT ON COLUMN public.intelligence_insights.llm_model_used IS
  'Claude model identifier from the narration call. Audit trail; '
  'mismatched against the current CLAUDE_MODEL constant means a '
  'pending regeneration.';

COMMENT ON COLUMN public.intelligence_insights.prompt_version_used IS
  'Brain prompt revision (matches T1-E api_costs.prompt_version). '
  'Bumping the prompt invalidates all rows with the prior version; '
  'next read regenerates.';

-- =====================================================================
-- Widen insight_type CHECK to allow T3 subtypes.
-- =====================================================================
-- Postgres requires DROP + ADD because the existing constraint is
-- anonymous-named (named at creation by Postgres). The DO block
-- discovers the actual name and drops it.

-- Drop both the explicit-named version (created by 080's DO block)
-- and any anonymous constraint that might have stuck around.
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
        -- T3 subtypes (this migration)
        'heat_narration',
        'negotiation_state',
        'cohort_match',
        'risk_flag',
        'pricing_elasticity',
        'source_mix_counterfactual',
        'decay_re_engagement'
      ));
END $$;

-- Idempotent unique-ish index for the cache-key path. Without it the
-- (venue_id, insight_type, context_id, cache_key) upsert pattern can
-- race. Partial — only meaningful when cache_key is set; legacy rows
-- with NULL cache_key keep working.
CREATE UNIQUE INDEX IF NOT EXISTS uq_intelligence_insights_cache_key
  ON public.intelligence_insights (venue_id, insight_type, context_id, cache_key)
  WHERE cache_key IS NOT NULL;
