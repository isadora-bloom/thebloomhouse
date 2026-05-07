/**
 * Bloom House: venue_health compute.
 *
 * Phase 4 Task 38. venue_health was schema-only with zero writers (the UI
 * at /intel/health rendered an empty state regardless of activity). This
 * service computes a 0-100 score per venue and persists it on a
 * schedule; the cron endpoint fires it weekly.
 *
 * Score composition (weights sum to 1.0):
 *   - inquiry_volume_trend     0.15  (rolling 30d vs prior 30d)
 *   - response_time_trend      0.15  (weddings.first_response_at lag)
 *   - tour_conversion_rate     0.20  (tours.outcome='booked' / all conducted)
 *   - booking_rate             0.20  (booked / total inquiries in window)
 *   - avg_revenue              0.10  (vs organisation or platform baseline)
 *   - review_score_trend       0.10  (reviews.rating rolling 90d)
 *   - availability_fill_rate   0.10  (Phase 2 venue_availability: ratio of
 *                                    booked_count / max_events per date over
 *                                    the next 12 months)
 *
 * Writes venue_health (latest snapshot) + a new venue_health_history row
 * so the /intel/health trend line has data.
 *
 * Multi-venue: every compute is scoped to a single venueId. Org/group
 * rollups are a read-time concern, handled by the /intel/health page.
 */

import { createServiceClient } from '@/lib/supabase/service'

interface SubScores {
  inquiry_volume_trend: number
  response_time_trend: number
  tour_conversion_rate: number
  booking_rate: number
  avg_revenue: number
  review_score_trend: number
  availability_fill_rate: number
}

const WEIGHTS: SubScores = {
  inquiry_volume_trend: 0.15,
  response_time_trend: 0.15,
  tour_conversion_rate: 0.20,
  booking_rate: 0.20,
  avg_revenue: 0.10,
  review_score_trend: 0.10,
  availability_fill_rate: 0.10,
}

export interface VenueHealthSnapshot {
  venueId: string
  overallScore: number
  subScores: SubScores
  calculatedAt: string
}

function clamp(n: number, min = 0, max = 100): number {
  if (!Number.isFinite(n)) return min
  return Math.max(min, Math.min(max, n))
}

/**
 * Compute the latest health snapshot for a single venue. Does NOT
 * persist — use `persistVenueHealthSnapshot` for that.
 */
