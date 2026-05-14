/**
 * Climate context provider (TIER 6++).
 *
 * One read surface that every AI consumer calls to fetch the venue's
 * historical weather record + relevant past anomalies in a prompt-ready
 * shape. Replaces the previous "each consumer queries weather_data on
 * its own" pattern where climate_norms + anomaly_events were dark to
 * the AI.
 *
 * Usage
 * -----
 *   const ctx = await getVenueClimateContext(venueId, { month: 5 })
 *   if (ctx.available) {
 *     systemPrompt += '\n\nVENUE CLIMATE RECORD:\n' + ctx.promptBlock
 *   }
 *
 * Two consumption modes:
 *   - `month`     specific month profile + relevant anomalies for that month
 *   - `date`      derives month from the date, returns the same shape
 *                 (convenient for tour-prep, couple-portal-by-wedding-date)
 *
 * The promptBlock is plain-English, numbers-typed text — ready to drop
 * into any system prompt. AI consumers DO NOT re-narrate; the block is
 * already coordinator voice.
 */

import { createServiceClient } from '@/lib/supabase/service'

export interface ClimateContextOptions {
  /** Month number 1-12. Mutually exclusive with `date`. */
  month?: number
  /** ISO date string. Month is derived from it. Mutually exclusive with `month`. */
  date?: string
  /** Hour of day (0-23) when caller wants hour-specific copy. */
  hour?: number
  /** Cap on how many past anomalies to surface. Default 3. */
  maxAnomalies?: number
}

export interface ClimateContext {
  venueId: string
  available: boolean
  /** Plain-English prompt block ready to inject into a system prompt. Null when no data. */
  promptBlock: string | null
  /** Structured data for callers that build their own copy. */
  monthProfile: {
    month: number
    monthLabel: string
    daytimeTempF: number | null
    daytimePrecipProbPct: number | null
    tempTrendF: number | null
    precipTrendPct: number | null
    hourSpecific?: { hour: number; tempF: number | null; precipProbPct: number | null }
  } | null
  recentAnomalies: Array<{
    description: string
    startDate: string
    durationDays: number
    severity: string
    inquiriesDuring: number | null
    inquiriesTypical: number | null
    toursDuring: number | null
    toursTypical: number | null
  }>
}

function monthLabel(m: number): string {
  return new Date(2000, m - 1, 1).toLocaleString('en-US', { month: 'long' })
}

function direction(delta: number): string {
  return delta > 0 ? 'warmer' : 'cooler'
}

function precipDirection(delta: number): string {
  return delta > 0 ? 'wetter' : 'drier'
}

function formatImpact(during: number | null, typical: number | null, label: string): string | null {
  if (during === null || typical === null || typical === 0) return null
  const delta = during - typical
  if (delta === 0) return null
  const pct = Math.round((delta / typical) * 100)
  const sign = pct > 0 ? '+' : ''
  return `${during} ${label} vs typical ${typical} (${sign}${pct}%)`
}

