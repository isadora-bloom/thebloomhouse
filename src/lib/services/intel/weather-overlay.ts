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

export interface WeatherIntelOverlay {
  venue_id: string
  generated_at: string
  forecast: ForecastDay[]
  upcoming_tours: UpcomingTourWeatherRow[]
  upcoming_weddings: UpcomingWeddingWeatherRow[]
  latest_insight: WeatherInsightSummary | null
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

  if (forecast.length === 0) {
    return {
      venue_id: venueId,
      generated_at: generatedAt,
      forecast: [],
      upcoming_tours: [],
      upcoming_weddings: [],
      latest_insight: null,
      data_gated: true,
      data_gated_reason: 'no_forecast_rows',
    }
  }

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

  return {
    venue_id: venueId,
    generated_at: generatedAt,
    forecast,
    upcoming_tours,
    upcoming_weddings,
    latest_insight,
    data_gated: false,
    data_gated_reason: null,
  }
}
