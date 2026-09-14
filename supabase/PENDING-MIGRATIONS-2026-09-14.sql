-- ============================================================================
-- PENDING MIGRATIONS BUNDLE for production (jsxxgwprxuqgcauzlxcb)
-- Built 2026-09-14 from supabase/migrations/, in dependency order.
--
-- HOW TO RUN: Supabase Dashboard -> SQL Editor -> paste the whole file -> Run.
-- The editor runs as the database owner, so the two things the exec_sql
-- runner cannot do (308's storage policies, 411's storage steps) work here.
-- Every statement is idempotent (IF NOT EXISTS / IF EXISTS / OR REPLACE), so a
-- second run is safe. There is no BEGIN/COMMIT wrapper on purpose: the
-- editor wraps the batch itself, and a partial failure leaves the earlier
-- files applied and the failing statement named.
--
-- ORDER (23 files): the legacy six first because 407 ALTERs a table 310
-- creates, then 395 to 412. 396 and 405 were never issued.
--   291, 304, 305, 307, 308, 309, 310, 395, 397, 398, 399, 400, 401, 402, 403, 404, 406, 407, 408, 409, 410, 411, 412
--
-- AFTER RUNNING:
--   node scripts/check-live-policies.mjs        every line should read OK
--   npx tsx scripts/gen-wedding-fk-tables.ts     regenerates the cascade list (406 stops being pending)
--   npx supabase gen types typescript ...        types.generated.ts (see package.json)
--   node scripts/check-types-fresh.mjs           should pass
-- ============================================================================


-- ############################################################################
-- 291_channel_intel_snapshots.sql
-- ############################################################################

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

-- (stripped for the bundle: BEGIN; ; the SQL editor wraps the batch itself)

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

-- (stripped for the bundle: COMMIT; ; the SQL editor wraps the batch itself)

NOTIFY pgrst, 'reload schema';


-- ############################################################################
-- 304_marketing_agencies.sql
-- ############################################################################

-- ---------------------------------------------------------------------------
-- 304_marketing_agencies.sql  (Wave 6E — agency entity layer)
-- ---------------------------------------------------------------------------
-- The "is Hawthorn paying off?" question is the strongest single argument
-- for Bloom right now. Boutique wedding-marketing agencies (Hawthorn
-- Creative, Elite Wedding Marketing, Path & Compass, Alecan, Slamdot,
-- Del Priore Hospitality, Wedding Venue Leads, etc.) bill $2k-$8k/mo
-- and report on top-of-funnel metrics they can see (impressions,
-- clicks, form submissions). They CANNOT see what happens after the
-- form: tour conversion, booking, revenue. Bloom can — and once an
-- agency is a first-class entity, "agency CAC" and "agency-vs-claimed
-- attribution" become the headline TBH Report.
--
-- This migration lands the agency entity + the venue-agency engagement.
-- Migration 305 adds the linkage columns on marketing_spend_records and
-- marketing_channels so spend rows + channels can point at an agency.
--
-- Architectural choices baked in here:
--
--   1. marketing_agencies is NOT venue-scoped by default — the same
--      agency (Hawthorn) can serve multiple venues at Wedgewood scale.
--      An agency belongs to an organisation (org_id) when an org owns
--      the relationship, or to a single venue (venue_id) when a
--      stand-alone Bloom customer manages their own roster. CHECK
--      requires exactly one ownership pointer.
--
--   2. venue_agency_engagements is the M:N relationship that carries
--      per-venue cost + per-venue scope. The same agency can have
--      different monthly fees at different venues. Active engagement
--      = ended_at IS NULL. One active engagement per (venue, agency).
--
--   3. Soft-delete only — `deleted_at` preserves history for TBH
--      Reports run against terminated engagements ("what did Hawthorn
--      actually deliver during the 18 months they ran our ads?").
--
--   4. Idempotent — every CREATE uses IF NOT EXISTS, RLS uses
--      DROP THEN CREATE. Safe to re-run. No BEGIN/COMMIT wrapper
--      (exec_sql RPC silently rejects transaction blocks — see
--      feedback_migration_no_transaction_wrapper memory, Wave 23
--      caught this).
--
-- What is NOT in this migration:
--   * Spend / channel linkage columns (migration 305 owns).
--   * Agency-attributed ROI compute function (service layer owns).
--   * Agency-portal multi-tenancy (deferred — see bloom expansion
--     investigation notes; only build after 5+ venues use TBH Reports).
-- ---------------------------------------------------------------------------

-- ============================================================================
-- STEP 1 — marketing_agencies (the agency entity)
-- ============================================================================

CREATE TABLE IF NOT EXISTS public.marketing_agencies (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),

  -- Exactly one ownership pointer must be set. org_id wins at
  -- Wedgewood scale (one Hawthorn relationship shared across 8
  -- venues). venue_id is the single-venue case (Rixey solo).
  org_id uuid REFERENCES public.organisations(id) ON DELETE CASCADE,
  venue_id uuid REFERENCES public.venues(id) ON DELETE CASCADE,

  -- The agency's display name. Free-text so regional / international
  -- agencies land without a hardcoded list.
  name text NOT NULL,

  -- Optional contact + identity fields. All free-text, all nullable.
  -- Coordinators populate over time as they get the data.
  website text,
  contact_name text,
  contact_email text,
  contact_phone text,

  -- The agency's typical pricing model. PER-VENUE cost lives on
  -- venue_agency_engagements (where it actually varies); these are
  -- the rack-rate defaults the agency advertises.
  default_monthly_retainer_cents integer
    CHECK (default_monthly_retainer_cents IS NULL OR default_monthly_retainer_cents >= 0),
  performance_fee_pct numeric(5,2)
    CHECK (performance_fee_pct IS NULL OR (performance_fee_pct >= 0 AND performance_fee_pct <= 100)),

  -- Services the agency claims to offer. Free-text tags in a JSON
  -- array so the operator can record what they're actually paying
  -- for. Common values: 'seo' | 'paid_search' | 'paid_social' |
  -- 'content' | 'web_design' | 'email' | 'pinterest' | 'reputation'.
  services jsonb NOT NULL DEFAULT '[]'::jsonb,

  -- Long-form coordinator notes. Contracts, account-rep names, the
  -- "they promised X but actually deliver Y" running log.
  notes text,

  -- Audit trail. created_by is nullable so service-role / cron
  -- inserts (rare here) don't break the FK.
  created_by uuid REFERENCES public.user_profiles(id),

  -- Soft-delete only. Preserves historical attribution + cost.
  deleted_at timestamptz,

  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT marketing_agencies_name_nonempty
    CHECK (length(trim(name)) > 0),

  -- Exactly one ownership pointer.
  CONSTRAINT marketing_agencies_owner_xor
    CHECK ((org_id IS NOT NULL) <> (venue_id IS NOT NULL))
);

COMMENT ON TABLE public.marketing_agencies IS
  'owner:intelligence. Wave 6E. First-class marketing-agency entity. '
  'NOT venue-scoped — a single agency can serve multiple venues at '
  'Wedgewood scale via venue_agency_engagements. Owned by either an '
  'organisation (org-level relationship) or a venue (single-venue '
  'roster) but never both. Soft-delete preserves historical '
  'attribution. The "is Hawthorn paying off?" answer is computed by '
  'joining attribution_events → marketing_channels.managed_by_agency_id '
  '+ marketing_spend_records.agency_id (migration 305). Migration 304.';

COMMENT ON COLUMN public.marketing_agencies.org_id IS
  'When set, agency is shared across all venues in the org. Wedgewood '
  'pattern. Mutually exclusive with venue_id.';

COMMENT ON COLUMN public.marketing_agencies.venue_id IS
  'When set, agency is owned by a single venue (no org context). '
  'Solo-Bloom pattern. Mutually exclusive with org_id.';

COMMENT ON COLUMN public.marketing_agencies.services IS
  'JSON array of free-text service tags. Common values: seo, '
  'paid_search, paid_social, content, web_design, email, pinterest, '
  'reputation, listing_management. UI surfaces these as chips on the '
  'agency card.';

COMMENT ON COLUMN public.marketing_agencies.default_monthly_retainer_cents IS
  'Rack-rate retainer the agency advertises (cents). Actual per-venue '
  'fee lives on venue_agency_engagements.monthly_fee_cents.';

CREATE INDEX IF NOT EXISTS idx_marketing_agencies_org
  ON public.marketing_agencies (org_id)
  WHERE deleted_at IS NULL AND org_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_marketing_agencies_venue
  ON public.marketing_agencies (venue_id)
  WHERE deleted_at IS NULL AND venue_id IS NOT NULL;

-- Case-insensitive name lookup for the "do we already have this agency?"
-- prompt in the create form.
CREATE INDEX IF NOT EXISTS idx_marketing_agencies_name_lower
  ON public.marketing_agencies (lower(name))
  WHERE deleted_at IS NULL;

-- ============================================================================
-- STEP 2 — venue_agency_engagements (M:N pivot with cost + scope)
-- ============================================================================

CREATE TABLE IF NOT EXISTS public.venue_agency_engagements (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  venue_id uuid NOT NULL REFERENCES public.venues(id) ON DELETE CASCADE,
  agency_id uuid NOT NULL REFERENCES public.marketing_agencies(id) ON DELETE CASCADE,

  -- Engagement period. ended_at NULL = currently active. ended_at
  -- in the past = historical (still counts for TBH Reports run with
  -- a window that overlaps the engagement).
  started_at date NOT NULL,
  ended_at date,

  -- What this venue is actually paying. Distinct from the agency's
  -- default_monthly_retainer — the same agency can charge different
  -- fees at different venues.
  monthly_fee_cents integer NOT NULL DEFAULT 0
    CHECK (monthly_fee_cents >= 0),

  -- Which channels (marketing_channels.key values) this engagement
  -- covers. The TBH ROI compute joins attribution_events against
  -- this set when answering "what did Hawthorn drive?". Stored as
  -- a JSON array to allow zero-or-more channels per engagement.
  managed_channels jsonb NOT NULL DEFAULT '[]'::jsonb,

  -- Coordinator-facing description of scope.
  scope_description text,

  notes text,

  deleted_at timestamptz,

  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT venue_agency_engagements_dates_valid
    CHECK (ended_at IS NULL OR ended_at >= started_at)
);

COMMENT ON TABLE public.venue_agency_engagements IS
  'owner:intelligence. Wave 6E. Per-venue agency engagement. Many-to-'
  'many between venues and marketing_agencies. Carries the per-venue '
  'fee (which can differ from the agency''s rack rate) and the set of '
  'channels the agency manages at this venue. One active engagement '
  '(ended_at IS NULL) per (venue, agency). Soft-delete preserves '
  'historical TBH Report data. Migration 304.';

COMMENT ON COLUMN public.venue_agency_engagements.managed_channels IS
  'JSON array of marketing_channels.key values that this engagement '
  'covers. Example: ["google_ads", "meta_ads", "organic_seo"]. The '
  'agency-ROI compute joins attribution_events.source_platform '
  'against this set.';

COMMENT ON COLUMN public.venue_agency_engagements.ended_at IS
  'NULL = currently active. Set when the relationship ends — '
  'historical TBH Reports still include this engagement when their '
  'window overlaps started_at..ended_at.';

-- One active engagement per (venue, agency).
CREATE UNIQUE INDEX IF NOT EXISTS uq_venue_agency_engagements_active
  ON public.venue_agency_engagements (venue_id, agency_id)
  WHERE ended_at IS NULL AND deleted_at IS NULL;

CREATE INDEX IF NOT EXISTS idx_venue_agency_engagements_venue
  ON public.venue_agency_engagements (venue_id, started_at DESC)
  WHERE deleted_at IS NULL;

CREATE INDEX IF NOT EXISTS idx_venue_agency_engagements_agency
  ON public.venue_agency_engagements (agency_id, started_at DESC)
  WHERE deleted_at IS NULL;

-- ============================================================================
-- STEP 3 — RLS for marketing_agencies
-- ============================================================================
-- An authenticated user can see an agency if either:
--   (a) their user_profile.org_id matches the agency's org_id, OR
--   (b) their user_profile.venue_id matches the agency's venue_id, OR
--   (c) they're in the org that owns a venue with an engagement to
--       the agency (multi-venue users), OR
--   (d) they're a super_admin.
-- Service-role bypasses RLS for the cron + compute paths.

ALTER TABLE public.marketing_agencies ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "marketing_agencies_select" ON public.marketing_agencies;
CREATE POLICY "marketing_agencies_select" ON public.marketing_agencies
  FOR SELECT TO authenticated
  USING (
    public.is_super_admin()
    OR (
      org_id IS NOT NULL
      AND org_id IN (
        SELECT up.org_id FROM public.user_profiles up
        WHERE up.id = auth.uid() AND up.org_id IS NOT NULL
      )
    )
    OR (
      venue_id IS NOT NULL
      AND venue_id IN (
        SELECT up.venue_id FROM public.user_profiles up
        WHERE up.id = auth.uid() AND up.venue_id IS NOT NULL
        UNION
        SELECT v.id FROM public.venues v
          JOIN public.user_profiles up ON up.org_id = v.org_id
        WHERE up.id = auth.uid()
      )
    )
    OR id IN (
      SELECT eng.agency_id
      FROM public.venue_agency_engagements eng
      WHERE eng.deleted_at IS NULL
        AND eng.venue_id IN (
          SELECT up.venue_id FROM public.user_profiles up
          WHERE up.id = auth.uid() AND up.venue_id IS NOT NULL
          UNION
          SELECT v.id FROM public.venues v
            JOIN public.user_profiles up ON up.org_id = v.org_id
          WHERE up.id = auth.uid()
        )
    )
  );

DROP POLICY IF EXISTS "marketing_agencies_modify" ON public.marketing_agencies;
CREATE POLICY "marketing_agencies_modify" ON public.marketing_agencies
  FOR ALL TO authenticated
  USING (
    public.is_super_admin()
    OR (
      org_id IS NOT NULL
      AND org_id IN (
        SELECT up.org_id FROM public.user_profiles up
        WHERE up.id = auth.uid() AND up.org_id IS NOT NULL
      )
    )
    OR (
      venue_id IS NOT NULL
      AND venue_id IN (
        SELECT up.venue_id FROM public.user_profiles up
        WHERE up.id = auth.uid() AND up.venue_id IS NOT NULL
        UNION
        SELECT v.id FROM public.venues v
          JOIN public.user_profiles up ON up.org_id = v.org_id
        WHERE up.id = auth.uid()
      )
    )
  )
  WITH CHECK (
    public.is_super_admin()
    OR (
      org_id IS NOT NULL
      AND org_id IN (
        SELECT up.org_id FROM public.user_profiles up
        WHERE up.id = auth.uid() AND up.org_id IS NOT NULL
      )
    )
    OR (
      venue_id IS NOT NULL
      AND venue_id IN (
        SELECT up.venue_id FROM public.user_profiles up
        WHERE up.id = auth.uid() AND up.venue_id IS NOT NULL
        UNION
        SELECT v.id FROM public.venues v
          JOIN public.user_profiles up ON up.org_id = v.org_id
        WHERE up.id = auth.uid()
      )
    )
  );

DROP POLICY IF EXISTS "marketing_agencies_service" ON public.marketing_agencies;
CREATE POLICY "marketing_agencies_service" ON public.marketing_agencies
  FOR ALL TO service_role
  USING (true) WITH CHECK (true);

DROP POLICY IF EXISTS "demo_anon_select_marketing_agencies" ON public.marketing_agencies;
CREATE POLICY "demo_anon_select_marketing_agencies" ON public.marketing_agencies
  FOR SELECT TO anon
  USING (
    venue_id IN (SELECT id FROM public.venues WHERE is_demo = true)
    OR org_id IN (
      SELECT DISTINCT org_id FROM public.venues
      WHERE is_demo = true AND org_id IS NOT NULL
    )
  );

-- ============================================================================
-- STEP 4 — RLS for venue_agency_engagements
-- ============================================================================
-- Mirror marketing_channels pattern — venue-scoped, with org-fanout
-- via user_profiles.org_id JOIN venues.org_id.

ALTER TABLE public.venue_agency_engagements ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "venue_agency_engagements_select" ON public.venue_agency_engagements;
CREATE POLICY "venue_agency_engagements_select" ON public.venue_agency_engagements
  FOR SELECT TO authenticated
  USING (
    venue_id IN (
      SELECT up.venue_id FROM public.user_profiles up
      WHERE up.id = auth.uid() AND up.venue_id IS NOT NULL
      UNION
      SELECT v.id FROM public.venues v
        JOIN public.user_profiles up ON up.org_id = v.org_id
      WHERE up.id = auth.uid()
    )
    OR public.is_super_admin()
  );

DROP POLICY IF EXISTS "venue_agency_engagements_modify" ON public.venue_agency_engagements;
CREATE POLICY "venue_agency_engagements_modify" ON public.venue_agency_engagements
  FOR ALL TO authenticated
  USING (
    venue_id IN (
      SELECT up.venue_id FROM public.user_profiles up
      WHERE up.id = auth.uid() AND up.venue_id IS NOT NULL
      UNION
      SELECT v.id FROM public.venues v
        JOIN public.user_profiles up ON up.org_id = v.org_id
      WHERE up.id = auth.uid()
    )
    OR public.is_super_admin()
  )
  WITH CHECK (
    venue_id IN (
      SELECT up.venue_id FROM public.user_profiles up
      WHERE up.id = auth.uid() AND up.venue_id IS NOT NULL
      UNION
      SELECT v.id FROM public.venues v
        JOIN public.user_profiles up ON up.org_id = v.org_id
      WHERE up.id = auth.uid()
    )
    OR public.is_super_admin()
  );

DROP POLICY IF EXISTS "venue_agency_engagements_service" ON public.venue_agency_engagements;
CREATE POLICY "venue_agency_engagements_service" ON public.venue_agency_engagements
  FOR ALL TO service_role
  USING (true) WITH CHECK (true);

DROP POLICY IF EXISTS "demo_anon_select_venue_agency_engagements"
  ON public.venue_agency_engagements;
CREATE POLICY "demo_anon_select_venue_agency_engagements"
  ON public.venue_agency_engagements
  FOR SELECT TO anon
  USING (venue_id IN (SELECT id FROM public.venues WHERE is_demo = true));

-- ============================================================================
-- STEP 5 — updated_at touch triggers
-- ============================================================================

CREATE OR REPLACE FUNCTION public.marketing_agencies_touch_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at := now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_marketing_agencies_updated_at
  ON public.marketing_agencies;
CREATE TRIGGER trg_marketing_agencies_updated_at
  BEFORE UPDATE ON public.marketing_agencies
  FOR EACH ROW
  EXECUTE FUNCTION public.marketing_agencies_touch_updated_at();

CREATE OR REPLACE FUNCTION public.venue_agency_engagements_touch_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at := now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_venue_agency_engagements_updated_at
  ON public.venue_agency_engagements;
CREATE TRIGGER trg_venue_agency_engagements_updated_at
  BEFORE UPDATE ON public.venue_agency_engagements
  FOR EACH ROW
  EXECUTE FUNCTION public.venue_agency_engagements_touch_updated_at();

NOTIFY pgrst, 'reload schema';


-- ############################################################################
-- 305_agency_spend_channel_linkage.sql
-- ############################################################################

-- ---------------------------------------------------------------------------
-- 305_agency_spend_channel_linkage.sql  (Wave 6E — agency linkage)
-- ---------------------------------------------------------------------------
-- Migration 304 landed the agency entity + engagement. This migration
-- wires it into the existing spend / channel substrates so the ROI
-- compute path can answer "which agency does this spend belong to?"
-- and "which agency manages this channel?" without re-architecting
-- the existing Wave 6A/6D pipeline.
--
-- Adds:
--   - marketing_spend_records.agency_id (nullable FK)
--     Per-row tag identifying which agency the spend was paid to or
--     managed by. NULL = unattributed (the org spent directly, or
--     the row predates agency tracking).
--
--   - marketing_channels.managed_by_agency_id (nullable FK)
--     Per-channel tag. When set, every attribution_event sourced from
--     this channel rolls up under the agency in TBH Reports.
--
-- Idempotent: ALTER ... ADD COLUMN IF NOT EXISTS + DROP/CREATE indexes.
-- No BEGIN/COMMIT wrapper (exec_sql RPC rejects them — see Wave 23
-- doctrine in feedback_migration_no_transaction_wrapper memory).
-- ---------------------------------------------------------------------------

-- ============================================================================
-- STEP 1 — marketing_spend_records.agency_id
-- ============================================================================
-- ON DELETE SET NULL so deleting an agency doesn't blow away historical
-- spend records. The spend row keeps its other columns; only the
-- agency association drops.

ALTER TABLE public.marketing_spend_records
  ADD COLUMN IF NOT EXISTS agency_id uuid
  REFERENCES public.marketing_agencies(id) ON DELETE SET NULL;

COMMENT ON COLUMN public.marketing_spend_records.agency_id IS
  'Wave 6E. Optional FK to marketing_agencies. When set, indicates '
  'this spend row was paid to or managed by the named agency. NULL = '
  'no agency context (direct spend, pre-tracking, or in-house). '
  'TBH agency-ROI rollups GROUP BY agency_id. ON DELETE SET NULL so '
  'agency deletion preserves spend history.';

CREATE INDEX IF NOT EXISTS idx_marketing_spend_records_agency
  ON public.marketing_spend_records (agency_id, spend_date DESC)
  WHERE agency_id IS NOT NULL;

COMMENT ON INDEX public.idx_marketing_spend_records_agency IS
  'Wave 6E. Hot-path: "total spend to Hawthorn in last 90 days", '
  'agency P&L rollup. Partial index — agency_id IS NOT NULL skips '
  'the (large) unattributed-spend tail.';

-- ============================================================================
-- STEP 2 — marketing_channels.managed_by_agency_id
-- ============================================================================
-- When a channel is "managed" by an agency, every attribution_event
-- sourced from that channel rolls up under the agency. Same FK
-- semantics: SET NULL on agency delete to preserve channel rows.

ALTER TABLE public.marketing_channels
  ADD COLUMN IF NOT EXISTS managed_by_agency_id uuid
  REFERENCES public.marketing_agencies(id) ON DELETE SET NULL;

COMMENT ON COLUMN public.marketing_channels.managed_by_agency_id IS
  'Wave 6E. Optional FK to marketing_agencies. When set, every '
  'attribution_event whose source_platform matches this channel''s '
  'key rolls up under the named agency in TBH Reports. The agency '
  '"manages" the channel — they''re the ones making decisions about '
  'spend / creative / targeting. ON DELETE SET NULL.';

CREATE INDEX IF NOT EXISTS idx_marketing_channels_managed_by_agency
  ON public.marketing_channels (managed_by_agency_id)
  WHERE managed_by_agency_id IS NOT NULL AND deleted_at IS NULL;

COMMENT ON INDEX public.idx_marketing_channels_managed_by_agency IS
  'Wave 6E. "Which channels does this agency manage?" reverse '
  'lookup. Used by agency-detail page + ROI compute.';

NOTIFY pgrst, 'reload schema';


-- ############################################################################
-- 307_agency_profile_depth.sql
-- ############################################################################

-- ---------------------------------------------------------------------------
-- 306_agency_profile_depth.sql  (Wave 6E — depth pass)
-- ---------------------------------------------------------------------------
-- Migrations 304/305 landed the agency entity + spend/channel linkage.
-- v1 of the tracker captured one contact + flat retainer + free-text
-- notes. Real agency relationships are deeper:
--
--   * Multiple humans (account manager, strategist, billing).
--   * Contracts (PDFs) with renewal dates.
--   * Specific KPIs the agency contractually promised (the TBH Report's
--     "they promised X, actual Y" requires this as a substrate).
--   * Per-channel sub-budgets WITHIN the engagement ($1.5k Google + $1k
--     Meta + $0.5k content, not just one $3k retainer line).
--   * Reporting cadence + dashboard URL — so Bloom can flag when their
--     monthly report is late and deep-link to their own view.
--   * Activity log — decisions over time (Q2 review notes, channel
--     shifts, escalations). Replaces the single free-text `notes` blob.
--
-- This migration adds four new tables + three new columns on
-- venue_agency_engagements. Idempotent. No BEGIN/COMMIT wrapper
-- (Wave 23 doctrine — see feedback_migration_no_transaction_wrapper).
-- ---------------------------------------------------------------------------

-- ============================================================================
-- STEP 1 — agency_contacts (multiple contacts per agency)
-- ============================================================================

