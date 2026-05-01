-- Migration 137: confidence_flag columns on import-eligible tables (T2-A / B-39)
--
-- Per Playbook Part 18 / B-39: every imported row should carry a
-- confidence flag so downstream consumers can distinguish
--   - 'live' rows (real-time pipeline-ingested)
--   - 'imported_high' (CRM export with full identity + dates)
--   - 'imported_medium' (CRM export with partial identity)
--   - 'imported_low' (Gmail backfill with classifier-inferred fields)
--   - 'manual' (coordinator hand-entry)
--
-- Pre-T2-A every imported row was indistinguishable from a live row
-- — anomaly detection couldn't down-weight a backfilled spike,
-- source quality couldn't show "year-1 numbers carry low confidence
-- because most are imported," and the coordinator review queue
-- couldn't sort by confidence.
--
-- Idempotent: ADD COLUMN IF NOT EXISTS.

ALTER TABLE public.weddings
  ADD COLUMN IF NOT EXISTS confidence_flag text;

ALTER TABLE public.weddings
  DROP CONSTRAINT IF EXISTS weddings_confidence_flag_check;
ALTER TABLE public.weddings
  ADD CONSTRAINT weddings_confidence_flag_check
    CHECK (confidence_flag IS NULL OR confidence_flag IN (
      'live', 'imported_high', 'imported_medium', 'imported_low', 'manual'
    ));

ALTER TABLE public.people
  ADD COLUMN IF NOT EXISTS confidence_flag text;

ALTER TABLE public.people
  DROP CONSTRAINT IF EXISTS people_confidence_flag_check;
ALTER TABLE public.people
  ADD CONSTRAINT people_confidence_flag_check
    CHECK (confidence_flag IS NULL OR confidence_flag IN (
      'live', 'imported_high', 'imported_medium', 'imported_low', 'manual'
    ));

ALTER TABLE public.interactions
  ADD COLUMN IF NOT EXISTS confidence_flag text;

ALTER TABLE public.interactions
  DROP CONSTRAINT IF EXISTS interactions_confidence_flag_check;
ALTER TABLE public.interactions
  ADD CONSTRAINT interactions_confidence_flag_check
    CHECK (confidence_flag IS NULL OR confidence_flag IN (
      'live', 'imported_high', 'imported_medium', 'imported_low', 'manual'
    ));

ALTER TABLE public.engagement_events
  ADD COLUMN IF NOT EXISTS confidence_flag text;

ALTER TABLE public.engagement_events
  DROP CONSTRAINT IF EXISTS engagement_events_confidence_flag_check;
ALTER TABLE public.engagement_events
  ADD CONSTRAINT engagement_events_confidence_flag_check
    CHECK (confidence_flag IS NULL OR confidence_flag IN (
      'live', 'imported_high', 'imported_medium', 'imported_low', 'manual'
    ));

ALTER TABLE public.marketing_spend
  ADD COLUMN IF NOT EXISTS confidence_flag text;

ALTER TABLE public.marketing_spend
  DROP CONSTRAINT IF EXISTS marketing_spend_confidence_flag_check;
ALTER TABLE public.marketing_spend
  ADD CONSTRAINT marketing_spend_confidence_flag_check
    CHECK (confidence_flag IS NULL OR confidence_flag IN (
      'live', 'imported_high', 'imported_medium', 'imported_low', 'manual'
    ));

COMMENT ON COLUMN public.weddings.confidence_flag IS
  'Provenance + confidence: NULL=unknown/legacy, ''live'' = pipeline-'
  'ingested, ''imported_high'' = CRM export with full identity, '
  '''imported_medium'' = partial identity, ''imported_low'' = Gmail '
  'backfill with classifier-inferred fields, ''manual'' = coordinator '
  'hand-entry. Per Playbook B-39 / T2-A.';

COMMENT ON COLUMN public.people.confidence_flag IS 'See weddings.confidence_flag — same enum.';
COMMENT ON COLUMN public.interactions.confidence_flag IS 'See weddings.confidence_flag — same enum.';
COMMENT ON COLUMN public.engagement_events.confidence_flag IS 'See weddings.confidence_flag — same enum.';
COMMENT ON COLUMN public.marketing_spend.confidence_flag IS 'See weddings.confidence_flag — same enum.';

CREATE INDEX IF NOT EXISTS idx_weddings_confidence_flag
  ON public.weddings (venue_id, confidence_flag)
  WHERE confidence_flag IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_interactions_confidence_flag
  ON public.interactions (venue_id, confidence_flag)
  WHERE confidence_flag IS NOT NULL;
