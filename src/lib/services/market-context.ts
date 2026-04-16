/**
 * Bloom House: Market Context Service
 *
 * Resolves market intelligence for a venue based on its location.
 * This is the "immediate value" layer — when a venue signs up and enters
 * their city/state, they can immediately see their market context from
 * pre-loaded external data. Their own operational data makes it better
 * over time.
 *
 * Fallback chain: metro → state → national
 */

import { createServiceClient } from '@/lib/supabase/service'

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface MarketData {
  regionKey: string
  regionType: 'national' | 'state' | 'metro' | 'county'
  regionName: string
  population: number | null
  medianHouseholdIncome: number | null
  medianAge: number | null
  marriagesPerYear: number | null
  marriageRatePer1000: number | null
  avgWeddingCost: number | null
  avgGuestCount: number | null
  venueCountEstimate: number | null
  avgVenuePrice: number | null
  inquirySeasonality: number[] | null
  bookingSeasonality: number[] | null
  consumerConfidenceIndex: number | null
  unemploymentRate: number | null
  nearbyVenueDensity: string | null
  pricePosition: string | null
  dataYear: number
  source: string | null
}

export interface BenchmarkRow {
  benchmarkKey: string
  venueTier: string
  label: string
  description: string | null
  p25: number | null
  median: number | null
  p75: number | null
  bestInClass: number | null
  unit: string | null
}

export interface MarketContext {
  market: MarketData | null
  benchmarks: BenchmarkRow[]
  venueTier: VenueTier
  seasonalIndex: number | null      // current month's inquiry seasonality factor
  seasonalLabel: string | null       // e.g., "+20% above average"
}

export interface BenchmarkComparison {
  benchmarkKey: string
  label: string
  venueValue: number | null
  industryMedian: number | null
  industryP25: number | null
  industryP75: number | null
  bestInClass: number | null
  percentileEstimate: number | null  // 0-100
  unit: string | null
  verdict: 'excellent' | 'good' | 'average' | 'below_average' | 'no_data'
}

type VenueTier = 'budget' | 'mid-range' | 'premium' | 'luxury' | 'all'

// ---------------------------------------------------------------------------
// Metro key mapping — maps city/state to a metro region_key
// ---------------------------------------------------------------------------

const METRO_MAPPING: Record<string, string> = {
  // Central Virginia
  'charlottesville-va': 'VA-Charlottesville',
  'culpeper-va': 'VA-Charlottesville',
  'orange-va': 'VA-Charlottesville',
  'gordonsville-va': 'VA-Charlottesville',
  'madison-va': 'VA-Charlottesville',
  'rixeyville-va': 'VA-Charlottesville',
  'warrenton-va': 'VA-Charlottesville',
  // Richmond
  'richmond-va': 'VA-Richmond',
  'midlothian-va': 'VA-Richmond',
  'glen allen-va': 'VA-Richmond',
  'henrico-va': 'VA-Richmond',
  'chesterfield-va': 'VA-Richmond',
  'mechanicsville-va': 'VA-Richmond',
  // Northern Virginia / DC Metro
  'leesburg-va': 'VA-NoVA',
  'arlington-va': 'VA-NoVA',
  'alexandria-va': 'VA-NoVA',
  'fairfax-va': 'VA-NoVA',
  'reston-va': 'VA-NoVA',
  'mclean-va': 'VA-NoVA',
  'vienna-va': 'VA-NoVA',
  'manassas-va': 'VA-NoVA',
  'gainesville-va': 'VA-NoVA',
  'ashburn-va': 'VA-NoVA',
  'sterling-va': 'VA-NoVA',
  'herndon-va': 'VA-NoVA',
  'tysons-va': 'VA-NoVA',
  'loudoun-va': 'VA-NoVA',
}

function resolveMetroKey(city: string | null, state: string | null): string | null {
  if (!city || !state) return null
  const key = `${city.toLowerCase().trim()}-${state.toLowerCase().trim()}`
  return METRO_MAPPING[key] ?? null
}

function resolveVenueTier(basePrice: number | null): VenueTier {
  if (!basePrice) return 'all'
  if (basePrice < 5000) return 'budget'
  if (basePrice < 15000) return 'mid-range'
  if (basePrice < 40000) return 'premium'
  return 'luxury'
}

