/**
 * Operator-patterns tool source — questions about the operator's own behaviour.
 *
 * W12 of NOVEMBER-PLAN.md wave 2. Three battery questions that are about the
 * venue side of the conversation rather than the couple side:
 *
 *   Q22 what hours and weekdays replies actually go out, against the hours and
 *       weekdays inquiries actually arrive, in venue local time
 *   Q23 couples replied to once and never followed up: how many, and the shape
 *       of them (channel, weekday, outcome)
 *   Q24 inquiries replied to that turned out to be a mismatch, read off the
 *       eventual recorded loss reason rather than guessed at
 *
 * Q22 and Q23 are spine-only: `couples` and `touchpoints`, through the shared
 * loader in time-series.ts. Q24 is not, and cannot be yet — the loss reason an
 * operator types lives on `weddings.lost_reason`, a legacy column with no
 * equivalent on `couples`. That read is marked and isolated below; the moment
 * the spine carries a loss reason, this source should move to it.
 *
 * Nothing here writes. Q24 in particular reports the operator's own words back
 * grouped verbatim and classifies nothing, because a "wrong vibe" bucket
 * inferred from free text would be a guess wearing a number's clothes.
 */

import type Anthropic from '@anthropic-ai/sdk'
import type { SupabaseClient } from '@supabase/supabase-js'
import { insufficient, type IntelToolSource, type ToolSourceDeps } from './types'
import {
  displayName,
  honest,
  honestRate,
  loadSpineSlice,
  todayMs,
  type HonestValue,
  type SpineSlice,
} from './time-series'
import { isOutbound } from '@/lib/services/cohort/direction'
import { WEEKDAY_LABEL, fetchAllRows, median, round2, zonedParts } from '@/lib/services/cohort/helpers'
import { MIN_DISTRIBUTION_N } from '@/lib/services/cohort/types'
import type { CoupleFacts } from '@/lib/services/cohort/facts'

const MIN_N = MIN_DISTRIBUTION_N
/** Bar for one hour of the day or one weekday. Same reasoning as the slice bar
 *  in time-series.ts: below five, a median is one bad afternoon. */
const MIN_SLICE_N = 5
/** How many couples any list in a result may name. A longer list is truncated
 *  and says so rather than being silently cut. */
const NAME_CAP = 25

const DAY_MS = 86_400_000

// ---------------------------------------------------------------------------
// Q22 — when replies go out against when inquiries arrive
// ---------------------------------------------------------------------------

interface Slot {
  n: number
  share: number | null
}

function shares(counts: number[]): Slot[] {
  const total = counts.reduce((a, b) => a + b, 0)
  return counts.map((n) => ({ n, share: total > 0 ? round2(n / total) : null }))
}

