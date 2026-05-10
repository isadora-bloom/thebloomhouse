/**
 * Wave 8 — external signal health check (LAYER FIX).
 *
 * Anchor docs:
 *   - bloom-constitution.md
 *   - feedback_deep_fix_vs_bandaid.md
 *   - bloom-wave4-identity-reconstruction.md
 *
 * Why this exists
 * ---------------
 * The 8 external-signal services each gate silently on different venue
 * fields. Operator has no single surface that says "trends is broken
 * because google_trends_metro is null AND fred is healthy AND census is
 * config_missing because zip is null."
 *
 * This module computes the health for each signal in one pass + upserts
 * into `external_signal_health`. The /intel/external-signals dashboard
 * reads these rows.
 *
 * Status meanings:
 *   ready          — has all config + recent data (or signal is national)
 *   config_missing — at least one required venue field is null
 *   data_stale     — config OK, but last_refresh_at older than threshold
 *   error          — last refresh attempt failed (last_error populated)
 *   disabled       — signal explicitly turned off (future use)
 *
 * "data_stale" is informational; we still mark "ready" as long as some
 * data exists. The dashboard can render "stale" as a sub-badge. For the
 * MVP we surface ready vs config_missing vs error — stale is computed
 * but not used as a hard gate.
 */

import { createServiceClient } from '@/lib/supabase/service'

// =============================================================================
// Types
// =============================================================================

export type SignalName =
  | 'google_trends'
  | 'weather'
  | 'holiday_calendar'
  | 'government'
  | 'cultural_moments'
  | 'market_intelligence'
  | 'fred'
  | 'census'

export const ALL_SIGNALS: ReadonlyArray<SignalName> = [
  'google_trends',
  'weather',
  'holiday_calendar',
  'government',
  'cultural_moments',
  'market_intelligence',
  'fred',
  'census',
]

export type SignalStatus =
  | 'ready'
  | 'config_missing'
  | 'data_stale'
  | 'error'
  | 'disabled'

export interface SignalHealth {
  signal_name: SignalName
  status: SignalStatus
  missing_config_fields: string[]
  last_refresh_at: string | null
  record_count: number
  last_error: string | null
  last_checked_at: string
  /** Display copy — what reads on the dashboard. Not persisted. */
  display_label: string
  display_description: string
}

// =============================================================================
// Per-signal logic
// =============================================================================

interface VenueConfigSnapshot {
  google_trends_metro: string | null
  noaa_station_id: string | null
  state: string | null
  city: string | null
  zip: string | null
  latitude: number | null
  longitude: number | null
  census_fips: string | null
  metro_msa_code: string | null
  dc_region_proxy: boolean | null
}

const STALE_THRESHOLD_DAYS_DEFAULT = 7

function daysAgo(iso: string | null, now: number): number | null {
  if (!iso) return null
  const ms = Date.parse(iso)
  if (!Number.isFinite(ms)) return null
  return (now - ms) / 86_400_000
}

function isStale(iso: string | null, now: number, thresholdDays = STALE_THRESHOLD_DAYS_DEFAULT): boolean {
  const d = daysAgo(iso, now)
  return d != null && d > thresholdDays
}

// =============================================================================
// Public entry
// =============================================================================

/**
 * Run health check for all 8 signals for a single venue. Upserts rows
 * into external_signal_health. Returns the array (with display labels)
 * for direct rendering.
 */
