/**
 * D9 — response time (battery Q1 / Q2 / Q4 / Q22).
 *
 * The gap between a couple's first inbound touchpoint (the inquiry
 * arriving) and the venue's first reply (CoupleFacts.responseHours).
 *
 * A couple with an inbound but no venue reply is a "never replied" —
 * counted separately, never folded into the median as a zero or an
 * infinity. That count itself feeds Q23 / Q24.
 */

import type { CohortData, Distribution, ResponseTimeResult } from './types'
import type { CoupleFacts } from './facts'
import { median, summarize, zonedParts } from './helpers'

const YEAR_MS = 365 * 24 * 3600_000

export function computeResponseTime(
  data: CohortData,
  facts: CoupleFacts[],
): ResponseTimeResult {
  const replied = facts.filter((f) => f.responseHours !== null)
  const repliedHours = replied.map((f) => f.responseHours as number)

  const overall: Distribution = summarize(repliedHours)
  const neverRepliedCount = facts.filter(
    (f) => f.hasInbound && !f.hasReply,
  ).length

  // 12-month delta — split by inquiry arrival.
  const now = Date.now()
  const last12: number[] = []
  const prior12: number[] = []
  for (const f of replied) {
    if (!f.firstInboundAt) continue
    const age = now - Date.parse(f.firstInboundAt)
    if (age < 0) continue
    if (age <= YEAR_MS) last12.push(f.responseHours as number)
    else if (age <= 2 * YEAR_MS) prior12.push(f.responseHours as number)
  }
  const last12moMedian = median(last12)
  const prior12moMedian = median(prior12)
  const deltaHours =
    last12moMedian !== null && prior12moMedian !== null
      ? Math.round((last12moMedian - prior12moMedian) * 100) / 100
      : null

  // By outcome — bookers vs ghosters (Q2).
  const outcomeBuckets: Record<string, number[]> = {
    booked: [],
    ghost: [],
    in_progress: [],
  }
  for (const f of replied) {
    outcomeBuckets[f.outcome].push(f.responseHours as number)
  }
  const byOutcome = (['booked', 'ghost', 'in_progress'] as const).map(
    (outcome) => ({ outcome, dist: summarize(outcomeBuckets[outcome]) }),
  )

  // By arrival channel (Q4).
  const channelBuckets = new Map<string, number[]>()
  for (const f of replied) {
    const ch = f.arrivalChannel ?? 'unknown'
    const list = channelBuckets.get(ch)
    if (list) list.push(f.responseHours as number)
    else channelBuckets.set(ch, [f.responseHours as number])
  }
  const byChannel = [...channelBuckets.entries()]
    .map(([channel, hours]) => ({ channel, dist: summarize(hours) }))
    .sort((a, b) => b.dist.n - a.dist.n)

  // By arrival hour-of-day in venue local time (Q22).
  const hourBuckets: number[][] = Array.from({ length: 24 }, () => [])
  for (const f of replied) {
    if (!f.firstInboundAt) continue
    const p = zonedParts(f.firstInboundAt, data.timezone)
    if (!p) continue
    hourBuckets[p.hour].push(f.responseHours as number)
  }
  const byArrivalHour = hourBuckets.map((hours, hour) => ({
    hour,
    dist: summarize(hours),
  }))

  return {
    overall,
    last12moMedian,
    prior12moMedian,
    deltaHours,
    neverRepliedCount,
    byOutcome,
    byChannel,
    byArrivalHour,
  }
}
