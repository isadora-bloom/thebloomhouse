-- ---------------------------------------------------------------------------
-- 325_social_metrics_config.sql
-- ---------------------------------------------------------------------------
-- Checkpoint 1 of the social-integration redesign.
--
-- Today (mig 324) the social_captures table accepts any (platform, metric_type)
-- combo but the UI / modal / parser dispatch is hardcoded as "Instagram New
-- Followers via text-paste". The richer reality:
--
--   - Some metrics are API-driven (IG post insights, FB page likes count,
--     Pinterest pin saves count, TikTok video stats).
--   - Some metrics are best captured via screenshot (IG followers via
--     notifications panel, IG mixed notifications "All" tab, story views,
--     TikTok / FB / Pinterest follower lists).
--   - Some metrics are best captured via copy-paste (IG post-likes via
--     drag-select on the open post, where the rendered likers list is
--     plain text).
--   - Some metrics carry post-date context that's NOT in the captured rows
--     (when you paste IG post likes, you need the operator to tell the
--     system when the post was published so engagement_at stamps to the
--     post date rather than capture-time).
--
-- This migration adds:
--   1. social_metrics_config reference table — one row per (platform,
--      metric_type) describing how it's captured and what extra inputs
--      the modal must collect.
--   2. social_captures.target_metadata jsonb — carries per-capture
--      context like the target post's publish_at, post URL, board name.
--      Per-metric required keys are declared in social_metrics_config.
--
-- Idempotent, statement-level, no BEGIN/COMMIT (Wave 23 doctrine).
-- ---------------------------------------------------------------------------

-- ============================================================================
-- 1. social_metrics_config — per-(platform, metric_type) capture method
-- ============================================================================

CREATE TABLE IF NOT EXISTS public.social_metrics_config (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  platform text NOT NULL CHECK (platform IN ('instagram', 'tiktok', 'facebook', 'pinterest')),
  metric_type text NOT NULL,
  label text NOT NULL,
  description text,
  capture_method text NOT NULL CHECK (capture_method IN ('api', 'paste', 'screenshot', 'manual')),
  -- Primary identifier in the captured data. IG / Pinterest expose
  -- @handles in their followers / engagement panels; TikTok and Facebook
  -- show display names instead, with the actual @handle not visible. The
  -- matcher reads this to dispatch — 'handle' fast-paths through
  -- platform_handles->>'<platform>', 'display_name' goes straight to
  -- the name-fuzzy + email-inferred matchers and skips the exact-handle
  -- lookup that would always miss.
  primary_identifier text NOT NULL DEFAULT 'handle'
    CHECK (primary_identifier IN ('handle', 'display_name')),
  -- jsonb array of extra-input descriptors the modal renders before
  -- submit. Each entry: { "key": "target_published_at", "type": "date",
  -- "label": "Post date", "required": true }
  required_inputs jsonb NOT NULL DEFAULT '[]'::jsonb,
  -- Default recommended frequency. Operator can override per-venue via
  -- platform_configs (mig 324). Drives the sage/gold/rose status dot.
  recommended_frequency_days integer NOT NULL DEFAULT 7,
  -- Render flag. When false, the metric row appears in the platform card
  -- as "Coming soon" disabled. Lets us ship the platform UI before the
  -- backend parser for a given metric exists.
  is_functional boolean NOT NULL DEFAULT false,
  -- Display order within a platform card. Lower = higher.
  sort_order integer NOT NULL DEFAULT 100,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (platform, metric_type)
);

COMMENT ON TABLE public.social_metrics_config IS
  'Reference table — one row per (platform, metric_type). Declares how '
  'the metric is captured (api / paste / screenshot / manual), what extra '
  'inputs the modal must collect (jsonb), and whether the metric is '
  'currently functional. The Social Integration page reads this to render '
  'metric rows + dispatch the right capture flow per click. Mig 325.';

COMMENT ON COLUMN public.social_metrics_config.capture_method IS
  '"api" → auto-sync via the platform API. Modal shows a Connect-account '
  'CTA when not connected. "paste" → modal renders a textarea (e.g. IG '
  'post-likes from drag-select). "screenshot" → modal renders image input '
  'plus the Capture-tab button (e.g. IG followers from the notifications '
  'panel). "manual" → free-text capture with no parser claims.';

