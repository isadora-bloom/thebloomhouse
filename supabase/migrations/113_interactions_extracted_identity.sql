-- ---------------------------------------------------------------------------
-- 113_interactions_extracted_identity.sql
-- ---------------------------------------------------------------------------
-- Universal body-identity extraction (2026-04-30). Every inbound email
-- is now body-scanned for prospect identity (emails, phones, names,
-- date hints) regardless of whether a platform-specific parser
-- (Calendly, Knot, WW, Zola, calculator) matched. The result is
-- persisted here so:
--
--   1. Coordinator UIs can render extracted signals without re-parsing
--   2. Retroactive person/wedding linkage scripts have a reliable
--      identity payload to match against
--   3. Future parsers can train on signal frequency / quality
--
-- Schema is a free-form jsonb so we don't need a migration every time
-- we extract a new field type. Documented shape lives in
-- src/lib/services/body-identity-extract.ts.
-- ---------------------------------------------------------------------------

ALTER TABLE public.interactions
  ADD COLUMN IF NOT EXISTS extracted_identity jsonb;

COMMENT ON COLUMN public.interactions.extracted_identity IS
  'Body-scan output from src/lib/services/body-identity-extract.ts. Shape: { emails: string[], phones: string[], names: string[], date_hints: string[], guest_count_hint: string|null, primary_email: string|null }. Populated on every email; null only on rows older than the 2026-04-30 universal-extractor rollout.';

-- Index for the common "find interactions with this extracted email"
-- query — used by retroactive linkage scripts.
CREATE INDEX IF NOT EXISTS idx_interactions_extracted_primary_email
  ON public.interactions ((extracted_identity->>'primary_email'))
  WHERE extracted_identity IS NOT NULL;

NOTIFY pgrst, 'reload schema';
