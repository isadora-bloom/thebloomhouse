-- Pricing v2: capacity-gated 5-tier model.
-- Replaces 3-tier feature-gated model (starter/intelligence/enterprise).
-- Mapping: starter→solo, intelligence→growth, enterprise→enterprise.
--
-- Key model shift: every tier now gets every feature. Capacity is the only
-- differentiator. Founding member program (25-venue cap, 50% off for 24mo)
-- and pre-opening rollover (auto-flip to Solo 30 days after first paid wedding)
-- are also tracked here.

BEGIN;

-- 1. Drop the old check constraint
ALTER TABLE venues DROP CONSTRAINT IF EXISTS venues_plan_tier_check;

-- user_profiles.plan_tier may not exist in this schema (only venues +
-- organisations carry tier in migration 001). Guard the constraint drop.
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name = 'user_profiles'
      AND column_name = 'plan_tier'
  ) THEN
    EXECUTE 'ALTER TABLE user_profiles DROP CONSTRAINT IF EXISTS user_profiles_plan_tier_check';
  END IF;
END$$;

-- 2. Migrate existing tier values
UPDATE venues SET plan_tier = 'solo' WHERE plan_tier = 'starter';
UPDATE venues SET plan_tier = 'growth' WHERE plan_tier = 'intelligence';

DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name = 'user_profiles'
      AND column_name = 'plan_tier'
  ) THEN
    EXECUTE $sql$UPDATE user_profiles SET plan_tier = 'solo' WHERE plan_tier = 'starter'$sql$;
    EXECUTE $sql$UPDATE user_profiles SET plan_tier = 'growth' WHERE plan_tier = 'intelligence'$sql$;
  END IF;
END$$;

-- 3. Add the new check constraint with 5 tiers
ALTER TABLE venues ADD CONSTRAINT venues_plan_tier_check
  CHECK (plan_tier IN ('pre_opening', 'solo', 'growth', 'multi', 'enterprise'));

DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name = 'user_profiles'
      AND column_name = 'plan_tier'
  ) THEN
    EXECUTE $sql$ALTER TABLE user_profiles ADD CONSTRAINT user_profiles_plan_tier_check
      CHECK (plan_tier IN ('pre_opening', 'solo', 'growth', 'multi', 'enterprise'))$sql$;
  END IF;
END$$;

-- 4. Default changes from 'starter' to 'solo'
ALTER TABLE venues ALTER COLUMN plan_tier SET DEFAULT 'solo';

DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name = 'user_profiles'
      AND column_name = 'plan_tier'
  ) THEN
    EXECUTE $sql$ALTER TABLE user_profiles ALTER COLUMN plan_tier SET DEFAULT 'solo'$sql$;
  END IF;
END$$;

-- 5. New tracking columns for capacity caps + founding member + pre-opening rollover
ALTER TABLE venues
  ADD COLUMN IF NOT EXISTS inquiry_period_start TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS inquiry_count_this_period INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS is_founding_member BOOLEAN NOT NULL DEFAULT FALSE,
  ADD COLUMN IF NOT EXISTS founding_member_signup_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS founding_member_expires_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS pre_opening_first_paid_wedding_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS pre_opening_grace_until TIMESTAMPTZ;

COMMENT ON COLUMN venues.inquiry_period_start IS
  'Start of the current monthly billing period for inquiry-cap tracking. Resets to now() on tier upgrade or month boundary.';
COMMENT ON COLUMN venues.inquiry_count_this_period IS
  'Number of new inquiries received in the current period. Compared against tier cap. Reset by cron at period boundary.';
COMMENT ON COLUMN venues.is_founding_member IS
  'TRUE if signed up during the 25-venue Founding Member program. Locks 50% off rate for 24 months.';
COMMENT ON COLUMN venues.founding_member_expires_at IS
  '24-month expiry of founding member rate. After this, tier auto-bills at standard rate.';
COMMENT ON COLUMN venues.pre_opening_first_paid_wedding_at IS
  'When the pre-opening venue completed its first paid wedding. Triggers 30-day grace + auto-rollover to Solo.';
COMMENT ON COLUMN venues.pre_opening_grace_until IS
  'End of 30-day grace period after first paid wedding. After this, billing flips to Solo (Founding if program open, else standard).';

-- 6. Founding member counter table — single row, used to enforce the 25-venue cap atomically
CREATE TABLE IF NOT EXISTS founding_member_counter (
  id INTEGER PRIMARY KEY DEFAULT 1,
  count INTEGER NOT NULL DEFAULT 0,
  cap INTEGER NOT NULL DEFAULT 25,
  closes_at TIMESTAMPTZ NOT NULL DEFAULT '2026-12-31T23:59:59Z',
  CONSTRAINT founding_member_counter_singleton CHECK (id = 1)
);
INSERT INTO founding_member_counter (id, count, cap) VALUES (1, 0, 25)
  ON CONFLICT (id) DO NOTHING;

-- 7. Index for the inquiry-cap reset cron
CREATE INDEX IF NOT EXISTS venues_inquiry_period_start_idx
  ON venues (inquiry_period_start);

COMMIT;
