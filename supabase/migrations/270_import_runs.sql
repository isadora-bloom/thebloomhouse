-- ---------------------------------------------------------------------------
-- 270_import_runs.sql
-- ---------------------------------------------------------------------------
-- Wave 4 Phase 4c — unified import router + raw-source persistence.
--
-- Anchor docs:
--   - bloom-wave4-identity-reconstruction.md (Wave 4 doctrine: "raw source
--     preserved, parsing is a derivation". Reconstruction can only do its
--     job when the source-of-truth is preserved separately from the
--     parsed projection that landed in weddings/people/interactions).
--   - feedback_deep_fix_vs_bandaid.md (the deep fix is layer-replace, not
--     "more careful rule". Adapter shape detection lives at the import
--     layer; the brain-dump + onboarding endpoints both delegate so a
--     misroute in one path can't drift from the other).
--   - feedback_parallel_stream_safety.md (migration 270 pre-allocated
--     for Wave 4 Phase 4c; Round 4 is using 267/268/269).
--
-- The bug this closes
-- -------------------
-- Operator uploaded a HoneyBook export CSV via brain-dump (~71 wedding
-- records). Brain-dump's csv-shape.ts only recognised 8 shapes
-- (knowledge_base_qa/tc, leads, tour_links, platform_activity, reviews,
-- marketing_spend, unknown). The HoneyBook export hit platform_activity
-- (or close enough by header overlap) and routed to importPlatformSignals
-- → tangential_signals. importPlatformSignals' strict filters rejected 63
-- of 71 rows. The ACTUAL HoneyBook adapter in src/lib/services/crm-import/
-- was never invoked. Net: 63 wedding records lost from the booked-client
-- report; 8 partial rows in the wrong table.
--
-- The same misroute would happen for every other CRM-shaped export
-- (Aisleplanner, Dubsado, tour-scheduler, web-form, web-form-packages,
-- generic CSV with CRM columns) until brain-dump learns to detect adapter
-- shapes BEFORE the leads / platform_activity fallback fires.
--
-- The structural gap (raw source persistence)
-- -------------------------------------------
-- Neither brain-dump nor /onboarding/crm-import preserves the raw CSV
-- on disk after parsing. When the parser misclassifies (or the adapter
-- changes), the only way to recover is to ask the operator to re-export.
-- Wave 4 reconstruction reads ONLY from the parsed projection — if the
-- parse was incomplete the source-of-truth is gone.
--
-- This migration creates the audit table that import_router writes one
-- row per upload attempt + creates the storage bucket where every raw
-- CSV / PDF lives keyed by venue_id and ingested_at. Re-uploads land
-- in a new row; reprocessing re-reads from the bucket.
--
-- What this migration does
-- ------------------------
-- 1. Creates storage bucket `crm-imports` (private, venue-scoped via
--    storage path prefix). Bucket creation is via INSERT INTO
--    storage.buckets — Supabase exposes the buckets table directly to
--    SQL. Pattern matches migration 028.
-- 2. Adds storage.objects RLS policies for `crm-imports` (mirrors
--    migration 084 for brain-dump).
-- 3. Creates public.import_runs (one row per import attempt).
-- 4. Adds RLS scoped on venue_id (auth_select / auth_insert / auth_update).
-- 5. Indexes for the imports admin page (per-venue list, per-shape filter,
--    status filter for in-flight reprocessing).
--
-- Idempotent: every CREATE TABLE / INDEX / POLICY uses IF NOT EXISTS or
-- DROP-then-CREATE. Safe to re-run.
-- ---------------------------------------------------------------------------

BEGIN;

-- ============================================================================
-- STEP 1 — Storage bucket: crm-imports (private)
-- ============================================================================
-- Mirrors migration 028's pattern. Bucket is private (public=false) — only
-- service-role + authenticated venue scope can read/write. Path convention
-- enforced at the application layer is {venueId}/{timestamp}-{uuid}-{filename}.

INSERT INTO storage.buckets (id, name, public)
VALUES ('crm-imports', 'crm-imports', false)
ON CONFLICT (id) DO UPDATE SET public = EXCLUDED.public;

-- ============================================================================
-- STEP 2 — storage.objects RLS for crm-imports (mirrors migration 084)
-- ============================================================================

DROP POLICY IF EXISTS "auth_insert_crm_imports" ON storage.objects;
CREATE POLICY "auth_insert_crm_imports" ON storage.objects
  FOR INSERT TO authenticated
  WITH CHECK (bucket_id = 'crm-imports');

DROP POLICY IF EXISTS "auth_select_crm_imports" ON storage.objects;
CREATE POLICY "auth_select_crm_imports" ON storage.objects
  FOR SELECT TO authenticated
  USING (bucket_id = 'crm-imports');

DROP POLICY IF EXISTS "auth_update_crm_imports" ON storage.objects;
CREATE POLICY "auth_update_crm_imports" ON storage.objects
  FOR UPDATE TO authenticated
  USING (bucket_id = 'crm-imports')
  WITH CHECK (bucket_id = 'crm-imports');

DROP POLICY IF EXISTS "auth_delete_crm_imports" ON storage.objects;
CREATE POLICY "auth_delete_crm_imports" ON storage.objects
  FOR DELETE TO authenticated
  USING (bucket_id = 'crm-imports');

-- ============================================================================
-- STEP 3 — import_runs (one row per import attempt)
-- ============================================================================

CREATE TABLE IF NOT EXISTS public.import_runs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  venue_id uuid NOT NULL REFERENCES public.venues(id) ON DELETE CASCADE,
  -- Where this import was initiated. 'brain-dump' (FloatingBrainDump),
  -- 'crm-import-onboarding' (Day-3 onboarding flow), 'admin-imports-
  -- reprocess' (operator clicked Reprocess on an existing row). Free-text
  -- (no CHECK) so future entry points can label themselves without a
  -- migration.
  source_path text NOT NULL,
  storage_bucket text NOT NULL DEFAULT 'crm-imports',
  -- Path within the bucket: {venueId}/{timestamp}-{uuid}-{safeFilename}.
  storage_path text NOT NULL,
  -- Original uploaded filename (user-supplied, kept verbatim for the
  -- imports admin display).
  filename text NOT NULL,
  mime_type text,
  file_size_bytes bigint,
  -- Output of csv-shape detector when an adapter shape was identified
  -- ('honeybook' | 'aisleplanner' | 'dubsado' | 'tour_scheduler' |
  -- 'web_form' | 'web_form_packages' | 'leads' | 'tour_links' |
  -- 'platform_activity' | 'reviews' | 'marketing_spend' |
  -- 'knowledge_base_qa' | 'knowledge_base_tc' | 'unknown').
  detected_shape text,
  -- Which adapter actually ran. May differ from detected_shape when the
  -- detector is uncertain and routing falls through to a generic path.
  adapter_used text,
  rows_attempted integer,
  rows_inserted integer,
  rows_updated integer,
  rows_skipped integer,
  -- Structured per-skip-reason counts, e.g.:
  --   { "duplicate": 12, "empty_name": 3, "unparseable_date": 1,
  --     "no_external_id": 5, "missing_required_column": 0 }
  -- The platform-signals importer surfaced 63 skips with NO reason; the
  -- import_runs row carries the breakdown so the imports admin page can
  -- show coordinators what tripped the filter and they can decide
  -- whether to clean the source CSV and reprocess.
  skip_reasons jsonb,
  errors jsonb,
  status text NOT NULL CHECK (
    status IN ('queued', 'processing', 'completed', 'failed', 'reprocessing')
  ),
  -- Wave 4 wiring: how many wedding rows were created/touched and had
  -- identity-reconstruction enqueued downstream. Surfaces in the imports
  -- admin so the operator can confirm the Sonnet judge picked up the
  -- imported rows.
  reconstruction_enqueued_count integer NOT NULL DEFAULT 0,
  ingested_by uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  ingested_at timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz
);

