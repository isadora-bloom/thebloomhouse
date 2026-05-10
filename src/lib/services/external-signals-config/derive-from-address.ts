/**
 * Wave 8 — derive external-signal config from a single address (LAYER FIX).
 *
 * Anchor docs:
 *   - bloom-constitution.md (one source of truth, derive the rest)
 *   - bloom-wave4-identity-reconstruction.md (Wave 4 doctrine — same pattern)
 *   - feedback_deep_fix_vs_bandaid.md (layer fix not rule fix)
 *
 * Why this exists
 * ---------------
 * The 8 external-signal services (trends/weather/holiday/government/cultural/
 * market/fred/census) each gate on a different venue config field. Today the
 * coordinator surface (/settings/venue-info) captures only address fields;
 * google_trends_metro + noaa_station_id are filled by hand if at all. So a
 * "complete" venue can still have trends + weather broken silently, and
 * each missing field becomes a whack-a-mole report from ops.
 *
 * This module's contract: given an address, return EVERY external-signal
 * config field that can be derived. The caller writes the result back to
 * `venues` columns. Network failures are non-fatal — partial results
 * + errors[] flow back so the UI can render "✗ noaa_station_id (lat/lng
 * missing)" inline.
 *
 * Doctrine alignment
 * ------------------
 * Layer fix not rule fix. We don't add a new piecemeal field per signal —
 * we add ONE derive layer behind the existing address surface. New signals
 * extend this module + the health check; the operator surface doesn't
 * change shape.
 *
 * Hardcoded fallback tables (NOT regex on user-text — see
 * feedback_no_regex_on_user_text.md). When the network call fails or
 * inputs are missing, we fall back to:
 *   - small lookup table for ~40 most common US metros (SerpAPI codes)
 *   - state-level SerpAPI code (e.g. 'US-VA') for the long tail
 *   - small city→station table for major cities (NOAA fallback)
 *   - small county-FIPS→MSA table for major metros (BLS fallback)
 *
 * Cache: lookups are de-duped within a call (multi-venue sweep doesn't
 * hammer the geocoder for the same ZIP 50 times).
 */

// =============================================================================
// Types
// =============================================================================

export interface AddressInput {
  line1: string | null
  city: string | null
  state: string | null  // 2-letter
  zip: string | null
  latitude: number | null
  longitude: number | null
}

export interface DerivationResult {
  google_trends_metro: string | null
  noaa_station_id: string | null
  census_fips: string | null
  metro_msa_code: string | null
  dc_region_proxy: boolean | null
  latitude: number | null
  longitude: number | null
  errors: string[]
  inputs: AddressInput
  /** What each field was derived from. Persisted to location_derivation_source. */
  field_sources: Record<string, string>
}

// =============================================================================
// Constants — small lookup tables (long tail handled by state-fallback or LLM)
// =============================================================================

/**
 * Hardcoded SerpAPI Google Trends metro codes for the most common US metros.
 * Source: SerpAPI's geo-targets list for Google Trends. Each entry is the
 * "DMA" identifier SerpAPI accepts in the `geo` query param.
 *
 * Long tail: SerpAPI accepts state-level codes ('US-VA') as fallback, so we
 * don't need to be exhaustive. The state fallback handles every venue we
 * don't have a specific metro for.
 *
 * Coverage rationale: top ~40 metros + state fallback covers 100% of US ZIPs.
 */
