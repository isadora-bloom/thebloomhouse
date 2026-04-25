-- ============================================
-- 091: add scheduling-tool values to weddings.source CHECK
--
-- Migration 086 locked weddings.source to a canonical list that
-- included 'honeybook' but missed the other three scheduling tools
-- the email-pipeline now emits:
--   - calendly (tour bookings that never came through another source)
--   - acuity   (alternative scheduling tool)
--   - dubsado  (CRM contract + payment notifications)
--
-- Without this, wedding-create calls from the scheduling-tool path
-- fail with `new row for relation "weddings" violates check
-- constraint "weddings_source_check"`. Rixey's Calendly backfill
-- surfaced this as the blocker on ~85 tour_scheduled weddings.
-- ============================================

ALTER TABLE weddings DROP CONSTRAINT IF EXISTS weddings_source_check;

ALTER TABLE weddings ADD CONSTRAINT weddings_source_check CHECK (
  source IS NULL OR source IN (
    'the_knot', 'wedding_wire', 'here_comes_the_guide', 'zola', 'honeybook',
    'calendly', 'acuity', 'dubsado',
    'google', 'google_ads', 'google_business',
    'instagram', 'facebook', 'pinterest', 'tiktok',
    'venue_calculator', 'website', 'direct', 'referral',
    'walk_in', 'csv_import', 'vendor_referral', 'other'
  )
);

NOTIFY pgrst, 'reload schema';
