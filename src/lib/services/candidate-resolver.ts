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
import { normalizeSource } from './normalize-source'
import {
  adjudicateAmbiguousMatch,
  fetchWeddingContext,
  type CandidateContextForAI,
} from './candidate-ai-adjudicator'
import { recalculateHeatScore } from './heat-mapping'
import {
  loadPerPlatformWindows,
  windowsForPlatform,
  type PerPlatformWindowMap,
} from './identity-windows'

// Hard-coded fallbacks. Per-platform overrides flow through
// loadPerPlatformWindows + windowsForPlatform (T2-D / ARCH-8.5.3).
// These constants are now the last-resort floor when neither the
// venue config nor the platform map produces a value — matching
// pre-T2-D behaviour for any code path that doesn't pass a
// PerPlatformWindowMap (legacy test paths, etc.).
const TIER_1_NAME_WINDOW_HOURS = 72
const TIER_2_WIDE_WINDOW_HOURS = 30 * 24
const AI_CONFIDENT_THRESHOLD = 70
// The AI adjudicator's system prompt is calibrated for "2 or more"
// candidate weddings — in practice 2-5 at the Tier 1 ±72h scope.
// At Tier 2 ±30d a common name + busy venue could in theory match
// many more, which would balloon the prompt and degrade AI confidence
// calibration (picking 1-of-15 is materially harder than 1-of-3).
// Above this cap, defer to coordinator without invoking AI. Picked
// 12 as a soft ceiling — high enough that real match sets always
// fit, low enough to catch a pathological case before it costs
// money or returns garbage.
const MAX_AI_CANDIDATES = 12

type Tier =
  | 'tier_1_exact'
  | 'tier_1_name_window'
  | 'tier_1_full_name'
  | 'tier_2_ai'
  | 'tier_2_wide_ai'
  | 'tier_2_coordinator'
  | 'tier_3_manual'

