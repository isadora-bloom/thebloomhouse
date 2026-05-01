/**
 * External calendar event series for the correlation engine
 * (T2-C / Playbook 17.4).
 *
 * Federal holidays, school holiday weeks, university calendars,
 * sporting events, conventions, election days. Each row in
 * external_calendar_events has a hierarchical geo_scope ('us' /
 * 'us_va' / 'us_va_culpeper') so the correlation engine reads
 * the right matrix per venue.
 *
 * The series is per-CATEGORY: federal_holiday + school_holiday +
 * university_event + … each get their own channel id so the
 * lagged-correlation math can detect "school break weeks lead to
 * a 12-day-out tour booking lift" separately from "graduation
 * weeks lead to a 30-day-out booking dip."
 */

import type { SupabaseClient } from '@supabase/supabase-js'
import type { ExternalChannelSeries, SeriesPoint } from './types'
import { daysInRange } from './types'

/**
 * Build the geo_scope OR-list for a venue. A venue in Culpeper, VA
 * reads federal-level ('us'), state-level ('us_va'), AND metro-level
 * ('us_va_culpeper') events.
 */
function expandGeoScopes(venueGeoScope: string | null): string[] {
  if (!venueGeoScope) return ['us']
  const parts = venueGeoScope.split('_')
  const out: string[] = []
  for (let i = 1; i <= parts.length; i++) {
    out.push(parts.slice(0, i).join('_'))
  }
  return out
}

/**
 * Load external calendar events overlapping the window, group by
 * category, project onto per-day series. Each category becomes its
 * own correlation channel.
 *
 * Per-day value = sum of influence_weight for events overlapping
 * that day. Events with influence_weight=0 still contribute 1
 * (presence indicator) so the correlation engine can detect "any
 * federal holiday → 14-day-out booking dip" without requiring a
 * coordinator to set numeric weights for every holiday.
 */
export async function loadCalendarSeries(
  supabase: SupabaseClient,
  windowStart: Date,
  windowEnd: Date,
  venueGeoScope: string | null = 'us',
): Promise<ExternalChannelSeries[]> {
  const scopes = expandGeoScopes(venueGeoScope)
  const startIso = windowStart.toISOString().slice(0, 10)
  const endIso = windowEnd.toISOString().slice(0, 10)

  const { data } = await supabase
    .from('external_calendar_events')
    .select('category, start_date, end_date, influence_weight, geo_scope')
    .in('geo_scope', scopes)
    .is('deleted_at', null)
    .lte('start_date', endIso)
    .gte('end_date', startIso)

  type CalendarRow = {
    category: string
    start_date: string
    end_date: string
    influence_weight: number | null
  }
  const byCategoryDay = new Map<string, Map<string, number>>()
  for (const r of ((data ?? []) as CalendarRow[])) {
    const dailyForCat = byCategoryDay.get(r.category) ?? new Map<string, number>()
    // Default presence-indicator value of 1 when influence_weight is
    // 0/null — lets the correlation engine pick up patterns even on
    // categories with no coordinator-tuned weights.
    const value = r.influence_weight && r.influence_weight !== 0 ? r.influence_weight : 1
    const start = new Date(`${r.start_date}T00:00:00Z`)
    const end = new Date(`${r.end_date}T00:00:00Z`)
    const clampedStart = start < windowStart ? windowStart : start
    const clampedEnd = end > windowEnd ? windowEnd : end
    if (clampedEnd < clampedStart) continue
    for (const dayKey of daysInRange(clampedStart, clampedEnd)) {
      dailyForCat.set(dayKey, (dailyForCat.get(dayKey) ?? 0) + value)
    }
    byCategoryDay.set(r.category, dailyForCat)
  }

  const out: ExternalChannelSeries[] = []
  for (const [category, dailyMap] of byCategoryDay) {
    const points: SeriesPoint[] = Array.from(dailyMap.entries())
      .map(([dayKey, value]) => ({ dayKey, value }))
      .sort((a, b) => a.dayKey.localeCompare(b.dayKey))
    if (points.length > 0) {
      out.push({ channel: `calendar_${category}`, points })
    }
  }
  return out
}
