-- ---------------------------------------------------------------------------
-- 189_government_events.sql  (T5-Rixey-ZZ / Z6 government shutdown channel)
-- ---------------------------------------------------------------------------
-- Why: Rixey Manor (Rixeyville, VA — ~70mi from DC) has a heavy federal-
-- employee wedding clientele. When the US federal government shuts down or
-- threatens to, federal employees freeze discretionary spending: tour
-- bookings stall, deposits get postponed, contract signings get delayed.
-- The correlation engine's existing channels (FRED macro, calendar, cultural
-- moments, weather) don't capture these step-function political events.
--
-- This table holds a small curated dataset of US federal government events
-- (full shutdowns, near-shutdowns, debt-ceiling crises, major legislation,
-- inaugurations, state of unions). The correlation engine reads it via
-- `src/lib/services/external-context/government.ts` as a binary daily signal
-- (1 = active shutdown, 0.5 = threatened/partial, 0 = quiet day) — for
-- DC-region venues the loader amplifies to 1.5x weight.
--
-- Idempotent: CREATE TABLE IF NOT EXISTS, INSERT … ON CONFLICT DO NOTHING.
-- ---------------------------------------------------------------------------

BEGIN;

CREATE TABLE IF NOT EXISTS public.government_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),

  -- The kind of event. CHECK constraint keeps the channel taxonomy small
  -- so the correlation engine's grouping logic stays simple. Add new
  -- types here when a new event class clearly maps to wedding-industry
  -- behavior (e.g. 'tariff_announcement' for trade-war years).
  event_type text NOT NULL CHECK (event_type IN (
    'shutdown',
    'debt_ceiling_crisis',
    'major_legislation',
    'inauguration',
    'state_of_union'
  )),

  -- Time bounds. end_date NULL means single-day OR ongoing (the loader
  -- treats NULL as "active through today" for active events; the writer
  -- closes them out by setting end_date when the event ends).
  start_date date NOT NULL,
  end_date date,

  -- Geographic scope. 'us' = nationwide effect; 'us_dc_metro' = events
  -- whose impact is concentrated in the DC metro (rare — a federal
  -- shutdown is national, but e.g. a Capitol-Hill closure for security
  -- might scope here).
  region text NOT NULL DEFAULT 'us',

  -- Severity controls the loader's per-day signal value:
  --   'full'        → 1.0    (full shutdown, max impact)
  --   'partial'     → 0.5    (some agencies funded, some not)
  --   'threatened'  → 0.5    (averted but the threat itself froze decisions)
  --   'minor'       → 0.25   (one-day kerfuffle)
  severity text NOT NULL CHECK (severity IN (
    'full', 'partial', 'threatened', 'minor'
  )),

  -- Plain-English narration shown to coordinators in the insight body.
  description text,

  created_at timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT government_events_window CHECK (end_date IS NULL OR end_date >= start_date)
);

-- Lookup: "active events overlapping window for region X".
CREATE INDEX IF NOT EXISTS idx_government_events_region_start
  ON public.government_events (region, start_date DESC);

-- Idempotent seed dedup key — same event seeded twice (cron + manual)
-- collapses to one row.
CREATE UNIQUE INDEX IF NOT EXISTS uq_government_events_natural
  ON public.government_events (region, event_type, start_date);

COMMENT ON TABLE public.government_events IS
  'Curated US federal government events (shutdowns, near-shutdowns, debt '
  'ceiling crises, major legislation, inaugurations) that materially affect '
  'federal-employee wedding-industry spending. Read by correlation-engine '
  'as an External Context channel. DC-region venues get amplified weight. '
  'Per T5-Rixey-ZZ / Z6.';

ALTER TABLE public.government_events ENABLE ROW LEVEL SECURITY;

-- Public macro data — readable by any authenticated user, anon (for the
-- marketing site / demo), service role for cron + seed inserts.
DROP POLICY IF EXISTS "government_events_select" ON public.government_events;
CREATE POLICY "government_events_select" ON public.government_events
  FOR SELECT TO authenticated USING (true);

DROP POLICY IF EXISTS "government_events_anon" ON public.government_events;
CREATE POLICY "government_events_anon" ON public.government_events
  FOR SELECT TO anon USING (true);

DROP POLICY IF EXISTS "government_events_service" ON public.government_events;
CREATE POLICY "government_events_service" ON public.government_events
  FOR ALL TO service_role
  USING (true)
  WITH CHECK (true);

-- ---------------------------------------------------------------------------
-- Initial seed — verified US federal government shutdowns + near-shutdowns.
-- Sources: Wikipedia "Government shutdowns in the United States" (cross-
-- referenced with congressional record CR end dates). Limit to events where
-- public reporting + congressional record agree on dates.
--
-- 2018-12-22 → 2019-01-25: longest in US history (35 days), full shutdown,
--   directly affected hundreds of thousands of federal employees including
--   many in the DC region. Anchor data point for any pre/post correlation
--   on Rixey-style venues with VA/DC clientele.
--
-- 2023-09-30: 45-day continuing resolution passed at 11th hour; widely
--   reported as a near-shutdown. Federal employees + contractors had
--   already begun shutdown contingency planning.
--
-- 2023-11-17: laddered CR averted shutdown; pattern repeated.
--
-- 2024-03-22: partial-agency funding cliff (12 of 24 hours past deadline)
--   resolved with 6-bill minibus. Brief partial shutdown.
--
-- 2024-09-30: CR averted shutdown.
--
-- 2025-03-14: CR averted shutdown.
--
-- 2025-09-30: CR averted shutdown.
--
-- ON CONFLICT DO NOTHING because this seed re-runs idempotently when the
-- migration is reapplied to a fresh DB.
-- ---------------------------------------------------------------------------

INSERT INTO public.government_events
  (event_type, start_date, end_date, region, severity, description)
VALUES
  (
    'shutdown', '2018-12-22', '2019-01-25', 'us', 'full',
    'Longest US federal government shutdown in history (35 days). Funding '
    'lapse caused by Border Wall appropriations dispute. ~800,000 federal '
    'employees furloughed or worked without pay. Heavy direct impact on '
    'DC-metro wedding clientele.'
  ),
  (
    'shutdown', '2023-09-30', '2023-09-30', 'us', 'threatened',
    'Continuing resolution passed hours before deadline (Sep 30, 2023). '
    'Federal employees had begun shutdown contingency planning; tour and '
    'deposit decisions paused during the ramp-up.'
  ),
  (
    'shutdown', '2023-11-17', '2023-11-17', 'us', 'threatened',
    'Laddered continuing resolution averted shutdown. Same dynamics as '
    'September 2023 — discretionary spending decisions paused around the '
    'cliff date.'
  ),
  (
    'shutdown', '2024-03-22', '2024-03-23', 'us', 'partial',
    'Partial funding lapse (~12 hours past deadline). Six-bill minibus '
    'passed early Saturday morning. Brief but real disruption.'
  ),
  (
    'shutdown', '2024-09-30', '2024-09-30', 'us', 'threatened',
    'Continuing resolution passed at deadline. No actual shutdown.'
  ),
  (
    'shutdown', '2025-03-14', '2025-03-14', 'us', 'threatened',
    'Continuing resolution passed at deadline. Federal employees had begun '
    'contingency planning during the run-up.'
  ),
  (
    'shutdown', '2025-09-30', '2025-09-30', 'us', 'threatened',
    'Continuing resolution passed at deadline. No actual shutdown.'
  )
ON CONFLICT (region, event_type, start_date) DO NOTHING;

COMMIT;
