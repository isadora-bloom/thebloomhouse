/**
 * NWS active-alerts loader (W49 / November plan wave 7).
 *
 * Replaces the dead keyword branch in weather-cancellation.ts's
 * `bucketWeather`: that function checked the venue's Open-Meteo
 * `conditions` string for the literal words "tornado" and "hurricane",
 * but Open-Meteo's weathercode mapping (weather.ts `weatherCodeToCondition`)
 * only ever produces "Clear sky" / "Partly cloudy" / "Fog" / "Drizzle" /
 * "Rain" / "Snow" / "Rain showers" / "Snow showers" / "Thunderstorm" /
 * "Unknown" — those two checks never fired.
 *
 * The National Weather Service publishes real severe-weather alerts
 * (tornado warnings, hurricane warnings, severe thunderstorm warnings,
 * blizzard warnings, etc.) for any US point, free, no API key:
 *
 *   GET https://api.weather.gov/alerts/active?point=<lat>,<lon>
 *
 * NWS policy requires a descriptive User-Agent identifying the
 * application and a contact (https://www.weather.gov/documentation/services-web-api
 * "Authentication"). We send one; requests without it are throttled or
 * rejected.
 *
 * Fail-closed contract: any network error, non-2xx response, or
 * malformed body returns `{ ok: false, alerts: [] }` — never throws,
 * never fabricates an alert. Callers that gate on "is there a severe
 * alert" get "no" on any doubt, not a guess.
 */

import type { SupabaseClient } from '@supabase/supabase-js'
import { redactError } from '@/lib/observability/redact'

const NWS_ALERTS_BASE = 'https://api.weather.gov/alerts/active'

// NWS asks every API consumer to identify itself. This is not a secret —
// it's the "please tell us who you are" contact NWS's own docs ask for.
const NWS_USER_AGENT = 'BloomHouseWeather/1.0 (ops@thebloomhouse.ai, https://thebloomhouse.ai)'

// -----------------------------------------------------------------------
// Types — the slice of the NWS GeoJSON alerts/active shape we consume.
// Full schema: https://api.weather.gov/openapi.json (AlertCollectionGeoJson)
// -----------------------------------------------------------------------

export interface NwsAlertFeatureProperties {
  id?: string
  event?: string | null
  severity?: string | null
  certainty?: string | null
  urgency?: string | null
  headline?: string | null
  description?: string | null
  instruction?: string | null
  areaDesc?: string | null
  status?: string | null
  messageType?: string | null
  onset?: string | null
  ends?: string | null
  expires?: string | null
}

interface NwsAlertFeature {
  id?: string
  properties?: NwsAlertFeatureProperties
}

interface NwsAlertsResponse {
  features?: NwsAlertFeature[]
}

/** Normalised, DB-shaped alert. Every field the caller needs, nothing raw. */
export interface ParsedNwsAlert {
  nwsId: string
  event: string | null
  severity: string | null
  certainty: string | null
  urgency: string | null
  headline: string | null
  description: string | null
  instruction: string | null
  areaDesc: string | null
  status: string | null
  messageType: string | null
  onset: string | null
  ends: string | null
  expires: string | null
}

/**
 * Typed, defensive parser for the alerts/active response body. Never
 * throws — malformed or missing fields are skipped/nulled rather than
 * crashing the caller. Exported standalone so it can be unit-tested
 * against a real fixture without a network call.
 */
export function parseNwsAlertsResponse(json: unknown): ParsedNwsAlert[] {
  if (!json || typeof json !== 'object') return []
  const body = json as NwsAlertsResponse
  if (!Array.isArray(body.features)) return []

  const out: ParsedNwsAlert[] = []
  for (const feature of body.features) {
    if (!feature || typeof feature !== 'object') continue
    const props = feature.properties
    // The alert's stable id. NWS puts it in properties.id (a URI) and
    // mirrors it as the feature's top-level id; prefer properties.id,
    // fall back to the feature id, skip alerts with neither (can't
    // dedupe/upsert without a stable key).
    const nwsId = (props?.id ?? feature.id ?? '').trim()
    if (!nwsId) continue

    out.push({
      nwsId,
      event: normStr(props?.event),
      severity: normStr(props?.severity),
      certainty: normStr(props?.certainty),
      urgency: normStr(props?.urgency),
      headline: normStr(props?.headline),
      description: normStr(props?.description),
      instruction: normStr(props?.instruction),
      areaDesc: normStr(props?.areaDesc),
      status: normStr(props?.status),
      messageType: normStr(props?.messageType),
      onset: normStr(props?.onset),
      ends: normStr(props?.ends),
      expires: normStr(props?.expires),
    })
  }
  return out
}

function normStr(v: unknown): string | null {
  if (typeof v !== 'string') return null
  const t = v.trim()
  return t.length > 0 ? t : null
}

