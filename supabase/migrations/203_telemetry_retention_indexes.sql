-- Migration 203 — Stream PPP (2026-05-03).
-- Telemetry-retention range-scan indexes (#96 / Pattern-I closure).
--
-- Background
-- ----------
-- src/lib/services/telemetry-retention.ts (registered as cron job
-- 'prune_telemetry' at 02:00 UTC) DELETEs rows from four telemetry
-- tables on a per-table TTL:
--
--   - api_costs           90d   filter: created_at < cutoff
--   - cron_runs           30d   filter: started_at < cutoff
--   - metered_events      90d   filter: observed_at < cutoff
--   - lead_score_history  365d  filter: calculated_at < cutoff
--
-- Of those, only the legacy composite indexes from migration 151
-- (cron_runs and metered_events) lead with the timestamp-paired column —
-- not the range-scan column. api_costs and lead_score_history have NO
-- index on their respective timestamp at all (per migrations 002 + 117 +
-- 127 + 128 — every prior api_costs index is on venue_id / service /
-- prompt_version / correlation_id / content_tier; lead_score_history is
-- only indexed on venue_id and wedding_id).
--
-- Without a leading-timestamp index the nightly DELETE has to seq-scan
-- the entire table to evaluate `< cutoff`. On a healthy production venue
-- api_costs grows by ~5k rows / day; without the index the prune does a
-- full-table scan every night and lock-holds api_costs writers (the AI
-- client logs every brain call here on the request hot path).
--
-- This migration adds CREATE INDEX IF NOT EXISTS for each table on the
-- prune-predicate column. Idempotent — safe to re-run.
--
-- Skipped: phrase_usage and interactions are NEVER pruned by the
-- telemetry sweeper (forensic record + voice training signal), so they
-- get no created_at index from this migration. Their existing indexes
-- already cover the surfaces that read them.
--
-- Task 97 (booking_value trigger watch list) was already shipped in
-- migration 174_temporal_trigger_add_booking_value.sql — that migration
-- CREATE OR REPLACEd the 158/165 trigger functions and re-issued the
-- BEFORE / AFTER triggers with `UPDATE OF inquiry_date, wedding_date,
-- estimated_guests, booking_value`. Nothing to add here for #97; the
-- two tasks share migration-number scoping per the Stream PPP brief but
-- the trigger work was already on master before 203 was minted.

-- =====================================================================
-- api_costs(created_at)
-- =====================================================================
-- Uses created_at — the column the AI client + cost-ceiling all stamp
-- on insert (per migration 002). Drops in the prune predicate's leading
-- column so the DELETE is a B-tree range scan.

CREATE INDEX IF NOT EXISTS idx_api_costs_created_at
  ON public.api_costs (created_at);

COMMENT ON INDEX public.idx_api_costs_created_at IS
  'Stream PPP / migration 203. Range-scan support for the nightly '
  'telemetry-retention prune (api_costs.created_at < now()-90d). Without '
  'this index the DELETE seq-scans the table on every tick and locks '
  'out the AI-client INSERT path. Per-day write volume is high enough '
  'that the index pays for itself within a month.';

-- =====================================================================
-- cron_runs(started_at)
-- =====================================================================
-- Migration 151 created composite (cron_name, started_at DESC) and
-- (status, started_at DESC) WHERE status IN (...) — neither leads with
-- started_at, so the prune's `started_at < cutoff` predicate cannot
-- range-scan from them. This index is the prune-predicate leader.

CREATE INDEX IF NOT EXISTS idx_cron_runs_started_at
  ON public.cron_runs (started_at);

COMMENT ON INDEX public.idx_cron_runs_started_at IS
  'Stream PPP / migration 203. Range-scan support for the nightly '
  'telemetry-retention prune (cron_runs.started_at < now()-30d). The '
  '151 composite indexes lead with cron_name / status, so they cannot '
  'serve the predicate without filtering. Standalone leading-timestamp '
  'index keeps the prune cheap.';

-- =====================================================================
-- metered_events(observed_at)
-- =====================================================================
-- Same shape as cron_runs — migration 151's composite leads with
-- counter_name, not the timestamp.

CREATE INDEX IF NOT EXISTS idx_metered_events_observed_at
  ON public.metered_events (observed_at);

COMMENT ON INDEX public.idx_metered_events_observed_at IS
  'Stream PPP / migration 203. Range-scan support for the nightly '
  'telemetry-retention prune (metered_events.observed_at < now()-90d). '
  'The 151 composite (counter_name, observed_at DESC) cannot serve the '
  'predicate without filtering. Standalone index closes the gap.';

-- =====================================================================
-- lead_score_history(calculated_at)
-- =====================================================================
-- Migration 002 only indexed venue_id and wedding_id. The 365-day
-- prune predicate has no index support at all today; this is the
-- worst offender by row-count growth (every heat-mapping recompute
-- inserts a row per wedding).

CREATE INDEX IF NOT EXISTS idx_lead_score_history_calculated_at
  ON public.lead_score_history (calculated_at);

COMMENT ON INDEX public.idx_lead_score_history_calculated_at IS
  'Stream PPP / migration 203. Range-scan support for the nightly '
  'telemetry-retention prune (lead_score_history.calculated_at < '
  'now()-365d). Migration 002 only indexed venue_id + wedding_id; the '
  'prune predicate had zero index coverage before this migration and '
  'every nightly run was a full seq-scan against a table that grows by '
  'one row per wedding per heat recompute.';

NOTIFY pgrst, 'reload schema';
