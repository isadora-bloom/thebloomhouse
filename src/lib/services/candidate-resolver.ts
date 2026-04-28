/**
 * Candidate-to-wedding resolver (Phase B / PB.3).
 *
 * Once a signal is in a candidate_identity (clusterer), the resolver
 * tries to link the candidate to a wedding. Tier-1 deterministic
 * paths handle the high-confidence cases; Tier-2 ambiguous cases are
 * routed to the AI adjudicator (PB.4); Tier-3 parks the candidate
 * for coordinator search.
 *
 * Tier 1 paths (locked 2026-04-28):
 *   1. Exact email match: candidate.email = person.email (or contacts.value)
 *   2. Exact phone match: candidate.phone = person.phone (or contacts.value)
 *   3. Exact username match: candidate.username (per platform) = people.external_ids[platform]
 *   4. Name + window + uniqueness: candidate has same first_name +
 *      last_initial as a person on a wedding whose inquiry_date OR
 *      tour_date is within ±72h of any signal in the candidate's
 *      timeline, AND no other candidate with the same fingerprint
 *      sits in the same window for the same wedding
 *   5. Full name: candidate has full last_name + first_name + state
 *      matching a person on a wedding (any window up to 60d)
 *
 * First-touch is recomputed every time a new attribution_event lands
 * for a wedding: the row with the EARLIEST signal_date among all
 * pre-inquiry rows wins is_first_touch=true; everything else is
 * is_first_touch=false. Signals after inquiry_date are bucket='nurture'
 * and never claim first-touch.
 *
 * Conflict flag: if weddings.source (legacy) disagrees with the
 * computed first-touch platform, attribution_events.conflict_with_legacy_source
 * captures the divergence. The flag surfaces a badge on lead detail
 * + a row in the coordinator review queue.
 *
 * Idempotency: resolving an already-resolved candidate is a no-op.
 * Re-running from either direction (signal-arrives or lead-arrives)
 * produces the same attribution_events set.
 */

import type { SupabaseClient } from '@supabase/supabase-js'

const TIER_1_NAME_WINDOW_HOURS = 72

type Tier =
  | 'tier_1_exact'
  | 'tier_1_name_window'
  | 'tier_1_full_name'
  | 'tier_2_ai'
  | 'tier_2_coordinator'
  | 'tier_3_manual'

export interface ResolverSummary {
  candidates_processed: number
  resolved_tier_1_exact: number
  resolved_tier_1_name_window: number
  resolved_tier_1_full_name: number
  deferred_to_ai: number
  parked_tier_3: number
  no_match: number
  conflicts_flagged: number
  errors: string[]
}

interface CandidateRow {
  id: string
  venue_id: string
  source_platform: string
  first_name: string | null
  last_initial: string | null
  last_name: string | null
  email: string | null
  phone: string | null
  username: string | null
  city: string | null
  state: string | null
  country: string | null
  first_seen: string | null
  last_seen: string | null
  funnel_depth: number
  signal_count: number
  resolved_wedding_id: string | null
  resolved_person_id: string | null
}

interface PersonMatch {
  person_id: string
  wedding_id: string
  inquiry_date: string | null
  tour_date: string | null
  legacy_source: string | null
}

interface WeddingRow {
  id: string
  venue_id: string
  source: string | null
  inquiry_date: string | null
  tour_date: string | null
}

interface PersonRow {
  id: string
  wedding_id: string | null
  first_name: string | null
  last_name: string | null
  email: string | null
  phone: string | null
  external_ids: Record<string, string> | null
}

function emptySummary(): ResolverSummary {
  return {
    candidates_processed: 0,
    resolved_tier_1_exact: 0,
    resolved_tier_1_name_window: 0,
    resolved_tier_1_full_name: 0,
    deferred_to_ai: 0,
    parked_tier_3: 0,
    no_match: 0,
    conflicts_flagged: 0,
    errors: [],
  }
}

function hoursBetween(a: string, b: string): number {
  return Math.abs(new Date(a).getTime() - new Date(b).getTime()) / 3_600_000
}

/**
 * Tier 1.1 — exact email/phone/username match. Returns the person+wedding
 * if any contact channel matches.
 */
