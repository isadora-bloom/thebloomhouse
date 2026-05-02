-- Migration 165: T5-schema-gap weddings.estimated_guests + extend the
-- temporal-recompute triggers from 158 to react to headcount changes too.
--
-- Audit finding (T5 schema-gap sweep): headcount is a top-3 qualification
-- question for venue inquiries — it drives pricing tier, capacity matching,
-- and package selection. Sage's inquiry-brain extraction prompt already
-- pulls a guestCount from the inbound email, but the platform stored it
-- only in the long-standing `guest_count_estimate` column whose semantics
-- are lossy (mixed inquiry-side estimate / coordinator override). This
-- migration adds an explicit lead-side estimate column with the constraint
-- semantics the brain expects, and wires it into the same recompute
-- pipeline migration 158 set up for inquiry_date / wedding_date.
--
-- Why a recompute? Capacity-aware risk-flag narration and pricing-elasticity
-- narration (T3 / Phase C caches) both fold guest count into their classical
-- signature, so a corrected headcount must invalidate the cache the same
-- way a corrected wedding_date does — otherwise the lead detail page shows
-- stale narration after a coordinator fix.
--
-- Idempotent: ADD COLUMN IF NOT EXISTS, CREATE OR REPLACE FUNCTION,
-- DROP TRIGGER IF EXISTS + CREATE TRIGGER. Safe to re-apply.
--
-- NOTE: this migration REPLACES the trigger functions defined in 158 — we
-- don't edit 158 because it's already applied. The replacement is a strict
-- superset (still gates on inquiry_date / wedding_date; ALSO gates on
-- estimated_guests). The trigger definitions are likewise re-issued so the
-- watch list expands to UPDATE OF inquiry_date, wedding_date, estimated_guests.

-- =====================================================================
-- Column
-- =====================================================================

ALTER TABLE public.weddings
  ADD COLUMN IF NOT EXISTS estimated_guests integer NULL
    CHECK (
      estimated_guests IS NULL
      OR (estimated_guests > 0 AND estimated_guests <= 1000)
    );

COMMENT ON COLUMN public.weddings.estimated_guests IS
  'Lead-side headcount estimate captured at qualification (inquiry-brain '
  'extraction). NOT the couple-portal RSVP count — that lives in '
  '`guest_list`. Nullable: many inquiries don''t volunteer a number, and '
  'the platform shouldn''t pretend a guess. Range 1-1000 enforced via '
  'CHECK constraint; values outside that window are almost certainly an '
  'extraction error rather than a real wedding.';

-- =====================================================================
-- Trigger function (BEFORE UPDATE) — sets the recompute flag on NEW.
-- Replaces the 158 definition; adds estimated_guests to the gate.
-- =====================================================================

CREATE OR REPLACE FUNCTION public.weddings_temporal_change_recompute_before()
RETURNS TRIGGER AS $$
BEGIN
  -- Only mark pending when an actual change happened. NULL-safe via
  -- IS DISTINCT FROM so first-time set (NULL -> value) also triggers.
  -- 165: estimated_guests joins the gate — capacity-aware narration
  -- depends on it the same way heat scoring depends on the dates.
  IF (NEW.inquiry_date IS DISTINCT FROM OLD.inquiry_date)
     OR (NEW.wedding_date IS DISTINCT FROM OLD.wedding_date)
     OR (NEW.estimated_guests IS DISTINCT FROM OLD.estimated_guests)
  THEN
    NEW.heat_recompute_pending := true;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

COMMENT ON FUNCTION public.weddings_temporal_change_recompute_before() IS
  'T5-delta.1 (158) + T5-schema-gap (165). BEFORE-UPDATE companion to '
  'weddings_temporal_change_recompute_after. Sets heat_recompute_pending '
  'on NEW so the cron picks the row up. Watches inquiry_date, '
  'wedding_date, estimated_guests. Split into BEFORE/AFTER because '
  'mutating NEW must happen BEFORE; cross-table cache invalidation must '
  'happen AFTER (the parent UPDATE has to commit first, and we need the '
  'final NEW.id).';

-- =====================================================================
-- Trigger function (AFTER UPDATE) — invalidates cross-table caches.
-- Replaces the 158 definition; adds estimated_guests to the gate.
-- =====================================================================

CREATE OR REPLACE FUNCTION public.weddings_temporal_change_recompute_after()
RETURNS TRIGGER AS $$
BEGIN
  -- Same gate as the BEFORE trigger: only invalidate when something
  -- actually changed. 165: estimated_guests joins the gate.
  IF (NEW.inquiry_date IS NOT DISTINCT FROM OLD.inquiry_date)
     AND (NEW.wedding_date IS NOT DISTINCT FROM OLD.wedding_date)
     AND (NEW.estimated_guests IS NOT DISTINCT FROM OLD.estimated_guests)
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
  'T5-delta.1 (158) + T5-schema-gap (165). AFTER-UPDATE on weddings. When '
  'inquiry_date / wedding_date / estimated_guests change, invalidate '
  'downstream caches: T3 insight last_classical_signature, '
  'wedding_journey_narratives.stale_since, tours.tour_brief_stale_since. '
  'Pinned narratives are spared. Heat-score recompute itself is deferred '
  'to the cron via heat_recompute_pending (set by the BEFORE trigger).';

-- =====================================================================
-- Re-wire the triggers so the watch list expands to estimated_guests.
-- =====================================================================

DROP TRIGGER IF EXISTS trg_weddings_temporal_recompute_before ON public.weddings;
CREATE TRIGGER trg_weddings_temporal_recompute_before
  BEFORE UPDATE OF inquiry_date, wedding_date, estimated_guests ON public.weddings
  FOR EACH ROW
  EXECUTE FUNCTION public.weddings_temporal_change_recompute_before();

DROP TRIGGER IF EXISTS trg_weddings_temporal_recompute_after ON public.weddings;
CREATE TRIGGER trg_weddings_temporal_recompute_after
  AFTER UPDATE OF inquiry_date, wedding_date, estimated_guests ON public.weddings
  FOR EACH ROW
  EXECUTE FUNCTION public.weddings_temporal_change_recompute_after();

NOTIFY pgrst, 'reload schema';
