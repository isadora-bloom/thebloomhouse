-- ============================================
-- 051: SCHEMA FIXES
-- Addresses BUG-02, BUG-03, BUG-04, BUG-05, BUG-09
-- All statements are idempotent (IF NOT EXISTS / IF EXISTS).
-- ============================================

-- --------------------------------------------
-- BUG-02: venues table missing Stripe columns
--   Referenced by src/app/api/webhooks/stripe/route.ts (lines 125, 155)
--   Migration 001 only placed stripe_customer_id on `organisations`, not on `venues`.
-- --------------------------------------------
ALTER TABLE venues
  ADD COLUMN IF NOT EXISTS stripe_subscription_id text;

ALTER TABLE venues
  ADD COLUMN IF NOT EXISTS stripe_customer_id text;

-- --------------------------------------------
-- BUG-03: weather_data upsert onConflict index missing
--   Referenced by src/lib/services/weather.ts:372
--   .upsert(records, { onConflict: 'venue_id,date,source' })
-- --------------------------------------------
CREATE UNIQUE INDEX IF NOT EXISTS weather_data_venue_date_source_key
  ON weather_data(venue_id, date, source);

-- --------------------------------------------
-- BUG-04: search_trends upsert onConflict index missing
--   Referenced by src/lib/services/trends.ts:208
-- --------------------------------------------
CREATE UNIQUE INDEX IF NOT EXISTS search_trends_metro_term_week_key
  ON search_trends(metro, term, week);

-- --------------------------------------------
-- BUG-05: economic_indicators upsert onConflict index missing
--   Referenced by src/lib/services/economics.ts:124
-- --------------------------------------------
CREATE UNIQUE INDEX IF NOT EXISTS economic_indicators_name_date_key
  ON economic_indicators(indicator_name, date);

-- --------------------------------------------
-- BUG-09: user_profiles.role CHECK constraint missing 'readonly'
--   Original constraint in migration 001_shared_tables.sql:111 did not include 'readonly'.
--   NOTE: Migration 049_team_invitations.sql already applied this fix. Re-applying here
--   idempotently so the fix is explicitly recorded as part of BUG-09 and safe if 049 is
--   ever re-ordered or rolled back.
-- --------------------------------------------
ALTER TABLE user_profiles DROP CONSTRAINT IF EXISTS user_profiles_role_check;
ALTER TABLE user_profiles ADD CONSTRAINT user_profiles_role_check
  CHECK (role IN ('super_admin', 'org_admin', 'venue_manager', 'coordinator', 'couple', 'readonly'));
