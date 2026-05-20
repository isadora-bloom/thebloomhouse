/**
 * D9 — couple-keyed funnel (battery Q7 / Q8 / Q14).
 *
 * The funnel is computed over engaged couples (CoupleFacts). channel-
 * scoped prospects sit outside the ratios — the doctrine treats them as
 * un-acknowledged signal, and at Rixey most are vendor noise; they are
 * surfaced as a bare count.
 *
 * Stage counts use each couple's furthest-stage ordinal, so the funnel
 * is monotone by construction — `booked` implies `toured` even when the
 * tour touchpoint was never captured (you cannot book a venue you did
 * not visit; a missing tour row is a data gap, not a skipped stage).
 */

import type { FunnelResult, FunnelSegment, FunnelStage } from './types'
import type { CohortData } from './types'
import type { CoupleFacts } from './facts'
import {
  WEEKDAY_LABEL,
  holidayWindow,
  ratio,
  season,
  zonedParts,
} from './helpers'

const STAGE_DEFS: { ordinal: number; key: FunnelStage['key']; label: string }[] =
  [
    { ordinal: 1, key: 'inquiry', label: 'Inquiry' },
    { ordinal: 2, key: 'replied', label: 'Venue replied' },
    { ordinal: 3, key: 'tour_booked', label: 'Tour booked' },
    { ordinal: 4, key: 'toured', label: 'Toured' },
    { ordinal: 5, key: 'booked', label: 'Booked' },
  ]

function buildSegment(label: string, facts: CoupleFacts[]): FunnelSegment {
  const inquiries = facts.length
  const toured = facts.filter((f) => f.toured).length
  const booked = facts.filter((f) => f.booked).length
  return {
    label,
    inquiries,
    toured,
    booked,
    inquiryToTour: ratio(toured, inquiries),
    tourToBooked: ratio(booked, toured),
    inquiryToBooked: ratio(booked, inquiries),
  }
}

export function computeFunnel(
  data: CohortData,
  facts: CoupleFacts[],
): FunnelResult {
  const inquiryTotal = facts.length

  const overall: FunnelStage[] = STAGE_DEFS.map((def, idx) => {
    const count = facts.filter((f) => f.furthest >= def.ordinal).length
    const prevCount =
      idx === 0
        ? null
        : facts.filter((f) => f.furthest >= STAGE_DEFS[idx - 1].ordinal).length
    return {
      key: def.key,
      label: def.label,
      count,
      fromPrevious: prevCount === null ? null : ratio(count, prevCount),
      fromInquiry: ratio(count, inquiryTotal),
    }
  })

  // bySeason — segment by the season of inquiry arrival (Q14).
  const seasonBuckets: Record<string, CoupleFacts[]> = {
    spring: [],
    summer: [],
    fall: [],
    winter: [],
  }
  for (const f of facts) {
    const p = zonedParts(f.firstTouchAt, data.timezone)
    if (!p) continue
    seasonBuckets[season(p.month)].push(f)
  }
  const bySeason: FunnelSegment[] = (
    ['spring', 'summer', 'fall', 'winter'] as const
  ).map((s) => buildSegment(s[0].toUpperCase() + s.slice(1), seasonBuckets[s]))

  // byTourWeekday — segment couples by the weekday of their tour (Q8).
  const weekdayBuckets: CoupleFacts[][] = [[], [], [], [], [], [], []]
  for (const f of facts) {
    if (!f.tourAt) continue
    const p = zonedParts(f.tourAt, data.timezone)
    if (!p) continue
    weekdayBuckets[p.weekday].push(f)
  }
  const byTourWeekday: FunnelSegment[] = weekdayBuckets.map((bucket, wd) => {
    const seg = buildSegment(WEEKDAY_LABEL[wd], bucket)
    // The cohort here is "couples toured on this weekday" — inquiries
    // and toured are the same number; tour -> booked is the answer.
    return { ...seg, inquiries: seg.toured, inquiryToTour: seg.toured ? 1 : null }
  })

  // byHolidayWindow — segment by holiday window of inquiry arrival (Q7).
  const NON_HOLIDAY = 'Non-holiday'
  const holidayBuckets = new Map<string, CoupleFacts[]>([[NON_HOLIDAY, []]])
  for (const f of facts) {
    const p = zonedParts(f.firstTouchAt, data.timezone)
    if (!p) continue
    const win = holidayWindow(p.month, p.day) ?? NON_HOLIDAY
    const list = holidayBuckets.get(win)
    if (list) list.push(f)
    else holidayBuckets.set(win, [f])
  }
  const byHolidayWindow: FunnelSegment[] = [...holidayBuckets.entries()]
    .map(([label, bucket]) => buildSegment(label, bucket))
    .sort((a, b) => {
      if (a.label === NON_HOLIDAY) return 1
      if (b.label === NON_HOLIDAY) return -1
      return b.inquiries - a.inquiries
    })

  return {
    overall,
    channelScopedCount: data.couples.filter(
      (c) => c.lifecycle_state === 'channel_scoped',
    ).length,
    ghostCount: data.couples.filter((c) => c.lifecycle_state === 'ghost')
      .length,
    couplesWithoutTouchpoints: facts.filter((f) => f.touchpoints.length === 0)
      .length,
    bySeason,
    byTourWeekday,
    byHolidayWindow,
  }
}