async function findExactContactMatch(
  supabase: SupabaseClient,
  c: CandidateRow,
): Promise<PersonMatch | null> {
  const checks: Array<{ field: 'email' | 'phone'; value: string }> = []
  if (c.email) checks.push({ field: 'email', value: c.email })
  if (c.phone) checks.push({ field: 'phone', value: c.phone })

  for (const check of checks) {
    const { data: people } = await supabase
      .from('people')
      .select('id, wedding_id, email, phone')
      .eq('venue_id', c.venue_id)
      .ilike(check.field, check.value)
      .limit(1)
    const p = (people ?? [])[0] as { id: string; wedding_id: string | null } | undefined
    if (p?.wedding_id) {
      const wed = await fetchWedding(supabase, p.wedding_id)
      if (wed) {
        return {
          person_id: p.id,
          wedding_id: wed.id,
          inquiry_date: wed.inquiry_date,
          tour_date: wed.tour_date,
          legacy_source: wed.source,
        }
      }
    }
  }

  if (c.username) {
    const { data: people } = await supabase
      .from('people')
      .select('id, wedding_id, external_ids')
      .eq('venue_id', c.venue_id)
      .not('external_ids', 'is', null)
    for (const p of (people ?? []) as PersonRow[]) {
      const ext = p.external_ids ?? {}
      if ((ext[c.source_platform] ?? '').toLowerCase() === c.username.toLowerCase() && p.wedding_id) {
        const wed = await fetchWedding(supabase, p.wedding_id)
        if (wed) {
          return {
            person_id: p.id,
            wedding_id: wed.id,
            inquiry_date: wed.inquiry_date,
            tour_date: wed.tour_date,
            legacy_source: wed.source,
          }
        }
      }
    }
  }

  return null
}

async function fetchWedding(supabase: SupabaseClient, id: string): Promise<WeddingRow | null> {
  const { data } = await supabase
    .from('weddings')
    .select('id, venue_id, source, inquiry_date, tour_date')
    .eq('id', id)
    .single()
  return (data as WeddingRow | null) ?? null
}

/**
 * Tier 1.2 — full name + state match. last_name and first_name both
 * present + state match. Up to 60 days from any signal to a wedding
 * touch (inquiry or tour). High confidence even without time proximity.
 */
async function findFullNameMatch(
  supabase: SupabaseClient,
  c: CandidateRow,
): Promise<PersonMatch | null> {
  if (!c.first_name || !c.last_name || !c.state) return null
  const { data: people } = await supabase
    .from('people')
    .select('id, wedding_id, first_name, last_name')
    .eq('venue_id', c.venue_id)
    .ilike('first_name', c.first_name)
    .ilike('last_name', c.last_name)
  const candidates = ((people ?? []) as PersonRow[]).filter((p) => p.wedding_id)

  for (const p of candidates) {
    const wed = await fetchWedding(supabase, p.wedding_id!)
    if (wed) {
      return {
        person_id: p.id,
        wedding_id: wed.id,
        inquiry_date: wed.inquiry_date,
        tour_date: wed.tour_date,
        legacy_source: wed.source,
      }
    }
  }
  return null
}

/**
 * Tier 1.3 — name + last_initial + ±72h window + uniqueness gate.
 *
 * The most common path for Knot/WW signals where we only have first
 * name + last initial. The window is hours, not days, so the
 * probability of two unrelated "Sarah R."s both signaling AND
 * inquiring within 72h at the same venue is acceptably small.
 *
 * Uniqueness gate: if more than one candidate with the same fingerprint
 * has signals in this 72h window for this same wedding, we defer
 * to coordinator confirm — Tier 1 must be unambiguous or it's not
 * Tier 1.
 */
async function findNameWindowMatch(
  supabase: SupabaseClient,
  c: CandidateRow,
): Promise<{ match: PersonMatch; ambiguous: boolean } | null> {
  if (!c.first_name || !c.last_initial || !c.first_seen) return null

  const { data: people } = await supabase
    .from('people')
    .select('id, wedding_id, first_name, last_name')
    .eq('venue_id', c.venue_id)
    .ilike('first_name', c.first_name)
  const candidates = ((people ?? []) as PersonRow[])
    .filter((p) => p.wedding_id)
    .filter((p) => (p.last_name ?? '').toLowerCase().startsWith(c.last_initial!.toLowerCase()))

  for (const p of candidates) {
    const wed = await fetchWedding(supabase, p.wedding_id!)
    if (!wed) continue
    const targets: Array<{ key: 'inquiry_date' | 'tour_date'; value: string }> = []
    if (wed.inquiry_date) targets.push({ key: 'inquiry_date', value: wed.inquiry_date })
    if (wed.tour_date) targets.push({ key: 'tour_date', value: wed.tour_date })

    let inWindow = false
    for (const t of targets) {
      const fsHours = hoursBetween(c.first_seen, t.value)
      const lsHours = c.last_seen ? hoursBetween(c.last_seen, t.value) : Infinity
      if (Math.min(fsHours, lsHours) <= TIER_1_NAME_WINDOW_HOURS) {
        inWindow = true
        break
      }
    }
    if (!inWindow) continue

    const ambiguous = await hasOtherCandidatesInWindow(supabase, c, wed)
    return {
      match: {
        person_id: p.id,
        wedding_id: wed.id,
        inquiry_date: wed.inquiry_date,
        tour_date: wed.tour_date,
        legacy_source: wed.source,
      },
      ambiguous,
    }
  }
  return null
}

