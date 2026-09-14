/**
 * Agent activity, read off the identity spine (W63, wave 9).
 *
 * /agent/analytics answered three questions out of `interactions` and
 * `weddings`, each with its own arithmetic living in the page body:
 * how much mail moved, did the first reply land, and how long a couple
 * takes to decide. All three are spine questions now.
 *
 *   - volume      → `touchpoints`, message channels, `direction` as
 *                   stamped at write time by migration 381.
 *   - followThrough → `couples` + `touchpoints`: of the couples who
 *                   first appeared in the window, how many wrote in
 *                   more than once.
 *   - decisionTime → `couples.first_seen_at` (migration 398) to the
 *                   `contract_signed` row in `couple_progression_events`.
 *
 * Nothing here infers a direction from an action type. Migration 381
 * bans read-time inference, and a touchpoint written before that
 * migration (or one that never landed on a couple, so the stamp never
 * ran) carries `direction = NULL`. Those rows are counted as unknown and
 * reported as unknown, never folded into whichever side makes the chart
 * look tidier.
 *
 * Each reader takes its Supabase client as an argument so the unit test
 * drives it from memory; the `get*` wrappers add the service client.
 */

import type { SupabaseClient } from '@supabase/supabase-js'
import { MESSAGE_CHANNELS } from './venue-spine-counts'

const ROW_FETCH_LIMIT = 20000

const DAY_MS = 86_400_000

// ─────────────────────────────────────────────────────────────────────
// 1. Message volume by day
// ─────────────────────────────────────────────────────────────────────

export interface DailyMessageVolume {
  /** `YYYY-MM-DD`, in UTC. The page formats it for display. */
  date: string
  inbound: number
  outbound: number
  /** Rows on that day whose direction was never stamped. */
  unknown: number
}

export interface MessageVolumeResult {
  days: DailyMessageVolume[]
  totalInbound: number
  totalOutbound: number
  /** Total unstamped rows across the window. Non-zero means the two
   *  totals above do not add up to every message, and the page says so
   *  rather than letting the reader assume they do. */
  totalUnknown: number
  truncated: boolean
  generatedAt: string
}

/**
 * Inbound and outbound messages per day across a window.
 *
 * Windowed on `occurred_at`, the real event time. A backfill that
 * imported last spring's mail this morning must not draw a spike on
 * today's column.
 */
export async function loadMessageVolume(
  supabase: SupabaseClient,
  venueIds: string[],
  startIso: string,
  endIso: string,
): Promise<MessageVolumeResult> {
  const generatedAt = new Date().toISOString()
  const empty: MessageVolumeResult = {
    days: [],
    totalInbound: 0,
    totalOutbound: 0,
    totalUnknown: 0,
    truncated: false,
    generatedAt,
  }
  if (venueIds.length === 0) return empty

  const { data, error } = await supabase
    .from('touchpoints')
    .select('direction, occurred_at')
    .in('venue_id', venueIds)
    .in('channel', [...MESSAGE_CHANNELS])
    .gte('occurred_at', startIso)
    .lt('occurred_at', endIso)
    .order('occurred_at', { ascending: true })
    .limit(ROW_FETCH_LIMIT)
  if (error) throw new Error(`loadMessageVolume: touchpoints ${error.message}`)

  const rows = (data ?? []) as Array<{ direction: string | null; occurred_at: string }>
  const byDay = new Map<string, DailyMessageVolume>()
  let totalInbound = 0
  let totalOutbound = 0
  let totalUnknown = 0

  for (const row of rows) {
    const date = row.occurred_at.slice(0, 10)
    let bucket = byDay.get(date)
    if (!bucket) {
      bucket = { date, inbound: 0, outbound: 0, unknown: 0 }
      byDay.set(date, bucket)
    }
    if (row.direction === 'inbound') {
      bucket.inbound += 1
      totalInbound += 1
    } else if (row.direction === 'outbound') {
      bucket.outbound += 1
      totalOutbound += 1
    } else {
      bucket.unknown += 1
      totalUnknown += 1
    }
  }

  return {
    days: [...byDay.values()].sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0)),
    totalInbound,
    totalOutbound,
    totalUnknown,
    truncated: rows.length >= ROW_FETCH_LIMIT,
    generatedAt,
  }
}

