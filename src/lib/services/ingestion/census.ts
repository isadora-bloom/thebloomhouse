/**
 * Bloom House: Census Data Ingestion Service
 *
 * Fetches and stores US Census Bureau ACS (American Community Survey) data
 * into the market_intelligence table. Provides demographic context for
 * wedding market analysis.
 *
 * Data source: Census ACS 5-Year Estimates
 * API docs: https://www.census.gov/data/developers/data-sets/acs-5year.html
 *
 * Non-US venues: market-context.ts resolves regions in a metro -> state -> 'US'
 * fallback chain. A venue with no state (e.g. a UK cottage) will miss the metro
 * and state lookups and land on the 'US' national rollup this job produces.
 * That's intentional: we'd rather hand a non-US venue the US baseline than
 * nothing. If we ever seed non-US regions, we can point their venues at those
 * region_keys via state + METRO_MAPPING in market-context.ts.
 */

import { createServiceClient } from '@/lib/supabase/service'

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface CensusData {
  state_fips: string
  county_fips: string
  county_name?: string
  population: number
  median_household_income: number
  median_age: number
  age_18_34_count: number
  pop_25_plus: number
  bachelors_or_higher_count: number
  age_18_34_pct: number | null
  bachelors_or_higher_pct: number | null
}

// ---------------------------------------------------------------------------
// FIPS-to-region mapping
// ---------------------------------------------------------------------------

/**
 * Maps state FIPS codes to region keys used in market_intelligence.
 * Extend as new states/regions are onboarded.
 */
const STATE_FIPS_TO_REGION: Record<string, { key: string; name: string }> = {
  '51': { key: 'VA', name: 'Virginia' },
  '24': { key: 'MD', name: 'Maryland' },
  '11': { key: 'DC', name: 'District of Columbia' },
  '37': { key: 'NC', name: 'North Carolina' },
  '42': { key: 'PA', name: 'Pennsylvania' },
  '36': { key: 'NY', name: 'New York' },
  '06': { key: 'CA', name: 'California' },
  '48': { key: 'TX', name: 'Texas' },
  '12': { key: 'FL', name: 'Florida' },
  '17': { key: 'IL', name: 'Illinois' },
  '13': { key: 'GA', name: 'Georgia' },
  '25': { key: 'MA', name: 'Massachusetts' },
  '34': { key: 'NJ', name: 'New Jersey' },
  '53': { key: 'WA', name: 'Washington' },
  '08': { key: 'CO', name: 'Colorado' },
}

/**
 * County FIPS to metro region key mapping for known metro areas.
 * Format: "STATE_FIPS-COUNTY_FIPS" -> region info
 */
const COUNTY_TO_METRO: Record<string, { key: string; name: string }> = {
  // Virginia - Charlottesville metro
  '51-003': { key: 'VA-Charlottesville', name: 'Charlottesville, VA' }, // Albemarle
  '51-540': { key: 'VA-Charlottesville', name: 'Charlottesville, VA' }, // Charlottesville city
  '51-065': { key: 'VA-Charlottesville', name: 'Charlottesville, VA' }, // Fluvanna
  '51-079': { key: 'VA-Charlottesville', name: 'Charlottesville, VA' }, // Greene
  '51-109': { key: 'VA-Charlottesville', name: 'Charlottesville, VA' }, // Louisa
  '51-113': { key: 'VA-Charlottesville', name: 'Charlottesville, VA' }, // Madison
  // Virginia - Richmond metro
  '51-760': { key: 'VA-Richmond', name: 'Richmond, VA' },
  '51-087': { key: 'VA-Richmond', name: 'Richmond, VA' }, // Henrico
  '51-041': { key: 'VA-Richmond', name: 'Richmond, VA' }, // Chesterfield
  // Virginia - Northern VA / DC metro
  '51-059': { key: 'VA-NoVA', name: 'Northern Virginia' }, // Fairfax
  '51-013': { key: 'VA-NoVA', name: 'Northern Virginia' }, // Arlington
  '51-510': { key: 'VA-NoVA', name: 'Northern Virginia' }, // Alexandria
  '51-107': { key: 'VA-NoVA', name: 'Northern Virginia' }, // Loudoun
}

// ---------------------------------------------------------------------------
// Census API Constants
// ---------------------------------------------------------------------------

const CENSUS_BASE_URL = 'https://api.census.gov/data/2023/acs/acs5'
const DATA_YEAR = 2023