function replyTiming(slice: SpineSlice) {
  const tz = slice.timezone

  // Replies: every venue-originated touchpoint, not only the first one. The
  // question is about the operator's working day, and a follow-up sent at
  // 11pm is as much a part of that as a first reply.
  const replyByHour = new Array(24).fill(0)
  const replyByWeekday = new Array(7).fill(0)
  let replyTotal = 0
  for (const f of slice.facts) {
    for (const tp of f.touchpoints) {
      if (!isOutbound(tp)) continue
      const p = zonedParts(tp.occurred_at, tz)
      if (!p) continue
      replyByHour[p.hour]++
      replyByWeekday[p.weekday]++
      replyTotal++
    }
  }

  // Arrivals: one per couple, at the moment their first messageable inquiry
  // landed. Counting every inbound message instead would let one chatty
  // couple redraw the arrival curve.
  const arrivalByHour = new Array(24).fill(0)
  const arrivalByWeekday = new Array(7).fill(0)
  const speedByHour: number[][] = Array.from({ length: 24 }, () => [])
  const speedByWeekday: number[][] = Array.from({ length: 7 }, () => [])
  let arrivalTotal = 0
  for (const f of slice.facts) {
    if (!f.firstMessageableInboundAt) continue
    const p = zonedParts(f.firstMessageableInboundAt, tz)
    if (!p) continue
    arrivalByHour[p.hour]++
    arrivalByWeekday[p.weekday]++
    arrivalTotal++
    if (f.responseHours !== null) {
      speedByHour[p.hour].push(f.responseHours)
      speedByWeekday[p.weekday].push(f.responseHours)
    }
  }

  const replyHourSlots = shares(replyByHour)
  const arrivalHourSlots = shares(arrivalByHour)

  const byArrivalHour = speedByHour.map((hours, hour) => ({
    hour,
    medianHours: honest(median(hours), hours.length, MIN_SLICE_N, 'answered inquiries'),
  }))
  const byArrivalWeekday = speedByWeekday.map((hours, weekday) => ({
    weekday: WEEKDAY_LABEL[weekday],
    medianHours: honest(median(hours), hours.length, MIN_SLICE_N, 'answered inquiries'),
  }))

  const measurable = byArrivalHour.filter((b) => b.medianHours.enoughData)
  const sorted = [...measurable].sort(
    (a, b) => (a.medianHours.value as number) - (b.medianHours.value as number),
  )
  const fastestHour = sorted[0] ?? null
  const slowestHour = sorted[sorted.length - 1] ?? null

  // Where the two curves disagree most: the hour that takes the largest share
  // of inquiries relative to the share of replies sent in it.
  let widestGap: { hour: number; inquiryShare: number; replyShare: number; gap: number } | null =
    null
  if (replyTotal > 0 && arrivalTotal >= MIN_N) {
    for (let h = 0; h < 24; h++) {
      const inq = arrivalHourSlots[h].share ?? 0
      const rep = replyHourSlots[h].share ?? 0
      const gap = round2(inq - rep)
      if (!widestGap || gap > widestGap.gap) {
        widestGap = { hour: h, inquiryShare: inq, replyShare: rep, gap }
      }
    }
  }

  return {
    metric: 'reply_timing',
    battery: 'Q22',
    timezone: tz,
    replies: {
      n: replyTotal,
      byHour: replyHourSlots.map((s, hour) => ({ hour, ...s })),
      byWeekday: replyByWeekday.map((n, wd) => ({
        weekday: WEEKDAY_LABEL[wd],
        n,
        share: replyTotal > 0 ? round2(n / replyTotal) : null,
      })),
    },
    inquiries: {
      n: arrivalTotal,
      byHour: arrivalHourSlots.map((s, hour) => ({ hour, ...s })),
      byWeekday: arrivalByWeekday.map((n, wd) => ({
        weekday: WEEKDAY_LABEL[wd],
        n,
        share: arrivalTotal > 0 ? round2(n / arrivalTotal) : null,
      })),
    },
    responseSpeedByArrivalHour: byArrivalHour,
    responseSpeedByArrivalWeekday: byArrivalWeekday,
    fastestArrivalHour: fastestHour ?? {
      ...insufficient(measurable.length, 'no hour of the day has enough answered inquiries to rank'),
    },
    slowestArrivalHour: slowestHour ?? {
      ...insufficient(measurable.length, 'no hour of the day has enough answered inquiries to rank'),
    },
    widestCoverageGap:
      widestGap ?? {
        ...insufficient(arrivalTotal, 'too few inquiries to compare the two curves hour by hour'),
      },
    note:
      'Hours are 0 to 23 in venue local time from venue_config. Reply counts are every outbound ' +
      'message; arrival counts are one per couple, at their first inquiry the venue could answer ' +
      'in writing. Speed is measured against the hour the inquiry arrived, not the hour it was answered.',
  }
}

// ---------------------------------------------------------------------------
// Q23 — replied once, never followed up
// ---------------------------------------------------------------------------

function singleReplyNoFollowUp(slice: SpineSlice, today: string) {
  const now = todayMs(today)

  interface Row {
    id: string
    name: string | null
    channel: string
    repliedAt: string
    weekday: string
    outcome: CoupleFacts['outcome']
    daysSinceReply: number
  }

  const rows: Row[] = []
  let repliedAtAll = 0
  for (const f of slice.facts) {
    const outbound = f.touchpoints.filter(isOutbound)
    if (outbound.length === 0) continue
    repliedAtAll++
    if (outbound.length !== 1) continue
    const reply = outbound[0]
    const p = zonedParts(reply.occurred_at, slice.timezone)
    rows.push({
      id: f.couple.id,
      name: displayName(slice, f),
      channel: f.messageableChannel ?? reply.channel,
      repliedAt: reply.occurred_at,
      weekday: p ? WEEKDAY_LABEL[p.weekday] : 'unknown',
      outcome: f.outcome,
      daysSinceReply: Math.max(0, Math.floor((now - Date.parse(reply.occurred_at)) / DAY_MS)),
    })
  }

  const stillOpen = rows.filter((r) => r.outcome !== 'booked')

  const tally = <K extends string>(list: Row[], key: (r: Row) => K) => {
    const counts = new Map<K, number>()
    for (const r of list) counts.set(key(r), (counts.get(key(r)) ?? 0) + 1)
    return [...counts.entries()]
      .sort((a, b) => b[1] - a[1])
      .map(([label, n]) => ({
        label,
        n,
        share: list.length > 0 ? round2(n / list.length) : null,
      }))
  }

  const days = rows.map((r) => r.daysSinceReply)

  return {
    metric: 'single_reply_no_follow_up',
    battery: 'Q23',
    timezone: slice.timezone,
    definition:
      'A couple with exactly one venue-originated message in their whole ribbon. The venue answered ' +
      'once and never went back, whatever the couple did afterwards.',
    coupleCount: { n: rows.length },
    ofCouplesEverReplied: honestRate(
      rows.length,
      repliedAtAll,
      MIN_N,
      'couples the venue ever replied to',
    ),
    stillOpen: {
      n: stillOpen.length,
      note: 'The same set minus the ones who booked anyway. These are the ones a follow-up could still reach.',
    },
    byOutcome: tally(rows, (r) => r.outcome),
    byInquiryChannel: tally(rows, (r) => r.channel),
    byReplyWeekday: tally(rows, (r) => r.weekday),
    medianDaysSinceThatReply: honest(
      median(days),
      days.length,
      MIN_SLICE_N,
      'couples with a single reply',
    ),
    couples: rows
      .sort((a, b) => b.repliedAt.localeCompare(a.repliedAt))
      .slice(0, NAME_CAP)
      .map((r) => ({
        name: r.name,
        coupleId: r.id,
        channel: r.channel,
        repliedAt: r.repliedAt,
        replyWeekday: r.weekday,
        daysSince: r.daysSinceReply,
        outcome: r.outcome,
      })),
    truncated: rows.length > NAME_CAP,
    neverRepliedAtAll: {
      n: slice.facts.filter((f) => f.hasMessageableInbound && !f.hasReply).length,
      note: 'A separate failure: an inquiry the venue could have answered and never did. Not counted above.',
    },
    note:
      'Direction comes from the Gmail adapter, which is the only channel that records venue-sent ' +
      'messages. A reply sent by phone or in person leaves no touchpoint and cannot be seen here.',
  }
}