export async function getMessageVolume(
  venueIds: string[],
  startIso: string,
  endIso: string,
): Promise<MessageVolumeResult> {
  const { createServiceClient } = await import('@/lib/supabase/service')
  return loadMessageVolume(createServiceClient(), venueIds, startIso, endIso)
}

// ─────────────────────────────────────────────────────────────────────
// 2. Did the first reply land
// ─────────────────────────────────────────────────────────────────────

export interface FollowThroughResult {
  /** Percentage, 0-100, or null when the denominator is zero. Never a
   *  fake 0 — the honesty primitive the canonical Distribution uses. */
  rate: number | null
  /** Couples who wrote in at all inside the window. The denominator. */
  sample: number
  /** Of those, the ones who wrote in more than once. The numerator. */
  returned: number
  sinceIso: string
  generatedAt: string
}

/**
 * Of the couples who first appeared in the window, how many came back.
 *
 * The legacy version counted weddings with `inquiry_date` in the last
 * ninety days, then counted inbound `interactions` per wedding. The
 * spine answers the same question with `couples.first_seen_at`
 * (migration 398 — the earliest touchpoint on the couple, whatever the
 * channel) and inbound touchpoints, so a couple who first appeared on
 * Instagram and came back by email is counted the same as one who did
 * both by email. The legacy version could not see the first half of
 * that.
 */
export async function loadFollowThrough(
  supabase: SupabaseClient,
  venueIds: string[],
  sinceIso: string,
): Promise<FollowThroughResult> {
  const generatedAt = new Date().toISOString()
  if (venueIds.length === 0) {
    return { rate: null, sample: 0, returned: 0, sinceIso, generatedAt }
  }

  const { data: coupleData, error: coupleErr } = await supabase
    .from('couples')
    .select('id, first_seen_at')
    .in('venue_id', venueIds)
    .is('merged_into_id', null)
    .gte('first_seen_at', sinceIso)
    .limit(ROW_FETCH_LIMIT)
  if (coupleErr) throw new Error(`loadFollowThrough: couples ${coupleErr.message}`)

  const coupleIds = ((coupleData ?? []) as Array<{ id: string }>).map((c) => c.id)
  if (coupleIds.length === 0) {
    return { rate: null, sample: 0, returned: 0, sinceIso, generatedAt }
  }

  const { data: tpData, error: tpErr } = await supabase
    .from('touchpoints')
    .select('couple_id, direction')
    .in('venue_id', venueIds)
    .in('channel', [...MESSAGE_CHANNELS])
    .eq('direction', 'inbound')
    .limit(ROW_FETCH_LIMIT)
  if (tpErr) throw new Error(`loadFollowThrough: touchpoints ${tpErr.message}`)

  const wanted = new Set(coupleIds)
  const inboundPerCouple = new Map<string, number>()
  for (const row of (tpData ?? []) as Array<{ couple_id: string | null }>) {
    if (!row.couple_id || !wanted.has(row.couple_id)) continue
    inboundPerCouple.set(row.couple_id, (inboundPerCouple.get(row.couple_id) ?? 0) + 1)
  }

  let sample = 0
  let returned = 0
  for (const count of inboundPerCouple.values()) {
    if (count >= 1) sample += 1
    if (count >= 2) returned += 1
  }

  return {
    rate: sample > 0 ? Math.round((returned / sample) * 100) : null,
    sample,
    returned,
    sinceIso,
    generatedAt,
  }
}

export async function getFollowThrough(
  venueIds: string[],
  sinceIso: string,
): Promise<FollowThroughResult> {
  const { createServiceClient } = await import('@/lib/supabase/service')
  return loadFollowThrough(createServiceClient(), venueIds, sinceIso)
}

// ─────────────────────────────────────────────────────────────────────
// 3. How long a couple takes to decide
// ─────────────────────────────────────────────────────────────────────

export interface DecisionTimelineResult {
  /** Mean days from first sight to contract, rounded. Null at n = 0. */
  averageDays: number | null
  /** Share of the sample, 0-100, in each band. Zero at n = 0. */
  fastPct: number
  typicalPct: number
  slowPct: number
  /** Couples behind the figures. */
  sample: number
  /** Couples whose contract is recorded but whose first sight is not, so
   *  no span could be measured. Reported rather than dropped silently. */
  unmeasurable: number
  sinceIso: string
  generatedAt: string
}