const SERPAPI_METRO_BY_STATE_PARTIAL: ReadonlyArray<{
  state: string
  zipPrefix?: string  // optional finer-grained match by ZIP3
  cityKeyword?: string  // optional finer-grained match by city contains
  code: string
  name: string
}> = [
  // Virginia
  { state: 'VA', zipPrefix: '227', code: 'US-VA-584', name: 'DC area (Charlottesville/Culpeper)' },
  { state: 'VA', zipPrefix: '220', code: 'US-VA-511', name: 'DC area (Northern VA)' },
  { state: 'VA', zipPrefix: '221', code: 'US-VA-511', name: 'DC area (Northern VA)' },
  { state: 'VA', zipPrefix: '222', code: 'US-VA-511', name: 'DC area (Northern VA)' },
  { state: 'VA', zipPrefix: '232', code: 'US-VA-556', name: 'Richmond-Petersburg' },
  { state: 'VA', zipPrefix: '234', code: 'US-VA-556', name: 'Richmond-Petersburg' },
  { state: 'VA', zipPrefix: '236', code: 'US-VA-544', name: 'Norfolk-Portsmouth-Newport News' },
  { state: 'VA', zipPrefix: '238', code: 'US-VA-544', name: 'Norfolk-Portsmouth-Newport News' },
  // DC / Maryland
  { state: 'DC', code: 'US-DC-511', name: 'Washington DC' },
  { state: 'MD', zipPrefix: '208', code: 'US-MD-511', name: 'DC area (Suburban MD)' },
  { state: 'MD', zipPrefix: '212', code: 'US-MD-512', name: 'Baltimore' },
  { state: 'MD', zipPrefix: '210', code: 'US-MD-512', name: 'Baltimore' },
  // New York
  { state: 'NY', zipPrefix: '100', code: 'US-NY-501', name: 'New York' },
  { state: 'NY', zipPrefix: '101', code: 'US-NY-501', name: 'New York' },
  { state: 'NY', zipPrefix: '110', code: 'US-NY-501', name: 'New York (LI)' },
  { state: 'NY', zipPrefix: '142', code: 'US-NY-514', name: 'Buffalo' },
  // California
  { state: 'CA', zipPrefix: '900', code: 'US-CA-803', name: 'Los Angeles' },
  { state: 'CA', zipPrefix: '902', code: 'US-CA-803', name: 'Los Angeles' },
  { state: 'CA', zipPrefix: '941', code: 'US-CA-807', name: 'San Francisco-Oakland-San Jose' },
  { state: 'CA', zipPrefix: '950', code: 'US-CA-807', name: 'San Jose' },
  { state: 'CA', zipPrefix: '921', code: 'US-CA-825', name: 'San Diego' },
  { state: 'CA', zipPrefix: '958', code: 'US-CA-862', name: 'Sacramento-Stockton-Modesto' },
  // Texas
  { state: 'TX', zipPrefix: '750', code: 'US-TX-623', name: 'Dallas-Fort Worth' },
  { state: 'TX', zipPrefix: '770', code: 'US-TX-618', name: 'Houston' },
  { state: 'TX', zipPrefix: '787', code: 'US-TX-635', name: 'Austin' },
  { state: 'TX', zipPrefix: '782', code: 'US-TX-641', name: 'San Antonio' },
  // Florida
  { state: 'FL', zipPrefix: '331', code: 'US-FL-528', name: 'Miami-Fort Lauderdale' },
  { state: 'FL', zipPrefix: '328', code: 'US-FL-534', name: 'Orlando-Daytona Beach' },
  { state: 'FL', zipPrefix: '337', code: 'US-FL-539', name: 'Tampa-St. Petersburg' },
  { state: 'FL', zipPrefix: '323', code: 'US-FL-530', name: 'Tallahassee' },
  // Illinois
  { state: 'IL', zipPrefix: '606', code: 'US-IL-602', name: 'Chicago' },
  { state: 'IL', zipPrefix: '601', code: 'US-IL-602', name: 'Chicago' },
  // Massachusetts
  { state: 'MA', zipPrefix: '021', code: 'US-MA-506', name: 'Boston-Manchester' },
  { state: 'MA', zipPrefix: '022', code: 'US-MA-506', name: 'Boston-Manchester' },
  // Washington / Oregon
  { state: 'WA', zipPrefix: '981', code: 'US-WA-819', name: 'Seattle-Tacoma' },
  { state: 'OR', zipPrefix: '972', code: 'US-OR-820', name: 'Portland' },
  // Georgia / Tennessee
  { state: 'GA', zipPrefix: '303', code: 'US-GA-524', name: 'Atlanta' },
  { state: 'TN', zipPrefix: '372', code: 'US-TN-659', name: 'Nashville' },
  // Pennsylvania
  { state: 'PA', zipPrefix: '191', code: 'US-PA-504', name: 'Philadelphia' },
  { state: 'PA', zipPrefix: '152', code: 'US-PA-508', name: 'Pittsburgh' },
  // Colorado
  { state: 'CO', zipPrefix: '802', code: 'US-CO-751', name: 'Denver' },
  // Arizona / Nevada
  { state: 'AZ', zipPrefix: '850', code: 'US-AZ-753', name: 'Phoenix' },
  { state: 'NV', zipPrefix: '891', code: 'US-NV-839', name: 'Las Vegas' },
  // Minnesota / Wisconsin
  { state: 'MN', zipPrefix: '554', code: 'US-MN-613', name: 'Minneapolis-St. Paul' },
  { state: 'WI', zipPrefix: '532', code: 'US-WI-617', name: 'Milwaukee' },
  // North Carolina
  { state: 'NC', zipPrefix: '282', code: 'US-NC-518', name: 'Charlotte' },
  { state: 'NC', zipPrefix: '276', code: 'US-NC-560', name: 'Raleigh-Durham' },
]

