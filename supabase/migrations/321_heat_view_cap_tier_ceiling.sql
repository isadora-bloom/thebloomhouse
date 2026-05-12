-- ---------------------------------------------------------------------------
-- 321_heat_view_cap_tier_ceiling.sql
-- ---------------------------------------------------------------------------
-- Bugfix for mig 319 (cohort damping in wedding_heat view).
--
-- Symptom: leads with heat_score=0 displayed as "Warm" instead of "Frozen".
-- Concrete case: RM-0480 (Crystal Fuller, marked lost) — score=0 yet badge=Warm.
--
-- Cause: the view used COALESCE(cache.cap_tier, natural_tier). cap_tier is
-- stamped 'warm' by cohort_damping_refresh whenever booking_rate < 10%,
-- regardless of the lead's actual score. So any wedding in a low-booking-
-- rate cohort got tier='warm' even when its damped score said 'frozen'.
--
-- Correct semantics (matches applyCohortDamping in heat-mapping.ts:309):
--   cap_tier is a CEILING, not an override. It clamps the displayed tier
--   DOWN when the natural tier would be 'hot' (i.e., "don't show Hot when
--   9 of 10 comparable leads went elsewhere"). It must NEVER push the
--   tier UP from frozen/cold/cool to warm.
--
-- Fix: drop + recreate wedding_heat with tier rank comparison. The natural
-- tier wins unless it ranks STRICTLY HIGHER than the cap, in which case
-- the cap wins.
--
-- Idempotent: DROP VIEW IF EXISTS + CREATE OR REPLACE. No BEGIN/COMMIT.
-- ---------------------------------------------------------------------------

DROP VIEW IF EXISTS public.wedding_heat;

CREATE OR REPLACE VIEW public.wedding_heat AS
WITH engagement_sum AS (
  SELECT
    w.id AS wedding_id,
    w.venue_id,
    w.heat_score_override_value,
    w.heat_score_overridden_at,
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
),
final AS (
  SELECT
    raw.wedding_id,
    raw.venue_id,
    raw.raw_score,
    raw.cohort_signature,
    raw.heat_score_override_value,
    raw.heat_score_overridden_at,
    cache.cap_tier,
    cache.booking_rate AS cohort_booking_rate,
    cache.cohort_size,
    cache.cohort_booked,
    COALESCE(cache.multiplier, 1.0) AS cohort_multiplier,
    -- The canonical heat_score. Operator override wins, otherwise the
    -- damped raw score.
    COALESCE(
      raw.heat_score_override_value,
      GREATEST(
        0,
        LEAST(
          100,
          ROUND(raw.raw_score * COALESCE(cache.multiplier, 1.0))::integer
        )
      )
    ) AS heat_score
  FROM raw
  LEFT JOIN public.cohort_damping_cache cache
    ON cache.venue_id = raw.venue_id
    AND cache.cohort_signature = raw.cohort_signature
)
SELECT
  wedding_id,
  venue_id,
  raw_score,
  cohort_signature,
  heat_score,
  -- Compute the natural tier from the (potentially damped) heat_score.
  -- Then apply cap_tier as a CEILING only — never an override. The cap
  -- only kicks in when the natural tier would rank strictly higher.
  -- Tier ranks: frozen=0, cold=1, cool=2, warm=3, hot=4.
  CASE
    WHEN cap_tier IS NULL THEN
      CASE
        WHEN heat_score >= 80 THEN 'hot'
        WHEN heat_score >= 60 THEN 'warm'
        WHEN heat_score >= 40 THEN 'cool'
        WHEN heat_score >= 20 THEN 'cold'
        ELSE 'frozen'
      END
    ELSE
      -- Natural tier
      CASE
        WHEN
          (CASE
            WHEN heat_score >= 80 THEN 4
            WHEN heat_score >= 60 THEN 3
            WHEN heat_score >= 40 THEN 2
            WHEN heat_score >= 20 THEN 1
            ELSE 0
          END)
          >
          (CASE cap_tier
            WHEN 'hot' THEN 4
            WHEN 'warm' THEN 3
            WHEN 'cool' THEN 2
            WHEN 'cold' THEN 1
            ELSE 0
          END)
        THEN cap_tier
        ELSE
          CASE
            WHEN heat_score >= 80 THEN 'hot'
            WHEN heat_score >= 60 THEN 'warm'
            WHEN heat_score >= 40 THEN 'cool'
            WHEN heat_score >= 20 THEN 'cold'
            ELSE 'frozen'
          END
      END
  END AS temperature_tier,
  heat_score_overridden_at IS NOT NULL AS is_overridden,
  cohort_booking_rate,
  cohort_size,
  cohort_booked,
  cohort_multiplier
FROM final;

COMMENT ON VIEW public.wedding_heat IS
  'Heat scoring as a derived view. Fix in mig 321: cap_tier now applied as '
  'a CEILING (down-cap when natural tier would rank higher), not as a hard '
  'override. Cohort damping multiplier from cohort_damping_cache (mig 319) '
  'still multiplies the raw score. Operator override (mig 312) short-circuits '
  'numeric. INVARIANT: no writer may target weddings.heat_score or '
  'weddings.temperature_tier.';

NOTIFY pgrst, 'reload schema';