export async function getVenueClimateContext(
  venueId: string,
  opts: ClimateContextOptions = {},
): Promise<ClimateContext> {
  const supabase = createServiceClient()
  const maxAnomalies = opts.maxAnomalies ?? 3

  let monthNum: number | null = null
  if (typeof opts.month === 'number') {
    monthNum = opts.month
  } else if (opts.date) {
    const d = new Date(opts.date)
    if (!isNaN(d.getTime())) monthNum = d.getUTCMonth() + 1
  } else {
    monthNum = new Date().getUTCMonth() + 1
  }

  if (!monthNum || monthNum < 1 || monthNum > 12) {
    return {
      venueId,
      available: false,
      promptBlock: null,
      monthProfile: null,
      recentAnomalies: [],
    }
  }

  // Pull only the month's 24 rows.
  const { data: normsRows } = await supabase
    .from('weather_climate_norms')
    .select(
      'hour_local, recent_temp_avg_f, recent_precip_prob_pct, prior_temp_avg_f, prior_precip_prob_pct',
    )
    .eq('venue_id', venueId)
    .eq('month_num', monthNum)

  const rows = (normsRows ?? []) as Array<{
    hour_local: number
    recent_temp_avg_f: number | null
    recent_precip_prob_pct: number | null
    prior_temp_avg_f: number | null
    prior_precip_prob_pct: number | null
  }>

  if (rows.length === 0) {
    return {
      venueId,
      available: false,
      promptBlock: null,
      monthProfile: null,
      recentAnomalies: [],
    }
  }

  const daytime = rows.filter((r) => r.hour_local >= 10 && r.hour_local <= 20)
  const meanOrNull = (vals: (number | null)[]): number | null => {
    const valid = vals.filter((v): v is number => v !== null)
    if (valid.length === 0) return null
    return valid.reduce((a, b) => a + b, 0) / valid.length
  }
  const recentTempAvg = meanOrNull(daytime.map((r) => r.recent_temp_avg_f))
  const recentPrecip = meanOrNull(daytime.map((r) => r.recent_precip_prob_pct))
  const priorTempAvg = meanOrNull(daytime.map((r) => r.prior_temp_avg_f))
  const priorPrecip = meanOrNull(daytime.map((r) => r.prior_precip_prob_pct))
  const tempDelta =
    recentTempAvg !== null && priorTempAvg !== null ? recentTempAvg - priorTempAvg : null
  const precipDelta =
    recentPrecip !== null && priorPrecip !== null ? recentPrecip - priorPrecip : null

  let hourSpecific: { hour: number; tempF: number | null; precipProbPct: number | null } | undefined
  if (typeof opts.hour === 'number') {
    const hourRow = rows.find((r) => r.hour_local === opts.hour)
    if (hourRow) {
      hourSpecific = {
        hour: opts.hour,
        tempF: hourRow.recent_temp_avg_f,
        precipProbPct: hourRow.recent_precip_prob_pct,
      }
    }
  }

  // Relevant past anomalies for this month. Order by recency so the
  // brain sees "last X" first.
  const { data: anomalyRows } = await supabase
    .from('weather_anomaly_events')
    .select(
      'event_type, start_date, end_date, duration_days, severity, description, inquiries_during, inquiries_typical, tours_during, tours_typical',
    )
    .eq('venue_id', venueId)
    .order('start_date', { ascending: false })
    .limit(50)

  type AnomalyRow = {
    event_type: string
    start_date: string
    end_date: string
    duration_days: number
    severity: string
    description: string
    inquiries_during: number | null
    inquiries_typical: number | null
    tours_during: number | null
    tours_typical: number | null
  }
  const allAnomalies = (anomalyRows ?? []) as AnomalyRow[]
  const monthAnomalies = allAnomalies.filter(
    (a) => parseInt(a.start_date.slice(5, 7), 10) === monthNum,
  )
  const top = monthAnomalies.slice(0, maxAnomalies)

  // -----------------------------------------------------------------
  // Compose prompt block. Plain-English coordinator voice. Numbers-
  // typed so the AI cannot fabricate values.
  // -----------------------------------------------------------------
  const lines: string[] = []
  lines.push(`Typical ${monthLabel(monthNum)} at this venue (10-year average):`)
  if (recentTempAvg !== null) {
    lines.push(`- Daytime temp: ${Math.round(recentTempAvg)}°F average`)
  }
  if (recentPrecip !== null) {
    lines.push(`- Daytime rain chance: ${Math.round(recentPrecip)}% of hours`)
  }
  if (hourSpecific && hourSpecific.tempF !== null) {
    const hourLbl =
      hourSpecific.hour === 0
        ? 'midnight'
        : hourSpecific.hour === 12
          ? 'noon'
          : hourSpecific.hour < 12
            ? `${hourSpecific.hour}am`
            : `${hourSpecific.hour - 12}pm`
    lines.push(
      `- At ${hourLbl}: ${Math.round(hourSpecific.tempF)}°F typical, ${hourSpecific.precipProbPct !== null ? `${Math.round(hourSpecific.precipProbPct)}% rain chance` : 'rain chance unknown'}`,
    )
  }
  if (tempDelta !== null && Math.abs(tempDelta) >= 0.5) {
    lines.push(
      `- Trend: ${Math.abs(tempDelta).toFixed(1)}°F ${direction(tempDelta)} than the prior decade`,
    )
  }
  if (precipDelta !== null && Math.abs(precipDelta) >= 1) {
    lines.push(
      `- Trend: ${Math.abs(Math.round(precipDelta))} percentage points ${precipDirection(precipDelta)} than the prior decade`,
    )
  }

  if (top.length > 0) {
    lines.push(``)
    lines.push(`Notable past ${monthLabel(monthNum)} weather at this venue:`)
    for (const a of top) {
      const yr = a.start_date.slice(0, 4)
      const parts = [`- ${yr}: ${a.description}`]
      const inq = formatImpact(a.inquiries_during, a.inquiries_typical, 'inquiries')
      const tours = formatImpact(a.tours_during, a.tours_typical, 'tours')
      if (inq) parts.push(`(${inq})`)
      if (tours) parts.push(`(${tours})`)
      lines.push(parts.join(' '))
    }
  }

  const recentAnomalies = top.map((a) => ({
    description: a.description,
    startDate: a.start_date,
    durationDays: a.duration_days,
    severity: a.severity,
    inquiriesDuring: a.inquiries_during,
    inquiriesTypical: a.inquiries_typical,
    toursDuring: a.tours_during,
    toursTypical: a.tours_typical,
  }))

  return {
    venueId,
    available: true,
    promptBlock: lines.join('\n'),
    monthProfile: {
      month: monthNum,
      monthLabel: monthLabel(monthNum),
      daytimeTempF: recentTempAvg,
      daytimePrecipProbPct: recentPrecip,
      tempTrendF: tempDelta,
      precipTrendPct: precipDelta,
      hourSpecific,
    },
    recentAnomalies,
  }
}

/**
 * Returns active anomalies that include today's date in their window.
 * Used by the daily-pulse / anomaly-detection surfaces to explain a
 * current pipeline dip in terms of a current weather anomaly.
 */
export async function getActiveAnomalies(
  venueId: string,
): Promise<
  Array<{
    eventType: string
    description: string
    severity: string
    inquiriesDuring: number | null
    inquiriesTypical: number | null
  }>
> {
  const supabase = createServiceClient()
  const today = new Date().toISOString().slice(0, 10)
  const { data } = await supabase
    .from('weather_anomaly_events')
    .select(
      'event_type, description, severity, inquiries_during, inquiries_typical',
    )
    .eq('venue_id', venueId)
    .lte('start_date', today)
    .gte('end_date', today)
    .order('severity', { ascending: false })

  type Row = {
    event_type: string
    description: string
    severity: string
    inquiries_during: number | null
    inquiries_typical: number | null
  }
  return ((data ?? []) as Row[]).map((r) => ({
    eventType: r.event_type,
    description: r.description,
    severity: r.severity,
    inquiriesDuring: r.inquiries_during,
    inquiriesTypical: r.inquiries_typical,
  }))
}
