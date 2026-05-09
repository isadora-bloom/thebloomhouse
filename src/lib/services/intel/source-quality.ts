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
import { asCents } from '@/lib/types/monetary'

export interface SourceQualityRow {
  source: string
  bookedCount: number
  /** Average booking_value across this source's booked weddings, in CENTS.
   *  Display sites must call formatCents() / divide by 100 to render
   *  dollars (Stream RR doctrine — keep cents-scale until the UI).
   *  T5-Rixey-VV Y1 fix (was double-converted by some readers). */
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

  // Wave 1C (2026-05-09): per-source emotional theme correlation.
  // Pulled from wedding_auto_context joined on the source's booked +
  // first-touch weddings inside the window. Shape:
  //   { category, noteCount, weddingShare, sensitive }
  // weddingShare is the percentage of the source's weddings that
  // mentioned this category (0-100). Sensitive=true means the category
  // contains health/grief/financial_stress/family_conflict/mental_health
  // signals — the UI must NOT name couples alongside it. Counts only.
  topEmotionalThemes: Array<{
    category: string
    noteCount: number
    weddingShare: number
    sensitive: boolean
  }>
}

export async function computeSourceQuality(
  venueId: string,
  opts: { windowDays?: number } = {},
): Promise<SourceQualityRow[]> {
  const windowDays = opts.windowDays ?? 90
  const windowStartIso = new Date(Date.now() - windowDays * 86_400_000).toISOString()
  const windowMonthCutoff = windowStartIso.slice(0, 7) + '-01' // marketing_spend.month is first-of-month
  const supabase = createServiceClient()
  // Window-bound Quality columns to weddings BOOKED inside the
  // window. Coordinator selecting "Last 90d" expects "Knot's quality
  // of bookings in the last 90 days," not all-time. PC.4 fix #1:
  // before this, the window selector silently did nothing for the
  // Quality view.
  // Stream WWW (migration 205): include utm_source on the projection so
  // downstream first-touch logic has access to the captured ad-channel
  // signal. We do NOT change the default first-touch grouping here —
  // grouping continues to read attribution_events.source_platform with
  // wedding.source as the legacy fallback. utm_source is exposed on the
  // wedding-row type so the next stream (XXX) can promote it ahead of
  // wedding.source when it lands as a candidate first-touch.
  const { data: weddings } = await supabase
    .from('weddings')
    .select('id, source, booking_value, friction_tags, referred_by, status, inquiry_date, booked_at, utm_source')
    .eq('venue_id', venueId)
    .not('source', 'is', null)
    .gte('booked_at', windowStartIso)

  // Per Constitution / Playbook ANTI-2.6.5: attribution_events.source_platform
  // is the truth for "where this couple came from". wedding.source is
  // the legacy denormalised field (the leg / channel of the inquiry
  // email). Pre-T1-J / B-15 this scorecard grouped Quality columns
  // (bookedCount, avgRevenue, frictionRate, avgDaysToBook) by
  // wedding.source while the Funnel columns below grouped by
  // attribution_events. Two attribution models on one scorecard
  // would silently disagree (e.g. a wedding with a Knot first-touch
  // signal but a direct-website inquiry showed up in `direct` for
  // Quality and `the_knot` for Funnel). This block builds a
  // wedding_id → first-touch source map and uses it for grouping;
  // wedding.source is the fallback ONLY when no first-touch
  // attribution row exists (legacy weddings imported before
  // attribution tracking, manual entries, etc.).
  const weddingIdsAll = (weddings ?? []).map((w) => w.id as string)
  const firstTouchByWedding = new Map<string, string>()
  // T5-Rixey-KKK: trust only HIGH-confidence first-touch
  // attribution_events when promoting wedding source. Tier 2 wide-AI
  // matches are guesses (year-long window, name-only) and producing
  // phantom-Knot bookings via firstTouchByWedding when wedding.source
  // is NULL is exactly the B7 leak (audit-knot-phantom diagnosed two
  // such rows on Rixey: weddings 2c229347 + 635e97ba both got
  // tier_2_wide_ai Knot first-touch but their wedding.source is null
  // and no Knot signal exists in their own cluster). The high-trust
  // tiers (manual / coordinator override / tier_1_*) are explicit-
  // identity matches and CAN override a null wedding.source. AI tiers
  // remain visible on /intel/sources via the candidate panels but
  // don't pollute the booked-cohort scorecard.
  const HIGH_TRUST_TIERS = new Set([
    'tier_1_exact', 'tier_1_full_name', 'tier_1_email_domain',
    'tier_1_name_window', 'tier_2_coordinator', 'manual',
    'coordinator_override',
  ])
  if (weddingIdsAll.length > 0) {
    const FT_CHUNK = 200
    for (let i = 0; i < weddingIdsAll.length; i += FT_CHUNK) {
      const chunk = weddingIdsAll.slice(i, i + FT_CHUNK)
      const { data: ftRows } = await supabase
        .from('attribution_events')
        .select('wedding_id, source_platform, tier, signal_class')
        .eq('venue_id', venueId)
        .eq('is_first_touch', true)
        .is('reverted_at', null)
        .in('wedding_id', chunk)
      for (const r of (ftRows ?? []) as Array<{ wedding_id: string; source_platform: string; tier: string | null; signal_class: string | null }>) {
        // Multiple first-touch rows shouldn't happen (trigger enforces
        // it) but if they do the first row wins; downstream invariant
        // detection catches the duplicate.
        if (firstTouchByWedding.has(r.wedding_id)) continue
        // Only source-class signals contribute (matches mig 192 model).
        if (r.signal_class && r.signal_class !== 'source') continue
        // Tier 2 AI matches are guesses; require high-trust tier.
        if (!HIGH_TRUST_TIERS.has(r.tier ?? '')) continue
        firstTouchByWedding.set(r.wedding_id, r.source_platform)
      }
    }
  }

  const bySource: Record<string, {
    ids: string[]
    revenues: number[]
    frictionHits: number
    referralHits: number
    daysToBook: number[]
  }> = {}

  for (const w of weddings ?? []) {
    // Stream XXX precedence (most-trusted to least):
    //   1. weddings.utm_source — form-captured at inbound (Stream WWW /
    //      mig 205). Never overwritten by HoneyBook import.
    //   2. attribution_events.source_platform WHERE is_first_touch=true
    //      — cluster-attribution decision (B-15). Survives HoneyBook
    //      overwrite of weddings.source on booking.
    //   3. weddings.source — legacy first-touch field; last resort for
    //      pre-attribution-pipeline / manual-entry weddings.
    // The funnel API in attribution.ts uses the same chain — the two
    // surfaces (Source Quality scorecard, Source Comparison funnel)
    // must agree on how a booking is credited.
    const src =
      (w.utm_source as string | null)
        ?? firstTouchByWedding.get(w.id as string)
        ?? (w.source as string)
        ?? 'unknown'
    const status = (w.status as string) ?? ''
    const booked = status === 'booked' || status === 'completed'
    if (!booked) continue

    if (!bySource[src]) bySource[src] = { ids: [], revenues: [], frictionHits: 0, referralHits: 0, daysToBook: [] }
    bySource[src].ids.push(w.id as string)
    // booking_value is cents per Bloom convention (T5-Rixey-NN bug #8;
    // T5-Rixey-RR fix #5 — branded `Cents` type makes this explicit).
    // T5-Rixey-VV Y1: keep cents-scale all the way to display so callers
    // use formatCents() consistently (Stream RR doctrine). Previously
    // converted to dollars here, which produced double-conversion when
    // some readers also divided.
    if (w.booking_value) {
      const cents = asCents(Number(w.booking_value))
      bySource[src].revenues.push(cents)
    }

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

    // Portal activity: engagement events. Filter direction='inbound'
    // per Playbook INV-16 — "portal activity" semantically means
    // couple-side actions, not autonomous-sender outbound. A future
    // outbound row in this aggregation would inflate per-source
    // activity in a way that has nothing to do with what the source
    // sent us.
    const { count: eventCount } = await supabase
      .from('engagement_events')
      .select('id', { count: 'exact', head: true })
      .in('wedding_id', data.ids)
      .eq('direction', 'inbound')
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
      // Wave 1C: theme correlation populated below.
      topEmotionalThemes: [],
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
        topEmotionalThemes: [],
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

  // ---- Wave 1C (2026-05-09): per-source emotional theme correlation ----
  //
  // For each source, fetch the soft-context categories that the
  // source's booked + first-touched weddings have produced inside the
  // window. This lets the scorecard say "couples from The Knot mention
  // budget concerns at 2x the rate of direct inquiries".
  //
  // Aggregate ≠ disclose: sensitive categories are surfaced as COUNTS
  // ONLY (per-source weddingShare). The UI must NOT name couples
  // alongside a sensitive theme.
  //
  // Soft-fail: any error returns empty themes for that source. The
  // scorecard is enrichment, never blocking.
  try {
    const SENSITIVE_CATS = new Set([
      'health',
      'grief',
      'financial_stress',
      'family_conflict',
      'mental_health',
    ])

    // Build the source → wedding-id map. We use BOTH booked weddings
    // (bySource) AND first-touch weddings (ftWeddingsBySource) so a
    // source with many leads but few bookings still gets coverage.
    const sourceWeddingMap = new Map<string, Set<string>>()
    for (const [src, data] of Object.entries(bySource)) {
      const set = sourceWeddingMap.get(src) ?? new Set<string>()
      for (const id of data.ids) set.add(id)
      sourceWeddingMap.set(src, set)
    }
    for (const [src, set] of ftWeddingsBySource) {
      const cur = sourceWeddingMap.get(src) ?? new Set<string>()
      for (const id of set) cur.add(id)
      sourceWeddingMap.set(src, cur)
    }

    // One pass: gather every wedding ID across all sources, fetch the
    // notes in chunks, then redistribute to source-keyed buckets.
    const allWeddingIds = Array.from(
      new Set(Array.from(sourceWeddingMap.values()).flatMap((s) => Array.from(s))),
    )
    if (allWeddingIds.length > 0) {
      type ThemeRow = {
        wedding_id: string
        category: string | null
        sensitive: boolean | null
      }
      const allThemes: ThemeRow[] = []
      const CHUNK = 200
      for (let i = 0; i < allWeddingIds.length; i += CHUNK) {
        const chunk = allWeddingIds.slice(i, i + CHUNK)
        try {
          const { data, error } = await supabase
            .from('wedding_auto_context')
            .select('wedding_id, category, sensitive')
            .eq('venue_id', venueId)
            .eq('is_active', true)
            .in('wedding_id', chunk)
          if (error) {
            // Pre-mig-255 fallback (no `sensitive` column).
            const message = (error as { message?: string }).message ?? ''
            if (/column .* does not exist/i.test(message)) {
              const legacy = await supabase
                .from('wedding_auto_context')
                .select('wedding_id, category')
                .eq('venue_id', venueId)
                .eq('is_active', true)
                .in('wedding_id', chunk)
              for (const r of (legacy.data ?? []) as Array<{ wedding_id: string; category: string | null }>) {
                allThemes.push({ wedding_id: r.wedding_id, category: r.category, sensitive: null })
              }
            }
          } else {
            for (const r of (data ?? []) as ThemeRow[]) allThemes.push(r)
          }
        } catch {
          // Skip this chunk; theme correlation is enrichment.
        }
      }

      // Build per-source theme maps.
      type Bucket = {
        // category → set of wedding IDs that mentioned it
        catWeddings: Map<string, Set<string>>
        catNotes: Map<string, number>
        catSensitive: Map<string, boolean>
      }
      const themesBySource = new Map<string, Bucket>()
      // Index theme rows by wedding_id for fast lookup.
      const themesByWedding = new Map<string, ThemeRow[]>()
      for (const t of allThemes) {
        const arr = themesByWedding.get(t.wedding_id) ?? []
        arr.push(t)
        themesByWedding.set(t.wedding_id, arr)
      }

      for (const [src, weddings] of sourceWeddingMap) {
        const bucket: Bucket = {
          catWeddings: new Map(),
          catNotes: new Map(),
          catSensitive: new Map(),
        }
        for (const wid of weddings) {
          const rows = themesByWedding.get(wid) ?? []
          for (const r of rows) {
            const cat = r.category && r.category.trim().length > 0 ? r.category : 'misc'
            const ws = bucket.catWeddings.get(cat) ?? new Set<string>()
            ws.add(wid)
            bucket.catWeddings.set(cat, ws)
            bucket.catNotes.set(cat, (bucket.catNotes.get(cat) ?? 0) + 1)
            const wasSensitive = bucket.catSensitive.get(cat) ?? false
            const nowSensitive = wasSensitive || r.sensitive === true || SENSITIVE_CATS.has(cat)
            bucket.catSensitive.set(cat, nowSensitive)
          }
        }
        themesBySource.set(src, bucket)
      }

      // Attach top-3 themes per source row.
      for (const row of results) {
        const bucket = themesBySource.get(row.source)
        if (!bucket) continue
        const total = sourceWeddingMap.get(row.source)?.size ?? 0
        if (total === 0) continue
        const entries = Array.from(bucket.catNotes.entries())
          .map(([category, noteCount]) => {
            const ws = bucket.catWeddings.get(category)?.size ?? 0
            return {
              category,
              noteCount,
              weddingShare: total > 0 ? Math.round((ws / total) * 1000) / 10 : 0,
              sensitive: bucket.catSensitive.get(category) === true,
            }
          })
          .sort((a, b) => {
            if (b.weddingShare !== a.weddingShare) return b.weddingShare - a.weddingShare
            return b.noteCount - a.noteCount
          })
          .slice(0, 3)
        row.topEmotionalThemes = entries
      }
    }
  } catch (err) {
    console.warn('[source-quality] theme correlation failed:', err)
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
