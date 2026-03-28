-- ============================================
-- 012: Add 'rule' to voice_preferences preference_type
-- Allows storing venue rules (always/never/when-then) alongside
-- banned phrases, approved phrases, and voice dimensions.
-- ============================================

ALTER TABLE voice_preferences
  DROP CONSTRAINT voice_preferences_preference_type_check;

ALTER TABLE voice_preferences
  ADD CONSTRAINT voice_preferences_preference_type_check
  CHECK (preference_type IN ('banned_phrase', 'approved_phrase', 'dimension', 'rule'));
