-- Migration 174: T5-followup-CC #97 — extend the 158/165 temporal-recompute
-- triggers to also watch booking_value.
--
-- Audit finding (seasoned MED 17, T5-followup-CC): when a coordinator
-- corrects a wedding's booking_value (e.g. they renegotiated the deposit,
-- or fixed an extraction error in the inquiry-brain pricing pull), the
-- downstream tour-brief / journey-narrative caches stay stale until the
-- daily heat-decay cron runs. The post-tour-brief is the one that hurts:
-- it folds booking_value into "what the couple is committing to", and a
-- $5k miss between brief and reality undermines the coordinator's tour
-- prep.
--
-- Migration 158 wired up trigger functions watching inquiry_date /
-- wedding_date; migration 165 expanded them to also watch
-- estimated_guests. This migration completes the qualification-tier set
-- by adding booking_value. The trigger functions are CREATE OR REPLACEd
-- as a strict superset of 165 (still gates on inquiry_date / wedding_date
-- / estimated_guests; ALSO gates on booking_value). The triggers
-- themselves are re-issued so the watch list expands to UPDATE OF
-- inquiry_date, wedding_date, estimated_guests, booking_value.
--
-- Why a recompute? Pricing-elasticity narration (T3 / Phase C cache),
-- post-tour-brief, and the journey narrative all fold booking_value into
-- their classical signature. A corrected booking_value must invalidate
-- the cache the same way a corrected wedding_date does — otherwise the
-- lead detail page shows stale narration after a coordinator fix.
--
-- Idempotent: CREATE OR REPLACE FUNCTION + DROP TRIGGER IF EXISTS.
-- Safe to re-apply.

-- =====================================================================
-- Trigger function (BEFORE UPDATE) — sets the recompute flag on NEW.
-- Replaces the 165 definition; adds booking_value to the gate.
-- =====================================================================

CREATE OR REPLACE FUNCTION public.weddings_temporal_change_recompute_before()
RETURNS TRIGGER AS $$
BEGIN
  -- Only mark pending when an actual change happened. NULL-safe via
  -- IS DISTINCT FROM so first-time set (NULL -> value) also triggers.
  -- 174: booking_value joins the gate — pricing-aware narration
  -- (post-tour-brief, journey narrative, pricing elasticity) folds
  -- booking_value into the classical signature, so a coordinator
  -- correction must invalidate downstream caches.
  IF (NEW.inquiry_date IS DISTINCT FROM OLD.inquiry_date)
     OR (NEW.wedding_date IS DISTINCT FROM OLD.wedding_date)
     OR (NEW.estimated_guests IS DISTINCT FROM OLD.estimated_guests)
     OR (NEW.booking_value IS DISTINCT FROM OLD.booking_value)
  THEN
    NEW.heat_recompute_pending := true;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

COMMENT ON FUNCTION public.weddings_temporal_change_recompute_before() IS
  'T5-delta.1 (158) + T5-schema-gap (165) + T5-followup-CC (174). BEFORE-UPDATE companion to weddings_temporal_change_recompute_after. Sets heat_recompute_pending on NEW so the cron picks the row up. Watches inquiry_date, wedding_date, estimated_guests, booking_value. Split into BEFORE/AFTER because mutating NEW must happen BEFORE; cross-table cache invalidation must happen AFTER.';

-- =====================================================================
-- Trigger function (AFTER UPDATE) — invalidates cross-table caches.
-- Replaces the 165 definition; adds booking_value to the gate.
-- =====================================================================

CREATE OR REPLACE FUNCTION public.weddings_temporal_change_recompute_after()
RETURNS TRIGGER AS $$
BEGIN
  -- Same gate as the BEFORE trigger: only invalidate when something
  -- actually changed. 174: booking_value joins the gate.
  IF (NEW.inquiry_date IS NOT DISTINCT FROM OLD.inquiry_date)
     AND (NEW.wedding_date IS NOT DISTINCT FROM OLD.wedding_date)
     AND (NEW.estimated_guests IS NOT DISTINCT FROM OLD.estimated_guests)
     AND (NEW.booking_value IS NOT DISTINCT FROM OLD.booking_value)
  THEN
    RETURN NEW;
  END IF;

  -- 1. T3 insight cache: nulling last_classical_signature forces
  --    lookupCachedInsight to re-narrate on next read because the
  --    classical signature comparison will mismatch.
  UPDATE public.intelligence_insights
     SET last_classical_signature = NULL
   WHERE context_id = NEW.id
     AND last_classical_signature IS NOT NULL;

  -- 2. Phase C journey narrative.
  UPDATE public.wedding_journey_narratives
     SET stale_since = now()
   WHERE wedding_id = NEW.id
     AND pinned = false;

  -- 3. Post-tour brief cache (every tour belonging to this wedding
  --    that has a generated brief).
  UPDATE public.tours
     SET tour_brief_stale_since = now()
   WHERE wedding_id = NEW.id
     AND tour_brief_text IS NOT NULL;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

COMMENT ON FUNCTION public.weddings_temporal_change_recompute_after() IS
  'T5-delta.1 (158) + T5-schema-gap (165) + T5-followup-CC (174). AFTER-UPDATE on weddings. When inquiry_date / wedding_date / estimated_guests / booking_value change, invalidate downstream caches: T3 insight last_classical_signature, wedding_journey_narratives.stale_since, tours.tour_brief_stale_since. Pinned narratives are spared. Heat-score recompute itself is deferred to the cron via heat_recompute_pending (set by the BEFORE trigger).';

-- =====================================================================
-- Re-wire the triggers so the watch list expands to booking_value.
-- =====================================================================

DROP TRIGGER IF EXISTS trg_weddings_temporal_recompute_before ON public.weddings;
CREATE TRIGGER trg_weddings_temporal_recompute_before
  BEFORE UPDATE OF inquiry_date, wedding_date, estimated_guests, booking_value ON public.weddings
  FOR EACH ROW
  EXECUTE FUNCTION public.weddings_temporal_change_recompute_before();

DROP TRIGGER IF EXISTS trg_weddings_temporal_recompute_after ON public.weddings;
CREATE TRIGGER trg_weddings_temporal_recompute_after
  AFTER UPDATE OF inquiry_date, wedding_date, estimated_guests, booking_value ON public.weddings
  FOR EACH ROW
  EXECUTE FUNCTION public.weddings_temporal_change_recompute_after();

NOTIFY pgrst, 'reload schema';