// ACS variable codes. We fetch these for every county query and roll them up
// to state + national. The age 18-34 buckets come in 6 male + 6 female brackets
// (B01001_007E..012E and B01001_031E..036E). Bachelors+ is 4 brackets
// (B15003_022E..025E: bachelors, masters, professional, doctorate).
const V = {
  population: 'B01003_001E',
  median_income: 'B19013_001E',
  median_age: 'B01002_001E',
  pop_25_plus: 'B15003_001E',
  // Male 18-34: B01001_007E (18-19), 008 (20), 009 (21), 010 (22-24), 011 (25-29), 012 (30-34)
  male_18_19: 'B01001_007E',
  male_20: 'B01001_008E',
  male_21: 'B01001_009E',
  male_22_24: 'B01001_010E',
  male_25_29: 'B01001_011E',
  male_30_34: 'B01001_012E',
  // Female 18-34: B01001_031E..036E (same brackets)
  female_18_19: 'B01001_031E',
  female_20: 'B01001_032E',
  female_21: 'B01001_033E',
  female_22_24: 'B01001_034E',
  female_25_29: 'B01001_035E',
  female_30_34: 'B01001_036E',
  // Educational attainment: bachelors, masters, professional, doctorate
  edu_bachelors: 'B15003_022E',
  edu_masters: 'B15003_023E',
  edu_professional: 'B15003_024E',
  edu_doctorate: 'B15003_025E',
} as const

// Stable order we send to the API so we can index back by name.
const CENSUS_VAR_LIST: readonly string[] = Object.values(V)

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

function toInt(v: string | undefined | null): number {
  if (v === null || v === undefined || v === '') return 0
  const n = parseInt(v, 10)
  // Census returns negative sentinels (-666666666 etc.) for suppressed values.
  if (!Number.isFinite(n) || n < 0) return 0
  return n
}

function toFloat(v: string | undefined | null): number {
  if (v === null || v === undefined || v === '') return 0
  const n = parseFloat(v)
  if (!Number.isFinite(n) || n < 0) return 0
  return n
}

function safePct(numerator: number, denominator: number): number | null {
  if (denominator <= 0) return null
  return Math.round((numerator / denominator) * 1000) / 10 // 1 decimal, 0-100
}

// ---------------------------------------------------------------------------
// Ingest Functions
// ---------------------------------------------------------------------------

/**
 * Low-level upsert into market_intelligence. Used by the state + national
 * rollups below. Keeps payload shape in one place.
 */
async function upsertRegion(row: {
  region_key: string
  region_type: 'national' | 'state' | 'metro' | 'county'
  region_name: string
  population: number | null
  median_household_income: number | null
  median_age: number | null
  age_18_34_pct: number | null
  bachelors_or_higher_pct: number | null
}): Promise<boolean> {
  const supabase = createServiceClient()
  const { error } = await supabase
    .from('market_intelligence')
    .upsert(
      {
        region_key: row.region_key,
        region_type: row.region_type,
        region_name: row.region_name,
        population: row.population,
        median_household_income: row.median_household_income,
        median_age: row.median_age,
        age_18_34_pct: row.age_18_34_pct,
        bachelors_or_higher_pct: row.bachelors_or_higher_pct,
        data_year: DATA_YEAR,
        source: 'census_acs5',
        updated_at: new Date().toISOString(),
      },
      { onConflict: 'region_key,data_year' }
    )

  if (error) {
    console.error(`[census-ingest] upsert failed for ${row.region_key}:`, error.message)
    return false
  }
  return true
}

/**
 * Fetches Census ACS data from the API for a given state.
 * Returns parsed CensusData objects for each county in the state.
 *
 * Never throws: on network / parse failure, logs and returns an empty array
 * so the cron keeps moving.
 *
 * API key can be requested at: https://api.census.gov/data/key_signup.html
 * No key required for basic queries (rate limited).
 *
 * Example API call:
 *   GET https://api.census.gov/data/2023/acs/acs5
 *     ?get=B01003_001E,B19013_001E,...
 *     &for=county:*
 *     &in=state:51
 */
