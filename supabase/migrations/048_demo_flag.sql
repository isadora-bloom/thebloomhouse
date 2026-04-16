-- ============================================
-- 048: DEMO FLAG + ONBOARDING COMPLETED
-- Marks demo venues/orgs so real signups never
-- get linked to demo data. Adds onboarding_completed
-- flag to venue_config for redirect logic.
-- ============================================

-- Add is_demo flag to venues
ALTER TABLE venues ADD COLUMN IF NOT EXISTS is_demo boolean DEFAULT false;

-- Mark the 4 demo venues
UPDATE venues SET is_demo = true WHERE id IN (
  '22222222-2222-2222-2222-222222222201',
  '22222222-2222-2222-2222-222222222202',
  '22222222-2222-2222-2222-222222222203',
  '22222222-2222-2222-2222-222222222204'
);

-- Also mark the demo org
ALTER TABLE organisations ADD COLUMN IF NOT EXISTS is_demo boolean DEFAULT false;
UPDATE organisations SET is_demo = true WHERE name = 'The Crestwood Collection';

-- Add onboarding_completed to venue_config
ALTER TABLE venue_config ADD COLUMN IF NOT EXISTS onboarding_completed boolean DEFAULT false;

-- Mark demo venues as onboarding completed (they don't need onboarding)
UPDATE venue_config SET onboarding_completed = true WHERE venue_id IN (
  '22222222-2222-2222-2222-222222222201',
  '22222222-2222-2222-2222-222222222202',
  '22222222-2222-2222-2222-222222222203',
  '22222222-2222-2222-2222-222222222204'
);
