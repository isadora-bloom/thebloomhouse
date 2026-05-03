/**
 * Post-tour browsing intelligence — find leads still researching
 * after their tour.
 *
 * T5-Rixey-GGG Bug 22 rewrite: the predicate is now POST-TOUR, not
 * POST-INQUIRY. Pre-fix, the query filtered tangential_signals by
 * `signal_date > inquiry_date` — but inquiry happens BEFORE the tour,
 * so a Knot save between inquiry and tour qualified even though it's
 * part of the BUILD-UP to the tour, not "still considering after". The
 * dashboard card promised "still considering after the tour" but was
 * surfacing mostly pre-tour research (5 of 6 visible rows).
 *
 * Post-fix, a wedding qualifies only when:
 *   1. There is at least one tour with outcome='completed' (the tour
 *      genuinely happened — pending/cancelled/no_show don't qualify).
 *      Tours with NULL scheduled_at are excluded; they don't have a
 *      trustworthy temporal anchor.
 *   2. There is at least one tangential_signal whose signal_date is
 *      AFTER the latest completed tour's scheduled_at + duration.
 *
 * Returns up to N leads ordered by most-recent post-tour signal date.
 *
 * NOTE: depends on Bug 12 (tour_outcome_classifier) being correct so
 * that `outcome='completed'` actually reflects past-due tours that
 * happened. Without the classifier this query will be empty until a
 * coordinator manually flips tours.outcome via the UI.
 */

import type { SupabaseClient } from '@supabase/supabase-js'
import { dedupePeopleByName } from '@/lib/utils/couple-name'

/**
 * Default tour duration assumption. Mirrors
 * tour-outcome-classifier.DEFAULT_TOUR_DURATION_MIN. We add this to
 * scheduled_at when computing "after the tour" so a signal fired
 * during the tour (e.g. a partner browsing while waiting in the car)
 * doesn't register as "post-tour" — the threshold is when the tour
 * SHOULD have ended.
 */
const TOUR_DURATION_MIN = 90

export interface PostTourBrowsingLead {
  wedding_id: string
  couple_name: string
  /** scheduled_at of the latest completed tour. Renderable as the
   *  "Toured X" label — never null because the predicate requires a
   *  completed tour with a scheduled_at. */
  tour_date: string
  inquiry_date: string | null
  status: string | null
  /** Most recent POST-tour signal across all platforms. Always
   *  greater than tour_date by definition of the predicate. */
  latest_signal_date: string
  /** All distinct platforms the couple has signaled on post-tour. */
  platforms: string[]
  /** Total count of post-tour signals. */
  signal_count: number
}

