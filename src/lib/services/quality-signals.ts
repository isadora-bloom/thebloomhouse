/**
 * Bloom House: Quality Signals (Phase 4 Tasks 40 + 42).
 *
 * - detectTwoEmailDropoffs: identifies weddings where the venue sent 2+
 *   outbound emails without any inbound reply. Writes "low engagement"
 *   flags into intelligence_insights so coordinators see them on
 *   /intel/insights.
 *
 * - computeAvailabilityPatterns: aggregates venue_availability over the
 *   next 12 months to surface seasonal fill-rate patterns ("Your
 *   September Saturdays are filling 3x faster than October Saturdays"
 *   per the Task 42 spec). Returns per-month fill data for the UI.
 */

import { createServiceClient } from '@/lib/supabase/service'

export interface DropoffRow {
  weddingId: string
  venueId: string
  outboundCount: number
  lastOutboundAt: string
  coupleLabel: string | null
}

export async function detectTwoEmailDropoffs(venueId: string): Promise<DropoffRow[]> {
  const supabase = createServiceClient()

  // Pull all interactions in the last 90 days for this venue, grouped
  // by wedding. Then filter to weddings with >=2 outbound and 0 inbound.
  const ninetyDaysAgo = new Date(Date.now() - 90 * 24 * 60 * 60 * 1000).toISOString()
  const { data: ints } = await supabase
    .from('interactions')
    .select('wedding_id, direction, timestamp')
    .eq('venue_id', venueId)
    .not('wedding_id', 'is', null)
    .gte('timestamp', ninetyDaysAgo)

  const perWedding: Record<string, { out: number; inCount: number; lastOut: string }> = {}
  for (const row of ints ?? []) {
    const wid = row.wedding_id as string
    if (!perWedding[wid]) perWedding[wid] = { out: 0, inCount: 0, lastOut: '' }
    const dir = (row.direction as string) ?? 'unknown'
    if (dir === 'outbound') {
      perWedding[wid].out++
      const t = row.timestamp as string
      if (!perWedding[wid].lastOut || t > perWedding[wid].lastOut) {
        perWedding[wid].lastOut = t
      }
    } else if (dir === 'inbound') {
      perWedding[wid].inCount++
    }
  }

  const dropoffIds = Object.entries(perWedding)
    .filter(([, v]) => v.out >= 2 && v.inCount === 0)
    .map(([id]) => id)

  if (dropoffIds.length === 0) return []

  // Hydrate with couple labels.
  const { data: weds } = await supabase
    .from('weddings')
    .select('id, venue_id, status, people(first_name, role)')
    .in('id', dropoffIds)

  const out: DropoffRow[] = []
  for (const w of weds ?? []) {
    // Skip weddings that already booked/lost — the signal is for live pipeline.
    const status = (w.status as string) ?? ''
    if (status === 'booked' || status === 'completed' || status === 'lost' || status === 'cancelled') {
      continue
    }
    const people = (w.people as Array<{ first_name: string | null; role: string | null }> | null) ?? []
    const p1 = people.find((p) => p.role === 'partner1')?.first_name ?? null
    out.push({
      weddingId: w.id as string,
      venueId: w.venue_id as string,
      outboundCount: perWedding[w.id as string].out,
      lastOutboundAt: perWedding[w.id as string].lastOut,
      coupleLabel: p1,
    })
  }
  return out
}

/**
 * Persist dropoffs as intelligence_insights rows so they surface in
 * /intel/insights alongside other signals. Idempotent: a second run
 * upserts on (venue_id, wedding_id, type='two_email_dropoff').
 */
export async function persistDropoffInsights(venueId: string): Promise<number> {
  const supabase = createServiceClient()
  const dropoffs = await detectTwoEmailDropoffs(venueId)
  let persisted = 0

  for (const d of dropoffs) {
    const { data: existing } = await supabase
      .from('intelligence_insights')
      .select('id')
      .eq('venue_id', venueId)
      .eq('insight_type', 'two_email_dropoff')
      .eq('context_id', d.weddingId)
      .maybeSingle()

    const payload = {
      venue_id: venueId,
      insight_type: 'two_email_dropoff',
      category: 'lead_conversion',
      title: d.coupleLabel
        ? `${d.coupleLabel} hasn't replied to ${d.outboundCount} emails`
        : `Lead stalled after ${d.outboundCount} outbound emails`,
      // Migration 041 canonical column is `body` (not `description`).
      body: "Couples who don't reply to 2+ follow-ups rarely book. Consider a final warm close or mark as lost.",
      priority: 'medium',
      context_id: d.weddingId,
      // Migration 041 canonical column is `data_points` (not `metadata`).
      data_points: {
        outbound_count: d.outboundCount,
        last_outbound_at: d.lastOutboundAt,
      },
    }
    if (existing) {
      const { error } = await supabase
        .from('intelligence_insights')
        .update(payload)
        .eq('id', existing.id)
      if (!error) persisted++
    } else {
      const { error } = await supabase.from('intelligence_insights').insert(payload)
      if (!error) persisted++
    }
  }
  return persisted
}

