/**
 * Weather x tour cancellation correlation insight (T5-Rixey-ZZ / Z7).
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
 *      AND >= MIN_BUCKET_TOURS samples, the deterministic detector
 *      composes a struct of the numbers and we hand it to a Sonnet
 *      narrator. The narrator produces {title, body, action} in
 *      coordinator voice, numbers-guarded against the exact bucket
 *      counts. The persisted row uses insight_type='correlation_narration'
 *      with signal_class='weather_x_venue', identical shape to the real
 *      LLM-narrated correlation rows from correlation-narration.ts.
 *
 * Skip-and-stop rules (don't fabricate):
 *   - venue has no lat/lon AND no NOAA station id -> data_gated.
 *   - weather_data has zero rows in the window -> data_gated.
 *   - tours has < MIN_TOTAL_TOURS in the window -> data_gated.
 *
 * AI-VS-TEMPLATED-AUDIT Finding #3 (2026-05-09): the prior persist path
 * was a direct intelligence_insights insert with deterministic title +
 * body + action strings, written under insight_type='correlation_narration'
 * (the same type real LLM-narrated correlation rows use). Coordinators
 * filtering /intel/insights on "Correlation" got a mix of real Sonnet
 * narration and template strings. We now route through a Sonnet narrator
 * with the SAME hybrid contract used by correlation-narration.ts:
 *   - Deterministic detector keeps doing the math (the math IS the truth).
 *   - LLM takes the struct and writes 2-3 sentences in coordinator voice.
 *   - Numbers-guard rejects any LLM number not present in the struct.
 *   - Cost-ceiling gate (gateForBrainCall) runs BEFORE the Sonnet call.
 *   - Fall back to the existing deterministic template when the gate is
 *     closed OR the LLM call fails OR the numbers-guard rejects.
 *
 * The persist path moves from a direct insert (l. 280-318 in the prior
 * version) to insights/persist.ts, which already enforces the
 * cache-key + numbers-guard contract every other LLM-narrated insight
 * uses.
 */

import type { SupabaseClient } from '@supabase/supabase-js'
import { callAIJson, CLAUDE_MODEL } from '@/lib/ai/client'
import { gateForBrainCall } from '@/lib/services/cost-ceiling'
import { redactError } from '@/lib/observability/redact'
import { confidenceFor, buildCacheKey } from './confidence'
import { persistInsight } from './persist'
import type { ClassicalEvidence, InsightNarration } from './types'

export const WEATHER_CANCELLATION_NARRATION_PROMPT_VERSION =
  'weather-cancellation-narration.v1'

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
  /** Provenance of the persisted narration. 'ai' when Sonnet wrote it,
   *  'template' when the deterministic fallback fired (cost-ceiling
   *  closed, LLM failed, or numbers-guard rejected). */
  narrationSource?: 'ai' | 'template'
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
 * is NOT counted as a cancellation: a successful reschedule is the
 * weather-mitigation outcome we want to encourage.
 */
function isCancellationOutcome(t: TourRow): boolean {
  if (!t.outcome) return false
  return t.outcome === 'cancelled' || t.outcome === 'no_show'
}

interface WeatherCancellationStruct {
  lookbackDays: number
  totalTours: number
  totalCancellations: number
  baselineRatePct: number
  triggerBucket: string
  triggerBucketLabel: string
  triggerBucketTours: number
  triggerBucketCancellations: number
  triggerBucketRatePct: number
  multiplierVsBaseline: number
}

/**
 * Build the deterministic fallback narration. Used when the cost ceiling
 * closes the gate, the LLM fails, or the numbers-guard rejects the LLM
 * output. Every number references the struct; this body MUST pass the
 * numbers-guard or the whole surface goes silent.
 */
function buildTemplateFallbackNarration(s: WeatherCancellationStruct): InsightNarration {
  const title =
    `Weather drives tour cancellations: ${s.triggerBucketRatePct}% cancel rate on ${s.triggerBucketLabel} days vs ${s.baselineRatePct}% baseline`
  const body =
    `Across the last ${s.lookbackDays} days, ${s.triggerBucketTours} tours were `
    + `scheduled on ${s.triggerBucketLabel} days; ${s.triggerBucketCancellations} cancelled or `
    + `no-showed (${s.triggerBucketRatePct}%). Baseline cancellation rate across all weather is `
    + `${s.baselineRatePct}% over ${s.totalTours} tours. Weather is materially affecting `
    + `tour completion, and the recovery offer that converts a weather-cancel into `
    + `a reschedule (vs a hard loss) is a high-leverage script.`
  const action =
    'Add an indoor-rain-plan upgrade upsell to outdoor-tour confirmation emails. '
    + 'For tours scheduled within 48 hours, run a weather check and send a proactive '
    + 'reschedule offer when severe weather is forecast: this converts a forced cancel '
    + 'into a coordinator-driven save.'
  return { title, body, action }
}

