/**
 * Wave 6D — marketing flag detector service.
 *
 * Anchor docs:
 *   - bloom-constitution.md (Wave 6 closes the forensic loop. 6A
 *     ingests spend, 6B rolls it up, 6C produces recommendations, 6D
 *     auto-flags under/over-performance and persona drift.)
 *   - bloom-wave4-5-6-master-plan.md (Wave 6D spec)
 *   - feedback_parallel_stream_safety.md (Wave 6D writes ONLY to the
 *     mig-273 tables; 6B's persona_channel_rollups + 6C's
 *     marketing_recommendations are read-only here.)
 *
 * Why this module is deterministic, not LLM
 * -----------------------------------------
 * The flag detector is forensic, not generative — its job is to spot
 * cells that violate explicit thresholds (CAC > 30% LTV, ROI < 50% of
 * channel-blended avg, persona shift > 15%, CAC week-over-week × 2).
 * These rules are auditable and tunable without a Sonnet round-trip.
 * The LLM enters the loop later (Wave 6D digest builder asks Sonnet to
 * narrate the flags + recommendations into a weekly story).
 *
 * Idempotency
 * -----------
 * One active flag per (venue, flag_type, source_channel, target_persona).
 * The unique partial index in mig 273 enforces this: re-running the
 * detector on unchanged data updates last_confirmed_at on the existing
 * row instead of inserting a duplicate. When the underlying condition
 * fails to re-confirm for 7d, the detector auto-resolves the flag
 * (status='resolved', resolved_at=now()).
 *
 * AUTO-FLAG NEVER AUTO-EXECUTE
 * ----------------------------
 * The detector NEVER mutates spend, NEVER pauses campaigns, NEVER
 * promotes recommendations. It only writes to marketing_spend_flags.
 * The operator decides everything else.
 */

import type { SupabaseClient } from '@supabase/supabase-js'
import { createServiceClient } from '@/lib/supabase/service'
import { logEvent } from '@/lib/observability/logger'

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface DetectMarketingFlagsInput {
  venueId: string
  supabase?: SupabaseClient
}

export interface DetectMarketingFlagsResult {
  ok: true
  venueId: string
  flagsCreated: number
  flagsConfirmed: number
  flagsResolved: number
  diagnostics: {
    rollupCellsScanned: number
    flagTypesEvaluated: number
    activeFlagsBefore: number
  }
}

// Internal candidate flag — what the detector intends to write before we
// reconcile against the existing-flag set.
interface FlagCandidate {
  flagType:
    | 'underperforming_pause_candidate'
    | 'overperforming_scale_candidate'
    | 'cac_exceeds_ltv'
    | 'persona_drift'
    | 'channel_anomaly'
  flagTitle: string
  flagText: string
  severity: 'info' | 'warning' | 'critical'
  sourceChannel: string | null
  targetPersona: string | null
  cohortData: Record<string, unknown>
  estimatedImpactCents: number | null
  recommendedAction: string | null
}

// ---------------------------------------------------------------------------
// Tunables (all forensic — single source of truth lives here so an
// audit-trail doc can cite the exact thresholds)
// ---------------------------------------------------------------------------

const COHORT_SIZE_THRESHOLD = 10
// 14d sustained gate for pause + cac_exceeds_ltv. last_confirmed_at -
// first_detected_at >= 14d before we promote severity / surface as
// critical. (The flag itself fires on first detection; the gate is on
// the recommended_action wording + severity).
const SUSTAINED_DAYS = 14
// 7d resolved gate. If a flag isn't re-confirmed for 7d, mark resolved.
const AUTO_RESOLVE_DAYS = 7
const MS_PER_DAY = 86_400_000

// Underperforming pause: ROI < 50% of channel-blended avg AND spend > $500/mo.
const PAUSE_ROI_RATIO = 0.5
const PAUSE_MIN_MONTHLY_SPEND_CENTS = 50_000 // $500

// Overperforming scale: ROI > 200% of channel-blended avg AND n>=10.
const SCALE_ROI_RATIO = 2.0

// CAC exceeds LTV: cac_cents > avg_booking_value_cents * 0.3, n>=10.
const CAC_LTV_RATIO = 0.3

// Persona drift: > 15% absolute share shift in a 30d window vs prior 30d.
const PERSONA_DRIFT_THRESHOLD_PCT = 15

// Channel anomaly: CAC doubles week-over-week (current_cac > 2× prior).
const CHANNEL_ANOMALY_RATIO = 2.0
// Anomaly requires meaningful spend in both windows so a single cheap
// week doesn't trigger.
const ANOMALY_MIN_WEEKLY_SPEND_CENTS = 10_000 // $100

// ---------------------------------------------------------------------------
// Loaders
// ---------------------------------------------------------------------------

interface RollupRow {
  channel: string
  persona_label: string | null
  time_window_start: string
  time_window_end: string
  spend_cents: number
  inquiries_count: number
  booked_count: number
  total_booked_value_cents: number
  cac_cents: number | null
  conversion_pct: number | null
  avg_booking_value_cents: number | null
  roi_pct: number | null
  payback_months: number | null
  n_too_small: boolean
  computed_at: string
}

