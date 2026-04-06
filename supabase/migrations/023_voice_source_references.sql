-- ============================================
-- 023: VOICE PREFERENCES — SOURCE REFERENCES
-- Links voice training rules to their source material
-- (reviews, testimonials, past conversations)
-- ============================================

ALTER TABLE voice_preferences
  ADD COLUMN IF NOT EXISTS source_type text CHECK (source_type IN ('review', 'testimonial', 'conversation', 'manual', 'training_game')),
  ADD COLUMN IF NOT EXISTS source_reference text,
  ADD COLUMN IF NOT EXISTS source_url text;

COMMENT ON COLUMN voice_preferences.source_type IS 'Where this rule/preference came from';
COMMENT ON COLUMN voice_preferences.source_reference IS 'Human-readable source description (e.g., "The Knot review, March 2026")';
COMMENT ON COLUMN voice_preferences.source_url IS 'Direct link to the source material if available';
