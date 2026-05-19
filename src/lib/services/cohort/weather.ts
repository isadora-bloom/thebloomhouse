/**
 * D9 — weather x tour no-show (battery Q10).
 *
 * Joins each scheduled tour touchpoint (attended or no-show) to the
 * weather_data row for that calendar date, then compares the no-show
 * rate on bad-weather days vs fair-weather days.
 *
 * "Bad weather" = measurable precipitation or a temperature extreme.
 * When no weather rows match the tour dates, `available` is false and
 * the surface says so rather than implying a zero-effect finding.
 */

import type { SupabaseClient } from '@supabase/supabase-js'
import type { CohortData, WeatherResult } from './types'
import { ratio, zonedParts } from './helpers'

interface WeatherRow {
  date: string
  high_temp: number | null
  low_temp: number | null
  precipitation: number | null
}

function isBadWeather(w: WeatherRow): boolean {
  if (w.precipitation !== null && Number(w.precipitation) >= 0.1) return true
  if (w.high_temp !== null && Number(w.high_temp) >= 95) return true
  if (w.low_temp !== null && Number(w.low_temp) <= 25) return true
  if (w.high_temp !== null && Number(w.high_temp) <= 35) return true
  return false
}

export async function computeWeather(
  data: CohortData,
  supabase: SupabaseClient,
): Promise<WeatherResult> {
  // Scheduled tours: a touchpoint the couple was expected to attend.
  const tours = data.touchpoints
    .filter(
      (tp) =>
        tp.action_type === 'tour_attended' || tp.action_type === 'tour_no_show',
    )
    .map((tp) => {
      const p = zonedParts(tp.occurred_at, data.timezone)
      return p
        ? { dateKey: p.dateKey, noShow: tp.action_type === 'tour_no_show' }
        : null
    })
    .filter((t): t is { dateKey: string; noShow: boolean } => t !== null)

  const empty: WeatherResult = {
    available: false,
    note: '',
    badWeatherTours: 0,
    badWeatherNoShows: 0,
    fairWeatherTours: 0,
    fairWeatherNoShows: 0,
    badWeatherNoShowRate: null,
    fairWeatherNoShowRate: null,
  }

  if (tours.length === 0) {
    return {
      ...empty,
      note: 'No scheduled-tour touchpoints (attended or no-show) to join.',
    }
  }

  let weather: WeatherRow[] = []
  try {
    const { data: rows } = await supabase
      .from('weather_data')
      .select('date, high_temp, low_temp, precipitation')
      .eq('venue_id', data.venueId)
    weather = (rows ?? []) as WeatherRow[]
  } catch {
    return { ...empty, note: 'Weather data is unavailable for this venue.' }
  }

  if (weather.length === 0) {
    return {
      ...empty,
      note:
        'No weather history recorded for this venue — the weather cron ' +
        'has not populated weather_data yet.',
    }
  }

  const byDate = new Map<string, WeatherRow>()
  for (const w of weather) byDate.set(w.date, w)

  let badWeatherTours = 0
  let badWeatherNoShows = 0
  let fairWeatherTours = 0
  let fairWeatherNoShows = 0
  let matched = 0

  for (const t of tours) {
    const w = byDate.get(t.dateKey)
    if (!w) continue
    matched++
    if (isBadWeather(w)) {
      badWeatherTours++
      if (t.noShow) badWeatherNoShows++
    } else {
      fairWeatherTours++
      if (t.noShow) fairWeatherNoShows++
    }
  }

  if (matched === 0) {
    return {
      ...empty,
      note:
        `Have ${tours.length} scheduled tours and ${weather.length} ` +
        'weather days, but none of the dates overlap yet.',
    }
  }

  return {
    available: true,
    note: `${matched} of ${tours.length} scheduled tours matched a weather day.`,
    badWeatherTours,
    badWeatherNoShows,
    fairWeatherTours,
    fairWeatherNoShows,
    badWeatherNoShowRate: ratio(badWeatherNoShows, badWeatherTours),
    fairWeatherNoShowRate: ratio(fairWeatherNoShows, fairWeatherTours),
  }
}
