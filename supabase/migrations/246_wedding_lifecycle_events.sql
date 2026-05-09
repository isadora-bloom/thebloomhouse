-- ============================================================================
-- Migration 246: Wedding Lifecycle Events + per-message lifecycle signal.
-- ============================================================================
--
-- Companion to lib/services/lifecycle/wedding-lifecycle-engine.ts +
-- signal-detector.ts. Two changes:
--
--   1) wedding_lifecycle_events: append-only audit table for every
--      lifecycle transition (or attempted transition that the engine
--      rejected as illegal -- those land with status_to=null and
--      signal includes a 'violation:' prefix). Coordinators read this on
--      the wedding detail page; intel reads it for journey narratives;
--      backfill / cron readiness gates read it for invariant checks.
--
--   2) interactions.lifecycle_signal: per-message detection result. The
--      detector writes this on every inbound. The auto-draft gate
--      reads the most recent inbound on a thread and refuses to draft
--      when the signal is a loss kind (lead_declined / going_with_other
--      / silent_close), even if the wedding row has not yet
--      transitioned to 'lost' (the engine + writer are eventually
--      consistent on the row, but the per-message signal is the
--      authoritative source for the gate).
--
-- Idempotent: CREATE TABLE / INDEX / POLICY all use IF NOT EXISTS or
-- DROP-then-CREATE so re-running the migration on a venue that already
-- saw a prior partial apply is safe. Permissive auth policies match the
-- rest of the system (post-058 sweep).
-- ============================================================================

