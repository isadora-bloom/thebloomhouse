-- ============================================
-- 092: venue_config.outdoor_ideal_temp_min / max
--
-- The outdoor-event scoring on /intel/market-pulse hardcoded an
-- "ideal temperature range" of 65-78°F. That's reasonable for an
-- average US outdoor wedding venue, but it's wrong for:
--   - Beach venues (FL, CA): comfortable up to 85°F+
--   - Mountain venues (CO, MT): cool side starts well below 65°F
--   - Desert venues (AZ, NV): late-fall + spring shoulder months
--
-- Making the range venue-configurable lets each venue's "best month
-- for outdoor events" reflect their actual climate sweet spot. The
-- 65/78 defaults preserve current behaviour for venues that don't
-- override.
-- ============================================

ALTER TABLE venue_config
  ADD COLUMN IF NOT EXISTS outdoor_ideal_temp_min integer NOT NULL DEFAULT 65,
  ADD COLUMN IF NOT EXISTS outdoor_ideal_temp_max integer NOT NULL DEFAULT 78;