export interface ResolverSummary {
  candidates_processed: number
  resolved_tier_1_exact: number
  resolved_tier_1_name_window: number
  resolved_tier_1_full_name: number
  resolved_tier_2_ai: number
  resolved_tier_2_wide_ai: number
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
    resolved_tier_2_ai: 0,
    resolved_tier_2_wide_ai: 0,
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
 * Tier 1.3 / Tier 2 — find ALL weddings whose people match the
 * candidate's first_name + last_initial AND have inquiry/tour within
 * ±72h of any candidate signal.
 *
 * Returns:
 *   - matches: every viable wedding (deduplicated by wedding_id)
 *   - other_candidates_in_window: true if a SECOND candidate cluster
 *     with the same fingerprint also sits in the same window — that
 *     ambiguity goes to coordinator, not AI (AI can't tell which
 *     candidate cluster belongs to the lead without coordinator
 *     context).
 *
 * Caller decides:
 *   - matches.length === 1 + !other_candidates_in_window → Tier 1 auto-link
 *   - matches.length === 1 + other_candidates_in_window  → coordinator queue
 *   - matches.length  >= 2                               → AI adjudicator
 *   - matches.length === 0                               → no_match
 */
async function findNameWindowMatches(
  supabase: SupabaseClient,
  c: CandidateRow,
  windowHours: number = TIER_1_NAME_WINDOW_HOURS,
  /** Tier 2 callers don't consult `other_candidates_in_window` (the
   *  output is always routed to AI regardless), so they pass false to
   *  skip the competitor pre-fetch. Saves one DB roundtrip per
   *  Tier-2-reaching candidate. */
  needsCompetitorCheck: boolean = true,
): Promise<{ matches: PersonMatch[]; other_candidates_in_window: boolean } | null> {
  if (!c.first_name || !c.last_initial || !c.first_seen) return null

  const { data: people } = await supabase
    .from('people')
    .select('id, wedding_id, first_name, last_name')
    .eq('venue_id', c.venue_id)
    .ilike('first_name', c.first_name)
  const peopleRows = ((people ?? []) as PersonRow[])
    .filter((p) => p.wedding_id)
    .filter((p) => (p.last_name ?? '').toLowerCase().startsWith(c.last_initial!.toLowerCase()))

  // Audit 2 / fix #1 + #2 (2026-04-30): batch the fetches.
  // Before: per-person fetchWedding (N+1) + per-match
  // hasOtherCandidatesInWindow (same query repeated per wedding).
  // After: one bulk wedding fetch by id list, one competitor-
  // candidate fetch per resolveCandidate call. The competitor
  // candidate set is fingerprint-scoped and doesn't change across
  // matches in this resolveCandidate call — fetch it once, then
  // check overlap in memory per wedding.
  const candidateWeddingIds = Array.from(
    new Set(peopleRows.map((p) => p.wedding_id).filter((v): v is string => Boolean(v))),
  )
  const wedMap = new Map<string, WeddingRow>()
  if (candidateWeddingIds.length > 0) {
    const CHUNK = 100
    for (let i = 0; i < candidateWeddingIds.length; i += CHUNK) {
      const chunk = candidateWeddingIds.slice(i, i + CHUNK)
      const { data: weds } = await supabase
        .from('weddings')
        .select('id, venue_id, source, inquiry_date, tour_date')
        .in('id', chunk)
      for (const w of (weds ?? []) as WeddingRow[]) wedMap.set(w.id, w)
    }
  }

  // Pre-fetch competitor candidates ONCE: same fingerprint, this
  // venue, not us. We'll check window overlap per wedding in memory.
  // Skipped on Tier 2 wide-window calls — the caller routes straight
  // to AI regardless of competitors.
  let competitors: Array<{ id: string; first_seen: string | null; last_seen: string | null }> = []
  if (needsCompetitorCheck) {
    const { data: competitorRows } = await supabase
      .from('candidate_identities')
      .select('id, first_seen, last_seen')
      .eq('venue_id', c.venue_id)
      .eq('first_name', c.first_name!)
      .eq('last_initial', c.last_initial!)
      .is('deleted_at', null)
      .neq('id', c.id)
    competitors = (competitorRows ?? []) as Array<{ id: string; first_seen: string | null; last_seen: string | null }>
  }

  const matches: PersonMatch[] = []
  const seenWeddings = new Set<string>()
  let other_candidates_in_window = false

  for (const p of peopleRows) {
    if (!p.wedding_id || seenWeddings.has(p.wedding_id)) continue
    const wed = wedMap.get(p.wedding_id)
    if (!wed) continue

    const targets: string[] = []
    if (wed.inquiry_date) targets.push(wed.inquiry_date)
    if (wed.tour_date) targets.push(wed.tour_date)

    let inWindow = false
    for (const t of targets) {
      const fsHours = hoursBetween(c.first_seen, t)
      const lsHours = c.last_seen ? hoursBetween(c.last_seen, t) : Infinity
      if (Math.min(fsHours, lsHours) <= windowHours) {
        inWindow = true
        break
      }
    }
    if (!inWindow) continue

    seenWeddings.add(wed.id)
    matches.push({
      person_id: p.id,
      wedding_id: wed.id,
      inquiry_date: wed.inquiry_date,
      tour_date: wed.tour_date,
      legacy_source: wed.source,
    })

    if (!other_candidates_in_window && targets.length > 0) {
      // In-memory overlap check against pre-fetched competitor list.
      for (const o of competitors) {
        if (!o.first_seen) continue
        for (const t of targets) {
          const fs = hoursBetween(o.first_seen, t)
          const ls = o.last_seen ? hoursBetween(o.last_seen, t) : Infinity
          if (Math.min(fs, ls) <= windowHours) {
            other_candidates_in_window = true
            break
          }
        }
        if (other_candidates_in_window) break
      }
    }
  }

  if (matches.length === 0) return null
  return { matches, other_candidates_in_window }
}

/**
 * Pull every signal for a candidate so we can write attribution_events
 * for each one and flag the earliest pre-inquiry as is_first_touch.
 */
interface SignalForAttribution {
  id: string
  signal_date: string | null
  source_platform: string | null
  /** Carried through to wedding_touchpoints.metadata so the journey
   *  UI can render "Knot save" / "Knot message" instead of a generic
   *  "Other touchpoint via platform_signal". */
  action_class: string | null
}

async function fetchSignalsForCandidate(
  supabase: SupabaseClient,
  candidateId: string,
): Promise<SignalForAttribution[]> {
  const { data } = await supabase
    .from('tangential_signals')
    .select('id, signal_date, source_platform, action_class')
    .eq('candidate_identity_id', candidateId)
    .order('signal_date', { ascending: true, nullsFirst: false })
  return (data ?? []) as SignalForAttribution[]
}

/**
 * Recompute attribution_events.bucket for every live row on a wedding.
 * Bucket logic mirrors the INSERT-time rule at line 550:
 *   signal_date >= inquiry_date → 'nurture' (post-point-zero touch)
 *   signal_date <  inquiry_date → 'attribution' (pre-point-zero touch)
 *
 * Migration 119 installs a Postgres trigger that recomputes BOTH
 * bucket and is_first_touch atomically on every weddings UPDATE OF
 * inquiry_date — that's the primary defense (can never be forgotten
 * by a code path). This service-side helper exists for callers that
 * want to perform the recompute in their own transaction — e.g.,
 * scripts that bulk-update via service-role queries that bypass the
 * trigger, or callers that want to invoke recompute without triggering
 * the inquiry_date column UPDATE itself (rare).
 *
 * Note: callers that update weddings.inquiry_date through normal
 * Supabase client paths get the trigger automatically — they DO NOT
 * need to call this helper. It's the explicit-invocation path for
 * edge cases.
 *
 * Per Playbook INV-2.5 + Part 12.3 (recomputation when event times change).
 */
export async function recomputeBucketsForWedding(
  supabase: SupabaseClient,
  weddingId: string,
): Promise<{ error?: string }> {
  const { data: wed, error: wedErr } = await supabase
    .from('weddings')
    .select('inquiry_date')
    .eq('id', weddingId)
    .single()
  if (wedErr) return { error: `recompute buckets fetch wedding: ${wedErr.message}` }
  const inquiryTs = wed.inquiry_date
    ? new Date(wed.inquiry_date as string).getTime()
    : null

  const { data: events, error: evErr } = await supabase
    .from('attribution_events')
    .select('id, signal_id, bucket')
    .eq('wedding_id', weddingId)
    .is('reverted_at', null)
  if (evErr) return { error: `recompute buckets fetch events: ${evErr.message}` }
  const rows = (events ?? []) as Array<{ id: string; signal_id: string | null; bucket: string }>
  if (rows.length === 0) return {}

  const sigIds = rows.map((r) => r.signal_id).filter((v): v is string => Boolean(v))
  const dateMap = new Map<string, string | null>()
  if (sigIds.length > 0) {
    const { data: sigs } = await supabase
      .from('tangential_signals')
      .select('id, signal_date')
      .in('id', sigIds)
    for (const s of (sigs ?? []) as Array<{ id: string; signal_date: string | null }>) {
      dateMap.set(s.id, s.signal_date)
    }
  }

  for (const r of rows) {
    const sigDate = r.signal_id ? dateMap.get(r.signal_id) ?? null : null
    const sigTs = sigDate ? new Date(sigDate).getTime() : null
    const expectedBucket =
      inquiryTs !== null && sigTs !== null && sigTs >= inquiryTs
        ? 'nurture'
        : 'attribution'
    if (r.bucket !== expectedBucket) {
      const { error: updErr } = await supabase
        .from('attribution_events')
        .update({ bucket: expectedBucket })
        .eq('id', r.id)
      if (updErr) return { error: `recompute bucket update ${r.id}: ${updErr.message}` }
    }
  }
  return {}
}

/**
 * Recompute is_first_touch across all live attribution_events for one
 * wedding. The earliest pre-inquiry signal_date among bucket='attribution'
 * rows wins. Run after every new attribution_event lands so the flag
 * stays accurate as new earlier signals arrive — and after a coordinator
 * reverts a row from the lead detail or review queue UI.
 */
export async function recomputeFirstTouch(
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
    metadata: {
      signal_id: signal.id,
      candidate_identity_id: candidate.id,
      // Carried so the wedding-journey UI can render "Knot save"
      // instead of a generic "Other touchpoint via platform_signal".
      action_class: signal.action_class,
      source_platform: signal.source_platform ?? candidate.source_platform,
    },
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

  // Both sides normalized through normalizeSource so naming drift
  // (wedding_wire vs weddingwire, google_business vs google) doesn't
  // produce false-positive conflicts. Only real disagreement flags.
  let conflict_flag: string | null = null
  if (match.legacy_source && candidate.source_platform) {
    const legacyNorm = normalizeSource(match.legacy_source)
    const computedNorm = normalizeSource(candidate.source_platform)
    if (legacyNorm !== computedNorm && legacyNorm !== 'other' && computedNorm !== 'other') {
      conflict_flag = `legacy=${legacyNorm} computed=${computedNorm}`
    }
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

  // PD.1 fix #1 (2026-04-30): platform-signal attribution should
  // immediately influence the heat score. Without this, the Phase B
  // contribution from D1.1 stays cold until the next engagement_event
  // or daily decay sweep — sometimes 24h. Best-effort, never throws:
  // a heat-recalc failure shouldn't roll back the attribution write.
  try {
    await recalculateHeatScore(candidate.venue_id, match.wedding_id)
  } catch (err) {
    console.warn('[resolver] post-attribution heat recalc failed:', err)
  }

  return { flagged_conflict: !!conflict_flag }
}

/**
 * Hand a set of candidate-wedding matches to the AI adjudicator,
 * write the attribution if the AI is confident, otherwise mark for
 * coordinator review. Used by both the Tier 1 ambiguous-multi path
 * (tier='tier_2_ai') and the Tier 2 wide-window path
 * (tier='tier_2_wide_ai'). Same writer, different label so the
 * /intel/sources analytics can split the tight-window AI decisions
 * from the wide-window ones.
 *
 * skipAI=true short-circuits to coordinator queue without invoking
 * the AI — used by the nightly sweep so it doesn't pay AI cost on
 * every retry of an ambiguous candidate.
 */
async function runAIAdjudication(args: {
  supabase: SupabaseClient
  candidate: CandidateRow
  matches: PersonMatch[]
  summary: ResolverSummary
  /** Tier label written on the attribution_event row when the AI
   *  decides confidently. The two values map to the same writer logic
   *  and confidence bar; only the analytics slice differs. */
  tier: 'tier_2_ai' | 'tier_2_wide_ai'
  skipAI?: boolean
}): Promise<ResolverSummary> {
  const { supabase, candidate, matches, summary, tier, skipAI } = args

  await supabase
    .from('candidate_identities')
    .update({ review_status: 'needs_review' })
    .eq('id', candidate.id)

  if (skipAI) {
    summary.deferred_to_ai++
    return summary
  }

  // Pathological-fanout guard. See MAX_AI_CANDIDATES. We never invoke
  // the AI on a set bigger than the prompt was calibrated for —
  // coordinator gets the candidate in the review queue instead.
  if (matches.length > MAX_AI_CANDIDATES) {
    summary.errors.push(
      `ai adjudicate ${candidate.id}: ${matches.length} candidate weddings exceeds MAX_AI_CANDIDATES=${MAX_AI_CANDIDATES}, deferring to coordinator`,
    )
    summary.deferred_to_ai++
    return summary
  }

  let aiVerdict: { match_wedding_id: string | null; confidence: number; reasoning: string } | null = null
  try {
    const candCtx: CandidateContextForAI = {
      id: candidate.id,
      source_platform: candidate.source_platform,
      first_name: candidate.first_name!,
      last_initial: candidate.last_initial!,
      last_name: candidate.last_name,
      state: candidate.state,
      city: candidate.city,
      signal_count: candidate.signal_count,
      funnel_depth: candidate.funnel_depth,
      action_counts: {},
      first_seen: candidate.first_seen,
      last_seen: candidate.last_seen,
    }
    const wedCtxs = (await Promise.all(
      matches.map((m) => fetchWeddingContext(supabase, m.wedding_id)),
    )).filter((v): v is NonNullable<typeof v> => Boolean(v))
    aiVerdict = await adjudicateAmbiguousMatch({
      candidate: candCtx,
      candidates: wedCtxs,
      venueId: candidate.venue_id,
    })
  } catch (err) {
    summary.errors.push(`ai adjudicate ${candidate.id}: ${err instanceof Error ? err.message : String(err)}`)
  }

  if (aiVerdict && aiVerdict.match_wedding_id && aiVerdict.confidence >= AI_CONFIDENT_THRESHOLD) {
    const chosen = matches.find((m) => m.wedding_id === aiVerdict!.match_wedding_id)
    if (chosen) {
      const { flagged_conflict, error } = await writeAttributionEvents({
        supabase, candidate, match: chosen,
        tier, decided_by: 'ai', confidence: aiVerdict.confidence,
        reasoning: aiVerdict.reasoning,
      })
      if (error) summary.errors.push(error)
      else {
        if (tier === 'tier_2_wide_ai') summary.resolved_tier_2_wide_ai++
        else summary.resolved_tier_2_ai++
        if (flagged_conflict) summary.conflicts_flagged++
      }
      return summary
    } else {
      // AI returned a UUID we don't recognize — hallucination or
      // race. Log so the coordinator can investigate instead of
      // silently falling through.
      summary.errors.push(
        `ai adjudicate ${candidate.id}: returned unrecognized wedding_id "${aiVerdict.match_wedding_id}" (confidence ${aiVerdict.confidence})`,
      )
    }
  }
  summary.deferred_to_ai++
  return summary
}

export async function resolveCandidate(args: {
  supabase: SupabaseClient
  candidate: CandidateRow
  /** Skip the AI adjudicator on Tier 2 ambiguity (cron sweep, backfill
   *  --no-ai). Without this, the nightly sweep would call Claude every
   *  night for every still-ambiguous candidate — at scale that's real
   *  money on retries that almost never resolve. AI is run once at
   *  import time; sweep just leaves them needs_review. */
  skipAI?: boolean
}): Promise<ResolverSummary> {
  const { supabase, candidate, skipAI = false } = args
  const summary = emptySummary()
  summary.candidates_processed = 1

  if (candidate.resolved_wedding_id) {
    return summary
  }

  // T2-D: Fetch per-platform windows once per candidate. Falls back to
  // platform-aware defaults (Knot 365d, Pinterest 540d, Instagram 180d,
  // GMB 1w/30d) overlaid with any per-venue overrides from
  // venue_config.identity_match_config.per_platform.
  const platformWindows = await loadPerPlatformWindows(supabase, candidate.venue_id)
  const w = windowsForPlatform(platformWindows, candidate.source_platform)

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

  // Tier 1: attempt name + last_initial within the platform's
  // tier_1_hours window. Single match with no competing candidates
  // auto-links at high confidence. Multiple matches go to AI
  // adjudicator. Single match with competitors goes to coordinator
  // queue. Per-platform window per ARCH-8.5.3 / T2-D — Knot 72h,
  // Pinterest 72h, Instagram 72h, GMB 168h (1 week).
  const tier1 = await findNameWindowMatches(supabase, candidate, w.tier_1_hours)

  if (tier1 && tier1.matches.length === 1 && !tier1.other_candidates_in_window) {
    const conf = 90 + Math.min(5, candidate.funnel_depth)
    const { flagged_conflict, error } = await writeAttributionEvents({
      supabase, candidate, match: tier1.matches[0],
      tier: 'tier_1_name_window', decided_by: 'auto', confidence: conf,
    })
    if (error) summary.errors.push(error)
    else {
      summary.resolved_tier_1_name_window++
      if (flagged_conflict) summary.conflicts_flagged++
    }
    return summary
  }

  if (tier1 && tier1.matches.length >= 2) {
    return runAIAdjudication({
      supabase, candidate, matches: tier1.matches, summary,
      tier: 'tier_2_ai', skipAI,
    })
  }

  if (tier1 && tier1.matches.length === 1 && tier1.other_candidates_in_window) {
    await supabase
      .from('candidate_identities')
      .update({ review_status: 'needs_review' })
      .eq('id', candidate.id)
    summary.deferred_to_ai++
    return summary
  }

  // Tier 2 wide window — per-platform tier_2_days converted to
  // hours. Knot/WW/Zola 365d, Pinterest 540d, Instagram/Facebook
  // 180d, GMB 30d. Pre-T2-D this was a global 30 days for every
  // platform — Knot Audit (2026-04-30) found 4/785 matched at ±72h
  // because most engagements precede the inquiry by weeks-to-months
  // and the global 30d cap missed the long tail. Wide window always
  // routes to AI since the confidence at this scope is below the
  // auto-link bar (ANTI-8.4-B).
  const tier2HoursForPlatform = w.tier_2_days * 24
  const tier2 = await findNameWindowMatches(
    supabase, candidate, tier2HoursForPlatform, /* needsCompetitorCheck */ false,
  )
  if (!tier2 || tier2.matches.length === 0) {
    summary.no_match++
    return summary
  }
  return runAIAdjudication({
    supabase, candidate, matches: tier2.matches, summary,
    tier: 'tier_2_wide_ai', skipAI,
  })
}

/**
 * Resolve unresolved candidates for a venue.
 *
 * Pass `candidateIds` to scope the run to a specific batch (e.g. the
 * candidates a brain-dump CSV import just produced) — this is the
 * common case after Phase A. Without `candidateIds`, scans every
 * unresolved candidate in the venue (the path used by the historical
 * backfill (PB.7) and nightly safety sweep (PB.8)).
 *
 * Pass `updatedSince` to scope to candidates touched since a
 * timestamp — used by the nightly sweep to catch candidates whose
 * aggregates changed but whose previous resolver run failed.
 */
export async function resolveVenueCandidates(args: {
  supabase: SupabaseClient
  venueId: string
  candidateIds?: readonly string[]
  updatedSince?: string
  /** Filter to one platform — used by the backfill --platform flag so
   *  the resolver step matches the clusterer step's scope. */
  platform?: string
  /** Skip AI adjudicator on Tier 2 ambiguity. Used by the cron sweep
   *  and backfill --no-ai. */
  skipAI?: boolean
}): Promise<ResolverSummary> {
  const { supabase, venueId, candidateIds, updatedSince, platform, skipAI } = args
  const aggregate = emptySummary()

  if (candidateIds !== undefined && candidateIds.length === 0) {
    return aggregate
  }

  // PostgREST drops `.in()` filters once the URL gets too long
  // (around 100+ UUIDs). Chunk the candidate ID list ourselves so a
  // 785-candidate import doesn't silently match zero rows.
  const ID_CHUNK = 100
  const idChunks = candidateIds && candidateIds.length > 0
    ? Array.from({ length: Math.ceil(candidateIds.length / ID_CHUNK) }, (_, i) =>
        (candidateIds as string[]).slice(i * ID_CHUNK, (i + 1) * ID_CHUNK))
    : [null]

  const processCandidate = async (c: CandidateRow) => {
    const s = await resolveCandidate({ supabase, candidate: c, skipAI })
    aggregate.candidates_processed += s.candidates_processed
    aggregate.resolved_tier_1_exact += s.resolved_tier_1_exact
    aggregate.resolved_tier_1_name_window += s.resolved_tier_1_name_window
    aggregate.resolved_tier_1_full_name += s.resolved_tier_1_full_name
    aggregate.resolved_tier_2_ai += s.resolved_tier_2_ai
    aggregate.resolved_tier_2_wide_ai += s.resolved_tier_2_wide_ai
    aggregate.deferred_to_ai += s.deferred_to_ai
    aggregate.parked_tier_3 += s.parked_tier_3
    aggregate.no_match += s.no_match
    aggregate.conflicts_flagged += s.conflicts_flagged
    aggregate.errors.push(...s.errors)
  }

  for (const chunk of idChunks) {
    const PAGE = 200
    let from = 0
    for (;;) {
      let q = supabase
        .from('candidate_identities')
        .select('id, venue_id, source_platform, first_name, last_initial, last_name, email, phone, username, city, state, country, first_seen, last_seen, funnel_depth, signal_count, resolved_wedding_id, resolved_person_id')
        .eq('venue_id', venueId)
        .is('resolved_wedding_id', null)
        .is('deleted_at', null)
        .range(from, from + PAGE - 1)
      if (chunk) q = q.in('id', chunk)
      if (updatedSince) q = q.gte('updated_at', updatedSince)
      if (platform) q = q.eq('source_platform', platform)
      const { data, error } = await q
      if (error) {
        aggregate.errors.push(`fetch unresolved @${from}: ${error.message}`)
        break
      }
      const page = (data ?? []) as CandidateRow[]
      for (const c of page) await processCandidate(c)
      if (page.length < PAGE) break
      from += PAGE
    }
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
