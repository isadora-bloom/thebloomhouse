-- ---------------------------------------------------------------------------
-- 348_identity_first_phase_d_decay.sql
-- ---------------------------------------------------------------------------
-- Phase D-2 (decay detection) prep. Anchor: IDENTITY-FIRST-ARCHITECTURE.md
-- §3.
--
-- Phase A created `couples.last_progression_at` (nullable) and the
-- `couple_progression_events` table. Phase B's `decay_sweep` stage was
-- a documented no-op because:
--   1. last_progression_at was never backfilled for existing couples
--   2. no progression-event writer was wired
--   3. decay_sweep would have flipped every couple to ghost if it ran
--
-- This migration fixes #1 by backfilling. The progression-event writer
-- (#2) and the decay sweep itself (#3) are TypeScript changes that
-- ship in the same release.
--
-- Backfill strategy:
--   For every couple, set last_progression_at = greatest(
--     most recent INBOUND touchpoint occurred_at (channel and action
--     matching the doctrine's progression-eligible event types),
--     couples.created_at
--   )
--
-- For couples with no inbound touchpoints at all (anchor-only from a
-- HoneyBook backfill), last_progression_at = couples.created_at. The
-- decay window default is 180 days; couples created within the last
-- 180 days stay Active even without any inbound activity (they are
-- presumed fresh anchors).
--
-- Inbound action types eligible to set last_progression_at (per §3
-- Don't skip #1, outbound MUST NOT count):
--   - email reply (channel=gmail, action_type=reply)
--   - tour booked / attended (channel=calendly, action_type=tour_booked
--     or tour_attended)
--   - contract signed (channel=honeybook, action_type=contract_signed)
--   - inquiry form / inbound followup (channel in knot/wedding wire,
--     action_type=inquiry or message)
--   - portal click (channel=portal, action_type=portal_click)
--
-- Rerun safety: the UPDATE clause uses GREATEST(existing,
-- backfilled) so re-running the migration never moves the clock
-- backward. Idempotent.
-- ---------------------------------------------------------------------------

-- ===========================================================================
-- 1. Backfill last_progression_at on existing couples
-- ===========================================================================

WITH inbound_progress AS (
  SELECT
    tp.couple_id,
    MAX(tp.occurred_at) AS latest_inbound
  FROM public.touchpoints tp
  WHERE tp.couple_id IS NOT NULL
    AND (
         (tp.channel = 'gmail'      AND tp.action_type IN ('reply', 'inquiry'))
      OR (tp.channel = 'calendly'   AND tp.action_type IN ('tour_booked','tour_attended'))
      OR (tp.channel = 'honeybook'  AND tp.action_type IN ('contract_signed','booking_signed'))
      OR (tp.channel IN ('knot','weddingwire','zola') AND tp.action_type IN ('inquiry','message','inquiry_form'))
      OR (tp.channel = 'portal'     AND tp.action_type IN ('portal_click','portal_visit'))
      OR (tp.channel = 'website'    AND tp.action_type = 'inquiry_form_submitted')
    )
  GROUP BY tp.couple_id
)
UPDATE public.couples c
SET last_progression_at = GREATEST(
  COALESCE(c.last_progression_at, c.created_at),
  COALESCE(ip.latest_inbound,     c.created_at)
)
FROM inbound_progress ip
WHERE c.id = ip.couple_id;

-- Couples with no inbound touchpoints at all: stamp created_at so
-- the decay sweep's window math is meaningful from day 1.
UPDATE public.couples
SET last_progression_at = created_at
WHERE last_progression_at IS NULL;


-- ===========================================================================
-- 2. Index for the decay sweep query
-- ===========================================================================
-- The decay sweep selects couples WHERE lifecycle_state IN
-- ('resolved','channel_scoped') AND last_progression_at < now() -
-- decay_window_days. Hot path on the (venue_id, lifecycle_state,
-- last_progression_at) tuple.

CREATE INDEX IF NOT EXISTS ix_couples_decay_sweep
  ON public.couples (venue_id, lifecycle_state, last_progression_at)
  WHERE lifecycle_state IN ('resolved','channel_scoped');


-- ===========================================================================
-- 3. Index on couple_progression_events for the existence check
-- ===========================================================================
-- The decay sweep also checks NOT EXISTS (SELECT 1 FROM
-- couple_progression_events WHERE couple_id = ... AND occurred_at >
-- now() - decay_window_days). The composite index makes this an
-- index-only scan.

CREATE INDEX IF NOT EXISTS ix_couple_progression_events_recent
  ON public.couple_progression_events (couple_id, occurred_at DESC);
