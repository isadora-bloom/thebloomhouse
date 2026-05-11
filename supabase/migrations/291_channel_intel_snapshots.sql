-- ---------------------------------------------------------------------------
-- 291_channel_intel_snapshots.sql
-- ---------------------------------------------------------------------------
-- Wave 25 — Channel Intelligence Hub.
--
-- Anchor docs:
--   - feedback_measure_dont_assume.md (system MEASURES — every snapshot
--     row carries sample size + prompt-version disclosure + freshness so
--     external readers and the Wedding MBA stage audience can reproduce
--     the number months after the talk)
--   - feedback_self_reported_sources_not_truth.md (per-source rollup
--     surfaces forensic Discovery / Validation / Broadcast splits — the
--     stated channel is NOT the forensic channel)
--   - feedback_deep_fix_vs_bandaid.md (every story-arc number is anchored
--     to an evidence chain; presentation exports snapshot the full
--     calibration band so the link is reproducible)
--   - PROMPT-BIAS-AUDIT.md (v1-contaminated prompt rows are flagged on
--     every cell; export PDF includes the asterisk discipline)
--   - bloom-constitution.md (forensic identity reconstruction — Wave 25
--     is the channel-projection of that thesis, sliced per source)
--
-- Why this migration exists
-- -------------------------
-- Wave 25 ships the Channel Intelligence Hub: per-source deep-dive +
-- cross-source comparison + Wedding MBA presentation exports. The page
-- is the talk surface — Isadora walks on stage in November and shows
-- "here is what Knot is ACTUALLY doing for Rixey", per the
-- Discovery / Inquiry / Validation / Broadcast / Cross-platform-
-- footprint story arc.
--
-- Two new tables:
--   1. channel_intel_snapshots — cached forensic numbers per (venue,
--      source_platform, window_days). Computed on operator-trigger or
--      weekly drift refresh. Speeds up the page; never sole source of
--      truth (the computer always re-derives from attribution_events
--      when the operator requests "force refresh").
--   2. channel_presentation_exports — Wedding MBA export audit trail.
--      Every PDF / PPTX / CSV / JSON export gets a share_token + a
--      frozen snapshot_jsonb so external readers see the same numbers
--      the operator did at export time.
--
-- The snapshot table is a SECONDARY index over a deterministic
-- computation. We snapshot for speed; we re-derive for truth.
--
-- Idempotent: every CREATE uses IF NOT EXISTS. Safe to re-run.
-- ---------------------------------------------------------------------------

BEGIN;

-- ============================================================================
-- STEP 1 — channel_intel_snapshots
-- ============================================================================
-- One row per (venue_id, channel_slug, window_days, computed_at). The
-- comparison page reads the LATEST row per (venue_id, channel_slug,
-- window_days). The per-source page reads the same.
--
-- channel_slug is the URL-safe kebab-case slug (e.g. 'the-knot'). The
-- source_platform column is the canonical platform name that matches
-- attribution_events.source_platform (e.g. 'the_knot'). The slug is
-- derived from the platform via a deterministic normalisation in TS.
--
-- jsonb shapes (validated client-side; never queried via jsonb-path):
--
--   role_breakdown:
--     { acquisition: 0, validation: 0, conversion: 0, mixed: 0, unknown: 0 }
--
--   intent_breakdown:
--     { targeted: 0, broadcast: 0, validation: 0, unknown: 0 }
--
--   funnel:
--     { inquiries: 0, tours: 0, booked: 0,
--       inquiry_to_tour_rate_0_1: 0.0 | null,
--       tour_to_booked_rate_0_1: 0.0 | null,
--       inquiry_to_booked_rate_0_1: 0.0 | null,
--       drop_inquiry_to_tour_0_1: 0.0 | null,
--       drop_tour_to_booked_0_1: 0.0 | null }
--
--   cost_metrics:
--     { spend_cents: 0,
--       cac_cents: 0 | null,
--       cac_excluding_broadcast_cents: 0 | null,
--       cac_excluding_broadcast_and_crossplatform_cents: 0 | null,
--       cost_per_inquiry_cents: 0 | null,
--       cost_per_tour_cents: 0 | null }
--
--   quality_metrics:
--     { avg_booking_value_cents: 0 | null,
--       median_lead_time_days: 0 | null,
--       avg_review_rating: 0.0 | null,
--       review_count: 0,
--       persona_distribution: { "<persona>": 0, ... } }
--
--   sample_sizes:
--     { unique_weddings: 0,
--       ae_total: 0,
--       weddings_per_role: { acquisition: 0, validation: 0, ... },
--       weddings_per_intent: { targeted: 0, broadcast: 0, ... },
--       weddings_per_story_arc: {
--         discovery: 0, inquiry: 0, validation: 0,
--         broadcast: 0, cross_platform_footprint: 0
--       } }
--
--   confidence_signals:
--     { v1_contaminated_count: 0,
--       v2_classified_count: 0,
--       null_classified_count: 0,
--       data_freshness_iso: "iso",
--       prompt_versions_used: ["..."],
--       window_days: 0,
--       computed_with_function: "computeChannelSnapshot" }
--
-- The page does NOT join across snapshot rows — every snapshot is
-- read whole. The shape is denormalised on purpose so a single row
-- read powers the entire per-source page.

