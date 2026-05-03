-- ---------------------------------------------------------------------------
-- 176_tours_cancellation_reason_extend.sql
-- ---------------------------------------------------------------------------
-- T5-Rixey-JJ: extend tours.cancellation_reason CHECK with buckets that
-- real Rixey Calendly cancellations actually use. Migration 166 shipped
-- 8 buckets; the live data shows 3 categories the original enum can't
-- cleanly represent:
--
--   - "Found a venue elsewhere" / "Went with another venue" / "Booked
--     different venue" — the lead actively chose a competitor. Distinct
--     from `lost_deals.reason_category='lost_to_competitor'` because the
--     LEAD-side equivalent on the tour timeline matters for the
--     intel-brain rollup ("23% of cancellations are competitor losses").
--     New bucket: `lost_to_competitor`.
--
--   - "Isadora's flight back from the UK was cancelled" / coordinator
--     travel disruption / facility closure — the venue is unable to
--     host. Migration 166's `travel_blocker` covers couple-side travel
--     issues only. Renaming `travel_blocker` would break existing rows;
--     instead we add a new venue-side bucket.
--     New bucket: `venue_unavailable`.
--
--   - "Got Covid" / "Sick" / "I picked up a mystery virus (with fever)" /
--     "Not feeling well" — health, but not necessarily a "family"
--     emergency. Migration 166's `family_emergency` covers
--     bereavement + urgent-family-matter, which is too narrow for the
--     dominant illness pattern in the Rixey data (10+ rows). Adding
--     `health_emergency` as the broader bucket; `family_emergency`
--     stays for backwards compat with rows already written under it.
--     New bucket: `health_emergency`.
--
-- Doctrine:
--   - DROP+ADD CHECK is non-destructive on a small table (tours has
--     <10k rows in real-prod). The DROP-then-ADD pattern matches
--     migration 166's own self-replay protection.
--   - All migration-166 buckets stay valid. Existing rows written as
--     'family_emergency' are unaffected.
--   - cancellation-classifier.ts maps free-text to this enum at write
--     time. The classifier ALSO recognises the new buckets via heuristic
--     before falling through to LLM.
--   - Idempotent: re-applying this migration on a database that already
--     has the extended CHECK is a no-op (DROP IF EXISTS, ADD with
--     named constraint).
-- ---------------------------------------------------------------------------

ALTER TABLE public.tours
  DROP CONSTRAINT IF EXISTS tours_cancellation_reason_check;

ALTER TABLE public.tours
  ADD CONSTRAINT tours_cancellation_reason_check CHECK (
    cancellation_reason IS NULL OR cancellation_reason IN (
      'weather',              -- weather event forced the cancel
      'date_conflict',        -- couple's schedule shifted (work, family event)
      'family_emergency',     -- bereavement / urgent family matter (legacy bucket)
      'health_emergency',     -- illness, Covid, hospital, mystery virus (T5-JJ)
      'venue_concern',        -- couple raised a concern about the venue itself
      'lost_to_competitor',   -- couple chose another venue (T5-JJ)
      'venue_unavailable',    -- venue-side cancel (coordinator travel, closure) (T5-JJ)
      'travel_blocker',       -- couple-side travel issue (flight cancel, illness in transit)
      'rescheduled',          -- coordinated to another date — lead alive
      'no_show_followup',     -- coordinator marked after the fact (no-show)
      'other'                 -- catch-all when extraction can't bucket
    )
  );

COMMENT ON COLUMN public.tours.cancellation_reason IS
  'Reason a tour was cancelled. Distinct from lost_deals.reason_category: a tour can be cancelled (weather, date conflict) without the deal being lost (reschedule succeeds, lead books later). Used by intel-brain.ts cancellation aggregates. Enum extended in migration 176 with lost_to_competitor / venue_unavailable / health_emergency to cover the dominant Rixey cancellation patterns.';
