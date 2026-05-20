/**
 * D8 source-quality scorecard - Tier 8 T8.2 remaining.
 *
 * Per-channel scorecard combining the three intel sources that already
 * read the spine: D3 attribution (volume + conversion + CAC), D9 cohort
 * (response time + booking lead time + heat), match precision (rejected
 * vs confirmed merges per channel).
 *
 * Each channel gets one row with:
 *   - volume         couples acquired (first-touch attribution)
 *   - booked         couples that booked (first-touch credit)
 *   - bookingRate    booked / volume
 *   - medianResponse hours from first messageable inbound to first reply,
 *                    for couples whose acquisition channel = this channel
 *   - medianHeat     median heat across couples acquired through this channel
 *   - matchPrecision share of candidate_matches from this channel that
 *                    the operator CONFIRMED (vs rejected). null when n=0.
 *
 * Honesty (§C.6 Tier 4): every cell carries its own n, rates use safe
 * ratios, and the surface gates each cell on its own MIN_QUALITY_N.
 *
 * Multi-venue safe. No Rixey-specific clauses.
 */

import type { SupabaseClient } from '@supabase/supabase-js'
import type { CohortData } from './types'
import { ENGAGED_STATES } from './types'
import { buildCoupleFacts } from './facts'
import { isOutbound } from './direction'

const MIN_QUALITY_N = 8

const PLUMBING_CHANNELS = new Set(['gmail', 'sms', 'calendly', 'honeybook'])
function isAcquisition(channel: string): boolean {
  return !PLUMBING_CHANNELS.has(channel)
}

export interface SourceQualityRow {
  channel: string
  isAcquisition: boolean
  volume: number
  booked: number
  bookingRate: number | null
  medianResponseHours: number | null
  responseN: number
  medianHeat: number | null
  heatN: number
  matchPrecision: number | null
  matchN: number
  enoughDataForBookingRate: boolean
  enoughDataForResponse: boolean
  enoughDataForHeat: boolean
  enoughDataForPrecision: boolean
}

export interface SourceQualityReport {
  generatedAt: string
  rows: SourceQualityRow[]
  /** How many couples have no first-touch (no acquisition-class touch).
   *  These get bucketed under '(unknown_acquisition)' rather than
   *  leaking credit to plumbing — same doctrine as D3. */
  couplesWithoutAcquisitionTouch: number
}

function median(values: number[]): number | null {
  if (values.length === 0) return null
  const sorted = values.slice().sort((a, b) => a - b)
  if (sorted.length === 1) return sorted[0]
  const mid = sorted.length / 2
  if (Number.isInteger(mid)) {
    return (sorted[mid - 1] + sorted[mid]) / 2
  }
  return sorted[Math.floor(mid)]
}

function ratio(num: number, denom: number): number | null {
  if (denom <= 0) return null
  return num / denom
}

interface CandidateMatchRow {
  resolution: string | null
  matcher_reason: string | null
  primary_record_type: string
  secondary_record_type: string
}

