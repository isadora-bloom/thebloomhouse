-- ============================================
-- SEED: MARKET INTELLIGENCE + INDUSTRY BENCHMARKS
-- ============================================
-- Pre-loaded external data that gives venues immediate value.
-- Sources: The Knot Real Weddings Study 2025, US Census Bureau,
-- Bureau of Labor Statistics, WeddingPro industry reports.
-- Run AFTER migration 042_external_intelligence.sql.
-- ============================================

-- ============================================
-- 1. MARKET INTELLIGENCE — NATIONAL
-- ============================================
INSERT INTO market_intelligence (
  region_key, region_type, region_name,
  population, median_household_income, median_age,
  marriages_per_year, marriage_rate_per_1000,
  avg_wedding_cost, avg_guest_count, venue_count_estimate, avg_venue_price,
  inquiry_seasonality, booking_seasonality,
  consumer_confidence_index, unemployment_rate,
  nearby_venue_density, price_position,
  data_year, source
) VALUES (
  'US', 'national', 'United States',
  331000000, 75149, 38.8,
  2065000, 6.2,
  35000, 131, 75000, 12500,
  ARRAY[0.75, 0.85, 1.05, 1.15, 1.20, 1.10, 0.95, 0.90, 1.05, 1.10, 0.95, 0.85],
  ARRAY[0.60, 0.70, 0.90, 1.10, 1.25, 1.40, 1.15, 1.00, 1.20, 1.30, 0.80, 0.60],
  102.0, 4.1,
  null, null,
  2025, 'The Knot Real Weddings Study 2025 + US Census Bureau + BLS'
) ON CONFLICT (region_key, data_year) DO NOTHING;

-- ============================================
-- 2. MARKET INTELLIGENCE — VIRGINIA STATE
-- ============================================
INSERT INTO market_intelligence (
  region_key, region_type, region_name,
  population, median_household_income, median_age,
  marriages_per_year, marriage_rate_per_1000,
  avg_wedding_cost, avg_guest_count, venue_count_estimate, avg_venue_price,
  inquiry_seasonality, booking_seasonality,
  consumer_confidence_index, unemployment_rate,
  nearby_venue_density, price_position,
  data_year, source
) VALUES (
  'VA', 'state', 'Virginia',
  8640000, 80615, 38.5,
  62000, 7.2,
  38000, 142, 2800, 14000,
  ARRAY[0.70, 0.80, 1.00, 1.15, 1.25, 1.15, 0.95, 0.85, 1.10, 1.15, 0.90, 0.80],
  ARRAY[0.55, 0.65, 0.85, 1.10, 1.30, 1.45, 1.20, 1.00, 1.25, 1.35, 0.75, 0.55],
  103.5, 3.8,
  'high', null,
  2025, 'The Knot Real Weddings Study 2025 + US Census Bureau + BLS Virginia'
) ON CONFLICT (region_key, data_year) DO NOTHING;

-- ============================================
-- 3. MARKET INTELLIGENCE — VIRGINIA METROS
-- ============================================

-- Charlottesville / Central Virginia (Hawthorne Manor & Crestwood Farm area)
INSERT INTO market_intelligence (
  region_key, region_type, region_name,
  population, median_household_income, median_age,
  marriages_per_year, marriage_rate_per_1000,
  avg_wedding_cost, avg_guest_count, venue_count_estimate, avg_venue_price,
  inquiry_seasonality, booking_seasonality,
  consumer_confidence_index, unemployment_rate,
  nearby_venue_density, price_position,
  data_year, source
) VALUES (
  'VA-Charlottesville', 'metro', 'Charlottesville / Central Virginia',
  265000, 72500, 36.2,
  1900, 7.1,
  32000, 135, 180, 11500,
  ARRAY[0.65, 0.75, 0.95, 1.15, 1.30, 1.20, 0.95, 0.80, 1.15, 1.25, 0.85, 0.75],
  ARRAY[0.50, 0.60, 0.80, 1.15, 1.35, 1.50, 1.25, 1.00, 1.30, 1.40, 0.70, 0.50],
  101.0, 3.5,
  'medium', 'mid-range',
  2025, 'Estimated from The Knot + Census + local market data'
) ON CONFLICT (region_key, data_year) DO NOTHING;

