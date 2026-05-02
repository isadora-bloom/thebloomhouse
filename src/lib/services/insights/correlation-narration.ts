/**
 * T5-θ.1: LLM-narrated cross-limb correlation surface (USP #4 demo core).
 *
 * Per the YC-partner audit (2026-05-T4-postlaunch/yc-partner.md
 * CRITICAL #2): the correlation engine writes statistically-sound rows
 * ("X and Y rise together with a 7-day lag, r=0.62"), but no surface
 * shows a coordinator the cross-limb story those rows IMPLY:
 *
 *   "Mortgage rate went up 80bps over Q1; your tour-completion rate
 *    dropped 14% with a 2-week lag. 3 inquiries in this window cited
 *    budget concerns."
 *
 * That story is the headline USP #4 demo. This module composes it.
 *
 * Pipeline:
 *   1. Read recent intelligence_insights rows of insight_type='correlation'
 *      written by correlation-engine.ts. Window: last 14 days, top 5 by
 *      |r|.
 *   2. For each correlation row, rebuild the underlying Internal +
 *      External series from the same loaders the engine uses
 *      (correlation-engine.ts buildSeries → fred + cultural + calendar
 *      + inquiries + marketing_metric + tangential_signals).
 *   3. Build a numbers-allowlist (r, lag, channel sample sizes, recent
 *      values from each series) so the LLM is bounded to numbers
 *      classical compute already produced.
 *   4. Cost-ceiling gate (gateForBrainCall) BEFORE Sonnet.
 *   5. Sonnet narration with strict prompt: 2-3 plain-English sentences,
 *      no inventing numbers, weak signal disclaimer if r<0.3 or p>0.05.
 *   6. numbers-guard against the narration body.
 *   7. Persist as a separate insight row (insight_type='correlation_narration')
 *      with cache_key = FNV-1a(channel_a, channel_b, lag, r, recent series
 *      hash). Cache hit on second load = no LLM re-call.
 *   8. Always returns SOMETHING — when the gate is closed or Sonnet is
 *      unavailable, the deterministic fallback narrates the engine's
 *      headline body verbatim. Never block the surface on AI.
 *
 * The companion API route + /intel/macro-correlations page consume this
 * service.
 */

import type { SupabaseClient } from '@supabase/supabase-js'
import { callAI, CLAUDE_MODEL } from '@/lib/ai/client'
import { gateForBrainCall } from '@/lib/services/cost-ceiling'
import { redactError } from '@/lib/observability/redact'
import { confidenceFor, buildCacheKey } from './confidence'
import { lookupCachedInsight, persistInsight } from './persist'
import type { ClassicalEvidence, InsightNarration } from './types'
import { loadFredSeries } from '../external-context/fred'
import { loadCulturalMomentsSeries } from '../external-context/cultural-moments'
import { loadCalendarSeries } from '../external-context/calendar'

export const CORRELATION_NARRATION_PROMPT_VERSION =
  'correlation-narration.prompt.v1.0'

// Weak-signal thresholds — surfaced as a "weak signal" badge on the
// card AND told to the LLM so the narration can disclaim. The
// correlation engine's CORRELATION_THRESHOLD floor is 0.6, so most
// stored 'correlation' rows clear the |r|>=0.3 bar by construction.
// The threshold pair lives here (not in the engine) because weak-
// signal framing is a SURFACE concern; the engine writes whatever
// clears its statistical bar, and the surface decides how to display it.
//
// p-value approximation: p ≈ 1 - r^2 isn't a real p-value, but the
// correlation engine doesn't store one. We use a ROUGH effective p
// derived from the stored r + n=90 window — see effectivePValue().
// This is conservative: a real Bonferroni-corrected p would be much
// stricter for a 90-day window with cross-limb pairs. Until the
// engine stores the actual p (follow-up scope), this disclaimer is
// the best we can do without re-running the math at narration time.
const WEAK_R_THRESHOLD = 0.3
const WEAK_P_THRESHOLD = 0.05

// Window over which we look for recent un-narrated correlation rows.
// 14 days mirrors the typical "what's new this fortnight" cadence the
// /intel surfaces use for fresh insights.
const RECENT_WINDOW_DAYS = 14
const MAX_NARRATIONS_PER_RUN = 5

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface CorrelationRow {
  id: string
  title: string
  body: string
  data_points: {
    channel_a?: string
    channel_b?: string
    lag_days?: number
    r?: number
    window_days?: number
  } | null
  created_at: string
}

