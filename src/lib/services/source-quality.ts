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
 *   - avgDaysToBook     (inquiry_date -> booked_at, in days, of booked
 *                        weddings; null when neither timestamp is set)
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
  /** Mean days from inquiry to booking for this source's booked
   *  weddings. Null when no wedding has both timestamps. */
  avgDaysToBook: number | null

  // Phase C / PC.1 (2026-04-28): candidate-funnel + CAC fields,
  // sourced from Phase B's attribution_events + tangential_signals.
  // Window-bounded by the windowDays argument to computeSourceQuality.

  /** Total signals delivered on this platform inside the window —
   *  includes anonymous (no candidate) signals. Pure volume metric. */
  signalsDelivered: number
  /** Candidate identities created on this platform inside the window
   *  (excludes anonymous). The "people-shaped engagement" count. */
  candidatesCreated: number
  /** Average funnel depth across this source's candidates. A value
   *  of 1 = view-only audience; ≥3 means routinely reaching the
   *  message tier. */
  avgFunnelDepth: number
  /** Share of candidates that resolved to a wedding (auto + AI +
   *  manual). 0-1. */
  autoLinkRate: number
  /** Number of weddings where this platform won is_first_touch
   *  inside the window — the methodologically-correct lead count
   *  per source. May differ from bookedCount (which uses the legacy
   *  weddings.source enum); the gap is the migration delta. */
  firstTouchLeads: number
  /** Subset of firstTouchLeads that reached tour_date status. */
  firstTouchTours: number
  /** Subset of firstTouchLeads that reached booked status. */
  firstTouchBookings: number
  /** Sum of marketing_spend inside the window. */
  spendInWindow: number
  /** spendInWindow / firstTouchLeads (or null when leads = 0). */
  costPerLead: number | null
  costPerTour: number | null
  costPerBooking: number | null
}

