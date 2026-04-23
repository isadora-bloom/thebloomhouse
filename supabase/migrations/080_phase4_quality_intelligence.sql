-- ---------------------------------------------------------------------------
-- 080_phase4_quality_intelligence.sql
-- ---------------------------------------------------------------------------
-- Phase 4: Client quality intelligence.
--
-- Task 38 gap: venue_health ships with 5 score columns (overall_score,
-- data_quality_score, pipeline_score, response_time_score, booking_rate_score)
-- but the Phase 4 spec requires 7 subscores. venue-health-compute.ts currently
-- maps 7 computed scores down to 5 columns (data_quality_score double-duties as
-- inquiry_volume_trend, pipeline_score as booking_rate; tour_conversion_rate,
-- avg_revenue, review_score_trend, availability_fill_rate are discarded).
-- Widening the schema is less invasive than renaming existing columns.
--
-- Task 38 gap: venue_health_history did not exist. Compute service's try/catch
-- silently swallowed the error, so the /intel/health 12-week trend line never
-- got data. Creating it now.
--
-- Task 44 gap: manual tour outcomes (set via /intel/tours) never flowed into
-- consultant_metrics because the tour UI only fires `tour_booked` on INSERT
-- (scheduling). The `tour_booked` + `booking_closed` signals that should fire
-- when outcome transitions to 'completed'/'booked' were unreachable for
-- non-Calendly venues. Adding a Postgres trigger that handles the transition
-- in-db means coordinators don't need to remember to call any endpoint.
-- ---------------------------------------------------------------------------

-- ============================================================================
-- STEP 1 — Extend venue_health with the 5 missing Phase 4 subscore columns.
-- ============================================================================

ALTER TABLE public.venue_health
  ADD COLUMN IF NOT EXISTS inquiry_volume_trend decimal,
  ADD COLUMN IF NOT EXISTS tour_conversion_rate decimal,
  ADD COLUMN IF NOT EXISTS avg_revenue_score decimal,
  ADD COLUMN IF NOT EXISTS review_score_trend decimal,
  ADD COLUMN IF NOT EXISTS availability_fill_rate decimal;

COMMENT ON COLUMN public.venue_health.inquiry_volume_trend IS
  'Phase 4 Task 38. 0-100 rolling 30d vs prior 30d inquiry volume score.';
COMMENT ON COLUMN public.venue_health.tour_conversion_rate IS
  'Phase 4 Task 38. 0-100 score derived from tours.outcome=booked / all conducted tours, 90d window.';
COMMENT ON COLUMN public.venue_health.avg_revenue_score IS
  'Phase 4 Task 38. 0-100 score. Normalised against venue own history over time; rough industry median used as seed until 3+ snapshots exist.';
COMMENT ON COLUMN public.venue_health.review_score_trend IS
  'Phase 4 Task 38. 0-100 score from reviews.rating rolling 90d mean.';
COMMENT ON COLUMN public.venue_health.availability_fill_rate IS
  'Phase 4 Task 38. 0-100 score from venue_availability.booked_count / max_events summed over next 12 months. Caps at 40% fill = 100 (higher is operational strength, not a concern at this level).';

-- ============================================================================
-- STEP 2 — Create venue_health_history for the /intel/health trend line.
-- ============================================================================

