-- Migration 159: T5-iota.1 fire-once heat events DB unique constraint.
--
-- Pre-fix: src/lib/services/heat-mapping.ts shouldSkipDuplicate() ran a
-- SELECT-then-INSERT to enforce the fire-once-per-wedding invariant for
-- a list of heat-signal event types. Two parallel pipeline runs (Knot
-- inquiry email + Calendly booking arriving in the same poll cycle, or
-- a manual Calendly fetch racing the live email pipeline) could both
-- pass the SELECT and both INSERT, double-counting heat points. The
-- audit (2026-05-T4) flagged this as a real race window.
--
-- Fix: a partial UNIQUE INDEX on (venue_id, wedding_id, event_type)
-- restricted to the fire-once event types. Postgres enforces the
-- constraint atomically; the application layer just tries to INSERT
-- and handles 23505 unique_violation with a reopen-aware retry (see
-- src/lib/services/heat-mapping.ts recordEngagementEventsBatch).
--
-- Reopen handling (CLAUDE.md heat scoring note): "if weddings.lost_at
-- is more recent than the existing event, dedup is bypassed (allows
-- fresh fire on a re-engaged lead)." A pure DB unique constraint can't
-- express the lost_at cross-table check, so the reopen-bypass moves
-- into the INSERT path: on 23505 the code DELETEs the stale event when
-- lost_at > existing.created_at and retries the INSERT.
--
-- Cleanup before index creation: any existing wedding with multiple
-- rows of the same fire-once event_type would block CREATE UNIQUE
-- INDEX. We DELETE all but the earliest (MIN(id)) per group so the
-- index can take. Cleanup is logged via RAISE NOTICE.
--
-- Idempotent: CREATE UNIQUE INDEX IF NOT EXISTS plus a guarded cleanup.

-- =====================================================================
-- Cleanup: remove duplicate fire-once events before creating the index.
-- =====================================================================
-- Strategy: keep the row with the smallest id per (venue_id, wedding_id,
-- event_type). The id ordering is stable for uuid v4 — not chronological,
-- but consistent across re-runs, which is what we need for idempotency.
-- We could prefer "earliest by created_at" but a tie on the same created_at
-- timestamp would still need a tiebreaker; id-based is simpler and safe.

DO $$
DECLARE
  removed_count integer;
BEGIN
  WITH dupes AS (
    SELECT id
      FROM (
        SELECT id,
               ROW_NUMBER() OVER (
                 PARTITION BY venue_id, wedding_id, event_type
                 ORDER BY created_at ASC, id ASC
               ) AS rn
          FROM public.engagement_events
         WHERE wedding_id IS NOT NULL
           AND event_type IN (
             'initial_inquiry',
             'tour_completed',
             'tour_requested',
             'high_commitment_signal',
             'family_mentioned',
             'high_specificity',
             'tour_cancelled',
             'not_interested_signal'
           )
      ) ranked
     WHERE rn > 1
  )
  DELETE FROM public.engagement_events
   WHERE id IN (SELECT id FROM dupes);

  GET DIAGNOSTICS removed_count = ROW_COUNT;
  RAISE NOTICE '[migration 159] removed % duplicate fire-once engagement_events rows before unique-index creation', removed_count;
END $$;

-- =====================================================================
-- Unique index — DB enforces the fire-once invariant from here on.
-- =====================================================================

CREATE UNIQUE INDEX IF NOT EXISTS uq_engagement_events_fire_once
  ON public.engagement_events (venue_id, wedding_id, event_type)
  WHERE event_type IN (
    'initial_inquiry',
    'tour_completed',
    'tour_requested',
    'high_commitment_signal',
    'family_mentioned',
    'high_specificity',
    'tour_cancelled',
    'not_interested_signal'
  );

COMMENT ON INDEX public.uq_engagement_events_fire_once IS
  'T5-iota.1 (2026-05-02). Partial UNIQUE INDEX enforcing the fire-once-'
  'per-wedding invariant for the heat-signal event types listed in '
  'CLAUDE.md heat scoring section. Replaces the in-code SELECT-then-'
  'INSERT shouldSkipDuplicate() check which had a race window. Reopen-'
  'bypass (when weddings.lost_at is more recent than the existing event) '
  'is implemented in recordEngagementEventsBatch on 23505: DELETE stale, '
  'retry INSERT.';

NOTIFY pgrst, 'reload schema';
