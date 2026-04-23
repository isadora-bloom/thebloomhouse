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

const WINDOW_DAYS = 90
const LAGS = [0, 3, 5, 7, 14]
const MIN_NONZERO_DAYS = 20
const CORRELATION_THRESHOLD = 0.6

export interface CorrelationInsight {
  channelA: string
  channelB: string
  lagDays: number
  r: number
  headline: string
  body: string
  confidence: number
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
 * '2025-10', '2025-10-15', 'Oct 2025', etc. Returns null if the label
 * cannot be resolved to a concrete day (abstract buckets are skipped
 * rather than guessed).
 */
function labelToDay(label: string): string | null {
  const s = label.trim()
  if (!s) return null
  // ISO day
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return s
  // ISO month → first day of month
  const iso = s.match(/^(\d{4})-(\d{2})$/)
  if (iso) return `${iso[1]}-${iso[2]}-01`
  // Month name → first day of month, nearest-year heuristic (most-recent past)
  const months: Record<string, string> = {
    jan: '01', feb: '02', mar: '03', apr: '04', may: '05', jun: '06',
    jul: '07', aug: '08', sep: '09', oct: '10', nov: '11', dec: '12',
  }
  const key = s.slice(0, 3).toLowerCase()
  if (months[key]) {
    const now = new Date()
    const targetMonth = Number(months[key])
    const currentMonth = now.getUTCMonth() + 1
    const year = targetMonth > currentMonth ? now.getUTCFullYear() - 1 : now.getUTCFullYear()
    return `${year}-${months[key]}-01`
  }
  return null
}

interface Series {
  channel: string
  values: Map<string, number>
}

async function buildSeries(supabase: SupabaseClient, venueId: string): Promise<Series[]> {
  const now = new Date()
  const start = new Date(now.getTime() - WINDOW_DAYS * 86400e3)

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

  // 2. marketing_metric events per day, grouped by source+metric
  const { data: mmRows } = await supabase
    .from('engagement_events')
    .select('metadata, created_at')
    .eq('venue_id', venueId)
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

  // 3. tangential_signals per platform per day
  const { data: ts } = await supabase
    .from('tangential_signals')
    .select('extracted_identity, signal_date, created_at')
    .eq('venue_id', venueId)
    .gte('created_at', start.toISOString())
  const tsBySeries = new Map<string, Map<string, number>>()
  for (const r of ts ?? []) {
    const ei = (r.extracted_identity ?? {}) as Record<string, unknown>
    const platform = String(ei.platform ?? 'other')
    const when = (r.signal_date as string | null) ?? (r.created_at as string)
    const k = dayKey(new Date(when))
    const seriesKey = `${platform}_signals`
    if (!tsBySeries.has(seriesKey)) tsBySeries.set(seriesKey, new Map())
    const map = tsBySeries.get(seriesKey)!
    map.set(k, (map.get(k) ?? 0) + 1)
  }
  for (const [k, v] of tsBySeries) series.push({ channel: k, values: v })

  return series
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

function humanChannel(ch: string): string {
  return ch
    .replace(/_/g, ' ')
    .replace(/\bthe knot\b/i, 'The Knot')
    .replace(/\bwedding wire\b/i, 'WeddingWire')
    .replace(/\binstagram\b/i, 'Instagram')
    .replace(/\bfacebook\b/i, 'Facebook')
    .replace(/\bpinterest\b/i, 'Pinterest')
    .replace(/\btiktok\b/i, 'TikTok')
    .replace(/\bgoogle analytics\b/i, 'Google Analytics')
    .replace(/\bgoogle\b/i, 'Google')
    .replace(/\bhoneybook\b/i, 'HoneyBook')
}

/**
 * Compute correlation insights for a venue. Writes at most N top
 * insights back to intelligence_insights. Returns what it wrote.
 */
export async function computeCorrelationsForVenue(args: {
  supabase: SupabaseClient
  venueId: string
  maxInsights?: number
}): Promise<CorrelationInsight[]> {
  const { supabase, venueId } = args
  const maxInsights = args.maxInsights ?? 5

  const series = await buildSeries(supabase, venueId)
  if (series.length < 2) return []

  const now = new Date()
  const start = new Date(now.getTime() - WINDOW_DAYS * 86400e3)
  const days = enumerateDays(start, now)
  const arrays = new Map<string, number[]>()
  for (const s of series) arrays.set(s.channel, seriesToArray(s, days))

  const insights: CorrelationInsight[] = []
  const names = Array.from(arrays.keys())

  for (let i = 0; i < names.length; i++) {
    for (let j = 0; j < names.length; j++) {
      if (i === j) continue
      const a = arrays.get(names[i])!
      const b = arrays.get(names[j])!
      if (nonZeroCount(a) < MIN_NONZERO_DAYS || nonZeroCount(b) < MIN_NONZERO_DAYS) continue

      // Try each lag; keep the highest-|r| hit that clears threshold.
      let best: { lag: number; r: number } | null = null
      for (const lag of LAGS) {
        const { x, y } = applyLag(a, lag) // A leads B by `lag` days
        const pairedA = x
        const pairedB = applyLag(b, lag).y // align same tail of b
        const r = pearson(pairedA, pairedB)
        if (Math.abs(r) >= CORRELATION_THRESHOLD && (best == null || Math.abs(r) > Math.abs(best.r))) {
          best = { lag, r }
        }
      }
      if (!best) continue

      const humanA = humanChannel(names[i])
      const humanB = humanChannel(names[j])
      const direction = best.r > 0 ? 'rise together' : 'move in opposite directions'
      const lagPhrase = best.lag === 0 ? 'on the same day' : `with a ${best.lag}-day lag`
      const headline = best.lag === 0
        ? `${humanA} correlates with ${humanB} (r=${best.r.toFixed(2)})`
        : `${humanA} precedes ${humanB} by ${best.lag} days (r=${best.r.toFixed(2)})`
      const body = `${humanA} and ${humanB} ${direction} ${lagPhrase} over the last ${WINDOW_DAYS} days (correlation ${best.r.toFixed(2)}). ${
        best.lag > 0
          ? `A spike in ${humanA} has tended to predict a move in ${humanB} about ${best.lag} days later.`
          : 'Movements appear synchronous.'
      }`
      insights.push({
        channelA: names[i],
        channelB: names[j],
        lagDays: best.lag,
        r: best.r,
        headline,
        body,
        confidence: Math.min(1, Math.abs(best.r)),
      })
    }
  }

  // Sort by |r|, dedupe by un-ordered pair (drop the mirror), take top N.
  insights.sort((x, y) => Math.abs(y.r) - Math.abs(x.r))
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
  for (const ins of deduped) {
    const contextId = `corr:${[ins.channelA, ins.channelB].sort().join('|')}`
    const row = {
      venue_id: venueId,
      insight_type: 'correlation',
      category: 'market',
      title: ins.headline,
      body: ins.body,
      priority: Math.abs(ins.r) >= 0.8 ? 'high' : 'medium',
      confidence: Math.abs(ins.r),
      data_points: {
        channel_a: ins.channelA,
        channel_b: ins.channelB,
        lag_days: ins.lagDays,
        r: ins.r,
        window_days: WINDOW_DAYS,
      },
      status: 'new',
      context_id: contextId as unknown as string,
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
  const out: Record<string, number> = {}
  for (const v of venues ?? []) {
    try {
      const insights = await computeCorrelationsForVenue({ supabase, venueId: v.id as string })
      out[v.id as string] = insights.length
    } catch (err) {
      console.error(`[correlation] ${v.id}:`, err instanceof Error ? err.message : err)
      out[v.id as string] = -1
    }
  }
  return out
}