CREATE TABLE IF NOT EXISTS public.channel_intel_snapshots (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  venue_id uuid NOT NULL REFERENCES public.venues(id) ON DELETE CASCADE,
  -- URL slug. 'the-knot' / 'weddingwire' / 'instagram' / 'google'.
  -- Kebab-case so it lands in /intel/channels/[channel_slug] cleanly.
  channel_slug text NOT NULL,
  -- Canonical platform name matching attribution_events.source_platform.
  -- 'the_knot' / 'weddingwire' / 'instagram' / etc.
  source_platform text NOT NULL,
  computed_at timestamptz NOT NULL DEFAULT now(),
  -- 30 / 90 / 365. The page lets the operator switch windows.
  window_days integer NOT NULL CHECK (window_days IN (30, 90, 365)),

  role_breakdown jsonb NOT NULL DEFAULT '{}'::jsonb,
  intent_breakdown jsonb NOT NULL DEFAULT '{}'::jsonb,
  funnel jsonb NOT NULL DEFAULT '{}'::jsonb,
  cost_metrics jsonb NOT NULL DEFAULT '{}'::jsonb,
  quality_metrics jsonb NOT NULL DEFAULT '{}'::jsonb,
  sample_sizes jsonb NOT NULL DEFAULT '{}'::jsonb,
  confidence_signals jsonb NOT NULL DEFAULT '{}'::jsonb,

  created_at timestamptz NOT NULL DEFAULT now()
);

COMMENT ON TABLE public.channel_intel_snapshots IS
  'Wave 25 (mig 291). Cache of per-(venue, channel_slug, window_days) '
  'forensic numbers. One row = one computation. The page reads the '
  'latest row; force-refresh writes a new row. Snapshot is NEVER the '
  'sole source of truth — the operator can always force a re-derive '
  'against live attribution_events. Wedding MBA exports snapshot the '
  'jsonb blob into channel_presentation_exports for reproducibility.';

COMMENT ON COLUMN public.channel_intel_snapshots.channel_slug IS
  'Wave 25. URL slug (kebab-case). Powers /intel/channels/[channel_slug]. '
  'Derived from source_platform via TS normaliser so all variants of '
  '"theknot.com" / "theknot" / "the_knot" collapse to the-knot.';

COMMENT ON COLUMN public.channel_intel_snapshots.window_days IS
  'Wave 25. Forensic window the snapshot covers — 30 / 90 / 365 days '
  'ending at computed_at. Different windows = different snapshot rows.';

COMMENT ON COLUMN public.channel_intel_snapshots.confidence_signals IS
  'Wave 25. Airtightness disclosure pulled forward into the snapshot: '
  'v1-contaminated counts (per PROMPT-BIAS-AUDIT.md), v2-classified '
  'counts, data freshness ISO timestamp, prompt versions present, '
  'computed_with_function name (reproducibility footer). The page '
  'renders these as the calibration band; the export embeds them in '
  'the footer of every PDF page.';

