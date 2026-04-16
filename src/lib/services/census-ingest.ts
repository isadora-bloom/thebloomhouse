/**
 * Bloom House: Census Data Ingestion Service
 *
 * Fetches and stores US Census Bureau ACS (American Community Survey) data
 * into the market_intelligence table. Provides demographic context for
 * wedding market analysis.
 *
 * Data source: Census ACS 5-Year Estimates
 * API docs: https://www.census.gov/data/developers/data-sets/acs-5year.html
 */

import { createServiceClient } from '@/lib/supabase/service'

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface CensusData {
  state_fips: string
  county_fips: string
  population: number
  median_household_income: number
  median_age: number
  age_18_34_pct: number
  bachelors_or_higher_pct: number
}

interface CensusAPIRow {
  // Census API returns arrays of string values
  [index: number]: string
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

// ACS variable codes
const CENSUS_VARIABLES = {
  population: 'B01003_001E',           // Total population
  median_income: 'B19013_001E',         // Median household income
  median_age: 'B01002_001E',            // Median age
  total_18_plus: 'B01001_007E',         // For age calculations (placeholder)
  bachelors_total: 'B15003_022E',       // Bachelor's degree
  pop_25_plus: 'B15003_001E',           // Population 25+ (for education %)
  age_18_34_male: 'B01001_007E',        // Male 18-19 (start of range)
  age_18_34_female: 'B01001_031E',      // Female 18-19 (start of range)
}

// ---------------------------------------------------------------------------
// Ingest Functions
// ---------------------------------------------------------------------------

/**
 * Ingests pre-processed Census data into market_intelligence.
 * Use this when you already have the data (e.g., from a manual download
 * or batch processing).
 */
export async function ingestCensusData(
  regionKey: string,
  data: CensusData,
  options?: { regionName?: string; regionType?: 'state' | 'metro' | 'county' }
): Promise<void> {
  const supabase = createServiceClient()
  const dataYear = new Date().getFullYear()

  // Determine region info
  const regionType = options?.regionType || (data.county_fips ? 'county' : 'state')
  const regionName = options?.regionName || regionKey

  const { error } = await supabase
    .from('market_intelligence')
    .upsert({
      region_key: regionKey,
      region_type: regionType,
      region_name: regionName,
      population: data.population,
      median_household_income: data.median_household_income,
      median_age: data.median_age,
      data_year: dataYear,
      source: 'census_acs',
      updated_at: new Date().toISOString(),
    }, {
      onConflict: 'region_key,data_year',
    })

  if (error) {
    console.error(`[census-ingest] Failed to upsert data for ${regionKey}:`, error.message)
    throw error
  }

  console.log(`[census-ingest] Upserted census data for ${regionKey} (${dataYear})`)
}

/**
 * Fetches Census ACS data from the API for a given state.
 * Returns parsed CensusData objects for each county in the state.
 *
 * TODO: Wire up real API calls. Currently structured for integration.
 * API key can be requested at: https://api.census.gov/data/key_signup.html
 * No key required for basic queries (rate limited).
 *
 * Example API call:
 *   GET https://api.census.gov/data/2023/acs/acs5
 *     ?get=B01003_001E,B19013_001E,B01002_001E
 *     &for=county:*
 *     &in=state:51
 *
 * Returns:
 *   [["B01003_001E","B19013_001E","B01002_001E","state","county"],
 *    ["36312","72484","38.1","51","003"], ...]
 */
export async function fetchCensusForState(
  stateFips: string,
  apiKey?: string
): Promise<CensusData[]> {
  const variables = [
    CENSUS_VARIABLES.population,
    CENSUS_VARIABLES.median_income,
    CENSUS_VARIABLES.median_age,
  ].join(',')

  const url = new URL(CENSUS_BASE_URL)
  url.searchParams.set('get', variables)
  url.searchParams.set('for', 'county:*')
  url.searchParams.set('in', `state:${stateFips}`)
  if (apiKey) {
    url.searchParams.set('key', apiKey)
  }

  // TODO: Uncomment when ready to make real API calls
  // const response = await fetch(url.toString())
  // if (!response.ok) {
  //   throw new Error(`Census API error: ${response.status} ${response.statusText}`)
  // }
  // const json: string[][] = await response.json()
  //
  // // First row is headers, remaining rows are data
  // const [headers, ...rows] = json
  // return rows.map(row => ({
  //   state_fips: row[headers.indexOf('state')],
  //   county_fips: row[headers.indexOf('county')],
  //   population: parseInt(row[headers.indexOf(CENSUS_VARIABLES.population)]) || 0,
  //   median_household_income: parseInt(row[headers.indexOf(CENSUS_VARIABLES.median_income)]) || 0,
  //   median_age: parseFloat(row[headers.indexOf(CENSUS_VARIABLES.median_age)]) || 0,
  //   age_18_34_pct: 0,        // TODO: Calculate from age breakdowns
  //   bachelors_or_higher_pct: 0, // TODO: Calculate from education variables
  // }))

  console.log(`[census-ingest] fetchCensusForState(${stateFips}) — TODO: wire real API call`)
  console.log(`[census-ingest] URL would be: ${url.toString()}`)
  return []
}

/**
 * Full pipeline: fetch Census data for a state and ingest into market_intelligence.
 * Aggregates county data into metro regions where applicable.
 */
export async function refreshCensusForState(
  stateFips: string,
  apiKey?: string
): Promise<{ ingested: number; errors: number }> {
  let ingested = 0
  let errors = 0

  try {
    const countyData = await fetchCensusForState(stateFips, apiKey)

    if (countyData.length === 0) {
      console.log(`[census-ingest] No data returned for state ${stateFips}`)
      return { ingested: 0, errors: 0 }
    }

    // Aggregate state-level totals
    const stateInfo = STATE_FIPS_TO_REGION[stateFips]
    if (stateInfo) {
      const statePop = countyData.reduce((s, d) => s + d.population, 0)
      const avgIncome = Math.round(
        countyData.reduce((s, d) => s + d.median_household_income, 0) / countyData.length
      )
      const avgAge = Math.round(
        (countyData.reduce((s, d) => s + d.median_age, 0) / countyData.length) * 10
      ) / 10

      try {
        await ingestCensusData(stateInfo.key, {
          state_fips: stateFips,
          county_fips: '',
          population: statePop,
          median_household_income: avgIncome,
          median_age: avgAge,
          age_18_34_pct: 0,
          bachelors_or_higher_pct: 0,
        }, { regionName: stateInfo.name, regionType: 'state' })
        ingested++
      } catch {
        errors++
      }
    }

    // Aggregate metro-level data from counties
    const metroAggregates = new Map<string, CensusData[]>()
    for (const county of countyData) {
      const metroKey = `${county.state_fips}-${county.county_fips}`
      const metro = COUNTY_TO_METRO[metroKey]
      if (metro) {
        const existing = metroAggregates.get(metro.key) || []
        existing.push(county)
        metroAggregates.set(metro.key, existing)
      }
    }

    for (const [metroRegionKey, counties] of metroAggregates) {
      const metroPop = counties.reduce((s, d) => s + d.population, 0)
      const metroIncome = Math.round(
        counties.reduce((s, d) => s + d.median_household_income, 0) / counties.length
      )
      const metroAge = Math.round(
        (counties.reduce((s, d) => s + d.median_age, 0) / counties.length) * 10
      ) / 10

      const metroInfo = COUNTY_TO_METRO[`${counties[0].state_fips}-${counties[0].county_fips}`]

      try {
        await ingestCensusData(metroRegionKey, {
          state_fips: counties[0].state_fips,
          county_fips: '',
          population: metroPop,
          median_household_income: metroIncome,
          median_age: metroAge,
          age_18_34_pct: 0,
          bachelors_or_higher_pct: 0,
        }, { regionName: metroInfo?.name || metroRegionKey, regionType: 'metro' })
        ingested++
      } catch {
        errors++
      }
    }
  } catch (err) {
    console.error(`[census-ingest] refreshCensusForState failed:`, err)
    errors++
  }

  return { ingested, errors }
}

/**
 * Refresh Census data for all tracked states.
 * Called by cron job (monthly check for annual data updates).
 */
export async function refreshAllCensusData(apiKey?: string): Promise<{
  total_ingested: number
  total_errors: number
  states_processed: number
}> {
  let totalIngested = 0
  let totalErrors = 0
  let statesProcessed = 0

  for (const stateFips of Object.keys(STATE_FIPS_TO_REGION)) {
    const result = await refreshCensusForState(stateFips, apiKey)
    totalIngested += result.ingested
    totalErrors += result.errors
    statesProcessed++
  }

  console.log(
    `[census-ingest] Completed: ${statesProcessed} states, ${totalIngested} regions ingested, ${totalErrors} errors`
  )

  return {
    total_ingested: totalIngested,
    total_errors: totalErrors,
    states_processed: statesProcessed,
  }
}
