/**
 * Weather × tour cancellation correlation insight (T5-Rixey-ZZ / Z7).
 *
 * Hypothesis the user flagged after the Feb 2026 weather slowed Rixey's
 * tours: when the weather is bad on a scheduled tour day, cancellations
 * spike. The platform should detect this from the join of `tours` x
 * `weather_data` and surface an actionable insight ("offer indoor-rain
 * upgrade upsell + 48h weather-check + reschedule offer").
 *
 * Pipeline:
 *   1. Pull tours with scheduled_at in the last N days for the venue.
 *   2. Pull weather_data covering the same window.
 *   3. Bucket each tour by the weather conditions on its scheduled_at::date:
 *        clear / light_rain / heavy_rain / snow / extreme_cold /
 *        extreme_heat / severe_weather / unknown
 *   4. Compute cancellation_rate per bucket (cancelled+no_show / total).
 *   5. If any bad-weather bucket has cancellation_rate >= 1.5x baseline
 *      AND >= MIN_BUCKET_TOURS samples, persist a 'correlation_narration'
 *      insight with signal_class='weather_x_venue'.
 *
 * Skip-and-stop rules (don't fabricate):
 *   - venue has no lat/lon AND no NOAA station id → return data_gated.
 *   - weather_data has zero rows in the window → return data_gated.
 *   - tours has < MIN_TOTAL_TOURS in the window → return data_gated.
 *
 * Per Z7 brief: stub the service when weather_data is unavailable,
 * emit the insight when it lands.
 */

import type { SupabaseClient } from '@supabase/supabase-js'

export interface WeatherCancellationResult {
  ok: boolean
  /** True when the service intentionally returned without persisting an
   *  insight because upstream data is missing or insufficient. The caller
   *  should NOT treat this as an error. */
  dataGated?: boolean
  /** Why the service gated, when dataGated=true. */
  gatedReason?:
    | 'venue_no_geo'
    | 'no_weather_data'
    | 'insufficient_tours'
    | 'no_signal'
  /** Per-bucket diagnostics surfaced in the cron log + (when not gated)
   *  in the persisted insight's data_points payload. */
  buckets?: Record<string, { tours: number; cancellations: number; rate: number }>
  /** Baseline cancellation rate across all buckets (cancelled / total). */
  baselineRate?: number
  /** Insight written, when the signal cleared the threshold. */
  insightId?: string
}

interface TourRow {
  id: string
  scheduled_at: string | null
  outcome: string | null
  cancellation_reason: string | null
}

interface WeatherRow {
  date: string
  high_temp: number | null
  low_temp: number | null
  precipitation: number | null
  conditions: string | null
}

const DEFAULT_LOOKBACK_DAYS = 365
const MIN_TOTAL_TOURS = 20
const MIN_BUCKET_TOURS = 5
/** Multiplier above baseline that triggers the insight. */
const TRIGGER_MULTIPLIER = 1.5

/** Bucket the weather conditions for a single day. */
function bucketWeather(w: WeatherRow): string {
  // Severe-weather wins over precipitation.
  const cond = (w.conditions ?? '').toLowerCase()
  if (cond.includes('thunderstorm') || cond.includes('tornado') || cond.includes('hurricane')) {
    return 'severe_weather'
  }
  if (cond.includes('snow')) return 'snow'

  const precip = w.precipitation ?? 0
  const high = w.high_temp ?? null
  const low = w.low_temp ?? null

  if (precip >= 1.0) return 'heavy_rain'
  if (precip >= 0.25) return 'light_rain'
  if (low != null && low < 25) return 'extreme_cold'
  if (high != null && high > 95) return 'extreme_heat'
  return 'clear'
}

/**
 * Determine whether a tour was a cancellation-style outcome. We bucket
 * cancelled + no_show together because both indicate the tour didn't
 * happen as scheduled (which is what weather affects). 'rescheduled'
 * is NOT counted as a cancellation — a successful reschedule is the
 * weather-mitigation outcome we want to encourage.
 */
function isCancellationOutcome(t: TourRow): boolean {
  if (!t.outcome) return false
  return t.outcome === 'cancelled' || t.outcome === 'no_show'
}

/**
 * Run the weather × cancellation analysis for a venue. Pure read +
 * compute; the caller (cron entry) decides whether to persist via the
 * insights pipeline.
 *
 * Returns dataGated=true when the upstream data isn't there yet, so the
 * cron can log a clean "skipped, waiting for data" instead of reporting
 * a false-clean run.
 */