async function loadLatest90dRollupCells(
  supabase: SupabaseClient,
  venueId: string,
): Promise<RollupRow[]> {
  // Pull a fresh 200-row slice and filter to the 90d window's latest
  // computed_at. Same pattern as Wave 6C's loadLatestRollupCells but
  // simpler — we want all cells in the 90d window.
  const { data, error } = await supabase
    .from('persona_channel_rollups')
    .select(
      'channel, persona_label, time_window_start, time_window_end, spend_cents, inquiries_count, booked_count, total_booked_value_cents, cac_cents, conversion_pct, avg_booking_value_cents, roi_pct, payback_months, n_too_small, computed_at',
    )
    .eq('venue_id', venueId)
    .order('computed_at', { ascending: false })
    .limit(2000)
  if (error) {
    logEvent({
      level: 'warn',
      msg: 'flag_detector.load_rollup_failed',
      event_type: 'wave_6d.detect',
      outcome: 'fail',
      venueId,
      data: { error: error.message },
    })
    return []
  }
  const rows = (data ?? []) as RollupRow[]
  if (rows.length === 0) return []

  // Filter to ~90d windows (start..end span within ±2 days of 90d).
  const ninetyDays = 90
  const matching = rows.filter((r) => {
    const startMs = Date.parse(r.time_window_start)
    const endMs = Date.parse(r.time_window_end)
    if (!Number.isFinite(startMs) || !Number.isFinite(endMs)) return false
    const lenDays = Math.round((endMs - startMs) / MS_PER_DAY)
    return Math.abs(lenDays - ninetyDays) <= 2
  })
  if (matching.length === 0) return []

  // Pick the latest computed_at + window pair within the matching set.
  const latestComputedAt = matching[0].computed_at
  const latestStart = matching[0].time_window_start
  const latestEnd = matching[0].time_window_end
  return matching.filter(
    (r) =>
      r.computed_at === latestComputedAt &&
      r.time_window_start === latestStart &&
      r.time_window_end === latestEnd,
  )
}

interface ExistingFlagRow {
  id: string
  flag_type: string
  source_channel: string | null
  target_persona: string | null
  status: string
  first_detected_at: string
  last_confirmed_at: string
  duration_days: number
}

async function loadActiveFlags(
  supabase: SupabaseClient,
  venueId: string,
): Promise<ExistingFlagRow[]> {
  const { data, error } = await supabase
    .from('marketing_spend_flags')
    .select(
      'id, flag_type, source_channel, target_persona, status, first_detected_at, last_confirmed_at, duration_days',
    )
    .eq('venue_id', venueId)
    .neq('status', 'resolved')
    .limit(2000)
  if (error) {
    logEvent({
      level: 'warn',
      msg: 'flag_detector.load_existing_failed',
      event_type: 'wave_6d.detect',
      outcome: 'fail',
      venueId,
      data: { error: error.message },
    })
    return []
  }
  return (data ?? []) as ExistingFlagRow[]
}

// ---------------------------------------------------------------------------
// Persona drift loader (couple_intel persona share over two 30d windows)
// ---------------------------------------------------------------------------

interface PersonaShare {
  label: string
  share_pct: number
  n: number
}

async function loadPersonaShareForWindow(
  supabase: SupabaseClient,
  venueId: string,
  windowStartIso: string,
  windowEndIso: string,
): Promise<PersonaShare[]> {
  // Two-step: weddings ids → couple_intel filtered.
  const { data: weds } = await supabase
    .from('weddings')
    .select('id')
    .eq('venue_id', venueId)
    .limit(1000)
  if (!weds) return []
  const ids = (weds as Array<{ id: string }>).map((w) => w.id)
  if (ids.length === 0) return []

  const counts = new Map<string, number>()
  let total = 0
  const BATCH = 100
  for (let i = 0; i < ids.length; i += BATCH) {
    const slice = ids.slice(i, i + BATCH)
    const { data } = await supabase
      .from('couple_intel')
      .select('persona_label, last_derived_at')
      .in('wedding_id', slice)
      .gte('last_derived_at', windowStartIso)
      .lte('last_derived_at', windowEndIso)
    for (const r of (data ?? []) as Array<{ persona_label: string | null }>) {
      total += 1
      if (!r.persona_label) continue
      counts.set(r.persona_label, (counts.get(r.persona_label) ?? 0) + 1)
    }
  }
  if (total === 0) return []
  const out: PersonaShare[] = []
  for (const [label, n] of counts.entries()) {
    out.push({
      label,
      share_pct: Math.round((n / total) * 100),
      n,
    })
  }
  out.sort((a, b) => b.share_pct - a.share_pct)
  return out
}

// ---------------------------------------------------------------------------
// Channel-anomaly loader (week-over-week CAC for each channel)
// ---------------------------------------------------------------------------