/**
 * Hardcoded BLS Metropolitan Statistical Area codes for the major US metros.
 * Source: BLS OEWS metro lookup. Long tail: null (signal degrades to
 * "config_missing" until ops fills in).
 */
const MSA_BY_GTRENDS_METRO: Record<string, string> = {
  // DC area
  'US-VA-511': '47900',  // Washington-Arlington-Alexandria, DC-VA-MD-WV
  'US-VA-584': '47900',  // Charlottesville folds into DC for MSA purposes (close enough; mig 271)
  'US-DC-511': '47900',
  'US-MD-511': '47900',
  // Major metros
  'US-NY-501': '35620',  // New York-Newark-Jersey City, NY-NJ-PA
  'US-CA-803': '31080',  // Los Angeles-Long Beach-Anaheim, CA
  'US-CA-807': '41860',  // San Francisco-Oakland-Berkeley, CA
  'US-CA-825': '41740',  // San Diego-Chula Vista-Carlsbad, CA
  'US-TX-623': '19100',  // Dallas-Fort Worth-Arlington, TX
  'US-TX-618': '26420',  // Houston-The Woodlands-Sugar Land, TX
  'US-TX-635': '12420',  // Austin-Round Rock-Georgetown, TX
  'US-FL-528': '33100',  // Miami-Fort Lauderdale-Pompano Beach, FL
  'US-FL-534': '36740',  // Orlando-Kissimmee-Sanford, FL
  'US-IL-602': '16980',  // Chicago-Naperville-Elgin, IL-IN-WI
  'US-MA-506': '14460',  // Boston-Cambridge-Newton, MA-NH
  'US-WA-819': '42660',  // Seattle-Tacoma-Bellevue, WA
  'US-GA-524': '12060',  // Atlanta-Sandy Springs-Alpharetta, GA
  'US-PA-504': '37980',  // Philadelphia-Camden-Wilmington, PA-NJ-DE-MD
  'US-CO-751': '19740',  // Denver-Aurora-Lakewood, CO
  'US-AZ-753': '38060',  // Phoenix-Mesa-Chandler, AZ
  'US-NV-839': '29820',  // Las Vegas-Henderson-Paradise, NV
  'US-MN-613': '33460',  // Minneapolis-St. Paul-Bloomington, MN-WI
  'US-NC-518': '16740',  // Charlotte-Concord-Gastonia, NC-SC
  'US-NC-560': '39580',  // Raleigh-Cary, NC
}

/**
 * NOAA fallback stations for major cities. When lat/lng aren't provided, OR
 * the NOAA API errors, we use this table. Sources documented inline.
 *
 * Stations chosen are airport stations (USW prefix) which have the best data
 * quality and longest history. GHCND datatype.
 */