// ---------------------------------------------------------------------------
// Q24 — replied to, and it turned out to be a mismatch
// ---------------------------------------------------------------------------

interface LostWeddingRow {
  id: string
  status: string | null
  lost_at: string | null
  lost_reason: string | null
}

/**
 * Couples the venue replied to that later went to `lost` with a reason on
 * record.
 *
 * LEGACY READ, and knowingly so. `weddings.lost_reason` and `weddings.lost_at`
 * (migration 001, kept current by migration 323) have no equivalent on
 * `couples`: the spine records that a couple went to `ghost`, never why. Until
 * a loss reason lands on the spine this is the only place the fact exists, and
 * answering Q24 off lifecycle alone would mean inferring "wrong budget" from
 * silence. The join runs through `couples.source_wedding_id`, so a couple with
 * no mirror row simply does not appear, and the count says how many those are.
 */
async function repliedButMismatch(
  slice: SpineSlice,
  supabase: SupabaseClient,
  venueId: string,
) {
  // legacy-read-ok: weddings.lost_reason has no spine equivalent
  const lostRows = await fetchAllRows<LostWeddingRow>(() =>
    supabase
      .from('weddings')
      .select('id, status, lost_at, lost_reason')
      .eq('venue_id', venueId)
      .eq('status', 'lost'),
  )
  const lostById = new Map(lostRows.map((r) => [r.id, r]))

  interface Row {
    id: string
    name: string | null
    reason: string | null
    lostAt: string | null
    replyHours: number | null
    channel: string | null
  }

  const replied = slice.facts.filter((f) => f.hasReply)
  const rows: Row[] = []
  let repliedWithoutMirror = 0
  for (const f of replied) {
    const weddingId = slice.weddingId.get(f.couple.id)
    if (!weddingId) {
      repliedWithoutMirror++
      continue
    }
    const lost = lostById.get(weddingId)
    if (!lost) continue
    rows.push({
      id: f.couple.id,
      name: displayName(slice, f),
      reason: lost.lost_reason?.trim() || null,
      lostAt: lost.lost_at,
      replyHours: f.responseHours,
      channel: f.messageableChannel,
    })
  }

  const withReason = rows.filter((r) => r.reason)
  const reasonCounts = new Map<string, { label: string; n: number }>()
  for (const r of withReason) {
    const key = (r.reason as string).toLowerCase()
    const entry = reasonCounts.get(key)
    if (entry) entry.n++
    else reasonCounts.set(key, { label: r.reason as string, n: 1 })
  }

  const mismatchHours = rows
    .map((r) => r.replyHours)
    .filter((h): h is number => h !== null)
  const allRepliedHours = replied
    .map((f) => f.responseHours)
    .filter((h): h is number => h !== null)

  const medianMismatch: HonestValue = honest(
    median(mismatchHours),
    mismatchHours.length,
    MIN_SLICE_N,
    'lost couples with a measured reply time',
  )
  const medianAll: HonestValue = honest(
    median(allRepliedHours),
    allRepliedHours.length,
    MIN_N,
    'answered inquiries',
  )

  return {
    metric: 'replied_but_mismatch',
    battery: 'Q24',
    timezone: slice.timezone,
    source:
      'weddings.status and weddings.lost_reason, joined to the spine through couples.source_wedding_id. ' +
      'This is a legacy table: the spine records that a couple went cold, never why.',
    repliedAndLost: { n: rows.length },
    withRecordedReason: { n: withReason.length },
    withoutRecordedReason: {
      n: rows.length - withReason.length,
      note: 'Marked lost with no reason typed. Nothing is inferred for these.',
    },
    repliedWithNoLegacyRecord: {
      n: repliedWithoutMirror,
      note: 'Couples the venue replied to that have no weddings row, so no loss reason could exist for them.',
    },
    shareOfRepliedThatWereLost: honestRate(
      rows.length,
      replied.length,
      MIN_N,
      'couples the venue replied to',
    ),
    reasons: [...reasonCounts.values()]
      .sort((a, b) => b.n - a.n)
      .map((r) => ({
        reason: r.label,
        n: r.n,
        share: withReason.length > 0 ? round2(r.n / withReason.length) : null,
      })),
    replyTime: {
      lostCouples: medianMismatch,
      allAnsweredInquiries: medianAll,
      note: 'Both in hours. If the first is the smaller number, the fastest replies went to the couples who were never a fit.',
    },
    couples: withReason
      .sort((a, b) => (b.lostAt ?? '').localeCompare(a.lostAt ?? ''))
      .slice(0, NAME_CAP)
      .map((r) => ({
        name: r.name,
        coupleId: r.id,
        reason: r.reason,
        lostAt: r.lostAt,
        replyHours: r.replyHours === null ? null : round2(r.replyHours),
        channel: r.channel,
      })),
    truncated: withReason.length > NAME_CAP,
    note:
      'Reasons are grouped exactly as the operator typed them and nothing is sorted into a budget or ' +
      'vibe bucket. Reading intent out of that free text would be a guess, and the question asks for ' +
      'the eventual outcome, not an inference.',
  }
}