/** Band edges in days. Same cuts the page drew before this reader
 *  existed, kept so the bar means what it has always meant. */
const FAST_UNDER_DAYS = 7
const TYPICAL_UPTO_DAYS = 30

/**
 * Days from a couple's first touchpoint to their contract.
 *
 * `couples.first_seen_at` is the start; the `contract_signed` row in
 * `couple_progression_events` is the end. The legacy version measured
 * `weddings.inquiry_date` to `weddings.updated_at` — and `updated_at` is
 * bumped by every batch import and every reconciliation pass, so it was
 * measuring the last time anything touched the row, not the day the
 * couple signed.
 */
export async function loadDecisionTimeline(
  supabase: SupabaseClient,
  venueIds: string[],
  sinceIso: string,
): Promise<DecisionTimelineResult> {
  const generatedAt = new Date().toISOString()
  const empty: DecisionTimelineResult = {
    averageDays: null,
    fastPct: 0,
    typicalPct: 0,
    slowPct: 0,
    sample: 0,
    unmeasurable: 0,
    sinceIso,
    generatedAt,
  }
  if (venueIds.length === 0) return empty

  const { data: coupleData, error: coupleErr } = await supabase
    .from('couples')
    .select('id, first_seen_at, lifecycle_state')
    .in('venue_id', venueIds)
    .is('merged_into_id', null)
    .in('lifecycle_state', ['booked', 'completed'])
    .limit(ROW_FETCH_LIMIT)
  if (coupleErr) throw new Error(`loadDecisionTimeline: couples ${coupleErr.message}`)

  const firstSeen = new Map<string, string | null>()
  for (const row of (coupleData ?? []) as Array<{ id: string; first_seen_at: string | null }>) {
    firstSeen.set(row.id, row.first_seen_at)
  }
  if (firstSeen.size === 0) return empty

  const { data: eventData, error: eventErr } = await supabase
    .from('couple_progression_events')
    .select('couple_id, occurred_at, event_type')
    .in('couple_id', [...firstSeen.keys()])
    .eq('event_type', 'contract_signed')
    .gte('occurred_at', sinceIso)
    .limit(ROW_FETCH_LIMIT)
  if (eventErr) {
    throw new Error(`loadDecisionTimeline: couple_progression_events ${eventErr.message}`)
  }

  // A couple can, in principle, carry more than one contract_signed row
  // (a re-signed contract after a date move). The earliest is the
  // decision; the later ones are paperwork.
  const signedAt = new Map<string, string>()
  for (const row of (eventData ?? []) as Array<{ couple_id: string; occurred_at: string }>) {
    const held = signedAt.get(row.couple_id)
    if (!held || row.occurred_at < held) signedAt.set(row.couple_id, row.occurred_at)
  }

  const spans: number[] = []
  let unmeasurable = 0
  for (const [coupleId, signed] of signedAt) {
    const seen = firstSeen.get(coupleId)
    if (!seen) {
      unmeasurable += 1
      continue
    }
    const days = (new Date(signed).getTime() - new Date(seen).getTime()) / DAY_MS
    if (!Number.isFinite(days) || days < 0) {
      unmeasurable += 1
      continue
    }
    spans.push(days)
  }

  if (spans.length === 0) {
    return { ...empty, unmeasurable }
  }

  const total = spans.length
  const fast = spans.filter((d) => d < FAST_UNDER_DAYS).length
  const typical = spans.filter((d) => d >= FAST_UNDER_DAYS && d <= TYPICAL_UPTO_DAYS).length
  const slow = spans.filter((d) => d > TYPICAL_UPTO_DAYS).length

  return {
    averageDays: Math.round(spans.reduce((s, d) => s + d, 0) / total),
    fastPct: Math.round((fast / total) * 100),
    typicalPct: Math.round((typical / total) * 100),
    slowPct: Math.round((slow / total) * 100),
    sample: total,
    unmeasurable,
    sinceIso,
    generatedAt,
  }
}

export async function getDecisionTimeline(
  venueIds: string[],
  sinceIso: string,
): Promise<DecisionTimelineResult> {
  const { createServiceClient } = await import('@/lib/supabase/service')
  return loadDecisionTimeline(createServiceClient(), venueIds, sinceIso)
}
