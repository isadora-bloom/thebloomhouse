-- ---------------------------------------------------------------------------
-- 205_weddings_utm.sql  (Stream WWW)
-- ---------------------------------------------------------------------------
-- Background — when a wedding becomes a contract via HoneyBook (or any
-- other CRM adapter), the import overwrites `weddings.source` to e.g.
-- 'honeybook'. The ORIGINAL acquisition channel (Knot ad, Google ad,
-- WeddingWire link) gets lost from `weddings.source` because nothing
-- was capturing it on inbound form submission. Concrete shape on Rixey:
-- $9.7K of 2025 Google Ads spend → 43 attributed inquiries → 0
-- attributed bookings on the page (the Google leads booked, but their
-- `source` rolled forward to honeybook). Every other paid channel has
-- the same gap.
--
-- The fix: capture UTM parameters on every inbound form submission,
-- store them on the wedding row, and NEVER overwrite them even when
-- downstream importers (HoneyBook, Calendly, etc.) update other fields.
-- Then attribution can credit the real ad-driven channel even after
-- the HoneyBook contract lands.
--
-- All columns are NULLABLE — the whole point of UTM is "preserve when
-- present; degrade gracefully when absent." Each column carries a
-- COMMENT documenting that downstream importers MUST NOT overwrite
-- non-NULL values; the policy is enforced at the application layer
-- (crm-import/index.ts + email-pipeline.ts) since UTM data flows
-- through both inbound forms (web-form adapter) and inbound emails
-- (extracted_identity payloads).
--
-- A partial index supports `WHERE utm_source IS NOT NULL` so the
-- attribution rollups in source-quality.ts and attribution.ts that
-- filter by UTM stay fast as utm_source coverage grows.
--
-- Idempotent: ALTER ... ADD COLUMN IF NOT EXISTS + CREATE INDEX IF
-- NOT EXISTS. Safe to re-run.
-- ---------------------------------------------------------------------------

ALTER TABLE public.weddings
  ADD COLUMN IF NOT EXISTS utm_source        text,
  ADD COLUMN IF NOT EXISTS utm_medium        text,
  ADD COLUMN IF NOT EXISTS utm_campaign      text,
  ADD COLUMN IF NOT EXISTS utm_term          text,
  ADD COLUMN IF NOT EXISTS utm_content       text,
  ADD COLUMN IF NOT EXISTS utm_first_seen_at timestamptz;

COMMENT ON COLUMN public.weddings.utm_source IS
  'Stream WWW / migration 205. Captured from inbound web-form submissions and inbound-email extracted_identity. Application layer (crm-import + email-pipeline) MUST NOT overwrite a non-NULL value — preserves the original acquisition channel even after a HoneyBook contract lands.';

COMMENT ON COLUMN public.weddings.utm_medium IS
  'Stream WWW / migration 205. Captured from inbound web-form submissions and inbound-email extracted_identity. Application layer MUST NOT overwrite a non-NULL value.';

COMMENT ON COLUMN public.weddings.utm_campaign IS
  'Stream WWW / migration 205. Captured from inbound web-form submissions and inbound-email extracted_identity. Application layer MUST NOT overwrite a non-NULL value.';

COMMENT ON COLUMN public.weddings.utm_term IS
  'Stream WWW / migration 205. Captured from inbound web-form submissions and inbound-email extracted_identity. Application layer MUST NOT overwrite a non-NULL value.';

COMMENT ON COLUMN public.weddings.utm_content IS
  'Stream WWW / migration 205. Captured from inbound web-form submissions and inbound-email extracted_identity. Application layer MUST NOT overwrite a non-NULL value.';

COMMENT ON COLUMN public.weddings.utm_first_seen_at IS
  'Stream WWW / migration 205. Stamped exactly once on the FIRST UTM stamp (when utm_source flipped from NULL → non-NULL). Subsequent submissions that re-send the same UTM do NOT refresh this timestamp — keeping it stable as the "earliest UTM signal observed" anchor for attribution windowing.';

-- ---------------------------------------------------------------------------
-- Partial index supporting attribution queries that filter by UTM. Most
-- weddings won't have UTM populated at all (especially the legacy backfill
-- cohort), so an unconditional index would be mostly NULLs. Partial
-- WHERE utm_source IS NOT NULL keeps the index small + cache-warm for
-- the queries that need it.
-- ---------------------------------------------------------------------------

CREATE INDEX IF NOT EXISTS idx_weddings_utm_source
  ON public.weddings (venue_id, utm_source)
  WHERE utm_source IS NOT NULL;

COMMENT ON INDEX public.idx_weddings_utm_source IS
  'Stream WWW / migration 205. Per-venue index over UTM-stamped weddings, supporting the attribution rollups in source-quality.ts + attribution.ts that filter by utm_source. Partial (WHERE utm_source IS NOT NULL) so the index stays small while UTM coverage ramps up.';

NOTIFY pgrst, 'reload schema';
