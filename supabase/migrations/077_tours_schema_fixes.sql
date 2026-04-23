-- ---------------------------------------------------------------------------
-- 077_tours_schema_fixes.sql
-- ---------------------------------------------------------------------------
-- Phase 2 Task 21: two pre-existing bugs in the tours table that prevented
-- the /intel/tours form from ever successfully saving a row.
--
-- Bug A: `outcome` CHECK constraint allowed only
--   ('completed','cancelled','no_show','rescheduled') but the UI and the
--   consultant-tracking service insert with outcome='pending' (tour is
--   scheduled but not yet conducted). Every form save failed silently —
--   the 20 demo rows all came from seed.sql which must have bypassed.
--
-- Bug B: the UI insert writes `couple_name` but that column doesn't
--   exist. The existing page's insert at intel/tours/page.tsx:287 fails
--   with "column couple_name of relation tours does not exist". Couple
--   identity already lives on people (via wedding_id) so we don't need
--   a redundant text column — just don't write it.
--
-- This migration widens the CHECK so 'pending' and the other real-world
-- values ('booked' tour outcome, 'lost' tour outcome) are admitted.
-- ---------------------------------------------------------------------------

ALTER TABLE public.tours DROP CONSTRAINT IF EXISTS tours_outcome_check;
ALTER TABLE public.tours ADD CONSTRAINT tours_outcome_check CHECK (
  outcome IS NULL OR outcome IN (
    'pending',     -- tour scheduled, not yet conducted
    'completed',   -- tour happened, no decision yet
    'booked',      -- couple booked after the tour
    'lost',        -- couple decided against the venue
    'cancelled',   -- couple cancelled before the tour
    'no_show',     -- couple didn't show
    'rescheduled'  -- moved to another date
  )
);

COMMENT ON COLUMN public.tours.outcome IS
  'Tour state: pending (scheduled, not yet conducted) | completed | booked (tour converted) | lost (did not convert) | cancelled | no_show | rescheduled. Widened from the original 4-value set in migration 077.';
