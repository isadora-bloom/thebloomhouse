/**
 * D9 — response time (battery Q1 / Q2 / Q4 / Q22).
 *
 * Response time is measured only over *messageable* arrivals — a
 * touchpoint the venue can reply to in writing. A Calendly tour_booked
 * is inbound but self-service; treating it as an inquiry-the-venue-
 * must-respond-to inflated the median by days on the first live run
 * (5.1d overall, calendly 16.1d, bookers 18.9d). See facts.ts
 * `isMessageableInbound`.
 *
 * A couple with a messageable inbound but no venue reply is a "never
 * replied" — counted separately, never folded into the median as a
 * zero or an infinity. That count itself feeds Q23 / Q24.
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
    (f) => f.hasMessageableInbound && !f.hasReply,
  ).length

  // 12-month delta — split by messageable inquiry arrival.
  const now = Date.now()
  const last12: number[] = []
  const prior12: number[] = []
  for (const f of replied) {
    if (!f.firstMessageableInboundAt) continue
    const age = now - Date.parse(f.firstMessageableInboundAt)
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

  // By messageable channel (Q4). Currently `'reply'` only lands on
  // gmail, so this is a one-row table in v1; the shape is preserved so
  // a future SMS / IG-DM adapter shows through without re-wiring.
  const channelBuckets = new Map<string, number[]>()
  for (const f of replied) {
    const ch = f.messageableChannel ?? 'unknown'
    const list = channelBuckets.get(ch)
    if (list) list.push(f.responseHours as number)
    else channelBuckets.set(ch, [f.responseHours as number])
  }
  const byChannel = [...channelBuckets.entries()]
    .map(([channel, hours]) => ({ channel, dist: summarize(hours) }))
    .sort((a, b) => b.dist.n - a.dist.n)

  // By arrival hour-of-day in venue local time (Q22) — bucketed off
  // the messageable inbound timestamp so we are timing real inquiries.
  const hourBuckets: number[][] = Array.from({ length: 24 }, () => [])
  for (const f of replied) {
    if (!f.firstMessageableInboundAt) continue
    const p = zonedParts(f.firstMessageableInboundAt, data.timezone)
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
