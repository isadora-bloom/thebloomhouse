-- Migration 172: crm_source provenance on weddings + interactions + tours +
-- lost_deals + people (T5-followup-Y / Pattern I closure).
--
-- Stream Y adds CRM-import adapters (HoneyBook / Dubsado / Aisle Planner /
-- generic CSV) to Day-3 of the 5-day onboarding-project flow. Coordinators
-- can drop a CRM export and bulk-create Bloom rows; downstream intel needs
-- to filter "imported from HoneyBook" vs "live pipeline" — confidence_flag
-- (migration 137) tells us _how confident_ the row is, not _which CRM_ it
-- came from. Without this column we can't build "X% of your booked
-- weddings came in via CRM import not the email pipeline" insights, and
-- post-Go-Live cleanup can't reliably target one importer's outputs.
--
-- crm_source enum (free text + CHECK):
--   - 'honeybook'        HoneyBook export
--   - 'dubsado'          Dubsado export
--   - 'aisle_planner'    Aisle Planner export
--   - 'generic_csv'      generic-csv adapter with column-mapping config
--   - 'manual_form'      coordinator hand-entered via the pricing-history
--                        single-row form (also used by future single-row
--                        wedding/lead reconstruction forms)
--   - 'manual_csv'       coordinator hand-uploaded a CSV via the
--                        pricing-history bulk path
--
-- NULL means "not imported" (pipeline-ingested, brain-dump, etc.).
-- Default NULL so existing rows continue to look "live".
--
-- Idempotent: ADD COLUMN IF NOT EXISTS / DROP+CREATE constraint.

DO $$
DECLARE
  tbl text;
BEGIN
  FOR tbl IN
    SELECT unnest(ARRAY['weddings', 'interactions', 'tours', 'lost_deals', 'people'])
  LOOP
    EXECUTE format('ALTER TABLE public.%I ADD COLUMN IF NOT EXISTS crm_source text NULL', tbl);
    EXECUTE format('ALTER TABLE public.%I DROP CONSTRAINT IF EXISTS %I',
                   tbl, tbl || '_crm_source_check');
    EXECUTE format($f$
      ALTER TABLE public.%I
        ADD CONSTRAINT %I
          CHECK (crm_source IS NULL OR crm_source IN (
            'honeybook', 'dubsado', 'aisle_planner', 'generic_csv',
            'manual_form', 'manual_csv'
          ))
    $f$, tbl, tbl || '_crm_source_check');
  END LOOP;
END
$$;

COMMENT ON COLUMN public.weddings.crm_source IS
  'Which CRM (or manual path) this row came from. NULL = pipeline-ingested. '
  'Set by src/lib/services/crm-import/* adapters + the pricing-history '
  'manual UI. Per T5-followup-Y / Pattern I closure.';

COMMENT ON COLUMN public.interactions.crm_source IS
  'See weddings.crm_source — same enum.';
COMMENT ON COLUMN public.tours.crm_source IS
  'See weddings.crm_source — same enum.';
COMMENT ON COLUMN public.lost_deals.crm_source IS
  'See weddings.crm_source — same enum.';
COMMENT ON COLUMN public.people.crm_source IS
  'See weddings.crm_source — same enum.';

CREATE INDEX IF NOT EXISTS idx_weddings_crm_source
  ON public.weddings (venue_id, crm_source)
  WHERE crm_source IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_interactions_crm_source
  ON public.interactions (venue_id, crm_source)
  WHERE crm_source IS NOT NULL;

-- pricing_history reuses an existing 'context' free-text + we add a
-- distinct provenance column. The pricing-history reconstruction UI
-- (T5-followup-Y / Pattern I) needs to mark its rows as 'manual_form'
-- or 'manual_csv' so the elasticity confound check can down-weight them
-- vs trigger-fired rows.
ALTER TABLE public.pricing_history
  ADD COLUMN IF NOT EXISTS source_provenance text NULL;

ALTER TABLE public.pricing_history
  DROP CONSTRAINT IF EXISTS pricing_history_source_provenance_check;
ALTER TABLE public.pricing_history
  ADD CONSTRAINT pricing_history_source_provenance_check
    CHECK (source_provenance IS NULL OR source_provenance IN (
      'venue_config_trigger',
      'manual_form',
      'manual_csv',
      'crm_import',
      'service_writer'
    ));

COMMENT ON COLUMN public.pricing_history.source_provenance IS
  'How this pricing-history row was created. NULL = legacy. '
  'venue_config_trigger = AFTER UPDATE trigger (migration 134). '
  'manual_form / manual_csv = pricing-history reconstruction UI. '
  'crm_import = downstream CRM adapter (future). '
  'service_writer = recordPricingChange() service helper. '
  'Per T5-followup-Y / Pattern I closure.';

-- pricing_history.confidence_flag mirrors the 137 enum so coordinators
-- can mark "I'm sure of this $4500 → $5200 change, mark high-confidence."
ALTER TABLE public.pricing_history
  ADD COLUMN IF NOT EXISTS confidence_flag text NULL;

ALTER TABLE public.pricing_history
  DROP CONSTRAINT IF EXISTS pricing_history_confidence_flag_check;
ALTER TABLE public.pricing_history
  ADD CONSTRAINT pricing_history_confidence_flag_check
    CHECK (confidence_flag IS NULL OR confidence_flag IN (
      'live', 'imported_high', 'imported_medium', 'imported_low', 'manual'
    ));

COMMENT ON COLUMN public.pricing_history.confidence_flag IS
  'See weddings.confidence_flag (migration 137). Manual coordinator '
  'reconstruction sets imported_high (they typed it themselves).';
