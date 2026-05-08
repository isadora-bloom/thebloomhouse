/**
 * Per-tour weather snapshot. Tier-D #164.
 *
 * Walks tours scheduled in the next 14 days OR completed in the last
 * 7 days without `weather_at_tour`, looks up the day's row in
 * weather_data (already kept fresh by the weather_forecast cron),
 * and stamps the tour. Idempotent: rows already stamped are skipped.
 *
 * Zero-cost — no new API call. Reuses the forecast that's already
 * being fetched for every venue daily.
 *
 * Why both windows: forecast captures the tour-day expectation
 * BEFORE the tour fires (drives "rain expected, prep umbrellas"
 * coordinator nudges). Last-7-days backfill captures the actual
 * conditions AFTER the tour, which feeds the weather × tour-outcome
 * correlation that #183 surfaces.
 */

import type { SupabaseClient } from '@supabase/supabase-js'

const FORWARD_DAYS = 14
const BACKWARD_DAYS = 7

interface WeatherRow {
  date: string
  temp_high: number | null
  temp_low: number | null
  precipitation_mm: number | null
  precipitation_probability: number | null
  conditions: string | null
}

interface TourRow {
  id: string
  venue_id: string
  scheduled_at: string
}

export interface StampTourWeatherResult {
  tours_stamped: number
  errors: string[]
}

export async function stampTourWeather(supabase: SupabaseClient): Promise<StampTourWeatherResult> {
  const errors: string[] = []
  const now = Date.now()
  const forwardCutoff = new Date(now + FORWARD_DAYS * 24 * 60 * 60 * 1000).toISOString()
  const backwardCutoff = new Date(now - BACKWARD_DAYS * 24 * 60 * 60 * 1000).toISOString()

  const { data: tours, error: tourErr } = await supabase
    .from('tours')
    .select('id, venue_id, scheduled_at')
    .is('weather_at_tour', null)
    .gte('scheduled_at', backwardCutoff)
    .lte('scheduled_at', forwardCutoff)
    .limit(2000)
  if (tourErr) {
    errors.push(`tours read: ${tourErr.message}`)
    return { tours_stamped: 0, errors }
  }

  const tourList = (tours ?? []) as TourRow[]
  if (tourList.length === 0) {
    return { tours_stamped: 0, errors }
  }

  // Bucket by venue + date so we issue one weather_data lookup per
  // (venue, date) rather than per tour.
  const byVenueDate = new Map<string, TourRow[]>()
  for (const t of tourList) {
    const day = t.scheduled_at.split('T')[0]
    const key = `${t.venue_id}::${day}`
    const arr = byVenueDate.get(key) ?? []
    arr.push(t)
    byVenueDate.set(key, arr)
  }

  let stamped = 0
  for (const [key, toursOnDay] of byVenueDate) {
    const [venueId, day] = key.split('::')
    const { data: weatherRow } = await supabase
      .from('weather_data')
      .select('date, temp_high, temp_low, precipitation_mm, precipitation_probability, conditions')
      .eq('venue_id', venueId)
      .eq('date', day)
      .maybeSingle()
    if (!weatherRow) continue

    const w = weatherRow as WeatherRow
    const snapshot = {
      temp_f_high: w.temp_high,
      temp_f_low: w.temp_low,
      precip_mm: w.precipitation_mm,
      precip_probability: w.precipitation_probability,
      conditions: w.conditions,
      source: 'weather_data_join',
      fetched_at: new Date().toISOString(),
    }

    for (const t of toursOnDay) {
      const { error: upErr } = await supabase
        .from('tours')
        .update({ weather_at_tour: snapshot })
        .eq('id', t.id)
      if (upErr) {
        errors.push(`tour ${t.id}: ${upErr.message}`)
        continue
      }
      stamped += 1
    }
  }

  console.log(`[tour_weather_stamp] stamped=${stamped} candidates=${tourList.length}` + (errors.length ? ` errors=${errors.length}` : ''))
  return { tours_stamped: stamped, errors }
}
