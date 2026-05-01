-- Migration 128: correlation_id columns (T1-G)
--
-- Per Playbook OPS-21.2.1: every async row should carry the
-- correlation_id of the inbound event that produced it, so a
-- coordinator debugging "what happened with this email" can pull
-- one ID and walk the full lineage:
--   interactions <- engagement_events <- drafts <- api_costs
--                                              <- notifications
--
-- Pre-migration the columns existed nowhere. This migration adds
-- correlation_id to the rows callers actually need to chase
-- (api_costs, drafts). Other tables can be added when a debugging
-- need surfaces.
--
-- Idempotent: ADD COLUMN IF NOT EXISTS.

ALTER TABLE api_costs
  ADD COLUMN IF NOT EXISTS correlation_id text;

ALTER TABLE drafts
  ADD COLUMN IF NOT EXISTS correlation_id text;

CREATE INDEX IF NOT EXISTS idx_api_costs_correlation_id
  ON api_costs (correlation_id)
  WHERE correlation_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_drafts_correlation_id
  ON drafts (correlation_id)
  WHERE correlation_id IS NOT NULL;

COMMENT ON COLUMN api_costs.correlation_id IS
  'Request-scoped uuid threaded by the structured logger '
  '(src/lib/observability/logger.ts). Lets a coordinator query '
  '"all costs incurred while processing this inbound email" with '
  'a single ID. Per Playbook OPS-21.2.1 / T1-G.';

COMMENT ON COLUMN drafts.correlation_id IS
  'Request-scoped uuid that ties this draft back to the inbound '
  'event that produced it (interaction id, gmail message id) via '
  'the same correlation thread. Per BUILD-PLAN T1-G.';
