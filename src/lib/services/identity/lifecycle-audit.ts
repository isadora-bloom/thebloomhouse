/**
 * Lifecycle audit + duplicate-couple diagnostic - Tier 8 §C.3 cleanup.
 *
 * Two parallel diagnostics that run over the spine and surface
 * operator-actionable cleanup work:
 *
 *   1. LIFECYCLE DRIFT. For every couple, derive the lifecycle state
 *      its spine signals SAY it should be (booked via progression
 *      events or legacy weddings.status; resolved via any inbound
 *      progression; ghost via no inbound for the decay window;
 *      channel_scoped via un-acknowledged), and flag couples whose
 *      stored `lifecycle_state` disagrees.
 *
 *   2. UNDER-MERGE candidates. Group couples by (lower(partner1
 *      first+last), lower(partner2 first), venue_id). Any group with
 *      >1 couple is a likely-duplicate pair the cascade missed -
 *      surfaces as a merge candidate for operator confirm. The
 *      diagnostic IS NOT auto-action: the operator reads the list
 *      and decides which to merge via the existing identity/resolve
 *      path.
 *
 * Anchor: IDENTITY-FIRST-ARCHITECTURE.md §3 (lifecycle clock) + §5
 * (judge + merge UI). The cascade closes the OVER-merge bug class;
 * this diagnostic catches the UNDER-merge bug class, which fires when
 * two records share names but disagree on identifiers (different
 * partner emails for the same couple, the Melissa Millis & Stephen
 * Pugh shape from the 2026-05-20 audit).
 *
 * Read-only. Multi-venue safe. No Rixey-specific clauses.
 */

import type { SupabaseClient } from '@supabase/supabase-js'

// Live ENGAGED states the funnel reports on (channel_scoped + agent
// sit outside).
const ENGAGED_STATES = new Set(['resolved', 'booked', 'ghost', 'completed'])

// Days quiet before a 'resolved' couple should flip to 'ghost' under
// doctrine §3. Mirrors the existing decay-sweep default.
const DECAY_WINDOW_DAYS = 180

export type LifecycleState =
  | 'channel_scoped'
  | 'resolved'
  | 'booked'
  | 'completed'
  | 'ghost'
  | 'agent'

export interface LifecycleAuditRow {
  coupleId: string
  primaryName: string | null
  primaryEmail: string | null
  currentState: LifecycleState | null
  expectedState: LifecycleState | null
  /** Short human-readable explanation of the derivation. */
  rationale: string
}

export interface DuplicateGroup {
  /** Stable key shared by every couple in the group (lower partner1
   *  first+last + partner2 first). */
  key: string
  couples: Array<{
    coupleId: string
    primaryName: string | null
    primaryEmail: string | null
    partnerName: string | null
    lifecycleState: LifecycleState | null
    weddingDate: string | null
    createdAt: string
  }>
}

export interface LifecycleAuditReport {
  drift: LifecycleAuditRow[]
  duplicates: DuplicateGroup[]
  meta: {
    couplesScanned: number
    driftCount: number
    duplicateGroupCount: number
    duplicateCoupleCount: number
  }
}

// ---------------------------------------------------------------------------
// Internal types
// ---------------------------------------------------------------------------

interface CoupleRow {
  id: string
  primary_contact_name: string | null
  primary_contact_email: string | null
  partner_contact_name: string | null
  lifecycle_state: string | null
  wedding_date: string | null
  source_wedding_id: string | null
  created_at: string
  last_progression_at: string | null
}

interface ProgressionRow {
  couple_id: string
  event_type: string
  occurred_at: string
}

interface WeddingRow {
  id: string
  status: string | null
}

// ---------------------------------------------------------------------------
// Derivation
// ---------------------------------------------------------------------------

