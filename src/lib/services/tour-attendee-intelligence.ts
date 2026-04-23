/**
 * Phase 4 Task 41 — Tour attendee intelligence signal.
 *
 * Hypothesis (from the checklist): the mix of attendees at a tour correlates
 * with booking likelihood. Couples bringing parents may book at a different
 * rate than couples bringing friends. This is a per-venue learning signal —
 * we do NOT pool across venues.
 *
 * Data dependency (per checklist): "do not build until 10+ tours with
 * attendee data exist" at the venue. The computer below returns a
 * null-signal result when the threshold is not met, so UI surfaces can
 * show a deliberate "not enough data yet" state rather than a spurious
 * number computed from two rows.
 *
 * tours.attendees is a jsonb array of strings (migration 075). Canonical
 * values we derive a named bucket for:
 *   - 'couple'         — the partners alone
 *   - 'parents'        — at least one parent
 *   - 'friends'        — at least one friend
 *   - 'family'         — sibling, relative, etc (not parents)
 *   - 'wedding_party'  — members of the wedding party
 * Anything else falls into 'other'.
 */

import { createServiceClient } from '@/lib/supabase/service'

export const MIN_TOURS_FOR_ATTENDEE_SIGNAL = 10

export interface AttendeeBucketStats {
  bucket: string
  toursWithBucket: number
  bookedFromBucket: number
  bookingRatePct: number
}

export interface TourAttendeeSignal {
  venueId: string
  totalTours: number
  bookedTours: number
  overallBookingRatePct: number
  buckets: AttendeeBucketStats[]
  /**
   * Top named insight when the best bucket's rate meaningfully exceeds the
   * overall rate. Null when under the data threshold or no clear outlier.
   */
  topInsight: string | null
}

const BUCKET_ORDER = ['couple', 'parents', 'family', 'friends', 'wedding_party', 'other'] as const

function classifyAttendee(raw: string): string {
  const a = raw.trim().toLowerCase()
  if (!a) return 'other'
  if (a === 'couple' || a === 'partners' || a === 'bride' || a === 'groom') return 'couple'
  if (/parent|mom|mum|dad|mother|father/.test(a)) return 'parents'
  if (/friend/.test(a)) return 'friends'
  if (/sibling|sister|brother|aunt|uncle|cousin|grandparent|family/.test(a)) return 'family'
  if (/wedding party|bridesmaid|groomsm|maid of honou?r|best man/.test(a)) return 'wedding_party'
  return 'other'
}

/**
 * Compute the attendee-type signal for a single venue. Returns a null-signal
 * (topInsight === null) when under the data threshold or no clear outlier.
 */
export async function computeTourAttendeeSignal(venueId: string): Promise<TourAttendeeSignal> {
  const supabase = createServiceClient()

  const { data: tours } = await supabase
    .from('tours')
    .select('id, outcome, attendees, scheduled_at')
    .eq('venue_id', venueId)
    .in('outcome', ['completed', 'booked', 'lost'])

  const rows = tours ?? []
  const totalTours = rows.length
  const bookedTours = rows.filter((t) => t.outcome === 'booked').length

  const bucketCounts: Record<string, { total: number; booked: number }> = {}
  for (const b of BUCKET_ORDER) bucketCounts[b] = { total: 0, booked: 0 }

  for (const t of rows) {
    const attendees = Array.isArray(t.attendees) ? (t.attendees as string[]) : []
    const tourBuckets = new Set<string>()
    for (const a of attendees) {
      if (typeof a === 'string') tourBuckets.add(classifyAttendee(a))
    }
    if (tourBuckets.size === 0) tourBuckets.add('other')
    const booked = t.outcome === 'booked'
    for (const bucket of tourBuckets) {
      bucketCounts[bucket].total++
      if (booked) bucketCounts[bucket].booked++
    }
  }

  const buckets: AttendeeBucketStats[] = BUCKET_ORDER.map((bucket) => {
    const { total, booked } = bucketCounts[bucket]
    const rate = total > 0 ? (booked / total) * 100 : 0
    return { bucket, toursWithBucket: total, bookedFromBucket: booked, bookingRatePct: rate }
  }).filter((b) => b.toursWithBucket > 0)

  const overallRate = totalTours > 0 ? (bookedTours / totalTours) * 100 : 0

  // Below threshold: return a valid shape but no named insight.
  if (totalTours < MIN_TOURS_FOR_ATTENDEE_SIGNAL) {
    return {
      venueId,
      totalTours,
      bookedTours,
      overallBookingRatePct: overallRate,
      buckets,
      topInsight: null,
    }
  }

  // Only name an insight when the best bucket with >= 5 supporting tours
  // materially beats the overall rate.
  const candidate = [...buckets]
    .filter((b) => b.toursWithBucket >= 5)
    .sort((a, b) => b.bookingRatePct - a.bookingRatePct)[0]

  let topInsight: string | null = null
  if (candidate && candidate.bookingRatePct >= overallRate + 10) {
    const pretty = {
      couple: 'Couples who toured alone',
      parents: 'Couples who brought parents',
      family: 'Couples who brought family',
      friends: 'Couples who brought friends',
      wedding_party: 'Couples who brought their wedding party',
      other: 'Couples with mixed attendees',
    }[candidate.bucket] ?? 'Couples in this group'
    topInsight = `${pretty} have booked at ${candidate.bookingRatePct.toFixed(0)}% vs an overall ${overallRate.toFixed(0)}% at your venue.`
  }

  return {
    venueId,
    totalTours,
    bookedTours,
    overallBookingRatePct: overallRate,
    buckets,
    topInsight,
  }
}