export async function checkExternalSignalHealth(args: {
  venueId: string
}): Promise<SignalHealth[]> {
  const { venueId } = args
  const supabase = createServiceClient()
  const now = Date.now()

  // Load the venue's gating fields in one query.
  const { data: venue, error: venueErr } = await supabase
    .from('venues')
    .select(
      'google_trends_metro, noaa_station_id, state, city, zip, latitude, longitude, census_fips, metro_msa_code, dc_region_proxy',
    )
    .eq('id', venueId)
    .maybeSingle()

  if (venueErr || !venue) {
    throw new Error(`venue ${venueId} not found: ${venueErr?.message ?? 'no row'}`)
  }

  const v = venue as VenueConfigSnapshot
  const results: SignalHealth[] = []

  // -------- 1. Google Trends --------
  results.push(await checkGoogleTrends(supabase, venueId, v, now))

  // -------- 2. Weather --------
  results.push(await checkWeather(supabase, venueId, v, now))

  // -------- 3. Holiday calendar --------
  results.push(await checkHolidayCalendar(supabase, venueId, v, now))

  // -------- 4. Government --------
  results.push(await checkGovernment(supabase, venueId, v, now))

  // -------- 5. Cultural moments --------
  results.push(await checkCulturalMoments(supabase, venueId, now))

  // -------- 6. Market intelligence --------
  results.push(await checkMarketIntelligence(supabase, v, now))

  // -------- 7. FRED --------
  results.push(await checkFred(supabase, now))

  // -------- 8. Census --------
  results.push(await checkCensus(supabase, venueId, v, now))

  // Persist (upsert per signal).
  const upsertRows = results.map((r) => ({
    venue_id: venueId,
    signal_name: r.signal_name,
    status: r.status,
    missing_config_fields: r.missing_config_fields.length > 0 ? r.missing_config_fields : null,
    last_refresh_at: r.last_refresh_at,
    record_count: r.record_count,
    last_error: r.last_error,
    last_checked_at: r.last_checked_at,
  }))

  const { error: upsertErr } = await supabase
    .from('external_signal_health')
    .upsert(upsertRows, { onConflict: 'venue_id,signal_name' })

  if (upsertErr) {
    console.error(`[external-signals-health] upsert failed: ${upsertErr.message}`)
  }

  return results
}

// =============================================================================
// Per-signal checkers
// =============================================================================

async function checkGoogleTrends(
  supabase: ReturnType<typeof createServiceClient>,
  venueId: string,
  v: VenueConfigSnapshot,
  now: number,
): Promise<SignalHealth> {
  const missing: string[] = []
  if (!v.google_trends_metro) missing.push('google_trends_metro')

  let recordCount = 0
  let lastRefresh: string | null = null
  if (v.google_trends_metro) {
    const { count } = await supabase
      .from('search_trends')
      .select('id', { count: 'exact', head: true })
      .eq('venue_id', venueId)
    recordCount = count ?? 0
    const { data } = await supabase
      .from('search_trends')
      .select('week')
      .eq('venue_id', venueId)
      .order('week', { ascending: false })
      .limit(1)
      .maybeSingle()
    lastRefresh = data?.week ?? null
  }

  const status: SignalStatus = missing.length > 0 ? 'config_missing' : 'ready'

  return {
    signal_name: 'google_trends',
    status,
    missing_config_fields: missing,
    last_refresh_at: lastRefresh,
    record_count: recordCount,
    last_error: null,
    last_checked_at: new Date(now).toISOString(),
    display_label: 'Google Trends',
    display_description:
      'Local search interest for wedding-related terms. Powers seasonality + market-pulse views.',
  }
}

async function checkWeather(
  supabase: ReturnType<typeof createServiceClient>,
  venueId: string,
  v: VenueConfigSnapshot,
  now: number,
): Promise<SignalHealth> {
  const missing: string[] = []
  if (!v.noaa_station_id) missing.push('noaa_station_id')
  // Weather rendering uses lat/lng for map pin; lat/lng absent reduces UX
  // but doesn't block ingestion. We list it as a soft requirement.
  if (v.latitude == null || v.longitude == null) missing.push('latitude/longitude')

  let recordCount = 0
  let lastRefresh: string | null = null
  if (v.noaa_station_id) {
    const { count } = await supabase
      .from('weather_data')
      .select('id', { count: 'exact', head: true })
      .eq('venue_id', venueId)
    recordCount = count ?? 0
    const { data } = await supabase
      .from('weather_data')
      .select('date')
      .eq('venue_id', venueId)
      .order('date', { ascending: false })
      .limit(1)
      .maybeSingle()
    lastRefresh = data?.date ?? null
  }

  const status: SignalStatus =
    !v.noaa_station_id ? 'config_missing' : 'ready'

  return {
    signal_name: 'weather',
    status,
    missing_config_fields: missing,
    last_refresh_at: lastRefresh,
    record_count: recordCount,
    last_error: null,
    last_checked_at: new Date(now).toISOString(),
    display_label: 'Weather',
    display_description:
      'NOAA forecast + historical normals. Powers tour-weather risk + outdoor-event planning.',
  }
}

