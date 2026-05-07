/**
 * Bloom House: Weather Service
 *
 * Fetches historical weather data from NOAA CDO API and 14-day forecasts
 * from Open-Meteo. Stores everything in the weather_data table so the
 * intelligence layer can score wedding dates and surface weather insights.
 *
 * NOAA CDO: monthly summaries (GSOM), requires NOAA_CDO_TOKEN env var
 * Open-Meteo: 14-day daily forecast, free / no key
 */

import { createServiceClient } from '@/lib/supabase/service'

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface WeatherRecord {
  id?: string
  venue_id: string
  date: string
  high_temp: number | null
  low_temp: number | null
  precipitation: number | null
  conditions: string | null
  source: string
}

interface NOAADataPoint {
  date: string
  datatype: string
  value: number
  station: string
}

interface OpenMeteoDaily {
  time: string[]
  temperature_2m_max: number[]
  temperature_2m_min: number[]
  precipitation_sum: number[]
  weathercode: number[]
}

// ---------------------------------------------------------------------------
// Conversion helpers
// ---------------------------------------------------------------------------

/** NOAA GSOM temps come in tenths of °C when units=metric. With units=standard they're °F. */
function celsiusToFahrenheit(c: number): number {
  return Math.round(((c * 9) / 5 + 32) * 10) / 10
}

function mmToInches(mm: number): number {
  return Math.round((mm / 25.4) * 100) / 100
}

/**
 * WMO weather code → human-readable condition string.
 * https://open-meteo.com/en/docs (weathercode table)
 */
function weatherCodeToCondition(code: number): string {
  if (code === 0) return 'Clear sky'
  if (code <= 3) return 'Partly cloudy'
  if (code <= 49) return 'Fog'
  if (code <= 59) return 'Drizzle'
  if (code <= 69) return 'Rain'
  if (code <= 79) return 'Snow'
  if (code <= 84) return 'Rain showers'
  if (code <= 86) return 'Snow showers'
  if (code >= 95) return 'Thunderstorm'
  return 'Unknown'
}

// ---------------------------------------------------------------------------
// Throttle helper for NOAA (max 4 req/sec → 250ms gap)
// ---------------------------------------------------------------------------

let lastNoaaRequest = 0

async function throttleNoaa(): Promise<void> {
  const now = Date.now()
  const elapsed = now - lastNoaaRequest
  if (elapsed < 250) {
    await new Promise((resolve) => setTimeout(resolve, 250 - elapsed))
  }
  lastNoaaRequest = Date.now()
}

// ---------------------------------------------------------------------------
// Venue lookup helper
// ---------------------------------------------------------------------------

async function getVenue(venueId: string) {
  const supabase = createServiceClient()
  const { data, error } = await supabase
    .from('venues')
    .select('id, noaa_station_id, latitude, longitude')
    .eq('id', venueId)
    .single()

  if (error || !data) {
    throw new Error(`Venue not found: ${venueId}`)
  }
  return data
}

// ---------------------------------------------------------------------------
// 1. fetchHistoricalWeather — NOAA CDO monthly summaries (GSOM)
// ---------------------------------------------------------------------------

export async function fetchHistoricalWeather(
  venueId: string,
  startDate: string,
  endDate: string
): Promise<WeatherRecord[]> {
  const token = process.env.NOAA_CDO_TOKEN
  if (!token) {
    console.warn('[weather] NOAA_CDO_TOKEN not set — skipping historical fetch')
    return []
  }

  const venue = await getVenue(venueId)
  if (!venue.noaa_station_id) {
    console.warn(`[weather] Venue ${venueId} has no NOAA station ID — skipping`)
    return []
  }

  const stationId = venue.noaa_station_id.startsWith('GHCND:')
    ? venue.noaa_station_id
    : `GHCND:${venue.noaa_station_id}`

  // NOAA CDO limits to 1 year per request — chunk if needed
  const chunks = chunkDateRange(startDate, endDate)
  const allPoints: NOAADataPoint[] = []

  for (const chunk of chunks) {
    await throttleNoaa()

    const url = new URL('https://www.ncdc.noaa.gov/cdo-web/api/v2/data')
    url.searchParams.set('datasetid', 'GSOM')
    url.searchParams.set('stationid', stationId)
    url.searchParams.set('startdate', chunk.start)
    url.searchParams.set('enddate', chunk.end)
    url.searchParams.set('units', 'standard')
    url.searchParams.set('limit', '1000')

    const res = await fetch(url.toString(), {
      headers: { token },
    })

    if (!res.ok) {
      console.error(`[weather] NOAA CDO error ${res.status}: ${await res.text()}`)
      continue
    }

    const json = await res.json()
    if (json.results) {
      allPoints.push(...(json.results as NOAADataPoint[]))
    }
  }

  // Group by date (GSOM returns one row per datatype per month)
  const byDate = new Map<
    string,
    { high: number | null; low: number | null; precip: number | null }
  >()

  for (const point of allPoints) {
    // NOAA dates come as "YYYY-MM-DDT00:00:00" — take the date part
    const date = point.date.substring(0, 10)
    if (!byDate.has(date)) {
      byDate.set(date, { high: null, low: null, precip: null })
    }
    const entry = byDate.get(date)!

    // With units=standard, temps are already in °F, precip in inches
    switch (point.datatype) {
      case 'TMAX':
        entry.high = point.value
        break
      case 'TMIN':
        entry.low = point.value
        break
      case 'PRCP':
        entry.precip = point.value
        break
    }
  }

  // Build records and upsert
  const records: WeatherRecord[] = []
  for (const [date, vals] of byDate) {
    records.push({
      venue_id: venueId,
      date,
      high_temp: vals.high,
      low_temp: vals.low,
      precipitation: vals.precip,
      conditions: null,
      source: 'noaa_cdo',
    })
  }

  if (records.length > 0) {
    await upsertWeatherRecords(records)
  }

  return records
}