function deriveExpectedState(
  couple: CoupleRow,
  progressionEvents: ProgressionRow[],
  weddingStatus: string | null,
): { expected: LifecycleState; rationale: string } {
  // Booked vs completed: depends on wedding_date.
  //   - has signed evidence AND wedding_date < now  -> 'completed'
  //   - has signed evidence AND wedding_date >= now -> 'booked'
  //   - has signed evidence AND no wedding_date     -> 'booked' (default)
  const TERMINAL_POSITIVE_WEDDING_STATUSES = new Set(['booked', 'completed', 'signed'])
  const hasContractSigned = progressionEvents.some(
    (p) => p.event_type === 'contract_signed',
  )
  const hasPositiveLegacyStatus =
    weddingStatus &&
    TERMINAL_POSITIVE_WEDDING_STATUSES.has(weddingStatus.toLowerCase())
  if (hasContractSigned || hasPositiveLegacyStatus) {
    const weddingPassed =
      couple.wedding_date && Date.parse(couple.wedding_date) < Date.now()
    const expected: LifecycleState = weddingPassed ? 'completed' : 'booked'
    const rationale = hasContractSigned
      ? `has contract_signed progression event${weddingPassed ? ' + wedding has passed' : ''}`
      : `legacy weddings.status = '${weddingStatus}'${weddingPassed ? ' + wedding has passed' : ''}`
    return { expected, rationale }
  }

  // Terminal-negative: legacy weddings.status = lost / cancelled /
  // non_couple -> ghost.
  if (
    weddingStatus &&
    ['lost', 'cancelled', 'non_couple'].includes(weddingStatus.toLowerCase())
  ) {
    return {
      expected: 'ghost',
      rationale: `legacy weddings.status = '${weddingStatus}'`,
    }
  }

  // Decay: any progression but quiet > DECAY_WINDOW_DAYS -> ghost.
  if (progressionEvents.length > 0) {
    const lastEvent = progressionEvents.reduce((latest, p) => {
      const t = Date.parse(p.occurred_at)
      return t > latest ? t : latest
    }, 0)
    const daysSince = (Date.now() - lastEvent) / 86_400_000
    if (daysSince > DECAY_WINDOW_DAYS) {
      return {
        expected: 'ghost',
        rationale: `quiet ${Math.floor(daysSince)} days since last progression`,
      }
    }
    return {
      expected: 'resolved',
      rationale: `${progressionEvents.length} progression events, last ${Math.floor(daysSince)}d ago`,
    }
  }

  // No progression events at all. If there's a wedding link, it's
  // pre-progression-events-era data -> trust the current state.
  if (couple.source_wedding_id) {
    return {
      expected: (couple.lifecycle_state as LifecycleState) ?? 'channel_scoped',
      rationale: 'legacy couple with no progression events; cannot derive',
    }
  }

  // Fragment-promoted couple with no progression events: channel-scoped.
  return {
    expected: 'channel_scoped',
    rationale: 'no progression events; un-acknowledged signal',
  }
}

/**
 * Build the partner-pair key used for duplicate detection.
 *
 * Tightened 2026-05-20 after the first live run flagged 137 noisy
 * groups dominated by first-name-plus-initial fragments. Doctrine
 * now requires:
 *
 *   - partner1 has at least TWO whitespace-separated tokens
 *   - the LAST token (the surname proxy) has ≥3 characters (drops
 *     single-letter initials like "Courtney H")
 *   - the name is not literally "Unnamed couple" or similar
 *     placeholder noise
 *
 * Records that fail any check get a null key and are excluded from
 * the duplicate scan. They are still surfaced by the lifecycle drift
 * pass (most fail because they are fragment-shape records with no
 * progression events and should be channel_scoped, not resolved).
 */
const PLACEHOLDER_NAMES = new Set([
  'unnamed couple',
  'unknown',
  '(unknown)',
  '(unnamed)',
  '(no name)',
  'no name',
])

function partnerNameKey(couple: CoupleRow): string | null {
  const a = (couple.primary_contact_name ?? '').trim().toLowerCase()
  const b = (couple.partner_contact_name ?? '').trim().toLowerCase()
  if (!a || PLACEHOLDER_NAMES.has(a)) return null

  const partner1Tokens = a.split(/\s+/).filter(Boolean)
  if (partner1Tokens.length < 2) return null
  const partner1Last = partner1Tokens[partner1Tokens.length - 1]
  if (!partner1Last || partner1Last.length < 3) return null

  // First token of partner2 when present. partner2 is OPTIONAL — the
  // partner1 full name is the primary disambiguator. Including
  // partner2 when available lets us distinguish "Sarah Smith & James"
  // from "Sarah Smith & Mike" at the same venue.
  const partner2First = (b.split(/\s+/).find((t) => t.length >= 2)) ?? ''
  return partner2First ? `${a}|${partner2First}` : a
}

// ---------------------------------------------------------------------------
// Public entry
// ---------------------------------------------------------------------------

