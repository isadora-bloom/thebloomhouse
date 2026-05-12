-- ---------------------------------------------------------------------------
-- 319_cohort_damping_cache.sql
-- ---------------------------------------------------------------------------
-- Reconciles the numerical disagreement between the lead-detail "Cool"
-- badge (computed in the view, mig 316) and the heat-narration prose
-- (computed in TS via getCohortBookingRate + applyCohortDamping). The
-- two paths were producing different damped scores for the same lead
-- because cohort damping was intentionally omitted from the view at
-- 316-ship for read-cost reasons (per-row similarity join was too
-- expensive).
--
-- This migration:
--   1. Adds public.cohort_damping_cache — one row per (venue, cohort
--      signature) with precomputed multiplier + cap_tier values.
--   2. Rebuilds public.wedding_heat (the mig-316 view) to LEFT JOIN
--      the cache by cohort signature and apply the multiplier inside
--      the same expression chain that emits heat_score + temperature_tier.
--   3. Exposes cohort_booking_rate + cohort_size on the view so the
--      narration layer can read them directly instead of re-deriving.
--
-- Population strategy: a daily cron (src/lib/services/intel/
-- cohort-damping-refresh.ts → registered as cohort_damping_refresh in
-- the cron dispatcher) iterates active venues, enumerates the discrete
-- cohort signatures present in the venue's weddings, runs the
-- TS-side getCohortBookingRate logic against each bucket, and UPSERTs
-- the resulting (rate, multiplier, cap_tier) into the cache. The view
-- LEFT JOINs the cache so MISSING rows degrade gracefully to
-- multiplier=1.0 (no damping). Fresh weddings whose signature has
-- never been seen pre-cache simply skip damping until the next cron
-- tick — correct, conservative behavior.
--
-- Cohort signature formula (must match the TS computeCohortSignature
-- exported from src/lib/services/insights/cohort-signature.ts):
--   'src=' || COALESCE(source, 'unknown')
--   || ';gc=' || COALESCE(((guest_count_estimate / 50) * 50)::text, 'unknown')
--   || ';season=' || season(wedding_date)
-- where season() maps months 3-5 → spring, 6-8 → summer, 9-11 → fall,
-- 12/1/2 → winter, NULL → 'unknown'.
--
-- Drift note: this discrete-bucket signature is intentionally coarser
-- than the legacy TS top-K similarity in heat-mapping.ts:174
-- (getCohortBookingRate), which uses z-score continuous similarity per
-- wedding pair. The cache groups weddings into broad buckets;
-- per-wedding similarity becomes a fallback (still used for the
-- narration's cohort descriptor when n_total > 0 but the cache row is
-- missing). Going forward the cache is canonical. Acceptable because:
--   - The buckets capture the same three dimensions the TS scorer
--     already weighted highest (source/guest-count/season).
--   - Discretization makes the multiplier consistent across all
--     weddings in the same bucket — exactly what the view needs.
--   - The damping decision was always coarse anyway (3 multiplier
--     levels: 1.0 / 0.7 / 0.5); finer-grained similarity inputs
--     collapsed to the same output multiplier.
--
-- Idempotent. No BEGIN/COMMIT (Wave 23 doctrine).
-- ---------------------------------------------------------------------------

-- =====================================================================
-- Step 1. Cache table.
-- =====================================================================
CREATE TABLE IF NOT EXISTS public.cohort_damping_cache (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  venue_id uuid NOT NULL REFERENCES public.venues(id) ON DELETE CASCADE,
  cohort_signature text NOT NULL,
  cohort_size integer NOT NULL,
  cohort_booked integer NOT NULL,
  booking_rate numeric NOT NULL,
  multiplier numeric NOT NULL,
  cap_tier text,
  computed_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (venue_id, cohort_signature)
);

CREATE INDEX IF NOT EXISTS idx_cohort_damping_cache_venue
  ON public.cohort_damping_cache (venue_id);

COMMENT ON TABLE public.cohort_damping_cache IS
  'Precomputed cohort-booking-rate-to-heat-multiplier per (venue, cohort signature). '
  'Refreshed daily by cohort_damping_refresh cron. Read by the wedding_heat view '
  '(mig 316/319) so every consumer sees the same damped score. Replaces the per-read '
  'aggregate in heat-mapping.ts:174 that was too expensive to put inline in SQL. '
  'Falls back to multiplier=1.0 when no cache row exists (the JOIN is LEFT JOIN in '
  'the view).';