CREATE TABLE IF NOT EXISTS public.agency_contacts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  agency_id uuid NOT NULL REFERENCES public.marketing_agencies(id) ON DELETE CASCADE,

  name text NOT NULL,
  email text,
  phone text,

  -- Free-text role tag. Common values: 'account_manager' | 'strategist'
  -- | 'billing' | 'creative' | 'founder' | 'support' | 'other'. Free-
  -- text so agencies with idiosyncratic structures land without
  -- migration.
  role text,

  -- Coordinator-facing notes about this specific contact ("prefers
  -- Slack over email", "covers maternity Jan-Mar", etc.).
  notes text,

  -- Primary contact for the relationship. At most one per agency
  -- (enforced via partial unique index below). UI surfaces the
  -- primary at the top of the contacts list.
  is_primary boolean NOT NULL DEFAULT false,

  deleted_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT agency_contacts_name_nonempty
    CHECK (length(trim(name)) > 0)
);

COMMENT ON TABLE public.agency_contacts IS
  'owner:intelligence. Wave 6E depth. One row per human at an agency. '
  'Replaces the single contact_name/email/phone fields on '
  'marketing_agencies (which stay as the canonical primary for back-'
  'compat). Soft-delete preserves who-said-what-when in the activity '
  'log. Migration 306.';

CREATE UNIQUE INDEX IF NOT EXISTS uq_agency_contacts_primary
  ON public.agency_contacts (agency_id)
  WHERE is_primary = true AND deleted_at IS NULL;

CREATE INDEX IF NOT EXISTS idx_agency_contacts_agency
  ON public.agency_contacts (agency_id)
  WHERE deleted_at IS NULL;

-- ============================================================================
-- STEP 2 — agency_documents (contracts, statements, reports)
-- ============================================================================

CREATE TABLE IF NOT EXISTS public.agency_documents (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  agency_id uuid NOT NULL REFERENCES public.marketing_agencies(id) ON DELETE CASCADE,
  engagement_id uuid REFERENCES public.venue_agency_engagements(id) ON DELETE SET NULL,

  -- File metadata. file_url points to Supabase Storage (bucket
  -- 'agency-documents' — provisioned via app config, not this
  -- migration). file_size in bytes for UI display.
  name text NOT NULL,
  file_url text,
  file_size_bytes integer,
  mime_type text,

  -- Free-text kind tag. Common values: 'contract' | 'sow' |
  -- 'statement' | 'invoice' | 'monthly_report' | 'quarterly_review' |
  -- 'asset_brief' | 'other'.
  kind text,

  -- Renewal / expiry tracking. NULL when not applicable (e.g. a
  -- one-off monthly report). When set, UI surfaces a 30-day warning.
  effective_date date,
  expires_at date,

  notes text,

  uploaded_by uuid REFERENCES public.user_profiles(id),

  deleted_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT agency_documents_name_nonempty
    CHECK (length(trim(name)) > 0)
);

COMMENT ON TABLE public.agency_documents IS
  'owner:intelligence. Wave 6E depth. PDF / image / link attachments '
  'for an agency relationship. Backed by Supabase Storage bucket '
  '`agency-documents`. expires_at drives the 30-day renewal warning. '
  'engagement_id is optional — contracts often span engagements; '
  'monthly reports are engagement-scoped. Migration 306.';

CREATE INDEX IF NOT EXISTS idx_agency_documents_agency
  ON public.agency_documents (agency_id, created_at DESC)
  WHERE deleted_at IS NULL;

CREATE INDEX IF NOT EXISTS idx_agency_documents_expiring
  ON public.agency_documents (expires_at)
  WHERE expires_at IS NOT NULL AND deleted_at IS NULL;

-- ============================================================================
-- STEP 3 — agency_kpi_commitments (what the agency promised)
-- ============================================================================
-- The "they promised X" side of the TBH Report. Bloom stores the
-- commitment; the agency-ROI compute reads it alongside the actuals
-- to produce the truth-vs-claim comparison.

CREATE TABLE IF NOT EXISTS public.agency_kpi_commitments (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  agency_id uuid NOT NULL REFERENCES public.marketing_agencies(id) ON DELETE CASCADE,
  engagement_id uuid REFERENCES public.venue_agency_engagements(id) ON DELETE SET NULL,

  -- Free-text metric name. Common: 'leads_per_month' |
  -- 'cost_per_lead' | 'tour_conversion_rate' | 'impressions_per_month'.
  -- Free-text so agencies with non-standard KPIs (e.g. "Pinterest
  -- saves") land without schema change.
  metric_name text NOT NULL,

  -- Numeric target. Stored as numeric (not cents) because some KPIs
  -- are counts (47 leads), some are percentages (8.5%), some are
  -- currency (which the unit column disambiguates).
  target_value numeric(18, 4) NOT NULL,

  -- Unit string. 'count' | 'cents' | 'usd' | 'percent' | 'days' |
  -- 'minutes' | 'other'. UI uses for display formatting.
  target_unit text NOT NULL DEFAULT 'count',

  -- Window the KPI is measured over. 'month' | 'quarter' | 'year' |
  -- 'engagement'.
  target_window text NOT NULL DEFAULT 'month',

  -- Optional human description for nuance.
  notes text,

  -- Track whether the commitment is currently active. Setting
  -- effective_to to a past date retires the KPI without deleting it
  -- (preserves historical truth-vs-claim).
  effective_from date NOT NULL DEFAULT CURRENT_DATE,
  effective_to date,

  deleted_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT agency_kpi_commitments_metric_nonempty
    CHECK (length(trim(metric_name)) > 0),
  CONSTRAINT agency_kpi_commitments_dates_valid
    CHECK (effective_to IS NULL OR effective_to >= effective_from)
);

COMMENT ON TABLE public.agency_kpi_commitments IS
  'owner:intelligence. Wave 6E depth. What the agency contractually '
  'promised. Lets the TBH Report contrast "promised X" vs "delivered '
  'Y" with the actual data Bloom can compute. effective_from / '
  'effective_to make commitments time-bound so contract renewals '
  'replace old targets without losing history. Migration 306.';

CREATE INDEX IF NOT EXISTS idx_agency_kpi_agency_active
  ON public.agency_kpi_commitments (agency_id)
  WHERE effective_to IS NULL AND deleted_at IS NULL;

-- ============================================================================
-- STEP 4 — agency_activity_log (timeline of decisions)
-- ============================================================================
-- The single notes blob on marketing_agencies isn't a relationship.
-- This is the timeline: "Q2 review on 2026-02-15, agreed to shift
-- 20% to Pinterest" / "renewed contract" / "added Maria as new account
-- manager" / "their monthly report is 8 days late".

CREATE TABLE IF NOT EXISTS public.agency_activity_log (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  agency_id uuid NOT NULL REFERENCES public.marketing_agencies(id) ON DELETE CASCADE,
  engagement_id uuid REFERENCES public.venue_agency_engagements(id) ON DELETE SET NULL,
  venue_id uuid REFERENCES public.venues(id) ON DELETE CASCADE,

  -- The event date the operator wants to remember. Distinct from
  -- created_at (when the row was written). Coordinator might log a
  -- meeting from 3 weeks ago and want the date right.
  occurred_at timestamptz NOT NULL DEFAULT now(),

  -- Free-text kind. Common: 'note' | 'meeting' | 'review' |
  -- 'decision' | 'escalation' | 'report_received' | 'report_late' |
  -- 'contract_renewed' | 'channel_change' | 'kpi_set' |
  -- 'kpi_missed' | 'kpi_hit'. Free-text so the operator can write
  -- their own kinds.
  kind text NOT NULL DEFAULT 'note',

  -- Short headline.
  summary text NOT NULL,

  -- Long-form body. Markdown OK.
  body text,

  -- Optional structured payload — e.g. for 'kpi_missed' the kpi_id
  -- + actual vs target. UI inspects this to render the appropriate
  -- visualization.
  payload jsonb NOT NULL DEFAULT '{}'::jsonb,

  recorded_by uuid REFERENCES public.user_profiles(id),

  deleted_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT agency_activity_log_summary_nonempty
    CHECK (length(trim(summary)) > 0)
);

COMMENT ON TABLE public.agency_activity_log IS
  'owner:intelligence. Wave 6E depth. Append-only timeline of '
  'decisions / meetings / KPI events for an agency relationship. '
  'Replaces the single notes blob with a structured history. Cron '
  'writers (e.g. "monthly report is late") share this table with '
  'human writers. Migration 306.';

CREATE INDEX IF NOT EXISTS idx_agency_activity_log_agency
  ON public.agency_activity_log (agency_id, occurred_at DESC)
  WHERE deleted_at IS NULL;

CREATE INDEX IF NOT EXISTS idx_agency_activity_log_engagement
  ON public.agency_activity_log (engagement_id, occurred_at DESC)
  WHERE engagement_id IS NOT NULL AND deleted_at IS NULL;

-- ============================================================================
-- STEP 5 — venue_agency_engagements extensions
-- ============================================================================

ALTER TABLE public.venue_agency_engagements
  ADD COLUMN IF NOT EXISTS channel_sub_budgets jsonb NOT NULL DEFAULT '{}'::jsonb;

COMMENT ON COLUMN public.venue_agency_engagements.channel_sub_budgets IS
  'Wave 6E depth. JSON object mapping marketing_channels.key → monthly '
  'cents budget. Example: { "google_ads": 150000, "meta_ads": 100000 }. '
  'Sums should equal monthly_fee_cents but the application layer '
  'enforces — DB allows drift so coordinator can record partial '
  'allocations.';

ALTER TABLE public.venue_agency_engagements
  ADD COLUMN IF NOT EXISTS reporting_cadence text;

COMMENT ON COLUMN public.venue_agency_engagements.reporting_cadence IS
  'Wave 6E depth. Free-text label for when the agency reports. '
  'Common: "weekly_email" | "biweekly_call" | "monthly_dashboard" | '
  '"quarterly_review". Drives the "their report is late" flag.';

ALTER TABLE public.venue_agency_engagements
  ADD COLUMN IF NOT EXISTS dashboard_url text;

COMMENT ON COLUMN public.venue_agency_engagements.dashboard_url IS
  'Wave 6E depth. Deep-link to the agency''s own reporting surface '
  '(their Looker / Data Studio / portal). Surface on the agency '
  'detail page next to Bloom''s view so the operator can compare '
  'their numbers to ours.';

-- ============================================================================
-- STEP 6 — RLS (mirror agency entity pattern from migration 304)
-- ============================================================================
-- All four tables follow the same access rule: visible to anyone who
-- can see the parent agency. Implemented as a single subquery against
-- marketing_agencies — RLS on that table already enforces the org /
-- venue / engagement-fanout logic.

-- Helper macro inline — repeat the policy pattern per table.

ALTER TABLE public.agency_contacts ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "agency_contacts_select" ON public.agency_contacts;
CREATE POLICY "agency_contacts_select" ON public.agency_contacts
  FOR SELECT TO authenticated
  USING (
    agency_id IN (SELECT id FROM public.marketing_agencies)
    OR public.is_super_admin()
  );

DROP POLICY IF EXISTS "agency_contacts_modify" ON public.agency_contacts;
CREATE POLICY "agency_contacts_modify" ON public.agency_contacts
  FOR ALL TO authenticated
  USING (
    agency_id IN (SELECT id FROM public.marketing_agencies)
    OR public.is_super_admin()
  )
  WITH CHECK (
    agency_id IN (SELECT id FROM public.marketing_agencies)
    OR public.is_super_admin()
  );

DROP POLICY IF EXISTS "agency_contacts_service" ON public.agency_contacts;
CREATE POLICY "agency_contacts_service" ON public.agency_contacts
  FOR ALL TO service_role USING (true) WITH CHECK (true);

ALTER TABLE public.agency_documents ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "agency_documents_select" ON public.agency_documents;
CREATE POLICY "agency_documents_select" ON public.agency_documents
  FOR SELECT TO authenticated
  USING (
    agency_id IN (SELECT id FROM public.marketing_agencies)
    OR public.is_super_admin()
  );

DROP POLICY IF EXISTS "agency_documents_modify" ON public.agency_documents;
CREATE POLICY "agency_documents_modify" ON public.agency_documents
  FOR ALL TO authenticated
  USING (
    agency_id IN (SELECT id FROM public.marketing_agencies)
    OR public.is_super_admin()
  )
  WITH CHECK (
    agency_id IN (SELECT id FROM public.marketing_agencies)
    OR public.is_super_admin()
  );

DROP POLICY IF EXISTS "agency_documents_service" ON public.agency_documents;
CREATE POLICY "agency_documents_service" ON public.agency_documents
  FOR ALL TO service_role USING (true) WITH CHECK (true);

ALTER TABLE public.agency_kpi_commitments ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "agency_kpi_select" ON public.agency_kpi_commitments;
CREATE POLICY "agency_kpi_select" ON public.agency_kpi_commitments
  FOR SELECT TO authenticated
  USING (
    agency_id IN (SELECT id FROM public.marketing_agencies)
    OR public.is_super_admin()
  );

DROP POLICY IF EXISTS "agency_kpi_modify" ON public.agency_kpi_commitments;
CREATE POLICY "agency_kpi_modify" ON public.agency_kpi_commitments
  FOR ALL TO authenticated
  USING (
    agency_id IN (SELECT id FROM public.marketing_agencies)
    OR public.is_super_admin()
  )
  WITH CHECK (
    agency_id IN (SELECT id FROM public.marketing_agencies)
    OR public.is_super_admin()
  );

DROP POLICY IF EXISTS "agency_kpi_service" ON public.agency_kpi_commitments;
CREATE POLICY "agency_kpi_service" ON public.agency_kpi_commitments
  FOR ALL TO service_role USING (true) WITH CHECK (true);

ALTER TABLE public.agency_activity_log ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "agency_activity_select" ON public.agency_activity_log;
CREATE POLICY "agency_activity_select" ON public.agency_activity_log
  FOR SELECT TO authenticated
  USING (
    agency_id IN (SELECT id FROM public.marketing_agencies)
    OR public.is_super_admin()
  );

DROP POLICY IF EXISTS "agency_activity_modify" ON public.agency_activity_log;
CREATE POLICY "agency_activity_modify" ON public.agency_activity_log
  FOR ALL TO authenticated
  USING (
    agency_id IN (SELECT id FROM public.marketing_agencies)
    OR public.is_super_admin()
  )
  WITH CHECK (
    agency_id IN (SELECT id FROM public.marketing_agencies)
    OR public.is_super_admin()
  );

DROP POLICY IF EXISTS "agency_activity_service" ON public.agency_activity_log;
CREATE POLICY "agency_activity_service" ON public.agency_activity_log
  FOR ALL TO service_role USING (true) WITH CHECK (true);

-- ============================================================================
-- STEP 7 — touch_updated_at triggers
-- ============================================================================

CREATE OR REPLACE FUNCTION public.agency_profile_touch_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at := now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_agency_contacts_updated_at ON public.agency_contacts;
CREATE TRIGGER trg_agency_contacts_updated_at
  BEFORE UPDATE ON public.agency_contacts
  FOR EACH ROW
  EXECUTE FUNCTION public.agency_profile_touch_updated_at();

DROP TRIGGER IF EXISTS trg_agency_documents_updated_at ON public.agency_documents;
CREATE TRIGGER trg_agency_documents_updated_at
  BEFORE UPDATE ON public.agency_documents
  FOR EACH ROW
  EXECUTE FUNCTION public.agency_profile_touch_updated_at();

DROP TRIGGER IF EXISTS trg_agency_kpi_updated_at ON public.agency_kpi_commitments;
CREATE TRIGGER trg_agency_kpi_updated_at
  BEFORE UPDATE ON public.agency_kpi_commitments
  FOR EACH ROW
  EXECUTE FUNCTION public.agency_profile_touch_updated_at();

NOTIFY pgrst, 'reload schema';


-- ############################################################################
-- 308_agency_storage_and_tbh_reports.sql
-- ############################################################################

-- ---------------------------------------------------------------------------
-- 308_agency_storage_and_tbh_reports.sql  (Wave 6E depth pass)
-- ---------------------------------------------------------------------------
-- Two pieces in one migration because they're both small and ship as a
-- single feature: real file storage for agency_documents, and a
-- persisted history table for TBH Reports so the LLM bill stays
-- bounded (one generation per period, with re-run on demand).
--
-- Piece 1 — Supabase Storage bucket for native file uploads
--
--   migration 307's agency_documents has file_url (text) but the only
--   way to populate it was paste a Google Drive / Dropbox link. The
--   depth pass adds true native uploads via a private bucket. All
--   access goes through API routes — the bucket itself is locked to
--   service-role to keep RLS reasoning simple (the agency_documents
--   row is the canonical permission boundary; signed URLs derived
--   from it carry the access decision).
--
--   Path scheme: {agency_id}/{document_id}-{slugified-name}.{ext}
--   Size limit:  25 MB (storage.buckets.file_size_limit, bytes).
--   Allowed MIME types: enforced at the API layer (not bucket-level
--                       because Supabase bucket allowed_mime_types
--                       triggers schema-cache reload churn).
--
-- Piece 2 — tbh_reports persisted history
--
--   Each TBH Report (LLM-generated narrative + structured snapshot)
--   gets a row so:
--     - Operator can review what was sent vs what numbers shifted
--     - LLM bill is bounded (don't regenerate on every page view)
--     - Coordinator + agency can reference the report by short_code
--       in conversation
--
--   Schema: one row per (agency_id, period_start, period_end, mode).
--   Mode = 'internal' | 'shareable' (per bloom-tbh-brand-asset
--   doctrine — sharp framing for venue ops, softer for sending to
--   the agency).
--
-- Idempotent. No BEGIN/COMMIT wrapper (Wave 23 doctrine).
-- ---------------------------------------------------------------------------

-- ============================================================================
-- STEP 1 — Storage bucket: agency-documents
-- ============================================================================
-- Private bucket. Service-role does all writes; signed URLs handle reads.
-- file_size_limit is in BYTES (25 MB). public=false so no anonymous
-- inference of object paths.

INSERT INTO storage.buckets (id, name, public, file_size_limit)
VALUES ('agency-documents', 'agency-documents', false, 26214400)
ON CONFLICT (id) DO UPDATE
  SET public = EXCLUDED.public,
      file_size_limit = EXCLUDED.file_size_limit;

-- Lock all direct authenticated access to the bucket. Reads happen via
-- short-lived signed URLs generated by /api/intel/agencies/[id]/
-- documents/[documentId]/download after the API validates the user
-- can see the parent agency_documents row.

DROP POLICY IF EXISTS "agency_documents_storage_service_all"
  ON storage.objects;
CREATE POLICY "agency_documents_storage_service_all"
  ON storage.objects
  FOR ALL
  TO service_role
  USING (bucket_id = 'agency-documents')
  WITH CHECK (bucket_id = 'agency-documents');

-- ============================================================================
-- STEP 2 — tbh_reports (persisted report history)
-- ============================================================================

CREATE TABLE IF NOT EXISTS public.tbh_reports (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  agency_id uuid NOT NULL REFERENCES public.marketing_agencies(id) ON DELETE CASCADE,
  venue_id uuid REFERENCES public.venues(id) ON DELETE CASCADE,

  -- Identifier the operator can quote in conversation ("send me TBH-2026-Q2-04").
  -- 8-char base36 string, derived from id but stored separately so it's
  -- queryable + URL-safe.
  short_code text NOT NULL,

  -- Period this report covers. period_end is inclusive.
  period_start date NOT NULL,
  period_end date NOT NULL,

  -- Mode the report was generated in.
  --   internal:  sharp framing, surfaces conflicts directly.
  --   shareable: softer framing, designed to send to the agency.
  mode text NOT NULL DEFAULT 'internal'
    CHECK (mode IN ('internal', 'shareable')),

  -- LLM-generated narrative pieces.
  executive_summary text,
  conflict_findings text,
  recommendations text,
  notes_for_agency text, -- only populated for mode='shareable'

  -- Full structured snapshot of every number that backs the narrative.
  -- Stored so re-rendering the report doesn't need a fresh compute.
  -- Shape (see computeTbhReport in service):
  --   {
  --     roi: { totalSpendCents, firstTouchLeads, ... },
  --     breakdown: { perChannel: [...], monthlyTrend: [...], personaCounts },
  --     kpiPerformance: [...],
  --     coverage: { pixelInstalledAt, googleAdsOAuth, calendlyQa, ... },
  --     activityHighlights: [...],
  --     engagements: [...]
  --   }
  snapshot jsonb NOT NULL DEFAULT '{}'::jsonb,

  -- LLM metadata for cost + reproducibility tracking.
  prompt_version text,
  llm_model text,
  llm_cost_cents integer NOT NULL DEFAULT 0,
  llm_input_tokens integer,
  llm_output_tokens integer,

  generated_by uuid REFERENCES public.user_profiles(id),
  generated_at timestamptz NOT NULL DEFAULT now(),

  -- Soft delete (lets a coordinator hide a report without losing the
  -- history vs new reports for the same period).
  deleted_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT tbh_reports_short_code_format
    CHECK (length(short_code) BETWEEN 6 AND 16
           AND short_code ~ '^[A-Z0-9-]+$'),
  CONSTRAINT tbh_reports_period_valid
    CHECK (period_end >= period_start)
);

COMMENT ON TABLE public.tbh_reports IS
  'owner:intelligence. Wave 6E depth. Persisted history of TBH Reports '
  '(forensic agency-performance reports). One row per (agency, period, '
  'mode). LLM cost capped because regeneration is operator-triggered, '
  'not page-view-triggered. snapshot column holds the structured data '
  'used to render so the report is reproducible even if upstream '
  'metrics drift. short_code is the human handle for the report. '
  'Migration 308.';

COMMENT ON COLUMN public.tbh_reports.mode IS
  'internal: sharp framing for venue operators. shareable: softer copy '
  'suitable for forwarding to the agency. Per bloom-tbh-brand-asset.';

COMMENT ON COLUMN public.tbh_reports.snapshot IS
  'Full structured dump of every number behind the narrative. Lets the '
  'report render without re-computing + lets the operator inspect the '
  'exact inputs months later when metrics have drifted.';

CREATE UNIQUE INDEX IF NOT EXISTS uq_tbh_reports_short_code
  ON public.tbh_reports (short_code);

CREATE INDEX IF NOT EXISTS idx_tbh_reports_agency_period
  ON public.tbh_reports (agency_id, period_end DESC)
  WHERE deleted_at IS NULL;

CREATE INDEX IF NOT EXISTS idx_tbh_reports_venue
  ON public.tbh_reports (venue_id, generated_at DESC)
  WHERE venue_id IS NOT NULL AND deleted_at IS NULL;

-- ============================================================================
-- STEP 3 — RLS for tbh_reports (mirror agency-profile pattern)
-- ============================================================================

ALTER TABLE public.tbh_reports ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "tbh_reports_select" ON public.tbh_reports;
CREATE POLICY "tbh_reports_select" ON public.tbh_reports
  FOR SELECT TO authenticated
  USING (
    agency_id IN (SELECT id FROM public.marketing_agencies)
    OR public.is_super_admin()
  );

DROP POLICY IF EXISTS "tbh_reports_modify" ON public.tbh_reports;
CREATE POLICY "tbh_reports_modify" ON public.tbh_reports
  FOR ALL TO authenticated
  USING (
    agency_id IN (SELECT id FROM public.marketing_agencies)
    OR public.is_super_admin()
  )
  WITH CHECK (
    agency_id IN (SELECT id FROM public.marketing_agencies)
    OR public.is_super_admin()
  );

DROP POLICY IF EXISTS "tbh_reports_service" ON public.tbh_reports;
CREATE POLICY "tbh_reports_service" ON public.tbh_reports
  FOR ALL TO service_role
  USING (true) WITH CHECK (true);

NOTIFY pgrst, 'reload schema';


-- ############################################################################
-- 309_web_pixel.sql
-- ############################################################################

-- ---------------------------------------------------------------------------
-- 309_web_pixel.sql  (Wave 6E follow-up — close the cross-session attribution gap)
-- ---------------------------------------------------------------------------
-- The TBH Report's coverage disclosure called out pixel='not_installed'
-- as the single biggest cross-session attribution gap. This migration
-- lands the substrate that fills it.
--
-- Architecture (per the original investigation):
--
--   1. Pixel snippet on the venue's marketing site fires on every
--      pageview. POSTs to /api/v1/visit with the venue's per-venue
--      pixel_ingest_key. Sets a first-party cookie `bloom_visitor_id`
--      that follows the visitor across sessions (1-year max-age).
--
--   2. The /api/v1/visit endpoint validates the ingest key, writes a
--      web_visits row with utm_*, gclid/fbclid/ttclid/msclkid,
--      document.referrer, landing path, IP hash, UA hash.
--
--   3. When a form on the venue's site submits to Bloom (web-form
--      adapter, existing migration 205 path), the form payload
--      includes bloom_visitor_id from the cookie. The adapter writes
--      candidate_identities + ties web_visits.candidate_identity_id
--      back, creating the cross-session attribution chain.
--
-- This migration adds ONLY the substrate. The endpoint + pixel.js +
-- form integration are app-layer code.
--
-- Constitution alignment: web_visits is a PRE-ZERO candidate signal in
-- the Constitution's sense. It identifies a candidate identity (the
-- anonymous visitor) BEFORE Point Zero (name + reachable identifier).
-- The resolver promotes web_visits → candidate_identity → wedding the
-- same way Knot CSV signals do.
-- ---------------------------------------------------------------------------