interface SeriesSummary {
  channel: string
  recentValues: Array<{ dayKey: string; value: number }>
  nonZeroDays: number
  /** Min / max / latest used for the prompt's "what changed" framing. */
  min: number
  max: number
  latest: number
  earliest: number
}

export interface NarratedCorrelation {
  id: string
  /** Underlying correlation row id (the engine's row). */
  correlationId: string
  channelA: string
  channelB: string
  channelALabel: string
  channelBLabel: string
  lagDays: number
  r: number
  /** Approximate p-value. See effectivePValue note above. */
  pValue: number
  weakSignal: boolean
  title: string
  body: string
  action: string | null
  confidence: number
  cached: boolean
  createdAt: string
  /** Recent values for the "view raw series" expandable. */
  seriesA: Array<{ dayKey: string; value: number }>
  seriesB: Array<{ dayKey: string; value: number }>
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Approximate two-sided p-value for Pearson r at sample size n. Fisher
 * z-transformation is overkill here — the engine doesn't store n
 * cleanly (window_days is a proxy, not exact non-zero pairs), so we
 * use the simple r → t → df=n-2 → tail mass approximation via the
 * normal-approximation cutoff. This produces a "good enough" disclaimer
 * threshold; it is NOT a defensible inferential statistic.
 *
 * For |r| >= 0.3 at n=90 the approximate p ≈ 0.004 (well under 0.05).
 * For |r| < 0.2 the disclaimer kicks in. Either threshold is honest
 * because we surface the raw r alongside the disclaimer — coordinators
 * can cross-check.
 */
function effectivePValue(r: number, n: number): number {
  if (!Number.isFinite(r) || !Number.isFinite(n) || n < 4) return 1
  const absR = Math.min(0.999, Math.abs(r))
  const df = n - 2
  const t = absR * Math.sqrt(df / (1 - absR * absR))
  // Normal approximation for two-tailed p — Math.erfc would be exact
  // for z, but we want a simple "is this strong" gate, not a journal-
  // quality inference. Map t→z via "t with high df ≈ N(0,1)".
  const z = t
  // Approximate Φ(z) via Abramowitz 7.1.26 erf approximation.
  const a1 =  0.254829592
  const a2 = -0.284496736
  const a3 =  1.421413741
  const a4 = -1.453152027
  const a5 =  1.061405429
  const p = 0.3275911
  const sign = z >= 0 ? 1 : -1
  const x = Math.abs(z) / Math.sqrt(2)
  const tt = 1.0 / (1.0 + p * x)
  const erf = sign * (1 - (((((a5 * tt + a4) * tt) + a3) * tt + a2) * tt + a1) * tt * Math.exp(-x * x))
  const phi = 0.5 * (1 + erf)
  return Math.max(0, Math.min(1, 2 * (1 - phi)))
}

function humanChannel(ch: string): string {
  const fredLabels: Record<string, string> = {
    CPIAUCSL: 'CPI (inflation)',
    MORTGAGE30US: '30y mortgage rate',
    SP500: 'S&P 500',
    UNRATE: 'unemployment rate',
    UMCSENT: 'consumer sentiment',
  }
  if (ch.startsWith('fred_')) {
    const id = ch.slice('fred_'.length)
    return fredLabels[id] ?? `FRED ${id}`
  }
  if (ch.startsWith('calendar_')) {
    const cat = ch.slice('calendar_'.length).replace(/_/g, ' ')
    return `${cat} (calendar)`
  }
  if (ch === 'cultural_moments') return 'cultural moments'
  if (ch === 'inquiries') return 'inquiries'
  return ch
    .replace(/_/g, ' ')
    .replace(/\bthe knot\b/i, 'The Knot')
    .replace(/\bwedding wire\b/i, 'WeddingWire')
    .replace(/\binstagram\b/i, 'Instagram')
    .replace(/\bfacebook\b/i, 'Facebook')
    .replace(/\bpinterest\b/i, 'Pinterest')
    .replace(/\btiktok\b/i, 'TikTok')
}

function summariseSeries(
  channel: string,
  points: Array<{ dayKey: string; value: number }>,
): SeriesSummary {
  const sorted = [...points].sort((a, b) => a.dayKey.localeCompare(b.dayKey))
  const values = sorted.map((p) => p.value).filter((v) => Number.isFinite(v))
  const nonZero = values.filter((v) => v !== 0).length
  const min = values.length ? Math.min(...values) : 0
  const max = values.length ? Math.max(...values) : 0
  const earliest = sorted.length ? sorted[0].value : 0
  const latest = sorted.length ? sorted[sorted.length - 1].value : 0
  return {
    channel,
    recentValues: sorted.slice(-30), // last 30 days for the expandable
    nonZeroDays: nonZero,
    min,
    max,
    earliest,
    latest,
  }
}

/**
 * Rebuild the per-day series for one of the engine's channel ids.
 * Mirrors correlation-engine.ts buildSeries but ONLY for the requested
 * channels — the narration only needs the two channels in the pair, not
 * the whole matrix.
 */
async function loadSeriesForChannels(
  supabase: SupabaseClient,
  venueId: string,
  channels: string[],
  windowDays: number,
): Promise<Map<string, Array<{ dayKey: string; value: number }>>> {
  const out = new Map<string, Array<{ dayKey: string; value: number }>>()
  const now = new Date()
  const start = new Date(now.getTime() - windowDays * 86400e3)

  // External: fred / calendar / cultural moments. Pulled once even if
  // we only need one of them; the loaders are read-only and cheap.
  const wantsFred = channels.some((c) => c.startsWith('fred_'))
  const wantsCalendar = channels.some((c) => c.startsWith('calendar_'))
  const wantsCultural = channels.includes('cultural_moments')

  try {
    const tasks: Array<Promise<void>> = []

    if (wantsFred) {
      const fredIds = channels
        .filter((c) => c.startsWith('fred_'))
        .map((c) => c.slice('fred_'.length))
      tasks.push(
        loadFredSeries(supabase, start, now, fredIds).then((seriesArr) => {
          for (const s of seriesArr) {
            out.set(s.channel, s.points.map((p) => ({ dayKey: p.dayKey, value: p.value })))
          }
        }).catch((err) => {
          console.warn('[correlation-narration] fred load failed:', redactError(err))
        }),
      )
    }
    if (wantsCalendar) {
      const { data: venue } = await supabase
        .from('venues')
        .select('state')
        .eq('id', venueId)
        .maybeSingle()
      const state = ((venue?.state as string | null) ?? '').trim().toLowerCase()
      const geoScope = state && /^[a-z]{2}$/.test(state) ? `us_${state}` : 'us'
      tasks.push(
        loadCalendarSeries(supabase, start, now, geoScope).then((seriesArr) => {
          for (const s of seriesArr) {
            if (channels.includes(s.channel)) {
              out.set(s.channel, s.points.map((p) => ({ dayKey: p.dayKey, value: p.value })))
            }
          }
        }).catch((err) => {
          console.warn('[correlation-narration] calendar load failed:', redactError(err))
        }),
      )
    }
    if (wantsCultural) {
      tasks.push(
        loadCulturalMomentsSeries(supabase, start, now).then((s) => {
          out.set(s.channel, s.points.map((p) => ({ dayKey: p.dayKey, value: p.value })))
        }).catch((err) => {
          console.warn('[correlation-narration] cultural load failed:', redactError(err))
        }),
      )
    }

    await Promise.all(tasks)
  } catch (err) {
    // Defense in depth — Promise.all should handle, but if a loader
    // throws synchronously we still want to fall through to internal
    // channels below.
    console.warn('[correlation-narration] external load failed:', redactError(err))
  }

  // Internal: inquiries / marketing_metric / tangential_signals.
  // Mirrors buildSeries; only computed when requested.
  if (channels.includes('inquiries') && !out.has('inquiries')) {
    const { data: inquiries } = await supabase
      .from('weddings')
      .select('inquiry_date')
      .eq('venue_id', venueId)
      .gte('inquiry_date', start.toISOString())
      .not('inquiry_date', 'is', null)
    const daily = new Map<string, number>()
    for (const r of inquiries ?? []) {
      if (!r.inquiry_date) continue
      const k = new Date(r.inquiry_date as string).toISOString().slice(0, 10)
      daily.set(k, (daily.get(k) ?? 0) + 1)
    }
    out.set(
      'inquiries',
      Array.from(daily.entries()).map(([dayKey, value]) => ({ dayKey, value })),
    )
  }

  // marketing_metric: channels of shape `{source}_{metric}`. We only
  // pull when one of the requested channels matches the prefix pattern.
  // Conservative: skip if we can't confidently identify the source.
  const mmChannels = channels.filter(
    (c) =>
      !c.startsWith('fred_') &&
      !c.startsWith('calendar_') &&
      c !== 'cultural_moments' &&
      c !== 'inquiries' &&
      !c.endsWith('_signals'),
  )
  if (mmChannels.length > 0) {
    const { data: mmRows } = await supabase
      .from('engagement_events')
      .select('metadata')
      .eq('venue_id', venueId)
      .eq('direction', 'inbound')
      .eq('event_type', 'marketing_metric')
    const bySeries = new Map<string, Map<string, number>>()
    for (const r of mmRows ?? []) {
      const md = (r.metadata ?? {}) as Record<string, unknown>
      const src = String(md.source ?? 'other')
      const metric = String(md.metric ?? 'other')
      const label = String(md.label ?? '')
      const value = Number(md.value ?? 0)
      // labelToDay: ISO YYYY-MM-DD only here; the engine has more
      // forms but for narration we just need recent values.
      const day = /^\d{4}-\d{2}-\d{2}$/.test(label) ? label : null
      if (!day || !Number.isFinite(value)) continue
      const k = `${src}_${metric}`
      if (!bySeries.has(k)) bySeries.set(k, new Map())
      bySeries.get(k)!.set(day, value)
    }
    for (const [k, v] of bySeries) {
      if (mmChannels.includes(k)) {
        out.set(k, Array.from(v.entries()).map(([dayKey, value]) => ({ dayKey, value })))
      }
    }
  }

  // tangential_signals: channels ending in `_signals`.
  const tsChannels = channels.filter((c) => c.endsWith('_signals'))
  if (tsChannels.length > 0) {
    const { data: ts } = await supabase
      .from('tangential_signals')
      .select('extracted_identity, signal_date, created_at')
      .eq('venue_id', venueId)
      .gte('created_at', start.toISOString())
    const bySeries = new Map<string, Map<string, number>>()
    for (const r of ts ?? []) {
      const ei = (r.extracted_identity ?? {}) as Record<string, unknown>
      const platform = String(ei.platform ?? 'other')
      const when = (r.signal_date as string | null) ?? (r.created_at as string)
      const k = new Date(when).toISOString().slice(0, 10)
      const seriesKey = `${platform}_signals`
      if (!tsChannels.includes(seriesKey)) continue
      if (!bySeries.has(seriesKey)) bySeries.set(seriesKey, new Map())
      const m = bySeries.get(seriesKey)!
      m.set(k, (m.get(k) ?? 0) + 1)
    }
    for (const [k, v] of bySeries) {
      out.set(k, Array.from(v.entries()).map(([dayKey, value]) => ({ dayKey, value })))
    }
  }

  return out
}

function buildAllowedNumbers(
  r: number,
  lagDays: number,
  windowDays: number,
  a: SeriesSummary,
  b: SeriesSummary,
): Array<number | string> {
  // The narration is allowed to reference: the correlation strength
  // (rounded), the lag in days, the window (90 days), each channel's
  // min / max / latest / earliest, and zero / one / 100 (allowed by
  // the numbers-guard tolerator). We deliberately do NOT include
  // arbitrary ratios — the LLM must build sentences from these
  // primitives only.
  const base: Array<number | string> = [
    r,
    Math.abs(r),
    Number(r.toFixed(2)),
    Number(Math.abs(r).toFixed(2)),
    lagDays,
    windowDays,
    a.nonZeroDays,
    b.nonZeroDays,
    a.min, a.max, a.latest, a.earliest,
    b.min, b.max, b.latest, b.earliest,
  ]
  // Add formatted variants for floats (the narration may write "0.62"
  // or "0.6"; the guard normalises stripping). Plus integer rounds
  // for percentage-style mentions of latest/earliest deltas.
  const extras: Array<number | string> = []
  for (const n of base) {
    if (typeof n === 'number' && Number.isFinite(n)) {
      extras.push(Number(n.toFixed(1)))
      extras.push(Math.round(n))
    }
  }
  return [...base, ...extras].filter(
    (n) => n !== null && n !== undefined && Number.isFinite(typeof n === 'number' ? n : Number(n)),
  )
}

// ---------------------------------------------------------------------------
// Public: load the most recent un-narrated correlations + return narrations
// ---------------------------------------------------------------------------

/**
 * Compute (or fetch from cache) the narrations for the venue's recent
 * correlation rows. Returns up to MAX_NARRATIONS_PER_RUN narrations.
 *
 * Order: highest |r| first. Each narration is independently cached via
 * the standard insight cache (cache_key = FNV-1a of stable inputs).
 */
export async function generateCorrelationNarrationsForVenue(
  supabase: SupabaseClient,
  venueId: string,
  /** Force = bypass cache; coordinator-triggered refresh. */
  force = false,
): Promise<NarratedCorrelation[]> {
  // 1. Find recent correlation rows. Window = last 14 days. Top 5 by
  // |r|. Filter expired/dismissed so a coordinator dismissing the
  // engine's row removes the narration from the surface too.
  const since = new Date(Date.now() - RECENT_WINDOW_DAYS * 86400e3).toISOString()
  const { data: corrRows, error: fetchErr } = await supabase
    .from('intelligence_insights')
    .select('id, title, body, data_points, created_at, status')
    .eq('venue_id', venueId)
    .eq('insight_type', 'correlation')
    .gte('created_at', since)
    .neq('status', 'expired')
    .neq('status', 'dismissed')
    .limit(50)

  if (fetchErr) {
    console.error(
      '[correlation-narration] fetch correlations failed:',
      redactError(fetchErr),
    )
    return []
  }

  const rows = (corrRows ?? []) as CorrelationRow[]
  // Sort by |r| desc, take top N.
  const ranked = rows
    .filter((r) => {
      const rValue = r.data_points?.r
      return typeof rValue === 'number' && Number.isFinite(rValue)
    })
    .sort((a, b) => Math.abs(b.data_points?.r ?? 0) - Math.abs(a.data_points?.r ?? 0))
    .slice(0, MAX_NARRATIONS_PER_RUN)

  if (ranked.length === 0) return []

  // 2. For each row, build the narration. Sequential rather than
  // parallel: each narration is one Sonnet call gated by the same
  // cost-ceiling. Running in parallel could blow through the ceiling
  // before later iterations get to check it. Sequential = ~5 * 1-2s
  // worst case, which is acceptable for this surface (cron-driven
  // or coordinator-triggered, not request-path).
  const out: NarratedCorrelation[] = []
  for (const row of ranked) {
    try {
      const narrated = await narrateOne(supabase, venueId, row, force)
      if (narrated) out.push(narrated)
    } catch (err) {
      console.error(
        '[correlation-narration] narrateOne failed:',
        redactError(err),
      )
    }
  }
  return out
}

async function narrateOne(
  supabase: SupabaseClient,
  venueId: string,
  row: CorrelationRow,
  force: boolean,
): Promise<NarratedCorrelation | null> {
  const channelA = row.data_points?.channel_a
  const channelB = row.data_points?.channel_b
  const lagDays = row.data_points?.lag_days ?? 0
  const r = row.data_points?.r ?? 0
  const windowDays = row.data_points?.window_days ?? 90
  if (!channelA || !channelB) return null

  // 3. Pull the underlying series for each channel.
  const seriesMap = await loadSeriesForChannels(
    supabase,
    venueId,
    [channelA, channelB],
    windowDays,
  )
  const aPoints = seriesMap.get(channelA) ?? []
  const bPoints = seriesMap.get(channelB) ?? []
  const aSummary = summariseSeries(channelA, aPoints)
  const bSummary = summariseSeries(channelB, bPoints)

  const channelALabel = humanChannel(channelA)
  const channelBLabel = humanChannel(channelB)
  const pValue = effectivePValue(r, windowDays)
  const weakSignal = Math.abs(r) < WEAK_R_THRESHOLD || pValue > WEAK_P_THRESHOLD

  // 4. Build cache key. Stable inputs only — recent values shift daily,
  // so we DON'T fingerprint the full series; we fingerprint the
  // (channels, lag, r) triple plus the engine row's created_at-day.
  // Same engine row → same narration. New engine row (different r or
  // pair) → fresh narration.
  const cacheKey = buildCacheKey({
    correlationId: row.id,
    channelA,
    channelB,
    lagDays,
    rRounded: Number(r.toFixed(3)),
    createdAtDay: (row.created_at ?? '').slice(0, 10),
  })

  if (!force) {
    const cached = await lookupCachedInsight(
      supabase,
      venueId,
      'correlation_narration',
      row.id,
      cacheKey,
    )
    if (cached) {
      return {
        id: cached.id,
        correlationId: row.id,
        channelA,
        channelB,
        channelALabel,
        channelBLabel,
        lagDays,
        r,
        pValue,
        weakSignal,
        title: cached.title,
        body: cached.body,
        action: cached.action,
        confidence: cached.confidence,
        cached: true,
        createdAt: row.created_at,
        seriesA: aSummary.recentValues,
        seriesB: bSummary.recentValues,
      }
    }
  }

  // 5. Compose prompt + run Sonnet, gated by cost-ceiling.
  const allowedNumbers = buildAllowedNumbers(r, lagDays, windowDays, aSummary, bSummary)
  const directionWord = r >= 0 ? 'rose together' : 'moved in opposite directions'
  const lagDescription = lagDays === 0 ? 'on the same day' : `with about a ${lagDays}-day lag`

  const systemPrompt = `You are explaining a statistical correlation to a wedding venue
coordinator who is not a statistician. Output JSON with:
  - title: short headline (max ~80 chars). Reference both channels by their
    plain-English names. Do not include r-values or p-values in the title.
  - body: 2-3 plain-English sentences. Ground every claim in the
    listed numbers. Frame the cross-channel story as a coordinator
    would understand it ("mortgage rates went up; tour completions
    dropped two weeks later" — not "Pearson r=0.42, lag=14d").
  - action: ONE specific thing the coordinator should do this week,
    OR null if the signal is weak.

CRITICAL RULES:
- Never invent numbers. The ONLY numbers you may reference are the
  correlation strength, the lag in days, the window in days, and the
  recent min/max/latest values for each channel — all listed in the
  user prompt. No percentages, ratios, or ranks unless they are exact
  matches to the listed numbers.
- Never speculate beyond the data. If the correlation is weak (the
  user prompt will say "WEAK SIGNAL"), say so explicitly: "this signal
  is weak; the platform is flagging it but not staking a claim."
- Never claim causation. Use "preceded", "moved with", "tracked",
  "tended to", not "caused".
- Never name specific couples or vendors.
- Use the venue's voice but stay neutral / factual.
- Keep the body to 2-3 sentences. Coordinator-readable, not
  engineer-readable.`

  const userPrompt = `CROSS-LIMB CORRELATION

Channel A: ${channelALabel} (${channelA})
Channel B: ${channelBLabel} (${channelB})

Correlation strength: ${r.toFixed(2)} (${directionWord})
Lag: ${lagDays} days (${lagDescription})
Analysis window: ${windowDays} days
Approximate p-value: ${pValue.toFixed(3)}
${weakSignal ? '\nWEAK SIGNAL: r below 0.3 or p above 0.05. Disclaim explicitly in the body.\n' : ''}
Channel A recent activity:
  - non-zero days in window: ${aSummary.nonZeroDays}
  - earliest value: ${aSummary.earliest}
  - latest value: ${aSummary.latest}
  - min / max in window: ${aSummary.min} / ${aSummary.max}

Channel B recent activity:
  - non-zero days in window: ${bSummary.nonZeroDays}
  - earliest value: ${bSummary.earliest}
  - latest value: ${bSummary.latest}
  - min / max in window: ${bSummary.min} / ${bSummary.max}

Compose the JSON narration. 2-3 sentence body, plain English, no
made-up numbers.`

  let narration: InsightNarration | null = null

  // Cost-ceiling gate (Stream B / T5-α.2). When the venue is at 100%
  // ceiling, the deterministic fallback below still runs so the
  // coordinator sees *some* story even when paused.
  const gate = await gateForBrainCall(venueId)
  if (gate.ok) {
    try {
      const result = await callAI({
        systemPrompt,
        userPrompt,
        maxTokens: 320,
        temperature: 0.4,
        venueId,
        taskType: 'correlation_narration',
        tier: 'sonnet',
        promptVersion: CORRELATION_NARRATION_PROMPT_VERSION,
      })
      const parsed = JSON.parse(
        result.text.replace(/```json\n?/gi, '').replace(/```\n?/g, '').trim(),
      ) as Partial<InsightNarration>
      if (parsed.title && parsed.body) {
        narration = {
          title: parsed.title,
          body: parsed.body,
          action: parsed.action ?? null,
        }
      }
    } catch (err) {
      // redactError strips PII echoed by Anthropic 4xx errors.
      console.warn(
        '[correlation-narration] LLM call failed:',
        redactError(err),
      )
    }
  }

  // 6. Deterministic fallback when LLM unavailable / cost-paused / numbers-
  // guard rejects. Numbers in this fallback are sourced strictly from
  // the engine row, so the guard tolerates them.
  if (!narration) {
    const weakDisclaimer = weakSignal
      ? ' This signal is weak; the platform is flagging it but not staking a claim.'
      : ''
    narration = {
      title: weakSignal
        ? `Weak signal: ${channelALabel} and ${channelBLabel}`
        : `${channelALabel} ${lagDays > 0 ? 'preceded' : 'moved with'} ${channelBLabel}`,
      body: `${channelALabel} and ${channelBLabel} ${directionWord} ${lagDescription} over the last ${windowDays} days (correlation ${r.toFixed(2)}).${weakDisclaimer}`,
      action: weakSignal
        ? null
        : `Watch ${channelALabel} this week; if it shifts again, expect ${channelBLabel} to follow.`,
    }
  }

  // 7. Persist with numbers-guard via the shared infra. Surface
  // priority = |r| * 100 so the strongest correlations sort first;
  // weak signals sink to the bottom.
  const classical: ClassicalEvidence = {
    cacheKey,
    numbers: allowedNumbers,
    payload: {
      correlationId: row.id,
      channelA, channelB,
      channelALabel, channelBLabel,
      lagDays, r, pValue,
      windowDays,
      weakSignal,
      seriesASummary: {
        nonZeroDays: aSummary.nonZeroDays,
        min: aSummary.min, max: aSummary.max,
        earliest: aSummary.earliest, latest: aSummary.latest,
      },
      seriesBSummary: {
        nonZeroDays: bSummary.nonZeroDays,
        min: bSummary.min, max: bSummary.max,
        earliest: bSummary.earliest, latest: bSummary.latest,
      },
      seriesA: aSummary.recentValues,
      seriesB: bSummary.recentValues,
    },
    sampleSize: Math.min(aSummary.nonZeroDays, bSummary.nonZeroDays),
    effectSize: Math.min(1, Math.abs(r)),
  }

  const conf = confidenceFor({
    sampleSize: classical.sampleSize,
    effectSize: classical.effectSize,
  })

  const result = await persistInsight(supabase, {
    venueId,
    insightType: 'correlation_narration',
    contextId: row.id,
    category: 'market',
    surfaceLayer: 'on_demand',
    classical,
    narration,
    llmModelUsed: CLAUDE_MODEL,
    promptVersionUsed: CORRELATION_NARRATION_PROMPT_VERSION,
    confidence: conf.value,
    surfacePriority: Math.abs(r) * 100,
    priority: Math.abs(r) >= 0.7 ? 'high' : Math.abs(r) >= 0.5 ? 'medium' : 'low',
  })

  if (!result.ok) {
    if (result.numbersGuardViolations) {
      console.warn(
        '[correlation-narration] numbers-guard rejected narration:',
        result.numbersGuardViolations.map((v) => v.token).join(', '),
      )
    }
    // Degrade gracefully: re-narrate with the deterministic body
    // (which is guaranteed to pass the guard because every number
    // comes from classical.numbers).
    const safeBody = `${channelALabel} and ${channelBLabel} ${directionWord} ${lagDescription} over the last ${windowDays} days (correlation ${r.toFixed(2)}).${weakSignal ? ' This signal is weak; the platform is flagging it but not staking a claim.' : ''}`
    const safeNarration: InsightNarration = {
      title: narration.title.length > 80 ? narration.title.slice(0, 77) + '...' : narration.title,
      body: safeBody,
      action: weakSignal ? null : narration.action,
    }
    const retry = await persistInsight(supabase, {
      venueId,
      insightType: 'correlation_narration',
      contextId: row.id,
      category: 'market',
      surfaceLayer: 'on_demand',
      classical,
      narration: safeNarration,
      llmModelUsed: CLAUDE_MODEL,
      promptVersionUsed: CORRELATION_NARRATION_PROMPT_VERSION,
      confidence: conf.value,
      surfacePriority: Math.abs(r) * 100,
      priority: Math.abs(r) >= 0.7 ? 'high' : Math.abs(r) >= 0.5 ? 'medium' : 'low',
    })
    if (!retry.ok) {
      // Truly degenerate. Return in-memory only.
      return {
        id: row.id,
        correlationId: row.id,
        channelA, channelB,
        channelALabel, channelBLabel,
        lagDays, r, pValue,
        weakSignal,
        title: safeNarration.title,
        body: safeNarration.body,
        action: safeNarration.action,
        confidence: conf.value,
        cached: false,
        createdAt: row.created_at,
        seriesA: aSummary.recentValues,
        seriesB: bSummary.recentValues,
      }
    }
    return {
      id: retry.insightId ?? row.id,
      correlationId: row.id,
      channelA, channelB,
      channelALabel, channelBLabel,
      lagDays, r, pValue,
      weakSignal,
      title: safeNarration.title,
      body: safeNarration.body,
      action: safeNarration.action,
      confidence: conf.value,
      cached: false,
      createdAt: row.created_at,
      seriesA: aSummary.recentValues,
      seriesB: bSummary.recentValues,
    }
  }

  return {
    id: result.insightId ?? row.id,
    correlationId: row.id,
    channelA, channelB,
    channelALabel, channelBLabel,
    lagDays, r, pValue,
    weakSignal,
    title: narration.title,
    body: narration.body,
    action: narration.action,
    confidence: conf.value,
    cached: false,
    createdAt: row.created_at,
    seriesA: aSummary.recentValues,
    seriesB: bSummary.recentValues,
  }
}

// ---------------------------------------------------------------------------
// Public: read-only fetch of existing narration rows for a venue
// (used by the API route when the caller doesn't want to trigger
// re-generation; e.g. on the second page load after the cron has
// already filled the cache).
// ---------------------------------------------------------------------------

export async function listExistingNarrations(
  supabase: SupabaseClient,
  venueId: string,
): Promise<NarratedCorrelation[]> {
  const { data: rows, error } = await supabase
    .from('intelligence_insights')
    .select('id, title, body, action, confidence, data_points, created_at, context_id, surface_priority')
    .eq('venue_id', venueId)
    .eq('insight_type', 'correlation_narration')
    .neq('status', 'expired')
    .neq('status', 'dismissed')
    .order('surface_priority', { ascending: false, nullsFirst: false })
    .limit(MAX_NARRATIONS_PER_RUN)

  if (error) {
    console.error(
      '[correlation-narration] list narrations failed:',
      redactError(error),
    )
    return []
  }

  const out: NarratedCorrelation[] = []
  for (const row of (rows ?? []) as Array<{
    id: string
    title: string
    body: string
    action: string | null
    confidence: number
    data_points: Record<string, unknown> | null
    created_at: string
    context_id: string | null
  }>) {
    const dp = (row.data_points ?? {}) as Record<string, unknown>
    const channelA = String(dp.channelA ?? '')
    const channelB = String(dp.channelB ?? '')
    if (!channelA || !channelB) continue
    const r = Number(dp.r ?? 0)
    const lagDays = Number(dp.lagDays ?? 0)
    const pValue = Number(dp.pValue ?? 1)
    const weakSignal = Boolean(dp.weakSignal)
    const seriesA = Array.isArray(dp.seriesA)
      ? (dp.seriesA as Array<{ dayKey: string; value: number }>)
      : []
    const seriesB = Array.isArray(dp.seriesB)
      ? (dp.seriesB as Array<{ dayKey: string; value: number }>)
      : []
    out.push({
      id: row.id,
      correlationId: row.context_id ?? row.id,
      channelA, channelB,
      channelALabel: String(dp.channelALabel ?? humanChannel(channelA)),
      channelBLabel: String(dp.channelBLabel ?? humanChannel(channelB)),
      lagDays, r, pValue, weakSignal,
      title: row.title,
      body: row.body,
      action: row.action,
      confidence: row.confidence ?? 0.5,
      cached: true,
      createdAt: row.created_at,
      seriesA, seriesB,
    })
  }
  return out
}