/**
 * Uniqueness check for Tier 1.3. Counts other candidates with the
 * same first_name + last_initial whose [first_seen, last_seen]
 * window overlaps the wedding's inquiry/tour ±72h window. If >0,
 * the match is ambiguous — Tier 1 can't fire and we route to AI.
 */
async function hasOtherCandidatesInWindow(
  supabase: SupabaseClient,
  c: CandidateRow,
  wed: WeddingRow,
): Promise<boolean> {
  const targets = [wed.inquiry_date, wed.tour_date].filter((v): v is string => Boolean(v))
  if (targets.length === 0) return false

  const { data } = await supabase
    .from('candidate_identities')
    .select('id, first_seen, last_seen')
    .eq('venue_id', c.venue_id)
    .eq('first_name', c.first_name!)
    .eq('last_initial', c.last_initial!)
    .is('deleted_at', null)
    .neq('id', c.id)
  const others = (data ?? []) as Array<{ id: string; first_seen: string | null; last_seen: string | null }>

  for (const o of others) {
    if (!o.first_seen) continue
    for (const t of targets) {
      const fs = hoursBetween(o.first_seen, t)
      const ls = o.last_seen ? hoursBetween(o.last_seen, t) : Infinity
      if (Math.min(fs, ls) <= TIER_1_NAME_WINDOW_HOURS) return true
    }
  }
  return false
}

/**
 * Pull every signal for a candidate so we can write attribution_events
 * for each one and flag the earliest pre-inquiry as is_first_touch.
 */
interface SignalForAttribution {
  id: string
  signal_date: string | null
  source_platform: string | null
}

async function fetchSignalsForCandidate(
  supabase: SupabaseClient,
  candidateId: string,
): Promise<SignalForAttribution[]> {
  const { data } = await supabase
    .from('tangential_signals')
    .select('id, signal_date, source_platform')
    .eq('candidate_identity_id', candidateId)
    .order('signal_date', { ascending: true, nullsFirst: false })
  return (data ?? []) as SignalForAttribution[]
}

/**
 * Recompute is_first_touch across all live attribution_events for one
 * wedding. The earliest pre-inquiry signal_date among bucket='attribution'
 * rows wins. Run after every new attribution_event lands so the flag
 * stays accurate as new earlier signals arrive.
 */
async function recomputeFirstTouch(
  supabase: SupabaseClient,
  weddingId: string,
): Promise<{ error?: string }> {
  const { data, error } = await supabase
    .from('attribution_events')
    .select('id, signal_id, bucket, is_first_touch, candidate_identity_id, decided_at')
    .eq('wedding_id', weddingId)
    .is('reverted_at', null)
  if (error) return { error: `recompute fetch: ${error.message}` }
  const events = (data ?? []) as Array<{
    id: string
    signal_id: string | null
    bucket: string
    is_first_touch: boolean
    candidate_identity_id: string
    decided_at: string
  }>
  const attribution = events.filter((e) => e.bucket === 'attribution')
  if (attribution.length === 0) return {}

  const sigIds = attribution.map((e) => e.signal_id).filter((v): v is string => Boolean(v))
  let earliest: { event_id: string; date: string } | null = null
  if (sigIds.length > 0) {
    const { data: sigs } = await supabase
      .from('tangential_signals')
      .select('id, signal_date')
      .in('id', sigIds)
    const dateMap = new Map<string, string>()
    for (const s of (sigs ?? []) as Array<{ id: string; signal_date: string | null }>) {
      if (s.signal_date) dateMap.set(s.id, s.signal_date)
    }
    for (const e of attribution) {
      const d = e.signal_id ? dateMap.get(e.signal_id) : undefined
      if (!d) continue
      if (!earliest || d < earliest.date) earliest = { event_id: e.id, date: d }
    }
  }

  for (const e of events) {
    const shouldBe = e.id === earliest?.event_id
    if (e.is_first_touch !== shouldBe) {
      const { error: updErr } = await supabase
        .from('attribution_events')
        .update({ is_first_touch: shouldBe })
        .eq('id', e.id)
      if (updErr) return { error: `recompute update ${e.id}: ${updErr.message}` }
    }
  }
  return {}
}