-- Richmond metro (The Glass House area)
INSERT INTO market_intelligence (
  region_key, region_type, region_name,
  population, median_household_income, median_age,
  marriages_per_year, marriage_rate_per_1000,
  avg_wedding_cost, avg_guest_count, venue_count_estimate, avg_venue_price,
  inquiry_seasonality, booking_seasonality,
  consumer_confidence_index, unemployment_rate,
  nearby_venue_density, price_position,
  data_year, source
) VALUES (
  'VA-Richmond', 'metro', 'Richmond Metro',
  1315000, 73200, 37.8,
  9400, 7.1,
  36000, 140, 420, 13500,
  ARRAY[0.70, 0.80, 1.00, 1.15, 1.25, 1.15, 0.95, 0.85, 1.10, 1.15, 0.90, 0.80],
  ARRAY[0.55, 0.65, 0.85, 1.10, 1.30, 1.45, 1.20, 1.00, 1.25, 1.35, 0.75, 0.55],
  102.5, 3.9,
  'high', 'mid-range',
  2025, 'Estimated from The Knot + Census + local market data'
) ON CONFLICT (region_key, data_year) DO NOTHING;

-- Northern Virginia / DC Metro (Rose Hill Gardens area)
INSERT INTO market_intelligence (
  region_key, region_type, region_name,
  population, median_household_income, median_age,
  marriages_per_year, marriage_rate_per_1000,
  avg_wedding_cost, avg_guest_count, venue_count_estimate, avg_venue_price,
  inquiry_seasonality, booking_seasonality,
  consumer_confidence_index, unemployment_rate,
  nearby_venue_density, price_position,
  data_year, source
) VALUES (
  'VA-NoVA', 'metro', 'Northern Virginia / DC Metro',
  3100000, 117000, 37.1,
  22000, 7.1,
  45000, 148, 650, 18000,
  ARRAY[0.70, 0.80, 1.00, 1.15, 1.25, 1.15, 0.95, 0.85, 1.10, 1.15, 0.90, 0.80],
  ARRAY[0.55, 0.65, 0.85, 1.10, 1.30, 1.45, 1.20, 1.00, 1.25, 1.35, 0.75, 0.55],
  105.0, 3.4,
  'saturated', 'premium',
  2025, 'Estimated from The Knot + Census + local market data'
) ON CONFLICT (region_key, data_year) DO NOTHING;

-- ============================================
-- 4. INDUSTRY BENCHMARKS
-- ============================================

-- Response time benchmarks
INSERT INTO industry_benchmarks (benchmark_key, venue_tier, label, description, p25, median, p75, best_in_class, unit, data_year, source) VALUES
  ('first_response_time', 'all', 'First Response Time', 'Time from inquiry to first venue response', 120, 480, 1440, 30, 'minutes', 2025, 'Industry average from vendor surveys'),
  ('first_response_time', 'budget', 'First Response Time (Budget)', 'Budget venues often slower to respond', 240, 720, 2880, 60, 'minutes', 2025, 'Estimated from vendor surveys'),
  ('first_response_time', 'mid-range', 'First Response Time (Mid-Range)', 'Mid-range venues aim for same-day', 120, 480, 1440, 30, 'minutes', 2025, 'Estimated from vendor surveys'),
  ('first_response_time', 'premium', 'First Response Time (Premium)', 'Premium venues respond faster', 60, 240, 720, 15, 'minutes', 2025, 'Estimated from vendor surveys'),
  ('first_response_time', 'luxury', 'First Response Time (Luxury)', 'Luxury venues prioritize immediate response', 30, 120, 480, 10, 'minutes', 2025, 'Estimated from vendor surveys')
ON CONFLICT DO NOTHING;

-- Conversion benchmarks
INSERT INTO industry_benchmarks (benchmark_key, venue_tier, label, description, p25, median, p75, best_in_class, unit, data_year, source) VALUES
  ('inquiry_to_tour', 'all', 'Inquiry to Tour Rate', 'Percentage of inquiries that result in a venue tour', 0.25, 0.35, 0.48, 0.65, 'percent', 2025, 'The Knot Industry Report'),
  ('inquiry_to_tour', 'premium', 'Inquiry to Tour Rate (Premium)', 'Premium venues convert more inquiries to tours', 0.30, 0.42, 0.55, 0.72, 'percent', 2025, 'Estimated'),
  ('tour_to_booking', 'all', 'Tour to Booking Rate', 'Percentage of tours that convert to bookings', 0.30, 0.42, 0.55, 0.70, 'percent', 2025, 'WeddingPro Benchmark Report'),
  ('tour_to_booking', 'premium', 'Tour to Booking Rate (Premium)', 'Premium venues close better after tours', 0.35, 0.48, 0.60, 0.75, 'percent', 2025, 'Estimated'),
  ('inquiry_to_booking', 'all', 'Inquiry to Booking Rate', 'End-to-end conversion from first contact to signed contract', 0.08, 0.15, 0.22, 0.35, 'percent', 2025, 'Derived from inquiry-to-tour and tour-to-booking rates'),
  ('inquiry_to_booking', 'premium', 'Inquiry to Booking Rate (Premium)', 'Premium end-to-end conversion', 0.10, 0.20, 0.30, 0.45, 'percent', 2025, 'Derived')
