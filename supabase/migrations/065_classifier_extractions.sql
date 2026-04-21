-- ============================================================================
-- Migration 065: Persist the full classifier output
-- ============================================================================
--
-- CONTEXT
-- The router-brain classifier returns an extractedData object on every
-- email: partnerName, eventDate, guestCount, questions[], urgencyLevel,
-- sentiment, source. Today only `source` is persisted (onto weddings).
-- The rest is dropped on the floor. That means /intel/clients/[id] has
-- nothing to show beyond the wedding skeleton, and the intelligence
-- layer can't learn from questions/urgency/sentiment over time.
--
-- This migration adds a metadata jsonb column to intelligence_extractions
-- so we can persist the full classification blob per email, queryable
-- by (wedding_id, extraction_type) and indexed for the common paths.
-- The existing `value text` column is left alone for backward compat.
-- ============================================================================

ALTER TABLE public.intelligence_extractions
  ADD COLUMN IF NOT EXISTS metadata jsonb;

CREATE INDEX IF NOT EXISTS idx_intelligence_extractions_type
  ON public.intelligence_extractions(extraction_type);

CREATE INDEX IF NOT EXISTS idx_intelligence_extractions_wedding_type
  ON public.intelligence_extractions(wedding_id, extraction_type);

-- GIN on metadata so we can filter by e.g. urgencyLevel later.
CREATE INDEX IF NOT EXISTS idx_intelligence_extractions_metadata
  ON public.intelligence_extractions USING gin (metadata);

NOTIFY pgrst, 'reload schema';
