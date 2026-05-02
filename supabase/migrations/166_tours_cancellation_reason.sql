-- ---------------------------------------------------------------------------
-- 166_tours_cancellation_reason.sql
-- ---------------------------------------------------------------------------
-- T5 schema gap: distinguish "tour cancelled, lead alive" from "lead lost".
--
-- Pre-fix: the only way to record a reason for a tour falling through was
-- via lost_deals.reason_category with lost_at_stage='tour'. That writer
-- only fires when the deal itself dies — it loses the case where a tour
-- is cancelled (weather, schedule conflict, illness) but the lead recovers
-- (reschedule succeeds, books later).
--
-- The tours table previously had only `outcome` (CHECK in migration 077:
-- pending/completed/booked/lost/cancelled/no_show/rescheduled) and `notes`.
-- This migration adds:
--   - cancellation_reason: nullable enum-style text, gated by CHECK so
--     only known buckets land. Default NULL preserves all existing rows
--     and existing writers that don't pass the field.
--   - cancellation_note: free-text optional context. App-side caps at
--     280 chars (mirrors a tweet so it stays a one-liner the coordinator
--     reads in a glance — DB allows arbitrary length so we don't lose
--     fidelity if a future surface relaxes the cap).
--   - Partial index (venue_id, cancellation_reason) WHERE cancellation_reason
--     IS NOT NULL — supports the aggregate query in intel-brain.ts
--     gatherVenueData (T5-θ.2 cancellation aggregates).
--
-- Idempotent: every statement uses IF NOT EXISTS / DROP-then-ADD so
-- replay on a database that already has the column is a no-op.
-- ---------------------------------------------------------------------------

ALTER TABLE public.tours
  ADD COLUMN IF NOT EXISTS cancellation_reason text NULL;

-- Drop and recreate the CHECK so re-applying the migration over an
-- earlier (incomplete) version of itself still lands the right enum set.
ALTER TABLE public.tours
  DROP CONSTRAINT IF EXISTS tours_cancellation_reason_check;
ALTER TABLE public.tours
  ADD CONSTRAINT tours_cancellation_reason_check CHECK (
    cancellation_reason IS NULL OR cancellation_reason IN (
      'weather',            -- weather event forced the cancel
      'date_conflict',      -- couple's schedule shifted (work, family event)
      'family_emergency',   -- illness, bereavement, urgent family matter
      'venue_concern',      -- couple raised a concern about the venue itself
      'travel_blocker',     -- travel (flight cancel, illness in transit)
      'rescheduled',        -- coordinated to another date — lead alive
      'no_show_followup',   -- coordinator marked after the fact (no-show)
      'other'               -- catch-all when extraction can't bucket
    )
  );

ALTER TABLE public.tours
  ADD COLUMN IF NOT EXISTS cancellation_note text NULL;

CREATE INDEX IF NOT EXISTS idx_tours_cancellation_reason
  ON public.tours (venue_id, cancellation_reason)
  WHERE cancellation_reason IS NOT NULL;

COMMENT ON COLUMN public.tours.cancellation_reason IS
  'Reason a tour was cancelled. Distinct from lost_deals.reason_category: a tour can be cancelled (weather, date conflict) without the deal being lost (reschedule succeeds, lead books later). Used by intel-brain.ts cancellation aggregates.';

COMMENT ON COLUMN public.tours.cancellation_note IS
  'Optional free-text context for the cancellation. App-side capped at 280 chars (validation enforced at the writer surface, not the DB).';
