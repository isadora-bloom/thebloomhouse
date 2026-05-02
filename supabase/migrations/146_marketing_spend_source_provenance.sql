-- Migration 146: marketing_spend.source_provenance — track HOW each
-- row got there (manual coordinator entry, CSV import, brain-dump
-- text extraction, integrated provider sync). Per Playbook
-- LIMB-16.2.4-C ("spend records have source field 'manual_entry'
-- or 'integrated:<provider>'") — without provenance, downstream
-- intel can't distinguish trustworthy first-party data from
-- LLM-extracted-from-prose figures, and audit trails are
-- incomplete.
--
-- CHECK enum values:
--   - 'manual_entry'        coordinator filled the form
--   - 'csv_import'          parsed from a CSV upload
--   - 'brain_dump_text'     extracted by AI from coordinator note
--   - 'screenshot_ocr'      vision pipeline (future)
--   - 'integrated_meta'     Meta Ads API
--   - 'integrated_google'   Google Ads API
--   - 'integrated_knot'     The Knot platform billing
--   - 'integrated_ww'       WeddingWire platform billing
--   - 'integrated_other'    other provider sync
--
-- Default 'manual_entry' so existing rows backfill cleanly without
-- claiming a provenance they didn't have. New writers MUST set the
-- column explicitly.
--
-- Idempotent.

ALTER TABLE public.marketing_spend
  ADD COLUMN IF NOT EXISTS source_provenance text NOT NULL DEFAULT 'manual_entry';

ALTER TABLE public.marketing_spend
  DROP CONSTRAINT IF EXISTS marketing_spend_source_provenance_check;
ALTER TABLE public.marketing_spend
  ADD CONSTRAINT marketing_spend_source_provenance_check
    CHECK (source_provenance IN (
      'manual_entry',
      'csv_import',
      'brain_dump_text',
      'screenshot_ocr',
      'integrated_meta',
      'integrated_google',
      'integrated_knot',
      'integrated_ww',
      'integrated_other'
    ));

COMMENT ON COLUMN public.marketing_spend.source_provenance IS
  'How this row was created. manual_entry / csv_import / brain_dump_text / '
  'screenshot_ocr / integrated_<provider>. Drives data-quality '
  'weighting in source-attribution + pricing-elasticity confound '
  'detection (LLM-extracted figures get lower weight). Per Playbook '
  'LIMB-16.2.4-C.';

CREATE INDEX IF NOT EXISTS idx_marketing_spend_source_provenance
  ON public.marketing_spend (venue_id, source_provenance);