// -----------------------------------------------------------------------
// Fetch wrapper — fails closed.
// -----------------------------------------------------------------------

export interface FetchAlertsResult {
  ok: boolean
  alerts: ParsedNwsAlert[]
  /** Set when ok=false, for the caller's log line. */
  error?: string
}

/**
 * Fetch currently-active NWS alerts for a lat/lon point. Fails closed:
 * network failure, non-2xx, or an unparseable body all resolve to
 * `{ ok: false, alerts: [] }` with the reason logged (redacted) — never
 * thrown, never a fabricated alert.
 */
export async function fetchActiveAlertsForPoint(
  lat: number,
  lon: number,
): Promise<FetchAlertsResult> {
  const url = `${NWS_ALERTS_BASE}?point=${encodeURIComponent(lat.toFixed(4))},${encodeURIComponent(lon.toFixed(4))}`
  try {
    const res = await fetch(url, {
      headers: {
        'User-Agent': NWS_USER_AGENT,
        Accept: 'application/geo+json',
      },
    })
    if (!res.ok) {
      const bodyText = await res.text().catch(() => '')
      const reason = `NWS alerts ${res.status}: ${bodyText.slice(0, 300)}`
      console.warn('[nws-alerts] fetch failed, failing closed:', reason)
      return { ok: false, alerts: [], error: reason }
    }
    const json = await res.json()
    const alerts = parseNwsAlertsResponse(json)
    return { ok: true, alerts }
  } catch (err) {
    console.warn('[nws-alerts] fetch threw, failing closed:', redactError(err))
    return {
      ok: false,
      alerts: [],
      error: err instanceof Error ? err.message : String(err),
    }
  }
}

// -----------------------------------------------------------------------
// Persistence — venue lookup + upsert into weather_alerts (mig 404).
// -----------------------------------------------------------------------

export interface RefreshVenueAlertsResult {
  ok: boolean
  dataGated?: boolean
  gatedReason?: 'venue_no_geo' | 'fetch_failed'
  alertCount: number
  deactivatedCount: number
}

/**
 * Refresh the persisted alert set for one venue: fetch current NWS
 * active alerts for its coordinates, upsert them (keyed on
 * (venue_id, nws_id)), and flip `is_active=false` on any previously-
 * active row that did not come back this time (expired/cancelled).
 * Rows are NEVER deleted — the cancellation analyzer joins historical
 * tour dates against past alert windows, so history has to persist
 * past expiry.
 */
export async function refreshVenueAlerts(
  supabase: SupabaseClient,
  venueId: string,
): Promise<RefreshVenueAlertsResult> {
  const { data: venue } = await supabase
    .from('venues')
    .select('latitude, longitude')
    .eq('id', venueId)
    .maybeSingle()

  if (!venue || venue.latitude == null || venue.longitude == null) {
    return { ok: true, dataGated: true, gatedReason: 'venue_no_geo', alertCount: 0, deactivatedCount: 0 }
  }

  const fetchResult = await fetchActiveAlertsForPoint(
    Number(venue.latitude),
    Number(venue.longitude),
  )
  if (!fetchResult.ok) {
    // Fail closed: persist nothing this run. Existing rows are left
    // exactly as they were — an upstream outage should never look like
    // "the alert cleared."
    return { ok: false, dataGated: true, gatedReason: 'fetch_failed', alertCount: 0, deactivatedCount: 0 }
  }

  const alerts = fetchResult.alerts
  const seenIds = new Set(alerts.map((a) => a.nwsId))

  if (alerts.length > 0) {
    const rows = alerts.map((a) => ({
      venue_id: venueId,
      nws_id: a.nwsId,
      event: a.event,
      severity: a.severity,
      certainty: a.certainty,
      urgency: a.urgency,
      headline: a.headline,
      description: a.description,
      instruction: a.instruction,
      area_desc: a.areaDesc,
      status: a.status,
      message_type: a.messageType,
      onset: a.onset,
      ends: a.ends,
      expires: a.expires,
      is_active: true,
      fetched_at: new Date().toISOString(),
    }))
    const { error: upsertErr } = await supabase
      .from('weather_alerts')
      .upsert(rows, { onConflict: 'venue_id,nws_id' })
    if (upsertErr) {
      console.error('[nws-alerts] upsert failed:', upsertErr.message)
      return { ok: false, alertCount: 0, deactivatedCount: 0 }
    }
  }

  // Flip previously-active rows not present in this fetch to inactive.
  const { data: staleRows } = await supabase
    .from('weather_alerts')
    .select('id, nws_id')
    .eq('venue_id', venueId)
    .eq('is_active', true)

  const staleIds = (staleRows ?? [])
    .filter((r) => !seenIds.has((r as { nws_id: string }).nws_id))
    .map((r) => (r as { id: string }).id)

  let deactivatedCount = 0
  if (staleIds.length > 0) {
    const { error: deactErr } = await supabase
      .from('weather_alerts')
      .update({ is_active: false })
      .in('id', staleIds)
    if (!deactErr) deactivatedCount = staleIds.length
  }

  return { ok: true, alertCount: alerts.length, deactivatedCount }
}