interface ChannelWeeklyMetric {
  channel: string
  weeklySpendCents: number
  weeklyBookedCount: number
  weeklyCacCents: number | null
}

async function loadChannelWeeklyMetric(
  supabase: SupabaseClient,
  venueId: string,
  weekStartIso: string,
  weekEndIso: string,
): Promise<Map<string, ChannelWeeklyMetric>> {
  const out = new Map<string, ChannelWeeklyMetric>()

  // Spend per channel in the week.
  const weekStartDate = weekStartIso.slice(0, 10)
  const weekEndDate = weekEndIso.slice(0, 10)
  const { data: spendRows } = await supabase
    .from('marketing_spend_records')
    .select('channel, amount_cents, spend_date')
    .eq('venue_id', venueId)
    .gte('spend_date', weekStartDate)
    .lte('spend_date', weekEndDate)
    .limit(5000)
  for (const r of (spendRows ?? []) as Array<{
    channel: string
    amount_cents: number
  }>) {
    const c = r.channel
    const m = out.get(c) ?? {
      channel: c,
      weeklySpendCents: 0,
      weeklyBookedCount: 0,
      weeklyCacCents: null,
    }
    m.weeklySpendCents += r.amount_cents || 0
    out.set(c, m)
  }

  // Booked-attribution per channel in the week.
  const { data: attrRows } = await supabase
    .from('attribution_events')
    .select('source_platform, wedding_id, decided_at')
    .eq('venue_id', venueId)
    .eq('is_first_touch', true)
    .is('reverted_at', null)
    .gte('decided_at', weekStartIso)
    .lte('decided_at', weekEndIso)
    .limit(5000)
  const weddingIds = new Set<string>()
  const channelByWedding = new Map<string, string>()
  for (const r of (attrRows ?? []) as Array<{
    source_platform: string
    wedding_id: string
  }>) {
    if (!r.wedding_id) continue
    weddingIds.add(r.wedding_id)
    channelByWedding.set(r.wedding_id, r.source_platform)
  }
  if (weddingIds.size > 0) {
    const idList = Array.from(weddingIds)
    const BATCH = 100
    for (let i = 0; i < idList.length; i += BATCH) {
      const slice = idList.slice(i, i + BATCH)
      const { data: weds } = await supabase
        .from('weddings')
        .select('id, status')
        .in('id', slice)
      for (const w of (weds ?? []) as Array<{ id: string; status: string }>) {
        if (w.status !== 'booked' && w.status !== 'completed') continue
        const channel = channelByWedding.get(w.id)
        if (!channel) continue
        // Same channel-vocab normalization as 6B.
        const norm = channel.toLowerCase().trim()
        const c =
          norm === 'theknot' || norm === 'the_knot'
            ? 'theknot_fee'
            : norm === 'weddingwire'
              ? 'weddingwire_fee'
              : norm === 'instagram' || norm === 'facebook' || norm === 'meta'
                ? 'meta_ads'
                : norm === 'tiktok'
                  ? 'tiktok_ads'
                  : norm === 'google' || norm === 'google_search'
                    ? 'google_ads'
                    : norm
        const m = out.get(c) ?? {
          channel: c,
          weeklySpendCents: 0,
          weeklyBookedCount: 0,
          weeklyCacCents: null,
        }
        m.weeklyBookedCount += 1
        out.set(c, m)
      }
    }
  }

  // Compute CAC where possible.
  for (const m of out.values()) {
    if (m.weeklyBookedCount > 0 && m.weeklySpendCents > 0) {
      m.weeklyCacCents = Math.round(m.weeklySpendCents / m.weeklyBookedCount)
    }
  }

  return out
}

// ---------------------------------------------------------------------------
// Detection rules
// ---------------------------------------------------------------------------