/**
 * NOAA CDO limits queries to 1 year at a time.
 * Split a range into <=1-year chunks.
 */
function chunkDateRange(
  startDate: string,
  endDate: string
): { start: string; end: string }[] {
  const chunks: { start: string; end: string }[] = []
  let cursor = new Date(startDate)
  const end = new Date(endDate)

  while (cursor < end) {
    const chunkEnd = new Date(cursor)
    chunkEnd.setFullYear(chunkEnd.getFullYear() + 1)
    chunkEnd.setDate(chunkEnd.getDate() - 1)

    const actualEnd = chunkEnd > end ? end : chunkEnd

    chunks.push({
      start: cursor.toISOString().substring(0, 10),
      end: actualEnd.toISOString().substring(0, 10),
    })

    cursor = new Date(actualEnd)
    cursor.setDate(cursor.getDate() + 1)
  }

  return chunks
}

// ---------------------------------------------------------------------------
// 2. fetchWeatherForecast — Open-Meteo 14-day daily forecast
// ---------------------------------------------------------------------------

export async function fetchWeatherForecast(
  venueId: string
): Promise<WeatherRecord[]> {
  const venue = await getVenue(venueId)

  if (!venue.latitude || !venue.longitude) {
    console.warn(`[weather] Venue ${venueId} missing lat/lng — skipping forecast`)
    return []
  }

  const url = new URL('https://api.open-meteo.com/v1/forecast')
  url.searchParams.set('latitude', String(venue.latitude))
  url.searchParams.set('longitude', String(venue.longitude))
  url.searchParams.set('daily', 'temperature_2m_max,temperature_2m_min,precipitation_sum,weathercode')
  url.searchParams.set('timezone', 'America/New_York')
  url.searchParams.set('forecast_days', '14')

  const res = await fetch(url.toString())
  if (!res.ok) {
    console.error(`[weather] Open-Meteo error ${res.status}: ${await res.text()}`)
    return []
  }

  const json = await res.json()
  const daily: OpenMeteoDaily = json.daily

  if (!daily || !daily.time) {
    console.warn('[weather] Open-Meteo returned no daily data')
    return []
  }

  const records: WeatherRecord[] = daily.time.map((date, i) => ({
    venue_id: venueId,
    date,
    high_temp: daily.temperature_2m_max[i] != null
      ? celsiusToFahrenheit(daily.temperature_2m_max[i])
      : null,
    low_temp: daily.temperature_2m_min[i] != null
      ? celsiusToFahrenheit(daily.temperature_2m_min[i])
      : null,
    precipitation: daily.precipitation_sum[i] != null
      ? mmToInches(daily.precipitation_sum[i])
      : null,
    conditions: daily.weathercode[i] != null
      ? weatherCodeToCondition(daily.weathercode[i])
      : null,
    source: 'open_meteo',
  }))

  if (records.length > 0) {
    await upsertWeatherRecords(records)
  }

  return records
}

// ---------------------------------------------------------------------------
// 3. getWeatherForDateRange — read from weather_data
// ---------------------------------------------------------------------------

export async function getWeatherForDateRange(
  venueId: string,
  startDate: string,
  endDate: string
): Promise<WeatherRecord[]> {
  const supabase = createServiceClient()

  const { data, error } = await supabase
    .from('weather_data')
    .select('*')
    .eq('venue_id', venueId)
    .gte('date', startDate)
    .lte('date', endDate)
    .order('date', { ascending: true })

  if (error) {
    console.error('[weather] Error reading weather_data:', error.message)
    return []
  }

  return (data ?? []) as WeatherRecord[]
}

// ---------------------------------------------------------------------------
// 4. calculateWeatherScore — 0-10 (higher = worse wedding weather)
// ---------------------------------------------------------------------------

export function calculateWeatherScore(
  precipitation: number,
  highTemp: number,
  lowTemp: number
): number {
  let score = 0

  // Precipitation scoring
  if (precipitation > 3) {
    score += 6
  } else if (precipitation > 1.5) {
    score += 4
  } else if (precipitation > 0.5) {
    score += 2
  }

  // Extreme heat
  if (highTemp > 95) {
    score += 2
  }

  // Extreme cold
  if (lowTemp < 35) {
    score += 2
  }

  return Math.min(score, 10)
}

// ---------------------------------------------------------------------------
// Upsert helper
// ---------------------------------------------------------------------------

async function upsertWeatherRecords(records: WeatherRecord[]): Promise<void> {
  const supabase = createServiceClient()

  // Supabase upsert with onConflict on the unique constraint columns
  const { error } = await supabase
    .from('weather_data')
    .upsert(records, { onConflict: 'venue_id,date,source' })

  if (error) {
    console.error('[weather] Upsert error:', error.message)
  }
}
