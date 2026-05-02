-- Migration 153: digest_preferences (T4-H / Playbook Part 20.3).
--
-- Per-coordinator digest configuration: cadence (daily/weekly/off),
-- which categories to include (lead_conversion / pricing /
-- source_attribution / agent_quality / etc.), which channels
-- (email / in-app), and opt-in toggles for self-knowledge sections
-- (per ANTI-19.9-5).
--
-- Pre-fix: every coordinator at a venue got the same digest at the
-- same cadence with no category filtering. Coordinators who only
-- handle inquiries got operational anomalies they couldn't act on;
-- coordinators on a 4-day work week got daily digests on weekends.
-- Idempotent.

CREATE TABLE IF NOT EXISTS public.digest_preferences (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES public.user_profiles(id) ON DELETE CASCADE,
  venue_id uuid NOT NULL REFERENCES public.venues(id) ON DELETE CASCADE,

  -- Top-level cadence. 'off' silences all digests for this user.
  cadence text NOT NULL DEFAULT 'weekly'
    CHECK (cadence IN ('off', 'daily', 'weekly', 'biweekly')),

  -- Send time of day (24h, venue-local timezone). Default 7am.
  send_time_local time NOT NULL DEFAULT '07:00:00',

  -- Day of week for weekly/biweekly digests. 0=Sun..6=Sat. Default Monday.
  send_dow integer NOT NULL DEFAULT 1 CHECK (send_dow >= 0 AND send_dow <= 6),

  -- Per-category include flags. Coordinator unchecks categories they
  -- don't act on. Defaults are conservative (include everything
  -- except self_knowledge which requires explicit opt-in).
  include_lead_conversion boolean NOT NULL DEFAULT true,
  include_pricing boolean NOT NULL DEFAULT true,
  include_source_attribution boolean NOT NULL DEFAULT true,
  include_anomalies boolean NOT NULL DEFAULT true,
  include_macro_correlations boolean NOT NULL DEFAULT true,
  include_self_knowledge boolean NOT NULL DEFAULT false,

  -- Channels.
  channel_email boolean NOT NULL DEFAULT true,
  channel_in_app boolean NOT NULL DEFAULT true,

  -- Audit timestamps.
  last_sent_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

-- One preference row per (user, venue). Org-admins managing multiple
-- venues get separate preferences per venue.
CREATE UNIQUE INDEX IF NOT EXISTS uq_digest_preferences_user_venue
  ON public.digest_preferences (user_id, venue_id);

CREATE INDEX IF NOT EXISTS idx_digest_preferences_cadence_dow
  ON public.digest_preferences (cadence, send_dow)
  WHERE cadence != 'off';

COMMENT ON TABLE public.digest_preferences IS
  'Per-coordinator digest configuration: cadence, categories, '
  'channels, opt-in toggles for sensitive sections. Per Playbook '
  'Part 20.3 / T4-H. Default lookup: send_digest cron pulls all '
  'rows where cadence != off and (today/dow) matches.';

ALTER TABLE public.digest_preferences ENABLE ROW LEVEL SECURITY;

-- Users see + edit their own preferences only.
DROP POLICY IF EXISTS "dp_select_own" ON public.digest_preferences;
CREATE POLICY "dp_select_own" ON public.digest_preferences
  FOR SELECT TO authenticated
  USING (user_id = auth.uid());

DROP POLICY IF EXISTS "dp_update_own" ON public.digest_preferences;
CREATE POLICY "dp_update_own" ON public.digest_preferences
  FOR UPDATE TO authenticated
  USING (user_id = auth.uid())
  WITH CHECK (user_id = auth.uid());

DROP POLICY IF EXISTS "dp_insert_own" ON public.digest_preferences;
CREATE POLICY "dp_insert_own" ON public.digest_preferences
  FOR INSERT TO authenticated
  WITH CHECK (user_id = auth.uid());

DROP POLICY IF EXISTS "dp_service" ON public.digest_preferences;
CREATE POLICY "dp_service" ON public.digest_preferences
  FOR ALL TO service_role
  USING (true) WITH CHECK (true);

CREATE OR REPLACE FUNCTION public.digest_preferences_touch()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at := now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_digest_preferences_touch
  ON public.digest_preferences;
CREATE TRIGGER trg_digest_preferences_touch
  BEFORE UPDATE ON public.digest_preferences
  FOR EACH ROW
  EXECUTE FUNCTION public.digest_preferences_touch();