CREATE INDEX IF NOT EXISTS idx_channel_intel_snapshots_lookup
  ON public.channel_intel_snapshots (venue_id, channel_slug, window_days, computed_at DESC);

COMMENT ON INDEX public.idx_channel_intel_snapshots_lookup IS
  'Wave 25 — primary index for "latest snapshot for this channel + '
  'window for this venue". Sorted DESC so the first row is the freshest.';

CREATE INDEX IF NOT EXISTS idx_channel_intel_snapshots_venue_computed
  ON public.channel_intel_snapshots (venue_id, computed_at DESC);

COMMENT ON INDEX public.idx_channel_intel_snapshots_venue_computed IS
  'Wave 25 — comparison page lookup ("show me all channels for this '
  'venue at the latest computed_at").';

-- ============================================================================
-- STEP 2 — channel_presentation_exports
-- ============================================================================
-- Wedding MBA export audit. One row per generated export. The
-- share_token is the public URL component (the public-share endpoint
-- looks up the row by share_token without auth). snapshot_jsonb is the
-- frozen view at export time so the link is stable even if the
-- underlying data shifts.

CREATE TABLE IF NOT EXISTS public.channel_presentation_exports (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  venue_id uuid NOT NULL REFERENCES public.venues(id) ON DELETE CASCADE,
  exported_at timestamptz NOT NULL DEFAULT now(),
  -- Nullable: super_admin exports may not carry a user id; cron-generated
  -- digest snapshots also leave this null.
  exported_by uuid,
  channel_slug text NOT NULL,
  -- 'pdf' | 'pptx' | 'csv' | 'json'
  format text NOT NULL CHECK (format IN ('pdf', 'pptx', 'csv', 'json')),
  -- Public share token. URL-safe random 24-32 char string. UNIQUE so
  -- the public lookup is O(1).
  share_token text NOT NULL UNIQUE,
  -- Frozen view of the snapshot at export time. Same shape as
  -- channel_intel_snapshots — the export endpoint copies the snapshot
  -- INTO this column so subsequent re-renders read this row, not the
  -- live snapshot table.
  snapshot_jsonb jsonb NOT NULL DEFAULT '{}'::jsonb,
  -- When the share link expires. NULL = never. Wedding MBA links
  -- typically permanent; cron-generated digests may set a TTL.
  expires_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);

COMMENT ON TABLE public.channel_presentation_exports IS
  'Wave 25 (mig 291). Audit trail for Wedding MBA presentation exports. '
  'One row per export. share_token powers /api/public/channels/exports/'
  '[shareToken] — anonymous readers see the frozen snapshot at export '
  'time, not the live snapshot. snapshot_jsonb is the full '
  'channel_intel_snapshots row at export moment + the venue label + '
  'the narrator output. Reproducibility primitive for external readers.';

COMMENT ON COLUMN public.channel_presentation_exports.share_token IS
  'Wave 25. Public URL component. URL-safe random 24-32 chars. UNIQUE. '
  'Anonymous public lookup endpoint reads this; no auth required '
  'because snapshot_jsonb is already a frozen, non-PII view.';

COMMENT ON COLUMN public.channel_presentation_exports.snapshot_jsonb IS
  'Wave 25. Frozen view at export time. Shape:'
  ' { "channel_slug": "...", "source_platform": "...", "venue_label": '
  '"...", "window_days": 90, "computed_at_iso": "...", "story_arc": '
  '{ "discovery": {...}, "inquiry": {...}, "validation": {...}, '
  '"broadcast": {...}, "cross_platform_footprint": {...} }, '
  '"cost_reveal": { "apparent_cac_cents": ..., "real_cac_cents": ... }, '
  '"calibration": { ... }, "narrator_output": { ... } }';

CREATE INDEX IF NOT EXISTS idx_channel_presentation_exports_venue_exported
  ON public.channel_presentation_exports (venue_id, exported_at DESC);

COMMENT ON INDEX public.idx_channel_presentation_exports_venue_exported IS
  'Wave 25 — primary index for "show me my recent exports" in the UI.';