export async function analyzeWeatherCancellations(
  supabase: SupabaseClient,
  venueId: string,
  opts: { lookbackDays?: number } = {},
): Promise<WeatherCancellationResult> {
  const lookbackDays = opts.lookbackDays ?? DEFAULT_LOOKBACK_DAYS
  const now = new Date()
  const start = new Date(now.getTime() - lookbackDays * 86_400_000)
  const startIso = start.toISOString().slice(0, 10)
  const endIso = now.toISOString().slice(0, 10)

  // Gate 1: venue has geo (otherwise no weather_data could exist).
  const { data: venue } = await supabase
    .from('venues')
    .select('latitude, longitude, noaa_station_id')
    .eq('id', venueId)
    .maybeSingle()
  if (!venue) {
    return { ok: false, dataGated: true, gatedReason: 'venue_no_geo' }
  }
  if (
    (venue.latitude == null || venue.longitude == null) &&
    !venue.noaa_station_id
  ) {
    return { ok: true, dataGated: true, gatedReason: 'venue_no_geo' }
  }

  // Gate 2: weather_data has rows in the window for this venue.
  const { data: weatherRowsRaw } = await supabase
    .from('weather_data')
    .select('date, high_temp, low_temp, precipitation, conditions')
    .eq('venue_id', venueId)
    .gte('date', startIso)
    .lte('date', endIso)
  const weatherRows = (weatherRowsRaw ?? []) as WeatherRow[]
  if (weatherRows.length === 0) {
    return { ok: true, dataGated: true, gatedReason: 'no_weather_data' }
  }

  const weatherByDate = new Map<string, WeatherRow>()
  for (const w of weatherRows) {
    // weather_data.date may be a date string OR a timestamp; normalize.
    const day = String(w.date).slice(0, 10)
    weatherByDate.set(day, w)
  }

  // Gate 3: enough tours to compute meaningful rates.
  const { data: tourRowsRaw } = await supabase
    .from('tours')
    .select('id, scheduled_at, outcome, cancellation_reason')
    .eq('venue_id', venueId)
    .gte('scheduled_at', start.toISOString())
    .lte('scheduled_at', now.toISOString())
    .not('scheduled_at', 'is', null)
  const tourRows = (tourRowsRaw ?? []) as TourRow[]
  if (tourRows.length < MIN_TOTAL_TOURS) {
    return { ok: true, dataGated: true, gatedReason: 'insufficient_tours' }
  }

  // Bucketize each tour by the weather of its scheduled_at::date.
  const buckets: Record<string, { tours: number; cancellations: number; rate: number }> = {}
  let totalTours = 0
  let totalCancellations = 0
  for (const t of tourRows) {
    if (!t.scheduled_at) continue
    const day = t.scheduled_at.slice(0, 10)
    const w = weatherByDate.get(day)
    if (!w) continue // tour day with no weather observation — skip
    const bucket = bucketWeather(w)
    if (!buckets[bucket]) buckets[bucket] = { tours: 0, cancellations: 0, rate: 0 }
    buckets[bucket].tours++
    totalTours++
    if (isCancellationOutcome(t)) {
      buckets[bucket].cancellations++
      totalCancellations++
    }
  }

  if (totalTours < MIN_TOTAL_TOURS) {
    return {
      ok: true,
      dataGated: true,
      gatedReason: 'insufficient_tours',
      buckets,
    }
  }

  for (const b of Object.keys(buckets)) {
    const e = buckets[b]
    e.rate = e.tours > 0 ? e.cancellations / e.tours : 0
  }
  const baselineRate = totalTours > 0 ? totalCancellations / totalTours : 0

  // Find the worst bad-weather bucket that meets the multiplier + sample
  // threshold. We DON'T trigger on 'clear' (the baseline) or 'unknown'.
  const triggerBucket = Object.entries(buckets)
    .filter(([k, v]) => k !== 'clear' && v.tours >= MIN_BUCKET_TOURS)
    .filter(([, v]) => baselineRate > 0 && v.rate >= baselineRate * TRIGGER_MULTIPLIER)
    .sort(([, a], [, b]) => b.rate - a.rate)[0]

  if (!triggerBucket) {
    return {
      ok: true,
      dataGated: true,
      gatedReason: 'no_signal',
      buckets,
      baselineRate,
    }
  }

  const [bucketName, bucketStats] = triggerBucket

  // Persist insight via the centralised intelligence_insights table.
  // We use the older direct-row pattern (rather than insights/persist.ts
  // which requires LLM-narration shape) because the title + body here
  // are deterministically composed — no LLM-numbers-guard concerns.
  const ratePct = Math.round(bucketStats.rate * 100)
  const baselinePct = Math.round(baselineRate * 100)
  const bucketLabel = humanBucket(bucketName)
  const title = `Weather drives tour cancellations: ${ratePct}% cancel rate on ${bucketLabel} days vs ${baselinePct}% baseline`
  const body =
    `Across the last ${lookbackDays} days, ${bucketStats.tours} tours were `
    + `scheduled on ${bucketLabel} days; ${bucketStats.cancellations} cancelled or `
    + `no-showed (${ratePct}%). Baseline cancellation rate across all weather is `
    + `${baselinePct}% over ${totalTours} tours. Weather is materially affecting `
    + `tour completion — and the recovery offer that converts a weather-cancel into `
    + `a reschedule (vs a hard loss) is a high-leverage script.`
  const action =
    'Add an indoor-rain-plan upgrade upsell to outdoor-tour confirmation emails. '
    + 'For tours scheduled within 48 hours, run a weather check + send a proactive '
    + 'reschedule offer when severe weather is forecast — converts a forced cancel '
    + 'into a coordinator-driven save.'

  const dataPoints = {
    signal_class: 'weather_x_venue',
    lookback_days: lookbackDays,
    total_tours: totalTours,
    total_cancellations: totalCancellations,
    baseline_rate: baselineRate,
    trigger_bucket: bucketName,
    trigger_bucket_tours: bucketStats.tours,
    trigger_bucket_cancellations: bucketStats.cancellations,
    trigger_bucket_rate: bucketStats.rate,
    multiplier_vs_baseline: baselineRate > 0 ? bucketStats.rate / baselineRate : null,
    buckets,
    pair_key: `weather_${bucketName}|tour_cancellations`,
  }

  // Use the fnv32 helper inline for context_id derivation. Keep
  // deterministic so re-runs upsert the same row.
  const contextId = buildContextUuidV5(
    `weather-cancellation:${venueId}:${bucketName}`,
  )

  // Lookup-then-insert/update against (venue_id, insight_type, context_id)
  // — same pattern persist.ts uses.
  const { data: existing } = await supabase
    .from('intelligence_insights')
    .select('id')
    .eq('venue_id', venueId)
    .eq('insight_type', 'correlation_narration')
    .eq('context_id', contextId)
    .maybeSingle()

  const row = {
    venue_id: venueId,
    insight_type: 'correlation_narration',
    category: 'market',
    title,
    body,
    action,
    priority: bucketStats.rate >= baselineRate * 2 ? 'high' : 'medium',
    confidence: Math.min(0.95, 0.5 + Math.min(0.3, bucketStats.tours / 100)),
    data_points: dataPoints,
    status: 'new',
    context_id: contextId,
  }

  let insightId: string | undefined
  if (existing) {
    const { data: updated, error: updErr } = await supabase
      .from('intelligence_insights')
      .update({ ...row, updated_at: new Date().toISOString() })
      .eq('id', existing.id as string)
      .select('id')
      .single()
    if (updErr || !updated) {
      console.error('[weather-cancellation] update failed:', updErr?.message)
      return { ok: false, buckets, baselineRate }
    }
    insightId = updated.id as string
  } else {
    const { data: inserted, error: insErr } = await supabase
      .from('intelligence_insights')
      .insert(row)
      .select('id')
      .single()
    if (insErr || !inserted) {
      console.error('[weather-cancellation] insert failed:', insErr?.message)
      return { ok: false, buckets, baselineRate }
    }
    insightId = inserted.id as string
  }

  return {
    ok: true,
    buckets,
    baselineRate,
    insightId,
  }
}