CREATE TABLE IF NOT EXISTS public.venue_health_history (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  venue_id uuid NOT NULL REFERENCES public.venues(id) ON DELETE CASCADE,
  calculated_at timestamptz NOT NULL DEFAULT now(),
  overall_score decimal,
  inquiry_volume_trend decimal,
  response_time_trend decimal,
  tour_conversion_rate decimal,
  booking_rate decimal,
  avg_revenue_score decimal,
  review_score_trend decimal,
  availability_fill_rate decimal,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_venue_health_history_venue_calculated
  ON public.venue_health_history (venue_id, calculated_at DESC);

COMMENT ON TABLE public.venue_health_history IS
  'owner:agent. One row per health snapshot per venue. /intel/health reads this to render the trend line; /intel/benchmark reads latest per venue for the multi-venue view.';

-- Enable RLS. Compute service uses service_role and bypasses this. Authenticated
-- reads match the canonical pattern from migration 056 (venue_id must match the
-- reader's user_profiles.venue_id, OR org_id-wide via venues, plus super_admin).
-- Demo anon reads match migration 064 (venues.is_demo = true).
ALTER TABLE public.venue_health_history ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "venue_health_history_select" ON public.venue_health_history;
CREATE POLICY "venue_health_history_select" ON public.venue_health_history
  FOR SELECT TO authenticated
  USING (
    venue_id IN (
      SELECT up.venue_id FROM public.user_profiles up WHERE up.id = auth.uid()
      UNION
      SELECT v.id FROM public.venues v
        JOIN public.user_profiles up ON up.org_id = v.org_id
       WHERE up.id = auth.uid()
    )
    OR public.is_super_admin()
  );

DROP POLICY IF EXISTS "demo_anon_select" ON public.venue_health_history;
CREATE POLICY "demo_anon_select" ON public.venue_health_history
  FOR SELECT TO anon
  USING (venue_id IN (SELECT id FROM public.venues WHERE is_demo = true));

-- ============================================================================
-- STEP 3 — Tours outcome transition -> consultant_metrics (Task 44).
-- ============================================================================
--
-- When a tour moves from 'pending' to a terminal outcome, we upsert
-- consultant_metrics for the period the tour landed in. This is the manual
-- equivalent of the Calendly webhook call to trackCoordinatorAction.
--
-- The function is idempotent per (venue_id, consultant_id, period) — running
-- it twice on the same transition doesn't double-count because we use the
-- same month-aligned period and compute the tour count from the tours table
-- rather than incrementing.

CREATE OR REPLACE FUNCTION public.sync_consultant_metrics_from_tour()
RETURNS TRIGGER AS $$
DECLARE
  v_period_start date;
  v_period_end date;
  v_tours_booked integer;
  v_bookings_closed integer;
  v_avg_booking_value decimal;
BEGIN
  -- Only fire when outcome TRANSITIONS to a terminal state from something else.
  -- Updates that don't touch outcome, or keep it in the same terminal state,
  -- are no-ops. This prevents double-counting when a coordinator edits notes
  -- on an already-completed tour.
  IF TG_OP = 'UPDATE' THEN
    IF NEW.outcome IS NOT DISTINCT FROM OLD.outcome THEN
      RETURN NEW;
    END IF;
  END IF;

  IF NEW.outcome NOT IN ('completed', 'booked', 'lost') THEN
    RETURN NEW;
  END IF;

  IF NEW.conducted_by IS NULL OR NEW.venue_id IS NULL THEN
    RETURN NEW;
  END IF;

  -- Month-aligned period: first day of tour month through last day of tour month.
  v_period_start := date_trunc('month', COALESCE(NEW.scheduled_at, now()))::date;
  v_period_end := (v_period_start + interval '1 month - 1 day')::date;

  -- Recount from the tours table rather than incrementing, so idempotent.
  SELECT COUNT(*)::int INTO v_tours_booked
    FROM public.tours
   WHERE venue_id = NEW.venue_id
     AND conducted_by = NEW.conducted_by
     AND outcome IN ('completed', 'booked')
     AND scheduled_at >= v_period_start::timestamptz
     AND scheduled_at <  (v_period_end + 1)::timestamptz;

  SELECT COUNT(*)::int INTO v_bookings_closed
    FROM public.tours
   WHERE venue_id = NEW.venue_id
     AND conducted_by = NEW.conducted_by
     AND outcome = 'booked'
     AND scheduled_at >= v_period_start::timestamptz
     AND scheduled_at <  (v_period_end + 1)::timestamptz;

  -- Average booking value for weddings attached to booked tours by this
  -- consultant in the period. Null if no bookings yet.
  SELECT AVG(w.booking_value) INTO v_avg_booking_value
    FROM public.tours t
    JOIN public.weddings w ON w.id = t.wedding_id
   WHERE t.venue_id = NEW.venue_id
     AND t.conducted_by = NEW.conducted_by
     AND t.outcome = 'booked'
     AND t.scheduled_at >= v_period_start::timestamptz
     AND t.scheduled_at <  (v_period_end + 1)::timestamptz
     AND w.booking_value IS NOT NULL;

  INSERT INTO public.consultant_metrics (
    venue_id, consultant_id, period_start, period_end,
    tours_booked, bookings_closed, avg_booking_value, calculated_at
  ) VALUES (
    NEW.venue_id, NEW.conducted_by, v_period_start, v_period_end,
    v_tours_booked, v_bookings_closed, v_avg_booking_value, now()
  )
  ON CONFLICT (venue_id, consultant_id, period_start) DO UPDATE
    SET tours_booked = EXCLUDED.tours_booked,
        bookings_closed = EXCLUDED.bookings_closed,
        avg_booking_value = COALESCE(EXCLUDED.avg_booking_value, public.consultant_metrics.avg_booking_value),
        calculated_at = now();

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

COMMENT ON FUNCTION public.sync_consultant_metrics_from_tour() IS
  'Phase 4 Task 44. Upserts consultant_metrics when a tour outcome transitions to completed/booked/lost. Counts from tours rather than incrementing, so it is idempotent. No-ops when tour has no conducted_by (Calendly path still works via trackCoordinatorAction webhook).';

-- consultant_metrics may or may not have the (venue_id, consultant_id, period_start)
-- unique constraint on older schemas. Add it if missing so the ON CONFLICT above
-- is deterministic.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_indexes
     WHERE schemaname = 'public'
       AND tablename = 'consultant_metrics'
       AND indexname = 'consultant_metrics_venue_consultant_period_key'
  ) THEN
    BEGIN
      ALTER TABLE public.consultant_metrics
        ADD CONSTRAINT consultant_metrics_venue_consultant_period_key
        UNIQUE (venue_id, consultant_id, period_start);
    EXCEPTION WHEN duplicate_object THEN
      NULL;
    END;
  END IF;
END $$;

DROP TRIGGER IF EXISTS trg_tours_sync_consultant_metrics ON public.tours;
CREATE TRIGGER trg_tours_sync_consultant_metrics
  AFTER INSERT OR UPDATE OF outcome ON public.tours
  FOR EACH ROW
  EXECUTE FUNCTION public.sync_consultant_metrics_from_tour();

-- ============================================================================
-- STEP 4 — Intelligence insights: extend for Phase 4 quality signals.
-- ============================================================================
-- Migration 041 defined intelligence_insights with a fixed CHECK list of 8
-- insight_type values (correlation, anomaly, prediction, recommendation,
-- benchmark, trend, risk, opportunity) and no context pointer. Phase 4 needs
-- to persist per-wedding dropoff warnings. Rather than shoehorning into one
-- of the 8 existing types and losing the wedding linkage, we add:
--   * `context_id uuid` — optional pointer to the entity the insight is about
--     (wedding_id for dropoff; later: source_id, tour_id, etc). Nullable to
--     preserve existing rows.
--   * Widen insight_type CHECK to include the Phase 4 specific types so the
--     persister can write meaningful labels instead of bucketing everything
--     as 'risk'.
--
-- Backwards compatibility: all 8 original insight_type values remain valid.
-- All existing rows keep their NULL context_id and continue to work.

ALTER TABLE public.intelligence_insights
  ADD COLUMN IF NOT EXISTS context_id uuid;

COMMENT ON COLUMN public.intelligence_insights.context_id IS
  'Phase 4. Optional pointer to the entity this insight is about (e.g. wedding_id for a two_email_dropoff). Used with (venue_id, insight_type, context_id) for idempotent upsert of per-entity insights.';

-- Widen insight_type CHECK to include Phase 4 subtypes. Because Postgres
-- stores CHECK definitions inline, we have to DROP and re-create.
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
    'source_quality'
  ));

CREATE INDEX IF NOT EXISTS idx_intelligence_insights_venue_type_context
  ON public.intelligence_insights (venue_id, insight_type, context_id);

NOTIFY pgrst, 'reload schema';