ON CONFLICT DO NOTHING;

-- Booking value benchmarks
INSERT INTO industry_benchmarks (benchmark_key, venue_tier, label, description, p25, median, p75, best_in_class, unit, data_year, source) VALUES
  ('avg_booking_value', 'budget', 'Avg Booking Value (Budget)', 'Typical booking value for budget-tier venues', 5000, 8000, 12000, 15000, 'dollars', 2025, 'The Knot Real Weddings Study'),
  ('avg_booking_value', 'mid-range', 'Avg Booking Value (Mid-Range)', 'Typical booking value for mid-range venues', 12000, 18000, 25000, 35000, 'dollars', 2025, 'The Knot Real Weddings Study'),
  ('avg_booking_value', 'premium', 'Avg Booking Value (Premium)', 'Typical booking value for premium venues', 25000, 35000, 50000, 75000, 'dollars', 2025, 'The Knot Real Weddings Study'),
  ('avg_booking_value', 'luxury', 'Avg Booking Value (Luxury)', 'Typical booking value for luxury venues', 50000, 75000, 120000, 200000, 'dollars', 2025, 'The Knot Real Weddings Study'),
  ('avg_booking_value', 'all', 'Avg Booking Value', 'Overall average booking value across all tiers', 10000, 16000, 28000, 45000, 'dollars', 2025, 'The Knot Real Weddings Study')
ON CONFLICT DO NOTHING;

-- Capacity utilisation benchmarks
INSERT INTO industry_benchmarks (benchmark_key, venue_tier, label, description, p25, median, p75, best_in_class, unit, data_year, source) VALUES
  ('capacity_utilisation', 'all', 'Capacity Utilisation', 'Percentage of available dates booked per year', 0.15, 0.30, 0.50, 0.75, 'percent', 2025, 'Estimated from industry surveys'),
  ('capacity_utilisation', 'premium', 'Capacity Utilisation (Premium)', 'Premium venues book more dates', 0.25, 0.45, 0.65, 0.85, 'percent', 2025, 'Estimated')
ON CONFLICT DO NOTHING;

-- Team productivity benchmarks
INSERT INTO industry_benchmarks (benchmark_key, venue_tier, label, description, p25, median, p75, best_in_class, unit, data_year, source) VALUES
  ('coordinator_bookings_per_month', 'all', 'Coordinator Bookings per Month', 'New bookings closed per coordinator per month', 1.5, 2.5, 4.0, 6.0, 'count', 2025, 'Estimated from industry averages')
ON CONFLICT DO NOTHING;

-- Decision timeline benchmarks
INSERT INTO industry_benchmarks (benchmark_key, venue_tier, label, description, p25, median, p75, best_in_class, unit, data_year, source) VALUES
  ('days_to_booking', 'all', 'Days: Inquiry to Booking', 'Median days from first contact to signed contract', 14, 28, 45, 7, 'days', 2025, 'WeddingPro Benchmark Report'),
  ('days_to_booking', 'premium', 'Days: Inquiry to Booking (Premium)', 'Premium venues often close faster', 10, 21, 35, 5, 'days', 2025, 'Estimated')
ON CONFLICT DO NOTHING;

-- Revenue per event benchmarks
INSERT INTO industry_benchmarks (benchmark_key, venue_tier, label, description, p25, median, p75, best_in_class, unit, data_year, source) VALUES
  ('revenue_per_guest', 'all', 'Revenue per Guest', 'Average venue revenue per wedding guest', 75, 120, 180, 250, 'dollars', 2025, 'Derived from The Knot data'),
  ('revenue_per_guest', 'premium', 'Revenue per Guest (Premium)', 'Premium venues earn more per head', 150, 225, 350, 500, 'dollars', 2025, 'Derived')
ON CONFLICT DO NOTHING;
