-- Migration 115: venue cost ceiling + autonomous-pause
--
-- Adds per-venue daily LLM-spend ceiling and the autonomous-paused
-- circuit-breaker flag the cost-ceiling cron flips when 100% is hit.
--
-- Per Playbook 21.4.3:
--   "When 80% is reached, a notify-level alert fires. When 100% is
--    reached, autonomous behavior pauses (drafts queue for coordinator
--    approval; no auto-sends; no proactive insights) until next day or
--    coordinator override."
--
-- Pricing-tier rationale (decided 2026-05-01):
--   Realistic per-venue spend on Sonnet-everywhere is ~$2/day; post-tier-
--   mapping ~$1/day. A flat $5/day ceiling = 2.5x normal Sonnet usage,
--   5x post-tier-mapping. Generous enough to absorb spike days; well
--   below the cheapest subscription tier ($150/mo). Hitting it is a
--   "wake the engineer" event, not a normal Tuesday.

ALTER TABLE venue_config
  ADD COLUMN IF NOT EXISTS daily_cost_ceiling_cents integer NOT NULL DEFAULT 500,
  ADD COLUMN IF NOT EXISTS autonomous_paused boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS autonomous_paused_reason text,
  ADD COLUMN IF NOT EXISTS autonomous_paused_at timestamptz,
  ADD COLUMN IF NOT EXISTS cost_ceiling_warned_at timestamptz;

COMMENT ON COLUMN venue_config.daily_cost_ceiling_cents IS
  'Per-venue daily LLM-spend ceiling in cents. Default 500 = $5/day. '
  'Aggregated against api_costs.cost summed for the UTC calendar day. '
  'When >=80% used, cost_ceiling_warned_at stamps + notify alert fires. '
  'When >=100% used, autonomous_paused flips true.';

COMMENT ON COLUMN venue_config.autonomous_paused IS
  'Circuit-breaker flag. When true: autonomous-sender refuses to flush '
  'auto-sends; cron-driven AI services skip; proactive insight '
  'generation pauses. Coordinator-initiated calls (NLQ, manual draft '
  'approval, Sage chat in response to a couple) still work. Reset by '
  'cost_ceiling_reset cron at next UTC midnight, or by coordinator '
  'override via /api/agent/cost-ceiling/resume.';

COMMENT ON COLUMN venue_config.autonomous_paused_reason IS
  'Free-text reason set when autonomous_paused flipped to true. '
  'Example: "daily cost ceiling reached: $5.12 of $5.00".';

CREATE INDEX IF NOT EXISTS idx_venue_config_autonomous_paused
  ON venue_config (venue_id)
  WHERE autonomous_paused = true;