function detectFromRollup(rollupCells: RollupRow[]): FlagCandidate[] {
  const candidates: FlagCandidate[] = []

  // Channel-blended ROI (across cells with non-null roi_pct + sufficient n).
  const byChannel = new Map<
    string,
    { totalRoi: number; cellCount: number; totalSpend: number }
  >()
  for (const r of rollupCells) {
    if (r.roi_pct === null) continue
    const cohortSize = r.inquiries_count + r.booked_count
    if (cohortSize < COHORT_SIZE_THRESHOLD) continue
    const m = byChannel.get(r.channel) ?? {
      totalRoi: 0,
      cellCount: 0,
      totalSpend: 0,
    }
    m.totalRoi += r.roi_pct
    m.cellCount += 1
    m.totalSpend += r.spend_cents || 0
    byChannel.set(r.channel, m)
  }
  const channelAvgRoi = new Map<string, number>()
  for (const [channel, m] of byChannel.entries()) {
    if (m.cellCount > 0) {
      channelAvgRoi.set(channel, m.totalRoi / m.cellCount)
    }
  }

  // Per-cell rules.
  for (const r of rollupCells) {
    const cohortSize = r.inquiries_count + r.booked_count
    if (cohortSize < COHORT_SIZE_THRESHOLD) continue

    const channelAvg = channelAvgRoi.get(r.channel) ?? null
    const persona = r.persona_label

    // Rule 1: cac_exceeds_ltv (severity=critical).
    // CAC > 30% of avg booking value, n>=10.
    if (
      r.cac_cents !== null &&
      r.avg_booking_value_cents !== null &&
      r.avg_booking_value_cents > 0 &&
      r.cac_cents > r.avg_booking_value_cents * CAC_LTV_RATIO
    ) {
      const ratioStr = (r.cac_cents / r.avg_booking_value_cents).toFixed(2)
      const cacDollars = (r.cac_cents / 100).toFixed(0)
      const ltvDollars = (r.avg_booking_value_cents / 100).toFixed(0)
      candidates.push({
        flagType: 'cac_exceeds_ltv',
        flagTitle: `${r.channel}${persona ? ' × ' + persona : ''}: CAC exceeds LTV threshold`,
        flagText: `CAC of $${cacDollars} on ${r.channel}${persona ? ' for ' + persona : ''} is ${ratioStr}× the average booking value of $${ltvDollars}. The 30% guardrail is breached; every booking acquired here is unprofitable on the current margin assumption. Cohort: n=${cohortSize} weddings.`,
        severity: 'critical',
        sourceChannel: r.channel,
        targetPersona: persona,
        cohortData: {
          cac_cents: r.cac_cents,
          avg_booking_value_cents: r.avg_booking_value_cents,
          ratio: r.cac_cents / r.avg_booking_value_cents,
          inquiries_count: r.inquiries_count,
          booked_count: r.booked_count,
          spend_cents: r.spend_cents,
          n_too_small: r.n_too_small,
        },
        estimatedImpactCents: -Math.round(
          r.cac_cents * Math.max(1, r.booked_count) -
            r.avg_booking_value_cents * Math.max(1, r.booked_count) * 0.3,
        ),
        recommendedAction: `Consider pausing or restructuring ${r.channel}${persona ? ' for ' + persona : ''} until the CAC/LTV ratio improves. Investigate whether the cohort is bringing in higher-value bookings that the LTV column hasn't captured yet.`,
      })
    }

    // Rule 2: underperforming_pause_candidate (severity=warning).
    // ROI < 50% of channel-blended avg AND spend > $500/mo (90d window
    // → ~$1500 over the window).
    if (
      channelAvg !== null &&
      r.roi_pct !== null &&
      r.roi_pct < channelAvg * PAUSE_ROI_RATIO &&
      r.spend_cents > PAUSE_MIN_MONTHLY_SPEND_CENTS * 3
    ) {
      const monthlySpend = (r.spend_cents / 3 / 100).toFixed(0)
      candidates.push({
        flagType: 'underperforming_pause_candidate',
        flagTitle: `${r.channel}${persona ? ' × ' + persona : ''}: underperforming vs channel avg`,
        flagText: `ROI of ${r.roi_pct.toFixed(1)}% is less than half the ${r.channel} channel-blended ROI of ${channelAvg.toFixed(1)}%. Spend is ~$${monthlySpend}/mo over the 90d window. The cell is bleeding budget that other persona × channel cells in this venue's matrix would convert better.`,
        severity: 'warning',
        sourceChannel: r.channel,
        targetPersona: persona,
        cohortData: {
          roi_pct: r.roi_pct,
          channel_avg_roi_pct: channelAvg,
          ratio: r.roi_pct / channelAvg,
          spend_cents: r.spend_cents,
          monthly_spend_cents: Math.round(r.spend_cents / 3),
          inquiries_count: r.inquiries_count,
          booked_count: r.booked_count,
          n_too_small: r.n_too_small,
        },
        estimatedImpactCents: -Math.round(r.spend_cents / 3),
        recommendedAction: `Consider pausing ${r.channel}${persona ? ' for ' + persona : ''} or reallocating that ~$${monthlySpend}/mo elsewhere. Compare against Wave 6C's reallocation recommendations before acting.`,
      })
    }

    // Rule 3: overperforming_scale_candidate (severity=info).
    // ROI > 200% of channel-blended avg AND n>=10.
    if (
      channelAvg !== null &&
      r.roi_pct !== null &&
      r.roi_pct > channelAvg * SCALE_ROI_RATIO &&
      r.spend_cents > 0
    ) {
      const monthlySpend = (r.spend_cents / 3 / 100).toFixed(0)
      candidates.push({
        flagType: 'overperforming_scale_candidate',
        flagTitle: `${r.channel}${persona ? ' × ' + persona : ''}: outperforming — scale candidate`,
        flagText: `ROI of ${r.roi_pct.toFixed(1)}% is more than 2× the ${r.channel} channel-blended ROI of ${channelAvg.toFixed(1)}%. Spend is ~$${monthlySpend}/mo over the 90d window. This cell is a clear scaling opportunity if the supply side can absorb more inquiries without quality drift.`,
        severity: 'info',
        sourceChannel: r.channel,
        targetPersona: persona,
        cohortData: {
          roi_pct: r.roi_pct,
          channel_avg_roi_pct: channelAvg,
          ratio: r.roi_pct / channelAvg,
          spend_cents: r.spend_cents,
          monthly_spend_cents: Math.round(r.spend_cents / 3),
          inquiries_count: r.inquiries_count,
          booked_count: r.booked_count,
          n_too_small: r.n_too_small,
        },
        // Project 50% more spend at the same ROI as upside (conservative
        // — scaling typically degrades ROI a little).
        estimatedImpactCents: Math.round(
          ((r.spend_cents / 3) * 0.5 * (r.roi_pct / 100)),
        ),
        recommendedAction: `Consider increasing ${r.channel}${persona ? ' for ' + persona : ''} budget by 30-50% over the next month. Watch for ROI degradation; CAC is the canary.`,
      })
    }
  }

  return candidates
}

