-- ---------------------------------------------------------------------------
-- 263_marketing_spend.sql
-- ---------------------------------------------------------------------------
-- Wave 6A — marketing spend ingestion + persona-aware attribution overlay.
--
-- Anchor docs:
--   - bloom-constitution.md (Wave 6 closes the forensic loop: ROI per
--     persona per channel)
--   - bloom-wave4-5-6-master-plan.md (6A spec)
--   - bloom-phase-b-decisions.md (attribution_events created in Phase B,
--     mig 105 — Wave 6A extends with persona_overlay; does NOT rebuild)
--
-- Why this migration exists
-- -------------------------
-- Marketing ROI requires two new substrates:
--   1. Per-day per-campaign spend records — finer than the legacy
--      monthly aggregate `marketing_spend` table from mig 003 (which is
--      kept intact). Wave 6A's ingestion is per-day per-channel per-
--      campaign with cents granularity, multi-currency aware, and
--      tracks which connector wrote each row for audit.
--   2. Persona overlay on attribution_events — joins each first-touch
--      decision (from Phase B) to the persona_label discovered by
--      Wave 5A's couple_intel synthesizer, so 6B's rollups can answer
--      "which channel acquired this persona?"
--
-- Naming choice: this file uses `marketing_spend_records` (not
-- `marketing_spend`) to avoid colliding with the legacy monthly-
-- aggregate table from mig 003. The legacy table stays in service for
-- the existing /intel/sources monthly summaries; new fine-grained
-- ingestion lands here.
--
-- What is NOT in this migration:
--   * Live Google Ads / Meta / TikTok integrations (Wave 6A2 — needs
--     OAuth + rate limit handling, separate work).
--   * Persona × channel rollups (Wave 6B).
--   * Cron registration (added by reconciliation stream after parallel
--     waves merge — see TODO in spend-sync-sweep.ts).
--   * Modifications to attribution_events.role (Wave 7B owns).
--
-- Idempotent: every CREATE TABLE / INDEX / POLICY uses IF NOT EXISTS
-- or DROP-then-CREATE. Safe to re-run.
-- ---------------------------------------------------------------------------

BEGIN;

-- ============================================================================
-- STEP 1 — marketing_spend_records (one row per spend record)
-- ============================================================================
-- Per-day per-campaign granularity. Cents not float to avoid rounding
-- error when summing across thousands of rows. source_platform_metadata
-- stores the raw API response so a re-ingest after a connector bug fix
-- is possible without re-fetching.

CREATE TABLE IF NOT EXISTS public.marketing_spend_records (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  venue_id uuid NOT NULL REFERENCES public.venues(id) ON DELETE CASCADE,
  -- Free-text channel string. Common values: google_ads | meta_ads |
  -- tiktok_ads | theknot_fee | weddingwire_fee | organic_seo |
  -- vendor_referral | other. Free-text so UK venues (Hitched /
  -- Bridebook) and new platforms can land without a schema change.
  channel text NOT NULL,
  -- Platform-specific identifier. NULL for manual / fee entries that
  -- don't have a campaign concept (e.g. flat Knot listing fee).
  campaign_id text,
  campaign_name text,
  -- The date the spend OCCURRED, not when it was ingested. So a
  -- backfill can land 30 days of historical data and roll up correctly
  -- by spend_date.
  spend_date date NOT NULL,
  -- Always cents to avoid float math. UI converts at display time.
  amount_cents integer NOT NULL CHECK (amount_cents >= 0),
  currency text NOT NULL DEFAULT 'USD',
  -- Raw connector payload for debugging / re-ingest. Stored verbatim.
  source_platform_metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  ingested_at timestamptz NOT NULL DEFAULT now(),
  -- Free-text label of how this row landed: 'manual' |
  -- 'google_ads_connector' | 'meta_ads_connector' |
  -- 'tiktok_ads_connector' | 'theknot_manual' | 'csv_import' | etc.
  ingested_by text,
  created_at timestamptz NOT NULL DEFAULT now()
);

