-- Migration 395: venues — trial_ends_at
--
-- W18 (Nov-plan wave 2) closes the "billing is decorative" gap from the
-- 2026-09-08 readiness audit: venues.plan_tier defaults to 'solo' (migration
-- 215) with no time limit and no record of when a venue's evaluation period
-- started, so a coordinator who never enters a card gets the $299/mo Solo
-- tier free, forever, indistinguishable from a paying customer. Pricing v2
-- has no free tier (see require-plan.ts) — this was a real revenue hole,
-- not a display quirk.
--
-- trial_ends_at is the timestamp a venue's platform trial (distinct from a
-- Stripe-side "trialing" subscription status, which only exists once a card
-- is on file) runs out. A venue is "on trial" in the app-layer sense used
-- by src/lib/services/billing/billing-state.ts when it has never had a
-- Stripe subscription (stripe_subscription_id IS NULL); trial_ends_at is
-- the deadline for that state, not a feature gate by itself.
--
-- Default: 14 days from row creation. No trial-length doctrine exists yet
-- in docs/pricing-policy.md; 14 days is a conventional SaaS default and is
-- centralised as TRIAL_LENGTH_DAYS in billing-state.ts so it can be tuned
-- without another migration.
--
-- Idempotent. Safe to re-run. No BEGIN/COMMIT (per migration convention).

ALTER TABLE public.venues
  ADD COLUMN IF NOT EXISTS trial_ends_at timestamptz;

ALTER TABLE public.venues
  ALTER COLUMN trial_ends_at SET DEFAULT (now() + interval '14 days');

COMMENT ON COLUMN public.venues.trial_ends_at IS
  'Deadline for the venue''s no-subscription platform trial. Set at row creation (DB default = created_at + 14 days). A venue is only "on trial" in the app sense when stripe_subscription_id IS NULL; once a Stripe subscription lands, trial_ends_at is historical and ignored by billing-state.ts. Past this timestamp with no subscription: trial_banner shows on every platform page and auto-send is forced off (checkAutoSendEligible), per src/lib/services/billing/billing-state.ts. Nothing else is blocked.';

-- Backfill existing rows created before this column existed. Every venue
-- that predates this migration was created under the old (missing) trial
-- clock, so its trial window is computed from its actual created_at rather
-- than starting fresh from today (which would silently grant every
-- existing never-subscribed venue another 14 free days at deploy time).
-- Guarded by trial_ends_at IS NULL so re-running this migration is a no-op
-- the second time.
UPDATE public.venues
   SET trial_ends_at = created_at + interval '14 days'
 WHERE trial_ends_at IS NULL;
