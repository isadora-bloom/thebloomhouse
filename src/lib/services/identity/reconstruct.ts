/**
 * Bloom House — Wave 4 Identity Reconstruction Service
 *
 * Anchor docs:
 *   - bloom-constitution.md (forensic identity reconstruction is the
 *     thesis; every populated claim has a verbatim evidence_quote)
 *   - bloom-wave4-identity-reconstruction.md (this service is the ONE
 *     Sonnet judge per couple that replaces ~15 heuristic detectors)
 *   - bloom-may9-llm-vs-template.md (every "AI / Sage / smart" surface
 *     is backed by a real callAI; Wave 4 extends to extractors)
 *
 * What this service does
 * ----------------------
 * Given a wedding_id, gather every signal we have on disk (interactions,
 * calculator submissions, HoneyBook contacts, calendar invites,
 * Calendly bookings, reviews, contracts, payments, tangential signals /
 * cross-platform handles) → feed it all into one Sonnet call → parse +
 * validate the structured response → upsert into
 * couple_identity_profile.
 *
 * One LLM call per couple. Cost target $0.03-$0.08 per reconstruction.
 *
 * What this service does NOT do (Phase 1)
 * ---------------------------------------
 * - It does NOT enqueue jobs into identity_reconstruction_jobs (Phase
 *   2 wires the pipeline + cron).
 * - It does NOT delete or modify heuristic detectors (Phase 4).
 * - It does NOT migrate read surfaces (Phase 3).
 * - It does NOT touch the live `people.first_name` / `last_name`
 *   columns — those still flow through the Wave 2/3 chokepoint until
 *   Phase 4 retires the heuristic detectors.
 *
 * The service is idempotent on signal-stable data (temperature 0.2
 * keeps the model close to deterministic). Re-running on a clean
 * wedding produces a profile that differs by trivial wording, not by
 * structural shape.
 */

import type { SupabaseClient } from '@supabase/supabase-js'
import { createServiceClient } from '@/lib/supabase/service'
import { callAI } from '@/lib/ai/client'
import {
  buildSystemPrompt,
  buildUserPrompt,
  validateCoupleIdentityProfile,
  IDENTITY_RECONSTRUCTION_PROMPT_VERSION,
  type CoupleIdentityProfile,
  type ReconstructionEvidence,
  type InteractionEvidence,
  type CalculatorEvidence,
  type HoneyBookEvidence,
  type CalendarEvidence,
  type ReviewEvidence,
  type ContractEvidence,
  type PaymentEvidence,
  type HandleEvidence,
} from '@/config/prompts/identity-reconstruction'
import {
  filterReviewsForCouple,
  deferAmbiguousReview,
  matchReviewToCouple,
  type PartnerNamePair,
} from './review-match'
import {
  loadEvidenceOverrides,
  isEvidenceDismissed,
  type EvidenceOverridesIndex,
} from './evidence-overrides'

// Re-export so callers don't have to import from two places.
export {
  IDENTITY_RECONSTRUCTION_PROMPT_VERSION,
  type CoupleIdentityProfile,
} from '@/config/prompts/identity-reconstruction'

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface EvidenceSummary {
  interactions_count: number
  calculator_count: number
  honeybook_present: boolean
  calendar_count: number
  reviews_count: number
  contracts_count: number
  tangentials_count: number
  payments_count: number
  /** Wave 15 — number of discovery_sources rows captured for this
   *  wedding ("How did you hear about us?" answers). When > 0, the
   *  most recent answer is surfaced via discovery_source_recent. */
  discovery_sources_count?: number
  /** Wave 15 — most recent discovery source (verbatim + canonical).
   *  Surfaced on ReconstructedIdentityPanel evidence row. */
  discovery_source_recent?: {
    canonical: string
    answer: string
    captured_at: string
  } | null
  /** Wave 15 — number of active evidence_overrides for this wedding. */
  evidence_overrides_count?: number
}

export interface ReconstructResult {
  profile: CoupleIdentityProfile
  costCents: number
  promptVersion: string
  evidenceSummary: EvidenceSummary
  inputTokens: number
  outputTokens: number
  reconstructionCount: number
  lastSignalAt: string | null
}

// ---------------------------------------------------------------------------
// Bounds — kept here (not in the prompt module) because the bounds are
// pipeline-cost knobs, not prompt-shape contracts.
// ---------------------------------------------------------------------------

const MAX_INTERACTIONS_FETCHED = 200
const MAX_REVIEW_FETCHED = 25
const MAX_TANGENTIAL_FETCHED = 50
const MAX_CALENDAR_FETCHED = 25

