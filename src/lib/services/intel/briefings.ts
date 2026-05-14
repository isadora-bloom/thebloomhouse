/**
 * Bloom House: AI Briefing Generator
 *
 * Generates weekly and monthly intelligence briefings for wedding venues.
 * Aggregates data from weddings, trends, weather, FRED demand, and
 * anomaly detection, then uses AI to produce structured, actionable
 * summaries.
 *
 * Briefing types:
 *   - weekly:  7-day window, tactical recommendations
 *   - monthly: 30-day window, strategic / month-over-month analysis
 *   - anomaly: triggered ad-hoc by anomaly detection (not generated here)
 */

import { createServiceClient } from '@/lib/supabase/service'
import { callAIJson } from '@/lib/ai/client'
import { withAiCache } from '@/lib/ai/cache'
import { gateForBrainCall } from '@/lib/services/cost-ceiling'
import { buildCoordinatorPrompt } from '@/lib/ai/coordinator-prompt'
import { detectTrendDeviations } from './trends'
import { getWeatherForDateRange } from './weather'
import { getLatestIndicators, calculateDemandScore } from './fred-demand'
import { getActiveAlerts } from './anomaly-detection'
import { getAnomalyDisplay } from '@/lib/services/anomaly/display-labels'
import {
  getVenueManifest,
  manifestToSystemPrompt,
} from '@/lib/services/manifest/venue-manifest'
import { sendEmail as sendGmail } from '../email/gmail'
import { sendEmail as sendTransactionalEmail } from '../email/transport'
import {
  loadVenueAutoContextRollup,
  type AutoContextThemeRollup,
} from '../identity/auto-context-loader'

/**
 * Prompt revision identifiers. Per Playbook OPS-21.5.1 / T1-E.
 * Bump when the corresponding system prompt changes so the in-memory
 * cache (withAiCache) invalidates on prompt updates.
 * See PROMPTS-CHANGELOG.md for version history.
 *
 * 2026-05-09 (TRENDS-DIAGNOSIS Fix 4 / Finding F): bumped both v1.0 →
 * v1.1. Briefings now receive a MACRO CONTEXT block (cultural moments
 * + FRED deltas + upcoming calendar events + correlation narrations)
 * and the system prompts instruct the LLM to weave them into the
 * narrative when present.
 */
// 2026-05-09 LLM-CALL-INVENTORY personality drift #3: bumped to v2.0
// when migrated to the canonical coordinator-prompt assembler.
//
// 2026-05-09 (Wave 1C — emotional themes) bumped both v2.0 → v2.1:
// briefings now receive an EMOTIONAL THEMES THIS PERIOD block built by
// `aggregateAutoContextThemes` so the venue's strategic surface
// reflects what couples are carrying beyond logistics. Sensitive
// categories are aggregated as counts; couples are never named
// alongside sensitive themes (aggregate ≠ disclose doctrine).
export const BRIEFING_PROMPT_VERSION = 'briefings.prompt.v2.1'
const MONTHLY_BRIEFING_PROMPT_VERSION = 'briefings.monthly.v2.1'

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface BriefingMetrics {
  new_inquiries: number
  tours_scheduled: number
  bookings: number
  lost_deals: number
  revenue_booked: number
}

interface BriefingContent {
  summary: string
  metrics: BriefingMetrics
  demand_outlook: { score: number; outlook: string }
  trend_highlights: string[]
  weather_outlook: string
  anomaly_summary: string[]
  recommendations: string[]
  generated_at: string
  // Connective tissue (gap E — 2026-04-30). Phase B counts preserved
  // structurally so the email body and dashboard render them
  // deterministically — not at the AI's mercy. The AI is still
  // instructed (via WEEKLY_SYSTEM_PROMPT) to weave them into the
  // summary, but if it doesn't, the structured field is the
  // fallback the rendering layer uses.
  phase_b?: {
    new_candidates: number
    platforms_active: number
    auto_linked: number
    high_funnel_non_converting: number
    open_conflicts: number
  }
  // Connective tissue II / fix #2 (2026-04-30). Anomaly detection
  // generates per-alert ai_explanation + ranked causes with actions.
  // Was being squeezed into the alertSummary string for the AI
  // prompt, then summarized away by the AI itself. Preserved
  // structurally so the email body always shows the full reasoning
  // verbatim, and the BriefingsPanel on the Intelligence Dashboard
  // can render them.
  anomaly_details?: Array<{
    metric: string
    alert_type: string
    severity: 'info' | 'warning' | 'critical'
    explanation: string
    top_action: string | null
  }>
  // Wave 1C (2026-05-09): emotional theme rollup. Counts + trend deltas
  // by category, with redacted exemplars for sensitive content. Never
  // names couples alongside sensitive themes — aggregate ≠ disclose.
  // Briefings page renders this as a "Couples we learned about this
  // week" section.
  emotional_themes?: AutoContextThemeRollup[]
}

interface MonthlyBriefingContent extends BriefingContent {
  month_over_month: {
    inquiries_change: number
    bookings_change: number
    revenue_change: number
  }
  strategic_recommendations: string[]
}

