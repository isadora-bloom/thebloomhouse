/**
 * Weather Intelligence overlay (TIER 6).
 *
 * The plumbing already exists — Open-Meteo forecasts run nightly,
 * weather_data has 14-day forecast rows, weather-cancellation correlates
 * to tour outcomes, and the briefings carry a weather_outlook string.
 * What's missing is a coordinator-facing surface that answers "which
 * tours and weddings in my upcoming pipeline are on bad-weather days".
 *
 * This service joins forecast rows to upcoming tours + weddings and
 * scores each by calculateWeatherScore. It does NOT call any external
 * API — pure DB read. Cron writes the forecast; this service composes.
 */

import { createServiceClient } from '@/lib/supabase/service'
import { calculateWeatherScore } from '@/lib/services/intel/weather'

export interface ForecastDay {
  date: string
  high_temp: number | null
  low_temp: number | null
  precipitation: number | null
  conditions: string | null
  weather_score: number
  risk_band: 'good' | 'fair' | 'poor' | 'severe'
}

export interface UpcomingTourWeatherRow {
  tour_id: string
  scheduled_at: string
  date: string
  couple_display_name: string | null
  wedding_id: string | null
  weather: ForecastDay | null
}

export interface UpcomingWeddingWeatherRow {
  wedding_id: string
  wedding_date: string
  display_name: string | null
  booking_value: number | null
  weather: ForecastDay | null
}

export interface WeatherInsightSummary {
  id: string
  title: string
  body: string | null
  generated_at: string
}

export interface ClimateHourCell {
  hour_local: number
  recent_temp_avg_f: number | null
  recent_temp_p10_f: number | null
  recent_temp_p90_f: number | null
  recent_precip_prob_pct: number | null
  prior_temp_avg_f: number | null
  prior_precip_prob_pct: number | null
}

export interface ClimateMonthProfile {
  month_num: number
  month_label: string
  hours: ClimateHourCell[]
  // Daytime average (10am-8pm) — useful for at-a-glance "what does April
  // feel like during venue hours"
  daytime_temp_avg_f: number | null
  daytime_precip_prob_pct: number | null
  daytime_temp_delta_f: number | null
  daytime_precip_prob_delta_pct: number | null
  recent_window_start: string | null
  recent_window_end: string | null
  prior_window_start: string | null
  prior_window_end: string | null
  refreshed_at: string | null
}

export interface AnomalyEvent {
  id: string
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
  inquiries_during: number | null
  inquiries_typical: number | null
  tours_during: number | null
  tours_typical: number | null
}

export interface WeatherIntelOverlay {
  venue_id: string
  generated_at: string
  forecast: ForecastDay[]
  upcoming_tours: UpcomingTourWeatherRow[]
  upcoming_weddings: UpcomingWeddingWeatherRow[]
  latest_insight: WeatherInsightSummary | null
  /** Per-month historical profile, indexed by month_num 1-12. */
  climate_months: ClimateMonthProfile[]
  /** Notable past events with operational impact. */
  anomaly_events: AnomalyEvent[]
  history_available: boolean
  data_gated: boolean
  data_gated_reason: string | null
}

function riskBand(score: number): ForecastDay['risk_band'] {
  if (score >= 8) return 'severe'
  if (score >= 5) return 'poor'
  if (score >= 2) return 'fair'
  return 'good'
}

function toForecastDay(row: {
  date: string
  high_temp: number | null
  low_temp: number | null
  precipitation: number | null
  conditions: string | null
}): ForecastDay {
  const score = calculateWeatherScore(
    row.precipitation ?? 0,
    row.high_temp ?? 70,
    row.low_temp ?? 50,
  )
  return {
    date: row.date,
    high_temp: row.high_temp,
    low_temp: row.low_temp,
    precipitation: row.precipitation,
    conditions: row.conditions,
    weather_score: score,
    risk_band: riskBand(score),
  }
}

function todayIso(): string {
  return new Date().toISOString().slice(0, 10)
}

function addDaysIso(days: number): string {
  const d = new Date()
  d.setUTCDate(d.getUTCDate() + days)
  return d.toISOString().slice(0, 10)
}

