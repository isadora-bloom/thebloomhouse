-- ============================================
-- 042: EXTERNAL INTELLIGENCE
-- Owner: intelligence (pre-loaded market data)
-- Depends on: 001_shared_tables.sql
-- ============================================
-- Market intelligence data keyed by region (state or metro area).
-- This is the "log in and immediately see value" layer — venues get
-- market context from public data before they generate any of their own.

-- Market intelligence data keyed by region (state or metro area)
CREATE TABLE IF NOT EXISTS market_intelligence (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  region_key text NOT NULL,          -- e.g., 'VA', 'VA-Charlottesville', 'US'
  region_type text NOT NULL CHECK (region_type IN ('national', 'state', 'metro', 'county')),
  region_name text NOT NULL,

  -- Demographics
  population integer,
  median_household_income integer,
  median_age float,
  marriages_per_year integer,
  marriage_rate_per_1000 float,

  -- Wedding market
  avg_wedding_cost integer,
  avg_guest_count integer,
  venue_count_estimate integer,
  avg_venue_price integer,

  -- Seasonal patterns (arrays indexed 0-11 for Jan-Dec)
  inquiry_seasonality float[],      -- relative inquiry volume by month (1.0 = average)
  booking_seasonality float[],      -- relative booking volume by month

  -- Economic
  consumer_confidence_index float,
  unemployment_rate float,

  -- Competitive
  nearby_venue_density text CHECK (nearby_venue_density IN ('low', 'medium', 'high', 'saturated')),
  price_position text CHECK (price_position IN ('budget', 'mid-range', 'premium', 'luxury')),

  -- Metadata
  data_year integer NOT NULL,
  source text,
  updated_at timestamptz DEFAULT now(),
  created_at timestamptz DEFAULT now(),

  UNIQUE(region_key, data_year)
);

COMMENT ON TABLE market_intelligence IS 'owner:intelligence — pre-loaded regional wedding market data';

CREATE INDEX idx_market_intel_region ON market_intelligence(region_key);
CREATE INDEX idx_market_intel_type ON market_intelligence(region_type);

-- Industry benchmarks keyed by venue tier
CREATE TABLE IF NOT EXISTS industry_benchmarks (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  benchmark_key text NOT NULL,       -- e.g., 'response_time', 'conversion_rate', 'booking_value'
  venue_tier text NOT NULL CHECK (venue_tier IN ('budget', 'mid-range', 'premium', 'luxury', 'all')),
  region_type text DEFAULT 'national',

  -- Values
  p25 float,           -- 25th percentile
  median float,        -- 50th percentile
  p75 float,           -- 75th percentile
  best_in_class float, -- 90th+ percentile

  unit text,           -- 'minutes', 'percent', 'dollars', 'days'
  label text NOT NULL, -- "Average First Response Time"
  description text,

  data_year integer NOT NULL,
  source text,
  created_at timestamptz DEFAULT now(),

  UNIQUE(benchmark_key, venue_tier, region_type, data_year)
);

COMMENT ON TABLE industry_benchmarks IS 'owner:intelligence — industry performance benchmarks by tier';

CREATE INDEX idx_benchmarks_key ON industry_benchmarks(benchmark_key);
CREATE INDEX idx_benchmarks_tier ON industry_benchmarks(venue_tier);

-- RLS
ALTER TABLE market_intelligence ENABLE ROW LEVEL SECURITY;
ALTER TABLE industry_benchmarks ENABLE ROW LEVEL SECURITY;
CREATE POLICY "anyone_select_market" ON market_intelligence FOR SELECT TO authenticated USING (true);
CREATE POLICY "anyone_select_benchmarks" ON industry_benchmarks FOR SELECT TO authenticated USING (true);
CREATE POLICY "anon_select_market" ON market_intelligence FOR SELECT TO anon USING (true);
CREATE POLICY "anon_select_benchmarks" ON industry_benchmarks FOR SELECT TO anon USING (true);