/**
 * Sonnet narrator. Takes the deterministic struct and produces a
 * coordinator-voice narration grounded in the exact numbers the
 * detector computed. Returns null on any failure so the caller can
 * fall back to the deterministic template.
 *
 * Numbers contract: the narrator may reference triggerBucketRatePct,
 * baselineRatePct, lookbackDays, totalTours, totalCancellations,
 * triggerBucketTours, triggerBucketCancellations, multiplierVsBaseline.
 * The numbers-guard at persist time enforces this; the prompt asks
 * the LLM to stay within it.
 */
async function narrateWithSonnet(
  venueId: string,
  s: WeatherCancellationStruct,
): Promise<InsightNarration | null> {
  const systemPrompt = `You are explaining a weather-driven tour-cancellation pattern to a wedding
venue coordinator who is not a statistician. Output JSON with:
  - title: short headline (max ~100 chars). Reference the bucket label
    plainly (e.g. "heavy-rain days" or "snow days"). Include the bucket
    cancel rate AND the baseline cancel rate so the contrast is
    obvious. No statistical jargon (no "r=" / "p<" / "Pearson").
  - body: 2-3 plain-English sentences. Frame the story as a coordinator
    would understand it: bad weather days cancel more often than
    baseline, the gap is large enough to act on, and the venue can
    recover most of those by offering a reschedule before they hard-cancel.
  - action: ONE specific thing the coordinator should do this week.
    Concrete and named (e.g. "add an indoor-rain plan upsell to
    outdoor-tour confirmation emails", "run a 48h weather check on
    upcoming tours and proactively offer reschedule").

CRITICAL RULES:
- Never invent numbers. The ONLY numbers you may reference are the
  ones listed in the user prompt: bucket cancel rate %, baseline cancel
  rate %, total tours in window, total cancellations in window, bucket
  tour count, bucket cancellation count, lookback days, multiplier vs
  baseline. No other percentages, ratios, or counts.
- Never claim causation. Use "drives", "tracks with", "elevated on".
  The pattern is a correlation between weather conditions and tour
  outcomes, not a proof of mechanism.
- Never name specific couples or vendors.
- Use neutral, factual coordinator voice. No exclamation points.
- 2-3 sentences in body. Coordinator-readable, not engineer-readable.
- No em dashes anywhere.`

  const userPrompt = `WEATHER x TOUR CANCELLATION PATTERN

Bucket: ${s.triggerBucketLabel} (raw: ${s.triggerBucket})
Lookback window: ${s.lookbackDays} days
Total tours in window: ${s.totalTours}
Total cancellations + no-shows in window: ${s.totalCancellations}
Baseline cancel rate (all weather): ${s.baselineRatePct}%

Bucket-specific stats:
- Tours scheduled on ${s.triggerBucketLabel} days: ${s.triggerBucketTours}
- Of those, cancelled or no-showed: ${s.triggerBucketCancellations}
- Bucket cancel rate: ${s.triggerBucketRatePct}%
- Multiplier vs baseline: ${s.multiplierVsBaseline.toFixed(2)}x

Compose the JSON narration. 2-3 sentence body, plain English, no
made-up numbers, no em dashes.`

  try {
    const result = await callAIJson<Partial<InsightNarration>>({
      systemPrompt,
      userPrompt,
      maxTokens: 360,
      temperature: 0.4,
      venueId,
      taskType: 'weather_cancellation_narration',
      tier: 'sonnet',
      promptVersion: WEATHER_CANCELLATION_NARRATION_PROMPT_VERSION,
    })
    if (!result.title || !result.body) return null
    return {
      title: result.title,
      body: result.body,
      action: result.action ?? null,
    }
  } catch (err) {
    console.warn(
      '[weather-cancellation] LLM narration failed:',
      redactError(err),
    )
    return null
  }
}