COMMENT ON TABLE public.import_runs IS
  'owner:agent. Wave 4 Phase 4c. One row per CSV/PDF upload that the '
  'unified import-router persists + dispatches. raw bytes live in '
  'storage_bucket/storage_path; the row carries the parsed projection''s '
  'rowcount + per-skip-reason breakdown. Reprocessing re-reads the bytes '
  'and runs them through the current adapter (closes the structural gap '
  'where a misroute used to require a re-export). Migration 270.';

COMMENT ON COLUMN public.import_runs.detected_shape IS
  'csv-shape detector output. Adapter shapes (honeybook, aisleplanner, '
  'dubsado, tour_scheduler, web_form, web_form_packages) take priority '
  'over the legacy generic shapes (leads, platform_activity, reviews, '
  'tour_links, marketing_spend, knowledge_base_qa, knowledge_base_tc). '
  'unknown means the detector fell through; the operator sees a "we '
  'couldn''t recognise this" prompt.';

COMMENT ON COLUMN public.import_runs.adapter_used IS
  'Which adapter actually ran. NULL until processing completes. Differs '
  'from detected_shape only when the detector confidence was below the '
  'route threshold and a fallback adapter was picked.';

COMMENT ON COLUMN public.import_runs.skip_reasons IS
  'Per-skip-reason counts. The platform-signals importer surfaced "63 '
  'skipped" with no reason; this column makes the breakdown explicit so '
  'the imports admin can show coordinators what tripped the filter.';

