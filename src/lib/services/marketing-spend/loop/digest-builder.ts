/**
 * Wave 6D — weekly marketing digest builder service.
 *
 * Anchor docs:
 *   - bloom-constitution.md (Wave 6D closes the loop. The digest is the
 *     weekly story.)
 *   - bloom-wave4-5-6-master-plan.md (Wave 6D spec)
 *   - feedback_parallel_stream_safety.md (Wave 6D writes ONLY to mig-273
 *     tables; reads Wave 6B/6C/7A but never modifies them)
 *
 * What this module does
 * ---------------------
 * For one venue, build the weekly digest:
 *   1. Pull top 3 unresolved flags (Wave 6D — mig 273).
 *   2. Pull top 3 pending recommendations (Wave 6C — mig 269).
 *   3. Compute week-over-week metric deltas (CAC, conversion%, ROI).
 *   4. Pull A/B tests concluded this week.
 *   5. Pull validated discoveries from Wave 7A this week.
 *   6. Call Sonnet to write the headline + 3-sentence narrative.
 *   7. Upsert into marketing_digests (one row per (venue, week)).
 *
 * Idempotency
 * -----------
 * The unique index on (venue_id, digest_period_start, digest_period_end)
 * makes (venue, week) the natural identity of a digest. Re-running the
 * builder for the same week REPLACES digest_jsonb in place rather than
 * inserting a duplicate. Sonnet is called every time so the narration
 * reflects the latest evidence (even if the underlying flags + recs
 * have shifted).
 */

import type { SupabaseClient } from '@supabase/supabase-js'
import { createServiceClient } from '@/lib/supabase/service'
import { callAI } from '@/lib/ai/client'
import { logEvent } from '@/lib/observability/logger'
import {
  MARKETING_DIGEST_PROMPT_VERSION,
  buildMarketingDigestSystemPrompt,
  buildMarketingDigestUserPrompt,
  validateMarketingDigestOutput,
  type MarketingDigestEvidence,
  type MarketingDigestOutput,
  type DigestFlagEvidence,
  type DigestRecommendationEvidence,
  type DigestWeekOverWeekEvidence,
  type DigestAbTestEvidence,
  type DigestValidatedDiscoveryEvidence,
} from '@/config/prompts/marketing-digest'

export { MARKETING_DIGEST_PROMPT_VERSION } from '@/config/prompts/marketing-digest'

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface BuildWeeklyDigestOptions {
  supabase?: SupabaseClient
  /** Optional override for the digest week. Defaults to most-recent
   *  Monday-Sunday week (UTC). */
  periodStart?: string
  periodEnd?: string
  correlationId?: string
}

export interface BuildWeeklyDigestResult {
  ok: true
  digestId: string
  digestJsonb: MarketingDigestOutput
  costCents: number
  promptVersion: string
  periodStart: string
  periodEnd: string
  diagnostics: {
    flagsScanned: number
    recommendationsScanned: number
    abTestsScanned: number
    discoveriesScanned: number
    weekOverWeekAvailable: boolean
  }
}

// ---------------------------------------------------------------------------
// Tunables
// ---------------------------------------------------------------------------

const MAX_OUTPUT_TOKENS = 2000
const TEMPERATURE = 0.4
const TOP_FLAGS = 3
const TOP_RECS = 3
const MS_PER_DAY = 86_400_000

// ---------------------------------------------------------------------------
// Period math
// ---------------------------------------------------------------------------

function isoDate(d: Date): string {
  const y = d.getUTCFullYear()
  const m = String(d.getUTCMonth() + 1).padStart(2, '0')
  const day = String(d.getUTCDate()).padStart(2, '0')
  return `${y}-${m}-${day}`
}

/**
 * Default digest period = most-recent Monday-Sunday week (UTC).
 * Returns ISO date strings (YYYY-MM-DD).
 */
function defaultDigestPeriod(): { start: string; end: string } {
  const now = new Date()
  const dayOfWeek = now.getUTCDay() // 0=Sun, 1=Mon, ... 6=Sat
  // We want the most recent fully-completed Monday→Sunday week.
  // Last Sunday at 23:59:59 = end of digest period.
  // The number of days back to that Sunday from today:
  //   if today is Mon (1), last Sunday was 1 day ago.
  //   if today is Sun (0), last full Sunday week ended yesterday.
  const daysToLastSunday = dayOfWeek === 0 ? 7 : dayOfWeek
  const lastSunday = new Date(now.getTime() - daysToLastSunday * MS_PER_DAY)
  const lastMonday = new Date(lastSunday.getTime() - 6 * MS_PER_DAY)
  return { start: isoDate(lastMonday), end: isoDate(lastSunday) }
}