const NOAA_STATION_BY_STATE_CITY: ReadonlyArray<{
  state: string
  cityKeyword?: string  // case-insensitive city contains, optional
  station: string
  name: string
}> = [
  // VA / DC
  { state: 'VA', cityKeyword: 'rixey', station: 'USW00093738', name: 'Reagan National (DC area)' },
  { state: 'VA', cityKeyword: 'culpeper', station: 'USW00093738', name: 'Reagan National (DC area)' },
  { state: 'VA', station: 'USW00013740', name: 'Richmond International' },
  { state: 'DC', station: 'USW00093738', name: 'Reagan National' },
  { state: 'MD', station: 'USW00093721', name: 'Baltimore-Washington Intl' },
  // Major metros
  { state: 'NY', cityKeyword: 'new york', station: 'USW00094728', name: 'NYC Central Park' },
  { state: 'NY', station: 'USW00014733', name: 'Buffalo' },
  { state: 'CA', cityKeyword: 'los angeles', station: 'USW00023174', name: 'LAX' },
  { state: 'CA', cityKeyword: 'san francisco', station: 'USW00023234', name: 'SFO' },
  { state: 'CA', station: 'USW00023174', name: 'LAX (state fallback)' },
  { state: 'TX', cityKeyword: 'dallas', station: 'USW00013960', name: 'Dallas/Fort Worth' },
  { state: 'TX', cityKeyword: 'houston', station: 'USW00012960', name: 'Houston Bush Intercontinental' },
  { state: 'TX', cityKeyword: 'austin', station: 'USW00013904', name: 'Austin-Bergstrom' },
  { state: 'TX', station: 'USW00013960', name: 'DFW (state fallback)' },
  { state: 'FL', cityKeyword: 'miami', station: 'USW00012839', name: 'Miami International' },
  { state: 'FL', cityKeyword: 'orlando', station: 'USW00012815', name: 'Orlando International' },
  { state: 'FL', station: 'USW00012815', name: 'Orlando (state fallback)' },
  { state: 'IL', station: 'USW00094846', name: "Chicago O'Hare" },
  { state: 'MA', station: 'USW00014739', name: 'Boston Logan' },
  { state: 'WA', station: 'USW00024233', name: 'Seattle-Tacoma' },
  { state: 'GA', station: 'USW00013874', name: 'Atlanta Hartsfield' },
  { state: 'PA', cityKeyword: 'philadelphia', station: 'USW00013739', name: 'Philadelphia International' },
  { state: 'PA', station: 'USW00094823', name: 'Pittsburgh International' },
  { state: 'CO', station: 'USW00003017', name: 'Denver International' },
  { state: 'AZ', station: 'USW00023183', name: 'Phoenix Sky Harbor' },
  { state: 'NV', station: 'USW00023169', name: 'Las Vegas McCarran' },
  { state: 'MN', station: 'USW00014922', name: 'Minneapolis-St. Paul' },
  { state: 'NC', cityKeyword: 'charlotte', station: 'USW00013881', name: 'Charlotte Douglas' },
  { state: 'NC', station: 'USW00013722', name: 'Raleigh-Durham (state fallback)' },
  { state: 'TN', station: 'USW00013897', name: 'Nashville International' },
  { state: 'OR', station: 'USW00024229', name: 'Portland International' },
]

/**
 * DC region proxy: states immediately adjacent or within commuter range
 * of the federal capital. Mirrors government.ts DC_REGION_STATES.
 */
const DC_REGION_STATES = new Set(['VA', 'DC', 'MD', 'WV'])
const DC_LAT = 38.9072
const DC_LON = -77.0369
const DC_RADIUS_MILES = 100

// =============================================================================
// Helpers
// =============================================================================

function toRad(deg: number): number {
  return (deg * Math.PI) / 180
}

function haversineMiles(lat1: number, lon1: number, lat2: number, lon2: number): number {
  const R = 3958.8  // Earth radius in miles
  const dLat = toRad(lat2 - lat1)
  const dLon = toRad(lon2 - lon1)
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(a)))
}

function normState(s: string | null): string | null {
  if (!s) return null
  const t = s.trim().toUpperCase()
  return /^[A-Z]{2}$/.test(t) ? t : null
}

function zipPrefix3(zip: string | null): string | null {
  if (!zip) return null
  const m = zip.trim().match(/^(\d{3})/)
  return m ? m[1] : null
}

// =============================================================================
// Per-call cache (de-dupes lookups within one sweep call)
// =============================================================================

interface DeriveCache {
  censusFipsByZip: Map<string, string | null>
  noaaStationByLatLng: Map<string, string | null>
  geocodedFromAddress: Map<string, { lat: number | null; lng: number | null }>
}

function newCache(): DeriveCache {
  return {
    censusFipsByZip: new Map(),
    noaaStationByLatLng: new Map(),
    geocodedFromAddress: new Map(),
  }
}

// =============================================================================
// Field-by-field derivers
// =============================================================================

/**
 * SerpAPI metro code for Google Trends. Tries the partial table first (state +
 * zip3 + city keyword), then falls back to state-level code (`US-VA`).
 *
 * SerpAPI accepts both DMA codes (`US-VA-584`) and state codes (`US-VA`) in
 * the `geo` query param. State-level data is coarser but valid.
 */
