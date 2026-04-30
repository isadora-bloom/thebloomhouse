/**
 * Post-tour browsing intelligence — find leads still researching
 * after their tour.
 *
 * Pattern: a wedding's tour is in the past AND there are
 * tangential_signals on a tracked platform (Knot, Instagram,
 * Pinterest, etc.) whose signal_date is AFTER the wedding's
 * inquiry_date. The couple toured the venue, then went back to
 * compare on a vendor platform.
 *
 * For coordinators this is a high-value cue:
 *   - Lead is still actively considering (not ghosting)
 *   - They're shopping competitors / reading reviews
 *   - A check-in email at this moment can land while the venue
 *     is still top-of-mind
 *
 * Returns up to N leads, ordered by most recent post-tour signal
 * date (most actionable first).
 */

import type { SupabaseClient } from '@supabase/supabase-js'

export interface PostTourBrowsingLead {
  wedding_id: string
  couple_name: string
  tour_date: string | null
  inquiry_date: string | null
  status: string | null
  /** Most recent post-tour signal across all platforms. */
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
  // Step 1: pull every wedding at the venue whose tour has already
  // happened. We filter in memory to avoid PostgREST's awkward
  // OR + nested AND syntax: a wedding qualifies if status =
  // 'tour_completed' OR (tour_date is in the past).
  const nowIso = new Date().toISOString()
  const { data: weddings } = await sb
    .from('weddings')
    .select('id, status, inquiry_date, tour_date')
    .eq('venue_id', venueId)
    .not('inquiry_date', 'is', null)
  const allRows = (weddings ?? []) as Array<{ id: string; status: string | null; inquiry_date: string; tour_date: string | null }>
  const wedRows = allRows.filter((w) => {
    if (w.status === 'tour_completed' || w.status === 'proposal_sent' || w.status === 'booked' || w.status === 'completed') return true
    if (w.tour_date && w.tour_date < nowIso) return true
    return false
  })
  if (wedRows.length === 0) return []

  // Step 2: for each, find tangential signals tied to the wedding
  // (via candidate_identities.resolved_wedding_id) whose
  // signal_date is after inquiry_date.
  const wedIds = wedRows.map((w) => w.id)
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

  const candidateIds = candidateRows.map((c) => c.id)
  const { data: signals } = await sb
    .from('tangential_signals')
    .select('id, signal_date, source_platform, candidate_identity_id')
    .in('candidate_identity_id', candidateIds)
    .not('signal_date', 'is', null)
  const sigRows = (signals ?? []) as Array<{ id: string; signal_date: string; source_platform: string | null; candidate_identity_id: string }>

  // Step 3: pull people for naming.
  const { data: people } = await sb
    .from('people')
    .select('first_name, last_name, wedding_id')
    .in('wedding_id', wedIds)
    .in('role', ['partner1', 'partner2'])
  const peopleByWedding = new Map<string, Array<{ first_name: string | null; last_name: string | null }>>()
  for (const p of (people ?? []) as Array<{ first_name: string | null; last_name: string | null; wedding_id: string }>) {
    const arr = peopleByWedding.get(p.wedding_id) ?? []
    arr.push({ first_name: p.first_name, last_name: p.last_name })
    peopleByWedding.set(p.wedding_id, arr)
  }

  // Step 4: bucket signals per wedding, keep only post-inquiry.
  const perWedding = new Map<string, { latest: string; platforms: Set<string>; count: number }>()
  for (const s of sigRows) {
    const wid = candidateToWedding.get(s.candidate_identity_id)
    if (!wid) continue
    const wed = wedRows.find((w) => w.id === wid)
    if (!wed) continue
    if (s.signal_date <= wed.inquiry_date) continue // pre-inquiry, skip
    const entry = perWedding.get(wid) ?? { latest: s.signal_date, platforms: new Set<string>(), count: 0 }
    if (s.signal_date > entry.latest) entry.latest = s.signal_date
    if (s.source_platform) entry.platforms.add(s.source_platform)
    entry.count++
    perWedding.set(wid, entry)
  }

  // Step 5: build the response, sort by recency, cap.
  const leads: PostTourBrowsingLead[] = []
  for (const [wid, data] of perWedding.entries()) {
    const wed = wedRows.find((w) => w.id === wid)!
    const wedPeople = peopleByWedding.get(wid) ?? []
    // Dedup first names — some weddings have a person row repeated
    // under different roles or partner_index values, which produced
    // "Sarah & Sarah" rendering. Stable order by first appearance.
    const seenNames = new Set<string>()
    const orderedNames: string[] = []
    for (const p of wedPeople) {
      if (!p.first_name) continue
      const k = p.first_name.toLowerCase()
      if (seenNames.has(k)) continue
      seenNames.add(k)
      orderedNames.push(p.first_name)
    }
    const coupleName = orderedNames.join(' & ') || 'Unnamed couple'
    leads.push({
      wedding_id: wid,
      couple_name: coupleName,
      tour_date: wed.tour_date,
      inquiry_date: wed.inquiry_date,
      status: wed.status,
      latest_signal_date: data.latest,
      platforms: Array.from(data.platforms).sort(),
      signal_count: data.count,
    })
  }
  leads.sort((a, b) => b.latest_signal_date.localeCompare(a.latest_signal_date))
  return leads.slice(0, limit)
}