export async function computeVenueHealth(venueId: string): Promise<VenueHealthSnapshot> {
  const supabase = createServiceClient()
  const now = new Date()
  const nowIso = now.toISOString()
  const thirtyDaysAgo = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000).toISOString()
  const sixtyDaysAgo = new Date(now.getTime() - 60 * 24 * 60 * 60 * 1000).toISOString()
  const ninetyDaysAgo = new Date(now.getTime() - 90 * 24 * 60 * 60 * 1000).toISOString()

  // ---- Inquiry volume trend ---------------------------------------------
  const { count: inquiries30 } = await supabase
    .from('weddings')
    .select('id', { count: 'exact', head: true })
    .eq('venue_id', venueId)
    .gte('inquiry_date', thirtyDaysAgo)
  const { count: inquiriesPrev30 } = await supabase
    .from('weddings')
    .select('id', { count: 'exact', head: true })
    .eq('venue_id', venueId)
    .gte('inquiry_date', sixtyDaysAgo)
    .lt('inquiry_date', thirtyDaysAgo)
  const volumeTrend = scoreTrend(inquiries30 ?? 0, inquiriesPrev30 ?? 0)

  // ---- Response time trend ----------------------------------------------
  const { data: responses } = await supabase
    .from('weddings')
    .select('inquiry_date, first_response_at')
    .eq('venue_id', venueId)
    .not('first_response_at', 'is', null)
    .gte('inquiry_date', thirtyDaysAgo)
  const responseMinutes: number[] = []
  for (const r of responses ?? []) {
    if (!r.inquiry_date || !r.first_response_at) continue
    const lag = (new Date(r.first_response_at as string).getTime() - new Date(r.inquiry_date as string).getTime()) / 60000
    if (lag >= 0 && lag < 48 * 60) responseMinutes.push(lag)
  }
  const avgResponse = responseMinutes.length > 0
    ? responseMinutes.reduce((a, b) => a + b, 0) / responseMinutes.length
    : null
  // Score: under 60m = 100, under 4h = 80, under 24h = 50, else 20
  let responseScore = 50
  if (avgResponse === null) responseScore = 50
  else if (avgResponse < 60) responseScore = 100
  else if (avgResponse < 240) responseScore = 80
  else if (avgResponse < 1440) responseScore = 50
  else responseScore = 20

  // ---- Tour conversion rate ---------------------------------------------
  const { count: toursConducted } = await supabase
    .from('tours')
    .select('id', { count: 'exact', head: true })
    .eq('venue_id', venueId)
    .in('outcome', ['completed', 'booked', 'lost'])
    .gte('scheduled_at', ninetyDaysAgo)
  const { count: toursBooked } = await supabase
    .from('tours')
    .select('id', { count: 'exact', head: true })
    .eq('venue_id', venueId)
    .eq('outcome', 'booked')
    .gte('scheduled_at', ninetyDaysAgo)
  const tourConv = (toursConducted ?? 0) > 0
    ? ((toursBooked ?? 0) / (toursConducted ?? 1)) * 100
    : 50 // neutral when no tours
  const tourConvScore = clamp(tourConv * 1.5) // 66%+ conversion = 100

  // ---- Booking rate -----------------------------------------------------
  const { count: totalInquiries90 } = await supabase
    .from('weddings')
    .select('id', { count: 'exact', head: true })
    .eq('venue_id', venueId)
    .gte('inquiry_date', ninetyDaysAgo)
  const { count: booked90 } = await supabase
    .from('weddings')
    .select('id', { count: 'exact', head: true })
    .eq('venue_id', venueId)
    .in('status', ['booked', 'completed'])
    .gte('inquiry_date', ninetyDaysAgo)
  const bookingRate = (totalInquiries90 ?? 0) > 0
    ? ((booked90 ?? 0) / (totalInquiries90 ?? 1)) * 100
    : 50
  const bookingRateScore = clamp(bookingRate * 5) // 20%+ = 100

  // ---- Avg revenue vs org baseline --------------------------------------
  const { data: revRow } = await supabase
    .from('weddings')
    .select('booking_value')
    .eq('venue_id', venueId)
    .in('status', ['booked', 'completed'])
    .gte('booked_at', ninetyDaysAgo)
  const venueRev = (revRow ?? [])
    .map((r) => Number(r.booking_value) || 0)
    .filter((n) => n > 0)
  const venueAvgRev = venueRev.length > 0
    ? venueRev.reduce((a, b) => a + b, 0) / venueRev.length
    : 0
  // Without a known baseline, fall back to comparing against 18k (rough
  // industry median). Customers with different price points get
  // normalised naturally since THEIR history is the baseline over time.
  const revScore = venueAvgRev > 0 ? clamp((venueAvgRev / 18000) * 60) : 50

  // ---- Review score trend -----------------------------------------------
  const { data: reviews } = await supabase
    .from('reviews')
    .select('rating, review_date')
    .eq('venue_id', venueId)
    .gte('review_date', ninetyDaysAgo.split('T')[0])
  const ratings = (reviews ?? [])
    .map((r) => Number(r.rating) || 0)
    .filter((n) => n > 0 && n <= 5)
  const avgRating = ratings.length > 0
    ? ratings.reduce((a, b) => a + b, 0) / ratings.length
    : 0
  const reviewScore = avgRating > 0 ? clamp((avgRating / 5) * 100) : 50

  // ---- Availability fill rate -------------------------------------------
  const nextYear = new Date(now.getTime() + 365 * 24 * 60 * 60 * 1000)
    .toISOString()
    .split('T')[0]
  const today = now.toISOString().split('T')[0]
  const { data: avail } = await supabase
    .from('venue_availability')
    .select('max_events, booked_count')
    .eq('venue_id', venueId)
    .gte('date', today)
    .lte('date', nextYear)
  const totalSlots = (avail ?? []).reduce((s, r) => s + (Number(r.max_events) || 0), 0)
  const totalBooked = (avail ?? []).reduce((s, r) => s + (Number(r.booked_count) || 0), 0)
  const fillRate = totalSlots > 0 ? (totalBooked / totalSlots) * 100 : 0
  // Score: 0% = 0, 40% = 100. Above 40% = 100 (overbooked is a concern
  // for capacity planning but reflects operational strength here).
  const fillScore = clamp((fillRate / 40) * 100)

  const subScores: SubScores = {
    inquiry_volume_trend: volumeTrend,
    response_time_trend: responseScore,
    tour_conversion_rate: tourConvScore,
    booking_rate: bookingRateScore,
    avg_revenue: revScore,
    review_score_trend: reviewScore,
    availability_fill_rate: fillScore,
  }

  const overallScore = Math.round(
    subScores.inquiry_volume_trend * WEIGHTS.inquiry_volume_trend +
      subScores.response_time_trend * WEIGHTS.response_time_trend +
      subScores.tour_conversion_rate * WEIGHTS.tour_conversion_rate +
      subScores.booking_rate * WEIGHTS.booking_rate +
      subScores.avg_revenue * WEIGHTS.avg_revenue +
      subScores.review_score_trend * WEIGHTS.review_score_trend +
      subScores.availability_fill_rate * WEIGHTS.availability_fill_rate
  )

  return {
    venueId,
    overallScore: clamp(overallScore),
    subScores,
    calculatedAt: nowIso,
  }
}