export async function buildSourceQualityReport(
  supabase: SupabaseClient,
  venueId: string,
  data: CohortData,
): Promise<SourceQualityReport> {
  const facts = buildCoupleFacts(data)

  // ---- Per-couple first-touch acquisition channel ------------------------
  // First-touch = earliest acquisition-class inbound touchpoint per couple.
  const firstTouchByCouple = new Map<string, string>()
  for (const couple of data.couples) {
    if (!(ENGAGED_STATES as readonly string[]).includes(couple.lifecycle_state)) continue
    const tps = data.byCouple.get(couple.id) ?? []
    const acq = tps.find((tp) => !isOutbound(tp) && isAcquisition(tp.channel))
    firstTouchByCouple.set(couple.id, acq?.channel ?? '(unknown_acquisition)')
  }

  // ---- Match precision per channel ---------------------------------------
  // Read candidate_matches grouped by the channel of the secondary record
  // (the fragment / touchpoint side). When secondary is a couple, we
  // can't infer channel; skip those for the precision metric.
  const matchByChannel = new Map<string, { confirmed: number; rejected: number }>()
  try {
    const { data: matches } = await supabase
      .from('candidate_matches')
      .select('resolution, matcher_reason, primary_record_type, secondary_record_type')
      .eq('venue_id', venueId)
      .in('resolution', ['confirmed', 'rejected'])
      .limit(5000)
    for (const m of (matches ?? []) as CandidateMatchRow[]) {
      // Match-precision is broken out by channel via the matcher_reason
      // text which carries the channel name (e.g. "knot fragment matches
      // ..."). When parseable, attribute; otherwise skip.
      const reason = (m.matcher_reason ?? '').toLowerCase()
      const channelMatch = reason.match(/\b(knot|instagram|gmail|calendly|honeybook|sms|web|weddingwire|pinterest|tiktok)\b/)
      if (!channelMatch) continue
      const ch = channelMatch[1]
      const entry = matchByChannel.get(ch) ?? { confirmed: 0, rejected: 0 }
      if (m.resolution === 'confirmed') entry.confirmed += 1
      else if (m.resolution === 'rejected') entry.rejected += 1
      matchByChannel.set(ch, entry)
    }
  } catch {
    // Best-effort.
  }

  // ---- Build per-channel rollups -----------------------------------------
  type Bucket = {
    volume: number
    booked: number
    responseHours: number[]
    heat: number[]
  }
  const buckets = new Map<string, Bucket>()
  let couplesWithoutAcquisitionTouch = 0

  for (const f of facts) {
    const channel = firstTouchByCouple.get(f.couple.id) ?? '(unknown_acquisition)'
    if (channel === '(unknown_acquisition)') {
      couplesWithoutAcquisitionTouch += 1
    }
    const b = buckets.get(channel) ?? {
      volume: 0,
      booked: 0,
      responseHours: [],
      heat: [],
    }
    b.volume += 1
    if (f.booked) b.booked += 1
    if (f.responseHours !== null) b.responseHours.push(f.responseHours)
    if (
      f.couple.heat_score !== null &&
      Number.isFinite(f.couple.heat_score) &&
      Number(f.couple.heat_score) > 0
    ) {
      b.heat.push(Number(f.couple.heat_score))
    }
    buckets.set(channel, b)
  }

  const rows: SourceQualityRow[] = []
  for (const [channel, b] of buckets) {
    const mp = matchByChannel.get(channel)
    const matchN = mp ? mp.confirmed + mp.rejected : 0
    const matchPrecision = mp && matchN > 0 ? mp.confirmed / matchN : null
    const medianResponseHours = median(b.responseHours)
    const medianHeat = median(b.heat)
    const bookingRate = ratio(b.booked, b.volume)

    rows.push({
      channel,
      isAcquisition: channel !== '(unknown_acquisition)' && isAcquisition(channel),
      volume: b.volume,
      booked: b.booked,
      bookingRate,
      medianResponseHours,
      responseN: b.responseHours.length,
      medianHeat,
      heatN: b.heat.length,
      matchPrecision,
      matchN,
      enoughDataForBookingRate: b.volume >= MIN_QUALITY_N,
      enoughDataForResponse: b.responseHours.length >= MIN_QUALITY_N,
      enoughDataForHeat: b.heat.length >= MIN_QUALITY_N,
      enoughDataForPrecision: matchN >= MIN_QUALITY_N,
    })
  }

  // Sort: acquisition first, then by volume desc.
  rows.sort((a, b) => {
    if (a.isAcquisition !== b.isAcquisition) return a.isAcquisition ? -1 : 1
    return b.volume - a.volume
  })

  return {
    generatedAt: new Date().toISOString(),
    rows,
    couplesWithoutAcquisitionTouch,
  }
}