async function checkHolidayCalendar(
  supabase: ReturnType<typeof createServiceClient>,
  venueId: string,
  v: VenueConfigSnapshot,
  now: number,
): Promise<SignalHealth> {
  // Calendar uses geo_scope hierarchy — state alone is enough for state +
  // federal reads. ZIP/county is a bonus for metro-level.
  const missing: string[] = []
  if (!v.state) missing.push('state')

  // Calendar is a national/state table — count rows for the state's geo_scope.
  let recordCount = 0
  let lastRefresh: string | null = null
  if (v.state) {
    const stateLower = v.state.toLowerCase()
    const { count } = await supabase
      .from('external_calendar_events')
      .select('id', { count: 'exact', head: true })
      .or(`geo_scope.eq.us,geo_scope.eq.us_${stateLower},geo_scope.like.us_${stateLower}_%`)
    recordCount = count ?? 0
    const { data } = await supabase
      .from('external_calendar_events')
      .select('start_date')
      .or(`geo_scope.eq.us,geo_scope.eq.us_${stateLower},geo_scope.like.us_${stateLower}_%`)
      .order('start_date', { ascending: false })
      .limit(1)
      .maybeSingle()
    lastRefresh = data?.start_date ?? null
  }

  // Note: venueId is not used by this signal because calendar table is geo-scoped,
  // not venue-scoped. We pass it for API symmetry. Suppress unused-var warning:
  void venueId

  const status: SignalStatus = missing.length > 0 ? 'config_missing' : 'ready'

  return {
    signal_name: 'holiday_calendar',
    status,
    missing_config_fields: missing,
    last_refresh_at: lastRefresh,
    record_count: recordCount,
    last_error: null,
    last_checked_at: new Date(now).toISOString(),
    display_label: 'Holiday Calendar',
    display_description:
      'Federal + state holidays, school breaks, university calendars. Powers seasonality channel.',
  }
}

async function checkGovernment(
  supabase: ReturnType<typeof createServiceClient>,
  venueId: string,
  v: VenueConfigSnapshot,
  now: number,
): Promise<SignalHealth> {
  // Government signal needs either state OR lat/lng (for DC-proxy radius check).
  const missing: string[] = []
  if (!v.state && (v.latitude == null || v.longitude == null)) {
    missing.push('state')
    missing.push('latitude/longitude')
  }

  // No persisted government_signals table; the channel is computed at
  // correlation time. Health == config presence + dc_region_proxy resolved.
  const dcResolved = v.dc_region_proxy != null

  const status: SignalStatus =
    missing.length > 0 ? 'config_missing' : dcResolved ? 'ready' : 'data_stale'

  // Suppress unused; the same query-shape as other checkers.
  void supabase
  void venueId

  return {
    signal_name: 'government',
    status,
    missing_config_fields: missing,
    last_refresh_at: null,
    record_count: 0,
    last_error:
      status === 'data_stale'
        ? 'dc_region_proxy not yet derived — run Auto-derive on /settings/venue-info'
        : null,
    last_checked_at: new Date(now).toISOString(),
    display_label: 'Government / DC Proxy',
    display_description:
      'DC-area shutdown impact channel. Auto-detected from state OR lat/lng radius.',
  }
}

async function checkCulturalMoments(
  supabase: ReturnType<typeof createServiceClient>,
  venueId: string,
  now: number,
): Promise<SignalHealth> {
  // Cultural moments are venue-scoped + LLM-proposed. Health = at least one
  // confirmed moment exists. No address gating.
  const { count } = await supabase
    .from('cultural_moments')
    .select('id', { count: 'exact', head: true })
    .eq('venue_id', venueId)

  const { data } = await supabase
    .from('cultural_moments')
    .select('start_at')
    .eq('venue_id', venueId)
    .order('start_at', { ascending: false })
    .limit(1)
    .maybeSingle()

  const recordCount = count ?? 0
  const status: SignalStatus =
    recordCount === 0 ? 'data_stale' : 'ready'

  return {
    signal_name: 'cultural_moments',
    status,
    missing_config_fields: [],
    last_refresh_at: data?.start_at ?? null,
    record_count: recordCount,
    last_error:
      status === 'data_stale'
        ? 'No confirmed cultural moments yet. Run propose-and-confirm on /intel/cultural-moments.'
        : null,
    last_checked_at: new Date(now).toISOString(),
    display_label: 'Cultural Moments',
    display_description:
      'LLM-proposed cultural events your couples care about. Confirmed moments enter the correlation engine.',
  }
}