function humanBucket(bucket: string): string {
  switch (bucket) {
    case 'heavy_rain': return 'heavy-rain'
    case 'light_rain': return 'light-rain'
    case 'snow': return 'snow'
    case 'severe_weather': return 'severe-weather'
    case 'extreme_cold': return 'extreme-cold'
    case 'extreme_heat': return 'extreme-heat'
    default: return bucket
  }
}

/**
 * Deterministic UUID v5 derivation for the insight's context_id. Same
 * input → same UUID forever. Mirrors the helper in correlation-engine.ts
 * so the two services use the same namespace convention.
 */
const WEATHER_CANCEL_NAMESPACE = 'a3f1c2d4-5e6b-4f7d-9a0c-3b1d2e4f5a6b'

function buildContextUuidV5(name: string): string {
  // Use Node's crypto subtle import in a way that doesn't break edge runtime.
  // We import lazily inside the function to keep the module import-safe in
  // edge contexts that don't ship node:crypto.
  const { createHash } = require('node:crypto') as typeof import('node:crypto')
  const nsHex = WEATHER_CANCEL_NAMESPACE.replace(/-/g, '')
  const nsBytes = Buffer.from(nsHex, 'hex')
  const nameBytes = Buffer.from(name, 'utf8')
  const hash = createHash('sha1').update(Buffer.concat([nsBytes, nameBytes])).digest()
  const bytes = Buffer.from(hash.subarray(0, 16))
  bytes[6] = (bytes[6] & 0x0f) | 0x50
  bytes[8] = (bytes[8] & 0x3f) | 0x80
  const hex = bytes.toString('hex')
  return (
    hex.slice(0, 8) + '-' +
    hex.slice(8, 12) + '-' +
    hex.slice(12, 16) + '-' +
    hex.slice(16, 20) + '-' +
    hex.slice(20, 32)
  )
}

/**
 * Batch entry point — runs analyzeWeatherCancellations for every active
 * venue, swallows per-venue errors. Designed to be called from a cron
 * handler; same shape as computeCorrelationsAllVenues.
 */
export async function analyzeWeatherCancellationsAllVenues(
  supabase: SupabaseClient,
): Promise<Record<string, WeatherCancellationResult>> {
  const { data: venues } = await supabase
    .from('venues')
    .select('id')
    .eq('status', 'active')
  const out: Record<string, WeatherCancellationResult> = {}
  for (const v of venues ?? []) {
    const id = v.id as string
    try {
      out[id] = await analyzeWeatherCancellations(supabase, id)
    } catch (err) {
      console.error('[weather-cancellation]', id, err instanceof Error ? err.message : err)
      out[id] = { ok: false }
    }
  }
  return out
}