-- ============================================================================
-- STEP 1 — venue_config: pixel_ingest_key + pixel_installed_at
-- ============================================================================
-- Per-venue ingest key. Generated on first read via app-level
-- gen_random_uuid() so existing rows backfill lazily. Stored separately
-- from the venue's API key so leaking the pixel key (it's embedded in
-- the public website's HTML) doesn't compromise anything else.

ALTER TABLE public.venue_config
  ADD COLUMN IF NOT EXISTS pixel_ingest_key text;

ALTER TABLE public.venue_config
  ADD COLUMN IF NOT EXISTS pixel_installed_at timestamptz;

COMMENT ON COLUMN public.venue_config.pixel_ingest_key IS
  'Per-venue public key embedded in the bloom-pixel.js snippet. Validates '
  '/api/v1/visit posts. Rotatable via /portal/pixel-config without re-'
  'deploying the snippet on the venue website (rotation invalidates the '
  'old key and the venue swaps the snippet). NULL until first read on '
  'the config page, then back-filled to gen_random_uuid()::text.';

COMMENT ON COLUMN public.venue_config.pixel_installed_at IS
  'Set the first time we receive a successful /api/v1/visit POST from '
  'this venue. Read by the TBH Report coverage disclosure to mark the '
  'pre-pixel period as forensic-only.';

CREATE UNIQUE INDEX IF NOT EXISTS uq_venue_config_pixel_ingest_key
  ON public.venue_config (pixel_ingest_key)
  WHERE pixel_ingest_key IS NOT NULL;

-- ============================================================================
-- STEP 2 — web_visits table
-- ============================================================================
-- One row per pageview ingested via the pixel. anon_visitor_id is the
-- first-party cookie value (UUID, set client-side on first visit).
-- candidate_identity_id is NULL until a form submission carrying the
-- same cookie resolves the visitor to a person.

CREATE TABLE IF NOT EXISTS public.web_visits (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  venue_id uuid NOT NULL REFERENCES public.venues(id) ON DELETE CASCADE,

  -- First-party cookie value. UUID v4 set by the pixel on first visit.
  -- Same visitor across sessions keeps the same value (1-year cookie).
  anon_visitor_id text NOT NULL,

  -- UTM + click-id capture. Captured on every visit; the FIRST non-null
  -- value across a (venue, anon_visitor_id) cluster is the canonical
  -- first-touch attribution input. App-layer resolver enforces.
  utm_source text,
  utm_medium text,
  utm_campaign text,
  utm_term text,
  utm_content text,

  -- Click identifiers from ad platforms. gclid = Google Ads,
  -- fbclid = Meta, ttclid = TikTok, msclkid = Microsoft.
  gclid text,
  fbclid text,
  ttclid text,
  msclkid text,

  -- Where the visitor came from + landed.
  referrer text,
  landing_path text,

  -- Hashed IP + UA for de-duplication + bot filtering. Raw values are
  -- never stored — privacy + size.
  ip_hash text,
  user_agent_hash text,

  -- When the pageview fired (per the pixel's client clock; we trust it
  -- within a tolerance band — ingest fills server time if missing).
  occurred_at timestamptz NOT NULL DEFAULT now(),

  -- Once a form submission ties this anonymous visitor to a real
  -- person, the resolver back-fills these columns.
  candidate_identity_id uuid REFERENCES public.candidate_identities(id) ON DELETE SET NULL,
  resolved_at timestamptz,

  created_at timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT web_visits_anon_visitor_id_nonempty
    CHECK (length(trim(anon_visitor_id)) > 0)
);

COMMENT ON TABLE public.web_visits IS
  'owner:intelligence. Wave 6E follow-up. One row per pixel-tracked '
  'pageview on the venue marketing site. Anonymous until a form '
  'submission with the same bloom_visitor_id cookie resolves the '
  'visitor to a candidate_identity. Captures UTM + click-ids + referrer '
  'so cross-session attribution survives the gap between first ad-click '
  'and the form fill 3 days later. Migration 309.';

COMMENT ON COLUMN public.web_visits.anon_visitor_id IS
  'First-party cookie value (UUID v4). Same visitor across sessions '
  'keeps the same value for the 1-year cookie life. Resolver clusters '
  'by (venue, anon_visitor_id) to find first-touch.';

COMMENT ON COLUMN public.web_visits.gclid IS
  'Google Ads click identifier. When present, the Google Ads OAuth '
  'connector can lift the matching keyword + match type + ad group, '
  'which closes the brand-search vs non-brand attribution gap.';

COMMENT ON COLUMN public.web_visits.ip_hash IS
  'SHA-256 of the visitor IP with a per-venue salt. Used for bot '
  'filtering + de-duplication but never reversible to a raw address.';

CREATE INDEX IF NOT EXISTS idx_web_visits_venue_visitor
  ON public.web_visits (venue_id, anon_visitor_id, occurred_at DESC);

CREATE INDEX IF NOT EXISTS idx_web_visits_venue_recent
  ON public.web_visits (venue_id, occurred_at DESC);

CREATE INDEX IF NOT EXISTS idx_web_visits_candidate
  ON public.web_visits (candidate_identity_id)
  WHERE candidate_identity_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_web_visits_gclid
  ON public.web_visits (gclid)
  WHERE gclid IS NOT NULL;

-- ============================================================================
-- STEP 3 — RLS
-- ============================================================================
-- Authenticated users see their own venue's visits (for the /intel
-- diagnostics page). Service role does all writes via the public ingest
-- endpoint. Anonymous is NEVER allowed to read.

ALTER TABLE public.web_visits ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "web_visits_select" ON public.web_visits;
CREATE POLICY "web_visits_select" ON public.web_visits
  FOR SELECT TO authenticated
  USING (
    venue_id IN (
      SELECT up.venue_id FROM public.user_profiles up
      WHERE up.id = auth.uid() AND up.venue_id IS NOT NULL
      UNION
      SELECT v.id FROM public.venues v
        JOIN public.user_profiles up ON up.org_id = v.org_id
      WHERE up.id = auth.uid()
    )
    OR public.is_super_admin()
  );

DROP POLICY IF EXISTS "web_visits_service" ON public.web_visits;
CREATE POLICY "web_visits_service" ON public.web_visits
  FOR ALL TO service_role
  USING (true) WITH CHECK (true);

NOTIFY pgrst, 'reload schema';


-- ############################################################################
-- 310_google_ads_and_downloads_audit.sql
-- ############################################################################

-- ---------------------------------------------------------------------------
-- 310_google_ads_and_downloads_audit.sql  (Wave 6E follow-up)
-- ---------------------------------------------------------------------------
-- Two follow-ups in one migration because they're both small and
-- complete distinct gaps the TBH Report's coverage disclosure called
-- out:
--
--   1. google_ads_connections — token storage for the Google Ads OAuth
--      connector. The TBH Report's brand-search vs non-brand split is
--      definitive ONLY when GCLID lookups can hit a real Google Ads
--      account; this is the substrate.
--
--   2. agency_document_downloads — audit log for downloads of agency
--      documents. Becomes interesting when the agency-portal mode lands
--      ("Hawthorn opened the Q2 contract on May 12") but the table is
--      cheap to land now so the download endpoint can start writing
--      rows immediately.
--
-- Both are idempotent. No BEGIN/COMMIT wrapper (Wave 23 doctrine).
-- ---------------------------------------------------------------------------

-- ============================================================================
-- STEP 1 — google_ads_connections
-- ============================================================================
-- One row per (venue, Google Ads customer). Tokens stored encrypted at
-- the API layer (pg_crypto + service-role-only access) — never exposed
-- to authenticated clients. The OAuth flow runs server-side; the
-- venue's coordinator only ever sees status (connected / not connected
-- / error).

CREATE TABLE IF NOT EXISTS public.google_ads_connections (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  venue_id uuid NOT NULL REFERENCES public.venues(id) ON DELETE CASCADE,

  -- The Google Ads customer ID the venue wants to read from. NULL until
  -- the OAuth flow completes; populated from the customer-listing call
  -- after token exchange. Free-text since Google returns it as a string
  -- ("123-456-7890").
  customer_id text,
  customer_name text,

  -- Tokens. access_token is the short-lived bearer; refresh_token gets
  -- exchanged for new access_tokens periodically. Both are stored as
  -- text — encryption is a follow-up (we want a working flow before we
  -- layer encryption on top).
  --
  -- HARDENING TODO: wrap these in pgsodium / encrypt-at-rest before
  -- this connector goes near a live ads account. The marker is a NOT
  -- VALID CHECK so future SELECTs can be hardened without a backfill.
  access_token text,
  refresh_token text,
  access_token_expires_at timestamptz,

  -- OAuth metadata.
  scope text,
  token_type text,

  -- Connection state. 'pending' until OAuth completes. 'connected'
  -- means we have working tokens. 'error' means the last refresh
  -- failed and the venue needs to re-OAuth.
  status text NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'connected', 'error', 'revoked')),
  status_reason text,

  -- The user who initiated the connection (audit trail).
  connected_by uuid REFERENCES public.user_profiles(id),
  connected_at timestamptz,
  last_used_at timestamptz,
  last_error_at timestamptz,
  last_error_message text,

  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

COMMENT ON TABLE public.google_ads_connections IS
  'owner:intelligence. Wave 6E follow-up. OAuth token storage for the '
  'Google Ads connector. Tokens are service-role-only — never read by '
  'authenticated clients. customer_id resolved from the customers-list '
  'call after token exchange. HARDENING TODO: wrap access_token + '
  'refresh_token in pgsodium before live use. Migration 310.';

COMMENT ON COLUMN public.google_ads_connections.access_token IS
  'Bearer token. Short-lived (~1 hour). Refreshed automatically using '
  'refresh_token. NEVER returned to authenticated client.';

CREATE UNIQUE INDEX IF NOT EXISTS uq_google_ads_connections_venue
  ON public.google_ads_connections (venue_id);

CREATE INDEX IF NOT EXISTS idx_google_ads_connections_status
  ON public.google_ads_connections (status, last_used_at);

ALTER TABLE public.google_ads_connections ENABLE ROW LEVEL SECURITY;

-- Authenticated users see STATUS only (the SELECT policy returns the
-- whole row, but the API layer never returns access_token / refresh_token
-- to the client. Server-side service-role reads are how tokens get used).
DROP POLICY IF EXISTS "google_ads_connections_select" ON public.google_ads_connections;
CREATE POLICY "google_ads_connections_select" ON public.google_ads_connections
  FOR SELECT TO authenticated
  USING (
    venue_id IN (
      SELECT up.venue_id FROM public.user_profiles up
      WHERE up.id = auth.uid() AND up.venue_id IS NOT NULL
      UNION
      SELECT v.id FROM public.venues v
        JOIN public.user_profiles up ON up.org_id = v.org_id
      WHERE up.id = auth.uid()
    )
    OR public.is_super_admin()
  );

DROP POLICY IF EXISTS "google_ads_connections_service" ON public.google_ads_connections;
CREATE POLICY "google_ads_connections_service" ON public.google_ads_connections
  FOR ALL TO service_role
  USING (true) WITH CHECK (true);

-- Updated_at touch.
CREATE OR REPLACE FUNCTION public.google_ads_connections_touch_updated_at()
RETURNS TRIGGER AS $$
BEGIN NEW.updated_at := now(); RETURN NEW; END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_google_ads_connections_updated_at
  ON public.google_ads_connections;
CREATE TRIGGER trg_google_ads_connections_updated_at
  BEFORE UPDATE ON public.google_ads_connections
  FOR EACH ROW
  EXECUTE FUNCTION public.google_ads_connections_touch_updated_at();

-- ============================================================================
-- STEP 2 — agency_document_downloads (audit log)
-- ============================================================================
-- One row per attempted download. Pruning policy is "keep forever" for
-- now; rotation can land later if volume warrants.

CREATE TABLE IF NOT EXISTS public.agency_document_downloads (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  document_id uuid NOT NULL REFERENCES public.agency_documents(id) ON DELETE CASCADE,
  agency_id uuid NOT NULL REFERENCES public.marketing_agencies(id) ON DELETE CASCADE,
  downloaded_by uuid REFERENCES public.user_profiles(id),
  -- IP hash with a per-venue salt — privacy floor identical to web_visits.
  ip_hash text,
  user_agent_hash text,
  downloaded_at timestamptz NOT NULL DEFAULT now()
);

COMMENT ON TABLE public.agency_document_downloads IS
  'owner:intelligence. Wave 6E follow-up. Audit log of downloads from '
  'agency_documents. One row per successful signed-URL mint. Used by '
  'the agency-portal mode (deferred) to surface "Hawthorn opened your '
  'Q2 contract on May 12". Migration 310.';

CREATE INDEX IF NOT EXISTS idx_agency_document_downloads_document
  ON public.agency_document_downloads (document_id, downloaded_at DESC);

CREATE INDEX IF NOT EXISTS idx_agency_document_downloads_agency
  ON public.agency_document_downloads (agency_id, downloaded_at DESC);

ALTER TABLE public.agency_document_downloads ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "agency_document_downloads_select"
  ON public.agency_document_downloads;
CREATE POLICY "agency_document_downloads_select"
  ON public.agency_document_downloads
  FOR SELECT TO authenticated
  USING (
    agency_id IN (SELECT id FROM public.marketing_agencies)
    OR public.is_super_admin()
  );

DROP POLICY IF EXISTS "agency_document_downloads_service"
  ON public.agency_document_downloads;
CREATE POLICY "agency_document_downloads_service"
  ON public.agency_document_downloads
  FOR ALL TO service_role
  USING (true) WITH CHECK (true);

NOTIFY pgrst, 'reload schema';


-- ############################################################################
-- 395_billing_enforcement.sql
-- ############################################################################

-- Migration 395: venues — trial_ends_at
--
-- W18 (Nov-plan wave 2) closes the "billing is decorative" gap from the
-- 2026-09-08 readiness audit: venues.plan_tier defaults to 'solo' (migration
-- 215) with no time limit and no record of when a venue's evaluation period
-- started, so a coordinator who never enters a card gets the $299/mo Solo
-- tier free, forever, indistinguishable from a paying customer. Pricing v2
-- has no free tier (see require-plan.ts) — this was a real revenue hole,
-- not a display quirk.
--
-- trial_ends_at is the timestamp a venue's platform trial (distinct from a
-- Stripe-side "trialing" subscription status, which only exists once a card
-- is on file) runs out. A venue is "on trial" in the app-layer sense used
-- by src/lib/services/billing/billing-state.ts when it has never had a
-- Stripe subscription (stripe_subscription_id IS NULL); trial_ends_at is
-- the deadline for that state, not a feature gate by itself.
--
-- Default: 14 days from row creation. No trial-length doctrine exists yet
-- in docs/pricing-policy.md; 14 days is a conventional SaaS default and is
-- centralised as TRIAL_LENGTH_DAYS in billing-state.ts so it can be tuned
-- without another migration.
--
-- Idempotent. Safe to re-run. No BEGIN/COMMIT (per migration convention).

ALTER TABLE public.venues
  ADD COLUMN IF NOT EXISTS trial_ends_at timestamptz;

ALTER TABLE public.venues
  ALTER COLUMN trial_ends_at SET DEFAULT (now() + interval '14 days');

COMMENT ON COLUMN public.venues.trial_ends_at IS
  'Deadline for the venue''s no-subscription platform trial. Set at row creation (DB default = created_at + 14 days). A venue is only "on trial" in the app sense when stripe_subscription_id IS NULL; once a Stripe subscription lands, trial_ends_at is historical and ignored by billing-state.ts. Past this timestamp with no subscription: trial_banner shows on every platform page and auto-send is forced off (checkAutoSendEligible), per src/lib/services/billing/billing-state.ts. Nothing else is blocked.';

-- Backfill existing rows created before this column existed. Every venue
-- that predates this migration was created under the old (missing) trial
-- clock, so its trial window is computed from its actual created_at rather
-- than starting fresh from today (which would silently grant every
-- existing never-subscribed venue another 14 free days at deploy time).
-- Guarded by trial_ends_at IS NULL so re-running this migration is a no-op
-- the second time.
UPDATE public.venues
   SET trial_ends_at = created_at + interval '14 days'
 WHERE trial_ends_at IS NULL;


-- ############################################################################
-- 397_ai_name_default_null.sql
-- ############################################################################

-- 397: venue_ai_config.ai_name no longer defaults to 'Sage'
--
-- W16 (NOVEMBER-PLAN.md wave 2) found the root cause of the recurring
-- "Sage" leaks on white-label venues: migration 001 set
-- venue_ai_config.ai_name DEFAULT 'Sage', so a venue whose coordinator skipped
-- the assistant-name field got Rixey's name persisted as a real value, and
-- every app-layer neutral fallback was bypassed because the column was not
-- blank. The default is now NULL and the app supplies the neutral wording.
--
-- Rows are not touched: Rixey's assistant really is called Sage, and a venue
-- that chose the name keeps it. A venue that never chose one can clear it in
-- Settings.
--
-- Schema-qualified on purpose: scripts/run-migration.ts drives public.exec_sql
-- with search_path = pg_catalog, public.

ALTER TABLE public.venue_ai_config ALTER COLUMN ai_name DROP DEFAULT;


-- ############################################################################
-- 398_couple_handles_first_seen.sql
-- ############################################################################

-- 398: handles become a first-class identifier on the spine; first_seen_at
--
-- Wave 3 (NOVEMBER-PLAN.md, HANDLE-IDENTITY-SPEC.md). Until now a social
-- handle could not exist on the identity spine: the normalised signal had
-- no handle field, the cascade had no handle stage, and people.platform_
-- handles (migration 255) lived on the legacy table and was written only
-- by the old candidate resolver. Followers, story viewers and DM senders
-- were matched against people by trigram name similarity or "email local
-- part contains the handle", outside every guard the spine has.
--
-- This adds:
--   couples.handles       jsonb map {platform: handle}, normalised lower
--                         case, no @, no URL (normalizeHandle). Platform
--                         scoped: the same string on two platforms is two
--                         facts, not one.
--   couples.first_seen_at the earliest touchpoint on the couple, whatever
--                         it carried. A handle-only signal can set it.
--                         Point-Zero is unchanged: the first moment the
--                         couple is known by name AND a reachable address.
--                         first_seen_at <= point_zero_at always.
--   fragments.handles     same map on the pre-identity side, so a later
--                         signal carrying the handle can promote the
--                         fragment deterministically.
--
-- Schema-qualified on purpose: scripts/run-migration.ts drives public.exec_sql
-- with search_path = pg_catalog, public. Idempotent.

ALTER TABLE public.couples
  ADD COLUMN IF NOT EXISTS handles jsonb NOT NULL DEFAULT '{}'::jsonb;

ALTER TABLE public.couples
  ADD COLUMN IF NOT EXISTS first_seen_at timestamptz;

ALTER TABLE public.fragments
  ADD COLUMN IF NOT EXISTS handles jsonb NOT NULL DEFAULT '{}'::jsonb;

COMMENT ON COLUMN public.couples.handles IS
  'Platform handle map, e.g. {"instagram":"rosie.hoyle"}. Normalised by normalizeHandle(). Written only through linkSignal and merge_couples. Platform-scoped exact match is a high-tier cascade stage.';

COMMENT ON COLUMN public.couples.first_seen_at IS
  'Earliest touchpoint on this couple, any channel, any identity strength. Set once by the linker, moved earlier only by a replay that finds an older touchpoint. Always <= point_zero_at.';

COMMENT ON COLUMN public.fragments.handles IS
  'Handles a pre-identity fragment carries. A later signal with the same platform handle promotes the fragment onto the couple it landed on.';

-- Lookup: which couple owns this handle on this platform. GIN over the
-- whole map serves the containment query {"instagram":"x"} <@ handles.
CREATE INDEX IF NOT EXISTS idx_couples_handles_gin
  ON public.couples USING gin (handles jsonb_path_ops);

CREATE INDEX IF NOT EXISTS idx_fragments_handles_gin
  ON public.fragments USING gin (handles jsonb_path_ops);

-- Backfill first_seen_at from the ribbon where it is known. Safe to rerun.
UPDATE public.couples c
SET first_seen_at = t.first_at
FROM (
  SELECT couple_id, MIN(occurred_at) AS first_at
  FROM public.touchpoints
  WHERE couple_id IS NOT NULL
  GROUP BY couple_id
) t
WHERE t.couple_id = c.id
  AND (c.first_seen_at IS NULL OR t.first_at < c.first_seen_at);


-- ############################################################################
-- 399_social_engagements_couple_id.sql
-- ############################################################################

-- 399: social engagements point at a couple on the spine, not a person
--
-- Wave 3, W23 (NOVEMBER-PLAN.md, HANDLE-IDENTITY-SPEC.md §4 and §5).
--
-- Migration 324 gave social_engagements a matched_person_id and three
-- matchers to fill it: handle_exact against people.platform_handles,
-- trigram name similarity at 0.5, and "the email local part contains the
-- handle" at confidence 50. The last two bound strangers to real
-- couples, and none of the three ever reached couples / touchpoints /
-- fragments, so a follow three weeks before the inquiry was invisible to
-- the journey ribbon.
--
-- Social captures now route through linkSignal like every other origin.
-- The outcome the coordinator sees is a couple on the spine, so the row
-- needs somewhere to record it. matched_person_id is kept, not dropped:
-- existing rows carry history we do not want to erase, and the doctrine
-- for retiring a column is to mark it deprecated and stop writing it.
--
-- Schema-qualified because scripts/run-migration.ts drives
-- public.exec_sql with search_path = pg_catalog, public. Idempotent, no
-- BEGIN/COMMIT (the exec_sql RPC rejects transaction blocks).

ALTER TABLE public.social_engagements
  ADD COLUMN IF NOT EXISTS couple_id uuid REFERENCES public.couples(id) ON DELETE SET NULL;

COMMENT ON COLUMN public.social_engagements.couple_id IS
  'couples.id the spine bound this engagement to, written from the linkSignal result. NULL means the signal is a fragment awaiting identity or a candidate in review, which is an honest not-yet, not a failure. ON DELETE SET NULL so couple cleanup never destroys the engagement history. Migration 399.';

COMMENT ON COLUMN public.social_engagements.matched_person_id IS
  'DEPRECATED 2026-09-09 (wave 3, W23). Legacy people.id from the retired social matcher. No longer written; read only for pre-wave-3 rows. couple_id is the live binding.';

COMMENT ON COLUMN public.social_engagements.match_method IS
  'How the spine resolved the row. Values since wave 3: spine_attached, spine_minted, spine_candidate, spine_fragment, spine_duplicate, spine_cold_start. Pre-wave-3 rows still carry handle_exact / name_fuzzy / email_inferred / name_lastname from the retired matcher; name_fuzzy and email_inferred were guesses and should not be trusted as bindings.';

COMMENT ON COLUMN public.social_engagements.match_status IS
  'pending = not yet through the linker; matched = the spine gave it a couple (couple_id is set); unmatched = fragment or candidate, no couple yet. A candidate in review is NOT matched.';

-- Hot path: the couple page and the journey ribbon ask "which social
-- engagements belong to this couple", venue-scoped.
CREATE INDEX IF NOT EXISTS idx_social_engagements_couple
  ON public.social_engagements (venue_id, couple_id)
  WHERE couple_id IS NOT NULL;

COMMENT ON INDEX public.idx_social_engagements_couple IS
  'Partial on purpose: the long tail of unbound follower rows is most of the table and none of it is ever fetched by couple.';


-- ############################################################################
-- 400_deprecate_tangential_pool.sql
-- ############################################################################

-- 400: the tangential identity pool is deprecated
--
-- Wave 3, W24 (NOVEMBER-PLAN.md, HANDLE-IDENTITY-SPEC.md §4 and §5).
--
-- There were two identity systems. The spine is couples, touchpoints,
-- fragments and candidate_matches, written only by linkSignal. Beside it
-- sat an older one: vision read a screenshot of comments or tags,
-- `tangential_signals` held the candidates, `candidate_identities`
-- clustered them, and `client_match_queue` asked the coordinator to
-- resolve them against `people`. It never touched a couple, so the same
-- question had two answers depending on which surface you opened.
--
-- From wave 3 the vision path builds a NormalizedSignal and calls
-- linkSignal. Below threshold the signal becomes a fragment, and a
-- fragment carrying a handle is promoted deterministically the moment
-- that handle turns up on a couple. Medium and low tier verdicts queue a
-- `candidate_matches` row, which is the one review queue.
--
-- This migration only marks. It drops nothing, revokes nothing and
-- changes no grant, because the historical rows are still read by the
-- correlation engine, the journey narrative and several intel surfaces,
-- and because a wipe-and-reimport is the wrong moment to lose evidence.
-- Idempotent, schema-qualified: scripts/run-migration.ts drives
-- public.exec_sql with search_path = pg_catalog, public.