// ---------------------------------------------------------------------------
// Loaders
// ---------------------------------------------------------------------------

async function loadVenueLabel(
  supabase: SupabaseClient,
  venueId: string,
): Promise<string | null> {
  const { data } = await supabase
    .from('venues')
    .select('name')
    .eq('id', venueId)
    .maybeSingle()
  return ((data as { name?: string | null } | null)?.name ?? null) || null
}

async function loadTopFlags(
  supabase: SupabaseClient,
  venueId: string,
): Promise<DigestFlagEvidence[]> {
  // Top 3 unresolved flags, ordered critical → warning → info, then by
  // duration_days desc. PostgREST can't express ORDER BY CASE inline;
  // do it client-side with a small over-fetch.
  const { data, error } = await supabase
    .from('marketing_spend_flags')
    .select(
      'flag_title, severity, source_channel, target_persona, duration_days, estimated_impact_cents, recommended_action',
    )
    .eq('venue_id', venueId)
    .neq('status', 'resolved')
    .neq('status', 'dismissed')
    .neq('status', 'actioned')
    .order('last_confirmed_at', { ascending: false })
    .limit(50)
  if (error) {
    logEvent({
      level: 'warn',
      msg: 'digest_builder.load_flags_failed',
      event_type: 'wave_6d.digest',
      outcome: 'fail',
      venueId,
      data: { error: error.message },
    })
    return []
  }
  const rows = (data ?? []) as Array<{
    flag_title: string
    severity: string
    source_channel: string | null
    target_persona: string | null
    duration_days: number
    estimated_impact_cents: number | null
    recommended_action: string | null
  }>
  const sevRank = (s: string): number =>
    s === 'critical' ? 3 : s === 'warning' ? 2 : 1
  rows.sort((a, b) => {
    const sa = sevRank(a.severity)
    const sb = sevRank(b.severity)
    if (sa !== sb) return sb - sa
    return (b.duration_days ?? 0) - (a.duration_days ?? 0)
  })
  return rows.slice(0, TOP_FLAGS).map((r) => ({
    flag_title: r.flag_title,
    severity: r.severity as 'info' | 'warning' | 'critical',
    source_channel: r.source_channel,
    target_persona: r.target_persona,
    duration_days: r.duration_days ?? 0,
    estimated_impact_cents: r.estimated_impact_cents,
    recommended_action: r.recommended_action,
  }))
}

async function loadTopRecommendations(
  supabase: SupabaseClient,
  venueId: string,
): Promise<DigestRecommendationEvidence[]> {
  const { data, error } = await supabase
    .from('marketing_recommendations')
    .select(
      'recommendation_title, action_type, source_channel, target_channel, target_persona, estimated_monthly_dollar_impact_cents, confidence_0_100',
    )
    .eq('venue_id', venueId)
    .eq('status', 'pending')
    .order('estimated_monthly_dollar_impact_cents', { ascending: false })
    .limit(TOP_RECS)
  if (error) {
    logEvent({
      level: 'warn',
      msg: 'digest_builder.load_recs_failed',
      event_type: 'wave_6d.digest',
      outcome: 'fail',
      venueId,
      data: { error: error.message },
    })
    return []
  }
  return ((data ?? []) as Array<{
    recommendation_title: string
    action_type: string
    source_channel: string | null
    target_channel: string | null
    target_persona: string | null
    estimated_monthly_dollar_impact_cents: number | null
    confidence_0_100: number
  }>).map((r) => ({
    recommendation_title: r.recommendation_title,
    action_type: r.action_type,
    source_channel: r.source_channel,
    target_channel: r.target_channel,
    target_persona: r.target_persona,
    estimated_monthly_dollar_impact_cents:
      r.estimated_monthly_dollar_impact_cents,
    confidence_0_100: r.confidence_0_100,
  }))
}

interface CellAgg {
  spendCents: number
  bookedCount: number
  inquiriesCount: number
  totalBookedValueCents: number
  topChannel: string | null
  topChannelSpend: number
  topPersona: string | null
  topPersonaCount: number
}