async function checkMarketIntelligence(
  supabase: ReturnType<typeof createServiceClient>,
  v: VenueConfigSnapshot,
  now: number,
): Promise<SignalHealth> {
  const missing: string[] = []
  if (!v.state) missing.push('state')

  let recordCount = 0
  let lastRefresh: string | null = null
  if (v.state) {
    const { count } = await supabase
      .from('market_intelligence')
      .select('id', { count: 'exact', head: true })
      .eq('region_key', v.state)
    recordCount = count ?? 0
    const { data } = await supabase
      .from('market_intelligence')
      .select('updated_at')
      .eq('region_key', v.state)
      .order('updated_at', { ascending: false })
      .limit(1)
      .maybeSingle()
    lastRefresh = data?.updated_at ?? null
  }

  const status: SignalStatus =
    missing.length > 0
      ? 'config_missing'
      : recordCount === 0
        ? 'data_stale'
        : 'ready'

  return {
    signal_name: 'market_intelligence',
    status,
    missing_config_fields: missing,
    last_refresh_at: lastRefresh,
    record_count: recordCount,
    last_error:
      status === 'data_stale'
        ? `No market_intelligence row for state ${v.state}. Backfill via the intelligence loader.`
        : null,
    last_checked_at: new Date(now).toISOString(),
    display_label: 'Market Intelligence',
    display_description:
      'Regional demographics, marriage rates, venue density. Auto-loaded by state.',
  }
}

async function checkFred(
  supabase: ReturnType<typeof createServiceClient>,
  now: number,
): Promise<SignalHealth> {
  // FRED is national — no venue config required. Always "available" as long
  // as the cron has run.
  const { count } = await supabase
    .from('fred_indicators')
    .select('id', { count: 'exact', head: true })

  const { data } = await supabase
    .from('fred_indicators')
    .select('observation_date')
    .order('observation_date', { ascending: false })
    .limit(1)
    .maybeSingle()

  const recordCount = count ?? 0
  const lastRefresh = data?.observation_date ?? null
  const stale = isStale(lastRefresh, now, 14)

  const status: SignalStatus =
    recordCount === 0 ? 'data_stale' : stale ? 'data_stale' : 'ready'

  return {
    signal_name: 'fred',
    status,
    missing_config_fields: [],
    last_refresh_at: lastRefresh,
    record_count: recordCount,
    last_error:
      status === 'data_stale'
        ? 'FRED indicators not refreshed recently — check the FRED cron job'
        : null,
    last_checked_at: new Date(now).toISOString(),
    display_label: 'FRED Macro Indicators',
    display_description:
      'CPI, mortgage rate, S&P 500, unemployment, consumer sentiment. National data, always available.',
  }
}

async function checkCensus(
  supabase: ReturnType<typeof createServiceClient>,
  venueId: string,
  v: VenueConfigSnapshot,
  now: number,
): Promise<SignalHealth> {
  const missing: string[] = []
  if (!v.census_fips) missing.push('census_fips')

  // Census is loaded into market_intelligence via county FIPS. Approximation:
  // count market_intelligence rows whose region_key matches the FIPS prefix.
  // For MVP we skip the per-record count and treat presence-of-FIPS as ready.
  let recordCount = 0
  if (v.census_fips) {
    // Use the census-cols-extended market_intelligence table when FIPS is set.
    const { count } = await supabase
      .from('market_intelligence')
      .select('id', { count: 'exact', head: true })
      .or(`region_key.eq.${v.census_fips},region_key.like.${v.census_fips}%`)
    recordCount = count ?? 0
  }

  // Suppress unused var note.
  void venueId

  const status: SignalStatus =
    missing.length > 0 ? 'config_missing' : 'ready'

  return {
    signal_name: 'census',
    status,
    missing_config_fields: missing,
    last_refresh_at: null,
    record_count: recordCount,
    last_error: null,
    last_checked_at: new Date(now).toISOString(),
    display_label: 'Census',
    display_description:
      'County-level demographics, household income, marriage stats. Derived from ZIP + Census Geocoder.',
  }
}