// ---------------------------------------------------------------------------
// Tool definition
// ---------------------------------------------------------------------------

const METRICS = ['reply_timing', 'single_reply_no_follow_up', 'replied_but_mismatch'] as const
type Metric = (typeof METRICS)[number]

const tool: Anthropic.Tool = {
  name: 'get_operator_patterns',
  description:
    "How the venue itself behaves, as opposed to how couples behave. Pick one metric:\n" +
    '- reply_timing: the hour-of-day and weekday distribution of outbound replies against the hours ' +
    'and weekdays inquiries actually arrive, plus the median response time by arrival hour and ' +
    'weekday, and the hour where the two curves diverge most. All in venue local time.\n' +
    '- single_reply_no_follow_up: couples answered exactly once and never chased, with a count and a ' +
    'breakdown by channel, weekday and outcome, plus the couples themselves by name.\n' +
    '- replied_but_mismatch: couples the venue replied to that were later marked lost, grouped by the ' +
    'loss reason the operator recorded, with the reply time for that group against the reply time ' +
    'overall. Reasons are reported verbatim and never sorted into inferred categories.\n' +
    'Every count and rate carries its n and refuses rather than quoting a figure off a handful of couples.',
  input_schema: {
    type: 'object',
    properties: {
      metric: {
        type: 'string',
        enum: [...METRICS],
        description: 'Which pattern to compute.',
      },
    },
    required: ['metric'],
    additionalProperties: false,
  },
}

export const operatorPatternsSource: IntelToolSource = {
  tool,
  subjects: [
    'what time of day and what weekday the venue replies, against when inquiries arrive',
    'couples replied to once and never followed up',
    'inquiries that were replied to and turned out to be a mismatch, by recorded loss reason',
  ],
  batteryQuestions: ['Q22', 'Q23', 'Q24'],
  // `reason` here is weddings.lost_reason: free text an operator typed into
  // a legacy column. The name is shared with HonestCount's own `reason`, so
  // an insufficient-data explanation this product wrote gets wrapped too.
  // That is noise on an edge case, and the alternative — renaming one of
  // them — would change a published tool result shape to buy tidiness.
  freeTextFields: ['reason'],

  async run(venueId, args, deps: ToolSourceDeps) {
    const raw = args.metric
    const metric =
      typeof raw === 'string' && (METRICS as readonly string[]).includes(raw)
        ? (raw as Metric)
        : null
    if (!metric) {
      return { error: `metric is required and must be one of: ${METRICS.join(', ')}.` }
    }
    if (!venueId) {
      return { ...insufficient(0, 'no venue in scope'), metric }
    }

    const slice = await loadSpineSlice(deps.supabase, venueId)

    switch (metric) {
      case 'reply_timing':
        return replyTiming(slice)
      case 'single_reply_no_follow_up':
        return singleReplyNoFollowUp(slice, deps.today)
      case 'replied_but_mismatch':
        return repliedButMismatch(slice, deps.supabase, venueId)
    }
  },
}