function detectPersonaDrift(
  current: PersonaShare[],
  prior: PersonaShare[],
): FlagCandidate | null {
  if (current.length === 0 || prior.length === 0) return null
  const priorMap = new Map(prior.map((p) => [p.label, p.share_pct]))
  const currentMap = new Map(current.map((p) => [p.label, p.share_pct]))
  const labels = new Set<string>([...priorMap.keys(), ...currentMap.keys()])
  let maxDelta = 0
  let driftLabel: string | null = null
  let driftDirection: 'rising' | 'declining' = 'rising'
  for (const label of labels) {
    const c = currentMap.get(label) ?? 0
    const p = priorMap.get(label) ?? 0
    const delta = c - p
    const abs = Math.abs(delta)
    if (abs > maxDelta) {
      maxDelta = abs
      driftLabel = label
      driftDirection = delta >= 0 ? 'rising' : 'declining'
    }
  }
  if (driftLabel === null || maxDelta < PERSONA_DRIFT_THRESHOLD_PCT) {
    return null
  }
  const c = currentMap.get(driftLabel) ?? 0
  const p = priorMap.get(driftLabel) ?? 0

  return {
    flagType: 'persona_drift',
    flagTitle: `Persona drift: ${driftLabel} ${driftDirection} ${maxDelta.toFixed(0)}pp`,
    flagText: `Couple-intel persona distribution has shifted: ${driftLabel} moved from ${p}% (prior 30d) to ${c}% (current 30d) — a ${driftDirection === 'rising' ? '+' : '-'}${maxDelta.toFixed(0)}pp swing. The targeting + voice + channel mix tuned to last quarter's cohort may not match what's actually inquiring now.`,
    severity: 'warning',
    sourceChannel: null,
    targetPersona: driftLabel,
    cohortData: {
      persona_label: driftLabel,
      direction: driftDirection,
      prior_share_pct: p,
      current_share_pct: c,
      delta_pp: maxDelta,
      prior_distribution: prior,
      current_distribution: current,
    },
    estimatedImpactCents: null,
    recommendedAction: `Review channel allocation against the new persona mix. Run Wave 6C "Generate now" — the rollup-driven recommendations should already reflect this shift; if they don't, the rollup may be stale.`,
  }
}

function detectChannelAnomaly(
  currentWeek: Map<string, ChannelWeeklyMetric>,
  priorWeek: Map<string, ChannelWeeklyMetric>,
): FlagCandidate[] {
  const candidates: FlagCandidate[] = []
  for (const [channel, current] of currentWeek.entries()) {
    const prior = priorWeek.get(channel)
    if (!prior) continue
    if (current.weeklyCacCents === null || prior.weeklyCacCents === null) {
      continue
    }
    if (
      current.weeklySpendCents < ANOMALY_MIN_WEEKLY_SPEND_CENTS ||
      prior.weeklySpendCents < ANOMALY_MIN_WEEKLY_SPEND_CENTS
    ) {
      continue
    }
    if (current.weeklyCacCents > prior.weeklyCacCents * CHANNEL_ANOMALY_RATIO) {
      const cacNow = (current.weeklyCacCents / 100).toFixed(0)
      const cacPrior = (prior.weeklyCacCents / 100).toFixed(0)
      const ratio = (current.weeklyCacCents / prior.weeklyCacCents).toFixed(2)
      candidates.push({
        flagType: 'channel_anomaly',
        flagTitle: `${channel}: CAC anomaly — week-over-week ${ratio}×`,
        flagText: `Weekly CAC on ${channel} jumped from $${cacPrior} to $${cacNow} (${ratio}×). This is forensic-significant: spend or auction dynamics changed materially in 7 days. Investigate before reallocating; an anomaly week can be auction noise OR a real degradation.`,
        severity: 'warning',
        sourceChannel: channel,
        targetPersona: null,
        cohortData: {
          current_week_cac_cents: current.weeklyCacCents,
          prior_week_cac_cents: prior.weeklyCacCents,
          ratio: current.weeklyCacCents / prior.weeklyCacCents,
          current_week_spend_cents: current.weeklySpendCents,
          prior_week_spend_cents: prior.weeklySpendCents,
          current_week_booked: current.weeklyBookedCount,
          prior_week_booked: prior.weeklyBookedCount,
        },
        estimatedImpactCents: null,
        recommendedAction: `Investigate ${channel} this week — auction price spike, audience burn-out, ad set fatigue, or a creative-quality hit. Don't pause yet; confirm the trend continues for 1-2 more weeks first.`,
      })
    }
  }
  return candidates
}