async function loadWeekOverWeek(
  supabase: SupabaseClient,
  venueId: string,
  periodStart: string,
  periodEnd: string,
): Promise<DigestWeekOverWeekEvidence | null> {
  // Compute simple WoW deltas:
  //   current = (periodStart..periodEnd)
  //   prior   = same length, immediately before periodStart
  const startMs = Date.parse(`${periodStart}T00:00:00Z`)
  const endMs = Date.parse(`${periodEnd}T23:59:59Z`)
  if (!Number.isFinite(startMs) || !Number.isFinite(endMs)) return null
  const lenMs = endMs - startMs
  const priorEndMs = startMs - 1
  const priorStartMs = priorEndMs - lenMs

  const currentLabel = `${periodStart} → ${periodEnd}`
  const priorLabel = `${isoDate(new Date(priorStartMs))} → ${isoDate(new Date(priorEndMs))}`

  async function aggregate(
    rangeStartMs: number,
    rangeEndMs: number,
  ): Promise<CellAgg> {
    const out: CellAgg = {
      spendCents: 0,
      bookedCount: 0,
      inquiriesCount: 0,
      totalBookedValueCents: 0,
      topChannel: null,
      topChannelSpend: 0,
      topPersona: null,
      topPersonaCount: 0,
    }
    const startDate = isoDate(new Date(rangeStartMs))
    const endDate = isoDate(new Date(rangeEndMs))
    const startIso = new Date(rangeStartMs).toISOString()
    const endIso = new Date(rangeEndMs).toISOString()

    // Spend.
    const { data: spendRows } = await supabase
      .from('marketing_spend_records')
      .select('channel, amount_cents, spend_date')
      .eq('venue_id', venueId)
      .gte('spend_date', startDate)
      .lte('spend_date', endDate)
      .limit(5000)
    const channelSpend = new Map<string, number>()
    for (const r of (spendRows ?? []) as Array<{
      channel: string
      amount_cents: number
    }>) {
      out.spendCents += r.amount_cents || 0
      channelSpend.set(
        r.channel,
        (channelSpend.get(r.channel) ?? 0) + (r.amount_cents || 0),
      )
    }
    for (const [channel, spend] of channelSpend.entries()) {
      if (spend > out.topChannelSpend) {
        out.topChannelSpend = spend
        out.topChannel = channel
      }
    }

    // Attribution events in the range (for inquiry + booked counts +
    // top persona).
    const { data: attrRows } = await supabase
      .from('attribution_events')
      .select('wedding_id, persona_overlay, decided_at')
      .eq('venue_id', venueId)
      .eq('is_first_touch', true)
      .is('reverted_at', null)
      .gte('decided_at', startIso)
      .lte('decided_at', endIso)
      .limit(5000)
    const personaCount = new Map<string, number>()
    const weddingIds = new Set<string>()
    for (const r of (attrRows ?? []) as Array<{
      wedding_id: string
      persona_overlay: { persona_label?: string } | null
    }>) {
      out.inquiriesCount += 1
      if (r.wedding_id) weddingIds.add(r.wedding_id)
      const p = r.persona_overlay?.persona_label?.trim()
      if (p) personaCount.set(p, (personaCount.get(p) ?? 0) + 1)
    }
    for (const [p, n] of personaCount.entries()) {
      if (n > out.topPersonaCount) {
        out.topPersonaCount = n
        out.topPersona = p
      }
    }

    // Wedding bookings + booked value.
    if (weddingIds.size > 0) {
      const ids = Array.from(weddingIds)
      const BATCH = 100
      for (let i = 0; i < ids.length; i += BATCH) {
        const slice = ids.slice(i, i + BATCH)
        const { data: weds } = await supabase
          .from('weddings')
          .select('id, status, booking_value')
          .in('id', slice)
        for (const w of (weds ?? []) as Array<{
          id: string
          status: string
          booking_value: number | null
        }>) {
          if (w.status === 'booked' || w.status === 'completed') {
            out.bookedCount += 1
            const v = Number(w.booking_value ?? 0)
            if (Number.isFinite(v) && v > 0) {
              out.totalBookedValueCents += Math.round(v)
            }
          }
        }
      }
    }
    return out
  }

  const [current, prior] = await Promise.all([
    aggregate(startMs, endMs),
    aggregate(priorStartMs, priorEndMs),
  ])

  // If both windows are empty, no WoW signal — return null and let the
  // narrator refuse.
  if (
    current.spendCents === 0 &&
    current.inquiriesCount === 0 &&
    prior.spendCents === 0 &&
    prior.inquiriesCount === 0
  ) {
    return null
  }

  function cac(agg: CellAgg): number | null {
    if (agg.bookedCount > 0 && agg.spendCents > 0) {
      return Math.round(agg.spendCents / agg.bookedCount)
    }
    return null
  }
  function conv(agg: CellAgg): number | null {
    if (agg.inquiriesCount > 0) {
      return Math.round((agg.bookedCount / agg.inquiriesCount) * 1000) / 10
    }
    return null
  }
  function roi(agg: CellAgg): number | null {
    if (agg.spendCents > 0) {
      return (
        Math.round(
          ((agg.totalBookedValueCents - agg.spendCents) / agg.spendCents) *
            1000,
        ) / 10
      )
    }
    return null
  }

  return {
    current_period_label: currentLabel,
    prior_period_label: priorLabel,
    current_cac_cents: cac(current),
    prior_cac_cents: cac(prior),
    current_conversion_pct: conv(current),
    prior_conversion_pct: conv(prior),
    current_roi_pct: roi(current),
    prior_roi_pct: roi(prior),
    top_channel_current: current.topChannel,
    top_persona_current: current.topPersona,
  }
}