COMMENT ON COLUMN public.social_metrics_config.required_inputs IS
  'jsonb array of extra-input descriptors the modal must collect before '
  'submit. Each entry: { key: string, type: "date"|"url"|"text", label: '
  'string, required: boolean, placeholder?: string }. Lands on '
  'social_captures.target_metadata under the same key. Example: post-likes '
  'needs target_published_at (date) so engagement_at stamps to the post '
  'date, not capture-time.';

COMMENT ON COLUMN public.social_metrics_config.is_functional IS
  'When false, the platform card renders the row disabled with a Coming '
  'soon pill. Set true as each metric''s backend parser lands.';

CREATE INDEX IF NOT EXISTS idx_social_metrics_config_platform
  ON public.social_metrics_config (platform, sort_order);

-- updated_at touch trigger
CREATE OR REPLACE FUNCTION public.touch_social_metrics_config_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_social_metrics_config_touch ON public.social_metrics_config;
CREATE TRIGGER trg_social_metrics_config_touch
  BEFORE UPDATE ON public.social_metrics_config
  FOR EACH ROW
  EXECUTE FUNCTION public.touch_social_metrics_config_updated_at();

-- RLS: anyone authenticated can read (reference data, not venue-scoped).
ALTER TABLE public.social_metrics_config ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "smc_auth_select" ON public.social_metrics_config;
CREATE POLICY "smc_auth_select" ON public.social_metrics_config
  FOR SELECT TO authenticated USING (true);

-- ============================================================================
-- 2. social_captures.target_metadata jsonb
-- ============================================================================

ALTER TABLE public.social_captures
  ADD COLUMN IF NOT EXISTS target_metadata jsonb NOT NULL DEFAULT '{}'::jsonb;

COMMENT ON COLUMN public.social_captures.target_metadata IS
  'Per-capture context the matcher / date-back-derivation reads. Keys '
  'declared in social_metrics_config.required_inputs for each metric. '
  'Examples: { target_published_at: "2026-03-10", target_url: '
  '"https://instagram.com/p/...", target_pin_name: "..." }. For metrics '
  'where engagement_at floor is the target''s publish date (post likes, '
  'pin saves), the matcher uses target_published_at when present. '
  'Mig 325.';

-- ============================================================================
-- 3. Seed the metric matrix
-- ============================================================================
-- One INSERT per row, ON CONFLICT DO NOTHING so re-running is safe + so an
-- operator who tuned a row's is_functional won't get reset.

-- ---- Instagram (handle-based identifiers) ----
INSERT INTO public.social_metrics_config (platform, metric_type, label, description, capture_method, primary_identifier, required_inputs, recommended_frequency_days, is_functional, sort_order)
VALUES
  ('instagram', 'new_followers',
    'New Followers',
    'Who recently followed the venue. Screenshot the Instagram notifications panel, Follows tab.',
    'screenshot', 'handle',
    '[]'::jsonb,
    7, true, 10),
  ('instagram', 'mixed_notifications',
    'Likes / Comments / Mentions',
    'The All tab of Instagram notifications. Mixed feed of likes / comments / mentions / story views with per-row timestamps.',
    'screenshot', 'handle',
    '[]'::jsonb,
    7, false, 20),
  ('instagram', 'post_likes',
    'Post Likes',
    'Who liked a specific post. Open the post, tap likes, drag-select the list, paste below. Tell us the post date so likers attribute correctly.',
    'paste', 'handle',
    '[{"key":"target_published_at","type":"date","label":"Post date","required":true},{"key":"target_url","type":"url","label":"Post URL","required":false}]'::jsonb,
    14, false, 30),
  ('instagram', 'story_views',
    'Story Views',
    'Who viewed a story. Open the story, swipe up, screenshot the viewers list.',
    'screenshot', 'handle',
    '[{"key":"target_published_at","type":"date","label":"Story date","required":true}]'::jsonb,
    1, false, 40),
  ('instagram', 'dms',
    'Direct Messages',
    'Inbox screenshot or paste. The vision parser extracts handle + message preview + timestamp.',
    'screenshot', 'handle',
    '[]'::jsonb,
    3, false, 50),
  ('instagram', 'post_engagement',
    'Post Engagement (aggregate)',
    'Impressions, reach, saves, profile visits per post. Auto-synced via Meta Graph API once the venue Instagram Business account is connected.',
    'api', 'handle',
    '[]'::jsonb,
    1, false, 60)
