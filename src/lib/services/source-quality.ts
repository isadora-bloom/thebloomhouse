/**
 * Bloom House: Source Quality Scorecard (Phase 4 Task 39).
 *
 * For each source the venue has seen, computes:
 *   - avgRevenue        (of booked weddings)
 *   - avgEmailsExchanged (count of interactions linked to booked weddings)
 *   - avgPortalActivity  (engagement_events count post-booking)
 *   - avgReviewScore    (if reviews exist for couples from that source)
 *   - referralCount     (weddings with referred_by populated, per source)
 *   - frictionRate      (weddings with non-empty friction_tags / total)
 *
 * Returns one row per source. All metrics are scoped to the venueId
 * passed in — cross-venue aggregation is a read-time responsibility for
 * the /intel/sources page.
 */

import { createServiceClient } from '@/lib/supabase/service'

export interface SourceQualityRow {
  source: string
  bookedCount: number
  avgRevenue: number
  avgEmailsExchanged: number
  avgPortalActivity: number
  avgReviewScore: number | null
  referralCount: number
  frictionRate: number
}

export async function computeSourceQuality(venueId: string): Promise<SourceQualityRow[]> {
  const supabase = createServiceClient()
  const { data: weddings } = await supabase
    .from('weddings')
    .select('id, source, booking_value, friction_tags, referred_by, status')
    .eq('venue_id', venueId)
    .not('source', 'is', null)

  const bySource: Record<string, {
    ids: string[]
    revenues: number[]
    frictionHits: number
    referralHits: number
  }> = {}

  for (const w of weddings ?? []) {
    const src = (w.source as string) ?? 'unknown'
    const status = (w.status as string) ?? ''
    const booked = status === 'booked' || status === 'completed'
    if (!booked) continue

    if (!bySource[src]) bySource[src] = { ids: [], revenues: [], frictionHits: 0, referralHits: 0 }
    bySource[src].ids.push(w.id as string)
    if (w.booking_value) bySource[src].revenues.push(Number(w.booking_value))

    const ft = w.friction_tags
    if (Array.isArray(ft) && ft.length > 0) bySource[src].frictionHits++
    if (w.referred_by) bySource[src].referralHits++
  }

  const results: SourceQualityRow[] = []
  for (const [source, data] of Object.entries(bySource)) {
    const bookedCount = data.ids.length
    if (bookedCount === 0) continue

    const avgRevenue = data.revenues.length > 0
      ? data.revenues.reduce((a, b) => a + b, 0) / data.revenues.length
      : 0

    // Emails exchanged: total interactions across all weddings from this
    // source, divided by count.
    const { count: interactionCount } = await supabase
      .from('interactions')
      .select('id', { count: 'exact', head: true })
      .in('wedding_id', data.ids)
    const avgEmailsExchanged = bookedCount > 0 ? (interactionCount ?? 0) / bookedCount : 0

    // Portal activity: engagement events.
    const { count: eventCount } = await supabase
      .from('engagement_events')
      .select('id', { count: 'exact', head: true })
      .in('wedding_id', data.ids)
    const avgPortalActivity = bookedCount > 0 ? (eventCount ?? 0) / bookedCount : 0

    // Review score: match reviewer name to partner1/partner2 of these
    // weddings. Approximate — fuzzy name matching is good-enough for the
    // scorecard, not precise enough for per-wedding attribution.
    const { data: people } = await supabase
      .from('people')
      .select('first_name, last_name')
      .in('wedding_id', data.ids)
      .in('role', ['partner1', 'partner2'])
    const names = new Set(
      (people ?? [])
        .map((p) => [p.first_name, p.last_name].filter(Boolean).join(' ').toLowerCase().trim())
        .filter((s) => s.length > 0)
    )
    let avgReviewScore: number | null = null
    if (names.size > 0) {
      const { data: reviews } = await supabase
        .from('reviews')
        .select('rating, reviewer_name')
        .eq('venue_id', venueId)
        .not('reviewer_name', 'is', null)
      const matchedRatings = (reviews ?? [])
        .filter((r) => {
          const reviewer = (r.reviewer_name as string).toLowerCase().trim()
          for (const name of names) {
            if (name.length >= 3 && reviewer.includes(name)) return true
          }
          return false
        })
        .map((r) => Number(r.rating) || 0)
        .filter((n) => n > 0 && n <= 5)
      if (matchedRatings.length > 0) {
        avgReviewScore = matchedRatings.reduce((a, b) => a + b, 0) / matchedRatings.length
      }
    }

    results.push({
      source,
      bookedCount,
      avgRevenue,
      avgEmailsExchanged,
      avgPortalActivity,
      avgReviewScore,
      referralCount: data.referralHits,
      frictionRate: bookedCount > 0 ? data.frictionHits / bookedCount : 0,
    })
  }

  return results.sort((a, b) => b.bookedCount - a.bookedCount)
}