async function loadConcludedAbTests(
  supabase: SupabaseClient,
  venueId: string,
  periodStart: string,
  periodEnd: string,
): Promise<DigestAbTestEvidence[]> {
  const startIso = new Date(`${periodStart}T00:00:00Z`).toISOString()
  const endIso = new Date(`${periodEnd}T23:59:59Z`).toISOString()
  const { data, error } = await supabase
    .from('marketing_ab_tests')
    .select(
      'test_name, channel, target_persona, winner, variant_a_label, variant_b_label, winner_decision_lift_pct, winner_decided_at',
    )
    .eq('venue_id', venueId)
    .eq('status', 'concluded')
    .gte('winner_decided_at', startIso)
    .lte('winner_decided_at', endIso)
    .order('winner_decided_at', { ascending: false })
    .limit(10)
  if (error) {
    logEvent({
      level: 'warn',
      msg: 'digest_builder.load_ab_tests_failed',
      event_type: 'wave_6d.digest',
      outcome: 'fail',
      venueId,
      data: { error: error.message },
    })
    return []
  }
  return ((data ?? []) as Array<{
    test_name: string
    channel: string
    target_persona: string | null
    winner: string
    variant_a_label: string
    variant_b_label: string
    winner_decision_lift_pct: number | string | null
  }>)
    .filter((r) => r.winner !== null && r.winner !== undefined)
    .map((r) => ({
      test_name: r.test_name,
      channel: r.channel,
      target_persona: r.target_persona,
      winner: r.winner as 'variant_a' | 'variant_b' | 'inconclusive',
      variant_a_label: r.variant_a_label,
      variant_b_label: r.variant_b_label,
      lift_pct:
        r.winner_decision_lift_pct === null
          ? null
          : Number(r.winner_decision_lift_pct),
    }))
}

async function loadValidatedDiscoveries(
  supabase: SupabaseClient,
  venueId: string,
  periodStart: string,
  periodEnd: string,
): Promise<DigestValidatedDiscoveryEvidence[]> {
  const startIso = new Date(`${periodStart}T00:00:00Z`).toISOString()
  const endIso = new Date(`${periodEnd}T23:59:59Z`).toISOString()
  const { data, error } = await supabase
    .from('intel_discoveries')
    .select('hypothesis_title, hypothesis_text, validated_at')
    .eq('venue_id', venueId)
    .eq('validation_status', 'validated')
    .gte('validated_at', startIso)
    .lte('validated_at', endIso)
    .order('validated_at', { ascending: false })
    .limit(5)
  if (error) {
    // intel_discoveries may not be populated yet — log + return empty.
    logEvent({
      level: 'debug',
      msg: 'digest_builder.load_discoveries_skipped',
      event_type: 'wave_6d.digest',
      outcome: 'skip',
      venueId,
      data: { error: error.message },
    })
    return []
  }
  return ((data ?? []) as Array<{
    hypothesis_title: string
    hypothesis_text: string
  }>).map((r) => ({
    title: r.hypothesis_title,
    summary:
      r.hypothesis_text.length > 200
        ? r.hypothesis_text.slice(0, 200) + '…'
        : r.hypothesis_text,
  }))
}