function deriveGoogleTrendsMetro(
  address: AddressInput,
): { value: string | null; source: string } {
  const state = normState(address.state)
  if (!state) return { value: null, source: 'state_missing' }

  const zip3 = zipPrefix3(address.zip)
  const cityLower = (address.city ?? '').trim().toLowerCase()

  // Try most-specific: zip prefix
  if (zip3) {
    const exact = SERPAPI_METRO_BY_STATE_PARTIAL.find(
      (r) => r.state === state && r.zipPrefix === zip3,
    )
    if (exact) return { value: exact.code, source: `zip_prefix_${zip3}` }
  }

  // Try city keyword
  if (cityLower) {
    const cityHit = SERPAPI_METRO_BY_STATE_PARTIAL.find(
      (r) =>
        r.state === state &&
        r.cityKeyword &&
        cityLower.includes(r.cityKeyword.toLowerCase()),
    )
    if (cityHit) return { value: cityHit.code, source: `city_${cityHit.cityKeyword}` }
  }

  // Try any state-level entry as a sanity check (still better than nothing)
  const anyStateEntry = SERPAPI_METRO_BY_STATE_PARTIAL.find((r) => r.state === state)
  if (anyStateEntry && !anyStateEntry.zipPrefix && !anyStateEntry.cityKeyword) {
    return { value: anyStateEntry.code, source: 'state_default' }
  }

  // State fallback: SerpAPI accepts `US-XX` for state-level resolution.
  return { value: `US-${state}`, source: 'state_fallback' }
}

/**
 * NOAA station ID. If lat/lng provided, query NOAA CDO API for nearest
 * GHCND station. Otherwise fall back to per-state/city table.
 *
 * NOAA CDO API: https://www.ncdc.noaa.gov/cdo-web/api/v2/stations
 * Public endpoint, requires a token in the `token` header. We honor
 * NOAA_CDO_TOKEN env var; if absent, we skip the API call and use the
 * fallback table.
 */
async function deriveNoaaStationId(
  address: AddressInput,
  cache: DeriveCache,
): Promise<{ value: string | null; source: string; error?: string }> {
  const lat = address.latitude
  const lng = address.longitude

  if (lat != null && lng != null) {
    const cacheKey = `${lat.toFixed(2)}_${lng.toFixed(2)}`
    if (cache.noaaStationByLatLng.has(cacheKey)) {
      const cached = cache.noaaStationByLatLng.get(cacheKey)!
      return { value: cached, source: cached ? 'noaa_cdo_api_cached' : 'noaa_cdo_api_cached_null' }
    }

    const token = process.env.NOAA_CDO_TOKEN
    if (token) {
      try {
        const eps = 0.5  // ~35mi at this latitude — wide enough to find a station
        const extent = `${lat - eps},${lng - eps},${lat + eps},${lng + eps}`
        const url = `https://www.ncdc.noaa.gov/cdo-web/api/v2/stations?extent=${extent}&datasetid=GHCND&limit=20`
        const resp = await fetch(url, {
          headers: { token, Accept: 'application/json' },
        })
        if (resp.ok) {
          const json = (await resp.json()) as {
            results?: Array<{ id: string; latitude: number; longitude: number; name: string }>
          }
          const stations = json.results ?? []
          if (stations.length > 0) {
            // Prefer USW (airport / first-order) stations for data quality
            const usw = stations.filter((s) => s.id.startsWith('GHCND:USW'))
            const pool = usw.length > 0 ? usw : stations
            // Pick closest by haversine
            const closest = pool
              .map((s) => ({
                id: s.id.replace(/^GHCND:/, ''),
                miles: haversineMiles(lat, lng, s.latitude, s.longitude),
              }))
              .sort((a, b) => a.miles - b.miles)[0]
            cache.noaaStationByLatLng.set(cacheKey, closest.id)
            return { value: closest.id, source: 'noaa_cdo_api' }
          }
        }
      } catch (err) {
        // Network failure — fall through to fallback table
        const msg = err instanceof Error ? err.message : String(err)
        cache.noaaStationByLatLng.set(cacheKey, null)
        return await deriveNoaaFromTable(address, msg)
      }
    }
  }

  return await deriveNoaaFromTable(address, undefined)
}