/**
 * Run the weather x cancellation analysis for a venue. Pure read +
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
    if (!w) continue // tour day with no weather observation: skip
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

  const ratePct = Math.round(bucketStats.rate * 100)
  const baselinePct = Math.round(baselineRate * 100)
  const bucketLabel = humanBucket(bucketName)
  const multiplierVsBaseline = baselineRate > 0 ? bucketStats.rate / baselineRate : 0

  const struct: WeatherCancellationStruct = {
    lookbackDays,
    totalTours,
    totalCancellations,
    baselineRatePct: baselinePct,
    triggerBucket: bucketName,
    triggerBucketLabel: bucketLabel,
    triggerBucketTours: bucketStats.tours,
    triggerBucketCancellations: bucketStats.cancellations,
    triggerBucketRatePct: ratePct,
    multiplierVsBaseline,
  }

  // Numbers-guard allowlist: every primitive a narration may reference.
  // Both raw + rounded forms so phrasing variants ("42%" / "42") match.
  const multiplierRounded = Number(multiplierVsBaseline.toFixed(2))
  const allowedNumbers: Array<number | string> = [
    ratePct, baselinePct,
    lookbackDays, totalTours, totalCancellations,
    bucketStats.tours, bucketStats.cancellations,
    multiplierVsBaseline,
    multiplierRounded,
    Math.round(multiplierVsBaseline),
    Math.round(multiplierVsBaseline * 10) / 10,
    // Day-window phrasing: the LLM may say "the past year" but if it
    // says "365 days" that should match. Already covered by lookbackDays.
    // 48 (hours) is a fixed-action phrase the template uses; allow it
    // so the deterministic fallback's "within 48 hours" line passes
    // the guard.
    48,
  ]

  // Cost-ceiling gate (Stream B / T5-alpha.2). When closed, fall back
  // to the deterministic template so the surface still produces SOMETHING.
  let narration: InsightNarration | null = null
  let narrationSource: 'ai' | 'template' = 'template'
  const gate = await gateForBrainCall(venueId)
  if (gate.ok) {
    const llmNarration = await narrateWithSonnet(venueId, struct)
    if (llmNarration) {
      narration = llmNarration
      narrationSource = 'ai'
    }
  }
  if (!narration) {
    narration = buildTemplateFallbackNarration(struct)
    narrationSource = 'template'
  }

  // Stable cache key on the deterministic struct. Same struct -> same
  // key -> idempotent upsert; new bucket / new rate -> fresh narration.
  const cacheKey = buildCacheKey({
    bucket: bucketName,
    rate: ratePct,
    baseline: baselinePct,
    totalTours,
    multiplier: multiplierRounded,
  })

  const dataPoints = {
    signal_class: 'weather_x_venue',
    lookback_days: lookbackDays,
    total_tours: totalTours,
    total_cancellations: totalCancellations,
    baseline_rate: baselineRate,
    baseline_rate_pct: baselinePct,
    trigger_bucket: bucketName,
    trigger_bucket_label: bucketLabel,
    trigger_bucket_tours: bucketStats.tours,
    trigger_bucket_cancellations: bucketStats.cancellations,
    trigger_bucket_rate: bucketStats.rate,
    trigger_bucket_rate_pct: ratePct,
    multiplier_vs_baseline: multiplierVsBaseline,
    buckets,
    pair_key: `weather_${bucketName}|tour_cancellations`,
    narration_source: narrationSource,
  }

  const classical: ClassicalEvidence = {
    cacheKey,
    numbers: allowedNumbers,
    payload: dataPoints,
    sampleSize: bucketStats.tours,
    effectSize: Math.min(1, Math.max(0, multiplierVsBaseline - 1) / 2),
  }

  // Deterministic context_id derivation so re-runs collapse onto one row.
  const contextId = buildContextUuidV5(
    `weather-cancellation:${venueId}:${bucketName}`,
  )
  const conf = confidenceFor({
    sampleSize: classical.sampleSize,
    effectSize: classical.effectSize,
  })

  const persistResult = await persistInsight(supabase, {
    venueId,
    insightType: 'correlation_narration',
    contextId,
    category: 'market',
    surfaceLayer: 'on_demand',
    classical,
    narration,
    llmModelUsed: narrationSource === 'ai' ? CLAUDE_MODEL : 'template',
    promptVersionUsed: WEATHER_CANCELLATION_NARRATION_PROMPT_VERSION,
    confidence: conf.value,
    surfacePriority: bucketStats.tours * Math.max(1, multiplierVsBaseline),
    priority: bucketStats.rate >= baselineRate * 2 ? 'high' : 'medium',
  })

  if (!persistResult.ok) {
    // Numbers-guard rejected the LLM narration. Re-persist with the
    // deterministic template (which is constructed from struct numbers
    // only and is guaranteed to pass the guard).
    if (persistResult.numbersGuardViolations) {
      console.warn(
        '[weather-cancellation] numbers-guard rejected narration:',
        persistResult.numbersGuardViolations.map((v) => v.token).join(', '),
      )
    }
    const safeNarration = buildTemplateFallbackNarration(struct)
    const retry = await persistInsight(supabase, {
      venueId,
      insightType: 'correlation_narration',
      contextId,
      category: 'market',
      surfaceLayer: 'on_demand',
      classical: {
        ...classical,
        payload: { ...dataPoints, narration_source: 'template' },
      },
      narration: safeNarration,
      llmModelUsed: 'template',
      promptVersionUsed: WEATHER_CANCELLATION_NARRATION_PROMPT_VERSION,
      confidence: conf.value,
      surfacePriority: bucketStats.tours * Math.max(1, multiplierVsBaseline),
      priority: bucketStats.rate >= baselineRate * 2 ? 'high' : 'medium',
    })
    if (!retry.ok) {
      console.error('[weather-cancellation] template fallback persist also failed')
      return { ok: false, buckets, baselineRate, narrationSource: 'template' }
    }
    return {
      ok: true,
      buckets,
      baselineRate,
      insightId: retry.insightId,
      narrationSource: 'template',
    }
  }

  return {
    ok: true,
    buckets,
    baselineRate,
    insightId: persistResult.insightId,
    narrationSource,
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
 * input -> same UUID forever. Mirrors the helper in correlation-engine.ts
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
 * Batch entry point: runs analyzeWeatherCancellations for every active
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
      console.error('[weather-cancellation]', id, redactError(err))
      out[id] = { ok: false }
    }
  }
  return out
}