// ---------------------------------------------------------------------------
// Evidence loaders. Each is best-effort: if the table doesn't exist on
// this environment OR RLS blocks the read OR the schema drifts, we log
// and continue. Identity reconstruction is forensic — partial evidence
// is better than none.
// ---------------------------------------------------------------------------

interface WeddingRow {
  id: string
  venue_id: string
  inquiry_date: string | null
  wedding_date: string | null
  status: string | null
  source: string | null
  guest_count_estimate: number | null
  notes: string | null
  // HoneyBook-shaped CRM fields (present when an import has run for
  // this wedding; null otherwise). Migration 175 added these.
  crm_external_id: string | null
  crm_team_members: unknown
  // merged_into_id is checked by the resolver upstream; we still
  // accept tombstoned weddings here because the caller may want to
  // re-reconstruct a tombstoned record for debugging. The endpoint
  // layer enforces non-tombstone for normal calls.
  merged_into_id: string | null
}

interface PersonRow {
  role: string | null
  first_name: string | null
  last_name: string | null
  email: string | null
  phone: string | null
}

interface InteractionRow {
  id: string
  direction: string | null
  from_email: string | null
  from_name: string | null
  subject: string | null
  full_body: string | null
  body_preview: string | null
  timestamp: string | null
}

interface ContractRow {
  id: string
  filename: string | null
  extracted_text: string | null
  created_at: string | null
}

interface ReviewRow {
  id: string
  reviewer_name: string | null
  source: string | null
  rating: number | null
  body: string | null
  review_date: string | null
}

interface TangentialRow {
  id: string
  source_platform: string | null
  signal_date: string | null
  source_context: string | null
  extracted_identity: Record<string, unknown> | null
}

async function loadWedding(
  supabase: SupabaseClient,
  weddingId: string,
): Promise<WeddingRow | null> {
  const { data, error } = await supabase
    .from('weddings')
    .select(
      'id, venue_id, inquiry_date, wedding_date, status, source, guest_count_estimate, notes, crm_external_id, crm_team_members, merged_into_id',
    )
    .eq('id', weddingId)
    .maybeSingle()
  if (error) {
    throw new Error(`reconstruct.loadWedding failed: ${error.message}`)
  }
  return (data as WeddingRow | null) ?? null
}

async function loadPeople(
  supabase: SupabaseClient,
  weddingId: string,
): Promise<PersonRow[]> {
  const { data, error } = await supabase
    .from('people')
    .select('role, first_name, last_name, email, phone, merged_into_id')
    .eq('wedding_id', weddingId)
    .is('merged_into_id', null)
  if (error) {
    console.warn('[reconstruct] loadPeople failed:', error.message)
    return []
  }
  return (data ?? []).map((r) => ({
    role: (r as { role: string | null }).role,
    first_name: (r as { first_name: string | null }).first_name,
    last_name: (r as { last_name: string | null }).last_name,
    email: (r as { email: string | null }).email,
    phone: (r as { phone: string | null }).phone,
  }))
}

async function loadInteractions(
  supabase: SupabaseClient,
  weddingId: string,
): Promise<InteractionRow[]> {
  const { data, error } = await supabase
    .from('interactions')
    .select('id, direction, from_email, from_name, subject, full_body, body_preview, timestamp')
    .eq('wedding_id', weddingId)
    .order('timestamp', { ascending: true })
    .limit(MAX_INTERACTIONS_FETCHED)
  if (error) {
    console.warn('[reconstruct] loadInteractions failed:', error.message)
    return []
  }
  return (data ?? []) as InteractionRow[]
}

async function loadContracts(
  supabase: SupabaseClient,
  weddingId: string,
): Promise<ContractRow[]> {
  const { data, error } = await supabase
    .from('contracts')
    .select('id, filename, extracted_text, created_at')
    .eq('wedding_id', weddingId)
    .order('created_at', { ascending: true })
  if (error) {
    console.warn('[reconstruct] loadContracts failed:', error.message)
    return []
  }
  return (data ?? []) as ContractRow[]
}

async function loadTangentials(
  supabase: SupabaseClient,
  weddingId: string,
  venueId: string,
): Promise<TangentialRow[]> {
  // tangential_signals is venue-scoped; it links to a person, not a
  // wedding directly. We collect signals matched to any people on this
  // wedding via the people table's resolution.
  const { data: peopleData } = await supabase
    .from('people')
    .select('id')
    .eq('wedding_id', weddingId)
  const peopleIds = ((peopleData ?? []) as Array<{ id: string }>).map((p) => p.id)
  if (peopleIds.length === 0) return []
  const { data, error } = await supabase
    .from('tangential_signals')
    .select('id, source_platform, signal_date, source_context, extracted_identity, matched_person_id')
    .eq('venue_id', venueId)
    .in('matched_person_id', peopleIds)
    .order('signal_date', { ascending: false })
    .limit(MAX_TANGENTIAL_FETCHED)
  if (error) {
    console.warn('[reconstruct] loadTangentials failed:', error.message)
    return []
  }
  return ((data ?? []) as Array<TangentialRow & { matched_person_id: string }>)
}

