-- ---------------------------------------------------------------------------
-- 168_voice_dna_columns.sql
-- ---------------------------------------------------------------------------
-- T5-θ.3 — Voice DNA Gmail-backfill seed path.
--
-- The Day-4 onboarding step extracts greetings, signoffs, and pet phrases
-- from the coordinator's actual Gmail backfill (sent outbound interactions
-- before Sage went live) and writes them as voice anchors. Per migration
-- 137 / B-39 we need to tag every imported row with a confidence_flag so
-- downstream surfaces can distinguish backfill-derived rows from
-- coordinator-typed ones.
--
-- The three target tables (voice_preferences, phrase_usage, review_language)
-- predate the confidence_flag convention. We retrofit the column here
-- using the same enum as migration 137.
--
-- We also relax phrase_usage.contact_email NOT NULL → NULL because the
-- voice-dna service writes per-phrase aggregate frequency rows that aren't
-- tied to a specific contact (the legacy use case is per-(venue,contact_email)
-- anti-dupe tracking; these new rows are venue-scope phrase frequency).
-- The phrase-selector reader in src/lib/ai/phrase-selector.ts always
-- filters by .eq('contact_email', contactEmail.toLowerCase()) so it will
-- never see the new rows by accident — the relaxation is safe.
--
-- Idempotent: ADD COLUMN IF NOT EXISTS, ALTER COLUMN DROP NOT NULL guarded
-- by a DO block.

-- voice_preferences -----------------------------------------------------------
ALTER TABLE public.voice_preferences
  ADD COLUMN IF NOT EXISTS confidence_flag text;

ALTER TABLE public.voice_preferences
  DROP CONSTRAINT IF EXISTS voice_preferences_confidence_flag_check;
ALTER TABLE public.voice_preferences
  ADD CONSTRAINT voice_preferences_confidence_flag_check
    CHECK (confidence_flag IS NULL OR confidence_flag IN (
      'live', 'imported_high', 'imported_medium', 'imported_low', 'manual'
    ));

COMMENT ON COLUMN public.voice_preferences.confidence_flag IS
  'Provenance + confidence: NULL=unknown/legacy, ''live'' = pipeline-'
  'ingested (training game / draft feedback), ''imported_high'' = '
  'extracted from coordinator-written Gmail backfill (T5-θ.3), '
  '''manual'' = coordinator typed directly. Same enum as weddings.confidence_flag '
  '(migration 137).';

CREATE INDEX IF NOT EXISTS idx_voice_preferences_confidence_flag
  ON public.voice_preferences (venue_id, confidence_flag)
  WHERE confidence_flag IS NOT NULL;

-- phrase_usage ----------------------------------------------------------------
ALTER TABLE public.phrase_usage
  ADD COLUMN IF NOT EXISTS confidence_flag text;

ALTER TABLE public.phrase_usage
  DROP CONSTRAINT IF EXISTS phrase_usage_confidence_flag_check;
ALTER TABLE public.phrase_usage
  ADD CONSTRAINT phrase_usage_confidence_flag_check
    CHECK (confidence_flag IS NULL OR confidence_flag IN (
      'live', 'imported_high', 'imported_medium', 'imported_low', 'manual'
    ));

COMMENT ON COLUMN public.phrase_usage.confidence_flag IS
  'Same enum as weddings.confidence_flag (migration 137). NULL for the '
  'legacy per-(venue, contact_email) anti-dupe writers; ''imported_high'' '
  'for backfill-derived per-venue frequency rows from T5-θ.3.';

-- Relax contact_email NOT NULL so the voice-dna backfill can insert
-- aggregate per-venue rows without inventing a fake email. Pre-existing
-- readers always filter by contact_email so the new NULL rows are
-- invisible to the legacy code path.
DO $$
BEGIN
  IF EXISTS (
    SELECT 1
      FROM information_schema.columns
     WHERE table_schema = 'public'
       AND table_name = 'phrase_usage'
       AND column_name = 'contact_email'
       AND is_nullable = 'NO'
  ) THEN
    ALTER TABLE public.phrase_usage
      ALTER COLUMN contact_email DROP NOT NULL;
  END IF;
END$$;

CREATE INDEX IF NOT EXISTS idx_phrase_usage_confidence_flag
  ON public.phrase_usage (venue_id, confidence_flag)
  WHERE confidence_flag IS NOT NULL;

-- review_language -------------------------------------------------------------
ALTER TABLE public.review_language
  ADD COLUMN IF NOT EXISTS confidence_flag text;

ALTER TABLE public.review_language
  DROP CONSTRAINT IF EXISTS review_language_confidence_flag_check;
ALTER TABLE public.review_language
  ADD CONSTRAINT review_language_confidence_flag_check
    CHECK (confidence_flag IS NULL OR confidence_flag IN (
      'live', 'imported_high', 'imported_medium', 'imported_low', 'manual'
    ));

COMMENT ON COLUMN public.review_language.confidence_flag IS
  'Same enum as weddings.confidence_flag (migration 137). Backfill-derived '
  'phrases extracted from coordinator-written outbound emails carry '
  '''imported_high''.';

CREATE INDEX IF NOT EXISTS idx_review_language_confidence_flag
  ON public.review_language (venue_id, confidence_flag)
  WHERE confidence_flag IS NOT NULL;

NOTIFY pgrst, 'reload schema';
