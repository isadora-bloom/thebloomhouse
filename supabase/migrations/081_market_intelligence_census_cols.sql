-- ---------------------------------------------------------------------------
-- 081_market_intelligence_census_cols.sql
-- ---------------------------------------------------------------------------
-- Phase 6 Task 54. census-ingest.ts now writes real Census ACS5 rollups at
-- state and national level. The rollup code computes two derived percentages
-- that migration 042 did not originally define:
--   * age_18_34_pct           — share of population aged 18-34 (key wedding
--                               demographic for venue demand modeling)
--   * bachelors_or_higher_pct — share with bachelors+ education (correlates
--                               with discretionary spend, wedding budget)
--
-- Without these columns the upsert logs the PostgREST error and skips the
-- write. Adding them allows the monthly census_refresh cron to persist its
-- full computed shape.
--
-- Both columns are nullable: a Census response with a zero denominator for
-- either pct produces NULL (not a fabricated 0). Non-US venues see the
-- 'US' national fallback row which also carries these values.
-- ---------------------------------------------------------------------------

ALTER TABLE public.market_intelligence
  ADD COLUMN IF NOT EXISTS age_18_34_pct decimal,
  ADD COLUMN IF NOT EXISTS bachelors_or_higher_pct decimal;

COMMENT ON COLUMN public.market_intelligence.age_18_34_pct IS
  'Phase 6 Task 54. Share of population aged 18-34 in this region. Computed from Census ACS5 B01001 variables. NULL when the denominator (total pop) is 0.';

COMMENT ON COLUMN public.market_intelligence.bachelors_or_higher_pct IS
  'Phase 6 Task 54. Share of population with bachelors degree or higher. Computed from Census ACS5 B15003 variables. NULL when the denominator is 0.';

NOTIFY pgrst, 'reload schema';
