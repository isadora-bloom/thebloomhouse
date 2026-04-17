-- ============================================
-- 054: STRIPE WEBHOOK EVENT IDEMPOTENCY
-- Tracks Stripe event IDs we've already processed so webhook retries
-- don't double-apply side effects (e.g. plan upgrades, emails).
-- ============================================

CREATE TABLE IF NOT EXISTS stripe_events (
  id text PRIMARY KEY,              -- Stripe event id, e.g. evt_1P...
  type text NOT NULL,               -- e.g. customer.subscription.created
  received_at timestamptz NOT NULL DEFAULT now(),
  payload jsonb                     -- full event for debugging
);
COMMENT ON TABLE stripe_events IS 'owner:platform — webhook idempotency ledger';

CREATE INDEX IF NOT EXISTS stripe_events_type_idx ON stripe_events(type);
CREATE INDEX IF NOT EXISTS stripe_events_received_at_idx ON stripe_events(received_at DESC);
