/**
 * Weather climate-norms backfill (TIER 6+).
 *
 * Fetches 20 years of hourly archive data from Open-Meteo for the
 * venue's lat/lon, aggregates into month × hour cells with recent-
 * decade vs prior-decade trend comparison, and writes the result to
 * weather_climate_norms. Detects notable past weather events and
 * writes them to weather_anomaly_events with joined ops impact.
 *
 * Why Open-Meteo archive: free, no API key, ERA5 reanalysis back to
 * 1940, same provider as the forecast cron so coordinates already work.
 *
 * Cost: one fetch per venue per refresh. ~175k hourly rows in JSON
 * (~6-8MB). Aggregation in-memory. Annual cadence is more than enough;
 * climate norms do not move overnight. Operators can also manually
 * trigger a refresh from the UI.
 */

import { createServiceClient } from '@/lib/supabase/service'

const ARCHIVE_URL = 'https://archive-api.open-meteo.com/v1/archive'
const RECENT_YEARS = 10
const PRIOR_YEARS = 10

// Heuristic thresholds for anomaly detection. Calibrated for venue
// pricing + expectation-setting contexts, not meteorology research.
const COLD_SNAP_MAX_HIGH_F = 32 // freezing or below
const COLD_SNAP_MIN_DAYS = 5
const HEAT_WAVE_MIN_HIGH_F = 95
const HEAT_WAVE_MIN_DAYS = 3
const WET_STRETCH_MIN_DAILY_IN = 0.5
const WET_STRETCH_MIN_DAYS = 4
const SEVERE_STORM_MIN_PRECIP_IN = 2.0 // a single day with this much rain
const SNOW_EVENT_MIN_DAILY_IN = 4

interface ArchiveHourlyResponse {
  hourly?: {
    time: string[]
    temperature_2m: (number | null)[]
    precipitation: (number | null)[]
    snowfall?: (number | null)[]
  }
}

interface DailyAggregate {
  date: string
  highF: number
  lowF: number
  precipIn: number
  snowIn: number
}

function celsiusToFahrenheit(c: number): number {
  return (c * 9) / 5 + 32
}

function mmToInches(mm: number): number {
  return mm / 25.4
}

function cmToInches(cm: number): number {
  return cm / 2.54
}

interface BackfillResult {
  venueId: string
  refreshedAt: string
  climateRows: number
  anomalyRows: number
  recentWindow: { start: string; end: string }
  priorWindow: { start: string; end: string }
}