async function loadReviewsForCouple(
  supabase: SupabaseClient,
  venueId: string,
  people: PersonRow[],
  wedding: WeddingRow,
): Promise<ReviewRow[]> {
  // Wave 15 precision filter: reviews are venue-scoped (no wedding_id
  // FK on legacy schema). Replace the old loose surname-substring match
  // with a strict first-name + temporal guard (see review-match.ts).
  //
  // Steps:
  //   1. Pre-filter by ANY surname token containing one of the partner
  //      first names. This is still loose — we let lots of candidates
  //      through and then the strict matcher in matchReviewToCouple()
  //      decides.
  //   2. Apply the strict matcher: first-name + temporal alignment.
  //   3. Reviews older than inquiry_date are dropped AND surfaced to
  //      review_match_review_queue as 'pre_inquiry_review' so an
  //      operator can audit (constitution: never silently discard
  //      potentially-relevant evidence).
  //
  // The strict matcher's verbose name guarantees: a review from
  // "Lauren and Thomas S" on Dec 30 will NOT attach to a Sophie Thomas
  // wedding that inquired May 8 — neither the first-name nor the
  // temporal rule passes.

  const partners: PartnerNamePair[] = people.map((p) => ({
    role: p.role,
    first_name: p.first_name,
    last_name: p.last_name,
  }))

  // No name evidence at all → can't match anything. Skip the DB roundtrip.
  if (
    partners.every((p) => !p.first_name && !p.last_name)
  ) {
    return []
  }

  // Build a loose pre-filter set (first names + last names, lower-case,
  // length >= 3 to avoid "an"/"of" false positives).
  const preFilterTokens = new Set<string>()
  for (const p of partners) {
    if (p.first_name && p.first_name.length >= 3) {
      preFilterTokens.add(p.first_name.toLowerCase())
    }
    if (p.last_name && p.last_name.length >= 3) {
      preFilterTokens.add(p.last_name.toLowerCase())
    }
  }
  if (preFilterTokens.size === 0) return []

  const { data, error } = await supabase
    .from('reviews')
    .select('id, reviewer_name, source, rating, body, review_date')
    .eq('venue_id', venueId)
    .order('review_date', { ascending: false })
    .limit(200) // pre-filter cap; strict matcher narrows
  if (error) {
    console.warn('[reconstruct] loadReviewsForCouple failed:', error.message)
    return []
  }

  // Loose pre-filter — drop reviews that don't have ANY token overlap.
  // (Saves CPU on the strict matcher for venues with thousands of reviews.)
  const looseCandidates: ReviewRow[] = []
  for (const r of (data ?? []) as ReviewRow[]) {
    const name = (r.reviewer_name ?? '').toLowerCase()
    if (!name) continue
    for (const t of preFilterTokens) {
      if (name.includes(t)) {
        looseCandidates.push(r)
        break
      }
    }
  }

  // Strict matcher.
  const wedAnchor = {
    inquiry_date: wedding.inquiry_date,
    wedding_date: wedding.wedding_date,
  }
  const filterResult = filterReviewsForCouple({
    reviews: looseCandidates.map((r) => ({
      id: r.id,
      reviewer_name: r.reviewer_name,
      review_date: r.review_date,
    })),
    partners,
    wedding: wedAnchor,
  })

  // Re-attach the full row shape (filterReviewsForCouple operates on
  // MatchableReview, which only carries id/reviewer_name/review_date).
  const reviewById = new Map(looseCandidates.map((r) => [r.id, r]))
  const filtered: ReviewRow[] = []
  for (const kept of filterResult.kept) {
    if (filtered.length >= MAX_REVIEW_FETCHED) break
    const full = reviewById.get(kept.id)
    if (full) filtered.push(full)
  }

  // Defer-to-queue: any review that PASSED the first-name match but
  // FAILED the temporal guard (i.e. was dropped with reason
  // 'pre_inquiry_temporal' or 'too_old_post_event') is recorded for
  // operator review. We do NOT defer plain no_first_name_match drops —
  // those are signal noise from the loose pre-filter.
  for (const d of filterResult.dropped) {
    if (
      d.reason === 'pre_inquiry_temporal' ||
      d.reason === 'too_old_post_event'
    ) {
      // Re-check first-name match: if it passed, then we have a real
      // temporal-conflict review the operator should audit.
      const full = reviewById.get(d.review.id)
      if (!full) continue
      const v = matchReviewToCouple(
        { id: full.id, reviewer_name: full.reviewer_name, review_date: full.review_date },
        partners,
        wedAnchor,
      )
      // v is matched=false; we already know that. We want to know if a
      // hypothetical relaxation of the temporal guard WOULD have matched —
      // i.e. did the first-name match succeed? Re-run matchByFirstName
      // semantics by checking the verdict reason ordering — pre-inquiry
      // / too-old reasons only fire AFTER the first-name match succeeds
      // in matchReviewToCouple's flow. So if reason is pre_inquiry_temporal
      // OR too_old_post_event we know the name matched.
      void v
      const partner1 = partners.find((p) => p.role === 'partner1') ?? partners[0]
      const partner2 = partners.find((p) => p.role === 'partner2') ?? partners[1]
      const fmtPartner = (p: PartnerNamePair | undefined): string | null =>
        p
          ? [p.first_name, p.last_name].filter(Boolean).join(' ').trim() || null
          : null
      try {
        await deferAmbiguousReview({
          supabase,
          venueId,
          reviewId: full.id,
          candidates: [
            {
              wedding_id: wedding.id,
              partner1_name: fmtPartner(partner1),
              partner2_name: fmtPartner(partner2),
              inquiry_date: wedding.inquiry_date,
              wedding_date: wedding.wedding_date,
              match_reason: 'temporal_pre_inquiry',
            },
          ],
          deferReason: 'pre_inquiry_review',
        })
      } catch {
        // best-effort
      }
    }
  }

  return filtered
}