COMMENT ON COLUMN public.cohort_damping_cache.venue_id IS
  'Owning venue. Scoping key for cache lookup from wedding_heat view.';
COMMENT ON COLUMN public.cohort_damping_cache.cohort_signature IS
  'Discrete cohort bucket key, e.g. ''src=knot;gc=100;season=summer''. Must match the '
  'computeCohortSignature() TS helper exported from src/lib/services/insights/'
  'cohort-signature.ts. Drift between SQL and TS = silent cache misses.';
COMMENT ON COLUMN public.cohort_damping_cache.cohort_size IS
  'Number of comparable weddings (booked + completed + lost) in the last 3y that share '
  'this signature. Min 5 to be informative (see MIN_COHORT_SIZE in heat-mapping.ts).';
COMMENT ON COLUMN public.cohort_damping_cache.cohort_booked IS
  'Count of cohort_size weddings whose status is booked or completed.';
COMMENT ON COLUMN public.cohort_damping_cache.booking_rate IS
  'cohort_booked / cohort_size, 0..1. Surfaced to narration as ''comparable leads are '
  'converting at X%''.';
COMMENT ON COLUMN public.cohort_damping_cache.multiplier IS
  'Damping multiplier applied to raw heat_score in the view. Mirrors '
  'applyCohortDamping() in heat-mapping.ts: <10% rate → 0.5x, <20% rate → 0.7x, '
  '>=20% rate → 1.0x. Range constrained 0..1 by cohort_damping_cache_multiplier_range.';