export async function runLifecycleAudit(
  supabase: SupabaseClient,
  venueId: string,
): Promise<LifecycleAuditReport> {
  // Load every couple for the venue. At venue scale (~2K rows) this
  // fits in memory.
  const { data: couplesData, error: couplesErr } = await supabase
    .from('couples')
    .select(
      'id, primary_contact_name, primary_contact_email, partner_contact_name, lifecycle_state, wedding_date, source_wedding_id, created_at, last_progression_at',
    )
    .eq('venue_id', venueId)
    .limit(10000)
  if (couplesErr) {
    return {
      drift: [],
      duplicates: [],
      meta: {
        couplesScanned: 0,
        driftCount: 0,
        duplicateGroupCount: 0,
        duplicateCoupleCount: 0,
      },
    }
  }
  const couples = (couplesData ?? []) as CoupleRow[]
  if (couples.length === 0) {
    return {
      drift: [],
      duplicates: [],
      meta: {
        couplesScanned: 0,
        driftCount: 0,
        duplicateGroupCount: 0,
        duplicateCoupleCount: 0,
      },
    }
  }

  // Bulk-load progression events for those couples.
  const coupleIds = couples.map((c) => c.id)
  const progByCouple = new Map<string, ProgressionRow[]>()
  // PostgREST 1000 id cap on IN — chunk.
  const CHUNK = 500
  for (let i = 0; i < coupleIds.length; i += CHUNK) {
    const slice = coupleIds.slice(i, i + CHUNK)
    const { data } = await supabase
      .from('couple_progression_events')
      .select('couple_id, event_type, occurred_at')
      .in('couple_id', slice)
    for (const row of (data ?? []) as ProgressionRow[]) {
      const list = progByCouple.get(row.couple_id)
      if (list) list.push(row)
      else progByCouple.set(row.couple_id, [row])
    }
  }

  // Bulk-load legacy weddings.status for couples with source_wedding_id.
  const sourceWeddingIds = couples
    .map((c) => c.source_wedding_id)
    .filter((v): v is string => Boolean(v))
  const weddingStatusById = new Map<string, string>()
  if (sourceWeddingIds.length > 0) {
    for (let i = 0; i < sourceWeddingIds.length; i += CHUNK) {
      const slice = sourceWeddingIds.slice(i, i + CHUNK)
      const { data } = await supabase
        .from('weddings')
        .select('id, status')
        .in('id', slice)
      for (const w of (data ?? []) as WeddingRow[]) {
        if (w.status) weddingStatusById.set(w.id, w.status)
      }
    }
  }

  // ---- Drift -------------------------------------------------------------
  const drift: LifecycleAuditRow[] = []
  for (const c of couples) {
    const progression = progByCouple.get(c.id) ?? []
    const weddingStatus = c.source_wedding_id
      ? weddingStatusById.get(c.source_wedding_id) ?? null
      : null
    const { expected, rationale } = deriveExpectedState(c, progression, weddingStatus)
    if (
      c.lifecycle_state !== expected &&
      // Skip 'agent' — administrative, don't audit
      c.lifecycle_state !== 'agent' &&
      expected !== 'agent'
    ) {
      drift.push({
        coupleId: c.id,
        primaryName: c.primary_contact_name,
        primaryEmail: c.primary_contact_email,
        currentState: (c.lifecycle_state as LifecycleState | null) ?? null,
        expectedState: expected,
        rationale,
      })
    }
  }
  // Order: terminal-positive corrections first (booked vs not booked),
  // then terminal-negative, then resolved/channel_scoped.
  const stateRank = (s: LifecycleState | null): number => {
    if (s === 'booked') return 0
    if (s === 'ghost') return 1
    if (s === 'resolved') return 2
    if (s === 'channel_scoped') return 3
    return 4
  }
  drift.sort((a, b) => stateRank(a.expectedState) - stateRank(b.expectedState))

  // ---- Duplicates --------------------------------------------------------
  // Group only engaged-state couples; channel_scoped duplicates are
  // usually vendor noise that should stay separate.
  const engaged = couples.filter((c) =>
    c.lifecycle_state ? ENGAGED_STATES.has(c.lifecycle_state) : false,
  )
  const groupsByKey = new Map<string, CoupleRow[]>()
  for (const c of engaged) {
    const key = partnerNameKey(c)
    if (!key) continue
    const list = groupsByKey.get(key)
    if (list) list.push(c)
    else groupsByKey.set(key, [c])
  }
  const duplicates: DuplicateGroup[] = []
  for (const [key, group] of groupsByKey) {
    if (group.length < 2) continue
    duplicates.push({
      key,
      couples: group.map((c) => ({
        coupleId: c.id,
        primaryName: c.primary_contact_name,
        primaryEmail: c.primary_contact_email,
        partnerName: c.partner_contact_name,
        lifecycleState: c.lifecycle_state as LifecycleState | null,
        weddingDate: c.wedding_date,
        createdAt: c.created_at,
      })),
    })
  }
  // Sort: groups with a booked record first (those resolutions matter
  // most), then by group size.
  duplicates.sort((a, b) => {
    const aHasBooked = a.couples.some((c) => c.lifecycleState === 'booked')
    const bHasBooked = b.couples.some((c) => c.lifecycleState === 'booked')
    if (aHasBooked !== bHasBooked) return aHasBooked ? -1 : 1
    return b.couples.length - a.couples.length
  })

  return {
    drift,
    duplicates,
    meta: {
      couplesScanned: couples.length,
      driftCount: drift.length,
      duplicateGroupCount: duplicates.length,
      duplicateCoupleCount: duplicates.reduce((s, g) => s + g.couples.length, 0),
    },
  }
}
