/**
 * Government events channel loader for the correlation engine
 * (T5-Rixey-ZZ / Z6).
 *
 * Reads `government_events` (migration 189) and projects rows onto a
 * dense per-day binary-ish series. Each day in the window gets a value
 * based on whether a government event covers it AND its severity:
 *
 *   - 'full'        → 1.0
 *   - 'partial'     → 0.5
 *   - 'threatened'  → 0.5
 *   - 'minor'       → 0.25
 *   - quiet day     → 0.0
 *
 * For DC-region venues (state IN ('VA', 'DC', 'MD') OR within ~100mi of
 * Washington DC by lat/lon) the per-day value is amplified by 1.5x to
 * reflect the heavier exposure of federal-employee clientele to
 * shutdowns. Non-DC venues get the default 0.5x weighting (the channel
 * still affects general consumer sentiment but less directly).
 *
 * NOTE on Pearson + binary signals: a step-function signal violates one
 * of Pearson's nicer assumptions (continuity), but the engine's
 * Bonferroni-adjusted critical |r| filter handles spurious-correlation
 * risk. To smooth the on/off discontinuity we additionally pad the
 * signal with a 7-day fade after each event ends (linear ramp from
 * peak → 0). This converts the step into a soft kernel that the
 * lagged-correlation math can latch onto when the booking-effect
 * window outlasts the event itself.
 *
 * Per Rixey-ZZ Z6.
 */

import type { SupabaseClient } from '@supabase/supabase-js'
import type { ExternalChannelSeries, SeriesPoint } from './types'
import { toDayKey } from './types'

/** DC-metro proxy: any of these state codes triggers amplification. */
const DC_REGION_STATES = new Set(['VA', 'DC', 'MD'])

/** Approximate center of the District of Columbia (US Capitol). */
const DC_LAT = 38.8895
const DC_LON = -77.0353
/** Miles. Anything closer than this counts as DC-region for amplification. */
const DC_RADIUS_MILES = 100

/** Severity → base per-day signal value. */
const SEVERITY_VALUE: Record<string, number> = {
  full: 1.0,
  partial: 0.5,
  threatened: 0.5,
  minor: 0.25,
}

/** Days of post-event linear fade applied to soften the step function. */
const POST_EVENT_FADE_DAYS = 7

/** Amplification factor applied for DC-region venues. */
const DC_AMPLIFICATION = 1.5
/** Damping factor applied for non-DC venues (federal events affect general
 *  consumer sentiment less directly). */
const NON_DC_DAMPING = 0.5

interface VenueGeoFacts {
  state: string | null
  latitude: number | null
  longitude: number | null
}

/**
 * Great-circle distance between two points in miles. Haversine formula.
 * Used to flag a venue as DC-region by proximity even when state isn't
 * one of VA/DC/MD (e.g. southern PA / northern WV / eastern WV venues
 * with federal-commuter clientele).
 */
function haversineMiles(lat1: number, lon1: number, lat2: number, lon2: number): number {
  const R = 3959 // earth radius in miles
  const toRad = (deg: number) => (deg * Math.PI) / 180
  const dLat = toRad(lat2 - lat1)
  const dLon = toRad(lon2 - lon1)
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(a)))
}

/**
 * Determine whether a venue counts as DC-region for amplification
 * purposes. Returns true if state is one of VA/DC/MD OR if lat/lon is
 * within DC_RADIUS_MILES of the Capitol.
 *
 * Exported for testing and for the engine wiring decision (skip the
 * channel entirely for venues with neither geo signal AND no clientele
 * in the DC area — saves a query for clearly non-relevant venues).
 */
export function isDCRegionVenue(facts: VenueGeoFacts): boolean {
  const state = (facts.state ?? '').trim().toUpperCase()
  if (state && DC_REGION_STATES.has(state)) return true
  if (
    facts.latitude != null &&
    facts.longitude != null &&
    Number.isFinite(facts.latitude) &&
    Number.isFinite(facts.longitude)
  ) {
    const miles = haversineMiles(facts.latitude, facts.longitude, DC_LAT, DC_LON)
    if (miles <= DC_RADIUS_MILES) return true
  }
  return false
}

/**
 * Fetch venue geo facts for the DC-region check. Falls back to nulls if
 * the venue row is missing — caller treats unknown as non-DC.
 */
