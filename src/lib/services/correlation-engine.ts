/**
 * Cross-channel correlation engine — Phase 8 Step 6.
 *
 * Hypothesis: when one channel spikes, others may spike or lag.
 * Examples from the brief:
 *   - Instagram engagement ↑ → website visits ↑ 3 days later →
 *     inquiries ↑ a week later
 *   - Wedding Wire profile views ↓ → inquiries ↓ two weeks later
 *
 * What this computes:
 *   1. Daily time series per "channel" for the venue over the past 90
 *      days. Channels:
 *      - inquiries: count of weddings.inquiry_date per day
 *      - {source}_{metric}: marketing_metric engagement_events grouped
 *        by source + metric, mapped by label to the day they represent
 *      - {source}_signals: tangential_signals created_at grouped by day
 *        per platform
 *   2. For every ordered pair (A, B) of channels, compute Pearson r
 *      at lags 0, 3, 5, 7, 14 days (B shifted forward relative to A).
 *      Pick the lag with highest |r|.
 *   3. If |r| >= 0.6 AND both series have >= 20 non-zero days in the
 *      shared window, record a named insight.
 *
 * Output: intelligence_insights rows with insight_type='correlation',
 * category='market'. /intel/insights already renders these.
 *
 * Purely read-only from external tables. Writes only to
 * intelligence_insights. Venue-scoped — caller passes the venueId.
 */

import type { SupabaseClient } from '@supabase/supabase-js'
import { createHash } from 'node:crypto'
import { loadFredSeries } from './external-context/fred'
import { loadCulturalMomentsSeries } from './external-context/cultural-moments'
import { loadCalendarSeries } from './external-context/calendar'
import { loadGovernmentSeries } from './external-context/government'
import { bonferroniCriticalR } from './external-context/stats'
import {
  formatSeriesLabel,
  classifySeries,
  classifyPair,
  rankMultiplierForPair,
  lagsForPair,
  type PairClass,
  type SignalClass,
} from '@/lib/utils/format-series-label'

/**
 * Stable namespace UUID for correlation context_id derivation. RFC 4122
 * §4.3 requires a namespace UUID for v5 derivation; this constant is
 * the project-private namespace for "correlation pair → uuid" mapping.
 * Generated once (random v4) and frozen — changing it would re-key
 * every existing correlation insight row, so don't.
 */
const CORRELATION_CONTEXT_NAMESPACE = 'd6b5c1fa-21d9-4f7d-9c3e-5d6e8a1b2c34'

/**
 * Derive a deterministic UUID from a name string using a name-based
 * scheme. Node's `crypto` doesn't ship a v5 helper directly, so we
 * implement RFC 4122 §4.3: SHA-1(namespace_bytes || name_bytes), take
 * the first 16 bytes, set version (5) and variant (RFC 4122) bits.
 *
 * Same input → same UUID forever, which is exactly what
 * intelligence_insights.context_id needs for the correlation upsert
 * key (channel pair + lag must collapse to one stable row across
 * cron runs). Bug it replaces (corr:<a>|<b> string crammed into a
 * uuid column) was P1: any insert on a real-prod schema would 22P02
 * before reaching the row.
 */
