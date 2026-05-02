-- Migration 158: T5-delta.1 temporal-derived recompute triggers (INV-2.5).
--
-- Audit finding (2026-05-T4 CRITICAL 5): when a coordinator corrects
-- inquiry_date / wedding_date / guest_count on a wedding, downstream
-- derived state stays stale until the daily heat-decay cron runs:
--   * weddings.heat_score / temperature_tier
--   * intelligence_insights.last_classical_signature (T3 cache)
--   * wedding_journey_narratives.narrative_text (Phase C cache)
--   * tours.tour_brief_text (post-tour brief cache)
--
-- This migration installs an UPDATE-OF trigger on weddings that:
--   1. Marks the row for heat recompute (heat_recompute_pending bool flag).
--      The actual recompute happens in /api/cron/recompute-pending-temporal
--      every 5 minutes (delta.2). We don't recompute inline because heat
--      scoring touches multi-table reads and would block the UPDATE.
--   2. Nulls out intelligence_insights.last_classical_signature for any
--      insight whose context_id = weddings.id, forcing the cache to
--      regenerate on next read (lookupCachedInsight compares signatures).
--   3. Stamps wedding_journey_narratives.stale_since for the wedding so
--      the lazy-regen path picks it up.
--   4. Stamps tours.tour_brief_stale_since for every tour belonging to
--      this wedding so the post-tour brief shows fresh on next view.
--
-- Idempotent: CREATE OR REPLACE FUNCTION + DROP TRIGGER IF EXISTS, plus
-- ADD COLUMN IF NOT EXISTS for the three new columns.

-- =====================================================================
-- Columns
-- =====================================================================

-- weddings.heat_recompute_pending: boolean flag the cron drains.
ALTER TABLE public.weddings
  ADD COLUMN IF NOT EXISTS heat_recompute_pending boolean NOT NULL DEFAULT false;

COMMENT ON COLUMN public.weddings.heat_recompute_pending IS
  'T5-delta.1 (2026-05-02). Set TRUE by the temporal-change trigger when '
  'inquiry_date / wedding_date / guest_count is updated. Drained by the '
  '/api/cron/recompute-pending-temporal sweep every 5 minutes — the cron '
  'calls recalculateHeatScore() and clears the flag. Inline recompute '
  'would block the UPDATE, so we defer.';

CREATE INDEX IF NOT EXISTS idx_weddings_heat_recompute_pending
  ON public.weddings (id)
  WHERE heat_recompute_pending = true;

-- wedding_journey_narratives.stale_since: timestamptz, NULL when fresh.
ALTER TABLE public.wedding_journey_narratives
  ADD COLUMN IF NOT EXISTS stale_since timestamptz;

COMMENT ON COLUMN public.wedding_journey_narratives.stale_since IS
  'T5-delta.1 (2026-05-02). Stamped now() when the wedding''s temporal '
  'inputs (inquiry_date / wedding_date / guest_count) change. Lazy '
  'regeneration path checks this alongside signal_count + attribution_count '
  'drift; non-NULL means re-narrate on next view. Cleared on regeneration.';

-- tours.tour_brief_stale_since: timestamptz, NULL when fresh.
ALTER TABLE public.tours
  ADD COLUMN IF NOT EXISTS tour_brief_stale_since timestamptz;

COMMENT ON COLUMN public.tours.tour_brief_stale_since IS
  'T5-delta.1 (2026-05-02). Stamped now() when the parent wedding''s '
  'inquiry_date / wedding_date / guest_count changes. Lazy regen path '
  'on /api/agent/post-tour-brief checks this; non-NULL forces a fresh '
  'brief on next view. Cleared on regeneration.';

-- =====================================================================
-- Trigger function (BEFORE UPDATE) — sets the recompute flag on NEW.
-- =====================================================================

CREATE OR REPLACE FUNCTION public.weddings_temporal_change_recompute_before()
RETURNS TRIGGER AS $$
BEGIN
  -- Only mark pending when an actual change happened. NULL-safe via
  -- IS DISTINCT FROM so first-time set (NULL -> value) also triggers.
  IF (NEW.inquiry_date IS DISTINCT FROM OLD.inquiry_date)
     OR (NEW.wedding_date IS DISTINCT FROM OLD.wedding_date)
     OR (NEW.guest_count IS DISTINCT FROM OLD.guest_count) THEN
    NEW.heat_recompute_pending := true;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

COMMENT ON FUNCTION public.weddings_temporal_change_recompute_before() IS
  'T5-delta.1 (2026-05-02). BEFORE-UPDATE companion to '
  'weddings_temporal_change_recompute_after. Sets heat_recompute_pending '
  'on NEW so the cron picks the row up. Split into BEFORE/AFTER because '
  'mutating NEW must happen BEFORE; cross-table cache invalidation must '
  'happen AFTER (the parent UPDATE has to commit first, and we need the '
  'final NEW.id).';

-- =====================================================================
-- Trigger function (AFTER UPDATE) — invalidates cross-table caches.
-- =====================================================================

CREATE OR REPLACE FUNCTION public.weddings_temporal_change_recompute_after()
RETURNS TRIGGER AS $$
BEGIN
  -- Same gate as the BEFORE trigger: only invalidate when something
  -- actually changed.
  IF (NEW.inquiry_date IS NOT DISTINCT FROM OLD.inquiry_date)
     AND (NEW.wedding_date IS NOT DISTINCT FROM OLD.wedding_date)
     AND (NEW.guest_count IS NOT DISTINCT FROM OLD.guest_count) THEN
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
  'T5-delta.1 (2026-05-02). AFTER-UPDATE on weddings. When inquiry_date / '
  'wedding_date / guest_count change, invalidate downstream caches: T3 '
  'insight last_classical_signature, wedding_journey_narratives.stale_since, '
  'tours.tour_brief_stale_since. Pinned narratives are spared. Heat-score '
  'recompute itself is deferred to the cron via heat_recompute_pending '
  '(set by the BEFORE trigger).';

-- =====================================================================
-- Wire up the triggers.
-- =====================================================================

DROP TRIGGER IF EXISTS trg_weddings_temporal_recompute_before ON public.weddings;
CREATE TRIGGER trg_weddings_temporal_recompute_before
  BEFORE UPDATE OF inquiry_date, wedding_date, guest_count ON public.weddings
  FOR EACH ROW
  EXECUTE FUNCTION public.weddings_temporal_change_recompute_before();

DROP TRIGGER IF EXISTS trg_weddings_temporal_recompute_after ON public.weddings;
CREATE TRIGGER trg_weddings_temporal_recompute_after
  AFTER UPDATE OF inquiry_date, wedding_date, guest_count ON public.weddings
  FOR EACH ROW
  EXECUTE FUNCTION public.weddings_temporal_change_recompute_after();

NOTIFY pgrst, 'reload schema';