// ---------------------------------------------------------------------------
// Market data row → typed MarketData
// ---------------------------------------------------------------------------

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function toMarketData(row: any): MarketData {
  return {
    regionKey: row.region_key,
    regionType: row.region_type,
    regionName: row.region_name,
    population: row.population,
    medianHouseholdIncome: row.median_household_income,
    medianAge: row.median_age,
    marriagesPerYear: row.marriages_per_year,
    marriageRatePer1000: row.marriage_rate_per_1000,
    avgWeddingCost: row.avg_wedding_cost,
    avgGuestCount: row.avg_guest_count,
    venueCountEstimate: row.venue_count_estimate,
    avgVenuePrice: row.avg_venue_price,
    inquirySeasonality: row.inquiry_seasonality,
    bookingSeasonality: row.booking_seasonality,
    consumerConfidenceIndex: row.consumer_confidence_index,
    unemploymentRate: row.unemployment_rate,
    nearbyVenueDensity: row.nearby_venue_density,
    pricePosition: row.price_position,
    dataYear: row.data_year,
    source: row.source,
  }
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function toBenchmarkRow(row: any): BenchmarkRow {
  return {
    benchmarkKey: row.benchmark_key,
    venueTier: row.venue_tier,
    label: row.label,
    description: row.description,
    p25: row.p25,
    median: row.median,
    p75: row.p75,
    bestInClass: row.best_in_class,
    unit: row.unit,
  }
}

// ---------------------------------------------------------------------------
// getMarketContext — main entry point
// ---------------------------------------------------------------------------

/**
 * Resolves market intelligence for a venue based on its location.
 * Falls back: metro → state → national.
 */
export async function getMarketContext(venueId: string): Promise<MarketContext> {
  const supabase = createServiceClient()

  // Get venue location + pricing for tier
  const { data: venue } = await supabase
    .from('venues')
    .select('state, city, latitude, longitude')
    .eq('id', venueId)
    .maybeSingle()

  const { data: config } = await supabase
    .from('venue_config')
    .select('base_price')
    .eq('venue_id', venueId)
    .maybeSingle()

  const venueTier = resolveVenueTier(config?.base_price ?? null)
  const state = venue?.state as string | null
  const city = venue?.city as string | null

  // Try metro first, then state, then national
  const metroKey = resolveMetroKey(city, state)
  const candidates = [metroKey, state, 'US'].filter(Boolean) as string[]

  let market: MarketData | null = null

  for (const regionKey of candidates) {
    const { data } = await supabase
      .from('market_intelligence')
      .select('*')
      .eq('region_key', regionKey)
      .order('data_year', { ascending: false })
      .limit(1)
      .maybeSingle()

    if (data) {
      market = toMarketData(data)
      break
    }
  }

  // Fetch benchmarks for the venue's tier + 'all' tier
  const tiers = venueTier !== 'all' ? [venueTier, 'all'] : ['all']
  const { data: benchmarkRows } = await supabase
    .from('industry_benchmarks')
    .select('*')
    .in('venue_tier', tiers)
    .order('benchmark_key')

  const benchmarks = (benchmarkRows ?? []).map(toBenchmarkRow)

  // Calculate current month's seasonal index
  const currentMonth = new Date().getMonth() // 0-11
  let seasonalIndex: number | null = null
  let seasonalLabel: string | null = null

  if (market?.inquirySeasonality && market.inquirySeasonality.length === 12) {
    seasonalIndex = market.inquirySeasonality[currentMonth]
    if (seasonalIndex !== null) {
      const pctDiff = Math.round((seasonalIndex - 1.0) * 100)
      if (pctDiff > 0) {
        seasonalLabel = `${pctDiff}% above seasonal average`
      } else if (pctDiff < 0) {
        seasonalLabel = `${Math.abs(pctDiff)}% below seasonal average`
      } else {
        seasonalLabel = 'at seasonal average'
      }
    }
  }

  return { market, benchmarks, venueTier, seasonalIndex, seasonalLabel }
}

// ---------------------------------------------------------------------------
// getMarketContextForClient — lighter version for client components
// ---------------------------------------------------------------------------

/**
 * Same as getMarketContext but takes city/state/basePrice directly
 * (for use in API routes where we already have the venue data).
 */
export async function getMarketContextDirect(
  city: string | null,
  state: string | null,
  basePrice: number | null
): Promise<MarketContext> {
  const supabase = createServiceClient()
  const venueTier = resolveVenueTier(basePrice)

  const metroKey = resolveMetroKey(city, state)
  const candidates = [metroKey, state, 'US'].filter(Boolean) as string[]

  let market: MarketData | null = null

  for (const regionKey of candidates) {
    const { data } = await supabase
      .from('market_intelligence')
      .select('*')
      .eq('region_key', regionKey)
      .order('data_year', { ascending: false })
      .limit(1)
      .maybeSingle()

    if (data) {
      market = toMarketData(data)
      break
    }
  }

  const tiers = venueTier !== 'all' ? [venueTier, 'all'] : ['all']
  const { data: benchmarkRows } = await supabase
    .from('industry_benchmarks')
    .select('*')
    .in('venue_tier', tiers)
    .order('benchmark_key')

  const benchmarks = (benchmarkRows ?? []).map(toBenchmarkRow)

  const currentMonth = new Date().getMonth()
  let seasonalIndex: number | null = null
  let seasonalLabel: string | null = null

  if (market?.inquirySeasonality && market.inquirySeasonality.length === 12) {
    seasonalIndex = market.inquirySeasonality[currentMonth]
    if (seasonalIndex !== null) {
      const pctDiff = Math.round((seasonalIndex - 1.0) * 100)
      if (pctDiff > 0) {
        seasonalLabel = `${pctDiff}% above seasonal average`
      } else if (pctDiff < 0) {
        seasonalLabel = `${Math.abs(pctDiff)}% below seasonal average`
      } else {
        seasonalLabel = 'at seasonal average'
      }
    }
  }

  return { market, benchmarks, venueTier, seasonalIndex, seasonalLabel }
}

// ---------------------------------------------------------------------------
// benchmarkVenue — compare a venue's actual metrics against industry
// ---------------------------------------------------------------------------

/**
 * Compare a venue's metrics against industry benchmarks.
 * Returns percentile position for each metric.
 */
export async function benchmarkVenue(venueId: string): Promise<BenchmarkComparison[]> {
  const supabase = createServiceClient()

  // Get venue config for tier
  const { data: config } = await supabase
    .from('venue_config')
    .select('base_price')
    .eq('venue_id', venueId)
    .maybeSingle()

  const venueTier = resolveVenueTier(config?.base_price ?? null)

  // Get the venue's actual metrics
  const [responseTimeResult, conversionResult, bookingValueResult] = await Promise.all([
    // Average first response time (minutes)
    supabase
      .from('weddings')
      .select('inquiry_date, first_response_at')
      .eq('venue_id', venueId)
      .not('first_response_at', 'is', null)
      .not('inquiry_date', 'is', null)
      .order('inquiry_date', { ascending: false })
      .limit(50),

    // Conversion: inquiries vs booked
    supabase
      .from('weddings')
      .select('status')
      .eq('venue_id', venueId),

    // Booking value
    supabase
      .from('weddings')
      .select('booking_value')
      .eq('venue_id', venueId)
      .eq('status', 'booked')
      .not('booking_value', 'is', null),
  ])

  // Calculate actual venue metrics
  const responseTimes = (responseTimeResult.data ?? [])
    .map((w) => {
      const inquiry = new Date(w.inquiry_date as string)
      const response = new Date(w.first_response_at as string)
      return (response.getTime() - inquiry.getTime()) / (1000 * 60) // minutes
    })
    .filter((m) => m > 0 && m < 10080) // filter out nonsense (>7 days)

  const avgResponseTime = responseTimes.length > 0
    ? responseTimes.reduce((a, b) => a + b, 0) / responseTimes.length
    : null

  const weddings = conversionResult.data ?? []
  const totalInquiries = weddings.length
  const totalBooked = weddings.filter((w) => w.status === 'booked').length
  const conversionRate = totalInquiries > 0 ? totalBooked / totalInquiries : null

  const bookingValues = (bookingValueResult.data ?? []).map((w) => w.booking_value as number)
  const avgBookingValue = bookingValues.length > 0
    ? bookingValues.reduce((a, b) => a + b, 0) / bookingValues.length
    : null

  // Get benchmarks for the venue's tier (prefer tier-specific, fall back to 'all')
  const tiers = venueTier !== 'all' ? [venueTier, 'all'] : ['all']
  const { data: benchmarkRows } = await supabase
    .from('industry_benchmarks')
    .select('*')
    .in('venue_tier', tiers)
    .order('benchmark_key')

  const benchmarks = (benchmarkRows ?? []).map(toBenchmarkRow)

  // Build comparisons
  const comparisons: BenchmarkComparison[] = []

  // Helper to find best benchmark (tier-specific first, then 'all')
  function findBenchmark(key: string): BenchmarkRow | undefined {
    return benchmarks.find((b) => b.benchmarkKey === key && b.venueTier === venueTier)
      ?? benchmarks.find((b) => b.benchmarkKey === key && b.venueTier === 'all')
  }

  // Response time comparison (lower is better)
  const rtBench = findBenchmark('first_response_time')
  if (rtBench) {
    comparisons.push(makeComparison(
      'first_response_time', rtBench, avgResponseTime, true
    ))
  }

  // Conversion comparison (higher is better)
  const convBench = findBenchmark('inquiry_to_booking')
  if (convBench) {
    comparisons.push(makeComparison(
      'inquiry_to_booking', convBench, conversionRate, false
    ))
  }

  // Booking value comparison (higher is better)
  const bvBench = findBenchmark('avg_booking_value')
  if (bvBench) {
    comparisons.push(makeComparison(
      'avg_booking_value', bvBench, avgBookingValue, false
    ))
  }

  return comparisons
}

/**
 * Estimate percentile and verdict for a venue metric against a benchmark.
 */
function makeComparison(
  key: string,
  bench: BenchmarkRow,
  venueValue: number | null,
  lowerIsBetter: boolean
): BenchmarkComparison {
  if (venueValue === null || bench.median === null) {
    return {
      benchmarkKey: key,
      label: bench.label,
      venueValue,
      industryMedian: bench.median,
      industryP25: bench.p25,
      industryP75: bench.p75,
      bestInClass: bench.bestInClass,
      percentileEstimate: null,
      unit: bench.unit,
      verdict: 'no_data',
    }
  }

  // Estimate percentile using linear interpolation between known points
  let percentile: number
  if (lowerIsBetter) {
    // For "lower is better" metrics (response time, days to booking)
    // best_in_class is top 10%, so being below it = 90+
    if (bench.bestInClass !== null && venueValue <= bench.bestInClass) {
      percentile = 95
    } else if (bench.p25 !== null && venueValue <= bench.p25) {
      percentile = 80
    } else if (venueValue <= bench.median) {
      percentile = 60
    } else if (bench.p75 !== null && venueValue <= bench.p75) {
      percentile = 35
    } else {
      percentile = 15
    }
  } else {
    // For "higher is better" metrics (conversion, booking value)
    if (bench.bestInClass !== null && venueValue >= bench.bestInClass) {
      percentile = 95
    } else if (bench.p75 !== null && venueValue >= bench.p75) {
      percentile = 80
    } else if (venueValue >= bench.median) {
      percentile = 60
    } else if (bench.p25 !== null && venueValue >= bench.p25) {
      percentile = 35
    } else {
      percentile = 15
    }
  }

  let verdict: BenchmarkComparison['verdict']
  if (percentile >= 80) verdict = 'excellent'
  else if (percentile >= 60) verdict = 'good'
  else if (percentile >= 40) verdict = 'average'
  else verdict = 'below_average'

  return {
    benchmarkKey: key,
    label: bench.label,
    venueValue,
    industryMedian: bench.median,
    industryP25: bench.p25,
    industryP75: bench.p75,
    bestInClass: bench.bestInClass,
    percentileEstimate: percentile,
    unit: bench.unit,
    verdict,
  }
}