export async function backfillVenueClimateNorms(
  venueId: string,
): Promise<BackfillResult> {
  const supabase = createServiceClient()

  const { data: venue, error: vErr } = await supabase
    .from('venues')
    .select('latitude, longitude')
    .eq('id', venueId)
    .single()

  if (vErr || !venue) throw new Error(`Venue ${venueId} not found`)
  if (!venue.latitude || !venue.longitude) {
    throw new Error(`Venue ${venueId} missing lat/lon — set in venue settings first`)
  }

  const today = new Date()
  const recentEnd = new Date(today.getUTCFullYear() - 1, 11, 31) // last full year end
  const recentStart = new Date(recentEnd.getUTCFullYear() - RECENT_YEARS + 1, 0, 1)
  const priorEnd = new Date(recentStart.getUTCFullYear() - 1, 11, 31)
  const priorStart = new Date(priorEnd.getUTCFullYear() - PRIOR_YEARS + 1, 0, 1)

  const fmtDate = (d: Date) => d.toISOString().slice(0, 10)
  const fetchStart = fmtDate(priorStart)
  const fetchEnd = fmtDate(recentEnd)

  const url = new URL(ARCHIVE_URL)
  url.searchParams.set('latitude', String(venue.latitude))
  url.searchParams.set('longitude', String(venue.longitude))
  url.searchParams.set('start_date', fetchStart)
  url.searchParams.set('end_date', fetchEnd)
  url.searchParams.set('hourly', 'temperature_2m,precipitation,snowfall')
  url.searchParams.set('temperature_unit', 'fahrenheit')
  url.searchParams.set('precipitation_unit', 'inch')
  // timezone=auto: Open-Meteo derives the venue's local timezone from
  // lat/lon. Hourly timestamps come back in local time, so hour-of-day
  // semantics are correct for a venue in California, Hawaii, Eastern
  // Europe, anywhere. NEVER hardcode America/New_York — multi-venue.
  url.searchParams.set('timezone', 'auto')

  const res = await fetch(url.toString())
  if (!res.ok) {
    throw new Error(`Open-Meteo archive ${res.status}: ${await res.text()}`)
  }
  const json = (await res.json()) as ArchiveHourlyResponse
  const hourly = json.hourly
  if (!hourly || !hourly.time) {
    throw new Error('Open-Meteo archive returned no hourly data')
  }

  // ---------------------------------------------------------------
  // Aggregate into month × hour cells, split by recent vs prior decade.
  // ---------------------------------------------------------------
  const recentCutoffYear = recentStart.getUTCFullYear()

  interface Cell {
    temps: number[]
    precip: number[]
    sample: number
  }
  function emptyCell(): Cell {
    return { temps: [], precip: [], sample: 0 }
  }

  const recentCells = new Map<string, Cell>()
  const priorCells = new Map<string, Cell>()

  // Also collect daily totals for anomaly detection.
  const dailyMap = new Map<string, { highF: number; lowF: number; precipIn: number; snowIn: number }>()

  for (let i = 0; i < hourly.time.length; i++) {
    const ts = hourly.time[i]
    const t = hourly.temperature_2m[i]
    const p = hourly.precipitation[i]
    const s = hourly.snowfall?.[i] ?? null
    if (t === null) continue

    // Open-Meteo returns ISO local timestamps when timezone is set:
    // 'YYYY-MM-DDTHH:00'. Parse without re-interpreting.
    const yyyy = parseInt(ts.slice(0, 4), 10)
    const monthNum = parseInt(ts.slice(5, 7), 10)
    const hourLocal = parseInt(ts.slice(11, 13), 10)
    const date = ts.slice(0, 10)

    const key = `${monthNum}-${hourLocal}`
    const bucket = yyyy >= recentCutoffYear ? recentCells : priorCells
    const cell = bucket.get(key) ?? emptyCell()
    cell.temps.push(t)
    cell.precip.push(p ?? 0)
    cell.sample++
    bucket.set(key, cell)

    // Daily aggregate for anomaly detection
    const d = dailyMap.get(date) ?? {
      highF: -Infinity,
      lowF: Infinity,
      precipIn: 0,
      snowIn: 0,
    }
    if (t > d.highF) d.highF = t
    if (t < d.lowF) d.lowF = t
    d.precipIn += p ?? 0
    // Open-Meteo `snowfall` is reported in cm by default, but with
    // precipitation_unit=inch the snowfall stays in cm regardless.
    // Convert defensively.
    if (s !== null) d.snowIn += cmToInches(s)
    dailyMap.set(date, d)
  }

  function pct(arr: number[], threshold: number): number {
    if (arr.length === 0) return 0
    const hits = arr.filter((v) => v > threshold).length
    return (hits / arr.length) * 100
  }
  function mean(arr: number[]): number | null {
    if (arr.length === 0) return null
    return arr.reduce((a, b) => a + b, 0) / arr.length
  }
  function percentile(arr: number[], p: number): number | null {
    if (arr.length === 0) return null
    const sorted = [...arr].sort((a, b) => a - b)
    const idx = Math.max(0, Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length)))
    return sorted[idx]
  }

  const rows: Array<{
    venue_id: string
    month_num: number
    hour_local: number
    recent_temp_avg_f: number | null
    recent_temp_p10_f: number | null
    recent_temp_p90_f: number | null
    recent_precip_avg_in: number | null
    recent_precip_prob_pct: number
    recent_sample_count: number
    prior_temp_avg_f: number | null
    prior_precip_avg_in: number | null
    prior_precip_prob_pct: number
    prior_sample_count: number
    recent_window_start: string
    recent_window_end: string
    prior_window_start: string
    prior_window_end: string
    refreshed_at: string
  }> = []

  const refreshedAt = new Date().toISOString()
  for (let month = 1; month <= 12; month++) {
    for (let hour = 0; hour <= 23; hour++) {
      const key = `${month}-${hour}`
      const r = recentCells.get(key) ?? emptyCell()
      const p = priorCells.get(key) ?? emptyCell()
      rows.push({
        venue_id: venueId,
        month_num: month,
        hour_local: hour,
        recent_temp_avg_f: mean(r.temps),
        recent_temp_p10_f: percentile(r.temps, 10),
        recent_temp_p90_f: percentile(r.temps, 90),
        recent_precip_avg_in: mean(r.precip),
        recent_precip_prob_pct: pct(r.precip, 0.01),
        recent_sample_count: r.sample,
        prior_temp_avg_f: mean(p.temps),
        prior_precip_avg_in: mean(p.precip),
        prior_precip_prob_pct: pct(p.precip, 0.01),
        prior_sample_count: p.sample,
        recent_window_start: fmtDate(recentStart),
        recent_window_end: fmtDate(recentEnd),
        prior_window_start: fmtDate(priorStart),
        prior_window_end: fmtDate(priorEnd),
        refreshed_at: refreshedAt,
      })
    }
  }

  const { error: upsertErr } = await supabase
    .from('weather_climate_norms')
    .upsert(rows, { onConflict: 'venue_id,month_num,hour_local' })
  if (upsertErr) throw new Error(`climate-norms upsert: ${upsertErr.message}`)

  // ---------------------------------------------------------------
  // Detect anomaly events from the daily aggregates.
  // ---------------------------------------------------------------
  const dailySorted: DailyAggregate[] = Array.from(dailyMap.entries())
    .map(([date, v]) => ({
      date,
      highF: v.highF,
      lowF: v.lowF,
      precipIn: v.precipIn,
      snowIn: v.snowIn,
    }))
    .sort((a, b) => a.date.localeCompare(b.date))

  const events: Array<{
    venue_id: string
    event_type: string
    start_date: string
    end_date: string
    duration_days: number
    severity: 'moderate' | 'severe' | 'extreme'
    description: string
    min_temp_f: number | null
    max_temp_f: number | null
    total_precip_in: number | null
    total_snow_in: number | null
    refreshed_at: string
  }> = []

  // Cold snaps + heat waves + wet stretches: detect consecutive-day runs.
  function detectRuns(
    test: (d: DailyAggregate) => boolean,
    label: 'cold_snap' | 'heat_wave' | 'wet_stretch',
    minDays: number,
    describe: (start: string, end: string, days: number, runDays: DailyAggregate[]) => {
      description: string
      severity: 'moderate' | 'severe' | 'extreme'
      min_temp_f: number | null
      max_temp_f: number | null
      total_precip_in: number | null
      total_snow_in: number | null
    },
  ) {
    let runStart: string | null = null
    let runDays: DailyAggregate[] = []
    for (let i = 0; i < dailySorted.length; i++) {
      const d = dailySorted[i]
      if (test(d)) {
        if (!runStart) runStart = d.date
        runDays.push(d)
      } else {
        if (runStart && runDays.length >= minDays) {
          const meta = describe(runStart, runDays[runDays.length - 1].date, runDays.length, runDays)
          events.push({
            venue_id: venueId,
            event_type: label,
            start_date: runStart,
            end_date: runDays[runDays.length - 1].date,
            duration_days: runDays.length,
            severity: meta.severity,
            description: meta.description,
            min_temp_f: meta.min_temp_f,
            max_temp_f: meta.max_temp_f,
            total_precip_in: meta.total_precip_in,
            total_snow_in: meta.total_snow_in,
            refreshed_at: refreshedAt,
          })
        }
        runStart = null
        runDays = []
      }
    }
    // Tail run
    if (runStart && runDays.length >= minDays) {
      const meta = describe(runStart, runDays[runDays.length - 1].date, runDays.length, runDays)
      events.push({
        venue_id: venueId,
        event_type: label,
        start_date: runStart,
        end_date: runDays[runDays.length - 1].date,
        duration_days: runDays.length,
        severity: meta.severity,
        description: meta.description,
        min_temp_f: meta.min_temp_f,
        max_temp_f: meta.max_temp_f,
        total_precip_in: meta.total_precip_in,
        total_snow_in: meta.total_snow_in,
        refreshed_at: refreshedAt,
      })
    }
  }

  detectRuns(
    (d) => d.highF <= COLD_SNAP_MAX_HIGH_F,
    'cold_snap',
    COLD_SNAP_MIN_DAYS,
    (start, end, days, run) => {
      const minTemp = Math.min(...run.map((r) => r.lowF))
      const severity: 'moderate' | 'severe' | 'extreme' =
        minTemp <= -5 ? 'extreme' : minTemp <= 15 ? 'severe' : 'moderate'
      return {
        description: `${days} consecutive days at or below freezing, low of ${Math.round(minTemp)}°F`,
        severity,
        min_temp_f: minTemp,
        max_temp_f: Math.max(...run.map((r) => r.highF)),
        total_precip_in: null,
        total_snow_in: run.reduce((s, r) => s + r.snowIn, 0),
      }
    },
  )

  detectRuns(
    (d) => d.highF >= HEAT_WAVE_MIN_HIGH_F,
    'heat_wave',
    HEAT_WAVE_MIN_DAYS,
    (start, end, days, run) => {
      const maxTemp = Math.max(...run.map((r) => r.highF))
      const severity: 'moderate' | 'severe' | 'extreme' =
        maxTemp >= 105 ? 'extreme' : maxTemp >= 100 ? 'severe' : 'moderate'
      return {
        description: `${days} consecutive days above 95°F, peak of ${Math.round(maxTemp)}°F`,
        severity,
        min_temp_f: Math.min(...run.map((r) => r.lowF)),
        max_temp_f: maxTemp,
        total_precip_in: null,
        total_snow_in: null,
      }
    },
  )

  detectRuns(
    (d) => d.precipIn >= WET_STRETCH_MIN_DAILY_IN,
    'wet_stretch',
    WET_STRETCH_MIN_DAYS,
    (start, end, days, run) => {
      const total = run.reduce((s, r) => s + r.precipIn, 0)
      const severity: 'moderate' | 'severe' | 'extreme' =
        total >= 8 ? 'extreme' : total >= 4 ? 'severe' : 'moderate'
      return {
        description: `${days} wet days with ${total.toFixed(1)}" total rainfall`,
        severity,
        min_temp_f: null,
        max_temp_f: null,
        total_precip_in: total,
        total_snow_in: null,
      }
    },
  )

  // ---------------------------------------------------------------
  // Monthly-deviation events. Catches "April 2024 was 6°F warmer
  // than typical" which the short-duration run detectors miss when
  // the warmth is consistent but never extreme on any single day.
  // ---------------------------------------------------------------
  // Compute monthly aggregates: mean daily-high, total precip.
  const monthly = new Map<
    string,
    { year: number; month: number; meanHighF: number; totalPrecipIn: number; days: number }
  >()
  for (const d of dailySorted) {
    const year = parseInt(d.date.slice(0, 4), 10)
    const month = parseInt(d.date.slice(5, 7), 10)
    const key = `${year}-${month}`
    const existing = monthly.get(key)
    if (existing) {
      existing.meanHighF =
        (existing.meanHighF * existing.days + d.highF) / (existing.days + 1)
      existing.totalPrecipIn += d.precipIn
      existing.days++
    } else {
      monthly.set(key, {
        year,
        month,
        meanHighF: d.highF,
        totalPrecipIn: d.precipIn,
        days: 1,
      })
    }
  }

  // Per-month norm across the full 20-year window: mean of mean-high
  // and mean of total-precip. Used as the comparison baseline.
  const monthNorms = new Map<number, { meanHighF: number; meanPrecipIn: number; sampleYears: number }>()
  for (let m = 1; m <= 12; m++) {
    const samples = Array.from(monthly.values()).filter((v) => v.month === m && v.days >= 25)
    if (samples.length === 0) continue
    const meanHigh = samples.reduce((s, v) => s + v.meanHighF, 0) / samples.length
    const meanPrecip = samples.reduce((s, v) => s + v.totalPrecipIn, 0) / samples.length
    monthNorms.set(m, { meanHighF: meanHigh, meanPrecipIn: meanPrecip, sampleYears: samples.length })
  }

  // Thresholds for emitting a monthly event. Calibrated to surface
  // months that actually felt different rather than statistical noise.
  const TEMP_DEVIATION_F = 4 // ±4°F monthly mean-high vs norm
  const PRECIP_RATIO_HIGH = 1.4 // wet month: 40%+ more rain than typical
  const PRECIP_RATIO_LOW = 0.5 // dry month: 50%+ less rain than typical

  for (const m of monthly.values()) {
    if (m.days < 25) continue // skip incomplete tail months
    const norm = monthNorms.get(m.month)
    if (!norm) continue
    const monthName = new Date(2000, m.month - 1, 1).toLocaleString('en-US', { month: 'long' })
    const startDate = `${m.year}-${String(m.month).padStart(2, '0')}-01`
    const endDate = `${m.year}-${String(m.month).padStart(2, '0')}-${String(m.days).padStart(2, '0')}`

    const tempDelta = m.meanHighF - norm.meanHighF
    if (Math.abs(tempDelta) >= TEMP_DEVIATION_F) {
      const eventType: 'warm_month' | 'cool_month' = tempDelta > 0 ? 'warm_month' : 'cool_month'
      const absDelta = Math.abs(tempDelta)
      const severity: 'moderate' | 'severe' | 'extreme' =
        absDelta >= 8 ? 'extreme' : absDelta >= 6 ? 'severe' : 'moderate'
      const direction = tempDelta > 0 ? 'warmer' : 'cooler'
      events.push({
        venue_id: venueId,
        event_type: eventType,
        start_date: startDate,
        end_date: endDate,
        duration_days: m.days,
        severity,
        description: `${monthName} ${m.year} ran ${absDelta.toFixed(1)}°F ${direction} than the ${norm.sampleYears}-year norm (avg high ${Math.round(m.meanHighF)}°F vs typical ${Math.round(norm.meanHighF)}°F)`,
        min_temp_f: null,
        max_temp_f: m.meanHighF,
        total_precip_in: null,
        total_snow_in: null,
        refreshed_at: refreshedAt,
      })
    }

    if (norm.meanPrecipIn >= 0.5) {
      const ratio = m.totalPrecipIn / norm.meanPrecipIn
      if (ratio >= PRECIP_RATIO_HIGH || ratio <= PRECIP_RATIO_LOW) {
        const eventType: 'wet_month' | 'dry_month' = ratio >= 1 ? 'wet_month' : 'dry_month'
        const severity: 'moderate' | 'severe' | 'extreme' =
          ratio >= 2.5 || ratio <= 0.25 ? 'extreme' : ratio >= 1.8 || ratio <= 0.35 ? 'severe' : 'moderate'
        const pct = Math.round(Math.abs(ratio - 1) * 100)
        const direction = ratio >= 1 ? 'wetter' : 'drier'
        events.push({
          venue_id: venueId,
          event_type: eventType,
          start_date: startDate,
          end_date: endDate,
          duration_days: m.days,
          severity,
          description: `${monthName} ${m.year} was ${pct}% ${direction} than typical (${m.totalPrecipIn.toFixed(1)}" vs typical ${norm.meanPrecipIn.toFixed(1)}")`,
          min_temp_f: null,
          max_temp_f: null,
          total_precip_in: m.totalPrecipIn,
          total_snow_in: null,
          refreshed_at: refreshedAt,
        })
      }
    }
  }

  // Severe-storm single days
  for (const d of dailySorted) {
    if (d.precipIn >= SEVERE_STORM_MIN_PRECIP_IN) {
      events.push({
        venue_id: venueId,
        event_type: 'severe_storm',
        start_date: d.date,
        end_date: d.date,
        duration_days: 1,
        severity: d.precipIn >= 4 ? 'extreme' : 'severe',
        description: `${d.precipIn.toFixed(1)}" of rain in a single day`,
        min_temp_f: d.lowF,
        max_temp_f: d.highF,
        total_precip_in: d.precipIn,
        total_snow_in: null,
        refreshed_at: refreshedAt,
      })
    }
    if (d.snowIn >= SNOW_EVENT_MIN_DAILY_IN) {
      events.push({
        venue_id: venueId,
        event_type: 'snow_event',
        start_date: d.date,
        end_date: d.date,
        duration_days: 1,
        severity: d.snowIn >= 12 ? 'extreme' : d.snowIn >= 8 ? 'severe' : 'moderate',
        description: `${d.snowIn.toFixed(1)}" of snow in a single day`,
        min_temp_f: d.lowF,
        max_temp_f: d.highF,
        total_precip_in: null,
        total_snow_in: d.snowIn,
        refreshed_at: refreshedAt,
      })
    }
  }

  // Rank by severity then duration; keep top 50.
  const severityRank = { extreme: 3, severe: 2, moderate: 1 } as const
  events.sort((a, b) => {
    const sa = severityRank[a.severity]
    const sb = severityRank[b.severity]
    if (sa !== sb) return sb - sa
    if (a.duration_days !== b.duration_days) return b.duration_days - a.duration_days
    return b.start_date.localeCompare(a.start_date)
  })
  const topEvents = events.slice(0, 50)

  // ---------------------------------------------------------------
  // Join ops impact: interactions + tours in each event window.
  // ---------------------------------------------------------------
  // Compute "typical" by averaging the same-month interaction/tour count
  // across all years in the recent decade. Cheap: one query for the
  // 10-year inbound history at this venue, then bucket in-memory.
  const tenYearsAgo = fmtDate(recentStart)
  const { data: interactionRows } = await supabase
    .from('interactions')
    .select('timestamp')
    .eq('venue_id', venueId)
    .eq('direction', 'inbound')
    .gte('timestamp', tenYearsAgo)
    .limit(50000)

  const { data: tourRows } = await supabase
    .from('tours')
    .select('scheduled_at')
    .eq('venue_id', venueId)
    .gte('scheduled_at', tenYearsAgo)
    .not('scheduled_at', 'is', null)
    .limit(50000)

  const inquiriesByYearMonth = new Map<string, number>()
  const toursByYearMonth = new Map<string, number>()
  for (const r of interactionRows ?? []) {
    const ts = (r as { timestamp: string }).timestamp
    const key = ts.slice(0, 7) // YYYY-MM
    inquiriesByYearMonth.set(key, (inquiriesByYearMonth.get(key) ?? 0) + 1)
  }
  for (const r of tourRows ?? []) {
    const ts = (r as { scheduled_at: string }).scheduled_at
    const key = ts.slice(0, 7)
    toursByYearMonth.set(key, (toursByYearMonth.get(key) ?? 0) + 1)
  }

  function countForRange(
    map: Map<string, number>,
    start: string,
    end: string,
  ): number {
    let total = 0
    for (const [ym, count] of map) {
      // ym is YYYY-MM. Check if it overlaps with [start, end].
      if (ym >= start.slice(0, 7) && ym <= end.slice(0, 7)) total += count
    }
    return total
  }

  function typicalMonth(map: Map<string, number>, monthNum: number): number {
    // Average count for this month across all years in the recent window
    const counts: number[] = []
    for (const [ym, count] of map) {
      const m = parseInt(ym.slice(5, 7), 10)
      if (m === monthNum) counts.push(count)
    }
    if (counts.length === 0) return 0
    return Math.round(counts.reduce((a, b) => a + b, 0) / counts.length)
  }

  const haveInteractionHistory = (interactionRows ?? []).length > 0
  const eventsWithImpact = topEvents.map((e) => {
    const startMonth = parseInt(e.start_date.slice(5, 7), 10)
    const inquiriesDuring = haveInteractionHistory
      ? countForRange(inquiriesByYearMonth, e.start_date, e.end_date)
      : null
    const toursDuring = haveInteractionHistory
      ? countForRange(toursByYearMonth, e.start_date, e.end_date)
      : null
    return {
      ...e,
      inquiries_during: inquiriesDuring,
      inquiries_typical: haveInteractionHistory
        ? typicalMonth(inquiriesByYearMonth, startMonth)
        : null,
      tours_during: toursDuring,
      tours_typical: haveInteractionHistory
        ? typicalMonth(toursByYearMonth, startMonth)
        : null,
    }
  })

  // Replace the existing top set rather than accumulate. Delete +
  // upsert because the unique constraint allows upsert but the
  // ranked-set semantics ("top 50 currently") need a clean slate.
  await supabase.from('weather_anomaly_events').delete().eq('venue_id', venueId)
  if (eventsWithImpact.length > 0) {
    const { error: insertErr } = await supabase
      .from('weather_anomaly_events')
      .insert(eventsWithImpact)
    if (insertErr) throw new Error(`anomaly insert: ${insertErr.message}`)
  }

  return {
    venueId,
    refreshedAt,
    climateRows: rows.length,
    anomalyRows: eventsWithImpact.length,
    recentWindow: { start: fmtDate(recentStart), end: fmtDate(recentEnd) },
    priorWindow: { start: fmtDate(priorStart), end: fmtDate(priorEnd) },
  }
}