COMMENT ON COLUMN public.cohort_damping_cache.cap_tier IS
  'Optional tier cap applied when the cohort signal is extreme (booking_rate < 10%). '
  '''warm'' clamps a damped Hot to Warm so the badge never says ''Hot'' when 9 of 10 '
  'comparable leads went elsewhere. NULL when no cap should be enforced.';
COMMENT ON COLUMN public.cohort_damping_cache.computed_at IS
  'Last cron refresh timestamp. Stale rows (older than ~48h) signal a cron outage.';

-- Constraints (drop + recreate so re-running this migration after a
-- schema tweak is safe — Wave 23 idempotency).
ALTER TABLE public.cohort_damping_cache
  DROP CONSTRAINT IF EXISTS cohort_damping_cache_multiplier_range;
ALTER TABLE public.cohort_damping_cache
  ADD CONSTRAINT cohort_damping_cache_multiplier_range
  CHECK (multiplier >= 0 AND multiplier <= 1);

ALTER TABLE public.cohort_damping_cache
  DROP CONSTRAINT IF EXISTS cohort_damping_cache_booking_rate_range;
ALTER TABLE public.cohort_damping_cache
  ADD CONSTRAINT cohort_damping_cache_booking_rate_range
  CHECK (booking_rate >= 0 AND booking_rate <= 1);

ALTER TABLE public.cohort_damping_cache
  DROP CONSTRAINT IF EXISTS cohort_damping_cache_cap_tier_values;
ALTER TABLE public.cohort_damping_cache
  ADD CONSTRAINT cohort_damping_cache_cap_tier_values
  CHECK (cap_tier IS NULL OR cap_tier IN ('hot', 'warm', 'cool', 'cold', 'frozen'));

-- =====================================================================
-- Step 2. Rebuild wedding_heat view to JOIN the cache.
-- =====================================================================
-- The CTEs below are preserved verbatim from migration 316 (engagement_sum,
-- phase_b_per_wedding, phase_b_ai_bonus, computed, raw). Only the final
-- SELECT changes: it now LEFT JOINs cohort_damping_cache on
-- (venue_id, cohort_signature) and applies multiplier + cap_tier in the
-- heat_score / temperature_tier expressions.

DROP VIEW IF EXISTS public.wedding_heat;

CREATE OR REPLACE VIEW public.wedding_heat AS
WITH engagement_sum AS (
  SELECT
    w.id AS wedding_id,
    w.venue_id,
    w.heat_score_override_value,
    w.heat_score_overridden_at,
    -- Cohort signature emitted as a SQL expression so a fresh wedding
    -- inserted between cron ticks immediately picks up its bucket's
    -- multiplier as soon as the cache row lands. Must stay in lockstep
    -- with computeCohortSignature() in TS.
    'src=' || COALESCE(w.source, 'unknown')
      || ';gc=' || COALESCE(((w.guest_count_estimate / 50) * 50)::text, 'unknown')
      || ';season=' || CASE
          WHEN w.wedding_date IS NULL THEN 'unknown'
          WHEN EXTRACT(MONTH FROM w.wedding_date) BETWEEN 3 AND 5 THEN 'spring'
          WHEN EXTRACT(MONTH FROM w.wedding_date) BETWEEN 6 AND 8 THEN 'summer'
          WHEN EXTRACT(MONTH FROM w.wedding_date) BETWEEN 9 AND 11 THEN 'fall'
          ELSE 'winter'
        END
      AS cohort_signature,
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
  GROUP BY
    w.id, w.venue_id, w.heat_score_override_value, w.heat_score_overridden_at,
    w.source, w.guest_count_estimate, w.wedding_date
),
phase_b_per_wedding AS (
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
    es.cohort_signature,
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
    cohort_signature,
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
  raw.cohort_signature,
  -- The canonical heat_score. Operator override wins. Otherwise apply the
  -- cohort damping multiplier (mig 319) to the raw computed score. The
  -- multiplier defaults to 1.0 when no cache row exists, so the legacy
  -- behavior pre-319 (no damping at view level) is preserved for any
  -- venue/signature pair that hasn't been refreshed yet.
  COALESCE(
    raw.heat_score_override_value,
    GREATEST(
      0,
      LEAST(
        100,
        ROUND(raw.raw_score * COALESCE(cache.multiplier, 1.0))::integer
      )
    )
  ) AS heat_score,
  -- Tier: the cohort cap_tier takes priority over the natural tier when
  -- present (cohort signal is extreme — booking_rate < 10%). Otherwise
  -- compute the tier from the (damped) numeric.
  COALESCE(
    cache.cap_tier,
    CASE
      WHEN COALESCE(
        raw.heat_score_override_value,
        ROUND(raw.raw_score * COALESCE(cache.multiplier, 1.0))::integer
      ) >= 80 THEN 'hot'
      WHEN COALESCE(
        raw.heat_score_override_value,
        ROUND(raw.raw_score * COALESCE(cache.multiplier, 1.0))::integer
      ) >= 60 THEN 'warm'
      WHEN COALESCE(
        raw.heat_score_override_value,
        ROUND(raw.raw_score * COALESCE(cache.multiplier, 1.0))::integer
      ) >= 40 THEN 'cool'
      WHEN COALESCE(
        raw.heat_score_override_value,
        ROUND(raw.raw_score * COALESCE(cache.multiplier, 1.0))::integer
      ) >= 20 THEN 'cold'
      ELSE 'frozen'
    END
  ) AS temperature_tier,
  raw.heat_score_overridden_at IS NOT NULL AS is_overridden,
  cache.booking_rate AS cohort_booking_rate,
  cache.cohort_size AS cohort_size,
  cache.cohort_booked AS cohort_booked,
  COALESCE(cache.multiplier, 1.0) AS cohort_multiplier
FROM raw
LEFT JOIN public.cohort_damping_cache cache
  ON cache.venue_id = raw.venue_id
  AND cache.cohort_signature = raw.cohort_signature;

COMMENT ON VIEW public.wedding_heat IS
  'F1 deep-fix (migration 316) + cohort damping reconciliation (migration 319). '
  'Heat scoring as a derived view, not a stored column. Computes 0.98^days decay sum '
  'over inbound engagement_events + Phase B candidate-identity contribution (capped at '
  '+20) + operator override + cohort damping multiplier from cohort_damping_cache. '
  'Cohort damping is now in-view (mig 319): a precomputed multiplier per discrete '
  '(venue, cohort signature) bucket is JOINed at read time. The signature formula is '
  '''src=<source>;gc=<bin50>;season=<spring|summer|fall|winter>'' and must match '
  'computeCohortSignature() in src/lib/services/insights/cohort-signature.ts. Cohort '
  'cache is refreshed daily by cohort_damping_refresh cron. Missing cache rows degrade '
  'to multiplier=1.0 (no damping). INVARIANT: no writer may target weddings.heat_score '
  'or weddings.temperature_tier. Read from this view.';

-- =====================================================================
-- Step 3. PostgREST schema reload.
-- =====================================================================
NOTIFY pgrst, 'reload schema';
