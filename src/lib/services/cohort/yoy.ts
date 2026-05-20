/**
 * D9 — year-over-year inquiry volume (battery Q12).
 *
 * Q12: "Were June inquiries up year-over-year, controlling for
 * marketing spend?" We give the operator the two halves of that
 * question side by side — *distinct new inquiries per calendar month*
 * this year vs last year, with the marketing spend for the same months
 * alongside. We do not attempt the regression; we surface the confound
 * so the operator (or Sage) can reason about it honestly.
 *
 * Honesty fix (2026-05-19): the first pass counted inbound *touch-
 * points* per month, so a single couple emailing five times moved the
 * chart by five and the re-import landed +2000% on April. Now we count
 * each couple once, in the month of its earliest inbound touchpoint.
 *
 * "This year" is anchored to the most recent inbound, not the wall
 * clock — a venue mid-import or paused should still get a meaningful
 * comparison.
 */

import type { SupabaseClient } from '@supabase/supabase-js'
import type { CohortData, YoYResult } from './types'
import type { CoupleFacts } from './facts'
import { MONTH_LABEL, ratio, zonedParts } from './helpers'

function key(year: number, month: number): string {
  return `${year}-${month}`
}

export async function computeYoY(
  data: CohortData,
  facts: CoupleFacts[],
  supabase: SupabaseClient,
): Promise<YoYResult> {
  // Distinct new inquiries per (year, month) = couples whose earliest
  // inbound touchpoint fell in that month.
  const counts = new Map<string, number>()
  let maxYear = 0
  for (const f of facts) {
    if (!f.firstInboundAt) continue
    const p = zonedParts(f.firstInboundAt, data.timezone)
    if (!p) continue
    counts.set(key(p.year, p.month), (counts.get(key(p.year, p.month)) ?? 0) + 1)
    if (p.year > maxYear) maxYear = p.year
  }
  const thisYear = maxYear || new Date().getUTCFullYear()
  const lastYear = thisYear - 1

  // Marketing spend by (year, month), cents. Prefer the modern
  // per-record table; fall back to the legacy monthly-rollup table.
  const spend = new Map<string, number>()
  let marketingSpendAvailable = false
  let marketingNote = ''

  try {
    const { data: records } = await supabase
      .from('marketing_spend_records')
      .select('spend_date, amount_cents')
      .eq('venue_id', data.venueId)
      .gte('spend_date', `${lastYear}-01-01`)
      .lte('spend_date', `${thisYear}-12-31`)
    if (records && records.length > 0) {
      for (const r of records) {
        const d = zonedParts(`${r.spend_date}T12:00:00Z`, data.timezone)
        if (!d) continue
        const cents = Number(r.amount_cents) || 0
        spend.set(key(d.year, d.month), (spend.get(key(d.year, d.month)) ?? 0) + cents)
      }
      marketingSpendAvailable = true
      marketingNote = 'Marketing spend from connected spend records.'
    }
  } catch {
    // table absent or unreadable — fall through to legacy
  }

  if (!marketingSpendAvailable) {
    try {
      const { data: legacy } = await supabase
        .from('marketing_spend')
        .select('month, amount')
        .eq('venue_id', data.venueId)
        .gte('month', `${lastYear}-01-01`)
        .lte('month', `${thisYear}-12-31`)
      if (legacy && legacy.length > 0) {
        for (const r of legacy) {
          const d = zonedParts(`${r.month}T12:00:00Z`, data.timezone)
          if (!d) continue
          const cents = Math.round((Number(r.amount) || 0) * 100)
          spend.set(key(d.year, d.month), (spend.get(key(d.year, d.month)) ?? 0) + cents)
        }
        marketingSpendAvailable = true
        marketingNote = 'Marketing spend from the legacy monthly spend log.'
      }
    } catch {
      // ignore
    }
  }

  if (!marketingSpendAvailable) {
    marketingNote =
      'No marketing spend recorded for this venue — the YoY change ' +
      'cannot yet be controlled for ad spend. Add spend at ' +
      '/intel/marketing-spend to close the confound.'
  }

  const monthly = Array.from({ length: 12 }, (_, i) => {
    const month = i + 1
    const ty = counts.get(key(thisYear, month)) ?? 0
    const ly = counts.get(key(lastYear, month)) ?? 0
    const deltaRatio = ratio(ty - ly, ly)
    return {
      month,
      label: MONTH_LABEL[month],
      thisYear: ty,
      lastYear: ly,
      deltaPct: deltaRatio === null ? null : Math.round(deltaRatio * 100),
      thisYearSpendCents: marketingSpendAvailable
        ? (spend.get(key(thisYear, month)) ?? 0)
        : null,
      lastYearSpendCents: marketingSpendAvailable
        ? (spend.get(key(lastYear, month)) ?? 0)
        : null,
    }
  })

  return {
    thisYearLabel: thisYear,
    lastYearLabel: lastYear,
    monthly,
    marketingSpendAvailable,
    marketingNote,
  }
}