export async function fetchCensusForState(
  stateFips: string,
  apiKey?: string
): Promise<CensusData[]> {
  const url = new URL(CENSUS_BASE_URL)
  url.searchParams.set('get', ['NAME', ...CENSUS_VAR_LIST].join(','))
  url.searchParams.set('for', 'county:*')
  url.searchParams.set('in', `state:${stateFips}`)
  if (apiKey) {
    url.searchParams.set('key', apiKey)
  }

  try {
    const response = await fetch(url.toString())
    if (!response.ok) {
      console.error(
        `[census-ingest] Census API error for state ${stateFips}: ${response.status} ${response.statusText}`
      )
      return []
    }
    const json = (await response.json()) as string[][]
    if (!Array.isArray(json) || json.length < 2) {
      console.warn(`[census-ingest] Empty or malformed Census response for state ${stateFips}`)
      return []
    }

    const [headers, ...rows] = json
    const idx = (name: string) => headers.indexOf(name)

    // Cache indexes up front
    const iName = idx('NAME')
    const iState = idx('state')
    const iCounty = idx('county')
    const iPop = idx(V.population)
    const iIncome = idx(V.median_income)
    const iAge = idx(V.median_age)
    const iPop25 = idx(V.pop_25_plus)

    const ageMaleIdx = [
      idx(V.male_18_19),
      idx(V.male_20),
      idx(V.male_21),
      idx(V.male_22_24),
      idx(V.male_25_29),
      idx(V.male_30_34),
    ]
    const ageFemaleIdx = [
      idx(V.female_18_19),
      idx(V.female_20),
      idx(V.female_21),
      idx(V.female_22_24),
      idx(V.female_25_29),
      idx(V.female_30_34),
    ]
    const eduIdx = [
      idx(V.edu_bachelors),
      idx(V.edu_masters),
      idx(V.edu_professional),
      idx(V.edu_doctorate),
    ]

    const out: CensusData[] = []
    for (const row of rows) {
      const population = toInt(row[iPop])
      const pop25Plus = toInt(row[iPop25])
      const age1834Count =
        ageMaleIdx.reduce((s, i) => s + toInt(row[i]), 0) +
        ageFemaleIdx.reduce((s, i) => s + toInt(row[i]), 0)
      const bachelorsCount = eduIdx.reduce((s, i) => s + toInt(row[i]), 0)

      out.push({
        state_fips: row[iState],
        county_fips: row[iCounty],
        county_name: row[iName],
        population,
        median_household_income: toInt(row[iIncome]),
        median_age: toFloat(row[iAge]),
        age_18_34_count: age1834Count,
        pop_25_plus: pop25Plus,
        bachelors_or_higher_count: bachelorsCount,
        age_18_34_pct: safePct(age1834Count, population),
        bachelors_or_higher_pct: safePct(bachelorsCount, pop25Plus),
      })
    }
    return out
  } catch (err) {
    console.error(`[census-ingest] fetchCensusForState(${stateFips}) threw:`, err)
    return []
  }
}

/**
 * Ingests pre-processed Census data into market_intelligence.
 * Use this when you already have the data (e.g., from a manual download
 * or batch processing).
 *
 * Kept for backwards compatibility with any external callers.
 */
export async function ingestCensusData(
  regionKey: string,
  data: CensusData,
  options?: { regionName?: string; regionType?: 'state' | 'metro' | 'county' }
): Promise<void> {
  const regionType = options?.regionType || (data.county_fips ? 'county' : 'state')
  const regionName = options?.regionName || regionKey

  const ok = await upsertRegion({
    region_key: regionKey,
    region_type: regionType,
    region_name: regionName,
    population: data.population || null,
    median_household_income: data.median_household_income || null,
    median_age: data.median_age || null,
    age_18_34_pct: data.age_18_34_pct,
    bachelors_or_higher_pct: data.bachelors_or_higher_pct,
  })

  if (ok) {
    console.log(`[census-ingest] Upserted census data for ${regionKey} (${DATA_YEAR})`)
  }
}

// ---------------------------------------------------------------------------
// Rollups
// ---------------------------------------------------------------------------

interface RollupAccum {
  population: number
  incomeWeighted: number      // sum(median_income * population)
  incomeWeightSum: number     // sum(population where income > 0)
  ageWeighted: number         // sum(median_age * population)
  ageWeightSum: number        // sum(population where age > 0)
  age1834Count: number
  pop25Plus: number
  bachelorsCount: number
}

function emptyAccum(): RollupAccum {
  return {
    population: 0,
    incomeWeighted: 0,
    incomeWeightSum: 0,
    ageWeighted: 0,
    ageWeightSum: 0,
    age1834Count: 0,
    pop25Plus: 0,
    bachelorsCount: 0,
  }
}

function accumulate(acc: RollupAccum, c: CensusData): void {
  acc.population += c.population
  if (c.median_household_income > 0 && c.population > 0) {
    acc.incomeWeighted += c.median_household_income * c.population
    acc.incomeWeightSum += c.population
  }
  if (c.median_age > 0 && c.population > 0) {
    acc.ageWeighted += c.median_age * c.population
    acc.ageWeightSum += c.population
  }
  acc.age1834Count += c.age_18_34_count
  acc.pop25Plus += c.pop_25_plus
  acc.bachelorsCount += c.bachelors_or_higher_count
}