// ---------------------------------------------------------------------------
// JSON fence stripping (defensive — Sonnet sometimes wraps)
// ---------------------------------------------------------------------------

function stripJsonFences(text: string): string {
  return text.replace(/```json\n?/g, '').replace(/```\n?/g, '').trim()
}

// ---------------------------------------------------------------------------
// Main entry point
// ---------------------------------------------------------------------------

export async function buildWeeklyDigest(
  venueId: string,
  options: BuildWeeklyDigestOptions = {},
): Promise<BuildWeeklyDigestResult> {
  const supabase = options.supabase ?? createServiceClient()
  const correlationId = options.correlationId

  const period =
    options.periodStart && options.periodEnd
      ? { start: options.periodStart, end: options.periodEnd }
      : defaultDigestPeriod()
  const { start: periodStart, end: periodEnd } = period

  // 1. Load all evidence in parallel.
  const [
    venueLabel,
    topFlags,
    topRecommendations,
    weekOverWeek,
    abTestsConcluded,
    validatedDiscoveries,
  ] = await Promise.all([
    loadVenueLabel(supabase, venueId),
    loadTopFlags(supabase, venueId),
    loadTopRecommendations(supabase, venueId),
    loadWeekOverWeek(supabase, venueId, periodStart, periodEnd),
    loadConcludedAbTests(supabase, venueId, periodStart, periodEnd),
    loadValidatedDiscoveries(supabase, venueId, periodStart, periodEnd),
  ])

  const evidence: MarketingDigestEvidence = {
    venueId,
    venueLabel,
    digestPeriodStart: periodStart,
    digestPeriodEnd: periodEnd,
    topFlags,
    topRecommendations,
    weekOverWeek,
    abTestsConcluded,
    validatedDiscoveries,
  }

  const diagnostics = {
    flagsScanned: topFlags.length,
    recommendationsScanned: topRecommendations.length,
    abTestsScanned: abTestsConcluded.length,
    discoveriesScanned: validatedDiscoveries.length,
    weekOverWeekAvailable: weekOverWeek !== null,
  }

  // 2. Empty-evidence short-circuit. If everything is empty, write a
  //    refusal digest WITHOUT calling Sonnet (saves $0.05).
  //    weekOverWeek with all-null derived fields counts as "empty" — the
  //    aggregate landed (some attribution events fell in the window) but
  //    spend was 0 so no CAC / no conversion can be computed.
  const wowHasSignal =
    weekOverWeek !== null &&
    (weekOverWeek.current_cac_cents !== null ||
      weekOverWeek.current_conversion_pct !== null ||
      weekOverWeek.current_roi_pct !== null ||
      weekOverWeek.prior_cac_cents !== null ||
      weekOverWeek.prior_conversion_pct !== null ||
      weekOverWeek.prior_roi_pct !== null)
  const evidenceIsEmpty =
    topFlags.length === 0 &&
    topRecommendations.length === 0 &&
    !wowHasSignal &&
    abTestsConcluded.length === 0 &&
    validatedDiscoveries.length === 0

  let output: MarketingDigestOutput
  let costCents = 0

  if (evidenceIsEmpty) {
    output = {
      headline: 'No digest-worthy signal this week',
      this_week_in_3_sentences:
        'No flags, recommendations, week-over-week deltas, A/B tests, or validated discoveries were available for this period. The marketing rollup may be empty (no spend ingested or no rollup recompute yet) or the venue may simply have had a quiet week. Run the Wave 6B persona-channel rollup recompute and the Wave 6D flag detector before next week to confirm.',
      top_flags: [],
      top_recommendations: [],
      week_over_week: {
        cac_change_pct: null,
        conversion_change_pct: null,
        roi_change_pct: null,
      },
      ab_tests_concluded: [],
      validated_discoveries: [],
      refusal:
        'Empty evidence block — no flags, recommendations, WoW deltas, A/B tests, or validated discoveries this period.',
    }
  } else {
    // 3. Call Sonnet narrator.
    const systemPrompt = buildMarketingDigestSystemPrompt()
    const userPrompt = buildMarketingDigestUserPrompt(evidence)
    const aiResult = await callAI({
      systemPrompt:
        systemPrompt +
        '\n\nRespond with valid JSON only. No markdown, no code blocks, no explanation.',
      userPrompt,
      tier: 'sonnet',
      taskType: 'marketing_digest',
      contentTier: 4, // anonymised aggregates only
      promptVersion: MARKETING_DIGEST_PROMPT_VERSION,
      venueId,
      maxTokens: MAX_OUTPUT_TOKENS,
      temperature: TEMPERATURE,
      correlationId,
    })

    const cleaned = stripJsonFences(aiResult.text)
    let parsed: unknown
    try {
      parsed = JSON.parse(cleaned)
    } catch (parseErr) {
      const message =
        parseErr instanceof Error ? parseErr.message : String(parseErr)
      throw new Error(
        `buildWeeklyDigest: LLM returned non-JSON. parseError=${message} rawResponse=${cleaned.slice(0, 2000)}`,
      )
    }
    const validation = validateMarketingDigestOutput(parsed)
    if (!validation.ok) {
      throw new Error(
        `buildWeeklyDigest: schema validation failed. error=${validation.error} rawResponse=${cleaned.slice(0, 2000)}`,
      )
    }
    output = validation.output
    costCents = aiResult.cost * 100
  }

  // 4. Upsert into marketing_digests. The unique index on
  //    (venue_id, digest_period_start, digest_period_end) handles
  //    re-running the same week.
  // PostgREST upsert path — onConflict on the unique columns.
  const { data: written, error: writeErr } = await supabase
    .from('marketing_digests')
    .upsert(
      {
        venue_id: venueId,
        digest_period_start: periodStart,
        digest_period_end: periodEnd,
        digest_jsonb: output,
        cost_cents: costCents,
        prompt_version: MARKETING_DIGEST_PROMPT_VERSION,
        generated_at: new Date().toISOString(),
      },
      {
        onConflict: 'venue_id,digest_period_start,digest_period_end',
      },
    )
    .select('id')
    .single()
  if (writeErr || !written) {
    throw new Error(
      `buildWeeklyDigest: upsert failed: ${writeErr?.message ?? 'no row returned'}`,
    )
  }

  logEvent({
    level: 'info',
    msg: 'digest_builder.complete',
    event_type: 'wave_6d.digest',
    outcome: 'ok',
    venueId,
    data: {
      digestId: written.id,
      periodStart,
      periodEnd,
      headline: output.headline,
      refusal: output.refusal,
      costCents,
      ...diagnostics,
    },
  })

  return {
    ok: true,
    digestId: written.id as string,
    digestJsonb: output,
    costCents,
    promptVersion: MARKETING_DIGEST_PROMPT_VERSION,
    periodStart,
    periodEnd,
    diagnostics,
  }
}