/**
 * Batch entry point: refresh alerts for every venue with coordinates.
 * Designed to be called from the weather_forecast cron case alongside
 * the existing forecast fetch — no new cron entry.
 */
export async function refreshAllVenueAlerts(
  supabase: SupabaseClient,
): Promise<Record<string, RefreshVenueAlertsResult>> {
  const { data: venues } = await supabase
    .from('venues')
    .select('id')
    .not('latitude', 'is', null)
    .not('longitude', 'is', null)

  const out: Record<string, RefreshVenueAlertsResult> = {}
  for (const v of venues ?? []) {
    const id = (v as { id: string }).id
    try {
      out[id] = await refreshVenueAlerts(supabase, id)
    } catch (err) {
      console.error('[nws-alerts]', id, redactError(err))
      out[id] = { ok: false, alertCount: 0, deactivatedCount: 0 }
    }
  }
  return out
}

// -----------------------------------------------------------------------
// Read side — per-day severe-alert lookup for the cancellation analyzer.
// -----------------------------------------------------------------------

export interface AlertForDay {
  event: string | null
  severity: string | null
  onset: string | null
  ends: string | null
}

const SEVERE_EVENT_PATTERN =
  /tornado|hurricane|blizzard|ice storm|flash flood|severe thunderstorm|typhoon|extreme wind/i

/** True when an alert (real NWS severity/event) counts as "severe" for
 *  the cancellation bucketing. Severity-first (NWS's own classification),
 *  with an event-name fallback for alert types NWS doesn't always mark
 *  Severe/Extreme (some tornado watches come through as "Moderate"). */
export function isSevereAlert(alert: { event: string | null; severity: string | null }): boolean {
  const sev = (alert.severity ?? '').toLowerCase()
  if (sev === 'extreme' || sev === 'severe') return true
  const event = alert.event ?? ''
  return SEVERE_EVENT_PATTERN.test(event)
}

/**
 * Build a day -> most-severe-alert map for a venue across [startIso,
 * endIso]. Reads venue_id-scoped rows only (RLS-equivalent scoping at
 * the query level; service-role callers still filter explicitly so the
 * behaviour is correct even for a future non-service-role caller).
 * An alert covers every calendar day between its onset and ends (or
 * expires, when ends is null — many NWS watches never set `ends`).
 */
export async function getAlertDayMap(
  supabase: SupabaseClient,
  venueId: string,
  startIso: string,
  endIso: string,
): Promise<Map<string, AlertForDay>> {
  const { data } = await supabase
    .from('weather_alerts')
    .select('event, severity, onset, ends, expires')
    .eq('venue_id', venueId)
    .lte('onset', endIso)
    .or(`ends.gte.${startIso},ends.is.null`)

  const rows = (data ?? []) as Array<{
    event: string | null
    severity: string | null
    onset: string | null
    ends: string | null
    expires: string | null
  }>

  const byDate = new Map<string, AlertForDay>()
  const startMs = new Date(startIso).getTime()
  const endMs = new Date(endIso).getTime()

  for (const r of rows) {
    if (!r.onset) continue
    const onsetMs = new Date(r.onset).getTime()
    const endBoundIso = r.ends ?? r.expires ?? r.onset
    const endBoundMs = new Date(endBoundIso).getTime()
    if (Number.isNaN(onsetMs) || Number.isNaN(endBoundMs)) continue

    const rangeStartMs = Math.max(onsetMs, startMs)
    const rangeEndMs = Math.min(endBoundMs, endMs)
    if (rangeStartMs > rangeEndMs) continue

    // Cap the day-expansion — a data quality issue upstream (e.g. a
    // malformed `expires` far in the future) should never spin this
    // loop for years of dates.
    const MAX_DAYS = 45
    let cursor = new Date(rangeStartMs)
    cursor.setUTCHours(0, 0, 0, 0)
    let guard = 0
    while (cursor.getTime() <= rangeEndMs && guard < MAX_DAYS) {
      const day = cursor.toISOString().slice(0, 10)
      const existing = byDate.get(day)
      const candidate: AlertForDay = { event: r.event, severity: r.severity, onset: r.onset, ends: r.ends }
      if (!existing || (isSevereAlert(candidate) && !isSevereAlert(existing))) {
        byDate.set(day, candidate)
      }
      cursor = new Date(cursor.getTime() + 24 * 60 * 60 * 1000)
      guard++
    }
  }

  return byDate
}
