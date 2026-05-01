-- Migration 143: index for the F6 fire-once-per-wedding prefetch
--
-- The email-pipeline F6 path (review pass 1 / heat-map fix) does:
--   SELECT event_type FROM engagement_events
--   WHERE venue_id=X AND wedding_id=Y
--     AND event_type IN ('tour_requested','high_commitment_signal',
--                        'family_mentioned','high_specificity')
--
-- on every inbound new_inquiry / inquiry_reply email so the F6 heat-
-- signal block can dedup. Without an index on (wedding_id, event_type)
-- this falls back to sequential scan when wedding has many events.
--
-- This migration adds a partial index on (venue_id, wedding_id, event_type)
-- restricted to the four fire-once-per-wedding event types — keeps
-- the index small and only benefits the prefetch's exact query shape.
--
-- Idempotent: CREATE INDEX IF NOT EXISTS.

CREATE INDEX IF NOT EXISTS idx_engagement_events_fire_once_dedup
  ON public.engagement_events (venue_id, wedding_id, event_type)
  WHERE event_type IN (
    'tour_requested',
    'high_commitment_signal',
    'family_mentioned',
    'high_specificity'
  );

COMMENT ON INDEX public.idx_engagement_events_fire_once_dedup IS
  'Targets the F6 dedup prefetch in email-pipeline.ts. Partial — only '
  'rows with the four fire-once-per-wedding event types are indexed, '
  'keeping size minimal. Per heat-map fix 2026-05-01.';