COMMENT ON TABLE public.marketing_spend_records IS
  'owner:intelligence. Wave 6A per-day per-campaign spend ingestion. '
  'Cents granularity (no float rounding). One row per (venue, channel, '
  'campaign_id, spend_date) — duplicate ingestion is idempotent via the '
  'unique constraint. Distinct from the legacy public.marketing_spend '
  '(mig 003) which holds monthly aggregates. Migration 263.';

COMMENT ON COLUMN public.marketing_spend_records.channel IS
  'Free-text channel identifier. Common values: google_ads | meta_ads | '
  'tiktok_ads | theknot_fee | weddingwire_fee | organic_seo | '
  'vendor_referral | other. Free-text so new platforms / regional '
  'platforms can land without migration.';

COMMENT ON COLUMN public.marketing_spend_records.spend_date IS
  'Date the spend OCCURRED. Used for ROI rollups. Distinct from '
  'ingested_at, which is when the row hit our DB.';

COMMENT ON COLUMN public.marketing_spend_records.amount_cents IS
  'Spend in cents (integer). Currency lives in `currency` column. '
  'Float math is forbidden when summing thousands of rows — use cents.';

COMMENT ON COLUMN public.marketing_spend_records.source_platform_metadata IS
  'Raw connector payload (campaign meta, impressions, clicks, etc). '
  'Stored verbatim so a re-ingest after a parser fix can rebuild '
  'rollups without re-fetching the API.';

COMMENT ON COLUMN public.marketing_spend_records.ingested_by IS
  'Free-text label of which writer landed this row. manual | '
  'google_ads_connector | meta_ads_connector | tiktok_ads_connector | '
  'theknot_manual | csv_import. Drives connector-health dashboards '
  '(when did the Google Ads connector last write a row?).';

-- Idempotent ingestion: re-running a connector for the same date /
-- campaign should NOT create duplicate rows. The unique constraint
-- enforces this; the service layer uses ON CONFLICT DO NOTHING.
-- For manual / fee entries with NULL campaign_id, COALESCE gives a
-- sentinel so the unique constraint still distinguishes channels.
CREATE UNIQUE INDEX IF NOT EXISTS uniq_marketing_spend_records_dedupe
  ON public.marketing_spend_records (
    venue_id,
    channel,
    COALESCE(campaign_id, ''),
    spend_date
  );