interface BriefingRow {
  id: string
  venue_id: string
  briefing_type: string
  content: BriefingContent | MonthlyBriefingContent
  delivered_via: string | null
  delivered_at: string | null
  created_at: string
  venues?: { name: string | null } | null
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function daysAgo(days: number): string {
  const d = new Date()
  d.setDate(d.getDate() - days)
  return d.toISOString().split('T')[0]
}

function daysFromNow(days: number): string {
  const d = new Date()
  d.setDate(d.getDate() + days)
  return d.toISOString().split('T')[0]
}

function today(): string {
  return new Date().toISOString().split('T')[0]
}

/**
 * Phase B/C state summary for the weekly briefing (D1.3 — 2026-04-30).
 * Counts of: new candidates, auto-links, non-converting high-funnel,
 * open conflicts. All rolling 7d.
 */
interface PhaseBWeeklyState {
  newCandidates: number
  platformsActive: number
  autoLinked: number
  highFunnelNonConverting: number
  openConflicts: number
}

async function getPhaseBWeeklyState(venueId: string): Promise<PhaseBWeeklyState> {
  const supabase = createServiceClient()
  const sevenDaysAgo = new Date(Date.now() - 7 * 86_400_000).toISOString()

  // PD.1 fix #10: each sub-query is awaited individually with a
  // narrow try/catch so one failure (e.g. an RLS edge case) doesn't
  // wipe the whole section. The previous shape silently dropped to
  // all-zeros without logging which query failed.
  const state: PhaseBWeeklyState = {
    newCandidates: 0,
    platformsActive: 0,
    autoLinked: 0,
    highFunnelNonConverting: 0,
    openConflicts: 0,
  }

  try {
    const { data, error } = await supabase
      .from('candidate_identities')
      .select('source_platform')
      .eq('venue_id', venueId)
      .is('deleted_at', null)
      .gte('first_seen', sevenDaysAgo)
    if (error) throw error
    const rows = (data ?? []) as Array<{ source_platform: string }>
    state.newCandidates = rows.length
    state.platformsActive = new Set(rows.map((c) => c.source_platform)).size
  } catch (err) {
    console.warn('[briefings] Phase B newCandidates fetch failed:', err)
  }

  try {
    // PD.1 fix #9: include coordinator-decided links too. The
    // /intel/candidates review queue's "Link to lead" button writes
    // attribution_events with decided_by='coordinator' — those are
    // legitimate auto-links from the system's perspective and were
    // being undercounted before.
    // Pattern A (mig 336): live view excludes tombstoned duplicates so
    // Briefings doesn't double-count the same auto-link.
    const { count, error } = await supabase
      .from('attribution_events_live')
      .select('id', { count: 'exact', head: true })
      .eq('venue_id', venueId)
      .in('decided_by', ['auto', 'ai', 'coordinator'])
      .gte('decided_at', sevenDaysAgo)
    if (error) throw error
    state.autoLinked = count ?? 0
  } catch (err) {
    console.warn('[briefings] Phase B autoLinked fetch failed:', err)
  }

  try {
    const { count, error } = await supabase
      .from('candidate_identities')
      .select('id', { count: 'exact', head: true })
      .eq('venue_id', venueId)
      .gte('funnel_depth', 3)
      .is('resolved_wedding_id', null)
      .is('deleted_at', null)
      .neq('review_status', 'reviewed')
    if (error) throw error
    state.highFunnelNonConverting = count ?? 0
  } catch (err) {
    console.warn('[briefings] Phase B highFunnelNonConverting fetch failed:', err)
  }

  try {
    // Pattern A (mig 336) + TIER 2e (mig 338): live view dedupes
    // duplicates AND we filter to UNRESOLVED conflicts only. The
    // 110-conflict queue from the audit drops to ~15-25 once the
    // destination/low-info/high-confidence auto-resolve rules fire.
    const { count, error } = await supabase
      .from('attribution_events_live')
      .select('id', { count: 'exact', head: true })
      .eq('venue_id', venueId)
      .not('conflict_with_legacy_source', 'is', null)
      .is('conflict_resolution_state', null)
    if (error) throw error
    state.openConflicts = count ?? 0
  } catch (err) {
    console.warn('[briefings] Phase B openConflicts fetch failed:', err)
  }

  return state
}

/**
 * TRENDS-DIAGNOSIS Fix 4 / Finding F (2026-05-09): macro context for
 * briefings.
 *
 * The pre-fix briefing prompts had access to FRED demand-score and
 * trend deviations only. They could NOT name a confirmed cultural
 * moment, cite an upcoming federal holiday, quote an engine-discovered
 * cross-channel pair, or reference the latest macro indicator deltas.
 * Briefings therefore couldn't tell macro stories — exactly the YC-
 * partner HIGH 12 complaint.
 *
 * This helper pulls all four:
 *   - confirmed cultural_moments overlapping the last 60 days, scoped
 *     to the venue's per-venue confirmation state (migration 167).
 *   - top-5 most-recent correlation_narration rows by surface_priority.
 *   - latest FRED indicator values + 30-day delta per panel series.
 *   - upcoming external_calendar_events in the next 30 days, hierarchy-
 *     matched to the venue's geo_scope (us → us_<state>).
 *
 * Returned as a pre-formatted string block so the briefing prompts can
 * concatenate it into their userPrompt without re-shaping. Empty
 * sections are omitted entirely so the LLM doesn't see "(none)" stubs.
 */
interface BriefingMacroContext {
  block: string
  hasContent: boolean
}

async function getBriefingMacroContext(venueId: string): Promise<BriefingMacroContext> {
  const supabase = createServiceClient()
  const NOW_MS = Date.now()
  const DAY_MS = 86_400_000
  const sixtyDaysAgo = new Date(NOW_MS - 60 * DAY_MS).toISOString()
  const thirtyDaysFromNow = new Date(NOW_MS + 30 * DAY_MS).toISOString().slice(0, 10)
  const today = new Date().toISOString().slice(0, 10)

  const sections: string[] = []

  // Resolve venue state for calendar-event geo filtering.
  let venueState: string = ''
  try {
    const { data: venue } = await supabase
      .from('venues')
      .select('state')
      .eq('id', venueId)
      .maybeSingle()
    venueState = ((venue?.state as string | null) ?? '').trim().toLowerCase()
  } catch (err) {
    console.warn('[briefings] macro context: venue state lookup failed:', err)
  }
  const venueScope = venueState && /^[a-z]{2}$/.test(venueState) ? `us_${venueState}` : 'us'
  const allowedScopes = new Set<string>(['us'])
  if (venueScope !== 'us') allowedScopes.add(venueScope)

  // Run all four pulls in parallel; each is best-effort and zero-rows
  // is a perfectly normal outcome (cultural channel may legitimately
  // be empty for a venue that hasn't confirmed anything yet).
  const [culturalRes, narrationRes, fredRes, calendarRes] = await Promise.all([
    supabase
      .from('venue_cultural_moment_state')
      .select('cultural_moments!inner(title, category, start_at, end_at, influence_weight, geo_scope)')
      .eq('venue_id', venueId)
      .eq('state', 'confirmed')
      .gte('cultural_moments.end_at', sixtyDaysAgo)
      .order('cultural_moments(start_at)', { ascending: false })
      .limit(20),
    supabase
      .from('intelligence_insights')
      .select('title, body, data_points, created_at, surface_priority')
      .eq('venue_id', venueId)
      .eq('insight_type', 'correlation_narration')
      .neq('status', 'expired')
      .neq('status', 'dismissed')
      .order('surface_priority', { ascending: false, nullsFirst: false })
      .order('created_at', { ascending: false })
      .limit(5),
    supabase
      .from('fred_indicators')
      .select('series_id, value, observation_date')
      .order('observation_date', { ascending: false })
      .limit(50),
    supabase
      .from('external_calendar_events')
      .select('title, category, start_date, end_date, geo_scope')
      .is('deleted_at', null)
      .lte('start_date', thirtyDaysFromNow)
      .gte('end_date', today)
      .order('start_date', { ascending: true })
      .limit(50),
  ])

  // Cultural moments — venue-confirmed only.
  type NestedMoment = {
    cultural_moments:
      | { title?: string; category?: string | null; start_at?: string; end_at?: string | null; influence_weight?: number | null }
      | Array<{ title?: string; category?: string | null; start_at?: string; end_at?: string | null; influence_weight?: number | null }>
      | null
  }
  const moments = ((culturalRes.data ?? []) as unknown as NestedMoment[])
    .map((r) => {
      const m = Array.isArray(r.cultural_moments) ? r.cultural_moments[0] : r.cultural_moments
      return m ?? null
    })
    .filter((m): m is { title?: string; category?: string | null; start_at?: string; end_at?: string | null; influence_weight?: number | null } => m !== null)
  if (moments.length > 0) {
    const lines = moments
      .map((m) => {
        const parts = [`"${m.title ?? ''}"`]
        if (m.category) parts.push(m.category)
        const start = (m.start_at ?? '').split('T')[0]
        const end = m.end_at ? (m.end_at ?? '').split('T')[0] : 'ongoing'
        parts.push(`window=${start} to ${end}`)
        if (m.influence_weight != null) parts.push(`influence=${m.influence_weight}`)
        return `  - ${parts.join(', ')}`
      })
      .join('\n')
    sections.push(`CONFIRMED CULTURAL MOMENTS (last 60 days):\n${lines}`)
  }

  // FRED latest + 30d delta.
  type FredRow = { series_id: string; value: number | null; observation_date: string | null }
  const seriesObservations = new Map<string, { date: string; value: number }[]>()
  for (const r of (fredRes.data ?? []) as FredRow[]) {
    if (r.value == null || !r.observation_date) continue
    const arr = seriesObservations.get(r.series_id) ?? []
    arr.push({ date: r.observation_date, value: Number(r.value) })
    seriesObservations.set(r.series_id, arr)
  }
  const FRED_LABELS: Record<string, string> = {
    CPIAUCSL: 'CPI (headline)',
    MORTGAGE30US: '30y mortgage rate',
    SP500: 'S&P 500',
    UNRATE: 'US unemployment',
    UMCSENT: 'Consumer sentiment',
    PSAVERT: 'Personal savings rate',
    CONCCONF: 'Consumer confidence',
    HOUST: 'Housing starts',
    DSPIC96: 'Real disposable income',
  }
  const fredLines: string[] = []
  for (const [seriesId, obs] of seriesObservations) {
    obs.sort((a, b) => b.date.localeCompare(a.date))
    const latest = obs[0]
    const cutoff30 = NOW_MS - 30 * DAY_MS
    const prior = obs.find((o) => new Date(`${o.date}T00:00:00Z`).getTime() <= cutoff30)
    const label = FRED_LABELS[seriesId] ?? seriesId
    const parts = [`${label}=${latest.value} (as of ${latest.date})`]
    if (prior) parts.push(`Δ30d=${(latest.value - prior.value).toFixed(2)}`)
    fredLines.push(`  - ${parts.join(', ')}`)
  }
  if (fredLines.length > 0) {
    sections.push(`FRED INDICATORS (latest + 30d delta):\n${fredLines.join('\n')}`)
  }

  // Upcoming calendar events (next 30d, hierarchy-matched to venue scope).
  type CalRow = { title: string | null; category: string | null; start_date: string; end_date: string; geo_scope: string | null }
  const upcomingCal = ((calendarRes.data ?? []) as CalRow[])
    .filter((r) => allowedScopes.has((r.geo_scope ?? '').toLowerCase()))
    .slice(0, 20)
  if (upcomingCal.length > 0) {
    const lines = upcomingCal
      .map((e) => `  - ${e.start_date}: ${e.title ?? ''} [${e.category ?? 'other'}] (${e.geo_scope ?? 'us'})`)
      .join('\n')
    sections.push(`UPCOMING CALENDAR EVENTS (next 30d, region-scoped):\n${lines}`)
  }

  // Correlation narrations (top 5 most-recent).
  type NarrationRow = { title: string | null; body: string | null; data_points: Record<string, unknown> | null; created_at: string | null }
  const narrationLines: string[] = []
  for (const r of (narrationRes.data ?? []) as NarrationRow[]) {
    const dp = r.data_points ?? {}
    const channelA = String(dp.channel_a ?? dp.channelA ?? '')
    const channelB = String(dp.channel_b ?? dp.channelB ?? '')
    if (!channelA || !channelB) continue
    const r_val = Number(dp.r ?? 0)
    const lagDays = Number(dp.lag_days ?? dp.lagDays ?? 0)
    const lagPart = lagDays === 0 ? 'same-day' : `${lagDays}-day lag`
    const directionPart = r_val >= 0 ? 'positive' : 'inverse'
    const trimmedBody = (r.body ?? '').replace(/\s+/g, ' ').trim().slice(0, 240)
    narrationLines.push(
      `  - "${r.title ?? ''}" (${channelA} × ${channelB}, r=${r_val.toFixed(2)} ${directionPart}, ${lagPart}): ${trimmedBody}`,
    )
  }
  if (narrationLines.length > 0) {
    sections.push(
      `CORRELATION NARRATIONS (engine-discovered cross-channel pairs, top 5):\n${narrationLines.join('\n')}`,
    )
  }

  return {
    block: sections.length > 0 ? sections.join('\n\n') : '',
    hasContent: sections.length > 0,
  }
}

/**
 * Query wedding-related metrics for a venue over a date window.
 */
async function getWeddingMetrics(
  venueId: string,
  fromDate: string,
  toDate: string
): Promise<BriefingMetrics> {
  const supabase = createServiceClient()

  // New inquiries in the window. T5-Rixey-LL: window on inquiry_date
  // (real arrival time) not created_at (import time). Briefings shown
  // to coordinators must reflect when leads ACTUALLY landed, not when
  // the row was inserted into Supabase.
  const { count: newInquiries } = await supabase
    .from('weddings')
    .select('id', { count: 'exact', head: true })
    .eq('venue_id', venueId)
    .gte('inquiry_date', fromDate)
    .lte('inquiry_date', toDate)

  // Tours scheduled in the window
  const { count: toursScheduled } = await supabase
    .from('weddings')
    .select('id', { count: 'exact', head: true })
    .eq('venue_id', venueId)
    .not('tour_date', 'is', null)
    .gte('tour_date', fromDate)
    .lte('tour_date', toDate)

  // Bookings confirmed in the window
  const { count: bookings } = await supabase
    .from('weddings')
    .select('id', { count: 'exact', head: true })
    .eq('venue_id', venueId)
    .eq('status', 'booked')
    .gte('booked_at', fromDate)
    .lte('booked_at', toDate)

  // Lost deals in the window
  const { count: lostDeals } = await supabase
    .from('weddings')
    .select('id', { count: 'exact', head: true })
    .eq('venue_id', venueId)
    .eq('status', 'lost')
    .gte('updated_at', fromDate)
    .lte('updated_at', toDate)

  // Revenue booked in the window
  const { data: revenueRows } = await supabase
    .from('weddings')
    .select('quoted_price')
    .eq('venue_id', venueId)
    .eq('status', 'booked')
    .gte('booked_at', fromDate)
    .lte('booked_at', toDate)

  const revenueBooked = (revenueRows ?? []).reduce(
    (sum, row) => sum + (Number(row.quoted_price) || 0),
    0
  )

  return {
    new_inquiries: newInquiries ?? 0,
    tours_scheduled: toursScheduled ?? 0,
    bookings: bookings ?? 0,
    lost_deals: lostDeals ?? 0,
    revenue_booked: revenueBooked,
  }
}

// ---------------------------------------------------------------------------
// System prompts
// ---------------------------------------------------------------------------

const WEEKLY_TASK_INSTRUCTIONS = `Generate a concise, actionable weekly briefing. Recommendations should be concrete actions the venue can take THIS WEEK. Tone: professional but warm, like a trusted advisor.

Return a JSON object with these exact fields:
- summary: string (2-3 sentence executive summary of the week)
- trend_highlights: string[] (2-3 notable trend movements in plain English)
- weather_outlook: string (natural language weather summary for the next 14 days)
- anomaly_summary: string[] (active anomalies in plain English, empty array if none)
- recommendations: string[] (2-4 actionable recommendations for this week)

The user prompt also includes a PLATFORM SIGNAL HEALTH section with new candidates, auto-linked count, high-funnel non-converting, and conflicts. When ANY of these numbers is non-zero:
  - Mention them naturally in the summary (e.g. "We saw 23 new platform candidates land this week, 4 of which auto-linked to existing leads.")
  - When high-funnel non-converting > 5, add a recommendation about re-engaging them (the /intel/sources cohort panel surfaces who).
  - When conflicts > 0, add a recommendation to clear the candidate review queue.

The user prompt may also include a MACRO CONTEXT section with confirmed cultural moments, FRED indicator deltas (CPI, mortgage rate, S&P, unemployment, sentiment), upcoming calendar events scoped to the venue's region, and correlation narrations (engine-discovered cross-channel pairs in plain English). When that section is present:
  - Weave the most relevant macro signal into the summary (e.g. "Mortgage rates climbed 30bps this month and our engine flagged a 60-day lag to inquiry softening.").
  - When a correlation narration is recent and venue-relevant (its pair_class isn't macro_x_macro), prefer quoting its title + r over re-describing the underlying numbers yourself.
  - When an upcoming calendar event sits in the next 14 days, mention it as a context cue for the recommendations (e.g. "Memorial Day weekend lands inside this window, expect tour-request volatility.").
  - Do NOT invent macro relationships; if the section is absent or empty, omit macro language from the briefing entirely.

The user prompt may also include an EMOTIONAL THEMES THIS PERIOD section listing categories (life_context / family / vendors / budget / health / dietary / cultural / preferences / etc.) with note counts, distinct couple counts, and percentage trend deltas vs the prior period. Some categories are tagged "[contains sensitive , do not name couples]". When that section is present:
  - Weave 1-2 of the strongest themes into the narrative, what the venue is hearing from couples right now beyond logistics. ("Five couples flagged vendor preferences this week and three mentioned cultural ceremony asks, both up vs last week.")
  - For categories tagged sensitive, report the count only. NEVER name a couple alongside a sensitive theme. NEVER quote a sensitive exemplar verbatim. Treat the theme as a signal about the venue's audience, not about an individual.
  - Do NOT invent themes. If the section is absent or empty, omit emotional-theme language entirely.

Be direct and specific. Quote provided numbers. Do not hedge or use vague language.`

const MONTHLY_TASK_INSTRUCTIONS = `Generate a strategic monthly briefing. Focus on big-picture trends, month-over-month momentum, and longer-term strategic recommendations. Tone: professional but warm, like a trusted advisor delivering a board-level summary.

Return a JSON object with these exact fields:
- summary: string (2-3 sentence executive summary of the month)
- trend_highlights: string[] (2-3 notable trend movements over the month)
- weather_outlook: string (general seasonal weather outlook)
- anomaly_summary: string[] (anomalies that occurred this month, empty array if none)
- recommendations: string[] (2-4 actionable tactical recommendations)
- strategic_recommendations: string[] (2-3 bigger-picture strategic recommendations for the coming month)

The user prompt may include a MACRO CONTEXT block with cultural moments, FRED indicator deltas, upcoming calendar events, and engine-discovered correlation narrations. When that block is present:
  - Surface the most relevant macro signal in the strategic_recommendations (e.g. "Mortgage rate climbed 60bps over the month and the engine flagged an inverse correlation with tour completions at 60-day lag, consider revisiting payment-plan messaging.").
  - Prefer quoting a correlation narration's title verbatim rather than re-describing the underlying numbers yourself.
  - Do NOT invent macro relationships; if the block is absent or empty, write the briefing without macro language.

The user prompt may also include an EMOTIONAL THEMES THIS PERIOD block listing what couples are mentioning beyond logistics, with counts, distinct couple counts, and trend deltas vs the prior month. Some categories are tagged "[contains sensitive , do not name couples]". When that block is present:
  - Weave 1-2 of the strongest themes into the strategic narrative ("Cultural ceremony asks doubled vs last month, plus six couples mentioned multi-religious blends, the venue is hearing a clear shift toward fusion programming.").
  - For sensitive-tagged categories report counts only. NEVER name a couple alongside a sensitive theme. NEVER quote a sensitive exemplar.
  - Do NOT invent themes; if the block is absent or empty, omit emotional-theme language.

Be decisive in your recommendations.`

// ---------------------------------------------------------------------------
// 1. generateWeeklyBriefing
// ---------------------------------------------------------------------------

/**
 * Gathers data from the last 7 days and generates an AI-powered weekly
 * briefing. Inserts the result into ai_briefings and returns it.
 */
export async function generateWeeklyBriefing(
  venueId: string
): Promise<BriefingContent | null> {
  // Cost-ceiling gate (T5-α.2). Cron path already filters paused
  // venues via filterActiveVenues; this is belt-and-suspenders for
  // the race where pause flips between filter and call, plus
  // covers the /api/intel/briefings POST path which doesn't filter.
  // Skip silently per audit guidance — caller treats null as "no
  // briefing this run". OPS-21.4.3.
  const gate = await gateForBrainCall(venueId)
  if (!gate.ok) {
    console.log(`[briefings] weekly briefing skipped — venue ${venueId} cost-ceiling paused`)
    return null
  }

  const fromDate = daysAgo(7)
  const toDate = today()

  // Gather all data sources in parallel. Pre-compute the PRIOR week
  // alongside the current week so the LLM sees deltas as INPUT
  // (not as something it has to compute → invent → trip ANTI-19.9-A).
  // The 14-7 day prior window is the canonical comparison.
  const priorFrom = daysAgo(14)
  const priorTo = daysAgo(7)
  // Wave 1C (2026-05-09): emotional theme rollup over 7d, with the
  // prior 7d implied by the loader for trend deltas. Soft-context is
  // enrichment, so a load failure returns empty rollups + null block
  // and the LLM simply doesn't see the section.
  const supabaseForThemes = createServiceClient()
  const [metrics, priorMetrics, deviations, weather, indicators, alerts, phaseB, macroContext, themePulse] = await Promise.all([
    getWeddingMetrics(venueId, fromDate, toDate),
    getWeddingMetrics(venueId, priorFrom, priorTo),
    detectTrendDeviations(venueId),
    getWeatherForDateRange(venueId, today(), daysFromNow(14)),
    getLatestIndicators(),
    getActiveAlerts(venueId),
    getPhaseBWeeklyState(venueId),
    // TRENDS-DIAGNOSIS Fix 4 / Finding F (2026-05-09).
    getBriefingMacroContext(venueId),
    loadVenueAutoContextRollup(supabaseForThemes, venueId, 7, {
      headerLabel: 'EMOTIONAL THEMES THIS WEEK',
      maxThemes: 8,
    }),
  ])

  // Classical compute: deltas + change percentages. The LLM never
  // computes these. ANTI-19.9-A.
  function pctChange(current: number, prior: number): number {
    if (prior === 0) return current === 0 ? 0 : 100
    return Math.round(((current - prior) / prior) * 1000) / 10
  }
  const deltas = {
    inquiries_change_pct: pctChange(metrics.new_inquiries, priorMetrics.new_inquiries),
    tours_change_pct: pctChange(metrics.tours_scheduled, priorMetrics.tours_scheduled),
    bookings_change_pct: pctChange(metrics.bookings, priorMetrics.bookings),
    revenue_change_pct: pctChange(metrics.revenue_booked, priorMetrics.revenue_booked),
  }

  const demandScore = calculateDemandScore(indicators)

  // Build a weather summary for the AI prompt
  const weatherSummary = weather.length > 0
    ? weather.map((w) => {
        const parts = [`${w.date}:`]
        if (w.high_temp != null) parts.push(`High ${w.high_temp}F`)
        if (w.low_temp != null) parts.push(`Low ${w.low_temp}F`)
        if (w.precipitation != null) parts.push(`Precip ${w.precipitation}in`)
        if (w.conditions) parts.push(w.conditions)
        return parts.join(' ')
      }).join('\n')
    : 'No weather data available.'

  // Format trend deviations
  const trendSummary = deviations.length > 0
    ? deviations.map(
        (d) =>
          `"${d.term}" (${d.category}): ${d.direction} ${Math.abs(d.changePercent)}%`
      ).join('\n')
    : 'No significant trend deviations detected.'

  // Format anomaly alerts
  const alertSummary = (alerts ?? []).length > 0
    ? (alerts as { alert_type: string; metric_name: string; ai_explanation: string | null }[])
        .map((a) => `[${a.alert_type}] ${a.metric_name}: ${a.ai_explanation ?? 'No explanation'}`)
        .join('\n')
    : 'No active anomaly alerts.'

  // Build the user prompt outside the cache wrapper so the key is stable.
  const weeklyUserPrompt = `Weekly data for the venue (last 7 days):

METRICS (current week):
- New inquiries: ${metrics.new_inquiries}
- Tours scheduled: ${metrics.tours_scheduled}
- Bookings confirmed: ${metrics.bookings}
- Lost deals: ${metrics.lost_deals}
- Revenue booked: $${metrics.revenue_booked.toLocaleString()}

PRIOR WEEK (for comparison):
- New inquiries: ${priorMetrics.new_inquiries}
- Tours scheduled: ${priorMetrics.tours_scheduled}
- Bookings confirmed: ${priorMetrics.bookings}
- Lost deals: ${priorMetrics.lost_deals}
- Revenue booked: $${priorMetrics.revenue_booked.toLocaleString()}

PRE-COMPUTED CHANGES (use these — do NOT compute your own):
- Inquiries: ${deltas.inquiries_change_pct >= 0 ? '+' : ''}${deltas.inquiries_change_pct}%
- Tours: ${deltas.tours_change_pct >= 0 ? '+' : ''}${deltas.tours_change_pct}%
- Bookings: ${deltas.bookings_change_pct >= 0 ? '+' : ''}${deltas.bookings_change_pct}%
- Revenue: ${deltas.revenue_change_pct >= 0 ? '+' : ''}${deltas.revenue_change_pct}%

DEMAND SCORE: ${demandScore.score}/100 (${demandScore.outlook})

SEARCH TREND DEVIATIONS:
${trendSummary}

14-DAY WEATHER FORECAST:
${weatherSummary}

ANOMALY ALERTS:
${alertSummary}

PLATFORM SIGNAL HEALTH (last 7 days):
- New candidate identities: ${phaseB.newCandidates} across ${phaseB.platformsActive} platform${phaseB.platformsActive === 1 ? '' : 's'}
- Auto-linked to leads: ${phaseB.autoLinked} (Tier 1 deterministic + Tier 2 AI)
- High-funnel non-converting: ${phaseB.highFunnelNonConverting} candidates engaged deeply but didn't inquire
- Conflicts to review: ${phaseB.openConflicts}
${macroContext.hasContent ? `\nMACRO CONTEXT (cultural / FRED / calendar / correlation narrations):\n${macroContext.block}\n` : ''}${themePulse.block ? `\n${themePulse.block}\n` : ''}
Generate the weekly briefing.`

  // Call AI to generate the briefing narrative.
  // withAiCache de-dupes concurrent cron fires + coordinator "Refresh"
  // clicks within the 5-min default TTL. Cache key is venue + date
  // window start + prompt version (so prompt bumps invalidate the cache).
  const weeklyBuilt = await buildCoordinatorPrompt({
    venueId,
    surface: 'briefing_weekly',
    taskInstructions: WEEKLY_TASK_INSTRUCTIONS,
    numbersGuard: {
      new_inquiries: metrics.new_inquiries,
      tours_scheduled: metrics.tours_scheduled,
      bookings: metrics.bookings,
      lost_deals: metrics.lost_deals,
      revenue_booked: metrics.revenue_booked,
      prior_new_inquiries: priorMetrics.new_inquiries,
      prior_tours_scheduled: priorMetrics.tours_scheduled,
      prior_bookings: priorMetrics.bookings,
      prior_revenue_booked: priorMetrics.revenue_booked,
      inquiries_change_pct: deltas.inquiries_change_pct,
      tours_change_pct: deltas.tours_change_pct,
      bookings_change_pct: deltas.bookings_change_pct,
      revenue_change_pct: deltas.revenue_change_pct,
      demand_score: demandScore.score,
      new_candidates: phaseB.newCandidates,
      auto_linked: phaseB.autoLinked,
      high_funnel_non_converting: phaseB.highFunnelNonConverting,
      open_conflicts: phaseB.openConflicts,
    },
  })

  // TIER 1 / Pattern B (2026-05-14): inject venue manifest as the
  // FIRST chunk of the system prompt. Without this, the audit caught
  // briefings hallucinating "80 inquiries" when the real number was
  // different. With the manifest the model sees what tables it has,
  // what's empty, and what's out of scope — so it composes prose
  // over verifiable numbers instead of inventing them.
  const manifest = await getVenueManifest(venueId)
  const manifestPrompt = manifestToSystemPrompt(manifest)
  const systemPromptWithManifest = `${manifestPrompt}\n\n---\n\n${weeklyBuilt.systemPrompt}`
  const aiResult = await withAiCache(
    `briefing:${venueId}:${fromDate}:${weeklyBuilt.promptVersion}`,
    () => callAIJson<{
      summary: string
      trend_highlights: string[]
      weather_outlook: string
      anomaly_summary: string[]
      recommendations: string[]
    }>({
      systemPrompt: systemPromptWithManifest,
      userPrompt: weeklyUserPrompt,
      maxTokens: 1500,
      temperature: 0.4,
      venueId,
      taskType: 'weekly_briefing',
      promptVersion: weeklyBuilt.promptVersion,
      contentTier: weeklyBuilt.contentTier,
    }),
  )

  // Connective II / fix #2: pull structured anomaly details from
  // the live alerts so the email + dashboard render the AI's
  // explanation verbatim, not the AI summary's paraphrase.
  const anomaly_details = ((alerts ?? []) as Array<{
    alert_type: string
    metric_name: string
    severity: 'info' | 'warning' | 'critical'
    ai_explanation: string | null
    causes: Array<{ likelihood: string; description: string; action: string }> | null
  }>)
    .filter((a) => a.ai_explanation)
    .map((a) => ({
      metric: a.metric_name,
      alert_type: a.alert_type,
      severity: a.severity,
      explanation: a.ai_explanation as string,
      top_action: a.causes && a.causes.length > 0 ? a.causes[0].action : null,
    }))

  // Assemble the full content object
  const content: BriefingContent = {
    summary: aiResult.summary,
    metrics,
    demand_outlook: { score: demandScore.score, outlook: demandScore.outlook },
    trend_highlights: aiResult.trend_highlights ?? [],
    weather_outlook: aiResult.weather_outlook,
    anomaly_summary: aiResult.anomaly_summary ?? [],
    recommendations: aiResult.recommendations ?? [],
    generated_at: new Date().toISOString(),
    phase_b: {
      new_candidates: phaseB.newCandidates,
      platforms_active: phaseB.platformsActive,
      auto_linked: phaseB.autoLinked,
      high_funnel_non_converting: phaseB.highFunnelNonConverting,
      open_conflicts: phaseB.openConflicts,
    },
    anomaly_details,
    // Wave 1C: persist the structured rollup so the briefings page can
    // render the "Couples we learned about this week" section without
    // re-querying. Sensitive bodies are already redacted upstream.
    emotional_themes: themePulse.rollups,
  }

  // Persist to ai_briefings
  const supabase = createServiceClient()
  const { error } = await supabase.from('ai_briefings').insert({
    venue_id: venueId,
    briefing_type: 'weekly',
    content,
  })

  if (error) {
    console.error('[briefings] Failed to insert weekly briefing:', error.message)
  }

  // Email the briefing to the venue's briefing address
  await deliverBriefingEmail(venueId, 'Weekly Intelligence Briefing', content)

  return content
}

// ---------------------------------------------------------------------------
// 2. generateMonthlyBriefing
// ---------------------------------------------------------------------------

/**
 * Gathers data from the last 30 days, compares with the prior 30 days,
 * and generates a strategic monthly briefing.
 */
export async function generateMonthlyBriefing(
  venueId: string
): Promise<MonthlyBriefingContent | null> {
  // Cost-ceiling gate (T5-α.2). Same belt-and-suspenders pattern as
  // generateWeeklyBriefing. OPS-21.4.3.
  const gate = await gateForBrainCall(venueId)
  if (!gate.ok) {
    console.log(`[briefings] monthly briefing skipped — venue ${venueId} cost-ceiling paused`)
    return null
  }

  const currentFrom = daysAgo(30)
  const currentTo = today()
  const priorFrom = daysAgo(60)
  const priorTo = daysAgo(31)

  // Gather current period + prior period metrics + all other data sources
  const supabaseForMonthlyThemes = createServiceClient()
  const [
    currentMetrics,
    priorMetrics,
    deviations,
    weather,
    indicators,
    alerts,
    macroContext,
    themePulse,
  ] = await Promise.all([
    getWeddingMetrics(venueId, currentFrom, currentTo),
    getWeddingMetrics(venueId, priorFrom, priorTo),
    detectTrendDeviations(venueId),
    getWeatherForDateRange(venueId, today(), daysFromNow(14)),
    getLatestIndicators(),
    getActiveAlerts(venueId),
    // TRENDS-DIAGNOSIS Fix 4 / Finding F (2026-05-09).
    getBriefingMacroContext(venueId),
    // Wave 1C (2026-05-09): 30d emotional theme rollup.
    loadVenueAutoContextRollup(supabaseForMonthlyThemes, venueId, 30, {
      headerLabel: 'EMOTIONAL THEMES THIS MONTH',
      maxThemes: 10,
    }),
  ])

  const demandScore = calculateDemandScore(indicators)

  // Month-over-month changes
  const mom = {
    inquiries_change: currentMetrics.new_inquiries - priorMetrics.new_inquiries,
    bookings_change: currentMetrics.bookings - priorMetrics.bookings,
    revenue_change: currentMetrics.revenue_booked - priorMetrics.revenue_booked,
  }

  // Build weather summary
  const weatherSummary = weather.length > 0
    ? weather.map((w) => {
        const parts = [`${w.date}:`]
        if (w.high_temp != null) parts.push(`High ${w.high_temp}F`)
        if (w.low_temp != null) parts.push(`Low ${w.low_temp}F`)
        if (w.precipitation != null) parts.push(`Precip ${w.precipitation}in`)
        if (w.conditions) parts.push(w.conditions)
        return parts.join(' ')
      }).join('\n')
    : 'No weather data available.'

  // Format trend deviations
  const trendSummary = deviations.length > 0
    ? deviations.map(
        (d) =>
          `"${d.term}" (${d.category}): ${d.direction} ${Math.abs(d.changePercent)}%`
      ).join('\n')
    : 'No significant trend deviations detected.'

  // Format anomaly alerts
  const alertSummary = (alerts ?? []).length > 0
    ? (alerts as { alert_type: string; metric_name: string; ai_explanation: string | null }[])
        .map((a) => `[${a.alert_type}] ${a.metric_name}: ${a.ai_explanation ?? 'No explanation'}`)
        .join('\n')
    : 'No active anomaly alerts.'

  // Build the user prompt outside the cache wrapper.
  const monthlyUserPrompt = `Monthly data for the venue (last 30 days):

CURRENT MONTH METRICS:
- New inquiries: ${currentMetrics.new_inquiries}
- Tours scheduled: ${currentMetrics.tours_scheduled}
- Bookings confirmed: ${currentMetrics.bookings}
- Lost deals: ${currentMetrics.lost_deals}
- Revenue booked: $${currentMetrics.revenue_booked.toLocaleString()}

PRIOR MONTH METRICS (for comparison):
- New inquiries: ${priorMetrics.new_inquiries}
- Tours scheduled: ${priorMetrics.tours_scheduled}
- Bookings confirmed: ${priorMetrics.bookings}
- Lost deals: ${priorMetrics.lost_deals}
- Revenue booked: $${priorMetrics.revenue_booked.toLocaleString()}

MONTH-OVER-MONTH CHANGES:
- Inquiries: ${mom.inquiries_change >= 0 ? '+' : ''}${mom.inquiries_change}
- Bookings: ${mom.bookings_change >= 0 ? '+' : ''}${mom.bookings_change}
- Revenue: ${mom.revenue_change >= 0 ? '+' : ''}$${mom.revenue_change.toLocaleString()}

DEMAND SCORE: ${demandScore.score}/100 (${demandScore.outlook})

SEARCH TREND DEVIATIONS:
${trendSummary}

UPCOMING WEATHER:
${weatherSummary}

ANOMALY ALERTS:
${alertSummary}
${macroContext.hasContent ? `\nMACRO CONTEXT (cultural / FRED / calendar / correlation narrations):\n${macroContext.block}\n` : ''}${themePulse.block ? `\n${themePulse.block}\n` : ''}
Generate the monthly briefing with strategic recommendations.`

  // Call AI to generate the monthly briefing.
  // withAiCache absorbs double-fires within the 5-min default TTL.
  const monthlyBuilt = await buildCoordinatorPrompt({
    venueId,
    surface: 'briefing_monthly',
    taskInstructions: MONTHLY_TASK_INSTRUCTIONS,
    numbersGuard: {
      new_inquiries: currentMetrics.new_inquiries,
      tours_scheduled: currentMetrics.tours_scheduled,
      bookings: currentMetrics.bookings,
      lost_deals: currentMetrics.lost_deals,
      revenue_booked: currentMetrics.revenue_booked,
      prior_new_inquiries: priorMetrics.new_inquiries,
      prior_bookings: priorMetrics.bookings,
      prior_revenue_booked: priorMetrics.revenue_booked,
      inquiries_change_pct: mom.inquiries_change,
      bookings_change_pct: mom.bookings_change,
      revenue_change_pct: mom.revenue_change,
      demand_score: demandScore.score,
    },
  })
  const aiResult = await withAiCache(
    `briefing:monthly:${venueId}:${currentFrom}:${monthlyBuilt.promptVersion}`,
    () => callAIJson<{
      summary: string
      trend_highlights: string[]
      weather_outlook: string
      anomaly_summary: string[]
      recommendations: string[]
      strategic_recommendations: string[]
    }>({
      systemPrompt: monthlyBuilt.systemPrompt,
      userPrompt: monthlyUserPrompt,
      maxTokens: 2000,
      temperature: 0.4,
      venueId,
      taskType: 'monthly_briefing',
      promptVersion: monthlyBuilt.promptVersion,
      contentTier: monthlyBuilt.contentTier,
    }),
  )

  // Assemble the full content object
  const content: MonthlyBriefingContent = {
    summary: aiResult.summary,
    metrics: currentMetrics,
    demand_outlook: { score: demandScore.score, outlook: demandScore.outlook },
    trend_highlights: aiResult.trend_highlights ?? [],
    weather_outlook: aiResult.weather_outlook,
    anomaly_summary: aiResult.anomaly_summary ?? [],
    recommendations: aiResult.recommendations ?? [],
    month_over_month: mom,
    strategic_recommendations: aiResult.strategic_recommendations ?? [],
    generated_at: new Date().toISOString(),
    // Wave 1C: persist the structured rollup for monthly UI render.
    emotional_themes: themePulse.rollups,
  }

  // Persist to ai_briefings
  const supabase2 = createServiceClient()
  const { error } = await supabase2.from('ai_briefings').insert({
    venue_id: venueId,
    briefing_type: 'monthly',
    content,
  })

  if (error) {
    console.error('[briefings] Failed to insert monthly briefing:', error.message)
  }

  // Email the briefing to the venue's briefing address
  await deliverBriefingEmail(venueId, 'Monthly Intelligence Briefing', content)

  return content
}

// ---------------------------------------------------------------------------
// 3. getLatestBriefing
// ---------------------------------------------------------------------------

/**
 * Returns the most recent briefing for a venue, optionally filtered by type.
 * Defaults to 'weekly' if no type is specified.
 */
export async function getLatestBriefing(
  venueId: string,
  type: string = 'weekly'
): Promise<BriefingRow | null> {
  const supabase = createServiceClient()

  const { data, error } = await supabase
    .from('ai_briefings')
    .select('*, venues:venue_id(name)')
    .eq('venue_id', venueId)
    .eq('briefing_type', type)
    .order('created_at', { ascending: false })
    .limit(1)
    .single()

  if (error || !data) return null

  return data as BriefingRow
}

// ---------------------------------------------------------------------------
// 4. getAllBriefings
// ---------------------------------------------------------------------------

/**
 * Returns recent briefings for a venue, newest first.
 * Default limit is 10.
 */
export async function getAllBriefings(
  venueId: string,
  limit: number = 10
): Promise<BriefingRow[]> {
  const supabase = createServiceClient()

  const { data, error } = await supabase
    .from('ai_briefings')
    .select('*, venues:venue_id(name)')
    .eq('venue_id', venueId)
    .order('created_at', { ascending: false })
    .limit(limit)

  if (error) {
    console.error('[briefings] Error fetching briefings:', error.message)
    return []
  }

  return (data ?? []) as BriefingRow[]
}

// ---------------------------------------------------------------------------
// 5. deliverBriefingEmail (shared helper)
// ---------------------------------------------------------------------------

/**
 * Sends a briefing summary email to the venue's briefing_email address.
 * Prefers the venue's authenticated Gmail (so the briefing arrives from
 * their own inbox). If Gmail isn't connected, falls back to Resend via
 * the transactional `sendEmail` helper. Fails silently if no
 * briefing_email is configured.
 */
async function deliverBriefingEmail(
  venueId: string,
  subjectPrefix: string,
  content: BriefingContent
): Promise<void> {
  try {
    const supabase = createServiceClient()
    const { data: venue } = await supabase
      .from('venues')
      .select('briefing_email, name')
      .eq('id', venueId)
      .single()

    const briefingEmail = venue?.briefing_email as string | null
    if (!briefingEmail) return

    const subject = `${venue?.name ?? 'Bloom House'} — ${subjectPrefix}`
    // Connective tissue (gap E — 2026-04-30): the email body now
    // composes deterministically from structured content fields
    // instead of relying on the AI summary to mention everything.
    // If the AI worked the Phase B numbers into the summary that's
    // fine; this section is the structural fallback so coordinators
    // never miss a non-zero count.
    const recsBlock = content.recommendations.length > 0
      ? `\n\nRecommendations:\n${content.recommendations.map((r) => `  • ${r}`).join('\n')}`
      : ''
    // Connective II / fix #2: anomaly explanations + suggested
    // actions render verbatim in the email so the AI summary
    // can't strip them. Filtered to warning/critical so info-level
    // alerts don't bloat the email.
    const anomalyBlock = content.anomaly_details && content.anomaly_details.length > 0
      ? `\n\nAlerts (${content.anomaly_details.length}):\n` +
        content.anomaly_details
          .filter((a) => a.severity !== 'info')
          .slice(0, 5)
          .map((a) => {
            const display = getAnomalyDisplay(a.metric)
            const lines = [`  • [${a.severity.toUpperCase()}] ${display.title}: ${a.explanation}`]
            if (a.top_action) lines.push(`    → suggested: ${a.top_action}`)
            return lines.join('\n')
          })
          .join('\n')
      : ''
    const phaseBBlock = content.phase_b && (
      content.phase_b.new_candidates > 0 ||
      content.phase_b.auto_linked > 0 ||
      content.phase_b.high_funnel_non_converting > 0 ||
      content.phase_b.open_conflicts > 0
    )
      ? `\n\nPlatform signal health:\n` +
        `  • ${content.phase_b.new_candidates} new candidates across ${content.phase_b.platforms_active} platform${content.phase_b.platforms_active === 1 ? '' : 's'}\n` +
        `  • ${content.phase_b.auto_linked} auto-linked to existing leads\n` +
        `  • ${content.phase_b.high_funnel_non_converting} engaged but didn't inquire\n` +
        `  • ${content.phase_b.open_conflicts} attribution conflict${content.phase_b.open_conflicts === 1 ? '' : 's'} to review`
      : ''
    const body = `${subjectPrefix}\n\n${content.summary}${anomalyBlock}${recsBlock}${phaseBBlock}\n\nView the full briefing in your Bloom House dashboard.`

    // Try venue's authenticated Gmail first
    const messageId = await sendGmail(venueId, briefingEmail, subject, body)
    if (messageId) {
      console.log(`[briefings] Sent ${subjectPrefix} via Gmail to ${briefingEmail}`)
      return
    }

    // Gmail not connected — fall back to transactional (Resend)
    console.warn(
      `[briefings] Gmail not connected for venue ${venueId}, falling back to transactional email`
    )
    const fallback = await sendTransactionalEmail({
      to: briefingEmail,
      subject,
      html: body,
    })

    if (fallback.ok) {
      console.log(
        `[briefings] Sent ${subjectPrefix} via Resend to ${briefingEmail} (id: ${fallback.id ?? 'n/a'})`
      )
    } else {
      console.error(
        `[briefings] Transactional fallback failed for ${briefingEmail}: ${fallback.error}`
      )
    }
  } catch (err) {
    console.error(`[briefings] Email delivery failed for ${venueId}:`, err)
  }
}