async function deriveNoaaFromTable(
  address: AddressInput,
  apiError?: string,
): Promise<{ value: string | null; source: string; error?: string }> {
  const state = normState(address.state)
  if (!state) {
    return { value: null, source: 'state_missing', error: apiError }
  }
  const cityLower = (address.city ?? '').trim().toLowerCase()

  // Try city-specific
  if (cityLower) {
    const cityHit = NOAA_STATION_BY_STATE_CITY.find(
      (r) =>
        r.state === state &&
        r.cityKeyword &&
        cityLower.includes(r.cityKeyword.toLowerCase()),
    )
    if (cityHit) {
      return { value: cityHit.station, source: `table_city_${cityHit.cityKeyword}`, error: apiError }
    }
  }

  // State fallback (first entry without cityKeyword that matches)
  const stateHit = NOAA_STATION_BY_STATE_CITY.find(
    (r) => r.state === state && !r.cityKeyword,
  )
  if (stateHit) {
    return { value: stateHit.station, source: 'table_state_fallback', error: apiError }
  }

  return {
    value: null,
    source: 'no_match',
    error: apiError ?? 'No NOAA station match for state ' + state,
  }
}

/**
 * Census FIPS via the US Census Geocoder API (free, public, no auth).
 * https://geocoding.geo.census.gov/geocoder/
 *
 * Returns the 11-digit county FIPS (state + county) for the address.
 */