export async function computeWeatherIntelOverlay(
  venueId: string,
): Promise<WeatherIntelOverlay> {
  const supabase = createServiceClient()
  const generatedAt = new Date().toISOString()

  const { data: venue } = await supabase
    .from('venues')
    .select('latitude, longitude')
    .eq('id', venueId)
    .single()

  if (!venue || (!venue.latitude && !venue.longitude)) {
    return {
      venue_id: venueId,
      generated_at: generatedAt,
      forecast: [],
      upcoming_tours: [],
      upcoming_weddings: [],
      latest_insight: null,
      climate_months: [],
      anomaly_events: [],
      history_available: false,
      data_gated: true,
      data_gated_reason: 'no_venue_coordinates',
    }
  }

  const start = todayIso()
  const end = addDaysIso(14)

  const { data: forecastRows } = await supabase
    .from('weather_data')
    .select('date, high_temp, low_temp, precipitation, conditions')
    .eq('venue_id', venueId)
    .gte('date', start)
    .lte('date', end)
    .order('date', { ascending: true })

  const forecast = (forecastRows ?? []).map(toForecastDay)
  const byDate = new Map(forecast.map((f) => [f.date, f]))

  // No early-return on missing forecast. Under the TIER 6+ reframe the
  // page still has climate norms + anomaly events to show, so we
  // degrade gracefully and leave the forecast strip empty rather than
  // blocking the whole surface.

  const { data: tourRows } = await supabase
    .from('tours')
    .select('id, scheduled_at, couple_display_name, wedding_id, outcome')
    .eq('venue_id', venueId)
    .gte('scheduled_at', new Date(start).toISOString())
    .lte('scheduled_at', new Date(`${end}T23:59:59Z`).toISOString())
    .not('scheduled_at', 'is', null)
    .order('scheduled_at', { ascending: true })

  const upcoming_tours: UpcomingTourWeatherRow[] = (tourRows ?? [])
    .filter((t) => {
      const outcome = (t as { outcome: string | null }).outcome
      return outcome === null || outcome === 'pending' || outcome === 'scheduled'
    })
    .map((t) => {
      const row = t as {
        id: string
        scheduled_at: string
        couple_display_name: string | null
        wedding_id: string | null
      }
      const date = row.scheduled_at.slice(0, 10)
      return {
        tour_id: row.id,
        scheduled_at: row.scheduled_at,
        date,
        couple_display_name: row.couple_display_name,
        wedding_id: row.wedding_id,
        weather: byDate.get(date) ?? null,
      }
    })

  // Upcoming weddings within the 14-day window. Booked = paying customer
  // with an event on the calendar — coordinators have time to react with
  // rain plans, vendor coord, shuttle changes.
  const { data: weddingRows } = await supabase
    .from('weddings')
    .select('id, wedding_date, booking_value, status')
    .eq('venue_id', venueId)
    .gte('wedding_date', start)
    .lte('wedding_date', end)
    .in('status', ['booked', 'completed'])
    .order('wedding_date', { ascending: true })

  // Roll up partner names per wedding so the row shows a real label
  // instead of a uuid. People may have NULL names; we filter and join
  // what we have.
  const weddingIds = (weddingRows ?? []).map((w) => (w as { id: string }).id)
  const namesByWedding = new Map<string, string[]>()
  if (weddingIds.length > 0) {
    const { data: peopleRows } = await supabase
      .from('people')
      .select('wedding_id, first_name, last_name, role')
      .in('wedding_id', weddingIds)
      .in('role', ['partner1', 'partner2'])
      .order('role', { ascending: true })

    for (const p of peopleRows ?? []) {
      const row = p as {
        wedding_id: string | null
        first_name: string | null
        last_name: string | null
      }
      if (!row.wedding_id) continue
      const display = [row.first_name, row.last_name].filter(Boolean).join(' ').trim()
      if (!display) continue
      const arr = namesByWedding.get(row.wedding_id) ?? []
      arr.push(display)
      namesByWedding.set(row.wedding_id, arr)
    }
  }

  const upcoming_weddings: UpcomingWeddingWeatherRow[] = (weddingRows ?? []).map((w) => {
    const row = w as {
      id: string
      wedding_date: string
      booking_value: number | null
    }
    const names = namesByWedding.get(row.id) ?? []
    return {
      wedding_id: row.id,
      wedding_date: row.wedding_date,
      display_name: names.length > 0 ? names.join(' & ') : null,
      booking_value: row.booking_value,
      weather: byDate.get(row.wedding_date) ?? null,
    }
  })

  // Latest weather-correlation insight, if any. weather-cancellation
  // service writes these under signal_class='weather_x_venue'.
  const { data: insightRows } = await supabase
    .from('intelligence_insights')
    .select('id, title, description, created_at, data_points')
    .eq('venue_id', venueId)
    .eq('insight_type', 'correlation_narration')
    .order('created_at', { ascending: false })
    .limit(10)

  let latest_insight: WeatherInsightSummary | null = null
  for (const r of insightRows ?? []) {
    const row = r as {
      id: string
      title: string
      description: string | null
      created_at: string
      data_points: Record<string, unknown> | null
    }
    const sig =
      row.data_points?.signalClass ??
      row.data_points?.signal_class ??
      row.data_points?.pair_class
    if (typeof sig === 'string' && sig.includes('weather')) {
      latest_insight = {
        id: row.id,
        title: row.title,
        body: row.description,
        generated_at: row.created_at,
      }
      break
    }
  }

  // -----------------------------------------------------------------
  // Climate norms (per-month-hour historical profile + trend deltas).
  // Empty when the operator has not yet triggered the history refresh.
  // -----------------------------------------------------------------
  const { data: normsRows } = await supabase
    .from('weather_climate_norms')
    .select(
      'month_num, hour_local, recent_temp_avg_f, recent_temp_p10_f, recent_temp_p90_f, recent_precip_avg_in, recent_precip_prob_pct, recent_sample_count, prior_temp_avg_f, prior_precip_avg_in, prior_precip_prob_pct, prior_sample_count, recent_window_start, recent_window_end, prior_window_start, prior_window_end, refreshed_at',
    )
    .eq('venue_id', venueId)
    .order('month_num', { ascending: true })
    .order('hour_local', { ascending: true })

  const climate_months: ClimateMonthProfile[] = []
  if (normsRows && normsRows.length > 0) {
    const byMonth = new Map<number, typeof normsRows>()
    for (const row of normsRows) {
      const r = row as { month_num: number }
      const arr = byMonth.get(r.month_num) ?? []
      arr.push(row)
      byMonth.set(r.month_num, arr as typeof normsRows)
    }
    for (let m = 1; m <= 12; m++) {
      const monthRows = byMonth.get(m)
      if (!monthRows || monthRows.length === 0) continue
      type NormRow = {
        month_num: number
        hour_local: number
        recent_temp_avg_f: number | null
        recent_temp_p10_f: number | null
        recent_temp_p90_f: number | null
        recent_precip_avg_in: number | null
        recent_precip_prob_pct: number | null
        recent_sample_count: number
        prior_temp_avg_f: number | null
        prior_precip_avg_in: number | null
        prior_precip_prob_pct: number | null
        prior_sample_count: number
        recent_window_start: string | null
        recent_window_end: string | null
        prior_window_start: string | null
        prior_window_end: string | null
        refreshed_at: string | null
      }
      const rows = monthRows as unknown as NormRow[]
      const hours = rows.map<ClimateHourCell>((r) => ({
        hour_local: r.hour_local,
        recent_temp_avg_f: r.recent_temp_avg_f,
        recent_temp_p10_f: r.recent_temp_p10_f,
        recent_temp_p90_f: r.recent_temp_p90_f,
        recent_precip_prob_pct: r.recent_precip_prob_pct,
        prior_temp_avg_f: r.prior_temp_avg_f,
        prior_precip_prob_pct: r.prior_precip_prob_pct,
      }))
      const daytime = hours.filter((h) => h.hour_local >= 10 && h.hour_local <= 20)
      const meanOrNull = (vals: (number | null)[]): number | null => {
        const valid = vals.filter((v): v is number => v !== null)
        if (valid.length === 0) return null
        return valid.reduce((a, b) => a + b, 0) / valid.length
      }
      const recentTempAvg = meanOrNull(daytime.map((h) => h.recent_temp_avg_f))
      const recentPrecip = meanOrNull(daytime.map((h) => h.recent_precip_prob_pct))
      const priorTempAvg = meanOrNull(daytime.map((h) => h.prior_temp_avg_f))
      const priorPrecip = meanOrNull(daytime.map((h) => h.prior_precip_prob_pct))

      const meta = rows[0]
      climate_months.push({
        month_num: m,
        month_label: new Date(2000, m - 1, 1).toLocaleString('en-US', { month: 'long' }),
        hours,
        daytime_temp_avg_f: recentTempAvg,
        daytime_precip_prob_pct: recentPrecip,
        daytime_temp_delta_f:
          recentTempAvg !== null && priorTempAvg !== null ? recentTempAvg - priorTempAvg : null,
        daytime_precip_prob_delta_pct:
          recentPrecip !== null && priorPrecip !== null ? recentPrecip - priorPrecip : null,
        recent_window_start: meta.recent_window_start,
        recent_window_end: meta.recent_window_end,
        prior_window_start: meta.prior_window_start,
        prior_window_end: meta.prior_window_end,
        refreshed_at: meta.refreshed_at,
      })
    }
  }

  // -----------------------------------------------------------------
  // Anomaly events (notable past weather + ops impact). Most recent
  // first so the page leads with the freshest "remember last Feb".
  // -----------------------------------------------------------------
  const { data: anomalyRows } = await supabase
    .from('weather_anomaly_events')
    .select(
      'id, event_type, start_date, end_date, duration_days, severity, description, min_temp_f, max_temp_f, total_precip_in, total_snow_in, inquiries_during, inquiries_typical, tours_during, tours_typical',
    )
    .eq('venue_id', venueId)
    .order('start_date', { ascending: false })
    .limit(50)

  const anomaly_events: AnomalyEvent[] = ((anomalyRows ?? []) as unknown as AnomalyEvent[]).map(
    (r) => ({
      id: r.id,
      event_type: r.event_type,
      start_date: r.start_date,
      end_date: r.end_date,
      duration_days: r.duration_days,
      severity: r.severity,
      description: r.description,
      min_temp_f: r.min_temp_f,
      max_temp_f: r.max_temp_f,
      total_precip_in: r.total_precip_in,
      total_snow_in: r.total_snow_in,
      inquiries_during: r.inquiries_during,
      inquiries_typical: r.inquiries_typical,
      tours_during: r.tours_during,
      tours_typical: r.tours_typical,
    }),
  )

  return {
    venue_id: venueId,
    generated_at: generatedAt,
    forecast,
    upcoming_tours,
    upcoming_weddings,
    latest_insight,
    climate_months,
    anomaly_events,
    history_available: climate_months.length > 0,
    data_gated: false,
    data_gated_reason: null,
  }
}