// ---------------------------------------------------------------------------
// HoneyBook + Calendar + Payment loaders.
//
// HoneyBook lives in the weddings row itself in this codebase (the
// importer writes crm_external_id, crm_team_members, plus the partner
// names go into people rows + booking_value into the wedding shell).
// We expose what we have on the row + a synthesised "honeybook_present"
// flag for the evidence_summary; the model gets the team_members blob
// plus the person rows already on the wedding.
//
// Calendars + payments do NOT have dedicated tables in this codebase
// today. Calendar evidence is implicit in interactions whose subject
// contains "Tour" / "Calendly" / "Invitation" — the model reads those
// from the interactions section directly. This loader returns empty
// arrays and the caller treats that as "no dedicated calendar source"
// → calendar_count counts implicit calendar-shaped interactions.
// ---------------------------------------------------------------------------

function deriveHoneyBookEvidence(
  wedding: WeddingRow,
  people: PersonRow[],
): HoneyBookEvidence | null {
  // If there's no crm_external_id at all and no team members, treat
  // this wedding as not having a HoneyBook record.
  if (!wedding.crm_external_id && !wedding.crm_team_members) return null

  const partner1 = people.find((p) => p.role === 'partner1') ?? null
  const partner2 = people.find((p) => p.role === 'partner2') ?? null

  return {
    external_id: wedding.crm_external_id,
    client_name: partner1
      ? [partner1.first_name, partner1.last_name].filter(Boolean).join(' ').trim() || null
      : null,
    partner_name: partner2
      ? [partner2.first_name, partner2.last_name].filter(Boolean).join(' ').trim() || null
      : null,
    email: partner1?.email ?? null,
    phone: partner1?.phone ?? null,
    team_members: wedding.crm_team_members ?? null,
    notes: wedding.notes,
  }
}

/** Pull calendar-shaped interactions (Calendly invites, tour
 *  confirmations, Google Calendar invites that landed via email) from
 *  the interactions list. The model still sees these interactions in
 *  the email section; this function exists so we can count them in the
 *  evidence_summary and surface them as a separate top-level section
 *  the model can reason about. */
function deriveCalendarEvidence(interactions: InteractionRow[]): CalendarEvidence[] {
  const out: CalendarEvidence[] = []
  let idx = 0
  for (const i of interactions) {
    if (out.length >= MAX_CALENDAR_FETCHED) break
    const subj = (i.subject ?? '').toLowerCase()
    const body = (i.full_body ?? '').toLowerCase()
    const isCalendar =
      subj.includes('invitation') ||
      subj.includes('calendly') ||
      subj.includes('tour confirmation') ||
      subj.includes('your tour') ||
      subj.includes('appointment') ||
      body.includes('calendly.com') ||
      body.includes('google.com/calendar')
    if (!isCalendar) continue
    idx += 1
    out.push({
      index: idx,
      source: subj.includes('calendly') || body.includes('calendly.com') ? 'calendly' : 'calendar_invite',
      title: i.subject,
      attendees: [i.from_name, i.from_email].filter(Boolean).join(' | ') || null,
      timestamp: i.timestamp,
      notes: i.body_preview,
    })
  }
  return out
}