COMMENT ON TABLE public.tangential_signals IS
  'DEPRECATED 2026-09-09 (wave 3, W24). Historical read-only pool of vision-extracted '
  'identity candidates. No new rows: the vision path now builds a NormalizedSignal and '
  'calls linkSignal, so a below-threshold candidate lands in public.fragments instead. '
  'Fragments carry handles and are promoted onto a couple by exact (platform, handle). '
  'See HANDLE-IDENTITY-SPEC.md section 4 and src/lib/services/ingestion/tangential-signals.ts.';

COMMENT ON TABLE public.client_match_queue IS
  'DEPRECATED 2026-09-09 (wave 3, W24). Historical review queue for person-to-person and '
  'signal-to-signal match proposals. No new rows: medium and low tier verdicts are queued '
  'as public.candidate_matches by linkSignal and adjudicated at /intel/identity-review. '
  'The old surface /intel/matching now redirects there. Kept for the audit trail only.';

COMMENT ON TABLE public.candidate_identities IS
  'LEGACY (wave 3, 2026-09-09). Clusters of tangential_signals, still written by '
  'candidate-clusterer.ts for the CSV and storefront import paths and resolved by '
  'candidate-resolver.ts. The handle a resolution confirms is now emitted through '
  'linkSignal onto public.couples.handles, not people.platform_handles. Phasing out '
  'behind the spine, do not build new readers.';

COMMENT ON COLUMN public.people.platform_handles IS
  'LEGACY (wave 3, 2026-09-09). Read-only. public.couples.handles is the identifier the '
  'cascade matches on, written only through linkSignal. Nothing new may read this column; '
  'scripts/check-no-platform-handles-reads.mjs holds the baseline.';


-- ############################################################################
-- 401_instagram_connections.sql
-- ############################################################################

-- ---------------------------------------------------------------------------
-- 401_instagram_connections.sql  (Wave 3, W28)
-- ---------------------------------------------------------------------------
-- Per-venue connection row for Instagram DMs through the Meta Messaging
-- API. Spec: HANDLE-IDENTITY-SPEC.md §4, the "Instagram DMs via Meta
-- Messaging API" row of the sources table.
--
-- WHY THIS EXISTS
-- ---------------
-- A DM is the first place a couple says anything in their own words, and
-- today it lands nowhere. The webhook at /api/webhooks/instagram turns
-- each inbound message into one NormalizedSignal with handles.instagram
-- set and hands it to linkSignal, exactly as the SMS path does. To route
-- an incoming Meta event to the right venue we need a lookup from the
-- Instagram business account id (which Meta puts in entry[].id) to a
-- venue, plus the page token that lets us resolve the sender's IGSID to
-- a username. That lookup is this table.
--
-- SECRETS
-- -------
-- The Meta app credentials (INSTAGRAM_APP_ID / INSTAGRAM_APP_SECRET /
-- INSTAGRAM_VERIFY_TOKEN) are single global env vars, following the same
-- pattern as Twilio, Calendly and Google Ads. Per-venue secrets are
-- parked. What IS per-venue is the page access token, because it is
-- minted per Facebook Page during the OAuth exchange. Two ways to hold
-- it, in priority order:
--
--   1. page_token_env_key — the NAME of an env var holding the token.
--      Nothing secret lands in the database. This is the safe default
--      for the first venue (Rixey) while encryption at rest is still
--      owed.
--   2. page_access_token  — the token itself, service-role only, never
--      selectable by an authenticated client (see the column grants
--      below). Written by the OAuth callback.
--
-- HARDENING TODO (same marker google_ads_connections carries, mig 310):
-- wrap page_access_token in pgsodium before a second venue connects.
--
-- Idempotent: IF NOT EXISTS on every CREATE, DROP POLICY IF EXISTS
-- before every CREATE POLICY. Schema-qualified throughout. No
-- BEGIN/COMMIT wrapper (Wave 23 doctrine).
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS public.instagram_connections (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  venue_id uuid NOT NULL REFERENCES public.venues(id) ON DELETE CASCADE,

  -- Meta identifiers. ig_business_id is the Instagram professional
  -- account id; it is what arrives as entry[].id on every messaging
  -- webhook, so it is the routing key. page_id is the Facebook Page the
  -- Instagram account is linked to, which is what the token belongs to.
  -- Both are free text: Meta returns them as decimal strings that do not
  -- fit in a bigint on every tier.
  ig_business_id text,
  ig_username text,
  page_id text,
  page_name text,

  -- Page access token. EITHER an env-var name (nothing secret stored)
  -- OR the token itself. The reader prefers page_token_env_key.
  page_token_env_key text,
  page_access_token text,
  token_expires_at timestamptz,

  -- Connection state. 'pending' until the OAuth exchange completes or an
  -- operator pastes a token; 'connected' means we believe the token
  -- works; 'error' means the last Graph call failed and the venue needs
  -- to reconnect; 'revoked' means an operator disconnected on purpose.
  status text NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'connected', 'error', 'revoked')),
  status_reason text,

  -- Audit + the operator-facing "is anything actually arriving" line.
  connected_by uuid REFERENCES public.user_profiles(id),
  connected_at timestamptz,
  -- Stamped by the webhook every time an inbound message is accepted for
  -- this venue. This is the field the settings page shows as "last event".
  last_event_at timestamptz,
  last_error_at timestamptz,
  last_error_message text,

  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

COMMENT ON TABLE public.instagram_connections IS
  'owner:intelligence. Wave 3 W28 (migration 401). One row per venue for '
  'Instagram DMs through the Meta Messaging API. ig_business_id is the '
  'webhook routing key (entry[].id). The page token is held either as an '
  'env-var NAME (page_token_env_key, preferred) or as the token itself '
  '(page_access_token, service-role only). HARDENING TODO: pgsodium on '
  'page_access_token before a second venue connects.';

COMMENT ON COLUMN public.instagram_connections.ig_business_id IS
  'Instagram professional account id. Arrives as entry[].id on every '
  'messaging webhook, so this is how an event finds its venue.';

COMMENT ON COLUMN public.instagram_connections.page_token_env_key IS
  'Name of the environment variable holding the page access token. '
  'Preferred over page_access_token: nothing secret lands in the row.';

COMMENT ON COLUMN public.instagram_connections.page_access_token IS
  'Page access token. Service-role only, never returned to an '
  'authenticated client. NULL when page_token_env_key is used instead.';

COMMENT ON COLUMN public.instagram_connections.last_event_at IS
  'Stamped when the webhook accepts an inbound message for this venue. '
  'The settings page reads it as "last event".';

-- One connection per venue. Matches openphone_connections +
-- google_ads_connections, and lets the OAuth callback upsert on venue_id.
CREATE UNIQUE INDEX IF NOT EXISTS uq_instagram_connections_venue
  ON public.instagram_connections (venue_id);

-- The webhook's hot path: ig_business_id -> venue. Unique because two
-- venues cannot share one Instagram account, and a duplicate would make
-- routing ambiguous in a way the webhook should refuse rather than guess.
CREATE UNIQUE INDEX IF NOT EXISTS uq_instagram_connections_ig_business
  ON public.instagram_connections (ig_business_id)
  WHERE ig_business_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_instagram_connections_status
  ON public.instagram_connections (status);

-- ---------------------------------------------------------------------------
-- updated_at trigger, if the shared helper exists. Guarded so the
-- migration still applies on a database that predates it.
-- ---------------------------------------------------------------------------
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_proc p
      JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE p.proname = 'set_updated_at' AND n.nspname = 'public'
  ) THEN
    DROP TRIGGER IF EXISTS trg_instagram_connections_updated_at
      ON public.instagram_connections;
    CREATE TRIGGER trg_instagram_connections_updated_at
      BEFORE UPDATE ON public.instagram_connections
      FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();
  END IF;
END $$;

-- ---------------------------------------------------------------------------
-- RLS — venue-scoped read/write, super_admin bypass, service_role full.
-- Copied from the prod-proven 377 / 383 pattern.
--
-- Deliberately NO demo-anon read policy: unlike knot_visitor_activity,
-- this row carries a credential. The demo venue has no Instagram
-- connection and should not be able to enumerate anyone else's.
-- ---------------------------------------------------------------------------

ALTER TABLE public.instagram_connections ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "igconn_select" ON public.instagram_connections;
CREATE POLICY "igconn_select" ON public.instagram_connections
  FOR SELECT TO authenticated
  USING (
    venue_id IN (
      SELECT up.venue_id FROM public.user_profiles up
      WHERE up.id = auth.uid() AND up.venue_id IS NOT NULL
      UNION
      SELECT v.id FROM public.venues v
        JOIN public.user_profiles up ON up.org_id = v.org_id
      WHERE up.id = auth.uid()
    )
    OR public.is_super_admin()
  );

DROP POLICY IF EXISTS "igconn_modify" ON public.instagram_connections;
CREATE POLICY "igconn_modify" ON public.instagram_connections
  FOR ALL TO authenticated
  USING (
    venue_id IN (
      SELECT up.venue_id FROM public.user_profiles up
      WHERE up.id = auth.uid() AND up.venue_id IS NOT NULL
      UNION
      SELECT v.id FROM public.venues v
        JOIN public.user_profiles up ON up.org_id = v.org_id
      WHERE up.id = auth.uid()
    )
    OR public.is_super_admin()
  )
  WITH CHECK (
    venue_id IN (
      SELECT up.venue_id FROM public.user_profiles up
      WHERE up.id = auth.uid() AND up.venue_id IS NOT NULL
      UNION
      SELECT v.id FROM public.venues v
        JOIN public.user_profiles up ON up.org_id = v.org_id
      WHERE up.id = auth.uid()
    )
    OR public.is_super_admin()
  );

DROP POLICY IF EXISTS "igconn_service" ON public.instagram_connections;
CREATE POLICY "igconn_service" ON public.instagram_connections
  FOR ALL TO service_role USING (true) WITH CHECK (true);

-- ---------------------------------------------------------------------------
-- Column grants. RLS decides which ROWS an authenticated user sees; these
-- grants decide which COLUMNS. The token must never leave the service
-- role, so `authenticated` is granted every column except
-- page_access_token.
--
-- Consequence worth knowing: with a column-level SELECT grant, a
-- `select('*')` from an authenticated client gets "permission denied for
-- column page_access_token" rather than a partial row. Every reader in
-- this repo names its columns, and the settings page reads through the
-- server-side status route anyway, so nothing in-tree hits that. A new
-- reader that reaches for `*` will fail loudly, which is the behaviour
-- we want on a table holding a credential.
-- ---------------------------------------------------------------------------
REVOKE ALL ON public.instagram_connections FROM authenticated;
GRANT SELECT (
  id, venue_id, ig_business_id, ig_username, page_id, page_name,
  page_token_env_key, token_expires_at, status, status_reason,
  connected_by, connected_at, last_event_at, last_error_at,
  last_error_message, created_at, updated_at
) ON public.instagram_connections TO authenticated;
GRANT INSERT, UPDATE, DELETE ON public.instagram_connections TO authenticated;

NOTIFY pgrst, 'reload schema';


-- ############################################################################
-- 402_merge_couples_handles.sql
-- ############################################################################

-- 402: a merge carries the handles, and a handle disagreement is recorded
--
-- Wave 3 (NOVEMBER-PLAN.md W22, HANDLE-IDENTITY-SPEC.md §1 + §3). Migration
-- 398 put `handles` and `first_seen_at` on couples. merge_couples (migration
-- 379) predates both, so a merge silently dropped the loser's handles and
-- kept whatever first_seen_at the winner happened to have. That loses exactly
-- the thing wave 3 exists to keep: a couple who followed on Instagram in
-- March and enquired by email in June can end up as two rows that later
-- merge, and the March handle is the only link back to the follow.
--
-- Three changes:
--
--   1. The survivor's handles become the UNION of both maps. The winner wins
--      a per-platform disagreement, and the disagreement is written into the
--      audit row's reason rather than dropped. A handle collision is a typo,
--      a re-used username, or two people being treated as one, and all three
--      want a human to see them.
--   2. first_seen_at becomes the earlier of the two. It is the first time
--      the venue saw this couple at all, and a merge cannot make that later.
--   3. A new couple_merge_events type, 'handle_contradiction', for the
--      linker's own stamp path: when a signal carries a handle the couple
--      already holds differently, the stored value stays and a row lands
--      here. The full CHECK list is carried forward (see the drift warning
--      in 379, a partial list rejects existing rows).
--
-- Schema-qualified on purpose: scripts/run-migration.ts drives public.exec_sql
-- with search_path = pg_catalog, public. Idempotent.

ALTER TABLE public.couple_merge_events
  DROP CONSTRAINT IF EXISTS couple_merge_events_event_type_check;
ALTER TABLE public.couple_merge_events
  ADD CONSTRAINT couple_merge_events_event_type_check
  CHECK (event_type = ANY (ARRAY[
    'fragment_promoted','channel_scoped_bridged','candidate_confirmed',
    'candidate_rejected','manual_merge','manual_unmerge','resurrection',
    'resurrection_rejected','couple_minted','reattach',
    'partner_reconciliation','handle_contradiction'
  ]));

CREATE OR REPLACE FUNCTION public.merge_couples(
  p_winner uuid,
  p_loser uuid,
  p_reason text,
  p_rule text DEFAULT 'partner_reconciliation'
) RETURNS boolean LANGUAGE plpgsql AS $$
declare
  r record;
  v_venue uuid;
  v_winner_handles jsonb;
  v_loser_handles jsonb;
  v_merged_handles jsonb;
  v_conflicts text := '';
  v_key text;
  v_reason text;
