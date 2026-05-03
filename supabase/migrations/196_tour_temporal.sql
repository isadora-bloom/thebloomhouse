-- ---------------------------------------------------------------------------
-- 196_tour_temporal.sql
-- ---------------------------------------------------------------------------
-- T5-Rixey-GGG: temporal layer for tours.
--
-- Pre-fix state (the bugs this migration unlocks):
--
--   Bug 12 — Tour Tracking shows 280 tours / 0 completed / 0% conversion
--   even though ~70 of those tours led to bookings. Root cause: nothing
--   ever flips tours.outcome from 'pending' (or NULL) to 'completed' /
--   'cancelled' / 'no_show' once the tour date has passed. Coordinators
--   only get to set outcomes through the cancel-tour modal; everything
--   else stays 'pending' forever. The new tour_outcome_classifier service
--   walks past-due tours nightly and stamps the right outcome based on
--   evidence (cancellation interactions, no-show notes, otherwise
--   defaults to 'completed').
--
--   Bug 13 — Tour Tracking "Couple" column shows "—" for every row.
--   Root cause: the page tries to read tours.couple_name (legacy field
--   that never existed) instead of joining through wedding → people.
--   This migration adds tours.couple_display_name as a denormalized
--   stamp (so list surfaces don't re-do the JOIN every render) and a
--   trigger on people INSERT/UPDATE/DELETE that keeps it in sync with
--   the underlying partner1/partner2 person rows. Backfill populates
--   every existing tour from current people.
--
--   Bug 22 prerequisite — "Still browsing after the tour" needs
--   tours.outcome='completed' to filter on. Bug 12 fixes the writer;
--   this column makes the read possible.
--
-- This migration covers the schema layer for those bugs:
--   1. tours.couple_display_name text (denormalized) + trigger to keep
--      it in sync with people. Backfill from current people rows.
--   2. Index on (venue_id, scheduled_at) for the past-due-tour scan in
--      tour_outcome_classifier (scoped per venue, ordered by date).
--   3. Comment-only documentation; no NOT NULL on scheduled_at because
--      Bug 24 investigation needs to run first against live data.
--
-- Idempotent: every statement uses IF NOT EXISTS / CREATE OR REPLACE so
-- replay on a database that already has these objects is a no-op.
-- ---------------------------------------------------------------------------

-- ---------------------------------------------------------------------------
-- 1. tours.couple_display_name (denormalized for tour-list display)
-- ---------------------------------------------------------------------------

ALTER TABLE public.tours
  ADD COLUMN IF NOT EXISTS couple_display_name text NULL;

COMMENT ON COLUMN public.tours.couple_display_name IS
  'Denormalized couple display name (e.g. "Maddie & Brian"). Populated by trigger when the underlying partner1/partner2 people rows change. Saves every tour-list surface from re-doing the wedding → people JOIN. Source of truth is still public.people; this is a cache. Bug 13 fix (T5-Rixey-GGG).';

-- ---------------------------------------------------------------------------
-- 2. Helper function: compute couple_display_name from people rows
--    Used by both the trigger and the backfill below.
--    Returns the 'partner1 & partner2' joined first names, falls back to
--    just partner1, then 'Unknown couple' if no people exist.
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.compute_couple_display_name(p_wedding_id uuid)
RETURNS text
LANGUAGE plpgsql
STABLE
AS $$
DECLARE
  partner1_first text;
  partner2_first text;
BEGIN
  IF p_wedding_id IS NULL THEN
    RETURN NULL;
  END IF;

  SELECT first_name INTO partner1_first
  FROM public.people
  WHERE wedding_id = p_wedding_id AND role = 'partner1'
  ORDER BY created_at ASC
  LIMIT 1;

  SELECT first_name INTO partner2_first
  FROM public.people
  WHERE wedding_id = p_wedding_id AND role = 'partner2'
  ORDER BY created_at ASC
  LIMIT 1;

  IF partner1_first IS NOT NULL AND partner2_first IS NOT NULL
     AND partner1_first <> '' AND partner2_first <> ''
     AND lower(partner1_first) <> lower(partner2_first) THEN
    RETURN partner1_first || ' & ' || partner2_first;
  ELSIF partner1_first IS NOT NULL AND partner1_first <> '' THEN
    RETURN partner1_first;
  ELSIF partner2_first IS NOT NULL AND partner2_first <> '' THEN
    RETURN partner2_first;
  ELSE
    RETURN NULL;
  END IF;
END;
$$;

COMMENT ON FUNCTION public.compute_couple_display_name(uuid) IS
  'Compute the couple_display_name string from current public.people rows for a wedding. Used by tours_sync_couple_name trigger and 196 backfill. Stable so the planner can cache within a single statement.';

-- ---------------------------------------------------------------------------
-- 3. Trigger function: keep tours.couple_display_name in sync
--    Fires on INSERT/UPDATE/DELETE of public.people (partner1/partner2
--    rows only). Recomputes the cached name on every tours row tied to
--    the affected wedding.
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.tours_sync_couple_name()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
DECLARE
  affected_wedding_id uuid;
  new_name text;
BEGIN
  -- Pick the wedding_id from the relevant row. On UPDATE both OLD and
  -- NEW are populated; if the wedding moved (rare) update both sides.
  IF TG_OP = 'DELETE' THEN
    affected_wedding_id := OLD.wedding_id;
  ELSE
    affected_wedding_id := NEW.wedding_id;
  END IF;

  IF affected_wedding_id IS NOT NULL THEN
    new_name := public.compute_couple_display_name(affected_wedding_id);
    UPDATE public.tours
       SET couple_display_name = new_name
     WHERE wedding_id = affected_wedding_id;
  END IF;

  -- Handle the rare case where a person row was reassigned to a
  -- different wedding (UPDATE moved wedding_id). Sync the prior
  -- wedding's tours too.
  IF TG_OP = 'UPDATE' AND OLD.wedding_id IS DISTINCT FROM NEW.wedding_id
     AND OLD.wedding_id IS NOT NULL THEN
    new_name := public.compute_couple_display_name(OLD.wedding_id);
    UPDATE public.tours
       SET couple_display_name = new_name
     WHERE wedding_id = OLD.wedding_id;
  END IF;

  IF TG_OP = 'DELETE' THEN
    RETURN OLD;
  END IF;
  RETURN NEW;
END;
$$;

COMMENT ON FUNCTION public.tours_sync_couple_name() IS
  'Trigger function: re-stamp tours.couple_display_name whenever the underlying partner1/partner2 people rows change. Bug 13 fix (T5-Rixey-GGG).';

DROP TRIGGER IF EXISTS trg_tours_sync_couple_name ON public.people;
CREATE TRIGGER trg_tours_sync_couple_name
AFTER INSERT OR UPDATE OR DELETE
ON public.people
FOR EACH ROW
WHEN (
  -- Only fire for partner roles. Guests / wedding party / vendor /
  -- family don't carry couple identity.
  (TG_OP = 'DELETE' AND OLD.role IN ('partner1', 'partner2'))
  OR (TG_OP <> 'DELETE' AND NEW.role IN ('partner1', 'partner2'))
)
EXECUTE FUNCTION public.tours_sync_couple_name();

-- ---------------------------------------------------------------------------
-- 4. Backfill couple_display_name for existing tours.
--    Runs once at migration time. Idempotent: any subsequent person
--    insert will re-trigger via trg_tours_sync_couple_name above, so
--    re-running this migration does the same thing.
-- ---------------------------------------------------------------------------

UPDATE public.tours t
   SET couple_display_name = public.compute_couple_display_name(t.wedding_id)
 WHERE t.wedding_id IS NOT NULL
   AND (t.couple_display_name IS NULL OR t.couple_display_name = '');

-- ---------------------------------------------------------------------------
-- 5. Helpful index for the tour_outcome_classifier scan
--    The classifier queries tours WHERE outcome IN ('pending', NULL)
--    AND scheduled_at < now() per venue. Index on (venue_id,
--    scheduled_at) makes this O(log n) per venue.
-- ---------------------------------------------------------------------------

CREATE INDEX IF NOT EXISTS idx_tours_venue_scheduled_at
  ON public.tours (venue_id, scheduled_at);

-- ---------------------------------------------------------------------------
-- 6. Reload PostgREST schema cache so the new column is queryable
--    immediately by API clients without a deploy.
-- ---------------------------------------------------------------------------

NOTIFY pgrst, 'reload schema';
