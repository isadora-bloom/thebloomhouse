-- ---------------------------------------------------------------------------
-- 316_heat_as_view.sql
-- ---------------------------------------------------------------------------
-- Architectural deep-fix for IDENTITY-RESOLUTION-AUDIT-2026-05-12 finding F1.
--
-- Pre-fix: weddings.heat_score and weddings.temperature_tier were STORED
-- columns. Every writer of engagement_events also had to call
-- recalculateHeatScore() to keep the columns in sync. Multiple writers
-- (the backfill script for Wave 28 voice events being the most recent
-- offender) forgot, and the column drifted to 0 even when many
-- engagement_events rows existed with points > 0. Justin & Sandy at
-- Rixey had 14 inbound voice events at points=8 each but heat_score=0
-- for ~2 weeks because backfill-voice-heat created the events but
-- never recomputed.
--
-- Post-fix: heat is a DERIVED view. The view runs the same 0.98^days
-- decay sum at read time. There is no write path. The "forgot to
-- recompute" bug class cannot reoccur because no caller can write a
-- stale value to a column that no longer exists.
--
-- Trade-offs:
--   * Read cost moves from a column lookup to a small aggregate
--     (engagement_events filtered by wedding_id with an inbound index).
--     The engagement_events_wedding_occurred_idx + idx_engagement_events_
--     inbound from 089 / 116 keep this cheap. If the view becomes hot,
--     a future migration can convert it to MATERIALIZED with a refresh
--     trigger on engagement_events insert.
--   * Phase B contribution (candidate_identities + attribution_events
--     adjustment, original logic at heat-mapping.ts:768-809) IS inlined
--     here in SQL so the view returns the same numeric the TS scorer
--     used to compute.
--   * Cohort damping (heat-mapping.ts:814+) is DEFERRED from the view
--     for performance: it requires a cross-wedding similarity join per
--     row read, and at venue scale (100+ weddings, dashboard reads)
--     that would be the dominant cost. The view returns the un-damped
--     score; callers that need damping (the heat-narration insight)
--     continue to call getCohortBookingRate + applyCohortDamping in
--     TS. The bug F1 was specifically about the column drifting to 0
--     because writers forgot to recompute. That is now structurally
--     impossible regardless of the damping question.
--
-- INVARIANT (encoded in this migration + heat-mapping.ts refactor):
--   If you see weddings.heat_score or weddings.temperature_tier as a
--   write target in any new code, the contract is broken. The columns
--   no longer exist. Read from wedding_heat instead.
--
-- Idempotent. No BEGIN/COMMIT (Wave 23 doctrine).
-- ---------------------------------------------------------------------------

-- =====================================================================
-- Step 1. Drop the stored columns.
-- =====================================================================
-- CASCADE because migration 158 may have indexed them indirectly and
-- some PostgREST-cached views may reference them. CASCADE is safe here
-- because the only consumers were the heat-mapping module + a handful
-- of UI selects we're updating in the same change.
ALTER TABLE public.weddings DROP COLUMN IF EXISTS heat_score CASCADE;
ALTER TABLE public.weddings DROP COLUMN IF EXISTS temperature_tier CASCADE;

-- =====================================================================
-- Step 2. Create the derived view.
-- =====================================================================
-- Decay constant: 0.98^days. Sourced from heat-mapping.ts:753 decayRate.
-- An event 30 days old retains 0.98^30 ~= 54.5% of its original points.
--
-- Direction filter: inbound only. Sourced from heat-mapping.ts:740.
-- INV-14 says heat increments only on couple-side actions. The schema
-- CHECK on engagement_events.direction (migration 116) plus this filter
-- is belt-and-braces.
--
-- Score formula:
--   raw_engagement_sum = SUM(points * 0.98^days_since_event)
--   phase_b_contribution = capped at +20 (sourced from heat-mapping.ts:809)
--   raw_score = clamp(raw_engagement_sum + phase_b_contribution, 0, 100)
--   heat_score = COALESCE(heat_score_override_value, raw_score)
--   temperature_tier = tier_of(heat_score)
--
-- Tier thresholds match heat-mapping.ts getTier() at line 119.