ON CONFLICT (platform, metric_type) DO NOTHING;

-- ---- TikTok (display-name based — @handles are not visible in the
--      notifications follower list, only chosen display names) ----
INSERT INTO public.social_metrics_config (platform, metric_type, label, description, capture_method, primary_identifier, required_inputs, recommended_frequency_days, is_functional, sort_order)
VALUES
  ('tiktok', 'new_followers',
    'New Followers',
    'Drag-select the followers list in the TikTok notifications panel and paste below. Each row carries a display name plus a relative date ("2d ago", "4-29").',
    'paste', 'display_name',
    '[]'::jsonb,
    7, false, 10),
  ('tiktok', 'video_engagement_paste',
    'Video Likers',
    'Who liked a specific video. Open the video, tap the like count, drag-select the list, paste below.',
    'paste', 'display_name',
    '[{"key":"target_published_at","type":"date","label":"Video date","required":true},{"key":"target_url","type":"url","label":"Video URL","required":false}]'::jsonb,
    14, false, 20),
  ('tiktok', 'video_stats',
    'Video Stats (aggregate)',
    'Views, likes, comments, shares per video. Auto-synced via TikTok Display API once connected.',
    'api', 'handle',
    '[]'::jsonb,
    1, false, 30)
ON CONFLICT (platform, metric_type) DO NOTHING;

-- ---- Facebook (display-name based for actor metrics) ----
INSERT INTO public.social_metrics_config (platform, metric_type, label, description, capture_method, primary_identifier, required_inputs, recommended_frequency_days, is_functional, sort_order)
VALUES
  ('facebook', 'page_likes',
    'Page Likes (aggregate)',
    'New page likes count. Auto-synced via Meta Graph API.',
    'api', 'handle',
    '[]'::jsonb,
    1, false, 10),
  ('facebook', 'post_likers',
    'Post Likers',
    'Who liked a specific page post. Page admin view → reactions list → screenshot or paste.',
    'screenshot', 'display_name',
    '[{"key":"target_published_at","type":"date","label":"Post date","required":true},{"key":"target_url","type":"url","label":"Post URL","required":false}]'::jsonb,
    14, false, 20),
  ('facebook', 'post_engagement',
    'Post Engagement (aggregate)',
    'Reach, impressions, reactions per post. Auto-synced via Meta Graph API.',
    'api', 'handle',
    '[]'::jsonb,
    1, false, 30)
ON CONFLICT (platform, metric_type) DO NOTHING;

-- ---- Pinterest (handle-based, no @ prefix in display) ----
INSERT INTO public.social_metrics_config (platform, metric_type, label, description, capture_method, primary_identifier, required_inputs, recommended_frequency_days, is_functional, sort_order)
VALUES
  ('pinterest', 'pin_saves_aggregate',
    'Pin Saves (aggregate)',
    'Save counts per pin. Auto-synced via Pinterest API.',
    'api', 'handle',
    '[]'::jsonb,
    1, false, 10),
  ('pinterest', 'pin_savers',
    'Pin Savers',
    'Who saved a specific pin. Open the pin → see saves list → screenshot.',
    'screenshot', 'handle',
    '[{"key":"target_published_at","type":"date","label":"Pin published date","required":true},{"key":"target_pin_name","type":"text","label":"Pin name","required":false}]'::jsonb,
    14, false, 20),
  ('pinterest', 'board_follows',
    'Board Followers',
    'Who follows a specific board. Open the board → followers list → screenshot.',
    'screenshot', 'handle',
    '[{"key":"target_board_name","type":"text","label":"Board name","required":true}]'::jsonb,
    14, false, 30)
ON CONFLICT (platform, metric_type) DO NOTHING;

NOTIFY pgrst, 'reload schema';
