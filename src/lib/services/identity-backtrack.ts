/**
 * Identity backtrack service (Stream T5-Rixey-CCC, 2026-05-02).
 *
 * Closes the orphan loop in the candidate-identity pipeline. Background:
 * the BBB spike found that only 12.7% of tangential_signals (247 / 1,951)
 * are connected to any active wedding via the existing candidate-resolver
 * pipeline. The other 1,704 — including 553 The-Knot storefront views
 * shown on the "Engaged but didn't inquire" dashboard — never pick up an
 * attribution even when the same person later submits the calculator OR
 * books a tour. The clusterer attached them to candidate_identities, but
 * the resolver only looks at candidates whose state is unresolved AT THE
 * TIME the resolver runs. Storefront candidates created BEFORE the
 * matching wedding inquiry never get a second look.
 *
 * The fix: when a wedding becomes known-email (inquiry / Calendly tour /
 * HoneyBook project), retroactively scan unresolved storefront
 * candidate_identities with matching first_name + last_initial (+ state
 * when both have it) within the engagement window and link them to the
 * wedding's cluster.
 *
 * Match scoring (storefront candidate ↔ wedding):
 *   - First-name exact (accent-folded + lowercase): 0.5
 *   - Last-initial match: 0.2
 *   - State match (both populated, equal): 0.1
 *   - Date in [-90 days, +14 days] of inquiry_date: 0.2
 *   total > 0.7 → high (auto-link)
 *   total 0.5..0.7 → medium (coordinator review queue)
 *   total 0.3..0.5 → low (record attempt, no action)
 *   total < 0.3 → no match
 *
 * Date window rationale: engagements precede inquiry by weeks-to-months
 * (typical Knot save-then-message cadence is 30-60 days). The +14d tail
 * catches storefront re-visits after a tour booking or as a result of
 * shortlist comparison.
 *
 * Conservative auto-link rule: if more than one wedding scores HIGH for
 * the same candidate, defer all of them to coordinator review — false
 * positives are worse than false negatives. The ambiguity is real
 * (two Sarah-H weddings in VA in March), and the coordinator has the
 * context to pick.
 *
 * Idempotency:
 *   - Already-resolved candidates are skipped (resolved_wedding_id set)
 *   - Already-linked attribution_events are NOT re-written (per (candidate_id,
 *     wedding_id) check before insert)
 *   - candidate_identities.backtrack_attempted_at stamped after every
 *     scan so a candidate isn't reprocessed during a sweep within the
 *     re-attempt window
 *
 * Trigger surfaces:
 *   1. Inline async after wedding insert (fire-and-forget, never blocks)
 *   2. Daily cron (sweep)
 *   3. Manual via /api/intel/identity-backtrack
 *
 * Anchor: bloom-constitution.md Point-Zero doctrine — pre-zero
 * tangential signals are attribution credit; post-zero are nurture.
 * This service makes that classification possible for orphan storefront
 * signals that the original real-time clusterer missed.
 */

import type { SupabaseClient } from '@supabase/supabase-js'
import { recalculateHeatScore } from './heat-mapping'
import { normalizeSource } from './normalize-source'

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Storefront platforms eligible for backtrack. Email-bearing channels
 *  (calendly, honeybook, etc.) already resolve via the Tier-1 exact-email
 *  path of the candidate-resolver — backtrack is the orphan-storefront
 *  net for the platforms whose CSV/screenshot exports lack email. */
export const BACKTRACK_PLATFORMS: ReadonlySet<string> = new Set([
  'the_knot',
  'knot',
  'wedding_wire',
  'weddingwire',
  'zola',
  'instagram',
  'pinterest',
  'facebook',
  'tiktok',
  'here_comes_the_guide',
  'hctg',
])

/** Date window: engagements happen BEFORE inquiry; +14d tail catches
 *  edge cases like booking-then-storefront-revisit during shortlist
 *  comparison or post-decision validation. */
export const BACKTRACK_LOOKBACK_DAYS = 90
export const BACKTRACK_LOOKAHEAD_DAYS = 14

/** Score thresholds. */
export const HIGH_CONFIDENCE_MIN = 0.7
export const MEDIUM_CONFIDENCE_MIN = 0.5
export const LOW_CONFIDENCE_MIN = 0.3

/** Skip candidates whose backtrack_attempted_at is within this window
 *  during a sweep — daily cron retries weekly-ish so a never-resolvable
 *  candidate doesn't burn cycles every night. */
export const REATTEMPT_WINDOW_DAYS = 7

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface StorefrontCandidate {
  id: string
  venue_id: string
  source_platform: string
  first_name: string | null
  last_initial: string | null
  state: string | null
  first_seen: string | null
  last_seen: string | null
  signal_count: number
  funnel_depth: number
}

export interface WeddingForBacktrack {
  id: string
  venue_id: string
  inquiry_date: string | null
  source: string | null
  partner1_first_name: string | null
  partner1_last_name: string | null
  partner2_first_name: string | null
  partner2_last_name: string | null
  state: string | null
}

