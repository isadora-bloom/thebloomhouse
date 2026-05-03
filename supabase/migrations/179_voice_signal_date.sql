-- ---------------------------------------------------------------------------
-- 179_voice_signal_date.sql  (T5-Rixey-LL)
-- ---------------------------------------------------------------------------
-- Adds `signal_date timestamptz` to voice_preferences and
-- voice_training_responses so post-import voice analytics window on
-- the underlying email's occurred_at, not the import date.
--
-- Why this matters:
--   When a venue imports 12 months of historical Gmail on Day 0, the
--   voice-DNA backfill writes voice_preferences rows with
--   created_at = now(). The "Sage learned this week" tracker (which
--   counts rows with created_at >= 7 days ago) then falsely reports
--   "Sage is waiting for voice training activity" — because every
--   imported preference shares the same import day, and that day is
--   not "this week" by the time the coordinator checks the panel.
--
--   The fix is to thread the underlying email's occurred_at into a
--   new signal_date column. Backfill-derived voice signals get
--   signal_date = interactions.occurred_at (real signal time).
--   Live coordinator-typed signals (training games, draft approvals)
--   get signal_date = created_at (the action IS the signal).
--
-- Doctrine sister: src/lib/services/date-windows.ts maps
--   voice_preferences        → signal_date
--   voice_training_responses → signal_date
-- so coordinator-facing windowing automatically uses the correct
-- column.
--
-- Defaults: signal_date defaults to NOW() so any code that doesn't
-- explicitly set the column still produces a sensible row (live signal
-- case). The voice-DNA backfill writer in src/lib/services/voice-dna-
-- extract.ts is responsible for setting signal_date to the underlying
-- email's occurred_at on imported rows.
--
-- Backfill: existing rows get signal_date = created_at (one-time UPDATE
-- below). Pre-existing imported_high rows whose underlying email
-- occurred_at is recoverable can be re-stamped via the voice-DNA
-- overwrite path (extractVoiceDnaFromBackfill with overwrite=true).
-- ---------------------------------------------------------------------------

ALTER TABLE voice_preferences
  ADD COLUMN IF NOT EXISTS signal_date timestamptz NOT NULL DEFAULT NOW();

ALTER TABLE voice_training_responses
  ADD COLUMN IF NOT EXISTS signal_date timestamptz NOT NULL DEFAULT NOW();

-- One-time backfill: existing rows get signal_date = created_at so the
-- new column starts populated for everything. Future writes either
-- accept the NOW() default (live signals) or set signal_date
-- explicitly (backfill writers).
UPDATE voice_preferences
   SET signal_date = created_at
 WHERE signal_date IS NULL OR signal_date >= NOW() - interval '1 minute';

UPDATE voice_training_responses
   SET signal_date = created_at
 WHERE signal_date IS NULL OR signal_date >= NOW() - interval '1 minute';

-- Coordinator-facing reads window by signal_date — index it.
CREATE INDEX IF NOT EXISTS idx_voice_preferences_venue_signal_date
  ON voice_preferences (venue_id, signal_date DESC);

CREATE INDEX IF NOT EXISTS idx_voice_training_responses_signal_date
  ON voice_training_responses (signal_date DESC);

COMMENT ON COLUMN voice_preferences.signal_date IS
  'When the underlying voice signal occurred. For backfill-derived rows this is interactions.occurred_at; for live coordinator actions this is created_at. Coordinator-facing analytics MUST window on signal_date — see src/lib/services/date-windows.ts.';

COMMENT ON COLUMN voice_training_responses.signal_date IS
  'When the underlying training response occurred (live = created_at; backfill = source signal time). Coordinator-facing analytics window on signal_date.';