// ---------------------------------------------------------------------------
// Reconciliation — merge candidates with existing flags
// ---------------------------------------------------------------------------

function flagKey(
  flagType: string,
  sourceChannel: string | null,
  targetPersona: string | null,
): string {
  return `${flagType}::${sourceChannel ?? ''}::${targetPersona ?? ''}`
}

interface ReconciliationPlan {
  toInsert: FlagCandidate[]
  toConfirm: Array<{
    id: string
    candidate: FlagCandidate
    firstDetectedAt: string
  }>
  toResolve: ExistingFlagRow[]
}

function reconcile(
  candidates: FlagCandidate[],
  existing: ExistingFlagRow[],
): ReconciliationPlan {
  const candidateMap = new Map<string, FlagCandidate>()
  for (const c of candidates) {
    candidateMap.set(
      flagKey(c.flagType, c.sourceChannel, c.targetPersona),
      c,
    )
  }
  const existingMap = new Map<string, ExistingFlagRow>()
  for (const e of existing) {
    existingMap.set(
      flagKey(e.flag_type, e.source_channel, e.target_persona),
      e,
    )
  }

  const toInsert: FlagCandidate[] = []
  const toConfirm: Array<{
    id: string
    candidate: FlagCandidate
    firstDetectedAt: string
  }> = []
  const toResolve: ExistingFlagRow[] = []

  for (const [key, candidate] of candidateMap.entries()) {
    const existingRow = existingMap.get(key)
    if (existingRow) {
      toConfirm.push({
        id: existingRow.id,
        candidate,
        firstDetectedAt: existingRow.first_detected_at,
      })
    } else {
      toInsert.push(candidate)
    }
  }

  // Existing flags whose condition no longer holds — auto-resolve when
  // last_confirmed_at is older than AUTO_RESOLVE_DAYS.
  const cutoffMs = Date.now() - AUTO_RESOLVE_DAYS * MS_PER_DAY
  for (const e of existing) {
    const key = flagKey(e.flag_type, e.source_channel, e.target_persona)
    if (candidateMap.has(key)) continue
    const lastMs = Date.parse(e.last_confirmed_at)
    if (Number.isFinite(lastMs) && lastMs < cutoffMs) {
      toResolve.push(e)
    }
  }

  return { toInsert, toConfirm, toResolve }
}

// ---------------------------------------------------------------------------
// Writers
// ---------------------------------------------------------------------------

async function insertCandidate(
  supabase: SupabaseClient,
  venueId: string,
  c: FlagCandidate,
): Promise<boolean> {
  const { error } = await supabase.from('marketing_spend_flags').insert({
    venue_id: venueId,
    flag_type: c.flagType,
    flag_title: c.flagTitle,
    flag_text: c.flagText,
    severity: c.severity,
    source_channel: c.sourceChannel,
    target_persona: c.targetPersona,
    cohort_data: c.cohortData,
    duration_days: 0,
    estimated_impact_cents: c.estimatedImpactCents,
    recommended_action: c.recommendedAction,
    status: 'pending',
    first_detected_at: new Date().toISOString(),
    last_confirmed_at: new Date().toISOString(),
  })
  if (error) {
    logEvent({
      level: 'warn',
      msg: 'flag_detector.insert_failed',
      event_type: 'wave_6d.detect',
      outcome: 'fail',
      venueId,
      data: { flagType: c.flagType, error: error.message },
    })
    return false
  }
  return true
}

async function confirmCandidate(
  supabase: SupabaseClient,
  venueId: string,
  flagId: string,
  candidate: FlagCandidate,
  firstDetectedAt: string,
): Promise<boolean> {
  const nowMs = Date.now()
  const firstMs = Date.parse(firstDetectedAt)
  const durationDays = Number.isFinite(firstMs)
    ? Math.max(0, Math.floor((nowMs - firstMs) / MS_PER_DAY))
    : 0

  // Apply the sustained gate: when 14d+ has elapsed AND the flag is
  // pause/cac, mention sustained-condition in the recommended_action
  // (idempotent rewrite — keeps the row's recommended_action fresh).
  let recommendedAction = candidate.recommendedAction
  if (
    durationDays >= SUSTAINED_DAYS &&
    (candidate.flagType === 'underperforming_pause_candidate' ||
      candidate.flagType === 'cac_exceeds_ltv')
  ) {
    recommendedAction =
      `[Sustained ${durationDays}d] ` + (candidate.recommendedAction ?? '')
  }

  const { error } = await supabase
    .from('marketing_spend_flags')
    .update({
      flag_title: candidate.flagTitle,
      flag_text: candidate.flagText,
      severity: candidate.severity,
      cohort_data: candidate.cohortData,
      duration_days: durationDays,
      estimated_impact_cents: candidate.estimatedImpactCents,
      recommended_action: recommendedAction,
      last_confirmed_at: new Date().toISOString(),
    })
    .eq('id', flagId)
    .eq('venue_id', venueId)
  if (error) {
    logEvent({
      level: 'warn',
      msg: 'flag_detector.confirm_failed',
      event_type: 'wave_6d.detect',
      outcome: 'fail',
      venueId,
      data: { flagId, error: error.message },
    })
    return false
  }
  return true
}