CREATE OR REPLACE VIEW public.wedding_heat AS
WITH engagement_sum AS (
  -- Per-wedding sum of decayed inbound engagement points.
  SELECT
    w.id AS wedding_id,
    w.venue_id,
    w.heat_score_override_value,
    w.heat_score_overridden_at,
    COALESCE(
      SUM(
        e.points
        * POWER(
            0.98,
            GREATEST(
              0,
              EXTRACT(EPOCH FROM (now() - COALESCE(e.occurred_at, e.created_at))) / 86400.0
            )
          )
      ),
      0
    ) AS engagement_score
  FROM public.weddings w
  LEFT JOIN public.engagement_events e
    ON e.wedding_id = w.id
    AND e.direction = 'inbound'
  GROUP BY w.id, w.venue_id, w.heat_score_override_value, w.heat_score_overridden_at
),
phase_b_per_wedding AS (
  -- Phase B contribution from resolved candidate identities (Knot,
  -- Wedding Wire, etc. signals captured pre-inquiry). Per-candidate:
  -- funnel_depth * 2, decayed from last_seen via the same 0.98/day.
  -- Plus +5 cross-platform bonus when 2+ platforms resolved here.
  -- Sourced verbatim from heat-mapping.ts:786-797.
  SELECT
    w.id AS wedding_id,
    COALESCE(
      SUM(
        COALESCE(ci.funnel_depth, 0) * 2
        * POWER(
            0.98,
            GREATEST(
              0,
              EXTRACT(EPOCH FROM (now() - COALESCE(ci.last_seen, now()))) / 86400.0
            )
          )
      ),
      0
    ) AS phase_b_base,
    COUNT(DISTINCT ci.source_platform) AS distinct_platforms
  FROM public.weddings w
  LEFT JOIN public.candidate_identities ci
    ON ci.resolved_wedding_id = w.id
    AND ci.deleted_at IS NULL
  GROUP BY w.id
),
phase_b_ai_bonus AS (
  -- AI-tier attribution bonus, capped at +6 (max 2 matches contribute).
  -- Sourced from heat-mapping.ts:798-808. Capped separately so heavy
  -- AI attribution can't dominate the +20 Phase B headroom.
  SELECT
    w.id AS wedding_id,
    LEAST(
      6,
      COUNT(ae.id) FILTER (WHERE ae.reverted_at IS NULL) * 3
    ) AS ai_bonus
  FROM public.weddings w
  LEFT JOIN public.attribution_events ae
    ON ae.wedding_id = w.id
    AND ae.tier IN ('tier_2_ai', 'tier_2_wide_ai')
  GROUP BY w.id
),
computed AS (
  SELECT
    es.wedding_id,
    es.venue_id,
    es.heat_score_override_value,
    es.heat_score_overridden_at,
    es.engagement_score,
    LEAST(
      20,
      pbw.phase_b_base
        + CASE WHEN pbw.distinct_platforms >= 2 THEN 5 ELSE 0 END
        + COALESCE(pba.ai_bonus, 0)
    ) AS phase_b_contribution
  FROM engagement_sum es
  LEFT JOIN phase_b_per_wedding pbw ON pbw.wedding_id = es.wedding_id
  LEFT JOIN phase_b_ai_bonus pba ON pba.wedding_id = es.wedding_id
),
raw AS (
  SELECT
    wedding_id,
    venue_id,
    heat_score_override_value,
    heat_score_overridden_at,
    GREATEST(
      0,
      LEAST(
        100,
        ROUND(engagement_score + phase_b_contribution)
      )
    )::integer AS raw_score
  FROM computed
)
SELECT
  raw.wedding_id,
  raw.venue_id,
  raw.raw_score,
  -- The canonical heat_score: operator override wins, otherwise the
  -- computed raw score. Sourced from heat-mapping.ts:709-721.
  COALESCE(raw.heat_score_override_value, raw.raw_score) AS heat_score,
  -- Tier thresholds match heat-mapping.ts getTier() at line 119-125.
  CASE
    WHEN COALESCE(raw.heat_score_override_value, raw.raw_score) >= 80 THEN 'hot'
    WHEN COALESCE(raw.heat_score_override_value, raw.raw_score) >= 60 THEN 'warm'
    WHEN COALESCE(raw.heat_score_override_value, raw.raw_score) >= 40 THEN 'cool'
    WHEN COALESCE(raw.heat_score_override_value, raw.raw_score) >= 20 THEN 'cold'
    ELSE 'frozen'
  END AS temperature_tier,
  raw.heat_score_overridden_at IS NOT NULL AS is_overridden
FROM raw;

COMMENT ON VIEW public.wedding_heat IS
  'F1 deep-fix (migration 316). Heat scoring as a derived view, not a stored '
  'column. Replaces the dropped weddings.heat_score / temperature_tier columns. '
  'Computes 0.98^days decay sum over inbound engagement_events + Phase B '
  'candidate-identity contribution (capped at +20) + operator override '
  '(heat_score_override_value, migration 312). Cohort damping is intentionally '
  'NOT in this view (too expensive at read time at venue scale); consumers that '
  'need damping (heat-narration insight) still call applyCohortDamping in TS '
  'against this view''s heat_score. INVARIANT: no writer may target '
  'weddings.heat_score or weddings.temperature_tier. The columns no longer '
  'exist. Read from this view. If reads become hot, convert to MATERIALIZED + '
  'refresh trigger on engagement_events.';

-- =====================================================================
-- Step 3. PostgREST schema reload so the new view is queryable from
-- supabase-js immediately.
-- =====================================================================
NOTIFY pgrst, 'reload schema';
