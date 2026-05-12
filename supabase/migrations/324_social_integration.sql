-- ---------------------------------------------------------------------------
-- 324_social_integration.sql
-- ---------------------------------------------------------------------------
-- Social Integration — Phase 1 schema. Companion to
-- src/lib/services/social/* and /intel/social-integration.
--
-- Why this exists
-- ---------------
-- Instagram (and TikTok / Facebook / Pinterest) do not expose new-follower
-- lists, profile-visit identities, or DM senders via API. The platforms
-- show the data inside the web UI but never give us a structured feed.
-- For Point-Zero forensic attribution, the venue operator captures the
-- data manually once a week (paste the followers list / saves list /
-- engagement list) and Bloom matches the parsed handles against the
-- existing people / weddings tables to surface pre-inquiry engagement.
--
-- A couple who followed the venue on Instagram three weeks before
-- submitting an inquiry is attribution credit -- the inquiry channel is
-- not where they first noticed the venue, the follow is. This module is
-- the substrate for that signal.
--
-- Tables
-- ------
--   social_captures      -- one row per Capture event (operator-triggered)
--   social_engagements   -- one row per parsed handle (the unit of attribution)
--   platform_configs     -- per-venue per-platform settings (venue handle,
--                          override followers URL, recommended frequency)
--
-- V1 scope: only Instagram New Followers is functional end-to-end. Other
-- (platform, metric_type) combos accept the same row shape; the UI gates
-- their capture buttons with a "coming soon" tooltip until the parsers
-- ship.
--
-- Idempotent: every CREATE TABLE / INDEX / POLICY uses IF NOT EXISTS or
-- DROP-then-CREATE. No BEGIN/COMMIT (Wave 23 doctrine -- the exec_sql RPC
-- rejects transaction blocks). Safe to re-run.
--
-- RLS pattern mirrors migration 246 (wedding_lifecycle_events): venue-
-- scoped via user_profiles.venue_id, demo-friendly select.
-- ---------------------------------------------------------------------------

-- ============================================================================
-- TABLE 1 -- social_captures
-- ============================================================================

CREATE TABLE IF NOT EXISTS public.social_captures (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  venue_id uuid NOT NULL REFERENCES public.venues(id) ON DELETE CASCADE,
  platform text NOT NULL CHECK (platform IN ('instagram', 'tiktok', 'facebook', 'pinterest')),
  metric_type text NOT NULL,
  captured_at timestamptz NOT NULL DEFAULT now(),
  captured_by uuid REFERENCES public.user_profiles(id) ON DELETE SET NULL,
  source_text text,
  source_image_path text,
  parse_result jsonb,
  capture_window_start timestamptz,
  capture_window_end timestamptz,
  total_handles integer,
  matched_count integer,
  unmatched_count integer
);

COMMENT ON TABLE public.social_captures IS
  'owner:intel. One row per Capture event the operator triggers from '
  '/intel/social-integration. Stores the raw paste / image path + the '
  'parsed structured output. social_engagements rows reference back via '
  'social_capture_id. Migration 324.';

COMMENT ON COLUMN public.social_captures.venue_id IS
  'Scope key. RLS uses user_profiles.venue_id = this column.';

COMMENT ON COLUMN public.social_captures.platform IS
  'instagram | tiktok | facebook | pinterest. V1 only ships Instagram '
  'New Followers; other combos accepted for forward compatibility.';

COMMENT ON COLUMN public.social_captures.metric_type IS
  'Free-text per-platform metric label. Known values: new_followers, '
  'profile_visits, story_views, post_engagement, dms, profile_views, '
  'video_engagement, page_likes, saves, board_follows. The UI cards '
  'enumerate the supported combos; the column accepts any string so '
  'V1.1 metrics can land without a schema migration.';

COMMENT ON COLUMN public.social_captures.captured_at IS
  'When the operator triggered the capture. Used for "last captured" '
  'recency dot on the platform card. Different from engagement_at on '
  'social_engagements (which is when the engagement happened, best-effort).';

COMMENT ON COLUMN public.social_captures.captured_by IS
  'user_profiles.id of the operator who clicked Capture Now. Nullable '
  'for demo-mode captures (no auth) and for future automation paths.';

COMMENT ON COLUMN public.social_captures.source_text IS
  'Raw paste from the textarea. Kept for audit + reparse-on-bugfix.';

COMMENT ON COLUMN public.social_captures.source_image_path IS
  'Storage path when the operator pasted/uploaded a screenshot instead '
  'of text. V1.1 -- V1 leaves NULL. OCR runs in the parser when set.';

COMMENT ON COLUMN public.social_captures.parse_result IS
  'Parser structured output. Shape: {parsed_count, unique_count, '
  'dedup_count, errors:[], parser_version}. Lets us re-run a matcher '
  'pass without re-parsing.';

COMMENT ON COLUMN public.social_captures.capture_window_start IS
  'For engagements that span a window (post engagement over the last 7 '
  'days, story views over 24h). NULL for point-in-time metrics. Helps '
  'the attribution layer decide whether an engagement_at is exact or '
  'a window estimate.';

COMMENT ON COLUMN public.social_captures.capture_window_end IS
  'See capture_window_start. NULL for point-in-time metrics.';

COMMENT ON COLUMN public.social_captures.total_handles IS
  'Count of parsed handles in this capture (post-dedup).';

COMMENT ON COLUMN public.social_captures.matched_count IS
  'Count of social_engagements rows in this capture that resolved to '
  'a person via the matcher. Denormalized for fast list rendering.';

COMMENT ON COLUMN public.social_captures.unmatched_count IS
  'Count of social_engagements rows in this capture that did not '
  'resolve. unmatched handles are the long tail of brand-aware audience '
  'that has not yet inquired -- valuable as cohort, not as attribution.';

CREATE INDEX IF NOT EXISTS idx_social_captures_venue_platform_metric
  ON public.social_captures (venue_id, platform, metric_type, captured_at DESC);

COMMENT ON INDEX public.idx_social_captures_venue_platform_metric IS
  'Hot path: state endpoint groups by (platform, metric_type) and picks '
  'the latest captured_at per group for the platform-card recency dot.';

CREATE INDEX IF NOT EXISTS idx_social_captures_venue_captured_at
  ON public.social_captures (venue_id, captured_at DESC);

ALTER TABLE public.social_captures ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "social_captures_auth_select" ON public.social_captures;
CREATE POLICY "social_captures_auth_select"
  ON public.social_captures
  FOR SELECT
  TO authenticated
  USING (
    venue_id IN (
      SELECT venue_id FROM public.user_profiles WHERE id = auth.uid()
    )
  );

DROP POLICY IF EXISTS "social_captures_auth_insert" ON public.social_captures;
CREATE POLICY "social_captures_auth_insert"
  ON public.social_captures
  FOR INSERT
  TO authenticated
  WITH CHECK (
    venue_id IN (
      SELECT venue_id FROM public.user_profiles WHERE id = auth.uid()
    )
  );

DROP POLICY IF EXISTS "social_captures_auth_update" ON public.social_captures;
CREATE POLICY "social_captures_auth_update"
  ON public.social_captures
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

-- ============================================================================
-- TABLE 2 -- social_engagements
-- ============================================================================

CREATE TABLE IF NOT EXISTS public.social_engagements (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  venue_id uuid NOT NULL REFERENCES public.venues(id) ON DELETE CASCADE,
  social_capture_id uuid NOT NULL REFERENCES public.social_captures(id) ON DELETE CASCADE,
  platform text NOT NULL,
  metric_type text NOT NULL,
  handle text NOT NULL,
  display_name text,
  engagement_at timestamptz,
  post_id text,
  match_status text NOT NULL DEFAULT 'pending' CHECK (match_status IN ('pending', 'matched', 'unmatched')),
  matched_person_id uuid REFERENCES public.people(id) ON DELETE SET NULL,
  match_method text,
  match_confidence integer,
  matched_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);

COMMENT ON TABLE public.social_engagements IS
  'owner:intel. One row per parsed handle from a social_captures row. '
  'The unit of attribution for Point-Zero -- a matched engagement whose '
  'engagement_at predates the linked wedding inquiry_date is a pre-zero '
  'forensic signal. Cascades on capture deletion (re-parsing means '
  'wiping the prior pass). Migration 324.';

COMMENT ON COLUMN public.social_engagements.venue_id IS
  'Scope key, denormalized from social_captures for fast scoped queries.';

COMMENT ON COLUMN public.social_engagements.social_capture_id IS
  'Parent capture. Cascades on delete so a re-capture cleanly wipes '
  'prior rows for that (capture event) scope.';

COMMENT ON COLUMN public.social_engagements.platform IS
  'Mirrors social_captures.platform; denormalized so we can index '
  '(venue_id, platform, handle) without a join.';

COMMENT ON COLUMN public.social_engagements.metric_type IS
  'Mirrors social_captures.metric_type. The same handle can show up '
  'across multiple metric types (new follower + story viewer) and '
  'each is its own row -- the matcher dedups at the person level.';

COMMENT ON COLUMN public.social_engagements.handle IS
  'Lowercased platform username, no leading @. The parser strips '
  'whitespace + @ + URL prefixes before insert. Postgres comparisons '
  'are case-sensitive; we normalize on write.';

COMMENT ON COLUMN public.social_engagements.display_name IS
  'When Instagram surfaces the full name alongside the handle ("rosie.hoyle  '
  'Rosie Hoyle"), the parser captures both. Used for the fuzzy-name '
  'matcher path.';

COMMENT ON COLUMN public.social_engagements.engagement_at IS
  'Best estimate of when the engagement happened. Follower lists do '
  'not include a timestamp, so V1 uses captured_at as a ceiling -- the '
  'follow happened at-or-before this moment. For post-engagement '
  'captures with a known post_id we can sometimes derive a tighter '
  'window from the post timestamp.';

COMMENT ON COLUMN public.social_engagements.post_id IS
  'For post-level metrics (post_engagement, story_views). NULL for '
  'profile-level metrics (new_followers, profile_visits).';

COMMENT ON COLUMN public.social_engagements.match_status IS
  'pending = matcher has not run yet; matched = resolved to a person; '
  'unmatched = matcher tried all methods and gave up. Filter on this '
  'when rerunning the matcher (only retry pending + unmatched).';

COMMENT ON COLUMN public.social_engagements.matched_person_id IS
  'people.id when match_status=matched. ON DELETE SET NULL so person '
  'cleanup does not destroy the engagement history.';

COMMENT ON COLUMN public.social_engagements.match_method IS
  'How the matcher resolved the row. Values: handle_exact (people. '
  'platform_handles->>platform = handle), name_fuzzy (trigram similarity '
  'on display_name vs first+last), email_inferred (handle equals or '
  'contains the email local part).';

COMMENT ON COLUMN public.social_engagements.match_confidence IS
  '0-100 score. handle_exact = 100, name_fuzzy = round(similarity * 100), '
  'email_inferred = 50.';

COMMENT ON COLUMN public.social_engagements.matched_at IS
  'When the matcher ran successfully. NULL while pending / unmatched.';

CREATE INDEX IF NOT EXISTS idx_social_engagements_venue_platform_metric
  ON public.social_engagements (venue_id, platform, metric_type, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_social_engagements_capture
  ON public.social_engagements (social_capture_id);

CREATE INDEX IF NOT EXISTS idx_social_engagements_handle
  ON public.social_engagements (venue_id, platform, handle);

CREATE INDEX IF NOT EXISTS idx_social_engagements_matched_person
  ON public.social_engagements (matched_person_id)
  WHERE matched_person_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_social_engagements_pending
  ON public.social_engagements (social_capture_id)
  WHERE match_status = 'pending';

COMMENT ON INDEX public.idx_social_engagements_pending IS
  'Partial index for the matcher worker: load pending rows for a capture.';

ALTER TABLE public.social_engagements ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "social_engagements_auth_select" ON public.social_engagements;
CREATE POLICY "social_engagements_auth_select"
  ON public.social_engagements
  FOR SELECT
  TO authenticated
  USING (
    venue_id IN (
      SELECT venue_id FROM public.user_profiles WHERE id = auth.uid()
    )
  );

DROP POLICY IF EXISTS "social_engagements_auth_insert" ON public.social_engagements;
CREATE POLICY "social_engagements_auth_insert"
  ON public.social_engagements
  FOR INSERT
  TO authenticated
  WITH CHECK (
    venue_id IN (
      SELECT venue_id FROM public.user_profiles WHERE id = auth.uid()
    )
  );

DROP POLICY IF EXISTS "social_engagements_auth_update" ON public.social_engagements;
CREATE POLICY "social_engagements_auth_update"
  ON public.social_engagements
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

-- ============================================================================
-- TABLE 3 -- platform_configs
-- ============================================================================

CREATE TABLE IF NOT EXISTS public.platform_configs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  venue_id uuid NOT NULL REFERENCES public.venues(id) ON DELETE CASCADE,
  platform text NOT NULL CHECK (platform IN ('instagram', 'tiktok', 'facebook', 'pinterest')),
  venue_handle text,
  followers_url text,
  recommended_frequency_days integer DEFAULT 7,
  is_active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (venue_id, platform)
);

COMMENT ON TABLE public.platform_configs IS
  'owner:intel. Per-venue per-platform settings. Stores the venue''s '
  'own handle on each platform (so the modal can link to '
  'instagram.com/<handle>/followers/) plus recommended capture cadence '
  'used to compute the sage/amber/rose recency dot. Migration 324.';

COMMENT ON COLUMN public.platform_configs.venue_handle IS
  'The venue''s username on this platform, no leading @. Used to '
  'build the link-out URL in the capture modal.';

COMMENT ON COLUMN public.platform_configs.followers_url IS
  'Override URL for the platform list (defaults to '
  'https://www.instagram.com/<venue_handle>/followers/ when NULL). '
  'Lets a venue point at a different URL if the platform changes its '
  'route shape.';

COMMENT ON COLUMN public.platform_configs.recommended_frequency_days IS
  'Cadence the platform-card recency dot uses to compute color: sage '
  'when last capture <= this many days, amber when 1-2x overdue, rose '
  'when never or very stale. Default 7 (weekly).';

COMMENT ON COLUMN public.platform_configs.is_active IS
  'Coordinator toggle. When false, the platform card renders the cards '
  'as inactive so the operator can hide platforms they do not use.';

CREATE INDEX IF NOT EXISTS idx_platform_configs_venue
  ON public.platform_configs (venue_id, platform);

ALTER TABLE public.platform_configs ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "platform_configs_auth_select" ON public.platform_configs;
CREATE POLICY "platform_configs_auth_select"
  ON public.platform_configs
  FOR SELECT
  TO authenticated
  USING (
    venue_id IN (
      SELECT venue_id FROM public.user_profiles WHERE id = auth.uid()
    )
  );

DROP POLICY IF EXISTS "platform_configs_auth_insert" ON public.platform_configs;
CREATE POLICY "platform_configs_auth_insert"
  ON public.platform_configs
  FOR INSERT
  TO authenticated
  WITH CHECK (
    venue_id IN (
      SELECT venue_id FROM public.user_profiles WHERE id = auth.uid()
    )
  );

DROP POLICY IF EXISTS "platform_configs_auth_update" ON public.platform_configs;
CREATE POLICY "platform_configs_auth_update"
  ON public.platform_configs
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

-- updated_at trigger for platform_configs.
CREATE OR REPLACE FUNCTION public.touch_platform_configs_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_platform_configs_touch ON public.platform_configs;
CREATE TRIGGER trg_platform_configs_touch
  BEFORE UPDATE ON public.platform_configs
  FOR EACH ROW
  EXECUTE FUNCTION public.touch_platform_configs_updated_at();

NOTIFY pgrst, 'reload schema';