async function resolveFlag(
  supabase: SupabaseClient,
  venueId: string,
  flagId: string,
): Promise<boolean> {
  const { error } = await supabase
    .from('marketing_spend_flags')
    .update({
      status: 'resolved',
      resolved_at: new Date().toISOString(),
    })
    .eq('id', flagId)
    .eq('venue_id', venueId)
  if (error) {
    logEvent({
      level: 'warn',
      msg: 'flag_detector.resolve_failed',
      event_type: 'wave_6d.detect',
      outcome: 'fail',
      venueId,
      data: { flagId, error: error.message },
    })
    return false
  }
  return true
}

// ---------------------------------------------------------------------------
// Public entry point
// ---------------------------------------------------------------------------

/**
 * Detect marketing flags for one venue.
 *
 * Reads the latest 90d persona × channel rollup from Wave 6B, the
 * couple_intel persona distribution from Wave 5A, the marketing spend
 * + attribution events from Wave 6A. Writes to marketing_spend_flags
 * (mig 273) only.
 *
 * Idempotent: re-running on unchanged data updates last_confirmed_at on
 * the existing rows; doesn't duplicate. Auto-resolves flags whose
 * condition hasn't held for 7d.
 */
export async function detectMarketingFlags(
  input: DetectMarketingFlagsInput,
): Promise<DetectMarketingFlagsResult> {
  const supabase = input.supabase ?? createServiceClient()
  const venueId = input.venueId
  const startedAt = Date.now()

  // 1. Load substrate.
  const [rollupCells, existingFlags] = await Promise.all([
    loadLatest90dRollupCells(supabase, venueId),
    loadActiveFlags(supabase, venueId),
  ])

  // 2. Detect candidates from rollup-driven rules.
  const candidates: FlagCandidate[] = []
  candidates.push(...detectFromRollup(rollupCells))

  // 3. Persona drift candidate (current 30d vs prior 30d).
  const nowMs = Date.now()
  const currentStart = new Date(nowMs - 30 * MS_PER_DAY).toISOString()
  const currentEnd = new Date(nowMs).toISOString()
  const priorStart = new Date(nowMs - 60 * MS_PER_DAY).toISOString()
  const priorEnd = new Date(nowMs - 30 * MS_PER_DAY).toISOString()
  const [currentPersona, priorPersona] = await Promise.all([
    loadPersonaShareForWindow(supabase, venueId, currentStart, currentEnd),
    loadPersonaShareForWindow(supabase, venueId, priorStart, priorEnd),
  ])
  const drift = detectPersonaDrift(currentPersona, priorPersona)
  if (drift) candidates.push(drift)

  // 4. Channel anomaly (current 7d vs prior 7d).
  const currentWeekStart = new Date(nowMs - 7 * MS_PER_DAY).toISOString()
  const currentWeekEnd = new Date(nowMs).toISOString()
  const priorWeekStart = new Date(nowMs - 14 * MS_PER_DAY).toISOString()
  const priorWeekEnd = new Date(nowMs - 7 * MS_PER_DAY).toISOString()
  const [currentWeek, priorWeek] = await Promise.all([
    loadChannelWeeklyMetric(
      supabase,
      venueId,
      currentWeekStart,
      currentWeekEnd,
    ),
    loadChannelWeeklyMetric(supabase, venueId, priorWeekStart, priorWeekEnd),
  ])
  candidates.push(...detectChannelAnomaly(currentWeek, priorWeek))

  // 5. Reconcile against existing flags.
  const plan = reconcile(candidates, existingFlags)

  // 6. Apply.
  let flagsCreated = 0
  let flagsConfirmed = 0
  let flagsResolved = 0
  for (const c of plan.toInsert) {
    if (await insertCandidate(supabase, venueId, c)) flagsCreated += 1
  }
  for (const t of plan.toConfirm) {
    if (
      await confirmCandidate(
        supabase,
        venueId,
        t.id,
        t.candidate,
        t.firstDetectedAt,
      )
    ) {
      flagsConfirmed += 1
    }
  }
  for (const e of plan.toResolve) {
    if (await resolveFlag(supabase, venueId, e.id)) flagsResolved += 1
  }

  logEvent({
    level: 'info',
    msg: 'flag_detector.complete',
    event_type: 'wave_6d.detect',
    outcome: 'ok',
    venueId,
    latency_ms: Date.now() - startedAt,
    data: {
      flagsCreated,
      flagsConfirmed,
      flagsResolved,
      rollupCellsScanned: rollupCells.length,
      activeFlagsBefore: existingFlags.length,
    },
  })

  return {
    ok: true,
    venueId,
    flagsCreated,
    flagsConfirmed,
    flagsResolved,
    diagnostics: {
      rollupCellsScanned: rollupCells.length,
      flagTypesEvaluated: 5,
      activeFlagsBefore: existingFlags.length,
    },
  }
}