// ---------------------------------------------------------------------------
// Availability patterns (Task 42)
// ---------------------------------------------------------------------------

export interface MonthlyFillRate {
  month: string        // YYYY-MM
  totalSlots: number
  booked: number
  fillRatePct: number  // 0-100
}

export async function computeAvailabilityPatterns(venueId: string): Promise<{
  next12Months: MonthlyFillRate[]
  saturdaysNext12Months: MonthlyFillRate[]
}> {
  const supabase = createServiceClient()
  const today = new Date()
  const start = today.toISOString().split('T')[0]
  const end = new Date(today.getTime() + 365 * 24 * 60 * 60 * 1000).toISOString().split('T')[0]

  const { data: rows } = await supabase
    .from('venue_availability')
    .select('date, max_events, booked_count')
    .eq('venue_id', venueId)
    .gte('date', start)
    .lte('date', end)

  const all: Record<string, { slots: number; booked: number }> = {}
  const saturdaysOnly: Record<string, { slots: number; booked: number }> = {}

  for (const r of rows ?? []) {
    const date = new Date(`${r.date}T00:00:00`)
    const key = `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}`
    const slots = Number(r.max_events) || 0
    const booked = Number(r.booked_count) || 0
    if (!all[key]) all[key] = { slots: 0, booked: 0 }
    all[key].slots += slots
    all[key].booked += booked

    // Saturdays (day 6). Where wedding demand clusters.
    if (date.getDay() === 6) {
      if (!saturdaysOnly[key]) saturdaysOnly[key] = { slots: 0, booked: 0 }
      saturdaysOnly[key].slots += slots
      saturdaysOnly[key].booked += booked
    }
  }

  const mapToArray = (src: Record<string, { slots: number; booked: number }>): MonthlyFillRate[] =>
    Object.entries(src)
      .sort((a, b) => a[0].localeCompare(b[0]))
      .map(([month, v]) => ({
        month,
        totalSlots: v.slots,
        booked: v.booked,
        fillRatePct: v.slots > 0 ? (v.booked / v.slots) * 100 : 0,
      }))

  return {
    next12Months: mapToArray(all),
    saturdaysNext12Months: mapToArray(saturdaysOnly),
  }
}

/**
 * Derive the headline insight string for availability patterns, per
 * Task 42 spec: "Your {HighMonth} Saturdays are filling {ratio}x faster
 * than {LowMonth} Saturdays."
 *
 * Rules:
 *  - Only considers months with >= 10 Saturday slots (avoids noise from
 *    sparsely configured months).
 *  - Returns null unless highest fill rate is >= 2x the lowest AND the
 *    highest itself is >= 40%. Anything less isn't a publishable signal.
 *  - Month names rendered via toLocaleString — no hardcoding.
 */
export function deriveTopAvailabilityInsight(patterns: {
  saturdaysNext12Months: MonthlyFillRate[]
}): string | null {
  const eligible = (patterns.saturdaysNext12Months ?? []).filter(
    (m) => m.totalSlots >= 10
  )
  if (eligible.length < 2) return null

  const highest = [...eligible].sort((a, b) => b.fillRatePct - a.fillRatePct)[0]
  const lowest = [...eligible].sort((a, b) => a.fillRatePct - b.fillRatePct)[0]

  if (!highest || !lowest || highest.month === lowest.month) return null
  if (highest.fillRatePct < 40) return null
  if (lowest.fillRatePct <= 0) {
    // Can't compute a ratio vs zero. Fall through silently.
    return null
  }

  const ratio = highest.fillRatePct / lowest.fillRatePct
  if (ratio < 2) return null

  const [hYear, hMonth] = highest.month.split('-').map(Number)
  const [lYear, lMonth] = lowest.month.split('-').map(Number)
  const highName = new Date(hYear, hMonth - 1, 1).toLocaleString('en-US', {
    month: 'long',
  })
  const lowName = new Date(lYear, lMonth - 1, 1).toLocaleString('en-US', {
    month: 'long',
  })

  // Round ratio to a clean display (1 decimal unless whole number).
  const displayRatio =
    Math.abs(ratio - Math.round(ratio)) < 0.05
      ? String(Math.round(ratio))
      : ratio.toFixed(1)

  return `Your ${highName} Saturdays are filling ${displayRatio}x faster than ${lowName} Saturdays.`
}
