-- Migration 138: fred_indicators (T2-C / Playbook 17.4-A)
--
-- Per Playbook 17.4-A and ARCH-19.5: macroeconomic indicators
-- (CPI, 30-year fixed mortgage rate, S&P 500, regional employment)
-- are causally connected to wedding venue booking patterns:
--   - High CPI + rising rates  → couples postpone, downgrade, or
--                                 negotiate harder
--   - S&P drawdowns           → discretionary spending tightens 1-2
--                                 quarters later
--   - Local unemployment      → directly correlates with downsize /
--                                 lost-deal rate
--
-- Pre-T2-C the correlation engine had no FRED data at all — these
-- channels were doctrine-only. This migration adds the table; the
-- writer is src/lib/services/fred-indicators.ts (cron-driven daily
-- refresh from FRED API). correlation-engine.ts reads as channel
-- series alongside weather + tangential_signals + marketing_metric.
--
-- Idempotent: CREATE TABLE IF NOT EXISTS, RLS DROP/CREATE.

CREATE TABLE IF NOT EXISTS public.fred_indicators (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),

  -- FRED series id (e.g. 'CPIAUCSL', 'MORTGAGE30US', 'SP500',
  -- 'UNRATE'). Documented at https://fred.stlouisfed.org/series/<id>.
  series_id text NOT NULL,

  -- Optional regional scope. NULL = national. For region-specific
  -- series (regional employment by state / metro) the writer fetches
  -- per-region series and stamps the region key here.
  region text,

  -- The actual data point.
  observation_date date NOT NULL,
  value numeric,

  -- Metadata + source attribution.
  units text,            -- e.g. '%', 'Index 1982-1984=100', 'Number'
  frequency text,        -- 'daily' / 'weekly' / 'monthly' / 'quarterly'

  fetched_at timestamptz NOT NULL DEFAULT now(),
  created_at timestamptz NOT NULL DEFAULT now()
);

-- One row per (series, region, date). FRED revises historical values
-- occasionally; the writer upserts so the latest revision wins.
CREATE UNIQUE INDEX IF NOT EXISTS uq_fred_indicators_series_region_date
  ON public.fred_indicators (series_id, COALESCE(region, ''), observation_date);

-- Lookup pattern: "give me the last 12mo of CPI for the correlation engine".
CREATE INDEX IF NOT EXISTS idx_fred_indicators_series_date
  ON public.fred_indicators (series_id, observation_date DESC);

COMMENT ON TABLE public.fred_indicators IS
  'Federal Reserve Economic Data series (CPI, mortgage rate, S&P 500, '
  'regional employment, etc.). Read by correlation-engine as External '
  'Context channels alongside weather + search_trends + calendar_events. '
  'Per Playbook 17.4-A / T2-C.';

ALTER TABLE public.fred_indicators ENABLE ROW LEVEL SECURITY;

-- FRED data is non-sensitive public macroeconomic info — readable by
-- any authenticated user. Service writes on cron-refresh.
DROP POLICY IF EXISTS "fred_indicators_select" ON public.fred_indicators;
CREATE POLICY "fred_indicators_select" ON public.fred_indicators
  FOR SELECT TO authenticated USING (true);

DROP POLICY IF EXISTS "fred_indicators_anon" ON public.fred_indicators;
CREATE POLICY "fred_indicators_anon" ON public.fred_indicators
  FOR SELECT TO anon USING (true);

DROP POLICY IF EXISTS "fred_indicators_service" ON public.fred_indicators;
CREATE POLICY "fred_indicators_service" ON public.fred_indicators
  FOR ALL TO service_role
  USING (true)
  WITH CHECK (true);
