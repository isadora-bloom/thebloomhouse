-- ---------------------------------------------------------------------------
-- 271_venue_location_derivations.sql
-- ---------------------------------------------------------------------------
-- Wave 8 — external signals foundation. Layer fix not rule fix.
--
-- Anchor docs:
--   - bloom-constitution.md (forensic identity reconstruction; one source of
--     truth, derive the rest — same doctrine applied to external-signal config)
--   - bloom-wave4-identity-reconstruction.md (Wave 4 doctrine — pattern: one
--     source of truth, derive the rest)
--   - feedback_deep_fix_vs_bandaid.md (LLM-as-primitive doctrine; broader
--     principle: layer fix not rule fix. We were whack-a-moling each external
--     signal's config field; this migration unifies them.)
--
-- Why this migration exists
-- -------------------------
-- Eight distinct external signal sources (Google Trends, Weather, Holiday
-- calendar, Government / DC-shutdown, Cultural moments, Market intelligence,
-- FRED, Census) each gate on their own venue config field. Today the
-- gating fields live across the venues table:
--   * venues.google_trends_metro      — SerpAPI metro code (mig 008)
--   * venues.noaa_station_id          — NOAA CDO station ID  (mig 008)
--   * venues.state                    — calendar geo_scope, market_intel region_key, DC-proxy
--   * venues.latitude / longitude     — DC-proxy radius, future use
--   * venues.zip                      — needed for census FIPS lookup (NEW gate)
--
-- Two of those (google_trends_metro, noaa_station_id) are NOT captured by
-- /settings/venue-info, so a "fully-filled" venue still has trends + weather
-- broken silently. Census FIPS + BLS metro MSA code don't exist yet at all.
-- This migration:
--   (1) adds the missing derived columns
--   (2) creates external_signal_health for at-a-glance status per venue
--
-- Idempotent: every CREATE / ALTER uses IF NOT EXISTS or DROP-then-CREATE.
-- Safe to re-run.
-- ---------------------------------------------------------------------------

BEGIN;

-- ============================================================================
-- STEP 1 — extend venues with derived location fields
-- ============================================================================

ALTER TABLE public.venues
  ADD COLUMN IF NOT EXISTS census_fips text,
  ADD COLUMN IF NOT EXISTS metro_msa_code text,
  ADD COLUMN IF NOT EXISTS dc_region_proxy boolean,
  ADD COLUMN IF NOT EXISTS location_derived_at timestamptz,
  ADD COLUMN IF NOT EXISTS location_derivation_source jsonb;

COMMENT ON COLUMN public.venues.census_fips IS
  '11-digit county FIPS code (state+county). Derived from ZIP via the US '
  'Census Geocoder API. Gates the Census signal channel. Wave 8 / mig 271.';

COMMENT ON COLUMN public.venues.metro_msa_code IS
  'BLS Metropolitan Statistical Area code (different from google_trends_metro '
  'which is a SerpAPI-specific code). Used by future labor / employment '
  'channel readers. Wave 8 / mig 271.';

COMMENT ON COLUMN public.venues.dc_region_proxy IS
  'Derived: state IN (VA, DC, MD) OR lat/lng within 100mi of the Capitol. '
  'Persisted (rather than always-recomputed) so the writer audit shows when '
  'and how the value was set. Mirrors government.ts isDCRegionVenue logic. '
  'Wave 8 / mig 271.';

COMMENT ON COLUMN public.venues.location_derived_at IS
  'When the auto-derivation last ran (manual or sweep). NULL = never derived; '
  'derived columns are stale or hand-edited. Wave 8 / mig 271.';

COMMENT ON COLUMN public.venues.location_derivation_source IS
  'Audit jsonb: { source: "manual" | "auto_derive" | "sweep", inputs: {...}, '
  'results: {...}, errors: [...] }. Lets ops trace which fields came from '
  'which network call. Wave 8 / mig 271.';

-- ============================================================================
-- STEP 2 — external_signal_health (one row per (venue, signal))
-- ============================================================================
--
-- Status meanings:
--   * ready          — signal has all config + recent data
--   * config_missing — at least one required venue field is null
--   * data_stale     — config OK, but last_refresh_at older than threshold
--   * error          — last refresh attempt failed (last_error populated)
--   * disabled       — signal explicitly turned off for this venue (future use)
--
-- The signals (8): google_trends, weather, holiday_calendar, government,
-- cultural_moments, market_intelligence, fred, census. New signals slot in
-- by adding a row — no schema change required.

CREATE TABLE IF NOT EXISTS public.external_signal_health (
  venue_id uuid NOT NULL REFERENCES public.venues(id) ON DELETE CASCADE,
  signal_name text NOT NULL,
  status text NOT NULL CHECK (status IN (
    'ready',
    'config_missing',
    'data_stale',
    'error',
    'disabled'
  )),
  -- What's required to flip this signal to 'ready', when status='config_missing'.
  -- Free-text array so new signals don't need a migration to add new keys.
  missing_config_fields text[],
  last_refresh_at timestamptz,
  record_count integer NOT NULL DEFAULT 0,
  last_error text,
  last_checked_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (venue_id, signal_name)
);

COMMENT ON TABLE public.external_signal_health IS
  'owner:intelligence. Wave 8 external-signal foundation. One row per '
  '(venue, signal) pair. Read by /intel/external-signals dashboard, '
  'written by the health-check service + sweep cron. Migration 271.';

COMMENT ON COLUMN public.external_signal_health.signal_name IS
  'Free-text signal id. Current set: google_trends, weather, holiday_calendar, '
  'government, cultural_moments, market_intelligence, fred, census. New '
  'signals slot in by inserting a row.';

COMMENT ON COLUMN public.external_signal_health.missing_config_fields IS
  'Array of venue/config field names that need filling for status to flip '
  'to ready. e.g. {google_trends_metro} for trends, {noaa_station_id, '
  'latitude} for weather. Empty/null when status != config_missing.';

CREATE INDEX IF NOT EXISTS idx_external_signal_health_venue_status
  ON public.external_signal_health (venue_id, status);

COMMENT ON INDEX public.idx_external_signal_health_venue_status IS
  'Dashboard hero query: count of ready/config_missing/error per venue.';

CREATE INDEX IF NOT EXISTS idx_external_signal_health_signal_status
  ON public.external_signal_health (signal_name, status);

COMMENT ON INDEX public.idx_external_signal_health_signal_status IS
  'Cross-venue ops view: which signals are config_missing across the fleet.';

-- ============================================================================
-- STEP 3 — RLS (mirrors venue-scoped pattern)
-- ============================================================================

ALTER TABLE public.external_signal_health ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "external_signal_health_auth_select"
  ON public.external_signal_health;
CREATE POLICY "external_signal_health_auth_select"
  ON public.external_signal_health
  FOR SELECT
  TO authenticated
  USING (
    venue_id IN (
      SELECT venue_id FROM public.user_profiles WHERE id = auth.uid()
    )
  );

DROP POLICY IF EXISTS "external_signal_health_auth_insert"
  ON public.external_signal_health;
CREATE POLICY "external_signal_health_auth_insert"
  ON public.external_signal_health
  FOR INSERT
  TO authenticated
  WITH CHECK (
    venue_id IN (
      SELECT venue_id FROM public.user_profiles WHERE id = auth.uid()
    )
  );

DROP POLICY IF EXISTS "external_signal_health_auth_update"
  ON public.external_signal_health;
CREATE POLICY "external_signal_health_auth_update"
  ON public.external_signal_health
  FOR UPDATE
  TO authenticated
  USING (
    venue_id IN (
      SELECT venue_id FROM public.user_profiles WHERE id = auth.uid()
    )
  )
  WITH CHECK (
    venue_id IN (
      SELECT venue_id FROM public.user_profiles WHERE id = auth.uid()
    )
  );

COMMIT;

NOTIFY pgrst, 'reload schema';
