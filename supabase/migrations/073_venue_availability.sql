-- ---------------------------------------------------------------------------
-- 073_venue_availability.sql
-- ---------------------------------------------------------------------------
-- Phase 2 Task 10: venue-level date availability with explicit status enum,
-- max_events support for multi-wedding venues, and derived booked_count.
--
-- Also fixes two silent-data-loss bugs that Phase 1 surfaced:
--   * weddings.booked_at is read by 8+ files (weekly-digest, briefings,
--     anomaly-detection, intelligence-engine, intel/clients) to compute
--     inquiry-to-booking and tour-to-booking lag. It is written in exactly
--     ONE code path (heat-mapping.markAsBooked) that nothing calls. Manual
--     bookings entered through /portal/weddings go in with status='booked'
--     but booked_at=NULL, breaking every lag metric silently.
--   * weddings.lost_at has the identical write gap.
--
-- Design choices:
--   * Rename booked_dates → venue_availability rather than create a parallel
--     table. booked_dates was the original intent (indexed, RLS'd, scoped by
--     venue_id) but shipped without a writer. Two tables with overlapping
--     semantics would drift.
--   * Backfill status from block_type: wedding|private_event → 'booked',
--     maintenance → 'blocked', hold → 'hold'. tour_only + available are
--     new values the old schema didn't express.
--   * booked_count is a cached column maintained by a trigger on weddings.
--     Every reader sees a consistent value without having to JOIN.
--   * max_events defaults from venue_config.max_events_per_day when that is
--     set, else 1. venue-level override per date supported.
--   * Coordinator intent wins over auto-computation: if the coordinator
--     manually set status='hold' on a date and a wedding confirms there,
--     booked_count rises but status stays 'hold'. Only status='available'
--     auto-flips to 'booked' when the cap is hit.
--   * The date-stamp triggers on weddings do NOT overwrite an explicit
--     booked_at/lost_at passed in by the caller — only fill when NULL.
-- ---------------------------------------------------------------------------

-- ============================================================================
-- STEP 1 — Rename booked_dates to venue_availability and widen the schema.
-- ============================================================================

ALTER TABLE public.booked_dates RENAME TO venue_availability;

-- Widen to the 5-status enum from the Phase 2 Task 10 spec.
ALTER TABLE public.venue_availability
  ADD COLUMN IF NOT EXISTS status text
    CHECK (status IN ('available', 'booked', 'hold', 'tour_only', 'blocked'));

ALTER TABLE public.venue_availability
  ADD COLUMN IF NOT EXISTS max_events integer NOT NULL DEFAULT 1;

ALTER TABLE public.venue_availability
  ADD COLUMN IF NOT EXISTS booked_count integer NOT NULL DEFAULT 0;

ALTER TABLE public.venue_availability
  ADD COLUMN IF NOT EXISTS updated_at timestamptz DEFAULT now();

-- Backfill status from the old block_type column.
UPDATE public.venue_availability
   SET status = CASE
     WHEN block_type IN ('wedding', 'private_event') THEN 'booked'
     WHEN block_type = 'maintenance' THEN 'blocked'
     WHEN block_type = 'hold' THEN 'hold'
     ELSE 'blocked'
   END
 WHERE status IS NULL;

-- Enforce NOT NULL now that every row has a value.
ALTER TABLE public.venue_availability
  ALTER COLUMN status SET NOT NULL;
ALTER TABLE public.venue_availability
  ALTER COLUMN status SET DEFAULT 'available';

-- Drop the legacy column — status now carries the semantics.
ALTER TABLE public.venue_availability DROP COLUMN IF EXISTS block_type;

-- Rename the index that carried the old table name so \d output is clean.
ALTER INDEX IF EXISTS idx_booked_dates_venue_id_date
  RENAME TO idx_venue_availability_venue_id_date;

-- One row per (venue, date) — coordinators edit one status per date.
CREATE UNIQUE INDEX IF NOT EXISTS idx_venue_availability_venue_date_unique
  ON public.venue_availability (venue_id, date);

COMMENT ON TABLE public.venue_availability IS
  'owner:agent. Per-date availability status per venue. Row absent = available + 0 bookings. Row present = coordinator or trigger touched the date. booked_count maintained by the trigger on weddings.';

COMMENT ON COLUMN public.venue_availability.status IS
  '5-state enum: available (actively selling) | booked (date full) | hold (tentative, not contracted) | tour_only (site visit scheduled but no wedding) | blocked (closed for any reason). Coordinator intent wins: triggers only flip available→booked when booked_count hits max_events.';

-- ============================================================================
-- STEP 2 — Data-integrity trigger on weddings: booked_at / lost_at auto-fill.
-- ============================================================================

CREATE OR REPLACE FUNCTION public.weddings_stamp_status_dates()
RETURNS TRIGGER AS $$
BEGIN
  -- Fill booked_at when the row lands in a booked status and the caller
  -- didn't provide an explicit timestamp. Do not overwrite.
  IF NEW.status IN ('booked', 'completed') AND NEW.booked_at IS NULL THEN
    NEW.booked_at := now();
  END IF;

  -- Same pattern for lost_at.
  IF NEW.status IN ('lost', 'cancelled') AND NEW.lost_at IS NULL THEN
    NEW.lost_at := now();
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_weddings_stamp_status_dates ON public.weddings;
CREATE TRIGGER trg_weddings_stamp_status_dates
  BEFORE INSERT OR UPDATE OF status ON public.weddings
  FOR EACH ROW
  EXECUTE FUNCTION public.weddings_stamp_status_dates();

-- Backfill existing rows that ended up in a terminal state without a stamp.
UPDATE public.weddings
   SET booked_at = COALESCE(booked_at, updated_at, created_at)
 WHERE status IN ('booked', 'completed')
   AND booked_at IS NULL;