export async function getPostTourBrowsingLeads(
  sb: SupabaseClient,
  venueId: string,
  limit = 25,
): Promise<PostTourBrowsingLead[]> {
  // Step 1: pull every COMPLETED tour at the venue with a non-null
  // scheduled_at. The post-tour predicate requires a real temporal
  // anchor — pending/cancelled/no_show don't qualify, and a tour with
  // NULL scheduled_at can't be compared chronologically.
  //
  // T5-Rixey-GGG Bug 22: this depends on tour_outcome_classifier (Bug
  // 12) flipping past-due pending → completed. Without the classifier
  // the venue's pending-tour backlog won't be reachable here.
  const { data: tours } = await sb
    .from('tours')
    .select('wedding_id, scheduled_at')
    .eq('venue_id', venueId)
    .eq('outcome', 'completed')
    .not('scheduled_at', 'is', null)
    .not('wedding_id', 'is', null)

  const tourRows = (tours ?? []) as Array<{ wedding_id: string; scheduled_at: string }>
  if (tourRows.length === 0) return []

  // Pick the LATEST completed tour per wedding — that's the temporal
  // anchor for "after the tour". Multiple tours per wedding is rare
  // but happens (initial + pre-booking walkthrough).
  const latestTourByWedding = new Map<string, string>()
  for (const t of tourRows) {
    const prior = latestTourByWedding.get(t.wedding_id)
    if (!prior || t.scheduled_at > prior) {
      latestTourByWedding.set(t.wedding_id, t.scheduled_at)
    }
  }
  const wedIds = Array.from(latestTourByWedding.keys())

  // Step 2: hydrate weddings for status / inquiry_date display.
  const { data: weddings } = await sb
    .from('weddings')
    .select('id, status, inquiry_date')
    .eq('venue_id', venueId)
    .in('id', wedIds)
  const wedRows = (weddings ?? []) as Array<{
    id: string
    status: string | null
    inquiry_date: string | null
  }>
  const wedById = new Map(wedRows.map((w) => [w.id, w]))

  // Step 3: candidates linked to these weddings.
  const { data: candidates } = await sb
    .from('candidate_identities')
    .select('id, resolved_wedding_id')
    .eq('venue_id', venueId)
    .in('resolved_wedding_id', wedIds)
    .is('deleted_at', null)
  const candidateRows = (candidates ?? []) as Array<{ id: string; resolved_wedding_id: string }>
  if (candidateRows.length === 0) return []

  const candidateToWedding = new Map<string, string>()
  for (const c of candidateRows) candidateToWedding.set(c.id, c.resolved_wedding_id)

  // Step 4: signals for those candidates with a real signal_date.
  const candidateIds = candidateRows.map((c) => c.id)
  const { data: signals } = await sb
    .from('tangential_signals')
    .select('id, signal_date, source_platform, candidate_identity_id')
    .in('candidate_identity_id', candidateIds)
    .not('signal_date', 'is', null)
  const sigRows = (signals ?? []) as Array<{
    id: string
    signal_date: string
    source_platform: string | null
    candidate_identity_id: string
  }>

  // Step 5: people for couple naming (EEE Bug 1: dedup by full name
  // via the shared util so "Sarah & Sarah" doesn't render).
  const { data: people } = await sb
    .from('people')
    .select('first_name, last_name, wedding_id')
    .in('wedding_id', wedIds)
    .in('role', ['partner1', 'partner2'])
  const peopleByWedding = new Map<
    string,
    Array<{ first_name: string | null; last_name: string | null }>
  >()
  for (const p of (people ?? []) as Array<{
    first_name: string | null
    last_name: string | null
    wedding_id: string
  }>) {
    const arr = peopleByWedding.get(p.wedding_id) ?? []
    arr.push({ first_name: p.first_name, last_name: p.last_name })
    peopleByWedding.set(p.wedding_id, arr)
  }

  // Step 6: bucket signals per wedding, KEEP ONLY post-tour signals.
  // The predicate: signal_date > tour_end (scheduled_at + duration).
  // T5-Rixey-GGG Bug 22 — was previously "signal_date > inquiry_date"
  // which qualified pre-tour shopping as "still browsing after".
  const perWedding = new Map<
    string,
    { latest: string; platforms: Set<string>; count: number }
  >()
  for (const s of sigRows) {
    const wid = candidateToWedding.get(s.candidate_identity_id)
    if (!wid) continue
    const tourScheduled = latestTourByWedding.get(wid)
    if (!tourScheduled) continue
    const tourEndMs = new Date(tourScheduled).getTime() + TOUR_DURATION_MIN * 60 * 1000
    const signalMs = new Date(s.signal_date).getTime()
    if (!Number.isFinite(signalMs) || signalMs <= tourEndMs) continue

    const entry =
      perWedding.get(wid) ?? { latest: s.signal_date, platforms: new Set<string>(), count: 0 }
    if (s.signal_date > entry.latest) entry.latest = s.signal_date
    if (s.source_platform) entry.platforms.add(s.source_platform)
    entry.count++
    perWedding.set(wid, entry)
  }

  // Step 7: build response, sort by recency, cap.
  const leads: PostTourBrowsingLead[] = []
  for (const [wid, data] of perWedding.entries()) {
    const wed = wedById.get(wid)
    const tourDate = latestTourByWedding.get(wid)!
    const wedPeople = peopleByWedding.get(wid) ?? []
    const orderedNames: string[] = []
    for (const p of dedupePeopleByName(wedPeople)) {
      if (!p.first_name) continue
      orderedNames.push(p.first_name)
    }
    const coupleName = orderedNames.join(' & ') || 'Unnamed couple'
    leads.push({
      wedding_id: wid,
      couple_name: coupleName,
      tour_date: tourDate,
      inquiry_date: wed?.inquiry_date ?? null,
      status: wed?.status ?? null,
      latest_signal_date: data.latest,
      platforms: Array.from(data.platforms).sort(),
      signal_count: data.count,
    })
  }
  leads.sort((a, b) => b.latest_signal_date.localeCompare(a.latest_signal_date))
  return leads.slice(0, limit)
}