export interface BacktrackMatch {
  candidateId: string
  weddingId: string
  score: number
  evidence: string[]
  confidence: 'high' | 'medium' | 'low'
  /** Which partner of the wedding scored. Helps the coordinator UI label
   *  "matched on partner2 = Mary" so reviewers can sanity-check. */
  matchedPartner: 'partner1' | 'partner2'
}

export interface BacktrackSummary {
  venueId: string
  weddingsScanned: number
  candidatesEvaluated: number
  highAutoLinked: number
  mediumQueued: number
  lowSkipped: number
  noMatch: number
  ambiguousDeferred: number
  errors: string[]
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Strip accents + lowercase + trim — matches Phase B clusterer fingerprint. */
function normName(s: string | null | undefined): string {
  if (!s) return ''
  return s
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .trim()
}

function lastInitial(name: string | null | undefined): string {
  const n = normName(name)
  return n ? n[0] : ''
}

function normState(s: string | null | undefined): string {
  return (s ?? '').toUpperCase().trim()
}

function daysBetween(a: string | null | undefined, b: string | null | undefined): number | null {
  if (!a || !b) return null
  const ta = new Date(a).getTime()
  const tb = new Date(b).getTime()
  if (!Number.isFinite(ta) || !Number.isFinite(tb)) return null
  return (ta - tb) / 86_400_000 // signed: positive when a > b
}

// ---------------------------------------------------------------------------
// Match scoring
// ---------------------------------------------------------------------------

/**
 * Score one storefront candidate against one wedding. Tries partner1
 * first; if a partner2 exists ALSO try matching against partner2 and
 * return the higher score. Returns null when the score < LOW_CONFIDENCE_MIN.
 */
export function scoreCandidate(
  candidate: {
    first_name?: string | null
    last_initial?: string | null
    state?: string | null
    observed_at?: string | null
  },
  wedding: {
    partner1_first_name?: string | null
    partner1_last_name?: string | null
    partner2_first_name?: string | null
    partner2_last_name?: string | null
    state?: string | null
    inquiry_date?: string | null
  },
): { score: number; evidence: string[]; matchedPartner: 'partner1' | 'partner2' } | null {
  const candFirst = normName(candidate.first_name)
  const candLastInit = normName(candidate.last_initial)
  const candState = normState(candidate.state)
  const wedState = normState(wedding.state)

  if (!candFirst) return null

  function scoreAgainst(
    partnerFirst: string | null | undefined,
    partnerLast: string | null | undefined,
    label: 'partner1' | 'partner2',
  ): { score: number; evidence: string[]; matchedPartner: 'partner1' | 'partner2' } | null {
    const pFirst = normName(partnerFirst)
    if (!pFirst) return null
    if (pFirst !== candFirst) return null

    let score = 0.5
    const evidence: string[] = [`first_name=${candFirst}`]

    if (candLastInit && partnerLast) {
      const pLastInit = lastInitial(partnerLast)
      if (pLastInit === candLastInit) {
        score += 0.2
        evidence.push(`last_initial=${candLastInit}`)
      } else {
        // Last-initial conflict is a hard negative — different surname is
        // strong evidence this is a different person, even with same
        // first name + state.
        return null
      }
    }

    if (candState && wedState && candState === wedState) {
      score += 0.1
      evidence.push(`state=${candState}`)
    }

    if (candidate.observed_at && wedding.inquiry_date) {
      const lag = daysBetween(wedding.inquiry_date, candidate.observed_at)
      if (lag !== null && lag >= -BACKTRACK_LOOKAHEAD_DAYS && lag <= BACKTRACK_LOOKBACK_DAYS) {
        score += 0.2
        evidence.push(`lag=${Math.round(lag)}d`)
      } else {
        // Out of window — drop hard. Engagement that's 6 months pre-inquiry
        // or 30+ days post-inquiry isn't this wedding.
        return null
      }
    }

    return { score, evidence, matchedPartner: label }
  }

  type ScoreResult = { score: number; evidence: string[]; matchedPartner: 'partner1' | 'partner2' }
  const p1 = scoreAgainst(wedding.partner1_first_name, wedding.partner1_last_name, 'partner1')
  const p2 = scoreAgainst(wedding.partner2_first_name, wedding.partner2_last_name, 'partner2')

  let best: ScoreResult | null = null
  if (p1) best = p1
  if (p2 && (best === null || p2.score > best.score)) best = p2

  if (best === null) return null
  if (best.score < LOW_CONFIDENCE_MIN) return null
  return best
}

function bandFor(score: number): 'high' | 'medium' | 'low' {
  if (score >= HIGH_CONFIDENCE_MIN) return 'high'
  if (score >= MEDIUM_CONFIDENCE_MIN) return 'medium'
  return 'low'
}

// ---------------------------------------------------------------------------
// Loaders
// ---------------------------------------------------------------------------

/** Load wedding with both partners' names (joined from people).
 *  Uses the role='partner1' / 'partner2' rows on people. */
async function loadWedding(
  supabase: SupabaseClient,
  weddingId: string,
): Promise<WeddingForBacktrack | null> {
  const { data: wedRow, error: wedErr } = await supabase
    .from('weddings')
    .select('id, venue_id, inquiry_date, source')
    .eq('id', weddingId)
    .is('merged_into_id', null)
    .maybeSingle()
  if (wedErr || !wedRow) return null

  const { data: people } = await supabase
    .from('people')
    .select('role, first_name, last_name')
    .eq('wedding_id', weddingId)

  const p1 = (people ?? []).find((p) => (p as { role: string }).role === 'partner1') as
    | { first_name: string | null; last_name: string | null }
    | undefined
  const p2 = (people ?? []).find((p) => (p as { role: string }).role === 'partner2') as
    | { first_name: string | null; last_name: string | null }
    | undefined

  const { data: venue } = await supabase
    .from('venues')
    .select('state')
    .eq('id', (wedRow as { venue_id: string }).venue_id)
    .maybeSingle()

  return {
    id: wedRow.id as string,
    venue_id: (wedRow as { venue_id: string }).venue_id,
    inquiry_date: (wedRow as { inquiry_date: string | null }).inquiry_date,
    source: (wedRow as { source: string | null }).source,
    partner1_first_name: p1?.first_name ?? null,
    partner1_last_name: p1?.last_name ?? null,
    partner2_first_name: p2?.first_name ?? null,
    partner2_last_name: p2?.last_name ?? null,
    state: (venue as { state: string | null } | null)?.state ?? null,
  }
}

/** Load all unresolved storefront candidates for a venue, optionally
 *  windowed against a wedding's inquiry_date. */
async function loadCandidatesInWindow(
  supabase: SupabaseClient,
  venueId: string,
  windowAround: { inquiry_date: string | null } | null,
  reattemptCutoff: string | null,
): Promise<StorefrontCandidate[]> {
  let query = supabase
    .from('candidate_identities')
    .select('id, venue_id, source_platform, first_name, last_initial, state, first_seen, last_seen, signal_count, funnel_depth, backtrack_attempted_at')
    .eq('venue_id', venueId)
    .is('resolved_wedding_id', null)
    .is('deleted_at', null)
    .in('source_platform', Array.from(BACKTRACK_PLATFORMS))

  if (windowAround?.inquiry_date) {
    const lo = new Date(new Date(windowAround.inquiry_date).getTime() - BACKTRACK_LOOKBACK_DAYS * 86_400_000).toISOString()
    const hi = new Date(new Date(windowAround.inquiry_date).getTime() + BACKTRACK_LOOKAHEAD_DAYS * 86_400_000).toISOString()
    query = query.gte('first_seen', lo).lte('first_seen', hi)
  }

  if (reattemptCutoff) {
    query = query.or(`backtrack_attempted_at.is.null,backtrack_attempted_at.lt.${reattemptCutoff}`)
  }

  const out: StorefrontCandidate[] = []
  const PAGE = 500
  let from = 0
  for (;;) {
    const { data, error } = await query.range(from, from + PAGE - 1)
    if (error) throw new Error(`load candidates @${from}: ${error.message}`)
    const page = (data ?? []) as Array<Record<string, unknown>>
    for (const r of page) {
      out.push({
        id: String(r.id ?? ''),
        venue_id: String(r.venue_id ?? ''),
        source_platform: String(r.source_platform ?? ''),
        first_name: (r.first_name as string | null) ?? null,
        last_initial: (r.last_initial as string | null) ?? null,
        state: (r.state as string | null) ?? null,
        first_seen: (r.first_seen as string | null) ?? null,
        last_seen: (r.last_seen as string | null) ?? null,
        signal_count: Number(r.signal_count ?? 0),
        funnel_depth: Number(r.funnel_depth ?? 0),
      })
    }
    if (page.length < PAGE) break
    from += PAGE
  }
  return out
}

/** Load all weddings with inquiry_date for a venue. */
async function loadVenueWeddings(
  supabase: SupabaseClient,
  venueId: string,
): Promise<WeddingForBacktrack[]> {
  const { data: venueRow } = await supabase
    .from('venues')
    .select('state')
    .eq('id', venueId)
    .maybeSingle()
  const venueState = (venueRow as { state: string | null } | null)?.state ?? null

  const { data: wedsRaw, error } = await supabase
    .from('weddings')
    .select('id, venue_id, inquiry_date, source')
    .eq('venue_id', venueId)
    .is('merged_into_id', null)
    .not('inquiry_date', 'is', null)
  if (error) throw new Error(`load weddings: ${error.message}`)

  const weddings = ((wedsRaw ?? []) as Array<Record<string, unknown>>).map((r) => ({
    id: String(r.id ?? ''),
    venue_id: String(r.venue_id ?? ''),
    inquiry_date: (r.inquiry_date as string | null) ?? null,
    source: (r.source as string | null) ?? null,
  }))

  // Bulk-load people in chunks.
  const wedIds = weddings.map((w) => w.id)
  const peopleByWedding = new Map<string, Array<{ role: string | null; first_name: string | null; last_name: string | null }>>()
  const CHUNK = 200
  for (let i = 0; i < wedIds.length; i += CHUNK) {
    const chunk = wedIds.slice(i, i + CHUNK)
    const { data: people } = await supabase
      .from('people')
      .select('wedding_id, role, first_name, last_name')
      .in('wedding_id', chunk)
    for (const p of (people ?? []) as Array<Record<string, unknown>>) {
      const wid = p.wedding_id as string
      const arr = peopleByWedding.get(wid) ?? []
      arr.push({
        role: (p.role as string | null) ?? null,
        first_name: (p.first_name as string | null) ?? null,
        last_name: (p.last_name as string | null) ?? null,
      })
      peopleByWedding.set(wid, arr)
    }
  }

  return weddings.map((w) => {
    const ppl = peopleByWedding.get(w.id) ?? []
    const p1 = ppl.find((p) => p.role === 'partner1') ?? ppl[0]
    const p2 = ppl.find((p) => p.role === 'partner2')
    return {
      id: w.id,
      venue_id: w.venue_id,
      inquiry_date: w.inquiry_date,
      source: w.source,
      partner1_first_name: p1?.first_name ?? null,
      partner1_last_name: p1?.last_name ?? null,
      partner2_first_name: p2?.first_name ?? null,
      partner2_last_name: p2?.last_name ?? null,
      state: venueState,
    }
  })
}

// ---------------------------------------------------------------------------
// Writers
// ---------------------------------------------------------------------------

/** Write one attribution_event per signal in the candidate, then mark
 *  the candidate resolved. Idempotent: skips signals that already have
 *  an attribution_event for this (candidate, wedding) pair. */
async function autoLinkCandidate(args: {
  supabase: SupabaseClient
  candidate: StorefrontCandidate
  wedding: WeddingForBacktrack
  match: BacktrackMatch
}): Promise<{ ok: true; signalsLinked: number } | { ok: false; error: string }> {
  const { supabase, candidate, wedding, match } = args

  // Pull every signal in the candidate cluster.
  const { data: signals, error: sigErr } = await supabase
    .from('tangential_signals')
    .select('id, signal_date, source_platform, action_class')
    .eq('candidate_identity_id', candidate.id)
    .order('signal_date', { ascending: true, nullsFirst: false })
  if (sigErr) return { ok: false, error: `signals load ${candidate.id}: ${sigErr.message}` }

  const signalRows = (signals ?? []) as Array<{
    id: string
    signal_date: string | null
    source_platform: string | null
    action_class: string | null
  }>
  if (signalRows.length === 0) {
    // Candidate with zero signals — clusterer race or soft-deleted.
    // Still mark resolved so we don't re-evaluate.
    await supabase
      .from('candidate_identities')
      .update({
        resolved_wedding_id: wedding.id,
        resolved_at: new Date().toISOString(),
        resolved_by: 'auto',
        resolved_confidence: Math.round(match.score * 100),
        backtrack_attempted_at: new Date().toISOString(),
      })
      .eq('id', candidate.id)
    return { ok: true, signalsLinked: 0 }
  }

  // Idempotency check — skip signals that already have an attribution_event.
  const { data: existing } = await supabase
    .from('attribution_events')
    .select('signal_id')
    .eq('wedding_id', wedding.id)
    .eq('candidate_identity_id', candidate.id)
    .is('reverted_at', null)
  const linkedSignalIds = new Set(((existing ?? []) as Array<{ signal_id: string | null }>)
    .map((e) => e.signal_id)
    .filter((v): v is string => Boolean(v)))

  const inquiryTs = wedding.inquiry_date ? new Date(wedding.inquiry_date).getTime() : null

  // Conflict detection mirrors candidate-resolver writeAttributionEvents.
  let conflictFlag: string | null = null
  if (wedding.source && candidate.source_platform) {
    const legacyNorm = normalizeSource(wedding.source)
    const computedNorm = normalizeSource(candidate.source_platform)
    if (legacyNorm !== computedNorm && legacyNorm !== 'other' && computedNorm !== 'other') {
      conflictFlag = `legacy=${legacyNorm} computed=${computedNorm}`
    }
  }

  const reasoning = `backtrack score=${match.score.toFixed(2)} evidence=[${match.evidence.join(', ')}] partner=${match.matchedPartner}`
  const rowsToInsert = signalRows
    .filter((s) => s.signal_date && !linkedSignalIds.has(s.id))
    .map((s) => {
      const sigTs = new Date(s.signal_date!).getTime()
      const bucket = inquiryTs !== null && sigTs >= inquiryTs ? 'nurture' : 'attribution'
      return {
        venue_id: candidate.venue_id,
        candidate_identity_id: candidate.id,
        wedding_id: wedding.id,
        signal_id: s.id,
        source_platform: s.source_platform ?? candidate.source_platform,
        confidence: Math.round(match.score * 100),
        // Tier 1.4 — backtrack name+state+window auto-link.
        tier: 'tier_1_name_window',
        decided_by: 'auto' as const,
        reasoning,
        is_first_touch: false,
        bucket,
        conflict_with_legacy_source: bucket === 'attribution' ? conflictFlag : null,
      }
    })

  if (rowsToInsert.length > 0) {
    const { error: insErr } = await supabase.from('attribution_events').insert(rowsToInsert)
    if (insErr) return { ok: false, error: `attribution insert ${candidate.id}: ${insErr.message}` }
  }

  // Mark candidate resolved.
  const { error: updErr } = await supabase
    .from('candidate_identities')
    .update({
      resolved_wedding_id: wedding.id,
      resolved_at: new Date().toISOString(),
      resolved_by: 'auto',
      resolved_confidence: Math.round(match.score * 100),
      backtrack_attempted_at: new Date().toISOString(),
    })
    .eq('id', candidate.id)
    .is('resolved_wedding_id', null) // race-guard
  if (updErr) return { ok: false, error: `candidate resolve ${candidate.id}: ${updErr.message}` }

  // Backfill wedding_touchpoints (mirrors candidate-resolver pattern).
  for (const s of signalRows) {
    if (!s.signal_date) continue
    const { data: existingTp } = await supabase
      .from('wedding_touchpoints')
      .select('id')
      .eq('wedding_id', wedding.id)
      .contains('metadata', { signal_id: s.id })
      .limit(1)
    if ((existingTp ?? []).length > 0) continue
    await supabase.from('wedding_touchpoints').insert({
      venue_id: candidate.venue_id,
      wedding_id: wedding.id,
      source: s.source_platform ?? candidate.source_platform,
      medium: 'platform_signal',
      touch_type: 'other',
      occurred_at: s.signal_date,
      metadata: {
        signal_id: s.id,
        candidate_identity_id: candidate.id,
        action_class: s.action_class,
        source_platform: s.source_platform ?? candidate.source_platform,
        backtrack: true,
      },
    })
  }

  // Recompute first-touch + heat (best-effort).
  try {
    const { recomputeFirstTouch } = await import('./candidate-resolver')
    await recomputeFirstTouch(supabase, wedding.id)
  } catch (err) {
    console.warn('[backtrack] first-touch recompute failed:', err)
  }
  try {
    await recalculateHeatScore(candidate.venue_id, wedding.id)
  } catch (err) {
    console.warn('[backtrack] heat recalc failed:', err)
  }

  return { ok: true, signalsLinked: rowsToInsert.length }
}

/** Stamp backtrack_attempted_at on a candidate without resolving — used
 *  for medium / low / no-match candidates so the sweep paginates past
 *  them. */
async function stampAttempted(
  supabase: SupabaseClient,
  candidateId: string,
  reviewStatus?: 'needs_review' | 'clean',
): Promise<void> {
  const update: Record<string, unknown> = {
    backtrack_attempted_at: new Date().toISOString(),
  }
  if (reviewStatus) update.review_status = reviewStatus
  await supabase
    .from('candidate_identities')
    .update(update)
    .eq('id', candidateId)
}

// ---------------------------------------------------------------------------
// Per-wedding evaluation (used by post-insert trigger path)
// ---------------------------------------------------------------------------

/**
 * Backtrack one wedding — evaluate every unresolved storefront
 * candidate in the venue against this wedding. Used by the inline
 * post-wedding-insert hook AND by the venue-wide runner (which loops
 * through every wedding).
 */
export async function runBacktrackForWedding(
  supabase: SupabaseClient,
  weddingId: string,
): Promise<BacktrackSummary> {
  const summary: BacktrackSummary = {
    venueId: '',
    weddingsScanned: 1,
    candidatesEvaluated: 0,
    highAutoLinked: 0,
    mediumQueued: 0,
    lowSkipped: 0,
    noMatch: 0,
    ambiguousDeferred: 0,
    errors: [],
  }

  const wedding = await loadWedding(supabase, weddingId)
  if (!wedding || !wedding.inquiry_date) return summary
  summary.venueId = wedding.venue_id

  let candidates: StorefrontCandidate[]
  try {
    candidates = await loadCandidatesInWindow(supabase, wedding.venue_id, wedding, null)
  } catch (err) {
    summary.errors.push(err instanceof Error ? err.message : String(err))
    return summary
  }

  for (const cand of candidates) {
    summary.candidatesEvaluated++
    const score = scoreCandidate(
      {
        first_name: cand.first_name,
        last_initial: cand.last_initial,
        state: cand.state,
        observed_at: cand.first_seen,
      },
      {
        partner1_first_name: wedding.partner1_first_name,
        partner1_last_name: wedding.partner1_last_name,
        partner2_first_name: wedding.partner2_first_name,
        partner2_last_name: wedding.partner2_last_name,
        state: wedding.state,
        inquiry_date: wedding.inquiry_date,
      },
    )

    if (!score) {
      summary.noMatch++
      await stampAttempted(supabase, cand.id)
      continue
    }

    const band = bandFor(score.score)
    const match: BacktrackMatch = {
      candidateId: cand.id,
      weddingId: wedding.id,
      score: score.score,
      evidence: score.evidence,
      confidence: band,
      matchedPartner: score.matchedPartner,
    }

    if (band === 'high') {
      const r = await autoLinkCandidate({ supabase, candidate: cand, wedding, match })
      if (!r.ok) {
        summary.errors.push(r.error)
      } else {
        summary.highAutoLinked++
      }
    } else if (band === 'medium') {
      summary.mediumQueued++
      await stampAttempted(supabase, cand.id, 'needs_review')
    } else {
      summary.lowSkipped++
      await stampAttempted(supabase, cand.id)
    }
  }

  return summary
}

// ---------------------------------------------------------------------------
// Venue-wide runner (cron entry point)
// ---------------------------------------------------------------------------

/**
 * Backtrack every active wedding in a venue. Two-phase:
 *   Phase 1 — for each wedding, score every candidate (in-memory, cheap).
 *             Track per-candidate the BEST scoring wedding plus second-best
 *             so we can detect ambiguity.
 *   Phase 2 — auto-link candidates with one clear high winner, queue the
 *             rest for review.
 *
 * The two-phase approach prevents a candidate that scores HIGH against
 * two different weddings from getting auto-linked to whichever wedding
 * loaded first. False positives are worse than false negatives in
 * attribution.
 */
export async function runBacktrackForVenue(
  supabase: SupabaseClient,
  venueId: string,
  options: { skipReattemptWindow?: boolean } = {},
): Promise<BacktrackSummary> {
  const summary: BacktrackSummary = {
    venueId,
    weddingsScanned: 0,
    candidatesEvaluated: 0,
    highAutoLinked: 0,
    mediumQueued: 0,
    lowSkipped: 0,
    noMatch: 0,
    ambiguousDeferred: 0,
    errors: [],
  }

  let weddings: WeddingForBacktrack[]
  try {
    weddings = await loadVenueWeddings(supabase, venueId)
  } catch (err) {
    summary.errors.push(err instanceof Error ? err.message : String(err))
    return summary
  }
  summary.weddingsScanned = weddings.length

  const reattemptCutoff = options.skipReattemptWindow
    ? null
    : new Date(Date.now() - REATTEMPT_WINDOW_DAYS * 86_400_000).toISOString()

  let candidates: StorefrontCandidate[]
  try {
    candidates = await loadCandidatesInWindow(supabase, venueId, null, reattemptCutoff)
  } catch (err) {
    summary.errors.push(err instanceof Error ? err.message : String(err))
    return summary
  }
  summary.candidatesEvaluated = candidates.length

  // For each candidate, find best + second-best wedding.
  interface Best {
    wedding: WeddingForBacktrack
    score: { score: number; evidence: string[]; matchedPartner: 'partner1' | 'partner2' }
  }
  const candidateBest = new Map<string, { best: Best | null; second: Best | null }>()
  for (const cand of candidates) {
    let best: Best | null = null
    let second: Best | null = null
    for (const wed of weddings) {
      const s = scoreCandidate(
        {
          first_name: cand.first_name,
          last_initial: cand.last_initial,
          state: cand.state,
          observed_at: cand.first_seen,
        },
        {
          partner1_first_name: wed.partner1_first_name,
          partner1_last_name: wed.partner1_last_name,
          partner2_first_name: wed.partner2_first_name,
          partner2_last_name: wed.partner2_last_name,
          state: wed.state,
          inquiry_date: wed.inquiry_date,
        },
      )
      if (!s) continue
      if (!best || s.score > best.score.score) {
        second = best
        best = { wedding: wed, score: s }
      } else if (!second || s.score > second.score.score) {
        second = { wedding: wed, score: s }
      }
    }
    candidateBest.set(cand.id, { best, second })
  }

  // Phase 2 — write decisions.
  for (const cand of candidates) {
    const entry = candidateBest.get(cand.id)
    if (!entry || !entry.best) {
      summary.noMatch++
      await stampAttempted(supabase, cand.id)
      continue
    }
    const band = bandFor(entry.best.score.score)
    const match: BacktrackMatch = {
      candidateId: cand.id,
      weddingId: entry.best.wedding.id,
      score: entry.best.score.score,
      evidence: entry.best.score.evidence,
      confidence: band,
      matchedPartner: entry.best.score.matchedPartner,
    }

    if (band === 'high') {
      // Conservative ambiguity gate: if second-best is also high, defer
      // both to coordinator review. Coordinator picks.
      if (entry.second && bandFor(entry.second.score.score) === 'high') {
        summary.ambiguousDeferred++
        await stampAttempted(supabase, cand.id, 'needs_review')
        continue
      }
      const r = await autoLinkCandidate({
        supabase,
        candidate: cand,
        wedding: entry.best.wedding,
        match,
      })
      if (!r.ok) {
        summary.errors.push(r.error)
      } else {
        summary.highAutoLinked++
      }
    } else if (band === 'medium') {
      summary.mediumQueued++
      await stampAttempted(supabase, cand.id, 'needs_review')
    } else {
      summary.lowSkipped++
      await stampAttempted(supabase, cand.id)
    }
  }

  return summary
}

/** Cron wrapper — every active venue. */
export async function runBacktrackAllVenues(
  supabase: SupabaseClient,
): Promise<Record<string, BacktrackSummary>> {
  const { data: venues } = await supabase
    .from('venues')
    .select('id, name')
    .is('archived_at', null)
  const out: Record<string, BacktrackSummary> = {}
  for (const v of (venues ?? []) as Array<{ id: string; name: string }>) {
    try {
      out[v.name] = await runBacktrackForVenue(supabase, v.id)
    } catch (err) {
      out[v.name] = {
        venueId: v.id,
        weddingsScanned: 0,
        candidatesEvaluated: 0,
        highAutoLinked: 0,
        mediumQueued: 0,
        lowSkipped: 0,
        noMatch: 0,
        ambiguousDeferred: 0,
        errors: [err instanceof Error ? err.message : String(err)],
      }
    }
  }
  return out
}

// ---------------------------------------------------------------------------
// Coordinator-review helpers
// ---------------------------------------------------------------------------

export interface BacktrackReviewItem {
  candidate: StorefrontCandidate
  wedding: WeddingForBacktrack
  match: BacktrackMatch
}

/**
 * List all pending medium-confidence matches for a venue. Surface for
 * the /intel/identity-backtrack coordinator UI. Recomputes scores in
 * memory so the page reflects current data without re-stamping rows.
 */
export async function listPendingBacktrackReview(
  supabase: SupabaseClient,
  venueId: string,
): Promise<BacktrackReviewItem[]> {
  const candidates = await loadCandidatesInWindow(supabase, venueId, null, null)
  const weddings = await loadVenueWeddings(supabase, venueId)
  const out: BacktrackReviewItem[] = []
  for (const cand of candidates) {
    let best: { wed: WeddingForBacktrack; s: ReturnType<typeof scoreCandidate> } | null = null
    for (const wed of weddings) {
      const s = scoreCandidate(
        {
          first_name: cand.first_name,
          last_initial: cand.last_initial,
          state: cand.state,
          observed_at: cand.first_seen,
        },
        {
          partner1_first_name: wed.partner1_first_name,
          partner1_last_name: wed.partner1_last_name,
          partner2_first_name: wed.partner2_first_name,
          partner2_last_name: wed.partner2_last_name,
          state: wed.state,
          inquiry_date: wed.inquiry_date,
        },
      )
      if (!s) continue
      if (!best || s.score > best.s!.score) best = { wed, s }
    }
    if (!best || !best.s) continue
    if (best.s.score < MEDIUM_CONFIDENCE_MIN || best.s.score >= HIGH_CONFIDENCE_MIN) continue
    out.push({
      candidate: cand,
      wedding: best.wed,
      match: {
        candidateId: cand.id,
        weddingId: best.wed.id,
        score: best.s.score,
        evidence: best.s.evidence,
        confidence: 'medium',
        matchedPartner: best.s.matchedPartner,
      },
    })
  }
  // Highest-score first.
  out.sort((a, b) => b.match.score - a.match.score)
  return out
}

/**
 * Coordinator-confirmed link from /intel/identity-backtrack — same writer
 * as the auto-link path, but tier='tier_2_coordinator' + decided_by='coordinator'.
 */
export async function applyBacktrackLink(
  supabase: SupabaseClient,
  args: {
    venueId: string
    candidateId: string
    weddingId: string
    coordinatorUserId?: string | null
    reason?: string | null
  },
): Promise<{ ok: true; signalsLinked: number } | { ok: false; error: string }> {
  const { venueId, candidateId, weddingId, coordinatorUserId, reason } = args

  const { data: cand, error: cErr } = await supabase
    .from('candidate_identities')
    .select('id, venue_id, source_platform, first_name, last_initial, state, first_seen, last_seen, signal_count, funnel_depth, resolved_wedding_id')
    .eq('id', candidateId)
    .maybeSingle()
  if (cErr || !cand) return { ok: false, error: `candidate not found: ${candidateId}` }
  if ((cand as { venue_id: string }).venue_id !== venueId) {
    return { ok: false, error: 'cross-venue candidate' }
  }
  if ((cand as { resolved_wedding_id: string | null }).resolved_wedding_id) {
    return { ok: false, error: 'candidate already resolved' }
  }

  const wedding = await loadWedding(supabase, weddingId)
  if (!wedding) return { ok: false, error: `wedding not found: ${weddingId}` }
  if (wedding.venue_id !== venueId) return { ok: false, error: 'cross-venue wedding' }

  const candForWriter: StorefrontCandidate = {
    id: String(cand.id),
    venue_id: (cand as { venue_id: string }).venue_id,
    source_platform: String(cand.source_platform ?? ''),
    first_name: (cand as { first_name: string | null }).first_name,
    last_initial: (cand as { last_initial: string | null }).last_initial,
    state: (cand as { state: string | null }).state,
    first_seen: (cand as { first_seen: string | null }).first_seen,
    last_seen: (cand as { last_seen: string | null }).last_seen,
    signal_count: Number((cand as { signal_count: number }).signal_count ?? 0),
    funnel_depth: Number((cand as { funnel_depth: number }).funnel_depth ?? 0),
  }

  // Score for audit trail; confidence value uses the score even though
  // the coordinator overrode the band.
  const s = scoreCandidate(
    {
      first_name: candForWriter.first_name,
      last_initial: candForWriter.last_initial,
      state: candForWriter.state,
      observed_at: candForWriter.first_seen,
    },
    {
      partner1_first_name: wedding.partner1_first_name,
      partner1_last_name: wedding.partner1_last_name,
      partner2_first_name: wedding.partner2_first_name,
      partner2_last_name: wedding.partner2_last_name,
      state: wedding.state,
      inquiry_date: wedding.inquiry_date,
    },
  )
  const score = s?.score ?? 0.5
  const evidence = s?.evidence ?? ['coordinator_confirmed']
  const partner = s?.matchedPartner ?? 'partner1'

  // Use the auto-link writer path but stamp tier=tier_2_coordinator.
  // Inline a custom write since we want the coordinator tier.
  const { data: signals } = await supabase
    .from('tangential_signals')
    .select('id, signal_date, source_platform, action_class')
    .eq('candidate_identity_id', candidateId)
    .order('signal_date', { ascending: true, nullsFirst: false })

  const signalRows = (signals ?? []) as Array<{
    id: string
    signal_date: string | null
    source_platform: string | null
    action_class: string | null
  }>

  const { data: existing } = await supabase
    .from('attribution_events')
    .select('signal_id')
    .eq('wedding_id', weddingId)
    .eq('candidate_identity_id', candidateId)
    .is('reverted_at', null)
  const linked = new Set(((existing ?? []) as Array<{ signal_id: string | null }>)
    .map((e) => e.signal_id)
    .filter((v): v is string => Boolean(v)))

  const inquiryTs = wedding.inquiry_date ? new Date(wedding.inquiry_date).getTime() : null
  let conflictFlag: string | null = null
  if (wedding.source && candForWriter.source_platform) {
    const ln = normalizeSource(wedding.source)
    const cn = normalizeSource(candForWriter.source_platform)
    if (ln !== cn && ln !== 'other' && cn !== 'other') {
      conflictFlag = `legacy=${ln} computed=${cn}`
    }
  }

  const reasoning = `backtrack coordinator link score=${score.toFixed(2)} evidence=[${evidence.join(', ')}] partner=${partner}${reason ? ` note="${reason}"` : ''}${coordinatorUserId ? ` by=${coordinatorUserId}` : ''}`

  const insertRows = signalRows
    .filter((s2) => s2.signal_date && !linked.has(s2.id))
    .map((s2) => {
      const sigTs = new Date(s2.signal_date!).getTime()
      const bucket = inquiryTs !== null && sigTs >= inquiryTs ? 'nurture' : 'attribution'
      return {
        venue_id: venueId,
        candidate_identity_id: candidateId,
        wedding_id: weddingId,
        signal_id: s2.id,
        source_platform: s2.source_platform ?? candForWriter.source_platform,
        confidence: Math.round(score * 100),
        tier: 'tier_2_coordinator',
        decided_by: 'coordinator' as const,
        reasoning,
        is_first_touch: false,
        bucket,
        conflict_with_legacy_source: bucket === 'attribution' ? conflictFlag : null,
      }
    })
  if (insertRows.length > 0) {
    const { error: insErr } = await supabase.from('attribution_events').insert(insertRows)
    if (insErr) return { ok: false, error: `attribution insert: ${insErr.message}` }
  }

  const { error: updErr } = await supabase
    .from('candidate_identities')
    .update({
      resolved_wedding_id: weddingId,
      resolved_at: new Date().toISOString(),
      resolved_by: 'coordinator',
      resolved_confidence: Math.round(score * 100),
      review_status: 'reviewed',
      backtrack_attempted_at: new Date().toISOString(),
    })
    .eq('id', candidateId)
    .is('resolved_wedding_id', null)
  if (updErr) return { ok: false, error: `candidate resolve: ${updErr.message}` }

  // Touchpoints + first-touch + heat (best-effort).
  for (const s2 of signalRows) {
    if (!s2.signal_date) continue
    const { data: existingTp } = await supabase
      .from('wedding_touchpoints')
      .select('id')
      .eq('wedding_id', weddingId)
      .contains('metadata', { signal_id: s2.id })
      .limit(1)
    if ((existingTp ?? []).length > 0) continue
    await supabase.from('wedding_touchpoints').insert({
      venue_id: venueId,
      wedding_id: weddingId,
      source: s2.source_platform ?? candForWriter.source_platform,
      medium: 'platform_signal',
      touch_type: 'other',
      occurred_at: s2.signal_date,
      metadata: {
        signal_id: s2.id,
        candidate_identity_id: candidateId,
        action_class: s2.action_class,
        source_platform: s2.source_platform ?? candForWriter.source_platform,
        backtrack: true,
        coordinator_confirmed: true,
      },
    })
  }
  try {
    const { recomputeFirstTouch } = await import('./candidate-resolver')
    await recomputeFirstTouch(supabase, weddingId)
  } catch (err) {
    console.warn('[backtrack] coordinator first-touch recompute failed:', err)
  }
  try {
    await recalculateHeatScore(venueId, weddingId)
  } catch (err) {
    console.warn('[backtrack] coordinator heat recalc failed:', err)
  }
  return { ok: true, signalsLinked: insertRows.length }
}

/** Coordinator dismiss — stamp candidate so the queue stops surfacing it. */
export async function rejectBacktrackCandidate(
  supabase: SupabaseClient,
  args: { venueId: string; candidateId: string },
): Promise<{ ok: true } | { ok: false; error: string }> {
  const { error } = await supabase
    .from('candidate_identities')
    .update({
      review_status: 'reviewed',
      backtrack_attempted_at: new Date().toISOString(),
    })
    .eq('id', args.candidateId)
    .eq('venue_id', args.venueId)
  if (error) return { ok: false, error: error.message }
  return { ok: true }
}