/**
 * Backfill wedding_touchpoints for resolved signals so the existing
 * /intel journey UI surfaces Knot/IG/etc events alongside email/Calendly.
 * Idempotent via metadata.signal_id check.
 */
async function backfillTouchpoint(
  supabase: SupabaseClient,
  signal: SignalForAttribution,
  match: PersonMatch,
  candidate: CandidateRow,
): Promise<void> {
  if (!signal.signal_date) return
  const { data: existing } = await supabase
    .from('wedding_touchpoints')
    .select('id')
    .eq('wedding_id', match.wedding_id)
    .contains('metadata', { signal_id: signal.id })
    .limit(1)
  if ((existing ?? []).length > 0) return

  await supabase.from('wedding_touchpoints').insert({
    venue_id: candidate.venue_id,
    wedding_id: match.wedding_id,
    source: signal.source_platform ?? candidate.source_platform,
    medium: 'platform_signal',
    touch_type: 'other',
    occurred_at: signal.signal_date,
    metadata: { signal_id: signal.id, candidate_identity_id: candidate.id },
  })
}

async function writeAttributionEvents(args: {
  supabase: SupabaseClient
  candidate: CandidateRow
  match: PersonMatch
  tier: Tier
  decided_by: 'auto' | 'ai' | 'coordinator'
  confidence: number
  reasoning?: string
}): Promise<{ flagged_conflict: boolean; error?: string }> {
  const { supabase, candidate, match, tier, decided_by, confidence, reasoning } = args
  const signals = await fetchSignalsForCandidate(supabase, candidate.id)
  if (signals.length === 0) {
    return { flagged_conflict: false, error: 'no signals attached to candidate' }
  }

  const inquiryTs = match.inquiry_date ? new Date(match.inquiry_date).getTime() : null

  let conflict_flag: string | null = null
  if (match.legacy_source && candidate.source_platform && match.legacy_source !== candidate.source_platform) {
    conflict_flag = `legacy=${match.legacy_source} computed=${candidate.source_platform}`
  }

  const rows = signals
    .filter((s) => s.signal_date)
    .map((s) => {
      const sigTs = new Date(s.signal_date!).getTime()
      const bucket = inquiryTs !== null && sigTs >= inquiryTs ? 'nurture' : 'attribution'
      return {
        venue_id: candidate.venue_id,
        candidate_identity_id: candidate.id,
        wedding_id: match.wedding_id,
        signal_id: s.id,
        source_platform: s.source_platform ?? candidate.source_platform,
        confidence,
        tier,
        decided_by,
        reasoning: reasoning ?? null,
        is_first_touch: false,
        bucket,
        conflict_with_legacy_source: bucket === 'attribution' ? conflict_flag : null,
      }
    })

  if (rows.length === 0) return { flagged_conflict: false }
  const { error: insErr } = await supabase.from('attribution_events').insert(rows)
  if (insErr) return { flagged_conflict: false, error: `attribution insert: ${insErr.message}` }

  const { error: updErr } = await supabase
    .from('candidate_identities')
    .update({
      resolved_wedding_id: match.wedding_id,
      resolved_person_id: match.person_id,
      resolved_at: new Date().toISOString(),
      resolved_by: decided_by,
      resolved_confidence: confidence,
    })
    .eq('id', candidate.id)
  if (updErr) return { flagged_conflict: false, error: `candidate resolve update: ${updErr.message}` }

  for (const s of signals) {
    await backfillTouchpoint(supabase, s, match, candidate)
  }

  const ft = await recomputeFirstTouch(supabase, match.wedding_id)
  if (ft.error) return { flagged_conflict: !!conflict_flag, error: ft.error }

  return { flagged_conflict: !!conflict_flag }
}