CREATE TABLE IF NOT EXISTS wedding_lifecycle_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  venue_id uuid NOT NULL REFERENCES venues(id) ON DELETE CASCADE,
  wedding_id uuid NOT NULL REFERENCES weddings(id) ON DELETE CASCADE,
  signal text NOT NULL,
  status_from text,
  status_to text,
  reason text,
  detected_by text NOT NULL CHECK (detected_by IN ('ai', 'pipeline', 'coordinator', 'webhook', 'cron', 'backfill')),
  source_interaction_id uuid REFERENCES interactions(id) ON DELETE SET NULL,
  confidence numeric,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_wlce_wedding_id
  ON wedding_lifecycle_events (wedding_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_wlce_venue_id
  ON wedding_lifecycle_events (venue_id, created_at DESC);

ALTER TABLE wedding_lifecycle_events ENABLE ROW LEVEL SECURITY;

-- Permissive policies (auth scope check is owned upstream by venue
-- membership context; the table only contains lifecycle metadata, no
-- raw PII). Matches the /225 / 226 RLS doctrine.
DROP POLICY IF EXISTS "auth_select_wlce" ON wedding_lifecycle_events;
CREATE POLICY "auth_select_wlce" ON wedding_lifecycle_events
  FOR SELECT TO authenticated USING (true);

DROP POLICY IF EXISTS "auth_insert_wlce" ON wedding_lifecycle_events;
CREATE POLICY "auth_insert_wlce" ON wedding_lifecycle_events
  FOR INSERT TO authenticated WITH CHECK (true);

-- ----------------------------------------------------------------------------
-- interactions.lifecycle_signal: per-message detector output.
-- ----------------------------------------------------------------------------
--
-- Stamped on inbound rows by the email pipeline after the AI signal
-- detector runs. NULL means either the detector returned null (most
-- common case -- regular inquiries / questions) or the row predates this
-- column. Auto-draft gate reads the most recent inbound on a thread and
-- treats lead_declined / going_with_other / silent_close as
-- draft-suppressing.
--
-- No CHECK constraint on the value: the engine's LifecycleSignal type
-- evolves and we'd rather a future signal kind land here as data than
-- fail the inbound INSERT. Coordinators / migrations 247+ enforce
-- coherence.

ALTER TABLE interactions
  ADD COLUMN IF NOT EXISTS lifecycle_signal text;

-- weddings.cancelled_at: stamped when a booked wedding is cancelled.
-- Mirrors lost_at / booked_at (already in 001_shared_tables.sql). Used by
-- the lifecycle writer + intel narratives to anchor "wedding cancelled
-- on date X" without needing to scan engagement_events.
ALTER TABLE weddings
  ADD COLUMN IF NOT EXISTS cancelled_at timestamptz;

-- Partial index: only index rows that actually carry a signal. Queries
-- like "find me weddings whose latest inbound was a decline" are heavily
-- selective.
CREATE INDEX IF NOT EXISTS idx_interactions_lifecycle_signal
  ON interactions (wedding_id, timestamp DESC)
  WHERE lifecycle_signal IS NOT NULL;

-- ============================================================================
-- One-shot heuristic backfill (in-migration, idempotent).
-- ============================================================================
--
-- This is COARSER than the live AI detector. We scan inbound interactions
-- for explicit decline / going-with-other / platform-close phrases via SQL
-- ILIKE. The live detector takes over for new mail, where it can use
-- Haiku-grade language understanding. The backfill exists so that as of
-- the migration apply, weddings that should ALREADY be lost stop
-- emitting auto-replies on their next inbound.
--
-- Trade-off documented: regex-style backfill catches the common cases
-- (the 80%) but misses paraphrasing. The user accepted this; the live
-- AI detector covers the long tail going forward.
--
-- Safety:
--   - Only flips weddings whose CURRENT status is in the pre-booking
--     set (inquiry / tour_scheduled / tour_completed / proposal_sent).
--     A booked or completed wedding never gets auto-flipped.
--   - Inserts a wedding_lifecycle_events row with detected_by='backfill'
--     so the source is auditable.
--   - Idempotent: the WHERE clause filters out weddings that already
--     have a backfill event for the same signal. Re-running the
--     migration is safe.

DO $backfill$
DECLARE
  affected_count int := 0;
BEGIN
  -- Loss-signal inbound interactions. Each WHEN branch matches one
  -- LifecycleSignal kind. We deliberately keep the patterns narrow --
  -- false positives flip a real lead to lost.
  WITH loss_candidates AS (
    SELECT
      i.id AS interaction_id,
      i.venue_id,
      i.wedding_id,
      i.timestamp,
      i.full_body,
      i.subject,
      i.from_email,
      CASE
        -- silent_close: platform-driven close events. WeddingPro /
        -- WeddingWire have a stock phrase; The Knot uses different
        -- wording.
        WHEN COALESCE(i.full_body, '') ILIKE '%decided to close the conversation%'
          OR COALESCE(i.full_body, '') ILIKE '%couple closed this conversation%'
          OR COALESCE(i.full_body, '') ILIKE '%marked as not interested%'
          OR COALESCE(i.full_body, '') ILIKE '%this lead has been archived%'
          OR COALESCE(i.subject, '') ILIKE '%conversation closed%'
          OR COALESCE(i.subject, '') ILIKE '%lead archived%'
          THEN 'silent_close'
        -- going_with_other: chose another venue.
        WHEN COALESCE(i.full_body, '') ILIKE '%decided on another venue%'
          OR COALESCE(i.full_body, '') ILIKE '%going with another%'
          OR COALESCE(i.full_body, '') ILIKE '%we''re going with %'
          OR COALESCE(i.full_body, '') ILIKE '%chose a different venue%'
          OR COALESCE(i.full_body, '') ILIKE '%signed with another venue%'
          OR COALESCE(i.full_body, '') ILIKE '%booked another venue%'
          THEN 'going_with_other'
        -- lead_declined: explicit decline. Order matters -- match the
        -- specific decline patterns before the noisier "we won't" cases.
        WHEN COALESCE(i.full_body, '') ILIKE '%won''t be moving forward%'
          OR COALESCE(i.full_body, '') ILIKE '%will not be moving forward%'
          OR COALESCE(i.full_body, '') ILIKE '%no longer pursuing%'
          OR COALESCE(i.full_body, '') ILIKE '%removing your venue from consideration%'
          OR COALESCE(i.full_body, '') ILIKE '%decided not to book%'
          OR COALESCE(i.full_body, '') ILIKE '%no longer in the running%'
          OR COALESCE(i.full_body, '') ILIKE '%we''re going to pass%'
          OR COALESCE(i.full_body, '') ILIKE '%we are going to pass%'
          THEN 'lead_declined'
        ELSE NULL
      END AS detected_signal
    FROM interactions i
    WHERE i.direction = 'inbound'
      AND i.wedding_id IS NOT NULL
      AND i.full_body IS NOT NULL
  ),
  matches AS (
    SELECT * FROM loss_candidates WHERE detected_signal IS NOT NULL
  ),
  -- Pick the most recent matching inbound per wedding so the backfill
  -- event ties to the latest signal, not an old one. A wedding might
  -- have several decline-shaped phrases historically (e.g. couple wrote
  -- back later); the latest is the authoritative state.
  latest_per_wedding AS (
    SELECT DISTINCT ON (wedding_id)
      wedding_id, venue_id, interaction_id, detected_signal, timestamp
    FROM matches
    ORDER BY wedding_id, timestamp DESC
  ),
  -- Filter to weddings still in pre-booking states; never flip booked /
  -- completed / cancelled. lost-already weddings are also filtered out
  -- (the event would be a no-op).
  to_flip AS (
    SELECT lpw.*
    FROM latest_per_wedding lpw
    JOIN weddings w ON w.id = lpw.wedding_id
    WHERE w.status IN ('inquiry', 'tour_scheduled', 'tour_completed', 'proposal_sent')
      -- Idempotent: skip rows that already have a backfill event for
      -- this signal kind.
      AND NOT EXISTS (
        SELECT 1 FROM wedding_lifecycle_events e
        WHERE e.wedding_id = lpw.wedding_id
          AND e.signal = lpw.detected_signal
          AND e.detected_by = 'backfill'
      )
  )
  -- Step 1: log the lifecycle events.
  INSERT INTO wedding_lifecycle_events
    (venue_id, wedding_id, signal, status_from, status_to, reason, detected_by, source_interaction_id, confidence)
  SELECT
    f.venue_id,
    f.wedding_id,
    f.detected_signal,
    w.status,
    'lost',
    'heuristic backfill on migration 246',
    'backfill',
    f.interaction_id,
    NULL  -- backfill has no model confidence; keep the column nullable
  FROM to_flip f
  JOIN weddings w ON w.id = f.wedding_id;

  GET DIAGNOSTICS affected_count = ROW_COUNT;
  RAISE NOTICE 'backfill: logged % wedding_lifecycle_events rows', affected_count;

  -- Step 2: flip the wedding rows to lost. The WHERE clause repeats the
  -- pre-booking guard so a concurrent transition between step 1 and 2
  -- doesn't get clobbered.
  UPDATE weddings w
  SET status = 'lost',
      lost_at = COALESCE(w.lost_at, now()),
      lost_reason = COALESCE(w.lost_reason, 'backfill: ' || f.detected_signal),
      updated_at = now()
  FROM (
    SELECT DISTINCT wedding_id, detected_signal FROM (
      SELECT
        i.wedding_id,
        CASE
          WHEN COALESCE(i.full_body, '') ILIKE '%decided to close the conversation%'
            OR COALESCE(i.full_body, '') ILIKE '%couple closed this conversation%'
            OR COALESCE(i.full_body, '') ILIKE '%marked as not interested%'
            OR COALESCE(i.full_body, '') ILIKE '%this lead has been archived%'
            OR COALESCE(i.subject, '') ILIKE '%conversation closed%'
            OR COALESCE(i.subject, '') ILIKE '%lead archived%'
            THEN 'silent_close'
          WHEN COALESCE(i.full_body, '') ILIKE '%decided on another venue%'
            OR COALESCE(i.full_body, '') ILIKE '%going with another%'
            OR COALESCE(i.full_body, '') ILIKE '%we''re going with %'
            OR COALESCE(i.full_body, '') ILIKE '%chose a different venue%'
            OR COALESCE(i.full_body, '') ILIKE '%signed with another venue%'
            OR COALESCE(i.full_body, '') ILIKE '%booked another venue%'
            THEN 'going_with_other'
          WHEN COALESCE(i.full_body, '') ILIKE '%won''t be moving forward%'
            OR COALESCE(i.full_body, '') ILIKE '%will not be moving forward%'
            OR COALESCE(i.full_body, '') ILIKE '%no longer pursuing%'
            OR COALESCE(i.full_body, '') ILIKE '%removing your venue from consideration%'
            OR COALESCE(i.full_body, '') ILIKE '%decided not to book%'
            OR COALESCE(i.full_body, '') ILIKE '%no longer in the running%'
            OR COALESCE(i.full_body, '') ILIKE '%we''re going to pass%'
            OR COALESCE(i.full_body, '') ILIKE '%we are going to pass%'
            THEN 'lead_declined'
          ELSE NULL
        END AS detected_signal
      FROM interactions i
      WHERE i.direction = 'inbound'
        AND i.wedding_id IS NOT NULL
        AND i.full_body IS NOT NULL
    ) raw
    WHERE detected_signal IS NOT NULL
  ) f
  WHERE w.id = f.wedding_id
    AND w.status IN ('inquiry', 'tour_scheduled', 'tour_completed', 'proposal_sent');

  GET DIAGNOSTICS affected_count = ROW_COUNT;
  RAISE NOTICE 'backfill: flipped % weddings to lost', affected_count;
END;
$backfill$;