/** Pull calculator-shaped interactions. The codebase doesn't have a
 *  dedicated calculator_submissions table; calculator data lands as a
 *  parsed interaction with a recognisable subject/body. */
function deriveCalculatorEvidence(interactions: InteractionRow[]): CalculatorEvidence[] {
  const out: CalculatorEvidence[] = []
  let idx = 0
  for (const i of interactions) {
    const subj = (i.subject ?? '').toLowerCase()
    const body = (i.full_body ?? '').toLowerCase()
    const isCalc =
      subj.includes('estimate') ||
      subj.includes('calculator') ||
      body.includes('new calculator submission') ||
      body.includes('estimate calculator')
    if (!isCalc) continue
    idx += 1
    out.push({
      index: idx,
      timestamp: i.timestamp,
      // Use the interaction body as the "form_data" payload. The model
      // will parse field labels (Name, Email, Date, Guest Count, etc.)
      // out of the body itself.
      form_data: i.full_body ?? i.body_preview ?? '(empty)',
    })
  }
  return out
}

function deriveHandleEvidence(tangentials: TangentialRow[]): HandleEvidence[] {
  const out: HandleEvidence[] = []
  for (const t of tangentials) {
    const ei = t.extracted_identity ?? null
    if (!ei) continue
    const username = typeof ei.username === 'string' ? ei.username : null
    const handle = typeof ei.handle === 'string' ? ei.handle : null
    const value = (username ?? handle ?? '').trim()
    if (!value) continue
    out.push({
      platform: t.source_platform ?? 'unknown',
      handle: value,
      signal_date: t.signal_date,
      context: t.source_context,
    })
  }
  return out
}

// ---------------------------------------------------------------------------
// Wave 15 — discovery_sources loader
// ---------------------------------------------------------------------------
// Captured "How did you hear about us?" answers from Calendly Q&A,
// intake forms, etc. Counts go into evidence_summary; the most recent
// answer is surfaced on the panel as a single evidence row.

interface DiscoverySourceRow {
  id: string
  canonical_source: string
  answer_text: string
  captured_at: string
}

async function loadDiscoverySources(
  supabase: SupabaseClient,
  weddingId: string,
): Promise<DiscoverySourceRow[]> {
  try {
    const { data, error } = await supabase
      .from('discovery_sources')
      .select('id, canonical_source, answer_text, captured_at')
      .eq('wedding_id', weddingId)
      .order('captured_at', { ascending: false })
      .limit(10)
    if (error) {
      console.warn('[reconstruct] loadDiscoverySources failed:', error.message)
      return []
    }
    return (data ?? []) as DiscoverySourceRow[]
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    console.warn('[reconstruct] loadDiscoverySources threw:', msg)
    return []
  }
}

// ---------------------------------------------------------------------------
// Build the ReconstructionEvidence object.
// ---------------------------------------------------------------------------