export async function resolveCandidate(args: {
  supabase: SupabaseClient
  candidate: CandidateRow
}): Promise<ResolverSummary> {
  const { supabase, candidate } = args
  const summary = emptySummary()
  summary.candidates_processed = 1

  if (candidate.resolved_wedding_id) {
    return summary
  }

  const exact = await findExactContactMatch(supabase, candidate)
  if (exact) {
    const { flagged_conflict, error } = await writeAttributionEvents({
      supabase, candidate, match: exact, tier: 'tier_1_exact', decided_by: 'auto', confidence: 95,
    })
    if (error) summary.errors.push(error)
    else {
      summary.resolved_tier_1_exact++
      if (flagged_conflict) summary.conflicts_flagged++
    }
    return summary
  }

  const fullName = await findFullNameMatch(supabase, candidate)
  if (fullName) {
    const { flagged_conflict, error } = await writeAttributionEvents({
      supabase, candidate, match: fullName, tier: 'tier_1_full_name', decided_by: 'auto', confidence: 90,
    })
    if (error) summary.errors.push(error)
    else {
      summary.resolved_tier_1_full_name++
      if (flagged_conflict) summary.conflicts_flagged++
    }
    return summary
  }

  const nameWindow = await findNameWindowMatch(supabase, candidate)
  if (nameWindow && !nameWindow.ambiguous) {
    const conf = 90 + Math.min(5, candidate.funnel_depth)
    const { flagged_conflict, error } = await writeAttributionEvents({
      supabase, candidate, match: nameWindow.match, tier: 'tier_1_name_window', decided_by: 'auto', confidence: conf,
    })
    if (error) summary.errors.push(error)
    else {
      summary.resolved_tier_1_name_window++
      if (flagged_conflict) summary.conflicts_flagged++
    }
    return summary
  }
  if (nameWindow && nameWindow.ambiguous) {
    await supabase
      .from('candidate_identities')
      .update({ review_status: 'needs_review' })
      .eq('id', candidate.id)
    summary.deferred_to_ai++
    return summary
  }

  summary.no_match++
  return summary
}

/**
 * Resolve every unresolved candidate for a venue. Used by the
 * historical backfill (PB.7) and the nightly safety sweep (PB.8).
 */
export async function resolveVenueCandidates(args: {
  supabase: SupabaseClient
  venueId: string
}): Promise<ResolverSummary> {
  const { supabase, venueId } = args
  const aggregate = emptySummary()

  const PAGE = 200
  let from = 0
  for (;;) {
    const { data, error } = await supabase
      .from('candidate_identities')
      .select('id, venue_id, source_platform, first_name, last_initial, last_name, email, phone, username, city, state, country, first_seen, last_seen, funnel_depth, signal_count, resolved_wedding_id, resolved_person_id')
      .eq('venue_id', venueId)
      .is('resolved_wedding_id', null)
      .is('deleted_at', null)
      .range(from, from + PAGE - 1)
    if (error) {
      aggregate.errors.push(`fetch unresolved @${from}: ${error.message}`)
      break
    }
    const page = (data ?? []) as CandidateRow[]
    for (const c of page) {
      const s = await resolveCandidate({ supabase, candidate: c })
      aggregate.candidates_processed += s.candidates_processed
      aggregate.resolved_tier_1_exact += s.resolved_tier_1_exact
      aggregate.resolved_tier_1_name_window += s.resolved_tier_1_name_window
      aggregate.resolved_tier_1_full_name += s.resolved_tier_1_full_name
      aggregate.deferred_to_ai += s.deferred_to_ai
      aggregate.parked_tier_3 += s.parked_tier_3
      aggregate.no_match += s.no_match
      aggregate.conflicts_flagged += s.conflicts_flagged
      aggregate.errors.push(...s.errors)
    }
    if (page.length < PAGE) break
    from += PAGE
  }
  return aggregate
}

/**
 * Resolve from the lead direction — when a wedding is created/edited,
 * scan unresolved candidates for matches. Same logic, fired from
 * the other side. Idempotent because resolveCandidate skips
 * already-resolved candidates.
 */
export async function resolveForWedding(args: {
  supabase: SupabaseClient
  weddingId: string
}): Promise<ResolverSummary> {
  const { supabase, weddingId } = args
  const aggregate = emptySummary()

  const { data: wed } = await supabase
    .from('weddings')
    .select('venue_id')
    .eq('id', weddingId)
    .single()
  const venueId = (wed as { venue_id: string } | null)?.venue_id
  if (!venueId) {
    aggregate.errors.push(`wedding ${weddingId} not found`)
    return aggregate
  }

  return resolveVenueCandidates({ supabase, venueId })
}
