-- ---------------------------------------------------------------------------
-- 350_identity_first_tracer_queue.sql
-- ---------------------------------------------------------------------------
-- Auto-trigger support for the Backwards Tracer. Anchor:
-- IDENTITY-FIRST-ARCHITECTURE.md §4 ("Tracer runs as a Vercel
-- cron-triggered background job ... and on-demand whenever a new
-- data source is connected").
--
-- Until now the Tracer was operator-initiated only (the "Run now"
-- button on /admin/tracer-runs). That left a seam: after an import,
-- nothing reconstructed the couples graph until a human clicked.
--
-- This migration adds the queue marker. When an import finishes
-- (HoneyBook / Knot CSV via brain-dump, Gmail backfill) the importer
-- stamps `identity_tracer_requested_at`. A cron drain (piggybacked on
-- the existing */5 identity_judge_sweep job) picks up venues with a
-- non-null marker, runs the Tracer, and clears the marker when the
-- run reaches a terminal state (validate-succeeded or
-- cold_start_needed). A failed run leaves the marker set so the next
-- drain tick retries.
--
-- One column, not a queue table: a venue has at most one pending
-- Tracer run at a time (the Tracer sweeps all of a venue's data in
-- one pass), so a timestamp column on venues is the whole queue.
--
-- Rerun safety: ADD COLUMN IF NOT EXISTS + CREATE INDEX IF NOT EXISTS.
-- ---------------------------------------------------------------------------

ALTER TABLE public.venues
  ADD COLUMN IF NOT EXISTS identity_tracer_requested_at timestamptz;

COMMENT ON COLUMN public.venues.identity_tracer_requested_at IS
  'Set by importers when a venue needs a Backwards Tracer run. The */5 '
  'cron drain picks up non-null markers, runs the Tracer, and clears '
  'this on terminal success. NULL = no pending run. '
  'See IDENTITY-FIRST-ARCHITECTURE.md §4.';

-- Partial index — the drain only ever queries WHERE the marker is set,
-- which is a tiny slice of the venues table.
CREATE INDEX IF NOT EXISTS ix_venues_tracer_requested
  ON public.venues (identity_tracer_requested_at)
  WHERE identity_tracer_requested_at IS NOT NULL;