async function buildEvidence(
  supabase: SupabaseClient,
  weddingId: string,
): Promise<{
  evidence: ReconstructionEvidence
  summary: EvidenceSummary
  lastSignalAt: string | null
  venueId: string
}> {
  const wedding = await loadWedding(supabase, weddingId)
  if (!wedding) {
    throw new Error(`reconstruct: wedding ${weddingId} not found`)
  }
  const venueId = wedding.venue_id

  // Wave 15: load evidence_overrides FIRST so we can filter every
  // downstream evidence loader's output. Operator override > inferred
  // state. The index is a per-(table, id) map — O(1) per check.
  const overrides: EvidenceOverridesIndex = await loadEvidenceOverrides(
    supabase,
    weddingId,
  )

  const [people, rawInteractions, rawContracts, rawTangentials, venueRow, discoverySources] = await Promise.all([
    loadPeople(supabase, weddingId),
    loadInteractions(supabase, weddingId),
    loadContracts(supabase, weddingId),
    loadTangentials(supabase, weddingId, venueId),
    supabase.from('venues').select('name').eq('id', venueId).maybeSingle(),
    loadDiscoverySources(supabase, weddingId),
  ])

  // Apply override filters to each source.
  const interactions = rawInteractions.filter(
    (i) => !isEvidenceDismissed(overrides, 'interactions', i.id),
  )
  const contracts = rawContracts.filter(
    (c) => !isEvidenceDismissed(overrides, 'contracts', c.id),
  )
  const tangentials = rawTangentials.filter(
    (t) => !isEvidenceDismissed(overrides, 'tangential_signals', t.id),
  )

  // Reviews use the Wave 15 precision matcher (first-name + temporal
  // guard) ALSO filtered by evidence_overrides.
  const rawReviews = await loadReviewsForCouple(supabase, venueId, people, wedding)
  const reviews = rawReviews.filter(
    (r) => !isEvidenceDismissed(overrides, 'reviews', r.id),
  )

  const honeybook = deriveHoneyBookEvidence(wedding, people)
  const calendars = deriveCalendarEvidence(interactions)
  const calculators = deriveCalculatorEvidence(interactions)
  const handles = deriveHandleEvidence(tangentials)
  void discoverySources // Wave 15 — surfaced via evidence_summary; the
                         // prompt schema is sealed so we do NOT thread it
                         // into ReconstructionEvidence (would require a
                         // prompt rev). Counts only.

  // Map interactions to InteractionEvidence with canonicalised
  // direction values + bounded body.
  const interactionEvidence: InteractionEvidence[] = interactions.map((i, idx) => ({
    index: idx + 1,
    direction: (i.direction === 'outbound' ? 'outbound' : 'inbound') as 'inbound' | 'outbound',
    from_email: i.from_email,
    from_name: i.from_name,
    subject: i.subject,
    body: i.full_body ?? i.body_preview ?? null,
    timestamp: i.timestamp,
  }))

  const contractEvidence: ContractEvidence[] = contracts.map((c, idx) => ({
    index: idx + 1,
    filename: c.filename,
    extracted_text: c.extracted_text,
    created_at: c.created_at,
  }))

  const reviewEvidence: ReviewEvidence[] = reviews.map((r, idx) => ({
    index: idx + 1,
    reviewer_name: r.reviewer_name,
    source: r.source ?? 'unknown',
    rating: r.rating,
    body: r.body,
    date: r.review_date,
  }))

  // Payments table doesn't exist as a couple-scoped concept here; the
  // codebase tracks payment amounts on contract / wedding rows. Keep
  // the array empty so the prompt section is suppressed cleanly.
  const payments: PaymentEvidence[] = []

  const venueLabel = (venueRow.data as { name?: string } | null)?.name ?? null

  // last_signal_at = newest of (interaction, contract, tangential).
  const candidates: number[] = []
  for (const i of interactions) {
    if (i.timestamp) candidates.push(Date.parse(i.timestamp))
  }
  for (const c of contracts) {
    if (c.created_at) candidates.push(Date.parse(c.created_at))
  }
  for (const t of tangentials) {
    if (t.signal_date) candidates.push(Date.parse(t.signal_date))
  }
  const lastSignalAt =
    candidates.length > 0 ? new Date(Math.max(...candidates)).toISOString() : null

  const evidence: ReconstructionEvidence = {
    weddingId,
    venueLabel,
    weddingShell: {
      inquiry_date: wedding.inquiry_date,
      wedding_date: wedding.wedding_date,
      status: wedding.status,
      source: wedding.source,
      guest_count_estimate: wedding.guest_count_estimate,
      notes: wedding.notes,
    },
    people: people.map((p) => ({
      role: p.role,
      first_name: p.first_name,
      last_name: p.last_name,
      email: p.email,
      phone: p.phone,
    })),
    interactions: interactionEvidence,
    calculators,
    honeybook,
    calendars,
    reviews: reviewEvidence,
    contracts: contractEvidence,
    payments,
    handles,
  }

  const summary: EvidenceSummary = {
    interactions_count: interactionEvidence.length,
    calculator_count: calculators.length,
    honeybook_present: honeybook !== null,
    calendar_count: calendars.length,
    reviews_count: reviewEvidence.length,
    contracts_count: contractEvidence.length,
    tangentials_count: tangentials.length,
    payments_count: payments.length,
    discovery_sources_count: discoverySources.length,
    discovery_source_recent:
      discoverySources.length > 0
        ? {
            canonical: discoverySources[0].canonical_source,
            answer: discoverySources[0].answer_text,
            captured_at: discoverySources[0].captured_at,
          }
        : null,
    evidence_overrides_count: overrides.rows.length,
  }

  return { evidence, summary, lastSignalAt, venueId }
}

// ---------------------------------------------------------------------------
// Strip code fences from the model output. callAI returns raw text;
// the prompt instructs the model to omit fences but defensive parsing
// still strips them in case the model adds them anyway.
// ---------------------------------------------------------------------------
function stripJsonFences(text: string): string {
  return text.replace(/```json\n?/g, '').replace(/```\n?/g, '').trim()
}

// ---------------------------------------------------------------------------
// Main entry point
// ---------------------------------------------------------------------------

export interface ReconstructOptions {
  /** Optional client override (tests). Defaults to service-role. */
  supabase?: SupabaseClient
  /** Optional correlation id (threaded into api_costs.correlation_id). */
  correlationId?: string
}

