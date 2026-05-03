-- ---------------------------------------------------------------------------
-- 183_website_traffic_history.sql  (T5-Rixey-OO platform finding)
-- ---------------------------------------------------------------------------
-- Creates `public.website_traffic_history` for GA4 (and future analytics-
-- provider) channel-level rollups.
--
-- Why this exists
-- ---------------
-- Stream MM Rixey load parked GA4 channel rollups in tangential_signals
-- with signal_type='analytics_entry'. That was wrong on two axes:
--   1. tangential_signals is per-LEAD signal storage (one row per
--      identifiable person-touch, e.g. instagram_engagement, review,
--      website_visit). GA4 channel rollups are venue-level aggregates
--      with NO lead identity — they don't fit the schema's purpose.
--   2. Identity-cluster operations (Stream KK candidate-resolver,
--      identity-enqueue, candidate-clusterer) iterate tangential_signals
--      by extracted_identity / matched_person_id. GA4 rollups have
--      neither, so they were dead weight in those flows AND cluttered
--      the per-lead funnel views.
--
-- Schema
-- ------
--   id              uuid PK
--   venue_id        uuid FK → venues(id) ON DELETE CASCADE
--   period_start    date  (inclusive)
--   period_end      date  (inclusive)
--   channel_group   text  (GA4 default channel group: "Direct",
--                          "Organic Search", "Paid Search", etc.)
--   sessions        integer
--   engaged_sessions integer
--   key_events      integer  (GA4 conversions)
--   engagement_rate numeric  (0..1)
--   session_key_event_rate numeric  (0..1)
--   source          text DEFAULT 'ga4'  (future: 'plausible', 'ga3', etc.)
--   created_at      timestamptz
--
-- Idempotency
-- -----------
-- UNIQUE INDEX on (venue_id, period_start, period_end, channel_group,
-- source) so the GA4 loader can use ON CONFLICT to upsert without
-- needing the delete-then-insert pattern.
--
-- RLS
-- ---
-- Same shape as other coordinator-data tables (mirrors migration 178
-- packages): venue_id IN user's venues OR venue.org_id IN user's orgs.
--
-- Idempotent: CREATE TABLE / INDEX / POLICY all use IF NOT EXISTS or
-- DROP-then-CREATE.
-- ---------------------------------------------------------------------------

BEGIN;

CREATE TABLE IF NOT EXISTS public.website_traffic_history (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  venue_id uuid NOT NULL REFERENCES public.venues(id) ON DELETE CASCADE,
  period_start date NOT NULL,
  period_end date NOT NULL,
  channel_group text NOT NULL,
  sessions integer NOT NULL DEFAULT 0,
  engaged_sessions integer NOT NULL DEFAULT 0,
  key_events integer NOT NULL DEFAULT 0,
  engagement_rate numeric(6, 4) NULL,
  session_key_event_rate numeric(6, 4) NULL,
  source text NOT NULL DEFAULT 'ga4',
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK (period_end >= period_start),
  CHECK (sessions >= 0),
  CHECK (engaged_sessions >= 0),
  CHECK (key_events >= 0)
);

COMMENT ON TABLE public.website_traffic_history IS
  'owner:intelligence. Venue-level analytics rollups (GA4 default '
  'channel group + future Plausible / Fathom / etc.). Distinct from '
  'tangential_signals which is per-LEAD identifiable touches. Read by '
  'intel-brain.ts gatherVenueData so Sage can answer "what % of my '
  'traffic is paid search?" + by the Source Quality scorecard. '
  'Written by scripts/rixey-load/04-ga4-traffic.mjs (manual loader) '
  'and the future GA4 sync cron.';

COMMENT ON COLUMN public.website_traffic_history.channel_group IS
  'GA4 default channel group label as shipped in the export: "Direct", '
  '"Organic Search", "Paid Search", "Organic Social", "Email", '
  '"Referral", "Unassigned", etc. Free text — different sources may '
  'use different vocabularies.';

COMMENT ON COLUMN public.website_traffic_history.source IS
  'Analytics provider. Defaults to ga4. Future values: plausible, '
  'fathom, ga3 (legacy), umami.';

-- Upsert key — one row per (venue, period, channel, source).
CREATE UNIQUE INDEX IF NOT EXISTS uq_website_traffic_history_period_channel
  ON public.website_traffic_history (venue_id, period_start, period_end, channel_group, source);