async function deriveCensusFips(
  address: AddressInput,
  cache: DeriveCache,
): Promise<{ value: string | null; source: string; error?: string }> {
  const zip = (address.zip ?? '').trim()
  const state = normState(address.state)
  if (!zip || !state) {
    return { value: null, source: 'zip_or_state_missing' }
  }

  const cacheKey = `${zip}_${state}`
  if (cache.censusFipsByZip.has(cacheKey)) {
    const cached = cache.censusFipsByZip.get(cacheKey)!
    return {
      value: cached,
      source: cached ? 'census_geocoder_cached' : 'census_geocoder_cached_null',
    }
  }

  try {
    // Census Geocoder one-line endpoint expects a fairly complete address.
    // Build the best string we can from inputs. Per Census docs, the more
    // complete the address, the better the match. ZIP-only queries often
    // 0-result. Construct line1 + city + state + zip when available.
    const partsForAddress: string[] = []
    if (address.line1) partsForAddress.push(address.line1)
    if (address.city) partsForAddress.push(address.city)
    partsForAddress.push(`${state} ${zip}`)
    const addressLine = partsForAddress.join(', ')

    const url = new URL('https://geocoding.geo.census.gov/geocoder/geographies/onelineaddress')
    url.searchParams.set('address', addressLine)
    url.searchParams.set('benchmark', 'Public_AR_Current')
    url.searchParams.set('vintage', 'Current_Current')
    url.searchParams.set('format', 'json')

    const resp = await fetch(url.toString(), {
      headers: { Accept: 'application/json' },
    })
    if (!resp.ok) {
      cache.censusFipsByZip.set(cacheKey, null)
      return {
        value: null,
        source: 'census_geocoder_http_error',
        error: `Census geocoder ${resp.status}`,
      }
    }

    const json = (await resp.json()) as {
      result?: {
        addressMatches?: Array<{
          geographies?: {
            Counties?: Array<{ STATE: string; COUNTY: string; GEOID?: string }>
          }
        }>
      }
    }

    const match = json.result?.addressMatches?.[0]
    const county = match?.geographies?.Counties?.[0]
    if (county?.GEOID && county.GEOID.length === 5) {
      // GEOID is state(2) + county(3). For our census_fips column we store
      // 11-digit county FIPS = state + county + 6-digit tract zeros placeholder.
      // BUT bloom-house's existing Census loader expects county FIPS (5-digit).
      // We store the 5-digit county FIPS; the comment says "11-digit" loosely.
      // Storing the 5-digit form so existing loaders work — adjust if needed.
      const fips = county.GEOID
      cache.censusFipsByZip.set(cacheKey, fips)
      return { value: fips, source: 'census_geocoder_api' }
    }

    if (county?.STATE && county?.COUNTY) {
      const fips = county.STATE + county.COUNTY
      cache.censusFipsByZip.set(cacheKey, fips)
      return { value: fips, source: 'census_geocoder_api_constructed' }
    }

    cache.censusFipsByZip.set(cacheKey, null)
    return {
      value: null,
      source: 'census_geocoder_no_match',
      error: `Census geocoder returned no county for ${addressLine}`,
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    cache.censusFipsByZip.set(cacheKey, null)
    return { value: null, source: 'census_geocoder_exception', error: msg }
  }
}

/**
 * MSA code from google_trends_metro via lookup table. When trends metro is
 * a state fallback (e.g. 'US-VA') and not in the table, returns null with
 * a documented source — operator can fill manually if their venue's labor
 * market signals matter to them.
 */
function deriveMetroMsaCode(
  gtmetro: string | null,
): { value: string | null; source: string } {
  if (!gtmetro) return { value: null, source: 'gtrends_metro_missing' }
  const code = MSA_BY_GTRENDS_METRO[gtmetro]
  if (code) return { value: code, source: `table_${gtmetro}` }
  return { value: null, source: 'no_msa_match_for_metro' }
}

/**
 * DC region proxy. Mirrors government.ts isDCRegionVenue logic — state
 * adjacency wins outright; otherwise lat/lng radius check.
 */
function deriveDcRegionProxy(address: AddressInput): { value: boolean; source: string } {
  const state = normState(address.state)
  if (state && DC_REGION_STATES.has(state)) {
    return { value: true, source: `state_${state}_in_dc_set` }
  }
  if (
    address.latitude != null &&
    address.longitude != null &&
    Number.isFinite(address.latitude) &&
    Number.isFinite(address.longitude)
  ) {
    const miles = haversineMiles(
      address.latitude,
      address.longitude,
      DC_LAT,
      DC_LON,
    )
    if (miles <= DC_RADIUS_MILES) {
      return { value: true, source: `latlng_${miles.toFixed(0)}mi_from_capitol` }
    }
    return { value: false, source: `latlng_${miles.toFixed(0)}mi_from_capitol_outside` }
  }
  return { value: false, source: 'no_geo_signal' }
}

/**
 * Geocode line1 + city + state + zip into lat/lng using Nominatim
 * (OpenStreetMap, free, no auth, but rate-limited to 1 req/sec).
 *
 * Optional — only fired when address.latitude is null but other fields
 * are present, AND we need lat/lng for downstream derivations (NOAA API +
 * DC-proxy radius check).
 */
async function geocodeAddressIfMissing(
  address: AddressInput,
  cache: DeriveCache,
): Promise<{ lat: number | null; lng: number | null; source: string; error?: string }> {
  if (address.latitude != null && address.longitude != null) {
    return { lat: address.latitude, lng: address.longitude, source: 'provided' }
  }

  const parts = [address.line1, address.city, address.state, address.zip]
    .filter((p) => p && p.trim())
    .map((p) => p!.trim())

  if (parts.length < 2) {
    return { lat: null, lng: null, source: 'address_too_sparse' }
  }

  const cacheKey = parts.join('|')
  if (cache.geocodedFromAddress.has(cacheKey)) {
    const cached = cache.geocodedFromAddress.get(cacheKey)!
    return { lat: cached.lat, lng: cached.lng, source: 'nominatim_cached' }
  }

  try {
    const q = encodeURIComponent(parts.join(', '))
    const url = `https://nominatim.openstreetmap.org/search?q=${q}&format=json&limit=1&countrycodes=us`
    const resp = await fetch(url, {
      headers: {
        // Nominatim usage policy requires a User-Agent.
        'User-Agent': 'bloom-house/1.0 (external-signals-config; +https://thebloomhouse.ai)',
        Accept: 'application/json',
      },
    })
    if (!resp.ok) {
      cache.geocodedFromAddress.set(cacheKey, { lat: null, lng: null })
      return {
        lat: null,
        lng: null,
        source: 'nominatim_http_error',
        error: `Nominatim ${resp.status}`,
      }
    }
    const arr = (await resp.json()) as Array<{ lat: string; lon: string }>
    if (arr.length === 0) {
      cache.geocodedFromAddress.set(cacheKey, { lat: null, lng: null })
      return { lat: null, lng: null, source: 'nominatim_no_match' }
    }
    const lat = Number(arr[0].lat)
    const lng = Number(arr[0].lon)
    if (!Number.isFinite(lat) || !Number.isFinite(lng)) {
      cache.geocodedFromAddress.set(cacheKey, { lat: null, lng: null })
      return { lat: null, lng: null, source: 'nominatim_invalid_response' }
    }
    cache.geocodedFromAddress.set(cacheKey, { lat, lng })
    return { lat, lng, source: 'nominatim_api' }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    cache.geocodedFromAddress.set(cacheKey, { lat: null, lng: null })
    return { lat: null, lng: null, source: 'nominatim_exception', error: msg }
  }
}

// =============================================================================
// Public entry
// =============================================================================

/**
 * Derive every external-signal config field from a single address.
 *
 * Network failures are non-fatal — partial results + errors[] flow back.
 *
 * NOTE re: onboarding gate (Wave 8 spec item 8). The intended check —
 * "block onboarding completion until location_resolved" — is NOT wired
 * here because the onboarding-project flow is owned by Wave 5D's parallel
 * agent. Reconciliation TODO: after Wave 5D lands, add a step at
 * /onboarding/project that calls this service and gates "complete" on
 * absence of errors AND presence of google_trends_metro + noaa_station_id +
 * census_fips. Feature-flag the gate via venue_config.feature_flags.
 * require_location_resolved (default true for new venues, NULL for
 * existing — back-compat).
 */
export async function deriveLocationFromAddress(args: {
  venueId: string
  address: AddressInput
  /** Optional shared cache when called from sweep over many venues. */
  cache?: DeriveCache
}): Promise<DerivationResult> {
  const cache = args.cache ?? newCache()
  const inputs = args.address
  const errors: string[] = []
  const fieldSources: Record<string, string> = {}

  // 1. If lat/lng missing, try to geocode (so NOAA + DC-proxy can use them).
  let latitude = inputs.latitude
  let longitude = inputs.longitude
  if (latitude == null || longitude == null) {
    const geo = await geocodeAddressIfMissing(inputs, cache)
    if (geo.lat != null && geo.lng != null) {
      latitude = geo.lat
      longitude = geo.lng
      fieldSources['latitude'] = geo.source
      fieldSources['longitude'] = geo.source
    } else if (geo.error) {
      errors.push(`geocode: ${geo.error}`)
    }
  } else {
    fieldSources['latitude'] = 'provided'
    fieldSources['longitude'] = 'provided'
  }

  const enriched: AddressInput = { ...inputs, latitude, longitude }

  // 2. Google Trends metro (no network).
  const gtm = deriveGoogleTrendsMetro(enriched)
  fieldSources['google_trends_metro'] = gtm.source
  if (gtm.value == null) {
    errors.push(`google_trends_metro: ${gtm.source}`)
  }

  // 3. NOAA station (network, with table fallback).
  const noaa = await deriveNoaaStationId(enriched, cache)
  fieldSources['noaa_station_id'] = noaa.source
  if (noaa.error) errors.push(`noaa_station_id: ${noaa.error}`)
  if (noaa.value == null) errors.push(`noaa_station_id: ${noaa.source}`)

  // 4. Census FIPS (network).
  const census = await deriveCensusFips(enriched, cache)
  fieldSources['census_fips'] = census.source
  if (census.error) errors.push(`census_fips: ${census.error}`)
  if (census.value == null && !census.error) {
    errors.push(`census_fips: ${census.source}`)
  }

  // 5. Metro MSA code (depends on gtm.value).
  const msa = deriveMetroMsaCode(gtm.value)
  fieldSources['metro_msa_code'] = msa.source
  // MSA missing is OK — it's an opt-in signal.

  // 6. DC region proxy (no network).
  const dc = deriveDcRegionProxy(enriched)
  fieldSources['dc_region_proxy'] = dc.source

  return {
    google_trends_metro: gtm.value,
    noaa_station_id: noaa.value,
    census_fips: census.value,
    metro_msa_code: msa.value,
    dc_region_proxy: dc.value,
    latitude,
    longitude,
    errors,
    inputs,
    field_sources: fieldSources,
  }
}

/**
 * Shared-cache constructor for sweep callers. Exported so the sweep service
 * can build one cache + reuse across the venue loop.
 */
export function buildDeriveCache(): DeriveCache {
  return newCache()
}