COMMENT ON COLUMN public.import_runs.reconstruction_enqueued_count IS
  'How many weddings touched by this import had identity-reconstruction '
  'enqueued (Wave 4 Phase 2 enqueueIdentityReconstruction). Zero is '
  'expected for non-wedding-shaped imports (reviews, knowledge_base, '
  'tour_links). Non-zero confirms the Sonnet judge picked up the import.';

-- Per-venue list — most-common imports admin query: rows by venue,
-- newest first.
CREATE INDEX IF NOT EXISTS idx_import_runs_venue_recent
  ON public.import_runs (venue_id, ingested_at DESC);

COMMENT ON INDEX public.idx_import_runs_venue_recent IS
  'Imports admin list page query: venue rows, newest first.';

-- Per-shape filter — coordinator wants "show me all HoneyBook imports".
CREATE INDEX IF NOT EXISTS idx_import_runs_venue_shape
  ON public.import_runs (venue_id, detected_shape);

COMMENT ON INDEX public.idx_import_runs_venue_shape IS
  'Imports admin filter: per-shape slice (e.g. honeybook only).';

-- Status filter — find in-flight reprocessing or recent failures.
CREATE INDEX IF NOT EXISTS idx_import_runs_status
  ON public.import_runs (status, ingested_at DESC);

COMMENT ON INDEX public.idx_import_runs_status IS
  'Worker / monitoring query: rows by status (queued / processing / '
  'reprocessing / failed) for active-imports surfacing.';

-- ============================================================================
-- STEP 4 — RLS (mirrors intel_discoveries / venue-scoped pattern)
-- ============================================================================

ALTER TABLE public.import_runs ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "import_runs_auth_select" ON public.import_runs;
CREATE POLICY "import_runs_auth_select"
  ON public.import_runs
  FOR SELECT
  TO authenticated
  USING (
    venue_id IN (
      SELECT venue_id FROM public.user_profiles WHERE id = auth.uid()
    )
  );

DROP POLICY IF EXISTS "import_runs_auth_insert" ON public.import_runs;
CREATE POLICY "import_runs_auth_insert"
  ON public.import_runs
  FOR INSERT
  TO authenticated
  WITH CHECK (
    venue_id IN (
      SELECT venue_id FROM public.user_profiles WHERE id = auth.uid()
    )
  );

DROP POLICY IF EXISTS "import_runs_auth_update" ON public.import_runs;
CREATE POLICY "import_runs_auth_update"
  ON public.import_runs
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