export async function computeSourceQuality(
  venueId: string,
  opts: { windowDays?: number } = {},
): Promise<SourceQualityRow[]> {
  const windowDays = opts.windowDays ?? 90
  const windowStartIso = new Date(Date.now() - windowDays * 86_400_000).toISOString()
  const windowMonthCutoff = windowStartIso.slice(0, 7) + '-01' // marketing_spend.month is first-of-month
  const supabase = createServiceClient()
  const { data: weddings } = await supabase
    .from('weddings')
    .select('id, source, booking_value, friction_tags, referred_by, status, inquiry_date, booked_at')
    .eq('venue_id', venueId)
    .not('source', 'is', null)

  const bySource: Record<string, {
    ids: string[]
    revenues: number[]
    frictionHits: number
    referralHits: number
    daysToBook: number[]
  }> = {}

  for (const w of weddings ?? []) {
    const src = (w.source as string) ?? 'unknown'
    const status = (w.status as string) ?? ''
    const booked = status === 'booked' || status === 'completed'
    if (!booked) continue

    if (!bySource[src]) bySource[src] = { ids: [], revenues: [], frictionHits: 0, referralHits: 0, daysToBook: [] }
    bySource[src].ids.push(w.id as string)
    if (w.booking_value) bySource[src].revenues.push(Number(w.booking_value))

    const ft = w.friction_tags
    if (Array.isArray(ft) && ft.length > 0) bySource[src].frictionHits++
    if (w.referred_by) bySource[src].referralHits++

    // Days to book: inquiry_date -> booked_at. Skip rows missing
    // either timestamp; some legacy bookings were entered manually
    // without a recorded inquiry. Negative values (booked before
    // inquiry — manual entry of a deposit etc.) are dropped as
    // nonsensical for this metric.
    const inquiry = w.inquiry_date as string | null
    const bookedAt = w.booked_at as string | null
    if (inquiry && bookedAt) {
      const ms = new Date(bookedAt).getTime() - new Date(inquiry).getTime()
      const days = ms / (1000 * 60 * 60 * 24)
      if (Number.isFinite(days) && days >= 0) bySource[src].daysToBook.push(days)
    }
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

    const avgDaysToBook = data.daysToBook.length > 0
      ? data.daysToBook.reduce((a, b) => a + b, 0) / data.daysToBook.length
      : null

    results.push({
      source,
      bookedCount,
      avgRevenue,
      avgEmailsExchanged,
      avgPortalActivity,
      avgReviewScore,
      referralCount: data.referralHits,
      frictionRate: bookedCount > 0 ? data.frictionHits / bookedCount : 0,
      avgDaysToBook,
      // Phase C fields populated below in one pass; default to zero
      // here so the row shape stays consistent.
      signalsDelivered: 0,
      candidatesCreated: 0,
      avgFunnelDepth: 0,
      autoLinkRate: 0,
      firstTouchLeads: 0,
      firstTouchTours: 0,
      firstTouchBookings: 0,
      spendInWindow: 0,
      costPerLead: null,
      costPerTour: null,
      costPerBooking: null,
    })
  }

  // ---- Phase C / PC.1: candidate-funnel + CAC enrichment ----
  // Most platforms in attribution_events don't have a row in `bySource`
  // yet (no booked weddings). We need entries for every platform that
  // shows up in tangential_signals OR attribution_events OR
  // marketing_spend so the scorecard isn't blind to fresh-traffic
  // sources that haven't converted yet.

  // Per-source signal counts (window-bounded by signal_date).
  const { data: signals } = await supabase
    .from('tangential_signals')
    .select('source_platform, candidate_identity_id, signal_date')
    .eq('venue_id', venueId)
    .not('source_platform', 'is', null)
    .gte('signal_date', windowStartIso)
  const signalsBySource = new Map<string, { delivered: number }>()
  for (const s of (signals ?? []) as Array<{ source_platform: string | null; candidate_identity_id: string | null; signal_date: string | null }>) {
    if (!s.source_platform) continue
    const key = s.source_platform
    const cur = signalsBySource.get(key) ?? { delivered: 0 }
    cur.delivered++
    signalsBySource.set(key, cur)
  }

  // Per-source candidates (excludes anonymous since they have no
  // candidate_identity_id). first_seen-bounded.
  const { data: candidates } = await supabase
    .from('candidate_identities')
    .select('source_platform, funnel_depth, resolved_wedding_id')
    .eq('venue_id', venueId)
    .is('deleted_at', null)
    .gte('first_seen', windowStartIso)
  const candByPlatform = new Map<string, { count: number; funnelTotal: number; resolved: number }>()
  for (const c of (candidates ?? []) as Array<{ source_platform: string; funnel_depth: number; resolved_wedding_id: string | null }>) {
    const key = c.source_platform
    const cur = candByPlatform.get(key) ?? { count: 0, funnelTotal: 0, resolved: 0 }
    cur.count++
    cur.funnelTotal += c.funnel_depth ?? 0
    if (c.resolved_wedding_id) cur.resolved++
    candByPlatform.set(key, cur)
  }

  // First-touch leads/tours/bookings via attribution_events. Window
  // by decided_at. Only is_first_touch=true and not reverted rows
  // count.
  const { data: attribEvents } = await supabase
    .from('attribution_events')
    .select('source_platform, wedding_id, decided_at')
    .eq('venue_id', venueId)
    .eq('is_first_touch', true)
    .is('reverted_at', null)
    .gte('decided_at', windowStartIso)
  const ftWeddingsBySource = new Map<string, Set<string>>()
  for (const e of (attribEvents ?? []) as Array<{ source_platform: string; wedding_id: string }>) {
    const key = e.source_platform
    const set = ftWeddingsBySource.get(key) ?? new Set<string>()
    set.add(e.wedding_id)
    ftWeddingsBySource.set(key, set)
  }
  // Single fetch of every first-touched wedding's status + tour_date.
  const allFtWeddingIds = Array.from(new Set(
    Array.from(ftWeddingsBySource.values()).flatMap((s) => Array.from(s)),
  ))
  const wedStatusMap = new Map<string, { status: string | null; tour_date: string | null; booked_at: string | null }>()
  if (allFtWeddingIds.length > 0) {
    const FT_CHUNK = 100
    for (let i = 0; i < allFtWeddingIds.length; i += FT_CHUNK) {
      const chunk = allFtWeddingIds.slice(i, i + FT_CHUNK)
      const { data: ws } = await supabase
        .from('weddings')
        .select('id, status, tour_date, booked_at')
        .in('id', chunk)
      for (const w of (ws ?? []) as Array<{ id: string; status: string | null; tour_date: string | null; booked_at: string | null }>) {
        wedStatusMap.set(w.id, { status: w.status, tour_date: w.tour_date, booked_at: w.booked_at })
      }
    }
  }

  // Spend per source within window.
  const { data: spendRows } = await supabase
    .from('marketing_spend')
    .select('source, amount')
    .eq('venue_id', venueId)
    .gte('month', windowMonthCutoff)
  const spendBySource = new Map<string, number>()
  for (const r of (spendRows ?? []) as Array<{ source: string; amount: number }>) {
    spendBySource.set(r.source, (spendBySource.get(r.source) ?? 0) + Number(r.amount))
  }

  // Make sure every source that has any signal/candidate/attribution/spend
  // gets a row, even if no booking exists yet.
  const allSources = new Set<string>([
    ...Object.keys(bySource),
    ...signalsBySource.keys(),
    ...candByPlatform.keys(),
    ...ftWeddingsBySource.keys(),
    ...spendBySource.keys(),
  ])
  for (const src of allSources) {
    if (!results.find((r) => r.source === src)) {
      results.push({
        source: src,
        bookedCount: 0,
        avgRevenue: 0,
        avgEmailsExchanged: 0,
        avgPortalActivity: 0,
        avgReviewScore: null,
        referralCount: 0,
        frictionRate: 0,
        avgDaysToBook: null,
        signalsDelivered: 0,
        candidatesCreated: 0,
        avgFunnelDepth: 0,
        autoLinkRate: 0,
        firstTouchLeads: 0,
        firstTouchTours: 0,
        firstTouchBookings: 0,
        spendInWindow: 0,
        costPerLead: null,
        costPerTour: null,
        costPerBooking: null,
      })
    }
  }

  for (const row of results) {
    const sig = signalsBySource.get(row.source)
    row.signalsDelivered = sig?.delivered ?? 0

    const cand = candByPlatform.get(row.source)
    row.candidatesCreated = cand?.count ?? 0
    row.avgFunnelDepth = cand && cand.count > 0 ? cand.funnelTotal / cand.count : 0
    row.autoLinkRate = cand && cand.count > 0 ? cand.resolved / cand.count : 0

    const ftWeddings = ftWeddingsBySource.get(row.source) ?? new Set<string>()
    row.firstTouchLeads = ftWeddings.size
    let tours = 0
    let bookings = 0
    for (const wid of ftWeddings) {
      const w = wedStatusMap.get(wid)
      if (!w) continue
      if (w.tour_date) tours++
      if (w.status === 'booked' || w.status === 'completed' || w.booked_at) bookings++
    }
    row.firstTouchTours = tours
    row.firstTouchBookings = bookings

    row.spendInWindow = spendBySource.get(row.source) ?? 0
    row.costPerLead = row.firstTouchLeads > 0 ? row.spendInWindow / row.firstTouchLeads : null
    row.costPerTour = row.firstTouchTours > 0 ? row.spendInWindow / row.firstTouchTours : null
    row.costPerBooking = row.firstTouchBookings > 0 ? row.spendInWindow / row.firstTouchBookings : null
  }

  return results.sort((a, b) => {
    // Bookings first, then first-touch leads, then candidates — keeps
    // the most-converted platforms at the top while still surfacing
    // platforms that have engagement but haven't booked yet.
    if (b.bookedCount !== a.bookedCount) return b.bookedCount - a.bookedCount
    if (b.firstTouchLeads !== a.firstTouchLeads) return b.firstTouchLeads - a.firstTouchLeads
    return b.candidatesCreated - a.candidatesCreated
  })
}