function finalize(acc: RollupAccum): {
  population: number | null
  median_household_income: number | null
  median_age: number | null
  age_18_34_pct: number | null
  bachelors_or_higher_pct: number | null
} {
  const popWeightedIncome =
    acc.incomeWeightSum > 0 ? Math.round(acc.incomeWeighted / acc.incomeWeightSum) : null
  const popWeightedAge =
    acc.ageWeightSum > 0
      ? Math.round((acc.ageWeighted / acc.ageWeightSum) * 10) / 10
      : null

  return {
    population: acc.population > 0 ? acc.population : null,
    median_household_income: popWeightedIncome,
    median_age: popWeightedAge,
    age_18_34_pct: safePct(acc.age1834Count, acc.population),
    bachelors_or_higher_pct: safePct(acc.bachelorsCount, acc.pop25Plus),
  }
}

/**
 * Refresh Census data for all tracked states.
 * Called by cron job (monthly check for annual data updates).
 *
 * For each state:
 *   - pull county-level rows via the ACS5 API
 *   - roll up to a single state row (pop-weighted income/age, summed counts)
 *   - upsert market_intelligence with region_type='state'
 *
 * After all states are fetched, roll the same accumulators into a single
 * national 'US' row with region_type='national'. This is the final fallback
 * for any venue (including non-US venues whose state lookup misses).
 *
 * Never throws: per-state errors are caught and logged so one bad request
 * doesn't kill the cron.
 */
export async function refreshAllCensusData(
  apiKey?: string
): Promise<{ statesFetched: number; rowsWritten: number }> {
  const key = apiKey ?? process.env.CENSUS_API_KEY

  let statesFetched = 0
  let rowsWritten = 0
  const national = emptyAccum()

  for (const [fips, info] of Object.entries(STATE_FIPS_TO_REGION)) {
    try {
      const counties = await fetchCensusForState(fips, key)
      if (counties.length === 0) {
        console.warn(`[census-ingest] No county data for state ${fips} (${info.key})`)
        continue
      }
      statesFetched++

      const stateAcc = emptyAccum()
      for (const c of counties) {
        accumulate(stateAcc, c)
        accumulate(national, c)
      }

      const stateFinal = finalize(stateAcc)
      const ok = await upsertRegion({
        region_key: info.key,
        region_type: 'state',
        region_name: info.name,
        ...stateFinal,
      })
      if (ok) rowsWritten++
    } catch (err) {
      // fetchCensusForState already swallows, but belt+braces in case
      // rollup/upsert throws on a weird payload.
      console.error(`[census-ingest] state ${fips} rollup failed:`, err)
    }
  }

  // National rollup — only write if we got at least one state's worth of data
  if (statesFetched > 0) {
    const usFinal = finalize(national)
    const ok = await upsertRegion({
      region_key: 'US',
      region_type: 'national',
      region_name: 'United States',
      ...usFinal,
    })
    if (ok) rowsWritten++
  }

  console.log(
    `[census-ingest] Completed: ${statesFetched} states fetched, ${rowsWritten} rows written`
  )
  return { statesFetched, rowsWritten }
}

// ---------------------------------------------------------------------------
// Legacy single-state refresh (metro aggregation — kept for ad-hoc use)
// ---------------------------------------------------------------------------

/**
 * Full pipeline for a single state: fetch, roll up metros if mapped, upsert.
 * Not called by the cron (refreshAllCensusData is the cron entry), but handy
 * for one-off backfills via a script or API route.
 */
export async function refreshCensusForState(
  stateFips: string,
  apiKey?: string
): Promise<{ ingested: number; errors: number }> {
  let ingested = 0
  let errors = 0

  const counties = await fetchCensusForState(stateFips, apiKey)
  if (counties.length === 0) return { ingested: 0, errors: 0 }

  // State rollup
  const stateInfo = STATE_FIPS_TO_REGION[stateFips]
  if (stateInfo) {
    const acc = emptyAccum()
    for (const c of counties) accumulate(acc, c)
    const final = finalize(acc)
    const ok = await upsertRegion({
      region_key: stateInfo.key,
      region_type: 'state',
      region_name: stateInfo.name,
      ...final,
    })
    if (ok) ingested++
    else errors++
  }

  // Metro rollups
  const metroAccs = new Map<string, { acc: RollupAccum; name: string }>()
  for (const c of counties) {
    const metro = COUNTY_TO_METRO[`${c.state_fips}-${c.county_fips}`]
    if (!metro) continue
    const bucket = metroAccs.get(metro.key) ?? { acc: emptyAccum(), name: metro.name }
    accumulate(bucket.acc, c)
    metroAccs.set(metro.key, bucket)
  }

  for (const [metroKey, { acc, name }] of metroAccs) {
    const final = finalize(acc)
    const ok = await upsertRegion({
      region_key: metroKey,
      region_type: 'metro',
      region_name: name,
      ...final,
    })
    if (ok) ingested++
    else errors++
  }

  return { ingested, errors }
}