UPDATE public.weddings
   SET lost_at = COALESCE(lost_at, updated_at, created_at)
 WHERE status IN ('lost', 'cancelled')
   AND lost_at IS NULL;

-- ============================================================================
-- STEP 3 — venue_availability.booked_count maintenance trigger on weddings.
-- ============================================================================

CREATE OR REPLACE FUNCTION public.sync_venue_availability_for_date(
  p_venue_id uuid,
  p_date date
) RETURNS void AS $$
DECLARE
  v_count integer;
  v_existing_status text;
  v_default_max integer;
BEGIN
  IF p_venue_id IS NULL OR p_date IS NULL THEN
    RETURN;
  END IF;

  -- Live count of weddings on this date in a date-consuming status.
  SELECT COUNT(*)::int INTO v_count
    FROM public.weddings
   WHERE venue_id = p_venue_id
     AND wedding_date = p_date
     AND status IN ('booked', 'completed');

  -- Coordinator's current intent for this date (if any row exists).
  SELECT status INTO v_existing_status
    FROM public.venue_availability
   WHERE venue_id = p_venue_id AND date = p_date;

  -- Venue default for max_events when inserting a fresh row.
  SELECT COALESCE(max_events_per_day, 1) INTO v_default_max
    FROM public.venue_config
   WHERE venue_id = p_venue_id;

  IF v_count = 0 AND v_existing_status IS NULL THEN
    -- No weddings, no coordinator touch, nothing to persist.
    RETURN;
  END IF;

  IF v_existing_status IS NULL THEN
    -- First time any wedding confirms for this date. Create the row with the
    -- venue default max_events and flip status to 'booked' if cap is hit.
    INSERT INTO public.venue_availability (venue_id, date, status, max_events, booked_count, updated_at)
    VALUES (
      p_venue_id,
      p_date,
      CASE WHEN v_count >= COALESCE(v_default_max, 1) THEN 'booked' ELSE 'available' END,
      COALESCE(v_default_max, 1),
      v_count,
      now()
    )
    ON CONFLICT (venue_id, date) DO UPDATE
      SET booked_count = EXCLUDED.booked_count,
          status = CASE
            WHEN public.venue_availability.status = 'available' AND EXCLUDED.booked_count >= public.venue_availability.max_events
              THEN 'booked'
            WHEN public.venue_availability.status = 'booked' AND EXCLUDED.booked_count = 0
              THEN 'available'
            ELSE public.venue_availability.status
          END,
          updated_at = now();
  ELSE
    -- Existing row — update count and let the CASE above decide status.
    UPDATE public.venue_availability
       SET booked_count = v_count,
           status = CASE
             WHEN status = 'available' AND v_count >= max_events THEN 'booked'
             WHEN status = 'booked' AND v_count = 0 THEN 'available'
             ELSE status
           END,
           updated_at = now()
     WHERE venue_id = p_venue_id AND date = p_date;
  END IF;
END;
$$ LANGUAGE plpgsql;

COMMENT ON FUNCTION public.sync_venue_availability_for_date(uuid, date) IS
  'Recompute venue_availability.booked_count for a single (venue, date) from the weddings table. Used by the wedding status/date trigger. Coordinator-set statuses (hold, tour_only, blocked) are preserved; only available<->booked transitions are automatic.';

CREATE OR REPLACE FUNCTION public.weddings_sync_availability()
RETURNS TRIGGER AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    PERFORM public.sync_venue_availability_for_date(NEW.venue_id, NEW.wedding_date);

  ELSIF TG_OP = 'UPDATE' THEN
    -- Date changed OR status changed in/out of a date-consuming state.
    IF NEW.wedding_date IS DISTINCT FROM OLD.wedding_date THEN
      PERFORM public.sync_venue_availability_for_date(OLD.venue_id, OLD.wedding_date);
      PERFORM public.sync_venue_availability_for_date(NEW.venue_id, NEW.wedding_date);
    ELSIF NEW.status IS DISTINCT FROM OLD.status THEN
      PERFORM public.sync_venue_availability_for_date(NEW.venue_id, NEW.wedding_date);
    END IF;

  ELSIF TG_OP = 'DELETE' THEN
    PERFORM public.sync_venue_availability_for_date(OLD.venue_id, OLD.wedding_date);
  END IF;

  RETURN COALESCE(NEW, OLD);
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_weddings_sync_availability ON public.weddings;
CREATE TRIGGER trg_weddings_sync_availability
  AFTER INSERT OR UPDATE OR DELETE ON public.weddings
  FOR EACH ROW
  EXECUTE FUNCTION public.weddings_sync_availability();

-- One-off backfill: rebuild booked_count for every (venue, wedding_date)
-- that currently has at least one booked/completed wedding.
DO $$
DECLARE r record;
BEGIN
  FOR r IN
    SELECT DISTINCT venue_id, wedding_date
      FROM public.weddings
     WHERE status IN ('booked', 'completed')
       AND wedding_date IS NOT NULL
  LOOP
    PERFORM public.sync_venue_availability_for_date(r.venue_id, r.wedding_date);
  END LOOP;
END $$;

-- ============================================================================
-- STEP 4 — updated_at auto-maintenance on venue_availability edits.
-- ============================================================================

CREATE OR REPLACE FUNCTION public.venue_availability_touch_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at := now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_venue_availability_updated_at ON public.venue_availability;
CREATE TRIGGER trg_venue_availability_updated_at
  BEFORE UPDATE ON public.venue_availability
  FOR EACH ROW
  EXECUTE FUNCTION public.venue_availability_touch_updated_at();

NOTIFY pgrst, 'reload schema';