function scoreTrend(current: number, prior: number): number {
  if (prior === 0 && current === 0) return 50
  if (prior === 0) return 100 // starting from zero is improvement by default
  const ratio = current / prior
  // 0.5 ratio = 0, 1.0 ratio = 50, 1.5 ratio = 100.
  return clamp(((ratio - 0.5) / 1.0) * 100)
}

/**
 * Compute AND persist. Upserts the venue_health row (one per venue) and
 * appends to venue_health_history so the trend line has data.
 */
export async function persistVenueHealthSnapshot(venueId: string): Promise<VenueHealthSnapshot> {
  const supabase = createServiceClient()
  const snapshot = await computeVenueHealth(venueId)

  // Persist the snapshot. venue_health keeps the latest row per venue;
  // downstream reads use ORDER BY calculated_at DESC LIMIT 1. Migration 080
  // extended venue_health with the 5 Phase 4 subscore columns so the full
  // 7-dimension picture is now round-trippable.
  await supabase.from('venue_health').insert({
    venue_id: venueId,
    calculated_at: snapshot.calculatedAt,
    overall_score: snapshot.overallScore,
    // Legacy columns retained for backwards compatibility with /intel/health
    // which renders a 4-card breakdown using these names.
    data_quality_score: snapshot.subScores.inquiry_volume_trend,
    pipeline_score: snapshot.subScores.booking_rate,
    response_time_score: snapshot.subScores.response_time_trend,
    booking_rate_score: snapshot.subScores.booking_rate,
    // Phase 4 subscores (migration 080).
    inquiry_volume_trend: snapshot.subScores.inquiry_volume_trend,
    tour_conversion_rate: snapshot.subScores.tour_conversion_rate,
    avg_revenue_score: snapshot.subScores.avg_revenue,
    review_score_trend: snapshot.subScores.review_score_trend,
    availability_fill_rate: snapshot.subScores.availability_fill_rate,
  })

  // History row (migration 080 created the table). The /intel/health trend
  // line and /intel/benchmark rollup both read from here.
  await supabase.from('venue_health_history').insert({
    venue_id: venueId,
    calculated_at: snapshot.calculatedAt,
    overall_score: snapshot.overallScore,
    inquiry_volume_trend: snapshot.subScores.inquiry_volume_trend,
    response_time_trend: snapshot.subScores.response_time_trend,
    tour_conversion_rate: snapshot.subScores.tour_conversion_rate,
    booking_rate: snapshot.subScores.booking_rate,
    avg_revenue_score: snapshot.subScores.avg_revenue,
    review_score_trend: snapshot.subScores.review_score_trend,
    availability_fill_rate: snapshot.subScores.availability_fill_rate,
  })

  return snapshot
}

/**
 * Batch compute for every venue in an org, or every venue system-wide
 * (when called from the cron). Returns the list of snapshots computed.
 */
export async function computeAllVenueHealth(): Promise<VenueHealthSnapshot[]> {
  const supabase = createServiceClient()
  const { data: venues } = await supabase
    .from('venues')
    .select('id')
    .eq('status', 'active')
  const out: VenueHealthSnapshot[] = []
  for (const v of venues ?? []) {
    try {
      const snap = await persistVenueHealthSnapshot(v.id as string)
      out.push(snap)
    } catch (err) {
      console.error(`[venue-health] compute failed for ${v.id}:`, err)
    }
  }
  return out
}
