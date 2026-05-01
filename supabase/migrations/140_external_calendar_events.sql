-- Migration 140: external_calendar_events (T2-C / Playbook 17.4)
--
-- Per Playbook Part 17.4 + ARCH-19.5: external calendar events
-- (federal holidays, school holiday weeks, university graduation /
-- move-in days, major sporting / convention events, election days)
-- materially shift wedding inquiry + tour booking patterns. A
-- "couples ghosting tours" anomaly during the same week as the
-- annual venue-region college graduation is a calendar effect, not
-- a funnel issue. Pre-T2-C the correlation engine had no calendar
-- channel; this migration adds the structured surface.
--
-- The table is venue-aware via geo_scope (e.g. 'us' / 'us_va' /
-- 'us_va_culpeper') so a venue's correlation engine reads the
-- region matrix that applies to its catchment area. Federal
-- holidays land at geo_scope='us'; state-level events scope to
-- 'us_<state>'; metro-level (university calendars, major
-- conventions) scope to 'us_<state>_<metro>'.
--
-- Idempotent: CREATE TABLE IF NOT EXISTS, RLS DROP/CREATE.

CREATE TABLE IF NOT EXISTS public.external_calendar_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),

  -- The event itself.
  title text NOT NULL CHECK (length(trim(title)) > 0),
  description text,

  -- Time bounds (date-resolution is fine — wedding-industry effects
  -- are at day granularity, not hour).
  start_date date NOT NULL,
  end_date date NOT NULL,

  -- Category for grouping in /intel surfaces. The set is the
  -- correlation engine's calibration target; the AI hypothesis
  -- prompt knows about each.
  category text NOT NULL CHECK (category IN (
    'federal_holiday',     -- Memorial Day, July 4, Thanksgiving, etc.
    'state_holiday',       -- regional holidays
    'school_holiday',      -- spring break, winter break, week-of grad
    'university_event',    -- graduation, move-in, homecoming
    'sporting_event',      -- Super Bowl week, World Series, etc.
    'convention',          -- major industry convention in metro
    'election',            -- federal / state / local election days
    'religious_observance',-- Easter, Passover, Ramadan, etc.
    'industry_event',      -- bridal expos, wedding-industry confs
    'other'
  )),

  -- Geographic scope. Hierarchical:
  --   'us'              = nationwide
  --   'us_<STATE>'      = state-level (us_va, us_ca, etc.)
  --   'us_<STATE>_<METRO>' = metro-level (us_va_culpeper, us_ny_nyc, etc.)
  geo_scope text NOT NULL CHECK (geo_scope ~ '^[a-z]+(?:_[a-z0-9]+){0,2}$'),

  -- Optional influence weight for the correlation engine. Negative
  -- = damping (couples don't book during this week), positive =
  -- lift (engagement season around Christmas / Valentine's). 0 =
  -- neutral / informational. Coordinator-tunable per venue via the
  -- /intel/calendar-effects UI (future).
  influence_weight integer DEFAULT 0 CHECK (
    influence_weight >= -100 AND influence_weight <= 100
  ),

  -- Provenance.
  source text NOT NULL DEFAULT 'manual' CHECK (
    source IN ('manual', 'federal_api', 'state_api', 'university_calendar', 'industry_feed')
  ),

  -- Soft delete (the historical record matters for retroactive
  -- correlation analysis even after the event passes).
  deleted_at timestamptz,

  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT external_calendar_events_window CHECK (end_date >= start_date)
);

CREATE INDEX IF NOT EXISTS idx_external_calendar_events_window
  ON public.external_calendar_events (geo_scope, start_date, end_date)
  WHERE deleted_at IS NULL;

CREATE INDEX IF NOT EXISTS idx_external_calendar_events_category
  ON public.external_calendar_events (category, start_date)
  WHERE deleted_at IS NULL;

COMMENT ON TABLE public.external_calendar_events IS
  'External calendar events that affect wedding-industry booking '
  'patterns. Read by correlation-engine as External Context channels. '
  'Hierarchical geo_scope so each venue reads federal / state / metro '
  'events that apply to its catchment area. Per Playbook 17.4 / T2-C.';

ALTER TABLE public.external_calendar_events ENABLE ROW LEVEL SECURITY;

-- Calendar events are global-ish (geo-scoped, not venue-scoped) — any
-- authenticated user can read. Coordinators contribute via the
-- /intel/calendar-effects admin UI (future); writes via service role
-- for the cron-driven public-data fetchers (federal holidays / etc.).
DROP POLICY IF EXISTS "external_calendar_events_select" ON public.external_calendar_events;
CREATE POLICY "external_calendar_events_select" ON public.external_calendar_events
  FOR SELECT TO authenticated USING (true);

DROP POLICY IF EXISTS "external_calendar_events_anon" ON public.external_calendar_events;
CREATE POLICY "external_calendar_events_anon" ON public.external_calendar_events
  FOR SELECT TO anon USING (deleted_at IS NULL);

DROP POLICY IF EXISTS "external_calendar_events_service" ON public.external_calendar_events;
CREATE POLICY "external_calendar_events_service" ON public.external_calendar_events
  FOR ALL TO service_role
  USING (true)
  WITH CHECK (true);

CREATE OR REPLACE FUNCTION public.external_calendar_events_touch_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at := now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_external_calendar_events_updated_at ON public.external_calendar_events;
CREATE TRIGGER trg_external_calendar_events_updated_at
  BEFORE UPDATE ON public.external_calendar_events
  FOR EACH ROW
  EXECUTE FUNCTION public.external_calendar_events_touch_updated_at();