// ---------------------------------------------------------------------------
// Read helpers
// ---------------------------------------------------------------------------

export interface StoredMarketingDigestRow {
  id: string
  venue_id: string
  digest_period_start: string
  digest_period_end: string
  digest_jsonb: MarketingDigestOutput
  delivered_via: string | null
  delivered_at: string | null
  cost_cents: number | string
  prompt_version: string | null
  generated_at: string
  created_at: string
}

export async function getLatestDigest(
  venueId: string,
  supabase: SupabaseClient = createServiceClient(),
): Promise<StoredMarketingDigestRow | null> {
  const { data, error } = await supabase
    .from('marketing_digests')
    .select(
      'id, venue_id, digest_period_start, digest_period_end, digest_jsonb, delivered_via, delivered_at, cost_cents, prompt_version, generated_at, created_at',
    )
    .eq('venue_id', venueId)
    .order('generated_at', { ascending: false })
    .limit(1)
    .maybeSingle()
  if (error) {
    if (error.code === 'PGRST116') return null
    throw new Error(`getLatestDigest: ${error.message}`)
  }
  return (data as StoredMarketingDigestRow | null) ?? null
}

export async function listDigests(
  venueId: string,
  options: { limit?: number } = {},
  supabase: SupabaseClient = createServiceClient(),
): Promise<StoredMarketingDigestRow[]> {
  const limit = Math.min(options.limit ?? 52, 200)
  const { data, error } = await supabase
    .from('marketing_digests')
    .select(
      'id, venue_id, digest_period_start, digest_period_end, digest_jsonb, delivered_via, delivered_at, cost_cents, prompt_version, generated_at, created_at',
    )
    .eq('venue_id', venueId)
    .order('digest_period_start', { ascending: false })
    .limit(limit)
  if (error) throw new Error(`listDigests: ${error.message}`)
  return (data ?? []) as StoredMarketingDigestRow[]
}
