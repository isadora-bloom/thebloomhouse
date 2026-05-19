/**
 * D9 — booking lead time (battery Q11).
 *
 * Lead time = days between a couple's first touchpoint (the first time
 * the venue heard from them) and their wedding_date. Computed only for
 * couples that have a wedding_date; the count without one is reported
 * alongside so the surface never implies the distribution covers
 * everyone.
 *
 * A non-positive lead time (wedding_date at or before the first
 * touchpoint) is a data artefact — a backfilled date, a past-dated CSV
 * row — and is excluded from the distribution rather than clamped.
 */

import type { LeadTimeResult } from './types'
import type { CoupleFacts } from './facts'
import { summarize } from './helpers'

const DAY_MS = 24 * 3600_000

const HISTOGRAM_BUCKETS: { label: string; maxMonths: number }[] = [
  { label: '0-3 months', maxMonths: 3 },
  { label: '3-6 months', maxMonths: 6 },
  { label: '6-9 months', maxMonths: 9 },
  { label: '9-12 months', maxMonths: 12 },
  { label: '12-18 months', maxMonths: 18 },
  { label: '18-24 months', maxMonths: 24 },
  { label: '24+ months', maxMonths: Infinity },
]

export function computeLeadTime(facts: CoupleFacts[]): LeadTimeResult {
  const leadDays: number[] = []
  let couplesWithDate = 0
  let couplesWithoutDate = 0

  for (const f of facts) {
    const weddingDate = f.couple.wedding_date
    if (!weddingDate) {
      couplesWithoutDate++
      continue
    }
    const weddingMs = Date.parse(weddingDate)
    if (!Number.isFinite(weddingMs)) {
      couplesWithoutDate++
      continue
    }
    couplesWithDate++

    const firstMs = Date.parse(f.firstTouchAt)
    if (!Number.isFinite(firstMs)) continue

    const days = (weddingMs - firstMs) / DAY_MS
    if (days > 0) leadDays.push(days)
  }

  const histogram = HISTOGRAM_BUCKETS.map((b) => ({
    bucket: b.label,
    count: 0,
  }))
  for (const d of leadDays) {
    const months = d / 30.44
    const idx = HISTOGRAM_BUCKETS.findIndex((b) => months <= b.maxMonths)
    histogram[idx === -1 ? histogram.length - 1 : idx].count++
  }

  return {
    dist: summarize(leadDays),
    histogram,
    couplesWithDate,
    couplesWithoutDate,
  }
}