// ---------------------------------------------------------------------------
// Read helpers
// ---------------------------------------------------------------------------

export interface StoredMarketingSpendFlagRow {
  id: string
  venue_id: string
  flag_type: string
  flag_title: string
  flag_text: string
  severity: string
  source_channel: string | null
  target_persona: string | null
  cohort_data: Record<string, unknown>
  duration_days: number
  estimated_impact_cents: number | null
  recommended_action: string | null
  status: string
  first_detected_at: string
  last_confirmed_at: string
  acknowledged_at: string | null
  acknowledged_by: string | null
  acknowledgment_note: string | null
  resolved_at: string | null
  created_at: string
}

export interface ListFlagsOptions {
  status?: string
  severity?: string
  limit?: number
}

export async function listMarketingFlags(
  venueId: string,
  options: ListFlagsOptions = {},
  supabase: SupabaseClient = createServiceClient(),
): Promise<StoredMarketingSpendFlagRow[]> {
  const limit = Math.min(options.limit ?? 200, 1000)
  let query = supabase
    .from('marketing_spend_flags')
    .select(
      'id, venue_id, flag_type, flag_title, flag_text, severity, source_channel, target_persona, cohort_data, duration_days, estimated_impact_cents, recommended_action, status, first_detected_at, last_confirmed_at, acknowledged_at, acknowledged_by, acknowledgment_note, resolved_at, created_at',
    )
    .eq('venue_id', venueId)
    .order('last_confirmed_at', { ascending: false })
    .limit(limit)
  if (options.status) query = query.eq('status', options.status)
  if (options.severity) query = query.eq('severity', options.severity)
  const { data, error } = await query
  if (error) {
    throw new Error(`listMarketingFlags: ${error.message}`)
  }
  return (data ?? []) as StoredMarketingSpendFlagRow[]
}

export async function getMarketingFlag(
  flagId: string,
  supabase: SupabaseClient = createServiceClient(),
): Promise<StoredMarketingSpendFlagRow | null> {
  const { data, error } = await supabase
    .from('marketing_spend_flags')
    .select(
      'id, venue_id, flag_type, flag_title, flag_text, severity, source_channel, target_persona, cohort_data, duration_days, estimated_impact_cents, recommended_action, status, first_detected_at, last_confirmed_at, acknowledged_at, acknowledged_by, acknowledgment_note, resolved_at, created_at',
    )
    .eq('id', flagId)
    .maybeSingle()
  if (error) throw new Error(`getMarketingFlag: ${error.message}`)
  return (data as StoredMarketingSpendFlagRow | null) ?? null
}

export async function acknowledgeMarketingFlag(
  flagId: string,
  input: { note?: string | null; acknowledgedBy?: string | null },
  supabase: SupabaseClient = createServiceClient(),
): Promise<void> {
  const { error } = await supabase
    .from('marketing_spend_flags')
    .update({
      status: 'acknowledged',
      acknowledged_at: new Date().toISOString(),
      acknowledged_by: input.acknowledgedBy ?? null,
      acknowledgment_note: input.note ?? null,
    })
    .eq('id', flagId)
  if (error) throw new Error(`acknowledgeMarketingFlag: ${error.message}`)
}

export async function dismissMarketingFlag(
  flagId: string,
  input: { reason: string; acknowledgedBy?: string | null },
  supabase: SupabaseClient = createServiceClient(),
): Promise<void> {
  const { error } = await supabase
    .from('marketing_spend_flags')
    .update({
      status: 'dismissed',
      acknowledged_at: new Date().toISOString(),
      acknowledged_by: input.acknowledgedBy ?? null,
      acknowledgment_note: input.reason,
      resolved_at: new Date().toISOString(),
    })
    .eq('id', flagId)
  if (error) throw new Error(`dismissMarketingFlag: ${error.message}`)
}

export async function actionMarketingFlag(
  flagId: string,
  input: { note?: string | null; acknowledgedBy?: string | null },
  supabase: SupabaseClient = createServiceClient(),
): Promise<void> {
  const { error } = await supabase
    .from('marketing_spend_flags')
    .update({
      status: 'actioned',
      acknowledged_at: new Date().toISOString(),
      acknowledged_by: input.acknowledgedBy ?? null,
      acknowledgment_note: input.note ?? null,
    })
    .eq('id', flagId)
  if (error) throw new Error(`actionMarketingFlag: ${error.message}`)
}