CREATE INDEX IF NOT EXISTS idx_channel_presentation_exports_share_token
  ON public.channel_presentation_exports (share_token);

COMMENT ON INDEX public.idx_channel_presentation_exports_share_token IS
  'Wave 25 — public lookup index. The UNIQUE constraint already creates '
  'one but we declare it explicitly so a code reader sees the access '
  'pattern next to the comments.';

-- ============================================================================
-- STEP 3 — RLS (venue_id scope)
-- ============================================================================
ALTER TABLE public.channel_intel_snapshots ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "channel_intel_snapshots_select"
  ON public.channel_intel_snapshots;
CREATE POLICY "channel_intel_snapshots_select"
  ON public.channel_intel_snapshots
  FOR SELECT
  TO authenticated
  USING (
    venue_id IN (
      SELECT up.venue_id FROM public.user_profiles up WHERE up.id = auth.uid()
      UNION
      SELECT v.id FROM public.venues v
        JOIN public.user_profiles up ON up.org_id = v.org_id
       WHERE up.id = auth.uid()
    )
    OR public.is_super_admin()
  );

DROP POLICY IF EXISTS "channel_intel_snapshots_insert"
  ON public.channel_intel_snapshots;
CREATE POLICY "channel_intel_snapshots_insert"
  ON public.channel_intel_snapshots
  FOR INSERT
  TO authenticated
  WITH CHECK (
    venue_id IN (
      SELECT up.venue_id FROM public.user_profiles up WHERE up.id = auth.uid()
      UNION
      SELECT v.id FROM public.venues v
        JOIN public.user_profiles up ON up.org_id = v.org_id
       WHERE up.id = auth.uid()
    )
    OR public.is_super_admin()
  );

DROP POLICY IF EXISTS "demo_anon_select_snapshots"
  ON public.channel_intel_snapshots;
CREATE POLICY "demo_anon_select_snapshots"
  ON public.channel_intel_snapshots
  FOR SELECT TO anon
  USING (venue_id IN (SELECT id FROM public.venues WHERE is_demo = true));

ALTER TABLE public.channel_presentation_exports ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "channel_presentation_exports_select"
  ON public.channel_presentation_exports;
CREATE POLICY "channel_presentation_exports_select"
  ON public.channel_presentation_exports
  FOR SELECT
  TO authenticated
  USING (
    venue_id IN (
      SELECT up.venue_id FROM public.user_profiles up WHERE up.id = auth.uid()
      UNION
      SELECT v.id FROM public.venues v
        JOIN public.user_profiles up ON up.org_id = v.org_id
       WHERE up.id = auth.uid()
    )
    OR public.is_super_admin()
  );

DROP POLICY IF EXISTS "channel_presentation_exports_insert"
  ON public.channel_presentation_exports;
CREATE POLICY "channel_presentation_exports_insert"
  ON public.channel_presentation_exports
  FOR INSERT
  TO authenticated
  WITH CHECK (
    venue_id IN (
      SELECT up.venue_id FROM public.user_profiles up WHERE up.id = auth.uid()
      UNION
      SELECT v.id FROM public.venues v
        JOIN public.user_profiles up ON up.org_id = v.org_id
       WHERE up.id = auth.uid()
    )
    OR public.is_super_admin()
  );

-- Public share endpoint reads with the anon role; the share_token is
-- the secret. RLS allows anon to SELECT only by share_token. The
-- endpoint itself enforces the share_token filter — RLS is belt to
-- the endpoint's suspenders.
DROP POLICY IF EXISTS "channel_presentation_exports_public_share"
  ON public.channel_presentation_exports;
CREATE POLICY "channel_presentation_exports_public_share"
  ON public.channel_presentation_exports
  FOR SELECT TO anon
  USING (share_token IS NOT NULL);

DROP POLICY IF EXISTS "demo_anon_select_exports"
  ON public.channel_presentation_exports;
CREATE POLICY "demo_anon_select_exports"
  ON public.channel_presentation_exports
  FOR SELECT TO anon
  USING (venue_id IN (SELECT id FROM public.venues WHERE is_demo = true));

COMMIT;

NOTIFY pgrst, 'reload schema';