/**
 * Reconstruct couple identity for a single wedding. One Sonnet call.
 * Upserts into couple_identity_profile.
 *
 * Throws on:
 *   - wedding not found
 *   - LLM call fails (callAI handles fallback; if both Anthropic AND
 *     OpenAI fail, callAI itself throws)
 *   - LLM response cannot be JSON-parsed or fails schema validation —
 *     the error message includes the raw response for postmortem.
 */
export async function reconstructCoupleIdentity(
  weddingId: string,
  options: ReconstructOptions = {},
): Promise<ReconstructResult> {
  const supabase = options.supabase ?? createServiceClient()
  const correlationId = options.correlationId

  // 1. Gather evidence in parallel.
  const { evidence, summary, lastSignalAt, venueId } = await buildEvidence(supabase, weddingId)

  // 2. Build prompts.
  const systemPrompt = buildSystemPrompt()
  const userPrompt = buildUserPrompt(evidence)

  // 3. Call the Sonnet judge.
  const aiResult = await callAI({
    systemPrompt,
    userPrompt,
    tier: 'sonnet',
    taskType: 'identity_reconstruction',
    contentTier: 2,
    promptVersion: IDENTITY_RECONSTRUCTION_PROMPT_VERSION,
    venueId,
    maxTokens: 6000,
    temperature: 0.2,
    correlationId,
  })

  // 4. Parse + validate.
  const cleaned = stripJsonFences(aiResult.text)
  let parsed: unknown
  try {
    parsed = JSON.parse(cleaned)
  } catch (parseErr) {
    const message = parseErr instanceof Error ? parseErr.message : String(parseErr)
    throw new Error(
      `reconstruct: LLM returned non-JSON. parseError=${message} ` +
        `rawResponse=${cleaned.slice(0, 2000)}`,
    )
  }
  const validation = validateCoupleIdentityProfile(parsed)
  if (!validation.ok) {
    throw new Error(
      `reconstruct: schema validation failed. error=${validation.error} ` +
        `rawResponse=${cleaned.slice(0, 2000)}`,
    )
  }
  const profile = validation.profile

  // 5. Upsert. cost_cents accumulates across reconstructions, so we
  //    read the existing row's cumulative cost first and add the new
  //    call's cost on top. reconstruction_count increments by 1.
  //
  //    aiResult.cost is dollars; cost_cents column stores cents.
  const newCallCostCents = aiResult.cost * 100

  const { data: existing } = await supabase
    .from('couple_identity_profile')
    .select('cost_cents, reconstruction_count, profile, partner1_locked_by_operator, partner2_locked_by_operator')
    .eq('wedding_id', weddingId)
    .maybeSingle()

  const existingCostCents = existing
    ? Number((existing as { cost_cents: number | string }).cost_cents) || 0
    : 0
  const existingCount = existing
    ? Number((existing as { reconstruction_count: number }).reconstruction_count) || 0
    : 0
  const cumulativeCostCents = existingCostCents + newCallCostCents
  const newCount = existing ? existingCount + 1 : 1

  // Step 7 / A1 (2026-05-13): operator name locks. When the existing
  // profile has partner1_locked_by_operator or partner2_locked_by_operator
  // set, preserve the operator-confirmed partner from the previous
  // profile rather than letting the new LLM verdict overwrite it. The
  // judge keeps working on the unlocked partner + every other section
  // (residence, occupations, emotional_truths, etc) — only the name
  // is frozen.
  const partner1Locked = !!(existing as { partner1_locked_by_operator?: boolean } | null)?.partner1_locked_by_operator
  const partner2Locked = !!(existing as { partner2_locked_by_operator?: boolean } | null)?.partner2_locked_by_operator
  const existingProfile = (existing as { profile?: typeof profile } | null)?.profile ?? null
  let mergedProfile = profile
  if ((partner1Locked || partner2Locked) && existingProfile) {
    mergedProfile = {
      ...profile,
      names: {
        ...profile.names,
        partner1: partner1Locked
          ? (existingProfile.names?.partner1 ?? profile.names.partner1)
          : profile.names.partner1,
        partner2: partner2Locked
          ? (existingProfile.names?.partner2 ?? profile.names.partner2)
          : profile.names.partner2,
      },
    }
  }

  const upsertRow = {
    wedding_id: weddingId,
    venue_id: venueId,
    profile: mergedProfile,
    evidence_summary: summary,
    last_reconstructed_at: new Date().toISOString(),
    last_signal_at: lastSignalAt,
    reconstruction_count: newCount,
    prompt_version: IDENTITY_RECONSTRUCTION_PROMPT_VERSION,
    cost_cents: cumulativeCostCents,
  }

  const { error: upsertErr } = await supabase
    .from('couple_identity_profile')
    .upsert(upsertRow, { onConflict: 'wedding_id' })

  if (upsertErr) {
    throw new Error(`reconstruct: upsert failed: ${upsertErr.message}`)
  }

  // Wave 4 Phase 3: project the forensic profile back onto the legacy
  // people / weddings rows so legacy readers (couple-name pickers,
  // inbox row labels, dashboards) read names that match the LLM-judged
  // truth. This is a courtesy for legacy readers; the profile is the
  // source of truth and never depends on the legacy projection. Sync
  // failures log + continue — they must not propagate up into the
  // reconstruction call (the upsert already succeeded).
  try {
    // Lazy import to avoid a circular dependency: profile-to-people-sync
    // imports getStoredCoupleIdentityProfile from this module.
    const { syncProfileToPeople } = await import('./profile-to-people-sync')
    const syncResult = await syncProfileToPeople(weddingId, {
      supabase,
      profile: {
        weddingId,
        venueId,
        profile,
        evidenceSummary: summary,
        lastReconstructedAt: upsertRow.last_reconstructed_at,
        lastSignalAt,
        reconstructionCount: newCount,
        promptVersion: IDENTITY_RECONSTRUCTION_PROMPT_VERSION,
        costCents: cumulativeCostCents,
      },
    })
    if (!syncResult.ok) {
      console.warn(`[reconstruct] profile→people sync skipped: ${syncResult.reason}`)
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    console.warn(`[reconstruct] profile→people sync threw: ${message}`)
  }

  // Wave 5A: enqueue per-couple intel derive whenever the underlying
  // forensic profile changes. Fire-and-forget — the enqueue helper is
  // always-safe and never throws, but we still wrap defensively because
  // the reconstruction itself has already succeeded by this point and
  // any failure here must NOT propagate up. 24h dedupe at the enqueue
  // layer collapses bursts.
  try {
    const { enqueueCoupleIntel } = await import('@/lib/services/intel/enqueue-couple-intel')
    const enqueueResult = await enqueueCoupleIntel({
      weddingId,
      venueId,
      triggerSignal: 'profile_updated',
      supabase,
    })
    if (enqueueResult.skipped) {
      console.log(
        `[reconstruct] couple-intel enqueue skipped: ${enqueueResult.reason}`,
        { weddingId },
      )
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    console.warn(`[reconstruct] couple-intel enqueue threw: ${message}`)
  }

  return {
    profile,
    costCents: newCallCostCents,
    promptVersion: IDENTITY_RECONSTRUCTION_PROMPT_VERSION,
    evidenceSummary: summary,
    inputTokens: aiResult.inputTokens,
    outputTokens: aiResult.outputTokens,
    reconstructionCount: newCount,
    lastSignalAt,
  }
}

/**
 * Read the stored profile for a wedding. Returns null when no row
 * exists. Used by GET /api/admin/identity/reconstruct and by every
 * read surface (Phase 3) to avoid re-extracting from raw bodies.
 */
export interface StoredCoupleIdentityProfile {
  weddingId: string
  venueId: string
  profile: CoupleIdentityProfile
  evidenceSummary: EvidenceSummary
  lastReconstructedAt: string
  lastSignalAt: string | null
  reconstructionCount: number
  promptVersion: string
  costCents: number
}

export async function getStoredCoupleIdentityProfile(
  weddingId: string,
  options: { supabase?: SupabaseClient } = {},
): Promise<StoredCoupleIdentityProfile | null> {
  const supabase = options.supabase ?? createServiceClient()
  const { data, error } = await supabase
    .from('couple_identity_profile')
    .select(
      'wedding_id, venue_id, profile, evidence_summary, last_reconstructed_at, last_signal_at, reconstruction_count, prompt_version, cost_cents',
    )
    .eq('wedding_id', weddingId)
    .maybeSingle()
  if (error) {
    console.warn('[reconstruct] getStoredCoupleIdentityProfile failed:', error.message)
    return null
  }
  if (!data) return null
  const row = data as {
    wedding_id: string
    venue_id: string
    profile: CoupleIdentityProfile
    evidence_summary: EvidenceSummary
    last_reconstructed_at: string
    last_signal_at: string | null
    reconstruction_count: number
    prompt_version: string
    cost_cents: number | string
  }
  return {
    weddingId: row.wedding_id,
    venueId: row.venue_id,
    profile: row.profile,
    evidenceSummary: row.evidence_summary,
    lastReconstructedAt: row.last_reconstructed_at,
    lastSignalAt: row.last_signal_at,
    reconstructionCount: row.reconstruction_count,
    promptVersion: row.prompt_version,
    costCents: Number(row.cost_cents) || 0,
  }
}