COMMENT ON INDEX public.uniq_marketing_spend_records_dedupe IS
  'Idempotent ingestion key. Re-running a connector for the same '
  '(venue, channel, campaign, date) is a no-op via ON CONFLICT DO '
  'NOTHING. NULL campaign_id collapses to '''' so manual fee entries '
  'still dedupe per (channel, date).';

CREATE INDEX IF NOT EXISTS idx_marketing_spend_records_venue_date
  ON public.marketing_spend_records (venue_id, spend_date DESC);

COMMENT ON INDEX public.idx_marketing_spend_records_venue_date IS
  'Hot-path: "show me last 30 days of spend for this venue", "summary '
  'for this month", "trailing 12 months trend chart".';

CREATE INDEX IF NOT EXISTS idx_marketing_spend_records_venue_channel_date
  ON public.marketing_spend_records (venue_id, channel, spend_date);

COMMENT ON INDEX public.idx_marketing_spend_records_venue_channel_date IS
  'Per-channel trend lookups: "trailing 90 days of Google Ads spend".';

-- ============================================================================
-- STEP 2 — marketing_spend_jobs (queue table for async ingestion)
-- ============================================================================
-- Mirror of identity_reconstruction_jobs (mig 260) and couple_intel_jobs
-- (mig 261). Spend-sync-sweep cron drains this queue per venue per
-- connector. For Wave 6A the connectors are stubs, so the queue mostly
-- stays empty — but the schema lands now so 6A2 can fill it without
-- another migration.

CREATE TABLE IF NOT EXISTS public.marketing_spend_jobs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  venue_id uuid NOT NULL REFERENCES public.venues(id) ON DELETE CASCADE,
  -- Which connector this job targets. Same free-text vocabulary as
  -- marketing_spend_records.channel.
  connector text NOT NULL,
  status text NOT NULL DEFAULT 'queued'
    CHECK (status IN ('queued', 'running', 'done', 'failed', 'skipped')),
  -- Free-text label of what kicked this job. 'manual_sync' |
  -- 'spend_sync_sweep_cron' | 'admin_backfill'.
  trigger_signal text,
  -- Optional payload — connector-specific (e.g. date range to fetch).
  payload jsonb DEFAULT '{}'::jsonb,
  enqueued_at timestamptz NOT NULL DEFAULT now(),
  started_at timestamptz,
  completed_at timestamptz,
  rows_ingested integer NOT NULL DEFAULT 0,
  error_text text
);

COMMENT ON TABLE public.marketing_spend_jobs IS
  'owner:intelligence. Wave 6A spend-ingestion queue. Workers drain via '
  'spend-sync-sweep cron (registration deferred to reconciliation '
  'stream — see spend-sync-sweep.ts TODO). Each job represents one '
  '(venue, connector) sync attempt. rows_ingested reports how many new '
  'spend rows landed. Migration 263.';

COMMENT ON COLUMN public.marketing_spend_jobs.connector IS
  'Which connector to run. Common values: google_ads | meta_ads | '
  'tiktok_ads | theknot_manual. Free-text so future connectors can '
  'land without migration.';

COMMENT ON COLUMN public.marketing_spend_jobs.payload IS
  'Connector-specific input. Examples: { "since": "2026-04-01", '
  '"until": "2026-04-30" } for date-range backfill.';

CREATE INDEX IF NOT EXISTS idx_marketing_spend_jobs_dequeue
  ON public.marketing_spend_jobs (status, enqueued_at)
  WHERE status = 'queued';

COMMENT ON INDEX public.idx_marketing_spend_jobs_dequeue IS
  'Worker dequeue path: ORDER BY enqueued_at WHERE status=''queued''.';

CREATE INDEX IF NOT EXISTS idx_marketing_spend_jobs_venue
  ON public.marketing_spend_jobs (venue_id, enqueued_at DESC);

COMMENT ON INDEX public.idx_marketing_spend_jobs_venue IS
  'Per-venue connector-health queries: "when did this venue last sync '
  'Google Ads?", "any failed syncs in the last 24h?"';

-- ============================================================================
-- STEP 3 — venue_config.spend_auto_sync_enabled
-- ============================================================================
-- Per-venue toggle for the daily sync cron. Defaults to false — venues
-- opt in per connector by populating their OAuth credentials elsewhere
-- (Wave 6A2). The sweep service iterates venues with this flag true.

ALTER TABLE public.venue_config
  ADD COLUMN IF NOT EXISTS spend_auto_sync_enabled boolean NOT NULL DEFAULT false;

COMMENT ON COLUMN public.venue_config.spend_auto_sync_enabled IS
  'Wave 6A. When true, the spend-sync-sweep cron will attempt to drain '
  'configured connectors for this venue. Defaults false so opting in '
  'is explicit. Wave 6A2 wires per-connector credentials.';

-- ============================================================================
-- STEP 4 — attribution_events.persona_overlay (Wave 6A extension)
-- ============================================================================
-- Snapshot of couple_intel.persona_label at the time the overlay was
-- attached, so 6B's rollup can join attribution → persona without a
-- runtime triple-join. Idempotent re-attach refreshes the snapshot.
--
-- Shape:
--   {
--     "persona_label": string,
--     "persona_confidence": int,
--     "derived_at": timestamp,
--     "couple_intel_id": uuid | null
--   }
--
-- Wave 7B owns attribution_events.role; this migration ONLY adds
-- persona_overlay. No other column touched.

ALTER TABLE public.attribution_events
  ADD COLUMN IF NOT EXISTS persona_overlay jsonb;

COMMENT ON COLUMN public.attribution_events.persona_overlay IS
  'Wave 6A. Snapshot of couple_intel.persona_label at the time the '
  'overlay was attached. Shape: { persona_label, persona_confidence, '
  'derived_at, couple_intel_id }. Lets Wave 6B''s rollup answer '
  '"which channel acquired this persona" without a runtime triple-'
  'join. Refreshed when couple_intel is re-derived. NULL until the '
  'first attach (couples without intel never get a value).';

CREATE INDEX IF NOT EXISTS idx_attribution_events_persona_overlay_label
  ON public.attribution_events ((persona_overlay->>'persona_label'))
  WHERE persona_overlay IS NOT NULL AND reverted_at IS NULL;

COMMENT ON INDEX public.idx_attribution_events_persona_overlay_label IS
  'Wave 6A. Persona × channel rollup index — speeds GROUP BY '
  'persona_overlay->>persona_label, source_platform queries. Filter '
  'on reverted_at IS NULL so reversed attributions don''t double-'
  'count.';

-- ============================================================================
-- STEP 5 — RLS (mirror couple_identity_profile pattern)
-- ============================================================================
-- Authenticated users see their own venue's rows. Service-role
-- bypasses RLS for the orchestrator + crons + admin endpoints. No
-- anon access — internal ops surface only.

ALTER TABLE public.marketing_spend_records ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "marketing_spend_records_auth_select"
  ON public.marketing_spend_records;
CREATE POLICY "marketing_spend_records_auth_select"
  ON public.marketing_spend_records
  FOR SELECT
  TO authenticated
  USING (
    venue_id IN (
      SELECT venue_id FROM public.user_profiles WHERE id = auth.uid()
    )
  );

DROP POLICY IF EXISTS "marketing_spend_records_auth_insert"
  ON public.marketing_spend_records;
CREATE POLICY "marketing_spend_records_auth_insert"
  ON public.marketing_spend_records
  FOR INSERT
  TO authenticated
  WITH CHECK (
    venue_id IN (
      SELECT venue_id FROM public.user_profiles WHERE id = auth.uid()
    )
  );

DROP POLICY IF EXISTS "marketing_spend_records_auth_update"
  ON public.marketing_spend_records;
CREATE POLICY "marketing_spend_records_auth_update"
  ON public.marketing_spend_records
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

DROP POLICY IF EXISTS "marketing_spend_records_auth_delete"
  ON public.marketing_spend_records;
CREATE POLICY "marketing_spend_records_auth_delete"
  ON public.marketing_spend_records
  FOR DELETE
  TO authenticated
  USING (
    venue_id IN (
      SELECT venue_id FROM public.user_profiles WHERE id = auth.uid()
    )
  );

ALTER TABLE public.marketing_spend_jobs ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "marketing_spend_jobs_auth_select"
  ON public.marketing_spend_jobs;
CREATE POLICY "marketing_spend_jobs_auth_select"
  ON public.marketing_spend_jobs
  FOR SELECT
  TO authenticated
  USING (
    venue_id IN (
      SELECT venue_id FROM public.user_profiles WHERE id = auth.uid()
    )
  );

DROP POLICY IF EXISTS "marketing_spend_jobs_auth_insert"
  ON public.marketing_spend_jobs;
CREATE POLICY "marketing_spend_jobs_auth_insert"
  ON public.marketing_spend_jobs
  FOR INSERT
  TO authenticated
  WITH CHECK (
    venue_id IN (
      SELECT venue_id FROM public.user_profiles WHERE id = auth.uid()
    )
  );

DROP POLICY IF EXISTS "marketing_spend_jobs_auth_update"
  ON public.marketing_spend_jobs;
CREATE POLICY "marketing_spend_jobs_auth_update"
  ON public.marketing_spend_jobs
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
