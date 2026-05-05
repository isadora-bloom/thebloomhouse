-- Migration 211: venues — subscription_status + past_due_since
--
-- Adds two columns needed for the 7-day past-due grace period in
-- require-plan.ts, and for the Stripe webhook to record when a
-- subscription first enters past_due so the grace window is stable
-- across retries.
--
-- subscription_status mirrors the Stripe subscription status string.
--   Allowed values mirror the Stripe API: active, trialing, past_due,
--   canceled, unpaid, incomplete, incomplete_expired, paused.
--   NULL = status not yet synced (treat as active for safety).
--
-- past_due_since is stamped by the webhook on the FIRST past_due event.
--   It is cleared (→ NULL) when the subscription returns to active.
--   This means we track "how long has it continuously been past_due"
--   rather than re-arming the grace window on every retry.
--
-- Idempotent. Safe to re-run.

ALTER TABLE public.venues
  ADD COLUMN IF NOT EXISTS subscription_status text
    CHECK (subscription_status IN (
      'active', 'trialing', 'past_due', 'canceled',
      'unpaid', 'incomplete', 'incomplete_expired', 'paused'
    ));

ALTER TABLE public.venues
  ADD COLUMN IF NOT EXISTS past_due_since timestamptz;

COMMENT ON COLUMN public.venues.subscription_status IS
  'Mirror of the Stripe subscription status. NULL = not yet synced (treated as active). Set by the stripe webhook handler on every customer.subscription.* event.';

COMMENT ON COLUMN public.venues.past_due_since IS
  'Timestamp of the first past_due transition for the current billing cycle. Stamped when subscription_status first becomes past_due; cleared to NULL when it returns to active or trialing. Used by require-plan.ts to enforce the 7-day grace period before downgrading access.';