async function loadVenueGeoFacts(
  supabase: SupabaseClient,
  venueId: string,
): Promise<VenueGeoFacts> {
  const { data } = await supabase
    .from('venues')
    .select('state, latitude, longitude')
    .eq('id', venueId)
    .maybeSingle()
  return {
    state: (data?.state as string | null) ?? null,
    latitude: data?.latitude as number | null,
    longitude: data?.longitude as number | null,
  }
}

interface GovEventRow {
  event_type: string
  start_date: string
  end_date: string | null
  region: string
  severity: string
}

/**
 * Build the government-events series for a venue across the requested
 * window. Returns at most one ExternalChannelSeries (channel id
 * 'government_signals'); if no events overlap the window the function
 * returns an empty array so the engine skips the channel.
 *
 * The per-day projection:
 *   1. For each event row, compute base value = SEVERITY_VALUE[severity].
 *   2. Apply amplification (1.5x) or damping (0.5x) based on venue's
 *      DC-region status.
 *   3. Stamp value onto every day inside [start_date, end_date].
 *   4. Apply linear fade for POST_EVENT_FADE_DAYS after end_date so the
 *      effect tail isn't a hard cliff.
 *   5. When two events overlap (rare but possible), the final value is
 *      the MAX across overlapping events — a shutdown during a debt-
 *      ceiling crisis isn't double-counted.
 */
export async function loadGovernmentSeries(
  supabase: SupabaseClient,
  windowStart: Date,
  windowEnd: Date,
  venueId: string,
): Promise<ExternalChannelSeries[]> {
  const startIso = windowStart.toISOString().slice(0, 10)
  const endIso = windowEnd.toISOString().slice(0, 10)

  // Pull events whose [start, end] overlap the window. NULL end_date
  // means "ongoing" — treat as overlapping if start_date <= window end.
  const { data, error } = await supabase
    .from('government_events')
    .select('event_type, start_date, end_date, region, severity')
    .lte('start_date', endIso)
    .or(`end_date.is.null,end_date.gte.${startIso}`)

  if (error) {
    console.warn('[gov-events] load failed:', error.message)
    return []
  }

  const rows = (data ?? []) as GovEventRow[]
  if (rows.length === 0) return []

  // Resolve venue's DC-region status once per call.
  const facts = await loadVenueGeoFacts(supabase, venueId)
  const isDC = isDCRegionVenue(facts)
  const venueScale = isDC ? DC_AMPLIFICATION : NON_DC_DAMPING

  // Project onto a per-day map; collapse overlapping rows by MAX.
  const perDay = new Map<string, number>()
  for (const r of rows) {
    const baseValue = SEVERITY_VALUE[r.severity] ?? 0.25
    if (baseValue === 0) continue
    const eventStart = new Date(`${r.start_date}T00:00:00Z`)
    const eventEnd = r.end_date
      ? new Date(`${r.end_date}T00:00:00Z`)
      : new Date(eventStart) // single-day if no end_date
    const fadeEnd = new Date(eventEnd)
    fadeEnd.setUTCDate(fadeEnd.getUTCDate() + POST_EVENT_FADE_DAYS)

    const cursor = new Date(Math.max(eventStart.getTime(), windowStart.getTime()))
    const stop = new Date(Math.min(fadeEnd.getTime(), windowEnd.getTime()))
    while (cursor.getTime() <= stop.getTime()) {
      const dayKey = toDayKey(cursor)
      let dayValue: number
      if (cursor.getTime() <= eventEnd.getTime()) {
        // During the event itself — full base value.
        dayValue = baseValue
      } else {
        // Linear fade: 1 day after end → (POST_EVENT_FADE_DAYS-1)/POST_EVENT_FADE_DAYS;
        // POST_EVENT_FADE_DAYS days after → 0.
        const daysAfter = Math.round(
          (cursor.getTime() - eventEnd.getTime()) / 86_400_000,
        )
        const remaining = Math.max(0, POST_EVENT_FADE_DAYS - daysAfter)
        dayValue = baseValue * (remaining / POST_EVENT_FADE_DAYS)
      }
      const scaled = dayValue * venueScale
      const prev = perDay.get(dayKey) ?? 0
      if (scaled > prev) perDay.set(dayKey, scaled)
      cursor.setUTCDate(cursor.getUTCDate() + 1)
    }
  }

  if (perDay.size === 0) return []

  const points: SeriesPoint[] = Array.from(perDay.entries())
    .map(([dayKey, value]) => ({ dayKey, value }))
    .sort((a, b) => a.dayKey.localeCompare(b.dayKey))

  return [{ channel: 'government_signals', points }]
}