function uuidV5(name: string, namespace: string = CORRELATION_CONTEXT_NAMESPACE): string {
  const nsHex = namespace.replace(/-/g, '')
  const nsBytes = Buffer.from(nsHex, 'hex')
  const nameBytes = Buffer.from(name, 'utf8')
  const hash = createHash('sha1').update(Buffer.concat([nsBytes, nameBytes])).digest()
  const bytes = Buffer.from(hash.subarray(0, 16))
  // Set version to 5 (top 4 bits of byte 6).
  bytes[6] = (bytes[6] & 0x0f) | 0x50
  // Set variant to RFC 4122 (top 2 bits of byte 8 → 10).
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

const WINDOW_DAYS = 90
// Stream QQ (2026-05-02): widening hook. The default 90d window is the
// production cron cadence — it matches "last quarter of activity" and
// keeps the Bonferroni penalty bounded. But the WeddingWire-cancellation
// event landed in Feb 2025 so a 90d window run in May 2026 can't see
// it; for ad-hoc historical-significance runs we accept a windowDaysOverride
// up to MAX_WINDOW_DAYS. Cron path stays at 90d.
const MAX_WINDOW_DAYS = 730
// Stream YY (Z5): replaced fixed `[0, 3, 5, 7, 14]` with class-aware
// lag selection. The macro × venue Rixey demo ("mortgage rate affects
// wedding inquiries") doesn't land at 14d but lands strongly at 60-90d
// because consumer-behaviour transmission is slow. Per-pair-class lag
// sets live in `format-series-label.ts` (lagsForPair); the engine
// derives the BONFERRONI_LAG_COUNT from the union of all per-class
// lags to keep the family-wise correction honest across the wider
// search space.
const ALL_LAGS_UNION = [0, 7, 14, 30, 60, 90, 180]
// T5-Rixey-NN: lowered from 20 → 12. Stream MM verified that small venues
// (Rixey, ~191 inquiries / 90d) commonly have valid leading-indicator
// series with 16-18 nonzero days that the 20-day gate killed outright.
// 12-of-90 is still a real signal in Pearson terms (the Bonferroni-adjusted
// critical |r| threshold scales with surviving pair count, so noise pairs
// will still be filtered downstream). Document choice: prefer "true positive
// at the cost of one extra Bonferroni pair" over "guaranteed silence on
// small venues".
const MIN_NONZERO_DAYS = 12
// "Notable effect size" floor. The Bonferroni correction
// (correctedThresholdFor) is computed on top — final threshold =
// max(CORRELATION_THRESHOLD, Bonferroni-adjusted critical |r|).
// The floor exists because passing the family-wise statistical-
// significance bar (~0.4 for our typical channel count at n=90)
// doesn't guarantee a NOTABLE effect a coordinator should act on.
// Surfacing requirement is actionable correlations, not merely
// non-random ones.
const CORRELATION_THRESHOLD = 0.6
const FAMILY_ALPHA = 0.05

export interface CorrelationInsight {
  channelA: string
  channelB: string
  lagDays: number
  r: number
  headline: string
  body: string
  confidence: number
  /** Stream YY (Z1): pair-class taxonomy. Drives surface_priority and
   *  the /intel/macro-correlations filter chips. */
  pairClass: PairClass
  classA: SignalClass
  classB: SignalClass
  /** Stream YY (Z1): |r| × 100 × rankMultiplierForPair(pairClass).
   *  Persisted to intelligence_insights.surface_priority so coordinators
   *  see venue × macro insights above macro × macro noise. */
  rankScore: number
}

function pearson(xs: number[], ys: number[]): number {
  if (xs.length !== ys.length || xs.length < 3) return 0
  const n = xs.length
  const meanX = xs.reduce((a, b) => a + b, 0) / n
  const meanY = ys.reduce((a, b) => a + b, 0) / n
  let num = 0
  let dx2 = 0
  let dy2 = 0
  for (let i = 0; i < n; i++) {
    const dx = xs[i] - meanX
    const dy = ys[i] - meanY
    num += dx * dy
    dx2 += dx * dx
    dy2 += dy * dy
  }
  const denom = Math.sqrt(dx2 * dy2)
  if (denom === 0) return 0
  return num / denom
}

function dayKey(d: Date): string {
  return d.toISOString().split('T')[0]
}

function enumerateDays(start: Date, end: Date): string[] {
  const out: string[] = []
  const cur = new Date(start.getTime())
  while (cur <= end) {
    out.push(dayKey(cur))
    cur.setUTCDate(cur.getUTCDate() + 1)
  }
  return out
}

/**
 * Convert a marketing_metric label into an ISO day. Accepts 'Oct',
 * '2025-10', '2025-10-15', 'Oct 2025', '5/2', '05/02', '5/2/2025', etc.
 * Returns null if the label cannot be resolved to a concrete day
 * (abstract buckets are skipped rather than guessed).
 *
 * T5-followup-AA (2026-05-02): year-boundary correctness. The previous
 * implementation parsed unyearned labels by picking the most-recent
 * past occurrence of that month — which is correct mid-year but flips
 * incorrectly on year-boundary imports for `M/D` labels (a January
 * import seeing "12/15" should reach back to December of last year,
 * not project forward to December of THIS year). The fix: after
 * deriving a candidate date, if the candidate is more than 6 months
 * in the FUTURE relative to "now", subtract a year. Mirror case is
 * already handled by the past-bias rule. Mid-year `5/2` style labels
 * are unaffected because they fall well within the ±6-month band.
 *
 * `now` is parameterised so unit tests can pin a date.
 */
export function labelToDay(label: string, now: Date = new Date()): string | null {
  const s = label.trim()
  if (!s) return null
  // ISO day — already absolute, no boundary heuristic needed.
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return s
  // ISO month → first day of month — also already absolute.
  const iso = s.match(/^(\d{4})-(\d{2})$/)
  if (iso) return `${iso[1]}-${iso[2]}-01`
  // Slash forms: M/D, MM/DD, M/D/YYYY, MM/DD/YYYY.
  const slash = s.match(/^(\d{1,2})\/(\d{1,2})(?:\/(\d{2,4}))?$/)
  if (slash) {
    const m = Number(slash[1])
    const d = Number(slash[2])
    if (m < 1 || m > 12 || d < 1 || d > 31) return null
    let yyyy: number
    if (slash[3]) {
      yyyy = Number(slash[3])
      if (yyyy < 100) yyyy += 2000 // two-digit year heuristic; venues don't pre-date 2000
    } else {
      yyyy = now.getUTCFullYear()
    }
    const candidate = `${yyyy.toString().padStart(4, '0')}-${m.toString().padStart(2, '0')}-${d.toString().padStart(2, '0')}`
    return slash[3] ? candidate : pinToNearestYear(candidate, now)
  }
  // Month name → first day of month, nearest-year heuristic (most-recent past).
  const months: Record<string, string> = {
    jan: '01', feb: '02', mar: '03', apr: '04', may: '05', jun: '06',
    jul: '07', aug: '08', sep: '09', oct: '10', nov: '11', dec: '12',
  }
  const key = s.slice(0, 3).toLowerCase()
  if (months[key]) {
    // Year explicit (e.g. "Oct 2025") — trust it.
    const yearMatch = s.match(/(\d{4})/)
    if (yearMatch) {
      return `${yearMatch[1]}-${months[key]}-01`
    }
    // Default to most-recent past occurrence — same as before — then
    // pinToNearestYear corrects for year-boundary imports both ways.
    const targetMonth = Number(months[key])
    const currentMonth = now.getUTCMonth() + 1
    const baseYear = targetMonth > currentMonth ? now.getUTCFullYear() - 1 : now.getUTCFullYear()
    const candidate = `${baseYear}-${months[key]}-01`
    return pinToNearestYear(candidate, now)
  }
  return null
}

/**
 * Year-boundary corrector for unyearned date labels.
 *
 * If the candidate date is more than 6 months FUTURE relative to `now`,
 * subtract a year (a label like "12/15" seen from January is last
 * December, not next December).
 *
 * If the candidate date is more than 6 months PAST relative to `now`,
 * the past-bias rule already chose this — but if the source data is
 * marketing-metric activity that's almost-always recent, an "Oct"
 * label seen from August would resolve to LAST October by the past-
 * bias rule. That's correct (a Q3 platform export of last fall's
 * traffic). We don't pull this case forward — would mis-attribute
 * historical traffic to a future month that hasn't happened yet.
 *
 * Net: only the future-by-more-than-6-months case is corrected here,
 * which closes the year-boundary import bug without stripping legitimate
 * mid-year cross-year-boundary labels.
 *
 * Internal helper. Exported as `labelToDay` only.
 */
function pinToNearestYear(isoDay: string, now: Date): string {
  const candidate = new Date(`${isoDay}T00:00:00Z`)
  if (!Number.isFinite(candidate.getTime())) return isoDay
  const sixMonthsMs = 183 * 86400e3
  const delta = candidate.getTime() - now.getTime()
  if (delta > sixMonthsMs) {
    // Pull a year back.
    const adjusted = new Date(candidate)
    adjusted.setUTCFullYear(adjusted.getUTCFullYear() - 1)
    return adjusted.toISOString().slice(0, 10)
  }
  // Past-direction case is intentionally NOT pulled forward — see
  // function-level comment. Marketing-metric exports legitimately
  // describe last-year-this-month and we don't want to pretend
  // last-October's data is THIS October's data.
  return isoDay
}

interface Series {
  channel: string
  values: Map<string, number>
}

async function buildSeries(
  supabase: SupabaseClient,
  venueId: string,
  windowDays: number = WINDOW_DAYS,
): Promise<Series[]> {
  const now = new Date()
  const start = new Date(now.getTime() - windowDays * 86400e3)

  const series: Series[] = []

  // 1. Inquiries per day
  const { data: inquiries } = await supabase
    .from('weddings')
    .select('inquiry_date')
    .eq('venue_id', venueId)
    .gte('inquiry_date', start.toISOString())
    .not('inquiry_date', 'is', null)
  const inquiriesDaily = new Map<string, number>()
  for (const r of inquiries ?? []) {
    if (!r.inquiry_date) continue
    const k = dayKey(new Date(r.inquiry_date as string))
    inquiriesDaily.set(k, (inquiriesDaily.get(k) ?? 0) + 1)
  }
  series.push({ channel: 'inquiries', values: inquiriesDaily })

  // 2. marketing_metric events per day, grouped by source+metric.
  // Filter direction='inbound' per INV-16. Marketing_metric rows are
  // couple-side platform observations (profile views, saves, clicks);
  // see storefront-analytics-import.ts. Future outbound marketing
  // tracking (autonomous social posts etc.) would land as 'outbound'
  // and intentionally not enter this correlation series.
  const { data: mmRows } = await supabase
    .from('engagement_events')
    .select('metadata, created_at')
    .eq('venue_id', venueId)
    .eq('direction', 'inbound')
    .eq('event_type', 'marketing_metric')
  const mmBySeries = new Map<string, Map<string, number>>()
  for (const r of mmRows ?? []) {
    const md = (r.metadata ?? {}) as Record<string, unknown>
    const src = String(md.source ?? 'other')
    const metric = String(md.metric ?? 'other')
    const label = String(md.label ?? '')
    const value = Number(md.value ?? 0)
    const day = labelToDay(label)
    if (!day || !Number.isFinite(value)) continue
    const k = `${src}_${metric}`
    if (!mmBySeries.has(k)) mmBySeries.set(k, new Map())
    mmBySeries.get(k)!.set(day, value)
  }
  for (const [k, v] of mmBySeries) series.push({ channel: k, values: v })

  // 3. tangential_signals per platform per day.
  // T5-Rixey-LL: window on signal_date (real signal time). Pre-fix the
  // filter was on created_at — a backfilled signal whose signal_date
  // is 6 months old but whose created_at is the import day would either
  // appear in the wrong day's bucket or get dropped from the analysis
  // entirely. NULL signal_date rows fall through to created_at via the
  // OR below.
  // T5-Rixey-NN bug #2: writers split between extracted_identity.platform
  // (older email-pipeline writers) and the row-level source_platform column
  // (storefront-analytics-import + web-form intake). Reader prefers the
  // jsonb signal (more specific), then falls back to the row column.
  // Pre-fix: 553 the_knot storefront signals all collapsed into a single
  // 'other_signals' channel because the importer only populated source_platform.
  const { data: ts } = await supabase
    .from('tangential_signals')
    .select('extracted_identity, source_platform, signal_date, created_at')
    .eq('venue_id', venueId)
    .or(`signal_date.gte.${start.toISOString()},and(signal_date.is.null,created_at.gte.${start.toISOString()})`)
  const tsBySeries = new Map<string, Map<string, number>>()
  for (const r of ts ?? []) {
    const ei = (r.extracted_identity ?? {}) as Record<string, unknown>
    const platform = String(ei.platform ?? r.source_platform ?? 'other')
    const when = (r.signal_date as string | null) ?? (r.created_at as string)
    const k = dayKey(new Date(when))
    const seriesKey = `${platform}_signals`
    if (!tsBySeries.has(seriesKey)) tsBySeries.set(seriesKey, new Map())
    const map = tsBySeries.get(seriesKey)!
    map.set(k, (map.get(k) ?? 0) + 1)
  }
  for (const [k, v] of tsBySeries) series.push({ channel: k, values: v })

  // 4. External Context channels (T2-C / Playbook 17.4-A).
  // Extends the engine beyond Internal-only signals (inquiries +
  // marketing_metric + tangential_signals) to include the macro
  // channels playbook 17.4-A flagged as the competitive moat.
  // Each loader returns ExternalChannelSeries[] with dense daily
  // points; convert to the engine's Map<dayKey,value> shape.
  // 2026-05-01 (review pass 3): parallelize external-context loaders.
  // Pre-fix this block ran sequentially: FRED → calendar → cultural →
  // venue geo lookup. With ~3 round-trips at ~50-100ms each, the engine
  // paid 200-400ms per venue per cron tick for no good reason. Now
  // resolve venue geo + run all 3 loaders concurrently.
  try {
    const venueGeoScope = await getVenueGeoScope(supabase, venueId)
    const [fredResult, calendarResult, cultural, governmentResult] = await Promise.all([
      loadFredSeries(supabase, start, now),
      loadCalendarSeries(supabase, start, now, venueGeoScope),
      // Migration 167: cultural moments are now per-venue confirmed.
      // Pass venueId so the engine reads moments THIS venue elevated,
      // not every confirmed moment globally.
      loadCulturalMomentsSeries(supabase, start, now, venueId),
      // Z6 (T5-Rixey-ZZ): government_events binary signal. The loader
      // checks venue geo + amplifies for DC-region venues (state IN
      // VA/DC/MD or within 100mi of DC). Non-DC venues still see the
      // channel at 0.5x weight — federal events touch national
      // consumer sentiment regardless. Returns [] if no rows overlap
      // the window so non-shutdown years don't add a noisy zero
      // channel to the correlation matrix.
      loadGovernmentSeries(supabase, start, now, venueId),
    ])
    const externalSeries = [...fredResult, ...calendarResult, ...governmentResult]
    // Cultural moments returns a single channel even when no rows match.
    if (cultural.points.length > 0) externalSeries.push(cultural)

    for (const ext of externalSeries) {
      const m = new Map<string, number>()
      for (const p of ext.points) m.set(p.dayKey, p.value)
      if (m.size > 0) series.push({ channel: ext.channel, values: m })
    }
  } catch (err) {
    // External context is additive — never block the engine on a
    // load failure; downstream insights from Internal channels still
    // run.
    console.warn('[correlation-engine] external context load failed:', err)
  }

  return series
}

/**
 * Resolve a venue's geo_scope for calendar event filtering. The venue
 * row may carry city/state directly (current schema doesn't formalise
 * this yet, so we try to construct it from venue_config.timezone +
 * known venue regions; falls back to 'us' for nationwide-only events).
 *
 * Future: add a venue_config.geo_scope column with the canonical
 * 'us_<state>_<metro>' tag the calendar loader expects.
 */
async function getVenueGeoScope(
  supabase: SupabaseClient,
  venueId: string,
): Promise<string> {
  // Best-effort: pull state from venues table if present, else 'us'.
  const { data } = await supabase
    .from('venues')
    .select('state')
    .eq('id', venueId)
    .maybeSingle()
  const state = ((data?.state as string | null) ?? '').trim().toLowerCase()
  if (state && /^[a-z]{2}$/.test(state)) return `us_${state}`
  return 'us'
}

/**
 * Bonferroni-corrected critical |r| for the engine's family of tests.
 * With N channels we test N×(N-1)×|LAGS| ordered pairs, so family-
 * wise error rate balloons. Adjust per-test alpha to keep family-wise
 * alpha at FAMILY_ALPHA.
 *
 * The math is in src/lib/services/external-context/stats.ts —
 * Acklam inverse normal + Cornish-Fisher t-correction + r = t/√(df+t²).
 * Pre-fix this was a heuristic with magic constants; replaced
 * 2026-05-01 with a proper derivation.
 *
 * Returns max(CORRELATION_THRESHOLD floor, Bonferroni critical r,
 *             0.85 cap). The floor enforces "notable effect"; the
 * cap prevents pathological N from making nothing detectable.
 *
 * Per Playbook ARCH-19.5 / T2-C requirement: "Add multiple-comparisons
 * correction + per-venue significance threshold to correlation engine."
 */
function correctedThresholdFor(numChannels: number, windowDays: number = WINDOW_DAYS): number {
  if (numChannels < 2) return CORRELATION_THRESHOLD
  // Stream YY (Z5 caveat): the lag set is now class-aware, but the
  // Bonferroni penalty must reflect the WIDEST search space the engine
  // could traverse — otherwise we'd give macro × macro pairs an unfair
  // significance break compared to venue × social pairs. Use the union
  // of all per-class lags. (For an N=12 channel family that's 12×11×7
  // = 924 tests vs the old 12×11×5 = 660; the threshold rises by
  // ~0.02-0.04 which is the right honest trade-off.)
  const numTests = numChannels * (numChannels - 1) * ALL_LAGS_UNION.length
  const bonferroniR = bonferroniCriticalR(numTests, windowDays, FAMILY_ALPHA)
  return Math.max(CORRELATION_THRESHOLD, Math.min(0.85, bonferroniR))
}

function seriesToArray(s: Series, days: string[]): number[] {
  return days.map((d) => s.values.get(d) ?? 0)
}

function nonZeroCount(arr: number[]): number {
  return arr.filter((v) => v !== 0).length
}

function applyLag(arr: number[], lag: number): { x: number[]; y: number[] } {
  // y is lagged behind x by `lag` days: x[t] vs y[t+lag]
  if (lag === 0) return { x: arr, y: arr }
  const n = arr.length - lag
  return { x: arr.slice(0, n), y: arr.slice(lag) }
}

/**
 * Stream YY (Z3): channel-id → coordinator-readable label.
 *
 * Delegates to the shared utility so the engine, the narration
 * surface, and any future macro-correlations consumer all render
 * identical labels. Pre-Stream-YY this lived in two places (here +
 * correlation-narration.ts) and drifted ("S&P 500" properly cased
 * alongside "30y mortgage rate" / "consumer sentiment" lowercase).
 */
function humanChannel(ch: string): string {
  return formatSeriesLabel(ch)
}

/**
 * Compute correlation insights for a venue. Writes at most N top
 * insights back to intelligence_insights. Returns what it wrote.
 */
export async function computeCorrelationsForVenue(args: {
  supabase: SupabaseClient
  venueId: string
  maxInsights?: number
  /** Stream QQ: opt-in override for ad-hoc historical-significance
   *  runs. Defaults to WINDOW_DAYS (90) so the cron path is unchanged.
   *  Capped at MAX_WINDOW_DAYS to bound the Bonferroni penalty. */
  windowDaysOverride?: number
}): Promise<CorrelationInsight[]> {
  const { supabase, venueId } = args
  const maxInsights = args.maxInsights ?? 5
  const windowDays = Math.max(
    1,
    Math.min(MAX_WINDOW_DAYS, args.windowDaysOverride ?? WINDOW_DAYS),
  )

  const series = await buildSeries(supabase, venueId, windowDays)
  if (series.length < 2) return []

  const now = new Date()
  const start = new Date(now.getTime() - windowDays * 86400e3)
  const days = enumerateDays(start, now)
  const arrays = new Map<string, number[]>()
  for (const s of series) arrays.set(s.channel, seriesToArray(s, days))

  const insights: CorrelationInsight[] = []
  const names = Array.from(arrays.keys())
  // T2-C: family-wise correction so Internal + External Context channels
  // together don't trip false-positive correlations from sheer test
  // volume. Replaces the bare CORRELATION_THRESHOLD constant on the
  // hot path.
  const familyThreshold = correctedThresholdFor(names.length, windowDays)

  for (let i = 0; i < names.length; i++) {
    for (let j = 0; j < names.length; j++) {
      if (i === j) continue
      const nameA = names[i]
      const nameB = names[j]

      // Stream YY (Z2): direction enforcement. Macro channels (FRED,
      // calendar, cultural moments) are exogenous — a venue's internal
      // metric cannot causally PRECEDE national CPI or 30-year mortgage
      // rates. Skip the venue/social → macro direction; the macro →
      // venue/social direction will be evaluated when (i, j) reaches
      // the swap. Same applies to social → macro (downstream of macro).
      // For symmetric same-class pairs (venue × venue, social × social,
      // macro × macro) both directions remain valid and dedup picks
      // the stronger.
      const classA = classifySeries(nameA)
      const classB = classifySeries(nameB)
      if (classB === 'macro' && classA !== 'macro') {
        // (venue|social) → macro: drop. The mirror (macro → venue|social)
        // is evaluated separately and IS allowed.
        continue
      }

      const a = arrays.get(nameA)!
      const b = arrays.get(nameB)!
      if (nonZeroCount(a) < MIN_NONZERO_DAYS || nonZeroCount(b) < MIN_NONZERO_DAYS) continue

      // Stream YY (Z5): class-aware lag set. Macro × venue gets the
      // 30-180d slow-consumer-behaviour set; venue × social gets the
      // 0-30d viral set; etc. The Bonferroni threshold is computed
      // against the WIDEST union (correctedThresholdFor uses
      // ALL_LAGS_UNION.length) so we can't game significance by
      // searching wider.
      const pairClass = classifyPair(nameA, nameB)
      const lagsToTry = lagsForPair(pairClass)

      // Try each lag; keep the highest-|r| hit that clears threshold.
      let best: { lag: number; r: number } | null = null
      for (const lag of lagsToTry) {
        const { x, y } = applyLag(a, lag) // A leads B by `lag` days
        const pairedA = x
        const pairedB = applyLag(b, lag).y // align same tail of b
        const r = pearson(pairedA, pairedB)
        if (Math.abs(r) >= familyThreshold && (best == null || Math.abs(r) > Math.abs(best.r))) {
          best = { lag, r }
        }
      }
      if (!best) continue

      const humanA = humanChannel(nameA)
      const humanB = humanChannel(nameB)
      const direction = best.r > 0 ? 'rise together' : 'move in opposite directions'
      const lagPhrase = best.lag === 0 ? 'on the same day' : `with a ${best.lag}-day lag`
      const headline = best.lag === 0
        ? `${humanA} correlates with ${humanB} (r=${best.r.toFixed(2)})`
        : `${humanA} precedes ${humanB} by ${best.lag} days (r=${best.r.toFixed(2)})`
      const body = `${humanA} and ${humanB} ${direction} ${lagPhrase} over the last ${windowDays} days (correlation ${best.r.toFixed(2)}). ${
        best.lag > 0
          ? `A spike in ${humanA} has tended to predict a move in ${humanB} about ${best.lag} days later.`
          : 'Movements appear synchronous.'
      }`
      // Stream YY (Z1): rankScore = |r| × 100 × per-pair-class
      // multiplier. Persisted as surface_priority so the UI sort puts
      // venue × macro insights above macro × macro noise without
      // hiding the latter.
      const rankScore = Math.abs(best.r) * 100 * rankMultiplierForPair(pairClass)
      insights.push({
        channelA: nameA,
        channelB: nameB,
        lagDays: best.lag,
        r: best.r,
        headline,
        body,
        confidence: Math.min(1, Math.abs(best.r)),
        pairClass,
        classA,
        classB,
        rankScore,
      })
    }
  }

  // Sort by rankScore (Stream YY Z1 — incorporates the pair-class
  // multiplier). Within the same rankScore, fall back to |r|. Then
  // dedupe by un-ordered pair (drop the mirror), take top N.
  insights.sort((x, y) => {
    const ds = y.rankScore - x.rankScore
    if (ds !== 0) return ds
    return Math.abs(y.r) - Math.abs(x.r)
  })
  const seenPairs = new Set<string>()
  const deduped: CorrelationInsight[] = []
  for (const ins of insights) {
    const pairKey = [ins.channelA, ins.channelB].sort().join('|')
    if (seenPairs.has(pairKey)) continue
    seenPairs.add(pairKey)
    deduped.push(ins)
    if (deduped.length >= maxInsights) break
  }

  // Write to intelligence_insights — upsert by (venue_id, insight_type,
  // context_id=pair_key) so re-runs refresh the same row rather than
  // duplicating.
  //
  // P1 fix (Stream BB / T5-Rixey-JJ): context_id is `uuid` (migration
  // 080). The previous build wrote `'corr:<a>|<b>'` here, which Postgres
  // rejects with `22P02 invalid input syntax for type uuid` — the engine
  // could not write any rows in production. Derive a stable v5 UUID
  // from the channel pair + lag instead so the insert lands AND
  // re-runs upsert deterministically (same channel pair + lag always
  // produces the same UUID).
  //
  // No backfill: Stream BB confirmed no production writes have occurred
  // since the column type tightened, so there are no orphan rows to
  // re-key.
  for (const ins of deduped) {
    const pairKey = `${[ins.channelA, ins.channelB].sort().join('|')}|${ins.lagDays}`
    const contextId = uuidV5(pairKey)
    const row = {
      venue_id: venueId,
      insight_type: 'correlation',
      category: 'market',
      title: ins.headline,
      body: ins.body,
      priority: Math.abs(ins.r) >= 0.8 ? 'high' : 'medium',
      confidence: Math.abs(ins.r),
      // Stream YY (Z1): persist signal_class + rank score so /intel UIs
      // can filter by class without re-running the engine, and so
      // ORDER BY surface_priority DESC reflects the per-class boost.
      surface_priority: ins.rankScore,
      data_points: {
        channel_a: ins.channelA,
        channel_b: ins.channelB,
        lag_days: ins.lagDays,
        r: ins.r,
        window_days: windowDays,
        // Audit: keep the pre-hash key visible so a coordinator (or
        // future reader) can reverse-engineer which pair the UUID
        // belongs to without re-running the engine.
        pair_key: pairKey,
        // Stream YY (Z1): signal-class taxonomy. UI filter (Z4) reads
        // these to switch chips between All / Venue-relevant / Macro.
        signal_class: ins.pairClass,
        class_a: ins.classA,
        class_b: ins.classB,
        rank_multiplier: rankMultiplierForPair(ins.pairClass),
        rank_score: ins.rankScore,
      },
      status: 'new',
      context_id: contextId,
    }
    const { data: existing } = await supabase
      .from('intelligence_insights')
      .select('id')
      .eq('venue_id', venueId)
      .eq('insight_type', 'correlation')
      .eq('context_id', contextId)
      .maybeSingle()
    if (existing) {
      await supabase.from('intelligence_insights').update(row).eq('id', existing.id)
    } else {
      await supabase.from('intelligence_insights').insert(row)
    }
  }

  return deduped
}

/**
 * Batch entry point for the cron. Runs computeCorrelationsForVenue for
 * every active venue. Swallows per-venue errors so one bad tenant
 * doesn't break the others.
 */
export async function computeCorrelationsAllVenues(
  supabase: SupabaseClient
): Promise<Record<string, number>> {
  const { data: venues } = await supabase.from('venues').select('id').eq('status', 'active')

  // Cost-ceiling gate: correlation-engine itself runs classical Pearson
  // (no LLM cost), but it WRITES to intelligence_insights which is a
  // "proactive insight" surface per Playbook 21.4.3. Paused venues
  // shouldn't get new proactive insights even if they're free to
  // compute — defense-in-depth around the doctrine boundary, not
  // just the cost boundary.
  const venueIds = (venues ?? []).map((v) => v.id as string)
  const { filterActiveVenues } = await import('@/lib/services/cost-ceiling')
  const { active, skipped } = await filterActiveVenues(venueIds, {
    workType: 'correlation_analysis',
  })
  if (skipped.length > 0) {
    console.log(`[correlation] Skipping ${skipped.length} paused venue(s); running ${active.length}`)
  }

  const out: Record<string, number> = {}
  for (const id of active) {
    try {
      const insights = await computeCorrelationsForVenue({ supabase, venueId: id })
      out[id] = insights.length
    } catch (err) {
      console.error(`[correlation] ${id}:`, err instanceof Error ? err.message : err)
      out[id] = -1
    }
  }
  return out
}