CREATE INDEX IF NOT EXISTS idx_website_traffic_history_venue_period
  ON public.website_traffic_history (venue_id, period_start DESC);

-- RLS — same shape as other venue-scoped intel tables (mirrors
-- packages from migration 178).
ALTER TABLE public.website_traffic_history ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "website_traffic_history_select" ON public.website_traffic_history;
CREATE POLICY "website_traffic_history_select" ON public.website_traffic_history
  FOR SELECT TO authenticated
  USING (
    venue_id IN (
      SELECT venue_id FROM public.user_profiles WHERE id = auth.uid()
    )
    OR
    venue_id IN (
      SELECT v.id FROM public.venues v
      WHERE v.org_id IN (
        SELECT org_id FROM public.user_profiles WHERE id = auth.uid()
      )
    )
  );

DROP POLICY IF EXISTS "website_traffic_history_insert" ON public.website_traffic_history;
CREATE POLICY "website_traffic_history_insert" ON public.website_traffic_history
  FOR INSERT TO authenticated
  WITH CHECK (
    venue_id IN (
      SELECT venue_id FROM public.user_profiles WHERE id = auth.uid()
    )
    OR
    venue_id IN (
      SELECT v.id FROM public.venues v
      WHERE v.org_id IN (
        SELECT org_id FROM public.user_profiles WHERE id = auth.uid()
      )
    )
  );

DROP POLICY IF EXISTS "website_traffic_history_update" ON public.website_traffic_history;
CREATE POLICY "website_traffic_history_update" ON public.website_traffic_history
  FOR UPDATE TO authenticated
  USING (
    venue_id IN (
      SELECT venue_id FROM public.user_profiles WHERE id = auth.uid()
    )
    OR
    venue_id IN (
      SELECT v.id FROM public.venues v
      WHERE v.org_id IN (
        SELECT org_id FROM public.user_profiles WHERE id = auth.uid()
      )
    )
  );

DROP POLICY IF EXISTS "website_traffic_history_delete" ON public.website_traffic_history;
CREATE POLICY "website_traffic_history_delete" ON public.website_traffic_history
  FOR DELETE TO authenticated
  USING (
    venue_id IN (
      SELECT venue_id FROM public.user_profiles WHERE id = auth.uid()
    )
    OR
    venue_id IN (
      SELECT v.id FROM public.venues v
      WHERE v.org_id IN (
        SELECT org_id FROM public.user_profiles WHERE id = auth.uid()
      )
    )
  );

-- ---------------------------------------------------------------------------
-- Backfill: migrate existing GA4 rows from tangential_signals.
-- Idempotent — INSERT ON CONFLICT DO NOTHING, then DELETE the source
-- rows guarded by signal_type + source_platform so a re-run can't
-- clobber unrelated tangential_signals.
-- ---------------------------------------------------------------------------

INSERT INTO public.website_traffic_history (
  venue_id, period_start, period_end, channel_group,
  sessions, engaged_sessions, key_events,
  engagement_rate, session_key_event_rate, source, created_at
)
SELECT
  venue_id,
  COALESCE((extracted_identity->>'period_start')::date, signal_date::date),
  COALESCE((extracted_identity->>'period_end')::date, signal_date::date),
  COALESCE(extracted_identity->>'channel_group', 'Unassigned'),
  COALESCE((extracted_identity->>'sessions')::integer, 0),
  COALESCE((extracted_identity->>'engaged_sessions')::integer, 0),
  COALESCE((extracted_identity->>'key_events')::integer, 0),
  NULLIF(extracted_identity->>'engagement_rate', '')::numeric,
  NULLIF(extracted_identity->>'session_key_event_rate', '')::numeric,
  COALESCE(source_platform, 'ga4'),
  COALESCE(created_at, now())
FROM public.tangential_signals
WHERE signal_type = 'analytics_entry'
  AND source_platform = 'ga4'
ON CONFLICT (venue_id, period_start, period_end, channel_group, source) DO NOTHING;

-- Now delete the source rows. Guarded by both signal_type AND
-- source_platform so a stray analytics_entry row from a future
-- non-GA4 provider can't get clobbered.
DELETE FROM public.tangential_signals
WHERE signal_type = 'analytics_entry'
  AND source_platform = 'ga4';

COMMIT;

NOTIFY pgrst, 'reload schema';