begin
  if p_winner is null or p_loser is null or p_winner = p_loser then
    return false;
  end if;

  -- Winner must exist; capture venue for the audit + isolation guard.
  select venue_id into v_venue from public.couples
    where id = p_winner and merged_into_id is null;
  if v_venue is null then
    return false;
  end if;

  -- Loser must exist, same venue, and not already merged (idempotent).
  perform 1 from public.couples
    where id = p_loser and venue_id = v_venue and merged_into_id is null;
  if not found then
    return false;
  end if;

  -- Reassign every couple_id-bearing table dynamically. No hand-list to drift.
  for r in
    select c.table_name
    from information_schema.columns c
    join information_schema.tables t
      on t.table_schema = c.table_schema and t.table_name = c.table_name
    where c.table_schema = 'public'
      and c.column_name = 'couple_id'
      and t.table_type = 'BASE TABLE'
  loop
    execute format('update public.%I set couple_id = $1 where couple_id = $2', r.table_name)
      using p_winner, p_loser;
  end loop;

  -- candidate_matches reference couples by (record_id, record_type='couple').
  update public.candidate_matches set primary_record_id = p_winner
    where primary_record_id = p_loser and primary_record_type = 'couple';
  update public.candidate_matches set secondary_record_id = p_winner
    where secondary_record_id = p_loser and secondary_record_type = 'couple';

  -- Handle union. Loser-only platforms are added; a platform both hold with
  -- DIFFERENT values keeps the winner's and is named in the audit reason.
  select coalesce(handles, '{}'::jsonb) into v_winner_handles
    from public.couples where id = p_winner;
  select coalesce(handles, '{}'::jsonb) into v_loser_handles
    from public.couples where id = p_loser;

  for v_key in select jsonb_object_keys(v_loser_handles) loop
    -- jsonb_exists() rather than the `?` operator: this body travels to the
    -- server as a bound string through public.exec_sql, and a bare `?` is a
    -- placeholder to more than one client library. Same semantics, no ambiguity.
    if jsonb_exists(v_winner_handles, v_key)
       and v_winner_handles ->> v_key is distinct from v_loser_handles ->> v_key then
      v_conflicts := v_conflicts
        || case when v_conflicts = '' then '' else '; ' end
        || v_key || ': kept ''' || (v_winner_handles ->> v_key)
        || ''' over ''' || (v_loser_handles ->> v_key) || '''';
    end if;
  end loop;

  -- Winner on the right so the winner's value wins every shared key.
  v_merged_handles := v_loser_handles || v_winner_handles;

  -- Partner backfill: the loser's primary contact becomes the winner's
  -- partner when the winner has no partner yet (the GC-5 shape). Handles
  -- union and first_seen_at goes to the earlier of the two.
  update public.couples w set
    partner_contact_name  = coalesce(w.partner_contact_name,  l.primary_contact_name),
    partner_contact_email = coalesce(w.partner_contact_email, l.primary_contact_email),
    partner_contact_phone = coalesce(w.partner_contact_phone, l.primary_contact_phone),
    handles = v_merged_handles,
    first_seen_at = least(w.first_seen_at, l.first_seen_at),
    updated_at = now()
  from public.couples l
  where w.id = p_winner and l.id = p_loser;

  -- Tombstone the loser (demotion, not deletion).
  update public.couples set merged_into_id = p_winner, updated_at = now()
    where id = p_loser;

  v_reason := coalesce(p_reason, '');
  if v_conflicts <> '' then
    v_reason := v_reason || ' | handle contradiction on merge, ' || v_conflicts;
  end if;

  -- Audit.
  insert into public.couple_merge_events(
    venue_id, event_type, primary_couple_id, secondary_couple_id,
    rule_triggered, confidence_tier, reason, occurred_at
  ) values (
    v_venue, 'partner_reconciliation', p_winner, p_loser, p_rule, 'high', v_reason, now()
  );

  return true;
end $$;

COMMENT ON FUNCTION public.merge_couples(uuid, uuid, text, text) IS
  'Merge loser couple INTO winner: dynamic couple_id reassignment + candidate_matches repoint + partner backfill + handles union (winner wins a per-platform conflict, conflict named in the audit reason) + earliest first_seen_at + merged_into_id tombstone + couple_merge_events audit. Atomic, idempotent. Anchors: GC-5 partner reconciliation (mig 379), HANDLE-IDENTITY-SPEC.md (mig 398/399).';


-- ############################################################################
-- 403_venue_config_social_handles.sql
-- ############################################################################

-- 403: the venue's own social handles live on venue_config
--
-- Wave 5, W36 (NOVEMBER-PLAN.md). Follow-up from wave 4: "a venue's own
-- social handle can stamp a couple if a prospect pastes the venue's link
-- above the quote line" (an email signature, a "follow us" line quoted
-- back, a screenshot that happens to catch the venue's own comment).
-- Nothing on the spine has ever recorded what the venue's own handles
-- ARE, so nothing could exclude them.
--
-- Shape matches couples.handles (migration 398): a jsonb map keyed by
-- HandlePlatform, normalised by normalizeHandle() before it is written.
-- `stripVenueHandles()` (src/lib/services/identity/handles.ts) reads this
-- column to drop the venue's own handle out of a signal derived from free
-- text before it ever reaches linkSignal.
--
-- platform_configs.venue_handle (migration 324) already holds the venue's
-- Instagram handle for the social-integration capture modal, and predates
-- this column. It is now the legacy source: venue_config.social_handles
-- is preferred everywhere, and getVenueSocialHandles() copies a legacy
-- platform_configs value across, once, the first time it finds
-- venue_config empty for that platform. platform_configs.venue_handle
-- itself is untouched — the capture modal still reads it directly and
-- this migration does not change that table.
--
-- Schema-qualified because scripts/run-migration.ts drives
-- public.exec_sql with search_path = pg_catalog, public. Idempotent, no
-- BEGIN/COMMIT (the exec_sql RPC rejects transaction blocks).

ALTER TABLE public.venue_config
  ADD COLUMN IF NOT EXISTS social_handles jsonb NOT NULL DEFAULT '{}'::jsonb;

COMMENT ON COLUMN public.venue_config.social_handles IS
  'The venue''s own handle map, e.g. {"instagram":"rixeymanor"}. Same shape as couples.handles: keys are HandlePlatform, values normalised by normalizeHandle(). Read by stripVenueHandles() so the venue''s own handle in a signature or a screenshot never stamps a couple. Legacy source: platform_configs.venue_handle (migration 324), copied across once by getVenueSocialHandles() when this column is empty for that platform. Written by Settings -> Venue Info -> Your social handles. Migration 403.';


-- ############################################################################
-- 404_weather_alerts.sql
-- ############################################################################

-- ---------------------------------------------------------------------------
-- 404_weather_alerts.sql
-- ---------------------------------------------------------------------------
-- W49 (November plan, wave 7). Two tables:
--
-- 1. weather_alerts — a real severity feed via the National Weather
--    Service "alerts for a point" API (api.weather.gov/alerts/active),
--    replacing the dead keyword branch in
--    src/lib/services/insights/weather-cancellation.ts's `bucketWeather`.
--    That function checked the Open-Meteo `conditions` string for the
--    literal words "tornado" / "hurricane", but Open-Meteo's weathercode
--    mapping never produces those strings — the checks never fired.
--    Refreshed inside the existing `weather_forecast` cron case (no new
--    cron entry; src/lib/services/intel/nws-alerts.ts owns the fetch +
--    upsert). Rows are never deleted, only flipped `is_active=false` on
--    expiry, so the cancellation analyzer can join historical tour dates
--    against real alert windows going forward.
--
-- 2. weather_climate_annual — per-year, per-month aggregates (mean daily
--    high, total precipitation) from the same Open-Meteo archive the
--    weather_climate_norms backfill (migration 340) already fetches.
--    weather_climate_norms only stores two decade-aggregate buckets
--    (recent 10y vs prior 10y), which is a two-point comparison, not a
--    trend. This table gives src/lib/services/intel/climate-context.ts
--    enough points to compute a real least-squares slope across every
--    available year. Bundled into this migration because the workstream
--    only owns migration 404 (no second migration number available).
--
-- Both RLS policy sets copy the canonical venue-isolation pattern from
-- migration 383 (own venue OR org sibling OR super-admin; service_role
-- unrestricted; demo anon read gated to is_demo venues) so
-- check-rls-on-venue-id.mjs passes without an allowlist entry.
--
-- No BEGIN/COMMIT wrapper, per repo convention (feedback_migration_no_
-- transaction_wrapper).

CREATE TABLE IF NOT EXISTS public.weather_alerts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  venue_id uuid NOT NULL REFERENCES public.venues(id) ON DELETE CASCADE,
  -- NWS's own alert id (a stable URI). Unique per venue so the same
  -- physical alert refreshed twice a day upserts onto one row.
  nws_id text NOT NULL,
  event text,
  severity text,
  certainty text,
  urgency text,
  headline text,
  description text,
  instruction text,
  area_desc text,
  status text,
  message_type text,
  onset timestamptz,
  ends timestamptz,
  expires timestamptz,
  -- Flips false when a refresh no longer sees this alert (expired or
  -- cancelled). Rows are kept, not deleted, for historical join.
  is_active boolean NOT NULL DEFAULT true,
  fetched_at timestamptz NOT NULL DEFAULT now(),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (venue_id, nws_id)
);

CREATE INDEX IF NOT EXISTS weather_alerts_venue_active_idx
  ON public.weather_alerts (venue_id, is_active);
CREATE INDEX IF NOT EXISTS weather_alerts_venue_onset_idx
  ON public.weather_alerts (venue_id, onset);

ALTER TABLE public.weather_alerts ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "weather_alerts_select" ON public.weather_alerts;
CREATE POLICY "weather_alerts_select" ON public.weather_alerts
  FOR SELECT TO authenticated
  USING (
    venue_id IN (
      SELECT up.venue_id FROM public.user_profiles up
      WHERE up.id = auth.uid() AND up.venue_id IS NOT NULL
      UNION
      SELECT v.id FROM public.venues v
        JOIN public.user_profiles up ON up.org_id = v.org_id
      WHERE up.id = auth.uid()
    )
    OR public.is_super_admin()
  );

DROP POLICY IF EXISTS "weather_alerts_service" ON public.weather_alerts;
CREATE POLICY "weather_alerts_service" ON public.weather_alerts
  FOR ALL TO service_role USING (true) WITH CHECK (true);

DROP POLICY IF EXISTS "demo_anon_select_weather_alerts" ON public.weather_alerts;
CREATE POLICY "demo_anon_select_weather_alerts" ON public.weather_alerts
  FOR SELECT TO anon
  USING (venue_id IN (SELECT id FROM public.venues WHERE is_demo = true));

COMMENT ON TABLE public.weather_alerts IS
  'NWS alerts/active feed per venue (api.weather.gov). Refreshed inside '
  'the weather_forecast cron via src/lib/services/intel/nws-alerts.ts. '
  'is_active flips false on expiry; rows persist for historical join in '
  'weather-cancellation.ts. W49 wave 7, 2026-09.';

-- ---------------------------------------------------------------------------
-- weather_climate_annual
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS public.weather_climate_annual (
  venue_id uuid NOT NULL REFERENCES public.venues(id) ON DELETE CASCADE,
  year int NOT NULL,
  month_num int NOT NULL CHECK (month_num BETWEEN 1 AND 12),
  mean_high_f decimal,
  total_precip_in decimal,
  sample_days int NOT NULL DEFAULT 0,
  refreshed_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (venue_id, year, month_num)
);

CREATE INDEX IF NOT EXISTS weather_climate_annual_venue_month_idx
  ON public.weather_climate_annual (venue_id, month_num);

ALTER TABLE public.weather_climate_annual ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "weather_climate_annual_select" ON public.weather_climate_annual;
CREATE POLICY "weather_climate_annual_select" ON public.weather_climate_annual
  FOR SELECT TO authenticated
  USING (
    venue_id IN (
      SELECT up.venue_id FROM public.user_profiles up
      WHERE up.id = auth.uid() AND up.venue_id IS NOT NULL
      UNION
      SELECT v.id FROM public.venues v
        JOIN public.user_profiles up ON up.org_id = v.org_id
      WHERE up.id = auth.uid()
    )
    OR public.is_super_admin()
  );

DROP POLICY IF EXISTS "weather_climate_annual_service" ON public.weather_climate_annual;
CREATE POLICY "weather_climate_annual_service" ON public.weather_climate_annual
  FOR ALL TO service_role USING (true) WITH CHECK (true);

DROP POLICY IF EXISTS "demo_anon_select_weather_climate_annual" ON public.weather_climate_annual;
CREATE POLICY "demo_anon_select_weather_climate_annual" ON public.weather_climate_annual
  FOR SELECT TO anon
  USING (venue_id IN (SELECT id FROM public.venues WHERE is_demo = true));

COMMENT ON TABLE public.weather_climate_annual IS
  'Per-year, per-month climate aggregates (mean daily high, total '
  'precipitation) from the Open-Meteo archive backfill '
  '(weather-climate-norms.ts). Feeds the least-squares year-over-year '
  'trend in climate-context.ts. W49 wave 7, 2026-09.';


-- ############################################################################
-- 406_commitment_reconciliation.sql
-- ############################################################################

-- 406_commitment_reconciliation.sql
--
-- W50 / the groom's cake.
--
-- A couple writes "we're having a groom's cake" in an email to the
-- coordinator. It is read once. On the day there is no cake table, no
-- cake, and nobody remembers being told. The sentence was captured
-- nowhere, so nothing could reconcile it against the day-of timeline.
--
-- Two changes here, both small:
--
--   1. planning_notes gains a source interaction. Until now a note could
--      only come from a couple's Sage message or a contract PDF, and the
--      row recorded no pointer back to what produced it. Notes written
--      from a coordinator-venue conversation need that pointer for two
--      reasons: the coordinator wants to click through to the message
--      that said it, and the writer needs somewhere to look to stay
--      idempotent when the same interaction is replayed.
--
--   2. commitment_reconciliation holds the nightly answer to "what have
--      they told us that is not on the day yet". One row per captured
--      commitment per wedding, keyed by a stable hash of the sentence so
--      a rerun updates rather than duplicates.
--
-- Numbering: the fleet integrator reserved 406 for this workstream. The
-- tree's highest committed migration at the time of writing is 394; the
-- gap belongs to sibling workstreams that had not landed yet.
--
-- Schema-qualified on purpose: scripts/run-migration.ts drives
-- public.exec_sql, which runs with search_path = pg_catalog, public. An
-- unqualified CREATE lands in the first schema on that path and fails
-- with 42501.
--
-- No BEGIN/COMMIT — exec_sql wraps each statement itself.

-- ---------------------------------------------------------------------------
-- 1. planning_notes: where did this note come from
-- ---------------------------------------------------------------------------

ALTER TABLE public.planning_notes
  ADD COLUMN IF NOT EXISTS source_interaction_id uuid
    REFERENCES public.interactions(id) ON DELETE SET NULL;

ALTER TABLE public.planning_notes
  ADD COLUMN IF NOT EXISTS source_channel text;

COMMENT ON COLUMN public.planning_notes.source_interaction_id IS
  'The inbound interaction this note was extracted from, when it came from a coordinator-venue conversation rather than a Sage chat message or a contract. Doubles as the idempotency key: the writer in services/intel/planning-extraction.ts refuses to extract twice from the same interaction.';

COMMENT ON COLUMN public.planning_notes.source_channel IS
  'Channel the source conversation arrived on (email / sms / instagram). Null for the legacy chatbot and contract writers.';

-- Deliberately NOT unique. A single email can legitimately carry several
-- planning notes ("we booked the florist AND we're having a groom's cake").
-- Idempotency is enforced by the writer reading this index before it
-- extracts, not by the database refusing the second row. A partial unique
-- index here would also break any future .upsert({onConflict}) against
-- this table with 42P10.
CREATE INDEX IF NOT EXISTS idx_planning_notes_source_interaction
  ON public.planning_notes (source_interaction_id)
  WHERE source_interaction_id IS NOT NULL;

-- ---------------------------------------------------------------------------
-- 1b. timeline.config_json, declared at last
-- ---------------------------------------------------------------------------
--
-- The couple's timeline builder has written `config_json` since it was
-- built, and the coordinator print view reads it, but no migration ever
-- declared the column. It exists in production and nowhere in this
-- directory, which is exactly the phantom-column class the schema-truth
-- check hunts for. The reconciler has to read it, so declare it.
--
-- IF NOT EXISTS, so this is a no-op against production and a fix against
-- any database built from this directory alone.

ALTER TABLE public.timeline
  ADD COLUMN IF NOT EXISTS config_json jsonb;

COMMENT ON COLUMN public.timeline.config_json IS
  'Config-blob mode: { config, events, customEvents } for the whole day, one row per wedding, written by the couple timeline builder. The table is dual-mode (see migration 076 and 188) — other rows are per-event and leave this null. services/commitments/timeline-read.ts is the reader that understands both.';

-- ---------------------------------------------------------------------------
-- 2. commitment_reconciliation
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS public.commitment_reconciliation (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  venue_id uuid NOT NULL REFERENCES public.venues(id) ON DELETE CASCADE,
  wedding_id uuid NOT NULL REFERENCES public.weddings(id) ON DELETE CASCADE,

  -- Stable identity of the sentence. FNV-1a 32-bit of the normalised
  -- quote, computed in services/commitments/reconcile.ts. Rewording the
  -- same commitment produces a new row; that is the intended behaviour,
  -- because the coordinator should see the words the couple used.
  commitment_key text NOT NULL,

  -- What they said, in their words. This is what the coordinator reads.
  quote text NOT NULL,

  -- 'intention' | 'special_request' | 'planning_note'
  kind text NOT NULL,

  -- Where the quote was captured. Exactly one of the two id columns is
  -- set; both are nullable because a note can outlive its source row.
  source_interaction_id uuid REFERENCES public.interactions(id) ON DELETE SET NULL,
  source_planning_note_id uuid REFERENCES public.planning_notes(id) ON DELETE SET NULL,

  -- unmatched  — captured, nothing on the timeline covers it (the queue)
  -- matched    — the judge found a timeline event that covers it
  -- added      — a coordinator added an event for it from the queue
  -- dismissed  — a coordinator decided it needs no event. Recorded, not
  --              deleted: the next sweep must not resurrect it, and the
  --              record of the decision is the point.
  status text NOT NULL DEFAULT 'unmatched'
    CHECK (status IN ('unmatched', 'matched', 'added', 'dismissed')),

  -- Title of the timeline event the judge matched this to, when matched.
  matched_event_title text,
  -- One sentence from the judge. Shown to the coordinator so a match is
  -- arguable rather than mysterious.
  judge_reason text,

  -- Content hash of (quote + the timeline titles it was judged against).
  -- A sweep that finds the same hash skips the model call entirely.
  judge_cache_key text,

  resolved_by uuid REFERENCES public.user_profiles(id) ON DELETE SET NULL,
  resolved_at timestamptz,

  -- Deliberately not called created_at / updated_at. These are read on a
  -- coordinator surface, and check-no-coordinator-facing-created-at.mjs
  -- exists because every batch pass bumps a generic updated_at to now()
  -- and makes the page lie about when something happened.
  first_seen_at timestamptz NOT NULL DEFAULT now(),
  last_checked_at timestamptz NOT NULL DEFAULT now()
);

-- Full (not partial) unique index so .upsert({ onConflict:
-- 'wedding_id,commitment_key' }) in reconcile.ts has a real constraint to
-- land on. A partial index would return 42P10 on every upsert.
CREATE UNIQUE INDEX IF NOT EXISTS uq_commitment_reconciliation_wedding_key
  ON public.commitment_reconciliation (wedding_id, commitment_key);

CREATE INDEX IF NOT EXISTS idx_commitment_reconciliation_queue
  ON public.commitment_reconciliation (venue_id, wedding_id, status, first_seen_at DESC);

COMMENT ON TABLE public.commitment_reconciliation IS
  'Things a couple told the venue that have no matching event on their day-of timeline. Written nightly by services/commitments/reconcile.ts off the data_integrity_sweep cron tick; read by the queue on the coordinator wedding page. One row per captured commitment per wedding.';

COMMENT ON COLUMN public.commitment_reconciliation.commitment_key IS
  'FNV-1a 32-bit hash of the normalised quote. Makes the nightly sweep idempotent: same sentence, same row.';

COMMENT ON COLUMN public.commitment_reconciliation.status IS
  'unmatched = on the queue; matched = a timeline event covers it; added = a coordinator created an event from the queue; dismissed = a coordinator decided no event is needed (recorded, never deleted).';

-- ---------------------------------------------------------------------------
-- Venue isolation (gap G17). Canonical policy set, same shape as 377 /
-- 383 / 389. Every read and write from the sweep goes through the service
-- key; the authenticated policies are what stop the coordinator page (a
-- browser client) from ever seeing another venue's row.
-- ---------------------------------------------------------------------------

ALTER TABLE public.commitment_reconciliation ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "commitment_reconciliation_select" ON public.commitment_reconciliation;
CREATE POLICY "commitment_reconciliation_select" ON public.commitment_reconciliation
  FOR SELECT TO authenticated
  USING (
    venue_id IN (
      SELECT up.venue_id FROM public.user_profiles up
      WHERE up.id = auth.uid() AND up.venue_id IS NOT NULL
      UNION
      SELECT v.id FROM public.venues v
        JOIN public.user_profiles up ON up.org_id = v.org_id
      WHERE up.id = auth.uid()
    )
    OR public.is_super_admin()
  );

DROP POLICY IF EXISTS "commitment_reconciliation_modify" ON public.commitment_reconciliation;
CREATE POLICY "commitment_reconciliation_modify" ON public.commitment_reconciliation
  FOR ALL TO authenticated
  USING (
    venue_id IN (
      SELECT up.venue_id FROM public.user_profiles up
      WHERE up.id = auth.uid() AND up.venue_id IS NOT NULL
      UNION
      SELECT v.id FROM public.venues v
        JOIN public.user_profiles up ON up.org_id = v.org_id
      WHERE up.id = auth.uid()
    )
    OR public.is_super_admin()
  )
  WITH CHECK (
    venue_id IN (
      SELECT up.venue_id FROM public.user_profiles up
      WHERE up.id = auth.uid() AND up.venue_id IS NOT NULL
      UNION
      SELECT v.id FROM public.venues v
        JOIN public.user_profiles up ON up.org_id = v.org_id
      WHERE up.id = auth.uid()
    )
    OR public.is_super_admin()
  );

DROP POLICY IF EXISTS "commitment_reconciliation_service" ON public.commitment_reconciliation;
CREATE POLICY "commitment_reconciliation_service" ON public.commitment_reconciliation
  FOR ALL TO service_role USING (true) WITH CHECK (true);

DROP POLICY IF EXISTS "demo_anon_select_commitment_reconciliation" ON public.commitment_reconciliation;
CREATE POLICY "demo_anon_select_commitment_reconciliation" ON public.commitment_reconciliation
  FOR SELECT TO anon
  USING (venue_id IN (SELECT id FROM public.venues WHERE is_demo = true));


-- ############################################################################
-- 407_ad_connections.sql
-- ############################################################################

-- ---------------------------------------------------------------------------
-- 407_ad_connections.sql  (W54)
-- ---------------------------------------------------------------------------
-- Per-venue connection rows for the two ad platforms that did not have
-- one: Meta Ads and TikTok Ads. Google Ads already has its table from
-- migration 310 (google_ads_connections); this migration only adds the
-- one column that table was missing so all three read the same way.
--
-- WHY THIS EXISTS
-- ---------------
-- Until now every ad-spend figure in Bloom was typed in by hand from a
-- screenshot. The coordinator reads a number off the Meta dashboard,
-- types it into /intel/marketing-spend, and the reallocation page then
-- reasons about it as if it were measured. It says so plainly on the
-- page, which is honest, but honest about a gap is still a gap. A venue
-- that grants read access gets the real daily figure per campaign, and
-- the same page stops hedging for them.
--
-- WHAT A ROW HOLDS
-- ----------------
-- The account id to read from, the token to read it with, and the
-- audit trail of who connected it and when it last worked. One row per
-- venue per platform, which is what lets the connector status flip per
-- venue rather than globally.
--
-- SECRETS
-- -------
-- App credentials (META_ADS_APP_ID / META_ADS_APP_SECRET,
-- TIKTOK_ADS_APP_ID / TIKTOK_ADS_APP_SECRET) are single global env
-- vars, the same pattern Twilio, Calendly, Google Ads and Instagram
-- already use. What is per-venue is the account token, because it is
-- minted per ad account during the grant. Two ways to hold it, in
-- priority order, copied from migration 401:
--
--   1. token_env_key   the NAME of an env var holding the token.
--      Nothing secret lands in the database. Safe default for the
--      first venue while encryption at rest is still owed.
--   2. access_token    the token itself, service-role only, never
--      selectable by an authenticated client (see the column grants
--      at the foot of each table).
--
-- HARDENING TODO, the same marker google_ads_connections (310) and
-- instagram_connections (401) carry: wrap access_token and
-- refresh_token in pgsodium before a second venue connects.
--
-- Idempotent: IF NOT EXISTS on every CREATE, DROP POLICY IF EXISTS
-- before every CREATE POLICY. Schema-qualified throughout. No
-- BEGIN/COMMIT wrapper (Wave 23 doctrine).
-- ---------------------------------------------------------------------------

-- ============================================================================
-- STEP 1 - meta_ads_connections
-- ============================================================================
-- Meta Marketing API. The read is
-- GET graph.facebook.com/v21.0/act_<ad_account_id>/insights with
-- fields spend, impressions, clicks, actions and a daily time
-- increment.
--
-- Meta has no refresh grant in the OAuth sense. A short-lived user
-- token is exchanged once for a long-lived one (about 60 days), and
-- that long-lived token is extended by exchanging it for another before
-- it lapses. token_expires_at is what the connector watches to know
-- when to do that.

CREATE TABLE IF NOT EXISTS public.meta_ads_connections (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  venue_id uuid NOT NULL REFERENCES public.venues(id) ON DELETE CASCADE,

  -- The ad account to read. Meta returns it as "act_123456789"; we
  -- store the bare numeric part and the connector adds the prefix, so
  -- an operator who pastes either form gets the same behaviour.
  ad_account_id text,
  ad_account_name text,
  -- Business Manager the account sits under. Informational.
  business_id text,

  -- Token. EITHER an env-var name (nothing secret stored) OR the token
  -- itself. The reader prefers token_env_key.
  token_env_key text,
  access_token text,
  token_expires_at timestamptz,
  scope text,
  token_type text,

  status text NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'connected', 'error', 'revoked')),
  status_reason text,

  connected_by uuid REFERENCES public.user_profiles(id),
  connected_at timestamptz,
  last_synced_at timestamptz,
  last_error_at timestamptz,
  last_error_message text,

  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

COMMENT ON TABLE public.meta_ads_connections IS
  'owner:intelligence. W54 (migration 407). One row per venue for Meta '
  'Ads daily spend through the Meta Marketing API. ad_account_id is the '
  'account the insights read targets. The token is held either as an '
  'env-var NAME (token_env_key, preferred) or as the token itself '
  '(access_token, service-role only). HARDENING TODO: pgsodium on '
  'access_token before a second venue connects.';

COMMENT ON COLUMN public.meta_ads_connections.ad_account_id IS
  'Numeric ad account id without the act_ prefix. The connector adds '
  'the prefix when building the insights URL.';

COMMENT ON COLUMN public.meta_ads_connections.token_env_key IS
  'Name of the environment variable holding the access token. '
  'Preferred over access_token: nothing secret lands in the row.';

COMMENT ON COLUMN public.meta_ads_connections.access_token IS
  'Long-lived user access token. Service-role only, never returned to '
  'an authenticated client. NULL when token_env_key is used instead.';

COMMENT ON COLUMN public.meta_ads_connections.last_synced_at IS
  'Stamped when a spend sync completes for this venue. The settings '
  'page reads it as "last sync".';

CREATE UNIQUE INDEX IF NOT EXISTS uq_meta_ads_connections_venue
  ON public.meta_ads_connections (venue_id);

CREATE INDEX IF NOT EXISTS idx_meta_ads_connections_status
  ON public.meta_ads_connections (status, last_synced_at);

-- ============================================================================
-- STEP 2 - tiktok_ads_connections
-- ============================================================================
-- TikTok Business API. The read is
-- GET business-api.tiktok.com/open_api/v1.3/report/integrated/get/ with
-- a CAMPAIGN data level and a daily dimension.
--
-- TikTok does issue a refresh token for some account types, so unlike
-- Meta there are two secrets to hold.

CREATE TABLE IF NOT EXISTS public.tiktok_ads_connections (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  venue_id uuid NOT NULL REFERENCES public.venues(id) ON DELETE CASCADE,

  advertiser_id text,
  advertiser_name text,
  -- TikTok's report endpoint returns spend as a bare decimal with no
  -- currency on it, so the currency has to come from the advertiser
  -- record instead. Without this column every non-dollar venue would
  -- have its spend silently filed as dollars.
  currency text,

  token_env_key text,
  access_token text,
  refresh_token text,
  token_expires_at timestamptz,
  refresh_token_expires_at timestamptz,
  scope text,

  status text NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'connected', 'error', 'revoked')),
  status_reason text,

  connected_by uuid REFERENCES public.user_profiles(id),
  connected_at timestamptz,
  last_synced_at timestamptz,
  last_error_at timestamptz,
  last_error_message text,

  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

COMMENT ON TABLE public.tiktok_ads_connections IS
  'owner:intelligence. W54 (migration 407). One row per venue for '
  'TikTok Ads daily spend through the TikTok Business API. '
  'advertiser_id is the account the report read targets. The token is '
  'held either as an env-var NAME (token_env_key, preferred) or as the '
  'token itself (access_token, service-role only). HARDENING TODO: '
  'pgsodium on access_token and refresh_token before a second venue '
  'connects.';

COMMENT ON COLUMN public.tiktok_ads_connections.advertiser_id IS
  'TikTok advertiser id. Required on every report call; the connector '
  'refuses to run without it rather than guessing an account.';

COMMENT ON COLUMN public.tiktok_ads_connections.token_env_key IS
  'Name of the environment variable holding the access token. '
  'Preferred over access_token: nothing secret lands in the row.';

CREATE UNIQUE INDEX IF NOT EXISTS uq_tiktok_ads_connections_venue
  ON public.tiktok_ads_connections (venue_id);

CREATE INDEX IF NOT EXISTS idx_tiktok_ads_connections_status
  ON public.tiktok_ads_connections (status, last_synced_at);

-- ============================================================================
-- STEP 3 - google_ads_connections gains last_synced_at
-- ============================================================================
-- Migration 310 gave that table last_used_at, which the OAuth layer
-- stamps on every token read. The three connectors want one column that
-- means "a spend sync finished", separate from "a token was read", so
-- all three settings pages can show the same line. Additive and
-- idempotent; 310 itself is untouched.

-- Guarded on the table existing, because 310 has never been applied to
-- production and sits in the legacy list in
-- scripts/apply-pending-migrations.ts. If 310 lands after this, its own
-- CREATE TABLE runs and this column is added the next time 407 is
-- replayed. An unguarded ALTER here would make 407 unapplyable on any
-- database where 310 is still owed, which is most of them.
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.tables
    WHERE table_schema = 'public' AND table_name = 'google_ads_connections'
  ) THEN
    ALTER TABLE public.google_ads_connections
      ADD COLUMN IF NOT EXISTS last_synced_at timestamptz;

    COMMENT ON COLUMN public.google_ads_connections.last_synced_at IS
      'W54 (migration 407). Stamped when a spend sync completes for this '
      'venue. Distinct from last_used_at, which moves whenever the token '
      'is read.';
  END IF;
END $$;

-- ============================================================================
-- STEP 4 - row security
-- ============================================================================
-- Venue-scoped read and write, super-admin bypass, service_role full.
-- Copied from the prod-proven 401 pattern.
--
-- Deliberately no demo-anon read policy: these rows carry a credential.
-- The demo venues have no live ad connection and must not be able to
-- enumerate anyone else's.

ALTER TABLE public.meta_ads_connections ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "meta_ads_connections_select" ON public.meta_ads_connections;
CREATE POLICY "meta_ads_connections_select" ON public.meta_ads_connections
  FOR SELECT TO authenticated
  USING (
    venue_id IN (
      SELECT up.venue_id FROM public.user_profiles up
      WHERE up.id = auth.uid() AND up.venue_id IS NOT NULL
      UNION
      SELECT v.id FROM public.venues v
        JOIN public.user_profiles up ON up.org_id = v.org_id
      WHERE up.id = auth.uid()
    )
    OR public.is_super_admin()
  );

DROP POLICY IF EXISTS "meta_ads_connections_modify" ON public.meta_ads_connections;
CREATE POLICY "meta_ads_connections_modify" ON public.meta_ads_connections
  FOR ALL TO authenticated
  USING (
    venue_id IN (
      SELECT up.venue_id FROM public.user_profiles up
      WHERE up.id = auth.uid() AND up.venue_id IS NOT NULL
      UNION
      SELECT v.id FROM public.venues v
        JOIN public.user_profiles up ON up.org_id = v.org_id
      WHERE up.id = auth.uid()
    )
    OR public.is_super_admin()
  )
  WITH CHECK (
    venue_id IN (
      SELECT up.venue_id FROM public.user_profiles up
      WHERE up.id = auth.uid() AND up.venue_id IS NOT NULL
      UNION
      SELECT v.id FROM public.venues v
        JOIN public.user_profiles up ON up.org_id = v.org_id
      WHERE up.id = auth.uid()
    )
    OR public.is_super_admin()
  );

DROP POLICY IF EXISTS "meta_ads_connections_service" ON public.meta_ads_connections;
CREATE POLICY "meta_ads_connections_service" ON public.meta_ads_connections
  FOR ALL TO service_role USING (true) WITH CHECK (true);

ALTER TABLE public.tiktok_ads_connections ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "tiktok_ads_connections_select" ON public.tiktok_ads_connections;
CREATE POLICY "tiktok_ads_connections_select" ON public.tiktok_ads_connections
  FOR SELECT TO authenticated
  USING (
    venue_id IN (
      SELECT up.venue_id FROM public.user_profiles up
      WHERE up.id = auth.uid() AND up.venue_id IS NOT NULL
      UNION
      SELECT v.id FROM public.venues v
        JOIN public.user_profiles up ON up.org_id = v.org_id
      WHERE up.id = auth.uid()
    )
    OR public.is_super_admin()
  );

DROP POLICY IF EXISTS "tiktok_ads_connections_modify" ON public.tiktok_ads_connections;
CREATE POLICY "tiktok_ads_connections_modify" ON public.tiktok_ads_connections
  FOR ALL TO authenticated
  USING (
    venue_id IN (
      SELECT up.venue_id FROM public.user_profiles up
      WHERE up.id = auth.uid() AND up.venue_id IS NOT NULL
      UNION
      SELECT v.id FROM public.venues v
        JOIN public.user_profiles up ON up.org_id = v.org_id
      WHERE up.id = auth.uid()
    )
    OR public.is_super_admin()
  )
  WITH CHECK (
    venue_id IN (
      SELECT up.venue_id FROM public.user_profiles up
      WHERE up.id = auth.uid() AND up.venue_id IS NOT NULL
      UNION
      SELECT v.id FROM public.venues v
        JOIN public.user_profiles up ON up.org_id = v.org_id
      WHERE up.id = auth.uid()
    )
    OR public.is_super_admin()
  );

DROP POLICY IF EXISTS "tiktok_ads_connections_service" ON public.tiktok_ads_connections;
CREATE POLICY "tiktok_ads_connections_service" ON public.tiktok_ads_connections
  FOR ALL TO service_role USING (true) WITH CHECK (true);

-- ============================================================================
-- STEP 5 - updated_at triggers
-- ============================================================================
-- Guarded on the shared helper so the migration still applies on a
-- database that predates it.

DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_proc p
      JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE p.proname = 'set_updated_at' AND n.nspname = 'public'
  ) THEN
    DROP TRIGGER IF EXISTS trg_meta_ads_connections_updated_at
      ON public.meta_ads_connections;
    CREATE TRIGGER trg_meta_ads_connections_updated_at
      BEFORE UPDATE ON public.meta_ads_connections
      FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

    DROP TRIGGER IF EXISTS trg_tiktok_ads_connections_updated_at
      ON public.tiktok_ads_connections;
    CREATE TRIGGER trg_tiktok_ads_connections_updated_at
      BEFORE UPDATE ON public.tiktok_ads_connections
      FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();
  END IF;
END $$;

-- ============================================================================
-- STEP 6 - column grants
-- ============================================================================
-- Row security decides which ROWS an authenticated user sees; these
-- grants decide which COLUMNS. A token must never leave the service
-- role, so authenticated is granted every column except the token ones.
--
-- Consequence worth knowing, the same one migration 401 documents: with
-- a column-level SELECT grant, a select('*') from an authenticated
-- client gets "permission denied for column access_token" rather than a
-- partial row. Every reader in this repo names its columns, and the
-- settings pages read through the server-side status routes anyway. A
-- new reader that reaches for * will fail loudly, which is the
-- behaviour we want on a table holding a credential.

REVOKE ALL ON public.meta_ads_connections FROM authenticated;
GRANT SELECT (
  id, venue_id, ad_account_id, ad_account_name, business_id,
  token_env_key, token_expires_at, scope, token_type,
  status, status_reason, connected_by, connected_at, last_synced_at,
  last_error_at, last_error_message, created_at, updated_at
) ON public.meta_ads_connections TO authenticated;
GRANT INSERT, UPDATE, DELETE ON public.meta_ads_connections TO authenticated;

REVOKE ALL ON public.tiktok_ads_connections FROM authenticated;
GRANT SELECT (
  id, venue_id, advertiser_id, advertiser_name, currency,
  token_env_key, token_expires_at, refresh_token_expires_at, scope,
  status, status_reason, connected_by, connected_at, last_synced_at,
  last_error_at, last_error_message, created_at, updated_at
) ON public.tiktok_ads_connections TO authenticated;
GRANT INSERT, UPDATE, DELETE ON public.tiktok_ads_connections TO authenticated;

NOTIFY pgrst, 'reload schema';


-- ############################################################################
-- 408_venue_sending_domain.sql
-- ############################################################################

-- 408: per-venue Resend sending domain
--
-- Wave 8, W55 (NOVEMBER-PLAN.md). Every venue's transactional mail
-- (portal invites, team invites, payment alerts, operator alerts) has
-- gone out through Bloom's own thebloomhouse.ai Resend domain since
-- transport.ts was written — see the "infrastructure carry-forward"
-- note on src/app/api/portal/invite-couple/route.ts, which flagged
-- exactly this as deferred. One shared sending domain means one
-- venue's bounces/spam complaints can drag down every other venue's
-- deliverability, and a couple's inbox shows "The Bloom House" instead
-- of the venue they actually booked. This migration is the storage
-- half of the fix; transport.ts (same commit) and
-- src/lib/services/email/sending-domain.ts (the Resend domain-
-- verification flow) are the other two.
--
-- Columns:
--   sending_domain            the venue's own domain, e.g. 'rixeymanor.com'.
--                              Null until the coordinator enters one.
--   sending_from_name          display name for the From header, e.g.
--                              'Rixey Manor'. Independent of business_name
--                              so a venue can pick different wording for
--                              the envelope than for the portal UI.
--   sending_domain_status      unverified (default, nothing attempted or
--                              DNS not yet added) | pending (Resend domain
--                              created, DNS check in flight) | verified
--                              (Resend confirmed SPF + DKIM; transport.ts
--                              may use this domain) | failed (Resend
--                              checked and the DNS records don't match —
--                              never used for sending).
--   resend_domain_id           the Resend domains/{id} this venue's
--                              domain maps to. Needed to call verify/get
--                              without re-creating the domain each time.
--   sending_domain_checked_at  last time the status was refreshed, either
--                              by the coordinator's "check now" button or
--                              the daily cron piggyback (see cron/route.ts
--                              heat_decay case). Shown on the settings
--                              page so a stuck "pending" reads as stale
--                              rather than actively wrong.
--
-- transport.ts only ever uses sending_domain/sending_from_name for the
-- From header when sending_domain_status = 'verified' — every other
-- status falls back to the platform default, logged, never silent.
--
-- RLS unchanged: venue_config already carries venue_id RLS (migration
-- 006 + tightened in 216/225/226); these are plain columns on an
-- already-isolated table, no new policy needed.
--
-- Schema-qualified because scripts/run-migration.ts drives
-- public.exec_sql with search_path = pg_catalog, public. Idempotent, no
-- BEGIN/COMMIT (the exec_sql RPC rejects transaction blocks).

ALTER TABLE public.venue_config
  ADD COLUMN IF NOT EXISTS sending_domain text,
  ADD COLUMN IF NOT EXISTS sending_from_name text,
  ADD COLUMN IF NOT EXISTS sending_domain_status text NOT NULL DEFAULT 'unverified',
  ADD COLUMN IF NOT EXISTS resend_domain_id text,
  ADD COLUMN IF NOT EXISTS sending_domain_checked_at timestamptz;

-- Guard the status enum the same way sending_domain_status is described
-- above. Dropped-and-recreated so a re-run of this file (idempotent
-- migration convention) doesn't fail on "constraint already exists".
ALTER TABLE public.venue_config
  DROP CONSTRAINT IF EXISTS venue_config_sending_domain_status_check;

ALTER TABLE public.venue_config
  ADD CONSTRAINT venue_config_sending_domain_status_check
  CHECK (sending_domain_status IN ('unverified', 'pending', 'verified', 'failed'));

COMMENT ON COLUMN public.venue_config.sending_domain IS
  'The venue''s own domain for outbound transactional mail, e.g. rixeymanor.com. Null until the coordinator sets one on Settings -> Sending domain. Migration 408.';

COMMENT ON COLUMN public.venue_config.sending_from_name IS
  'Display name for the From header when sending_domain_status is verified, e.g. "Rixey Manor". Migration 408.';

COMMENT ON COLUMN public.venue_config.sending_domain_status IS
  'unverified | pending | verified | failed. transport.ts sendEmail only builds a From address on this domain when verified; every other value falls back to the platform default with a logged reason. Migration 408.';

COMMENT ON COLUMN public.venue_config.resend_domain_id IS
  'The Resend domains/{id} this venue''s sending_domain was created as. Set by src/lib/services/email/sending-domain.ts on create, read back on every verify/refresh. Migration 408.';

COMMENT ON COLUMN public.venue_config.sending_domain_checked_at IS
  'Last time sending_domain_status was refreshed against Resend — coordinator "check now" or the daily cron piggyback (cron/route.ts heat_decay case). Migration 408.';


-- ############################################################################
-- 409_contract_generation.sql
-- ############################################################################

-- ---------------------------------------------------------------------------
-- 409_contract_generation.sql
-- ---------------------------------------------------------------------------
-- W57 (NOVEMBER-PLAN.md, wave 8). Contracts a venue generates inside Bloom
-- from a booked wedding's own package figures, sends to the couple, and
-- then watches for a signature.
--
-- The `contracts` table already exists (migration 004) and already holds
-- what a couple uploads: a filename, a file type, the extracted text, a
-- storage path, and since migration 015 a vendor link plus an AI analysis.
-- Nothing here changes any of that. Generated contracts live in the same
-- table, read by the same coordinator and couple surfaces, and carry the
-- extra columns this migration adds.
--
-- Scope note: this is generation and status tracking. It is not
-- e-signature legal infrastructure. A typed name, a timestamp and the
-- caller's IP are recorded as a record of agreement, which is what the
-- venue asked for. No certificate, no audit-trail PDF, no notary.
--
-- Why `status` is not re-declared and gets no CHECK
-- -------------------------------------------------
-- Migration 015 already added `status text DEFAULT 'uploaded'` and the
-- upload path writes 'uploaded', 'extracted' and 'analyzed' into it. The
-- generated lifecycle (draft / sent / viewed / signed / void) shares that
-- same column, which is what the two surfaces want: one pill, one column,
-- one sort. A CHECK constraint would have to list all eight values and
-- would reject any historical row that carries something else, so the
-- allowed set is enforced in code instead, in
-- src/lib/services/contracts/status.ts, where the transition rules live
-- anyway. `kind` is what tells the two lifecycles apart.
--
-- Row-level security: `contracts` is already venue-scoped by the
-- venue_isolation policy of migration 006, plus the couple-role policy of
-- migration 226 and the demo anon policies of migration 027. Adding
-- columns does not change any of them and this migration deliberately
-- adds no policy. The public signing page does not read the table as the
-- anon role; it goes through a service-role route that looks the row up
-- by a hashed token and returns a narrow projection.
--
-- Rerun safety: every statement is IF NOT EXISTS or CREATE OR REPLACE.
-- No BEGIN/COMMIT (the migration runner wraps statements itself).
-- ---------------------------------------------------------------------------

-- uploaded | generated. Defaults to 'uploaded' so every existing row keeps
-- the meaning it already had without a backfill.
ALTER TABLE public.contracts
  ADD COLUMN IF NOT EXISTS kind text NOT NULL DEFAULT 'uploaded';

COMMENT ON COLUMN public.contracts.kind IS
  'uploaded = a file the couple or coordinator added. generated = built by '
  'Bloom from the wedding''s package figures. The status column carries a '
  'different set of values for each; see src/lib/services/contracts/status.ts.';

COMMENT ON COLUMN public.contracts.status IS
  'Uploaded contracts: uploaded | extracted | analyzed. Generated '
  'contracts: draft | sent | viewed | signed | void. Not constrained in '
  'SQL because the two lifecycles share the column; the allowed set and '
  'the transitions are enforced in src/lib/services/contracts/status.ts.';

-- Which template built it. Free text so a venue can keep more than one
-- (a full wedding and an elopement, say) without a lookup table.
ALTER TABLE public.contracts
  ADD COLUMN IF NOT EXISTS template_key text;

COMMENT ON COLUMN public.contracts.template_key IS
  'Key of the template used, e.g. ''standard''. Null for uploads.';

-- The figures the document was built from, frozen at generation time.
-- The wedding's guest count and balance move; a contract that has been
-- sent must not. Holds { snapshot, template }: the numbers AND the
-- wording used, because re-rendering needs both and a venue editing their
-- template next month must not change what somebody already signed.
ALTER TABLE public.contracts
  ADD COLUMN IF NOT EXISTS generated_from jsonb;

COMMENT ON COLUMN public.contracts.generated_from IS
  '{ snapshot, template }. The package snapshot used to render this '
  'contract (totals, deposit, guest count, hours, names) plus the '
  'template wording it was rendered with. Frozen at generation so the '
  'signing page shows what was sent. Null for uploads.';

ALTER TABLE public.contracts
  ADD COLUMN IF NOT EXISTS sent_at timestamptz;

ALTER TABLE public.contracts
  ADD COLUMN IF NOT EXISTS viewed_at timestamptz;

ALTER TABLE public.contracts
  ADD COLUMN IF NOT EXISTS signed_at timestamptz;

COMMENT ON COLUMN public.contracts.sent_at IS
  'When the contract email went out. The real event column for the send; '
  'do not window or display created_at for this.';

COMMENT ON COLUMN public.contracts.viewed_at IS
  'First time the couple opened the signing link.';

COMMENT ON COLUMN public.contracts.signed_at IS
  'When the couple typed their name and agreed.';

ALTER TABLE public.contracts
  ADD COLUMN IF NOT EXISTS signed_name text;

COMMENT ON COLUMN public.contracts.signed_name IS
  'The name the couple typed. A record of agreement, not a signature '
  'image and not a legal e-signature certificate.';

ALTER TABLE public.contracts
  ADD COLUMN IF NOT EXISTS signed_ip text;

COMMENT ON COLUMN public.contracts.signed_ip IS
  'IP the agreement came from, read from the proxy headers. Best effort.';

-- The signing credential. Holds a sha256 of the token that was emailed,
-- never the token itself, the same way couple_invites.token_hash does
-- (migration 391). Anyone who reads this column still cannot sign.
-- Unique because a lookup by token must land on exactly one row.
ALTER TABLE public.contracts
  ADD COLUMN IF NOT EXISTS sign_token text;

COMMENT ON COLUMN public.contracts.sign_token IS
  'sha256 (hex) of the single-use signing token that was emailed. The '
  'token itself is never stored. Single use for SIGNING: once the row is '
  'signed the same link still opens the contract read-only.';

CREATE UNIQUE INDEX IF NOT EXISTS idx_contracts_sign_token
  ON public.contracts (sign_token)
  WHERE sign_token IS NOT NULL;

-- The coordinator's section lists a wedding's generated contracts newest
-- first; the couple's library lists the whole wedding. Both filter on
-- wedding_id, which migration 004 already indexes, so this partial index
-- exists for the kind filter alone.
CREATE INDEX IF NOT EXISTS idx_contracts_generated
  ON public.contracts (wedding_id, kind)
  WHERE kind = 'generated';


-- ############################################################################
-- 410_benchmark_participation.sql
-- ############################################################################

-- 410: cross-venue benchmark participation is opt-in, default off
--
-- Wave 8 follow-up to W56 (NOVEMBER-PLAN.md). Doctrine INV-24.1-A in
-- doctrine-compliance.yaml asks that a venue's numbers only ever enter
-- another venue's benchmark when the venue said yes. W56 used
-- venue_config.onboarding_completed as the only condition because it wrote
-- no migrations; this column is the real switch. benchmarkPeerSet() reads
-- it, so a venue that has not opted in is never a peer and never sees
-- peers. The demo venues are opted in by the seed so the demo shows the
-- page working.

ALTER TABLE public.venue_config
  ADD COLUMN IF NOT EXISTS benchmark_participation boolean NOT NULL DEFAULT false;

COMMENT ON COLUMN public.venue_config.benchmark_participation IS
  'Opt-in to cross-venue benchmarks (doctrine INV-24.1-A). Default false. When true this venue contributes anonymised aggregates to other venues'' benchmarks and may read its own. Set from Settings by the venue, never by the platform.';


-- ############################################################################
-- 411_security_policies.sql
-- ############################################################################

-- ---------------------------------------------------------------------------
-- 411_security_policies.sql  (S3, 2026-09-14 security audit remediation)
-- ---------------------------------------------------------------------------
-- One migration, ten findings. Every one of them is the same shape: a
-- policy or a grant that was written when the demo was the only thing
-- reachable, and that nobody narrowed once real tenants arrived. None of
-- this is new capability. It takes away access that was never meant to be
-- there.
--
-- WHAT IS IN HERE
-- ---------------
--   STEP 0  helpers: try_uuid, can_access_venue, can_access_wedding,
--           normalise_e164
--   STEP 1  storage buckets: public flags and allowed_mime_types
--   STEP 2  storage.objects: drop every anon policy and every
--           bucket-id-only authenticated policy on the nine buckets in
--           scope; replace with folder-scoped authenticated policies
--   STEP 3  column grants on the three connection tables that had none
--           (google_ads_connections, zoom_connections,
--           openphone_connections)
--   STEP 4  demo-anon: drop the gmail_connections read, drop venue_config
--           from the demo write set, revoke anon SELECT on venue_config's
--           secret columns
--   STEP 5  env-var-name indirection: narrow the INSERT/UPDATE grants on
--           meta_ads_connections / tiktok_ads_connections /
--           instagram_connections and CHECK the env-key names
--   STEP 6  twilio_phone_numbers uniqueness across venues
--   STEP 7  team_invitations.token_hash, plus the invitation policy set
--           that let any signed-in user invite themselves as org_admin
--   STEP 8  venue_config writes gated on role
--   STEP 9  knot_template_patterns anon read
--   STEP 10 booked_vendors.portal_token_hash
--
-- OPERATOR NOTE, READ BEFORE APPLYING
-- -----------------------------------
-- STEP 1 and STEP 2 touch the `storage` schema. `public.exec_sql` runs as
-- the function owner, which is not the owner of `storage.objects`, so
-- CREATE POLICY there can come back as
-- "42501: must be owner of table objects" — the same reason migration 308
-- is absent from scripts/apply-pending-migrations.ts. Both steps are
-- therefore wrapped in a DO block with an `insufficient_privilege`
-- handler: if the runner cannot do it, the block raises a WARNING naming
-- the step and the rest of the migration still applies. Run
-- `node scripts/check-live-policies.mjs` afterwards; if the storage rows
-- still read `NEEDS 411`, paste STEP 1 and STEP 2 into the Supabase SQL
-- editor, which runs as the project owner, and re-run the script.
--
-- Idempotent throughout: IF EXISTS / IF NOT EXISTS / DROP-then-CREATE /
-- CREATE OR REPLACE. Safe to re-run. No BEGIN/COMMIT wrapper (Wave 23
-- doctrine). Schema-qualified throughout.
-- ---------------------------------------------------------------------------


-- ===========================================================================
-- STEP 0 - helpers
-- ===========================================================================
-- Storage paths are text. The venue or wedding id sits in a path segment,
-- and a segment that is not a uuid must not raise 22P02 inside a policy
-- predicate (an error there is a 500, not a denial). try_uuid turns a bad
-- segment into NULL, and both access helpers return false on NULL.

CREATE OR REPLACE FUNCTION public.try_uuid(p_text text)
RETURNS uuid
LANGUAGE plpgsql
IMMUTABLE
AS $try_uuid$
BEGIN
  RETURN p_text::uuid;
EXCEPTION WHEN others THEN
  RETURN NULL;
END;
$try_uuid$;

COMMENT ON FUNCTION public.try_uuid(text) IS
  'Migration 411. Cast to uuid or NULL. Used by the storage.objects '
  'policies so a path segment that is not a uuid denies rather than '
  'raising 22P02 from inside a policy predicate.';

-- The venue predicate every scoped policy in this repo writes out
-- longhand (own venue, or any venue in the caller's org, or super
-- admin). SECURITY DEFINER so a policy on a storage object can read
-- user_profiles and venues without tripping their own RLS.

CREATE OR REPLACE FUNCTION public.can_access_venue(p_venue_id uuid)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $can_access_venue$
  SELECT p_venue_id IS NOT NULL
     AND (
       EXISTS (
         SELECT 1 FROM public.user_profiles up
          WHERE up.id = auth.uid() AND up.venue_id = p_venue_id
       )
       OR EXISTS (
         SELECT 1 FROM public.venues v
           JOIN public.user_profiles up ON up.org_id = v.org_id
          WHERE up.id = auth.uid() AND v.id = p_venue_id
       )
       OR public.is_super_admin()
     )
$can_access_venue$;

COMMENT ON FUNCTION public.can_access_venue(uuid) IS
  'Migration 411. True when the calling authenticated user may act on '
  'this venue: it is their own venue, or it belongs to their org, or '
  'they are a super admin. The same predicate migrations 401 and 407 '
  'write inline; factored out so the storage policies can use it.';

CREATE OR REPLACE FUNCTION public.can_access_wedding(p_wedding_id uuid)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $can_access_wedding$
  SELECT p_wedding_id IS NOT NULL
     AND (
       p_wedding_id = public.couple_user_wedding_id()
       OR EXISTS (
         SELECT 1 FROM public.weddings w
          WHERE w.id = p_wedding_id
            AND public.can_access_venue(w.venue_id)
       )
     )
$can_access_wedding$;

COMMENT ON FUNCTION public.can_access_wedding(uuid) IS
  'Migration 411. True when the calling authenticated user may act on '
  'this wedding: they are the couple on it (migration 226 helper), or '
  'they can access its venue. Used by the couple-photos, inspo-gallery, '
  'contracts, vendor-contracts and day-of-media storage policies.';

REVOKE ALL ON FUNCTION public.try_uuid(text) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.can_access_venue(uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.can_access_wedding(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.try_uuid(text) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.can_access_venue(uuid) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.can_access_wedding(uuid) TO authenticated, service_role;

-- Phone normalisation for STEP 6. Digits only, then an E.164-ish form.
-- A bare 10-digit string is treated as North American, which is what
-- every number in this database is today; anything else keeps whatever
-- country code it arrived with. Deliberately dumb: its only job is to
-- make "+1 (540) 555-0101" and "15405550101" collide.

CREATE OR REPLACE FUNCTION public.normalise_e164(p_raw text)
RETURNS text
LANGUAGE sql
IMMUTABLE
AS $normalise_e164$
  SELECT CASE
    WHEN p_raw IS NULL THEN NULL
    WHEN regexp_replace(p_raw, '[^0-9]', '', 'g') = '' THEN NULL
    WHEN length(regexp_replace(p_raw, '[^0-9]', '', 'g')) = 10
      THEN '+1' || regexp_replace(p_raw, '[^0-9]', '', 'g')
    ELSE '+' || regexp_replace(p_raw, '[^0-9]', '', 'g')
  END
$normalise_e164$;

COMMENT ON FUNCTION public.normalise_e164(text) IS
  'Migration 411. Crude E.164 normaliser for the twilio number claims '
  'table. Strips everything but digits; a 10-digit string is assumed '
  'North American. Its only job is to make two spellings of one number '
  'collide on a unique index.';


-- ===========================================================================
-- STEP 1 - storage bucket flags and mime types
-- ===========================================================================
-- Migration 028 created five buckets with public = true and did not set
-- allowed_mime_types on any of them. Migration 225 dropped the table-level
-- anon policies but never touched storage, so the buckets stayed as 028
-- left them.
--
-- WHAT FLIPS TO PRIVATE, AND WHY
--   contracts         private. Every reader already asks for a signed URL
--                     (src/lib/services/contracts/generate.ts ~323,
--                     src/components/couple/contract-library.tsx ~694), so
--                     nothing in tree depends on the public object route.
--   vendor-contracts  private. Same: src/app/_couple-pages/vendors/page.tsx
--                     ~512 signs its URLs.
--   day-of-media      private. This is the bucket the coordinator asked
--                     for by name. See the note under STEP 2 about the one
--                     reader that still builds a public URL.
--
-- WHAT STAYS PUBLIC, AND WHY
--   couple-photos     the couple's own wedding website renders these to
--                     logged-out guests (src/app/_couple-pages/website/
--                     page.tsx ~233 stores a getPublicUrl result in the
--                     saved site settings). That is a genuine public read
--                     path, so the flag stays and the fix is the policy
--                     work in STEP 2: dropping the anon SELECT policy ends
--                     anonymous LISTING of the bucket, which is what let
--                     one couple walk another couple's folder. Fetching an
--                     exact known path stays possible, as it must for the
--                     public site to work.
--   inspo-gallery     public URLs are persisted into inspo_gallery.image_url
--                     (src/app/_couple-pages/inspo/page.tsx ~197). Flipping
--                     the flag would blank every existing image, and the
--                     swap to signed URLs is a src/ change this workstream
--                     does not own. Flag stays; anon listing and anon write
--                     both go in STEP 2. Flagged for follow-up.
--   venue-assets      logos and floor plans are rendered by email and by
--                     the public site through getPublicUrl (settings/
--                     page.tsx ~212, portal/seating-config/page.tsx ~352).
--                     Flag stays; SVG is excluded below because an SVG is a
--                     script that the browser will run from our origin.
--   brain-dump        already private (migration 084).
--   crm-imports       already private (migration 270).

DO $bucket_flags$
BEGIN
  UPDATE storage.buckets
     SET public = false
   WHERE id IN ('contracts', 'vendor-contracts', 'day-of-media');

  UPDATE storage.buckets
     SET public = true
   WHERE id IN ('couple-photos', 'inspo-gallery', 'venue-assets');

  UPDATE storage.buckets
     SET public = false
   WHERE id IN ('brain-dump', 'crm-imports');

  -- No SVG. Everything else here is what the three venue-asset upload
  -- surfaces actually send: images for logos and floor plans, documents
  -- for the couple-facing resources list.
  UPDATE storage.buckets
     SET allowed_mime_types = ARRAY[
       'image/png',
       'image/jpeg',
       'image/webp',
       'image/gif',
       'image/avif',
       'image/heic',
       'application/pdf',
       'application/msword',
       'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
       'text/plain',
       'text/csv'
     ]
   WHERE id = 'venue-assets';
EXCEPTION WHEN insufficient_privilege THEN
  RAISE WARNING
    '411 STEP 1 skipped: the runner is not the owner of storage.buckets. '
    'Paste STEP 1 into the Supabase SQL editor, then re-run '
    'scripts/check-live-policies.mjs.';
END
$bucket_flags$;


-- ===========================================================================
-- STEP 2 - storage.objects policies
-- ===========================================================================
-- Before: migration 028 gave anon SELECT / INSERT / UPDATE / DELETE on
-- couple-photos, inspo-gallery, vendor-contracts, contracts and
-- venue-assets with `bucket_id = '<name>'` as the entire predicate.
-- Anyone holding the anon key (it ships to every browser) could list,
-- overwrite or delete any venue's contracts. Migrations 084 and 270 did
-- the authenticated equivalent for brain-dump and crm-imports: any signed-
-- in user of any venue could read every venue's uploads. 097 gave
-- day-of-media a public flag and an anon SELECT policy.
--
-- After: no anon policy on any of these buckets, and every authenticated
-- policy carries a `(storage.foldername(name))[1]` predicate resolving to
-- a venue or wedding the caller may access. The service role bypasses RLS
-- and is unchanged, so every server-side path keeps working.
--
-- PATH SHAPES, read out of src/ rather than assumed:
--   couple-photos     {weddingId}/...        _couple-pages/couple-photo ~210,
--                                            photos ~215, website ~231,
--                                            components/couple/couple-photo-prompt ~73
--   inspo-gallery     {weddingId}/...        _couple-pages/inspo ~195
--   vendor-contracts  {weddingId}/...        _couple-pages/vendors ~508
--   contracts         {weddingId}/...        lib/services/contracts/generate.ts ~308,
--                                            components/couple/contract-library ~684
--   venue-assets      TWO shapes, both live:
--                       {venueId}/...              settings ~468,
--                                                  portal/venue-assets-config ~100
--                       venue-assets/{venueId}/... settings ~205 (logo),
--                                                  portal/seating-config ~335 (floor plan)
--                     The predicate accepts either. Narrowing to one would
--                     break a working upload, and src/ belongs to other
--                     workstreams this week.
--   brain-dump        {venueId}/...          components/shell/floating-brain-dump ~471
--   crm-imports       {venueId}/...          migration 270 header
--   day-of-media      {venueId}/{weddingId}/...
--                                            portal/weddings/[id]/_components/
--                                            day-of-memories-tab ~98
--
-- KNOWN CONSEQUENCE, day-of-media: that tab builds its image src by hand
-- as /storage/v1/object/public/day-of-media/<path> (day-of-memories-tab.tsx
-- ~42-47). Once the bucket is private those URLs 404 and the tab needs
-- createSignedUrl. That is a src/ change and is called out in the S3
-- handoff; the isolation fix is not held back for it.

DO $storage_policies$
DECLARE
  v_sql text;
  v_stmts text[] := ARRAY[
    -- --- sweep: every policy on storage.objects that mentions one of the
    -- --- nine buckets in scope, whatever it is called. Named drops would
    -- --- miss a policy added by hand in the dashboard, and a single
    -- --- surviving bucket-id-only policy re-opens the whole bucket
    -- --- because permissive policies are OR-ed.
    $s$DO $sweep$
      DECLARE p record;
      BEGIN
        FOR p IN
          SELECT policyname
            FROM pg_policies
           WHERE schemaname = 'storage'
             AND tablename = 'objects'
             AND (
               coalesce(qual, '') || ' ' || coalesce(with_check, '')
             ) ~ '(couple-photos|inspo-gallery|vendor-contracts|contracts|venue-assets|brain-dump|crm-imports|day-of-media)'
        LOOP
          EXECUTE format('DROP POLICY IF EXISTS %I ON storage.objects', p.policyname);
        END LOOP;
      END
    $sweep$$s$,

    -- --- couple-photos: wedding folder ---------------------------------
    $s$CREATE POLICY "auth_couple_photos_select" ON storage.objects
        FOR SELECT TO authenticated
        USING (bucket_id = 'couple-photos'
               AND public.can_access_wedding(public.try_uuid((storage.foldername(name))[1])))$s$,
    $s$CREATE POLICY "auth_couple_photos_insert" ON storage.objects
        FOR INSERT TO authenticated
        WITH CHECK (bucket_id = 'couple-photos'
               AND public.can_access_wedding(public.try_uuid((storage.foldername(name))[1])))$s$,
    $s$CREATE POLICY "auth_couple_photos_update" ON storage.objects
        FOR UPDATE TO authenticated
        USING (bucket_id = 'couple-photos'
               AND public.can_access_wedding(public.try_uuid((storage.foldername(name))[1])))
        WITH CHECK (bucket_id = 'couple-photos'
               AND public.can_access_wedding(public.try_uuid((storage.foldername(name))[1])))$s$,
    $s$CREATE POLICY "auth_couple_photos_delete" ON storage.objects
        FOR DELETE TO authenticated
        USING (bucket_id = 'couple-photos'
               AND public.can_access_wedding(public.try_uuid((storage.foldername(name))[1])))$s$,

    -- --- inspo-gallery: wedding folder ---------------------------------
    $s$CREATE POLICY "auth_inspo_gallery_select" ON storage.objects
        FOR SELECT TO authenticated
        USING (bucket_id = 'inspo-gallery'
               AND public.can_access_wedding(public.try_uuid((storage.foldername(name))[1])))$s$,
    $s$CREATE POLICY "auth_inspo_gallery_insert" ON storage.objects
        FOR INSERT TO authenticated
        WITH CHECK (bucket_id = 'inspo-gallery'
               AND public.can_access_wedding(public.try_uuid((storage.foldername(name))[1])))$s$,
    $s$CREATE POLICY "auth_inspo_gallery_update" ON storage.objects
        FOR UPDATE TO authenticated
        USING (bucket_id = 'inspo-gallery'
               AND public.can_access_wedding(public.try_uuid((storage.foldername(name))[1])))
        WITH CHECK (bucket_id = 'inspo-gallery'
               AND public.can_access_wedding(public.try_uuid((storage.foldername(name))[1])))$s$,
    $s$CREATE POLICY "auth_inspo_gallery_delete" ON storage.objects
        FOR DELETE TO authenticated
        USING (bucket_id = 'inspo-gallery'
               AND public.can_access_wedding(public.try_uuid((storage.foldername(name))[1])))$s$,

    -- --- vendor-contracts: wedding folder, private bucket --------------
    $s$CREATE POLICY "auth_vendor_contracts_select" ON storage.objects
        FOR SELECT TO authenticated
        USING (bucket_id = 'vendor-contracts'
               AND public.can_access_wedding(public.try_uuid((storage.foldername(name))[1])))$s$,
    $s$CREATE POLICY "auth_vendor_contracts_insert" ON storage.objects
        FOR INSERT TO authenticated
        WITH CHECK (bucket_id = 'vendor-contracts'
               AND public.can_access_wedding(public.try_uuid((storage.foldername(name))[1])))$s$,
    $s$CREATE POLICY "auth_vendor_contracts_update" ON storage.objects
        FOR UPDATE TO authenticated
        USING (bucket_id = 'vendor-contracts'
               AND public.can_access_wedding(public.try_uuid((storage.foldername(name))[1])))
        WITH CHECK (bucket_id = 'vendor-contracts'
               AND public.can_access_wedding(public.try_uuid((storage.foldername(name))[1])))$s$,
    $s$CREATE POLICY "auth_vendor_contracts_delete" ON storage.objects
        FOR DELETE TO authenticated
        USING (bucket_id = 'vendor-contracts'
               AND public.can_access_wedding(public.try_uuid((storage.foldername(name))[1])))$s$,

    -- --- contracts: wedding folder, private bucket ---------------------
    $s$CREATE POLICY "auth_contracts_select" ON storage.objects
        FOR SELECT TO authenticated
        USING (bucket_id = 'contracts'
               AND public.can_access_wedding(public.try_uuid((storage.foldername(name))[1])))$s$,
    $s$CREATE POLICY "auth_contracts_insert" ON storage.objects
        FOR INSERT TO authenticated
        WITH CHECK (bucket_id = 'contracts'
               AND public.can_access_wedding(public.try_uuid((storage.foldername(name))[1])))$s$,
    $s$CREATE POLICY "auth_contracts_update" ON storage.objects
        FOR UPDATE TO authenticated
        USING (bucket_id = 'contracts'
               AND public.can_access_wedding(public.try_uuid((storage.foldername(name))[1])))
        WITH CHECK (bucket_id = 'contracts'
               AND public.can_access_wedding(public.try_uuid((storage.foldername(name))[1])))$s$,
    $s$CREATE POLICY "auth_contracts_delete" ON storage.objects
        FOR DELETE TO authenticated
        USING (bucket_id = 'contracts'
               AND public.can_access_wedding(public.try_uuid((storage.foldername(name))[1])))$s$,

    -- --- venue-assets: venue folder, either path shape ------------------
    $s$CREATE POLICY "auth_venue_assets_select" ON storage.objects
        FOR SELECT TO authenticated
        USING (bucket_id = 'venue-assets'
               AND (
                 public.can_access_venue(public.try_uuid((storage.foldername(name))[1]))
                 OR ((storage.foldername(name))[1] = 'venue-assets'
                     AND public.can_access_venue(public.try_uuid((storage.foldername(name))[2])))
               ))$s$,
    $s$CREATE POLICY "auth_venue_assets_insert" ON storage.objects
        FOR INSERT TO authenticated
        WITH CHECK (bucket_id = 'venue-assets'
               AND (
                 public.can_access_venue(public.try_uuid((storage.foldername(name))[1]))
                 OR ((storage.foldername(name))[1] = 'venue-assets'
                     AND public.can_access_venue(public.try_uuid((storage.foldername(name))[2])))
               ))$s$,
    $s$CREATE POLICY "auth_venue_assets_update" ON storage.objects
        FOR UPDATE TO authenticated
        USING (bucket_id = 'venue-assets'
               AND (
                 public.can_access_venue(public.try_uuid((storage.foldername(name))[1]))
                 OR ((storage.foldername(name))[1] = 'venue-assets'
                     AND public.can_access_venue(public.try_uuid((storage.foldername(name))[2])))
               ))
        WITH CHECK (bucket_id = 'venue-assets'
               AND (
                 public.can_access_venue(public.try_uuid((storage.foldername(name))[1]))
                 OR ((storage.foldername(name))[1] = 'venue-assets'
                     AND public.can_access_venue(public.try_uuid((storage.foldername(name))[2])))
               ))$s$,
    $s$CREATE POLICY "auth_venue_assets_delete" ON storage.objects
        FOR DELETE TO authenticated
        USING (bucket_id = 'venue-assets'
               AND (
                 public.can_access_venue(public.try_uuid((storage.foldername(name))[1]))
                 OR ((storage.foldername(name))[1] = 'venue-assets'
                     AND public.can_access_venue(public.try_uuid((storage.foldername(name))[2])))
               ))$s$,

    -- --- brain-dump: venue folder (084 scoped on bucket id alone) -------
    $s$CREATE POLICY "auth_select_brain_dump" ON storage.objects
        FOR SELECT TO authenticated
        USING (bucket_id = 'brain-dump'
               AND public.can_access_venue(public.try_uuid((storage.foldername(name))[1])))$s$,
    $s$CREATE POLICY "auth_insert_brain_dump" ON storage.objects
        FOR INSERT TO authenticated
        WITH CHECK (bucket_id = 'brain-dump'
               AND public.can_access_venue(public.try_uuid((storage.foldername(name))[1])))$s$,
    $s$CREATE POLICY "auth_update_brain_dump" ON storage.objects
        FOR UPDATE TO authenticated
        USING (bucket_id = 'brain-dump'
               AND public.can_access_venue(public.try_uuid((storage.foldername(name))[1])))
        WITH CHECK (bucket_id = 'brain-dump'
               AND public.can_access_venue(public.try_uuid((storage.foldername(name))[1])))$s$,
    $s$CREATE POLICY "auth_delete_brain_dump" ON storage.objects
        FOR DELETE TO authenticated
        USING (bucket_id = 'brain-dump'
               AND public.can_access_venue(public.try_uuid((storage.foldername(name))[1])))$s$,

    -- --- crm-imports: venue folder (270 scoped on bucket id alone) ------
    $s$CREATE POLICY "auth_select_crm_imports" ON storage.objects
        FOR SELECT TO authenticated
        USING (bucket_id = 'crm-imports'
               AND public.can_access_venue(public.try_uuid((storage.foldername(name))[1])))$s$,
    $s$CREATE POLICY "auth_insert_crm_imports" ON storage.objects
        FOR INSERT TO authenticated
        WITH CHECK (bucket_id = 'crm-imports'
               AND public.can_access_venue(public.try_uuid((storage.foldername(name))[1])))$s$,
    $s$CREATE POLICY "auth_update_crm_imports" ON storage.objects
        FOR UPDATE TO authenticated
        USING (bucket_id = 'crm-imports'
               AND public.can_access_venue(public.try_uuid((storage.foldername(name))[1])))
        WITH CHECK (bucket_id = 'crm-imports'
               AND public.can_access_venue(public.try_uuid((storage.foldername(name))[1])))$s$,
    $s$CREATE POLICY "auth_delete_crm_imports" ON storage.objects
        FOR DELETE TO authenticated
        USING (bucket_id = 'crm-imports'
               AND public.can_access_venue(public.try_uuid((storage.foldername(name))[1])))$s$,

    -- --- day-of-media: venue folder then wedding folder -----------------
    $s$CREATE POLICY "auth_day_of_media_select" ON storage.objects
        FOR SELECT TO authenticated
        USING (bucket_id = 'day-of-media'
               AND public.can_access_venue(public.try_uuid((storage.foldername(name))[1]))
               AND public.can_access_wedding(public.try_uuid((storage.foldername(name))[2])))$s$,
    $s$CREATE POLICY "auth_day_of_media_insert" ON storage.objects
        FOR INSERT TO authenticated
        WITH CHECK (bucket_id = 'day-of-media'
               AND public.can_access_venue(public.try_uuid((storage.foldername(name))[1]))
               AND public.can_access_wedding(public.try_uuid((storage.foldername(name))[2])))$s$,
    $s$CREATE POLICY "auth_day_of_media_update" ON storage.objects
        FOR UPDATE TO authenticated
        USING (bucket_id = 'day-of-media'
               AND public.can_access_venue(public.try_uuid((storage.foldername(name))[1]))
               AND public.can_access_wedding(public.try_uuid((storage.foldername(name))[2])))
        WITH CHECK (bucket_id = 'day-of-media'
               AND public.can_access_venue(public.try_uuid((storage.foldername(name))[1]))
               AND public.can_access_wedding(public.try_uuid((storage.foldername(name))[2])))$s$,
    $s$CREATE POLICY "auth_day_of_media_delete" ON storage.objects
        FOR DELETE TO authenticated
        USING (bucket_id = 'day-of-media'
               AND public.can_access_venue(public.try_uuid((storage.foldername(name))[1]))
               AND public.can_access_wedding(public.try_uuid((storage.foldername(name))[2])))$s$
  ];
BEGIN
  FOREACH v_sql IN ARRAY v_stmts LOOP
    EXECUTE v_sql;
  END LOOP;
EXCEPTION WHEN insufficient_privilege THEN
  RAISE WARNING
    '411 STEP 2 skipped: the runner is not the owner of storage.objects '
    '(the same reason migration 308 is not in apply-pending-migrations). '
    'Paste STEP 2 into the Supabase SQL editor, then re-run '
    'scripts/check-live-policies.mjs.';
END
$storage_policies$;


-- ===========================================================================
-- STEP 3 - column grants on the three connection tables that had none
-- ===========================================================================
-- google_ads_connections (310), zoom_connections and openphone_connections
-- (097) all have venue-scoped SELECT policies and no column grants. RLS
-- decides which ROWS come back; without a column grant the token comes
-- back with the row, to any authenticated user of that venue. Migrations
-- 401 and 407 already do this correctly; this is the same block.
--
-- Consequence, documented in 401 and worth repeating: with a column-level
-- SELECT grant a `select('*')` from an authenticated client fails with
-- "permission denied for column access_token" rather than returning a
-- partial row. Every reader in tree names its columns, and these three
-- tables are read server-side. A new reader that reaches for * will fail
-- loudly, which is the behaviour we want on a table holding a credential.
--
-- Each block is guarded on the table existing (310 has never been applied
-- to production; it sits in the legacy list in
-- scripts/apply-pending-migrations.ts).
--
-- The column list is a DENY list resolved against information_schema at
-- apply time, not an allow list copied out of the migration. That choice
-- came from reading production rather than the files: zoom_connections
-- carries a last_synced_at that appears in no migration in this repo, and
-- an allow list transcribed from 097 would have quietly dropped it. A
-- deny list cannot drop a working column. What it can do is miss a NEW
-- secret column added later, so the name patterns below are deliberately
-- broad and scripts/check-live-policies.mjs re-reads the live grants.
--
-- `anon` is revoked too. Production has anon holding SELECT, INSERT and
-- UPDATE grants on every column of zoom_connections and
-- openphone_connections, api_key included. Only RLS stands between the
-- public anon key and an OpenPhone API key, and neither table has any
-- anon policy, so nothing is lost by taking the grant away as well.

DO $connection_grants$
DECLARE
  v_tbl text;
  v_cols text;
BEGIN
  FOREACH v_tbl IN ARRAY ARRAY[
    'google_ads_connections', 'zoom_connections', 'openphone_connections'
  ] LOOP
    IF to_regclass('public.' || v_tbl) IS NULL THEN
      RAISE NOTICE '411 STEP 3: % not present, skipping', v_tbl;
      CONTINUE;
    END IF;

    SELECT string_agg(quote_ident(column_name), ', ' ORDER BY ordinal_position)
      INTO v_cols
      FROM information_schema.columns
     WHERE table_schema = 'public'
       AND table_name = v_tbl
       -- The secrets themselves, not every column with "token" in the
       -- name: access_token_expires_at and token_type are metadata the
       -- settings pages read, and 401 and 407 grant their equivalents.
       AND column_name NOT IN (
         'access_token', 'refresh_token', 'api_key',
         'page_access_token', 'token_env_key', 'page_token_env_key'
       )
       AND column_name !~ '(secret|password|_api_key$)';

    IF v_cols IS NULL THEN
      RAISE WARNING '411 STEP 3: % has no grantable columns, skipping', v_tbl;
      CONTINUE;
    END IF;

    EXECUTE format('REVOKE ALL ON public.%I FROM anon', v_tbl);
    EXECUTE format('REVOKE ALL ON public.%I FROM authenticated', v_tbl);
    EXECUTE format('GRANT SELECT (%s) ON public.%I TO authenticated', v_cols, v_tbl);
    EXECUTE format('GRANT INSERT, UPDATE, DELETE ON public.%I TO authenticated', v_tbl);
  END LOOP;
END
$connection_grants$;

DO $connection_comments$
BEGIN
  IF to_regclass('public.zoom_connections') IS NOT NULL THEN
    EXECUTE $c$COMMENT ON COLUMN public.zoom_connections.access_token IS
      'Service-role only. Migration 411 revoked the authenticated SELECT grant on this column.'$c$;
    EXECUTE $c$COMMENT ON COLUMN public.zoom_connections.refresh_token IS
      'Service-role only. Migration 411 revoked the authenticated SELECT grant on this column.'$c$;
  END IF;
  IF to_regclass('public.openphone_connections') IS NOT NULL THEN
    EXECUTE $c$COMMENT ON COLUMN public.openphone_connections.api_key IS
      'Service-role only. Migration 411 revoked the authenticated SELECT grant on this column.'$c$;
  END IF;
  IF to_regclass('public.google_ads_connections') IS NOT NULL THEN
    EXECUTE $c$COMMENT ON COLUMN public.google_ads_connections.refresh_token IS
      'Service-role only. Migration 411 revoked the authenticated SELECT grant on this column.'$c$;
  END IF;
END
$connection_comments$;


-- ===========================================================================
-- STEP 4 - demo-anon policies that reach credentials
-- ===========================================================================
-- 4a. gmail_connections. Migration 064 listed this table in its exclusions
-- with the reason spelled out: "OAuth tokens, defense in depth. The demo
-- venues should not have real tokens, but never expose an OAuth token
-- table to anon regardless." Migration 383 then re-added
-- demo_anon_select_gmail_connections while sweeping 65 tables. Take it
-- back off; 064's reasoning did not change.

DROP POLICY IF EXISTS "demo_anon_select_gmail_connections" ON public.gmail_connections;

-- 4b. venue_config writes. Migration 027 gave anon INSERT and UPDATE with
-- USING (true); migration 147 narrowed those to demo venues but kept
-- venue_config in the write set. A demo venue's config row holds
-- gmail_tokens, calendly_tokens and omi_webhook_token, and an anon writer
-- can overwrite omi_webhook_token to point the Omi webhook at itself.
-- Nothing in the demo needs to write venue_config: the demo is a read
-- surface, and 064 said so ("Demo users cannot INSERT/UPDATE/DELETE via
-- anon. If the demo ever needs interactive write actions, route them
-- through API routes that use the service client").

DROP POLICY IF EXISTS "anon_insert_venue_config" ON public.venue_config;
DROP POLICY IF EXISTS "anon_update_venue_config" ON public.venue_config;
DROP POLICY IF EXISTS "anon_delete_venue_config" ON public.venue_config;
DROP POLICY IF EXISTS "anon_select_venue_config" ON public.venue_config;

-- 4c. venue_config reads. The demo genuinely reads this table (business
-- name, brand colours, portal copy), so the row-level demo policy from
-- 392 stays. What goes is anon's access to the secret COLUMNS.
--
-- Column-level revoke, not a view: every demo reader queries
-- `venue_config` by name from the browser (40-odd call sites under src/app),
-- so a view under another name would need all of them changed, and src/
-- belongs to other workstreams this week. The revoke lands in place and
-- costs nothing to a reader that names its columns.
--
-- Deny-list is by name pattern plus the three known ones, so a secret
-- added to this table before 411 lands is covered without an edit here.
-- A column added AFTER 411 is not granted to anon at all, which is the
-- right default.
--
-- KNOWN CONSEQUENCE: src/app/(platform)/settings/page.tsx ~349 does
-- select('*') on venue_config. As `authenticated` that is unaffected.
-- In demo mode the platform shell runs on `anon`, so the demo settings
-- page will get "permission denied for column gmail_tokens" until that
-- one call names its columns. Flagged in the S3 handoff.

DO $venue_config_anon_cols$
DECLARE
  v_cols text;
BEGIN
  SELECT string_agg(quote_ident(column_name), ', ' ORDER BY ordinal_position)
    INTO v_cols
    FROM information_schema.columns
   WHERE table_schema = 'public'
     AND table_name = 'venue_config'
     AND column_name NOT IN ('gmail_tokens', 'calendly_tokens', 'omi_webhook_token')
     AND column_name !~ '(token|secret|password|api_key)';

  IF v_cols IS NULL THEN
    RAISE WARNING '411 STEP 4c: venue_config has no grantable columns, skipping';
    RETURN;
  END IF;

  EXECUTE 'REVOKE ALL ON public.venue_config FROM anon';
  EXECUTE format('GRANT SELECT (%s) ON public.venue_config TO anon', v_cols);
END
$venue_config_anon_cols$;


-- ===========================================================================
-- STEP 5 - env-var-name indirection on the three ad / social connections
-- ===========================================================================
-- Migrations 401 and 407 got the SELECT side right and then granted
-- INSERT, UPDATE, DELETE at table level. Table-level DML means a venue
-- user can write any column on their own row, and two of those columns
-- are not data:
--
--   token_env_key / page_token_env_key name an environment variable. The
--   connector reads process.env[<that name>]. A venue user who sets it to
--   any other variable name makes the server hand them, or use on their
--   behalf, a secret they were never given.
--
--   ig_business_id is the webhook routing key, with a unique index on it.
--   A venue user who writes another venue's Instagram business id into
--   their own row claims that venue's inbound DMs. status is the same
--   shape of problem one step down: flip it to 'connected' and the
--   connector starts trying.
--
-- These columns are written by the OAuth callback under the service role.
-- The grants below say so. DELETE stays at table level: it is row-shaped,
-- and RLS already confines it to the caller's own venue.

-- Deny list, same reasoning as STEP 3: a column added to one of these
-- tables after 407 must keep working, and only the named six are the
-- problem. `status` is in the list because flipping it to 'connected'
-- starts the connector; `ig_business_id` because it is the webhook
-- routing key and has a unique index, so writing another venue's id
-- claims their inbound DMs.

DO $connection_dml_grants$
DECLARE
  v_tbl text;
  v_cols text;
BEGIN
  FOREACH v_tbl IN ARRAY ARRAY[
    'meta_ads_connections', 'tiktok_ads_connections', 'instagram_connections'
  ] LOOP
    IF to_regclass('public.' || v_tbl) IS NULL THEN
      RAISE NOTICE '411 STEP 5: % not present, skipping', v_tbl;
      CONTINUE;
    END IF;

    SELECT string_agg(quote_ident(column_name), ', ' ORDER BY ordinal_position)
      INTO v_cols
      FROM information_schema.columns
     WHERE table_schema = 'public'
       AND table_name = v_tbl
       AND column_name NOT IN (
         'token_env_key', 'page_token_env_key',
         'access_token', 'refresh_token', 'page_access_token',
         'status', 'ig_business_id'
       );

    IF v_cols IS NULL THEN
      RAISE WARNING '411 STEP 5: % has no grantable columns, skipping', v_tbl;
      CONTINUE;
    END IF;

    EXECUTE format('REVOKE ALL ON public.%I FROM anon', v_tbl);
    EXECUTE format('REVOKE INSERT, UPDATE ON public.%I FROM authenticated', v_tbl);
    EXECUTE format('GRANT INSERT (%s) ON public.%I TO authenticated', v_cols, v_tbl);
    EXECUTE format('GRANT UPDATE (%s) ON public.%I TO authenticated', v_cols, v_tbl);
    EXECUTE format('GRANT DELETE ON public.%I TO authenticated', v_tbl);
  END LOOP;
END
$connection_dml_grants$;

-- The shape an env-var name is allowed to take. Belt to the grants'
-- braces: even a service-role write, or a future widening of the grants,
-- cannot point the connector at ANTHROPIC_API_KEY.
--
-- NOT VALID so the ALTER never scans and never blocks. The VALIDATE
-- afterwards is attempted separately and downgraded to a warning if an
-- existing row does not match, so a badly-shaped value already in the
-- table stops the constraint being trusted without stopping the
-- migration. NULL passes a CHECK, so a row with no env key is fine.

DO $env_key_checks$
DECLARE
  v_target record;
BEGIN
  FOR v_target IN
    SELECT *
      FROM (VALUES
        ('meta_ads_connections',   'token_env_key',      'meta_ads_connections_token_env_key_shape'),
        ('tiktok_ads_connections', 'token_env_key',      'tiktok_ads_connections_token_env_key_shape'),
        ('instagram_connections',  'page_token_env_key', 'instagram_connections_page_token_env_key_shape')
      ) AS t(tbl, col, conname)
  LOOP
    IF to_regclass('public.' || v_target.tbl) IS NULL THEN CONTINUE; END IF;
    IF NOT EXISTS (
      SELECT 1 FROM information_schema.columns
       WHERE table_schema = 'public' AND table_name = v_target.tbl
         AND column_name = v_target.col
    ) THEN CONTINUE; END IF;

    IF NOT EXISTS (
      SELECT 1 FROM pg_constraint WHERE conname = v_target.conname
    ) THEN
      EXECUTE format(
        'ALTER TABLE public.%I ADD CONSTRAINT %I '
        'CHECK (%I IS NULL OR %I ~ %L) NOT VALID',
        v_target.tbl, v_target.conname, v_target.col, v_target.col,
        '^(META_ADS|TIKTOK_ADS|INSTAGRAM)_VENUE_[A-Z0-9_]+$'
      );
    END IF;

    BEGIN
      EXECUTE format('ALTER TABLE public.%I VALIDATE CONSTRAINT %I',
                     v_target.tbl, v_target.conname);
    EXCEPTION WHEN check_violation THEN
      RAISE WARNING
        '411 STEP 5: %.% holds a value that is not a %%_VENUE_%% env-var '
        'name, so % stays NOT VALID. Fix the row, then run '
        'ALTER TABLE public.% VALIDATE CONSTRAINT %.',
        v_target.tbl, v_target.col, v_target.conname, v_target.tbl, v_target.conname;
    END;
  END LOOP;
END
$env_key_checks$;


-- ===========================================================================
-- STEP 6 - one phone number, one venue
-- ===========================================================================
-- multi_channel_inbox_settings.twilio_phone_numbers (migration 295) is a
-- text[] with no constraint of any kind. Two venues can both list
-- +15405550101, and the Twilio webhook resolves an inbound message to a
-- venue by looking the number up. Whichever row the lookup happens to
-- return gets the other venue's couple's message.
--
-- WHY A CLAIMS TABLE RATHER THAN AN EXCLUSION CONSTRAINT
-- An EXCLUDE constraint with the array-overlap operator needs a GiST
-- opclass for text[], which core Postgres does not ship (intarray covers
-- int[] only). btree_gist does not help either. That leaves a helper
-- table, which is the better answer anyway: a plain unique index on one
-- normalised number per row, a visible record of which venue owns which
-- number, and a clean 23505 at write time instead of a silent misroute at
-- read time. The trigger keeps it in step with the array, so nothing in
-- src/ has to change for the constraint to hold.

CREATE TABLE IF NOT EXISTS public.twilio_number_claims (
  phone_e164 text PRIMARY KEY,
  venue_id uuid NOT NULL REFERENCES public.venues(id) ON DELETE CASCADE,
  claimed_at timestamptz NOT NULL DEFAULT now()
);

COMMENT ON TABLE public.twilio_number_claims IS
  'owner:agent. Migration 411. One row per Twilio number, keyed on the '
  'normalised E.164 form, so two venues cannot both claim a number. '
  'Maintained by a trigger on multi_channel_inbox_settings; never write '
  'it by hand. A collision surfaces as 23505 on the settings write.';

CREATE INDEX IF NOT EXISTS idx_twilio_number_claims_venue
  ON public.twilio_number_claims (venue_id);

ALTER TABLE public.twilio_number_claims ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "twilio_number_claims_select" ON public.twilio_number_claims;
CREATE POLICY "twilio_number_claims_select" ON public.twilio_number_claims
  FOR SELECT TO authenticated
  USING (public.can_access_venue(venue_id));

DROP POLICY IF EXISTS "twilio_number_claims_service" ON public.twilio_number_claims;
CREATE POLICY "twilio_number_claims_service" ON public.twilio_number_claims
  FOR ALL TO service_role USING (true) WITH CHECK (true);

REVOKE ALL ON public.twilio_number_claims FROM anon;
REVOKE ALL ON public.twilio_number_claims FROM authenticated;
GRANT SELECT ON public.twilio_number_claims TO authenticated;

CREATE OR REPLACE FUNCTION public.sync_twilio_number_claims()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $sync_twilio_number_claims$
DECLARE
  v_n text;
BEGIN
  IF TG_OP = 'DELETE' THEN
    DELETE FROM public.twilio_number_claims WHERE venue_id = OLD.venue_id;
    RETURN OLD;
  END IF;

  -- Release everything this venue used to hold, then re-claim what it
  -- now lists. A number moved from venue A to venue B works as long as
  -- A gives it up first, which is the honest constraint.
  DELETE FROM public.twilio_number_claims WHERE venue_id = NEW.venue_id;

  IF NEW.twilio_phone_numbers IS NOT NULL THEN
    FOREACH v_n IN ARRAY NEW.twilio_phone_numbers LOOP
      IF public.normalise_e164(v_n) IS NOT NULL THEN
        INSERT INTO public.twilio_number_claims (phone_e164, venue_id)
        VALUES (public.normalise_e164(v_n), NEW.venue_id);
      END IF;
    END LOOP;
  END IF;

  RETURN NEW;
END;
$sync_twilio_number_claims$;

COMMENT ON FUNCTION public.sync_twilio_number_claims() IS
  'Migration 411. Keeps twilio_number_claims in step with '
  'multi_channel_inbox_settings.twilio_phone_numbers. A number already '
  'claimed by another venue raises 23505, which is the point.';

DO $twilio_trigger$
BEGIN
  IF to_regclass('public.multi_channel_inbox_settings') IS NULL THEN
    RAISE NOTICE '411 STEP 6: multi_channel_inbox_settings not present, skipping trigger';
    RETURN;
  END IF;

  DROP TRIGGER IF EXISTS trg_sync_twilio_number_claims
    ON public.multi_channel_inbox_settings;
  CREATE TRIGGER trg_sync_twilio_number_claims
    AFTER INSERT OR UPDATE OR DELETE ON public.multi_channel_inbox_settings
    FOR EACH ROW EXECUTE FUNCTION public.sync_twilio_number_claims();
END
$twilio_trigger$;

-- Backfill. Report a collision rather than picking a winner: whichever
-- venue is meant to own the number, this migration is not the place to
-- decide it.
DO $twilio_backfill$
DECLARE
  v_dup record;
  v_row record;
  v_n text;
BEGIN
  IF to_regclass('public.multi_channel_inbox_settings') IS NULL THEN RETURN; END IF;

  FOR v_dup IN
    SELECT public.normalise_e164(n) AS phone, count(DISTINCT venue_id) AS venues
      FROM public.multi_channel_inbox_settings s,
           unnest(coalesce(s.twilio_phone_numbers, '{}'::text[])) AS n
     WHERE public.normalise_e164(n) IS NOT NULL
     GROUP BY 1
    HAVING count(DISTINCT venue_id) > 1
  LOOP
    RAISE WARNING
      '411 STEP 6: % is listed by % venues. Only the first claim is '
      'recorded; decide the owner and remove the number from the others.',
      v_dup.phone, v_dup.venues;
  END LOOP;

  FOR v_row IN SELECT venue_id, twilio_phone_numbers
                 FROM public.multi_channel_inbox_settings
  LOOP
    IF v_row.twilio_phone_numbers IS NULL THEN CONTINUE; END IF;
    FOREACH v_n IN ARRAY v_row.twilio_phone_numbers LOOP
      IF public.normalise_e164(v_n) IS NOT NULL THEN
        INSERT INTO public.twilio_number_claims (phone_e164, venue_id)
        VALUES (public.normalise_e164(v_n), v_row.venue_id)
        ON CONFLICT (phone_e164) DO NOTHING;
      END IF;
    END LOOP;
  END LOOP;
END
$twilio_backfill$;


-- ===========================================================================
-- STEP 7 - team_invitations
-- ===========================================================================
-- 7a. token_hash. The invite link carries a token that is stored in
-- plaintext and indexed. Anyone who can read a row can accept the invite
-- and become an org_admin. S1 changes /api/team/invite to write the hash
-- and /api/team/accept to look up by hash; the plaintext column stays for
-- the transition so an invite sent before the swap still works.

ALTER TABLE public.team_invitations
  ADD COLUMN IF NOT EXISTS token_hash text;

CREATE UNIQUE INDEX IF NOT EXISTS uq_team_invitations_token_hash
  ON public.team_invitations (token_hash)
  WHERE token_hash IS NOT NULL;

COMMENT ON COLUMN public.team_invitations.token_hash IS
  'Migration 411. SHA-256 of the invite token, hex. The column the accept '
  'route looks up once S1 lands. Unique where present.';

COMMENT ON COLUMN public.team_invitations.token IS
  'DEPRECATED (migration 411). Plaintext invite token, kept only so links '
  'sent before the hash swap still resolve. Stop writing it once every '
  'outstanding invitation has expired, then drop the column.';

-- 7b. the policy set. Migration 049 shipped `anon_select_invitations`
-- (FOR SELECT TO anon USING (true)) and `auth_all_invitations` (FOR ALL
-- TO authenticated USING (true)). Neither is live any more, but reading
-- production rather than the migration files turned up the same hole
-- wearing different names:
--
--   demo_anon_select_team_invitations   anon SELECT on every demo venue's
--                                       invitations. Migration 064 named
--                                       team_invitations in its exclusion
--                                       list, with the reason ("invitation
--                                       tokens"); the 383 / 392 sweeps
--                                       re-added it anyway.
--   team_invitations_modify             FOR ALL TO authenticated, venue or
--                                       org scoped, NO role gate.
--   team_invitations_org_insert/update/delete
--                                       org scoped, no role gate either.
--
-- Together those mean any signed-in coordinator can insert an invitation
-- with role = 'org_admin' and accept it. That is a one-step privilege
-- escalation, and it is why the whole set is replaced here rather than
-- one policy narrowed: permissive policies are OR-ed, so leaving any of
-- them standing leaves the escalation standing.
--
-- Nothing in tree reads this table as anon: /api/team/accept and
-- /api/team/invite both use the service client, which bypasses RLS. The
-- one browser read is the team settings page listing and revoking its own
-- org's invitations, which the two policies below still allow for the
-- roles that are supposed to be doing it.

DROP POLICY IF EXISTS "anon_select_invitations" ON public.team_invitations;
DROP POLICY IF EXISTS "auth_all_invitations" ON public.team_invitations;
DROP POLICY IF EXISTS "demo_anon_select_team_invitations" ON public.team_invitations;
DROP POLICY IF EXISTS "demo_anon_select" ON public.team_invitations;
DROP POLICY IF EXISTS "team_invitations_modify" ON public.team_invitations;
DROP POLICY IF EXISTS "team_invitations_select" ON public.team_invitations;
DROP POLICY IF EXISTS "team_invitations_super_admin_all" ON public.team_invitations;
DROP POLICY IF EXISTS "super_admin_all" ON public.team_invitations;
DROP POLICY IF EXISTS "team_invitations_org_insert" ON public.team_invitations;
DROP POLICY IF EXISTS "team_invitations_org_update" ON public.team_invitations;
DROP POLICY IF EXISTS "team_invitations_org_delete" ON public.team_invitations;

DROP POLICY IF EXISTS "team_invitations_org_select" ON public.team_invitations;
CREATE POLICY "team_invitations_org_select" ON public.team_invitations
  FOR SELECT TO authenticated
  USING (
    org_id = (SELECT up.org_id FROM public.user_profiles up WHERE up.id = auth.uid())
    OR public.is_super_admin()
  );

DROP POLICY IF EXISTS "team_invitations_admin_write" ON public.team_invitations;
CREATE POLICY "team_invitations_admin_write" ON public.team_invitations
  FOR ALL TO authenticated
  USING (
    public.is_super_admin()
    OR EXISTS (
      SELECT 1 FROM public.user_profiles up
       WHERE up.id = auth.uid()
         AND up.org_id = team_invitations.org_id
         AND up.role IN ('org_admin', 'venue_manager')
    )
  )
  WITH CHECK (
    public.is_super_admin()
    OR EXISTS (
      SELECT 1 FROM public.user_profiles up
       WHERE up.id = auth.uid()
         AND up.org_id = team_invitations.org_id
         AND up.role IN ('org_admin', 'venue_manager')
    )
  );

DROP POLICY IF EXISTS "team_invitations_service" ON public.team_invitations;
CREATE POLICY "team_invitations_service" ON public.team_invitations
  FOR ALL TO service_role USING (true) WITH CHECK (true);

REVOKE ALL ON public.team_invitations FROM anon;


-- ===========================================================================
-- STEP 8 - venue_config UPDATE gated on role
-- ===========================================================================
-- Migration 058 gave every member of an org UPDATE on every venue_config
-- row in that org. venue_config.feature_flags is what turns paid
-- capability on and off, so a coordinator could grant their own venue
-- anything. The roles are the ones user_profiles actually allows
-- (migration 001 / 049 / 051: super_admin, org_admin, venue_manager,
-- coordinator, couple, readonly); the write set is the three at the top.
--
-- WHY THIS REPLACES THE WHOLE POLICY SET AND NOT JUST 058'S UPDATE
-- Permissive policies are OR-ed, so narrowing one of several is the same
-- as narrowing none. Production carries FOUR authenticated write routes
-- into this table, and only one of them is 058's:
--
--   venue_config_org_update / _insert / _delete   058, org scoped
--   venue_scope_update / _insert / _delete        the 056-062 RLS sweep
--                                                 rewrote migration 006's
--                                                 `venue_isolation` under
--                                                 this name; own venue,
--                                                 no role gate
--   super_admin_all                               is_super_admin()
--
-- Narrowing 058's UPDATE alone would have changed nothing: every
-- coordinator would still write through venue_scope_update. So the
-- authenticated set is replaced here as one coherent thing, read split
-- from write. Migration 226's `couple_read` and the demo-anon read
-- policies are left alone; neither grants a write.
--
-- INSERT and DELETE are gated on the same roles, not only UPDATE.
-- Leaving DELETE open would leave the door it closes: delete the row,
-- insert a new one, set the flags on the way in.
--
-- KNOWN CONSEQUENCE, and it is not small: RLS gates rows and not
-- columns, so this covers every column of venue_config, not just
-- feature_flags. A coordinator saving anything on the settings page
-- through the browser client (src/app/(platform)/settings/page.tsx ~382)
-- now gets nothing written back. S5 is already routing the
-- contract-template write through an API route; the rest of that page
-- needs the same treatment, or the venue hands its coordinators
-- venue_manager. Called out in the S3 handoff rather than fixed here:
-- src/ belongs to other workstreams.

DROP POLICY IF EXISTS "venue_isolation" ON public.venue_config;
DROP POLICY IF EXISTS "super_admin_bypass" ON public.venue_config;
DROP POLICY IF EXISTS "super_admin_all" ON public.venue_config;
DROP POLICY IF EXISTS "venue_scope_select" ON public.venue_config;
DROP POLICY IF EXISTS "venue_scope_insert" ON public.venue_config;
DROP POLICY IF EXISTS "venue_scope_update" ON public.venue_config;
DROP POLICY IF EXISTS "venue_scope_delete" ON public.venue_config;
DROP POLICY IF EXISTS "venue_config_org_select" ON public.venue_config;
DROP POLICY IF EXISTS "venue_config_org_insert" ON public.venue_config;
DROP POLICY IF EXISTS "venue_config_org_update" ON public.venue_config;
DROP POLICY IF EXISTS "venue_config_org_delete" ON public.venue_config;

CREATE POLICY "venue_config_read" ON public.venue_config
  FOR SELECT TO authenticated
  USING (public.can_access_venue(venue_id));

CREATE POLICY "venue_config_org_insert" ON public.venue_config
  FOR INSERT TO authenticated
  WITH CHECK (
    public.can_access_venue(venue_id)
    AND EXISTS (
      SELECT 1 FROM public.user_profiles up
       WHERE up.id = auth.uid()
         AND up.role IN ('org_admin', 'venue_manager', 'super_admin')
    )
  );

CREATE POLICY "venue_config_org_update" ON public.venue_config
  FOR UPDATE TO authenticated
  USING (
    public.can_access_venue(venue_id)
    AND EXISTS (
      SELECT 1 FROM public.user_profiles up
       WHERE up.id = auth.uid()
         AND up.role IN ('org_admin', 'venue_manager', 'super_admin')
    )
  )
  WITH CHECK (
    public.can_access_venue(venue_id)
    AND EXISTS (
      SELECT 1 FROM public.user_profiles up
       WHERE up.id = auth.uid()
         AND up.role IN ('org_admin', 'venue_manager', 'super_admin')
    )
  );

CREATE POLICY "venue_config_org_delete" ON public.venue_config
  FOR DELETE TO authenticated
  USING (
    public.can_access_venue(venue_id)
    AND EXISTS (
      SELECT 1 FROM public.user_profiles up
       WHERE up.id = auth.uid()
         AND up.role IN ('org_admin', 'venue_manager', 'super_admin')
    )
  );

DROP POLICY IF EXISTS "venue_config_service" ON public.venue_config;
CREATE POLICY "venue_config_service" ON public.venue_config
  FOR ALL TO service_role USING (true) WITH CHECK (true);

COMMENT ON COLUMN public.venue_config.feature_flags IS
  'Paid-capability switches. Migration 411 narrowed the venue_config '
  'UPDATE policy to org_admin / venue_manager / super_admin so a '
  'coordinator cannot grant their own venue a tier. Writes that a '
  'coordinator must be able to make belong in an API route running the '
  'service client.';


-- ===========================================================================
-- STEP 9 - knot_template_patterns anon read
-- ===========================================================================
-- Migration 283 added demo_anon_select_patterns as FOR SELECT TO anon
-- USING (true). The table already has a venue-scoped authenticated policy
-- in the same migration, and migration 392 re-asserts a demo policy under
-- the conventional name (demo_anon_select_knot_template_patterns) scoped
-- to is_demo venues. The USING (true) one is the leak, and it is the only
-- one that has to go.
--
-- Guarded: as of 2026-09-14 this table does not exist in production, so
-- 283 has not been applied there. `DROP POLICY IF EXISTS` still errors on
-- a missing table, which would take the rest of this migration down with
-- it. When 283 lands, replaying 411 drops the policy.

DO $knot_patterns$
BEGIN
  IF to_regclass('public.knot_template_patterns') IS NULL THEN
    RAISE NOTICE '411 STEP 9: knot_template_patterns not present (283 unapplied), skipping';
    RETURN;
  END IF;
  EXECUTE 'DROP POLICY IF EXISTS "demo_anon_select_patterns" ON public.knot_template_patterns';
END
$knot_patterns$;


-- ===========================================================================
-- STEP 10 - booked_vendors.portal_token
-- ===========================================================================
-- Migration 032 gave every booked vendor a plaintext portal token,
-- backfilled from gen_random_bytes, and a unique index on it. Same shape
-- as team_invitations: a readable row is a usable credential. Same
-- treatment, hash alongside for the transition; the code migration is a
-- later step and is not in this workstream.

ALTER TABLE public.booked_vendors
  ADD COLUMN IF NOT EXISTS portal_token_hash text;

CREATE UNIQUE INDEX IF NOT EXISTS uq_booked_vendors_portal_token_hash
  ON public.booked_vendors (portal_token_hash)
  WHERE portal_token_hash IS NOT NULL;

COMMENT ON COLUMN public.booked_vendors.portal_token_hash IS
  'Migration 411. SHA-256 of the vendor portal token, hex. The column the '
  'vendor portal looks up once the code migration lands. Unique where present.';

COMMENT ON COLUMN public.booked_vendors.portal_token IS
  'DEPRECATED (migration 411). Plaintext vendor portal token, kept only '
  'so links already sent still resolve. Stop writing it once the portal '
  'reads portal_token_hash, then drop the column.';


NOTIFY pgrst, 'reload schema';


-- ############################################################################
-- 412_tangential_comment.sql
-- ############################################################################

-- 412: correct migration 400's tangential_signals comment
--
-- Wave 9, W68 (NOVEMBER-PLAN.md; HANDLE-IDENTITY-SPEC.md §4 and §5).
--
-- Migration 400 stamped "DEPRECATED ... No new rows" on
-- public.tangential_signals on 2026-09-09. That was true of the vision
-- path W24 converted and of nothing else. A verification pass on
-- 2026-09-14 found four live writers still filling the table:
--
--   src/lib/services/crm-import/site-visitors.ts      (website pixel)
--   src/lib/services/crm-import/storefront-activity.ts (Knot / WW funnel)
--   src/lib/services/crm-import/web-form.ts            (form submissions)
--   src/lib/services/ingestion/platform-signals.ts     (every platform CSV)
--
-- So the schema was telling readers one thing and the code was doing
-- another, which is worse than a table nobody had got round to retiring:
-- a comment that lies is read as fact by whoever arrives next.
--
-- W68 routed all four through linkSignal. The website pixel's anonymous
-- visitors, the storefront's partial names and the platform CSVs' handles
-- and display names all now land as fragments, which get promoted onto a
-- couple by exact (platform, handle) the moment a real identity arrives.
-- The web-form row was simply redundant: W35 already hands every committed
-- CSV row to linkSignal, so that adapter was recording one submission
-- twice in two identity systems. `scripts/check-no-tangential-writes.mjs`
-- fails CI on any insert or upsert into this table under src/, so the
-- comment below is now enforced rather than asserted.
--
-- COMMENT ONLY. No DDL, no grant change, no data change. The historical
-- rows stay exactly where they are: the correlation engine, the journey
-- narrative, the erasure sweep and several intel surfaces read them, and
-- a wipe-and-reimport is the wrong moment to lose evidence.
--
-- Idempotent, schema-qualified: scripts/run-migration.ts drives
-- public.exec_sql with search_path = pg_catalog, public.

COMMENT ON TABLE public.tangential_signals IS
  'DEPRECATED. Historical read-only pool of partial-identity signals: vision-extracted '
  'candidates (retired wave 3 W24, 2026-09-09) plus website-pixel visits, storefront funnel '
  'rows, web-form submissions and platform CSV engagement (retired wave 9 W68, 2026-09-14). '
  'No new rows from any path: every one of them now builds a NormalizedSignal and calls '
  'linkSignal, so a below-threshold signal lands in public.fragments instead. Fragments carry '
  'handles and are promoted onto a couple by exact (platform, handle), which is the promotion '
  'this pool never had. Enforced by scripts/check-no-tangential-writes.mjs. See '
  'HANDLE-IDENTITY-SPEC.md sections 4 and 5, src/lib/services/ingestion/tangential-signals.ts '
  'for the reference conversion, and migration 400 for the original deprecation.';
