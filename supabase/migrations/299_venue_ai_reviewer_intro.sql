-- ---------------------------------------------------------------------------
-- 299_venue_ai_reviewer_intro.sql  (live-customer fix 2026-05-11)
-- ---------------------------------------------------------------------------
-- Adds `venue_ai_config.reviewer_intro` — a short operator-authored phrase
-- the disclosure footer renders so the email reads warm + accountable
-- instead of clinical. For Rixey Isadora would set:
--   "Based on Isadora's thinking. She double-checks the important details
--    before anything goes out."
--
-- When NULL the footer falls back to a safe generic line so unconfigured
-- venues still ship a valid disclosure.
-- ---------------------------------------------------------------------------

ALTER TABLE venue_ai_config
  ADD COLUMN IF NOT EXISTS reviewer_intro TEXT;

COMMENT ON COLUMN venue_ai_config.reviewer_intro IS
  'Operator-authored short phrase rendered in the Sage disclosure footer ("Based on Isadora''s thinking. She double-checks the important details."). NULL falls back to "Reviewed by the team before anything important goes out."';

NOTIFY pgrst, 'reload schema';
