/**
 * Bloom House — Wave 13 review solicitation pipeline.
 *
 * Anchor docs:
 *   - bloom-constitution.md (Sage drafts go to coordinator review;
 *     never auto-sent; sensitive themes are voice-shape only)
 *   - bloom-wave4-identity-reconstruction.md (Phase 3 read surfaces;
 *     the forensic profile + 5A intel drive personalised drafting)
 *
 * What this service does
 * ----------------------
 * Given a weddingId whose event has wrapped, draft a personalised
 * review-solicitation email and route it to coordinator approval via
 * the `drafts` table. Also writes a review_solicit_requests row so we
 * can:
 *   - dedupe repeat solicitations (no more than once per 30 days)
 *   - reconcile a received review back to the request (matched by
 *     reviewer name + venue) and update status to 'review_received'
 *
 * Channel selection is DETERMINISTIC. The couple's
 * couple_identity_profile.handles drive the choice:
 *   - knot handle present     → target='knot'
 *   - weddingwire handle      → target='weddingwire'
 *   - otherwise               → target='google' (universal fallback)
 *
 * The Sonnet draft personalises against:
 *   - venue archetype (Wave 5D venue_thesis paraphrase)
 *   - couple_brief (Wave 5A coordinator_brief — sensitive themes
 *     already voice-shape only at that layer)
 *   - tour-moments (Wave 13 brief.key_facts + what_to_lead_with when
 *     a brief was generated for this couple's tour)
 *
 * Wave 13 NEVER auto-sends. Coordinator approves + sends from the
 * existing Sage draft flow.
 */

import type { SupabaseClient } from '@supabase/supabase-js'
import { createServiceClient } from '@/lib/supabase/service'
import { callAI } from '@/lib/ai/client'
import {
  REVIEW_SOLICIT_PROMPT_VERSION,
  buildReviewSolicitSystemPrompt,
  buildReviewSolicitUserPrompt,
  validateReviewSolicitOutput,
  type ReviewSolicitEvidence,
  type ReviewSolicitOutput,
  type ReviewTargetChannel,
} from '@/config/prompts/review-solicit'
import type { CoupleIdentityProfile } from '@/config/prompts/identity-reconstruction'
import type { CoupleIntelOutput } from '@/config/prompts/couple-intel-derive'
import { dedupePeopleByName } from '@/lib/utils/couple-name'
import { getStoredTourPrepBrief } from '@/lib/services/tour/prep-brief'

export { REVIEW_SOLICIT_PROMPT_VERSION } from '@/config/prompts/review-solicit'

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface SolicitReviewArgs {
  weddingId: string
  /** Optional override; otherwise picked deterministically from handles. */
  channel?: ReviewTargetChannel
  supabase?: SupabaseClient
  correlationId?: string
}

export interface SolicitReviewResult {
  ok: true
  requestId: string
  draftId: string | null
  weddingId: string
  venueId: string
  targetChannel: ReviewTargetChannel
  reviewLinkUrl: string | null
  draft: ReviewSolicitOutput
  costCents: number
  promptVersion: string
  inputTokens: number
  outputTokens: number
}

export interface SkipSolicitReviewResult {
  ok: false
  reason: string
}

const DEDUPE_WINDOW_DAYS = 30

// ---------------------------------------------------------------------------
// Channel selection
// ---------------------------------------------------------------------------

interface ChannelDecision {
  channel: ReviewTargetChannel
  link: string | null
}

function normaliseHandlePlatform(p: string | null | undefined): string {
  return (p ?? '').toLowerCase().trim()
}

/**
 * Pick the target channel deterministically. Order of preference:
 *   1. Caller override
 *   2. Knot handle in the forensic profile
 *   3. WeddingWire handle
 *   4. Generic google fallback
 *
 * Link is derived where we have enough signal — Knot/WW handles can be
 * turned into a profile URL but the underlying review-page URL is per-
 * venue. We surface the venue review-page URL when stored on venue_config,
 * else we leave link=null and the model writes "search for us on Google"-
 * style copy that the coordinator can paste the link into before sending.
 */
function pickChannel(
  profile: CoupleIdentityProfile | null,
  venueReviewLinks: VenueReviewLinks,
  override?: ReviewTargetChannel,
): ChannelDecision {
  if (override) {
    return { channel: override, link: venueReviewLinks[override] ?? null }
  }
  if (profile?.handles && Array.isArray(profile.handles)) {
    const hasKnot = profile.handles.some(
      (h) => normaliseHandlePlatform(h.platform) === 'knot' || normaliseHandlePlatform(h.platform) === 'theknot',
    )
    if (hasKnot && venueReviewLinks.knot) {
      return { channel: 'knot', link: venueReviewLinks.knot }
    }
    if (hasKnot) {
      return { channel: 'knot', link: null }
    }
    const hasWW = profile.handles.some(
      (h) => normaliseHandlePlatform(h.platform) === 'weddingwire',
    )
    if (hasWW) {
      return { channel: 'weddingwire', link: venueReviewLinks.weddingwire ?? null }
    }
  }
  return { channel: 'google', link: venueReviewLinks.google ?? null }
}

// ---------------------------------------------------------------------------
// Loaders
// ---------------------------------------------------------------------------

interface WeddingRow {
  id: string
  venue_id: string
  wedding_date: string | null
  status: string | null
}

async function loadWedding(
  supabase: SupabaseClient,
  weddingId: string,
): Promise<WeddingRow | null> {
  const { data, error } = await supabase
    .from('weddings')
    .select('id, venue_id, wedding_date, status')
    .eq('id', weddingId)
    .maybeSingle()
  if (error) throw new Error(`solicit.loadWedding failed: ${error.message}`)
  return (data as WeddingRow | null) ?? null
}

async function loadProfile(
  supabase: SupabaseClient,
  weddingId: string,
): Promise<CoupleIdentityProfile | null> {
  const { data } = await supabase
    .from('couple_identity_profile')
    .select('profile')
    .eq('wedding_id', weddingId)
    .maybeSingle()
  if (!data) return null
  return (data as { profile: CoupleIdentityProfile }).profile
}

async function loadCoupleIntel(
  supabase: SupabaseClient,
  weddingId: string,
): Promise<CoupleIntelOutput | null> {
  const { data } = await supabase
    .from('couple_intel')
    .select('intel')
    .eq('wedding_id', weddingId)
    .maybeSingle()
  if (!data) return null
  return (data as { intel: CoupleIntelOutput }).intel
}

async function loadVenueArchetype(
  supabase: SupabaseClient,
  venueId: string,
): Promise<string | null> {
  const { data } = await supabase
    .from('venue_thesis')
    .select('thesis')
    .eq('venue_id', venueId)
    .maybeSingle()
  if (!data) return null
  const thesis = (data as { thesis: Record<string, unknown> }).thesis ?? {}
  const archetypeBlock = thesis.venue_archetype as
    | { label?: string; summary?: string; description?: string }
    | string
    | undefined
  if (!archetypeBlock) return null
  if (typeof archetypeBlock === 'string') return archetypeBlock
  const parts: string[] = []
  if (archetypeBlock.label) parts.push(archetypeBlock.label)
  if (archetypeBlock.summary) parts.push(archetypeBlock.summary)
  if (archetypeBlock.description) parts.push(archetypeBlock.description)
  return parts.join(' — ') || null
}

interface VenueReviewLinks {
  knot: string | null
  weddingwire: string | null
  google: string | null
  yelp: string | null
  facebook: string | null
  other: string | null
}

async function loadVenueReviewLinks(
  supabase: SupabaseClient,
  venueId: string,
): Promise<VenueReviewLinks> {
  // venue_config may carry per-platform review URLs in a jsonb blob.
  // Tolerant fallback: empty links shape when nothing is configured.
  try {
    const { data } = await supabase
      .from('venue_config')
      .select('review_links')
      .eq('venue_id', venueId)
      .maybeSingle()
    const raw = (data as { review_links?: Record<string, string> | null } | null)?.review_links ?? {}
    return {
      knot: raw.knot ?? null,
      weddingwire: raw.weddingwire ?? null,
      google: raw.google ?? null,
      yelp: raw.yelp ?? null,
      facebook: raw.facebook ?? null,
      other: raw.other ?? null,
    }
  } catch {
    return {
      knot: null,
      weddingwire: null,
      google: null,
      yelp: null,
      facebook: null,
      other: null,
    }
  }
}

async function loadVenuePersonality(
  supabase: SupabaseClient,
  venueId: string,
): Promise<{ aiName: string; venueLabel: string; coordinatorName: string | null }> {
  const [ai, venue, cfg] = await Promise.all([
    supabase
      .from('venue_ai_config')
      .select('ai_name')
      .eq('venue_id', venueId)
      .maybeSingle(),
    supabase
      .from('venues')
      .select('name')
      .eq('id', venueId)
      .maybeSingle(),
    supabase
      .from('venue_config')
      .select('coordinator_name')
      .eq('venue_id', venueId)
      .maybeSingle(),
  ])
  const aiName =
    ((ai.data as { ai_name?: string | null } | null)?.ai_name) ?? 'Sage'
  const venueLabel =
    ((venue.data as { name?: string } | null)?.name) ?? 'the venue'
  const coordinatorName =
    ((cfg.data as { coordinator_name?: string | null } | null)?.coordinator_name) ?? null
  return { aiName, venueLabel, coordinatorName }
}

async function loadCoupleDisplayName(
  supabase: SupabaseClient,
  weddingId: string,
): Promise<string | null> {
  const { data } = await supabase
    .from('people')
    .select('first_name, last_name, role')
    .eq('wedding_id', weddingId)
    .in('role', ['partner1', 'partner2', 'bride', 'groom', 'partner'])
  if (!data || data.length === 0) return null
  const deduped = dedupePeopleByName(
    data as Array<{ first_name: string | null; last_name: string | null; role: string }>,
  )
  const names = deduped
    .map((p) => p.first_name ?? '')
    .filter((s) => s.trim().length > 0)
  if (names.length === 0) return null
  return names.slice(0, 2).join(' & ')
}

/**
 * Pull tour-moments from the most-recent tour-prep brief on this
 * wedding. Used to give the review-solicit draft something concrete to
 * reference (e.g. "what you mentioned about the lakeside ceremony").
 */
async function loadTourMoments(
  supabase: SupabaseClient,
  weddingId: string,
): Promise<string[]> {
  const { data } = await supabase
    .from('tours')
    .select('id')
    .eq('wedding_id', weddingId)
    .order('scheduled_at', { ascending: false })
    .limit(1)
  if (!data || data.length === 0) return []
  const tourId = (data[0] as { id: string }).id
  const brief = await getStoredTourPrepBrief(tourId, { supabase })
  if (!brief) return []
  const moments: string[] = []
  if (brief.brief.what_to_lead_with) {
    moments.push('Lead-in from tour prep: ' + brief.brief.what_to_lead_with)
  }
  for (const f of brief.brief.key_facts.slice(0, 3)) {
    moments.push(`${f.fact} — ${f.why_it_matters}`)
  }
  return moments
}

function stripJsonFences(text: string): string {
  return text.replace(/```json\n?/g, '').replace(/```\n?/g, '').trim()
}

function daysBetween(iso: string | null, now: number): number | null {
  if (!iso) return null
  const t = Date.parse(iso)
  if (!Number.isFinite(t)) return null
  return Math.floor((now - t) / 86_400_000)
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Generate a personalised review-solicitation draft + write a
 * review_solicit_requests row. The draft also lands in `drafts` for
 * coordinator review (NEVER auto-sent).
 *
 * Dedupes against any prior solicit-request for the same wedding within
 * the last 30 days.
 */
export async function solicitReview(
  args: SolicitReviewArgs,
): Promise<SolicitReviewResult | SkipSolicitReviewResult> {
  const supabase = args.supabase ?? createServiceClient()

  const wedding = await loadWedding(supabase, args.weddingId)
  if (!wedding) return { ok: false, reason: 'wedding not found' }
  const venueId = wedding.venue_id

  // 30-day dedupe.
  const sinceIso = new Date(
    Date.now() - DEDUPE_WINDOW_DAYS * 24 * 60 * 60 * 1000,
  ).toISOString()
  const { data: existing } = await supabase
    .from('review_solicit_requests')
    .select('id, status, generated_at')
    .eq('wedding_id', args.weddingId)
    .gte('generated_at', sinceIso)
    .order('generated_at', { ascending: false })
    .limit(1)
    .maybeSingle()
  if (existing) {
    return {
      ok: false,
      reason: `dedupe_${DEDUPE_WINDOW_DAYS}d: prior request ${(existing as { id: string }).id}`,
    }
  }

  const [
    profile,
    intel,
    archetype,
    reviewLinks,
    personality,
    coupleDisplay,
    tourMoments,
  ] = await Promise.all([
    loadProfile(supabase, args.weddingId),
    loadCoupleIntel(supabase, args.weddingId),
    loadVenueArchetype(supabase, venueId),
    loadVenueReviewLinks(supabase, venueId),
    loadVenuePersonality(supabase, venueId),
    loadCoupleDisplayName(supabase, args.weddingId),
    loadTourMoments(supabase, args.weddingId),
  ])

  const decision = pickChannel(profile, reviewLinks, args.channel)
  const daysSinceEvent = daysBetween(wedding.wedding_date, Date.now())

  const evidence: ReviewSolicitEvidence = {
    weddingId: args.weddingId,
    venueLabel: personality.venueLabel,
    coupleDisplayName: coupleDisplay,
    targetChannel: decision.channel,
    reviewLinkUrl: decision.link,
    eventDate: wedding.wedding_date,
    daysSinceEvent,
    aiName: personality.aiName,
    coordinatorName: personality.coordinatorName,
    venueArchetype: archetype,
    coupleBrief: intel?.coordinator_brief ?? null,
    tourMoments,
  }

  const systemPrompt = buildReviewSolicitSystemPrompt(
    decision.channel,
    personality.aiName,
    personality.venueLabel,
  )
  const userPrompt = buildReviewSolicitUserPrompt(evidence)

  const aiResult = await callAI({
    systemPrompt,
    userPrompt,
    tier: 'sonnet',
    taskType: 'review_solicit',
    contentTier: 2,
    promptVersion: REVIEW_SOLICIT_PROMPT_VERSION,
    venueId,
    maxTokens: 900,
    temperature: 0.4,
    correlationId: args.correlationId,
  })

  const cleaned = stripJsonFences(aiResult.text)
  let parsed: unknown
  try {
    parsed = JSON.parse(cleaned)
  } catch (parseErr) {
    const message = parseErr instanceof Error ? parseErr.message : String(parseErr)
    throw new Error(
      `solicitReview: LLM returned non-JSON. parseError=${message} raw=${cleaned.slice(0, 1500)}`,
    )
  }
  const validation = validateReviewSolicitOutput(parsed)
  if (!validation.ok) {
    throw new Error(
      `solicitReview: schema validation failed. error=${validation.error} raw=${cleaned.slice(0, 1500)}`,
    )
  }
  const draft = validation.output
  const costCents = aiResult.cost * 100

  // Insert the draft into the existing drafts table. context_type='client'
  // because the recipient is a booked couple post-event.
  const { data: insertedDraft, error: insErr } = await supabase
    .from('drafts')
    .insert({
      venue_id: venueId,
      wedding_id: args.weddingId,
      subject: draft.subject,
      draft_body: draft.body,
      status: 'pending',
      context_type: 'client',
      brain_used: 'review_solicit',
      model_used: 'sonnet',
      tokens_used: aiResult.inputTokens + aiResult.outputTokens,
      cost: aiResult.cost,
      confidence_score: 80,
      auto_sent: false,
    })
    .select('id')
    .single()
  const draftId = insErr || !insertedDraft ? null : (insertedDraft as { id: string }).id

  // Insert the solicitation request row. Status starts 'queued' — flips
  // to 'sent' when the coordinator approves and the email goes out;
  // 'review_received' on reconciliation; 'declined' / 'no_response'
  // via downstream signals.
  const { data: requestRow, error: reqErr } = await supabase
    .from('review_solicit_requests')
    .insert({
      wedding_id: args.weddingId,
      venue_id: venueId,
      status: 'queued',
      target_channel: decision.channel,
      review_link_url: decision.link,
      subject: draft.subject,
      body: draft.body,
      draft_id: draftId,
      prompt_version: REVIEW_SOLICIT_PROMPT_VERSION,
      cost_cents: costCents,
    })
    .select('id')
    .single()
  if (reqErr || !requestRow) {
    throw new Error(
      `solicitReview: request insert failed: ${reqErr?.message ?? 'unknown'}`,
    )
  }
  const requestId = (requestRow as { id: string }).id

  return {
    ok: true,
    requestId,
    draftId,
    weddingId: args.weddingId,
    venueId,
    targetChannel: decision.channel,
    reviewLinkUrl: decision.link,
    draft,
    costCents,
    promptVersion: REVIEW_SOLICIT_PROMPT_VERSION,
    inputTokens: aiResult.inputTokens,
    outputTokens: aiResult.outputTokens,
  }
}

// ---------------------------------------------------------------------------
// Enqueue helper (Wave 11 post_event stage-trigger fan-out)
// ---------------------------------------------------------------------------

export interface EnqueueReviewSolicitArgs {
  weddingId: string
  venueId: string
  triggerSignal: string
  supabase?: SupabaseClient
}

export interface EnqueueResult {
  jobId: string | null
  skipped: boolean
  reason?: string
}

/**
 * Enqueue a review-solicit job. Dedupes against any queued/running job
 * AND against the 30-day request-window dedupe.
 *
 * Never throws.
 */
export async function enqueueReviewSolicit(
  args: EnqueueReviewSolicitArgs,
): Promise<EnqueueResult> {
  const supabase = args.supabase ?? createServiceClient()
  try {
    // 30-day request-window dedupe first — the strongest signal.
    const sinceIso = new Date(
      Date.now() - DEDUPE_WINDOW_DAYS * 24 * 60 * 60 * 1000,
    ).toISOString()
    const { data: priorRequest } = await supabase
      .from('review_solicit_requests')
      .select('id')
      .eq('wedding_id', args.weddingId)
      .gte('generated_at', sinceIso)
      .limit(1)
      .maybeSingle()
    if (priorRequest) {
      return {
        jobId: null,
        skipped: true,
        reason: 'request_dedupe_30d',
      }
    }

    // Per-queue dedupe (24h).
    const queueSinceIso = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString()
    const { data: existing } = await supabase
      .from('review_solicit_jobs')
      .select('id')
      .eq('wedding_id', args.weddingId)
      .in('status', ['queued', 'running'])
      .gte('enqueued_at', queueSinceIso)
      .limit(1)
      .maybeSingle()
    if (existing) {
      return {
        jobId: (existing as { id: string }).id,
        skipped: true,
        reason: 'queue_dedupe_24h',
      }
    }

    const { data: inserted, error } = await supabase
      .from('review_solicit_jobs')
      .insert({
        wedding_id: args.weddingId,
        venue_id: args.venueId,
        status: 'queued',
        trigger_signal: args.triggerSignal,
      })
      .select('id')
      .single()
    if (error || !inserted) {
      return {
        jobId: null,
        skipped: true,
        reason: 'insert_failed: ' + (error?.message ?? 'unknown'),
      }
    }
    return { jobId: (inserted as { id: string }).id, skipped: false }
  } catch (err) {
    return {
      jobId: null,
      skipped: true,
      reason: 'threw: ' + (err instanceof Error ? err.message : String(err)),
    }
  }
}

// ---------------------------------------------------------------------------
// Reconciliation — link a received review back to a solicitation request
// ---------------------------------------------------------------------------

export interface ReconcileArgs {
  reviewId: string
  supabase?: SupabaseClient
}

export interface ReconcileResult {
  ok: boolean
  matchedRequestId: string | null
  reason?: string
}

/**
 * When a review lands (existing review-ingestion path), call this to
 * fuzzy-match the reviewer name against any outstanding
 * review_solicit_requests rows for the same venue. On match:
 *   - set review_solicit_requests.status = 'review_received'
 *   - link review_id
 *   - stamp response_received_at
 *   - set reviews.wedding_id (backfill the linkage)
 *
 * Returns ok:true regardless of whether a match was found — the only
 * failure mode is a DB error.
 */
export async function reconcileReceivedReviewWithSolicitation(
  args: ReconcileArgs,
): Promise<ReconcileResult> {
  const supabase = args.supabase ?? createServiceClient()

  // 1. Load the review.
  const { data: reviewRow, error: rErr } = await supabase
    .from('reviews')
    .select('id, venue_id, reviewer_name, wedding_id')
    .eq('id', args.reviewId)
    .maybeSingle()
  if (rErr) {
    return {
      ok: false,
      matchedRequestId: null,
      reason: 'review fetch failed: ' + rErr.message,
    }
  }
  if (!reviewRow) {
    return {
      ok: false,
      matchedRequestId: null,
      reason: 'review not found',
    }
  }
  const review = reviewRow as {
    id: string
    venue_id: string
    reviewer_name: string | null
    wedding_id: string | null
  }
  if (!review.reviewer_name || !review.reviewer_name.trim()) {
    return {
      ok: true,
      matchedRequestId: null,
      reason: 'no reviewer_name to match on',
    }
  }
  if (review.wedding_id) {
    // Already linked — nothing to do.
    return {
      ok: true,
      matchedRequestId: null,
      reason: 'review already linked to wedding',
    }
  }

  // 2. Pull outstanding solicit requests for this venue (status='sent',
  //    or 'queued' since coordinator may have sent without flipping status).
  const { data: requests, error: rqErr } = await supabase
    .from('review_solicit_requests')
    .select('id, wedding_id, status, generated_at')
    .eq('venue_id', review.venue_id)
    .in('status', ['queued', 'sent'])
    .order('generated_at', { ascending: false })
    .limit(200)
  if (rqErr) {
    return {
      ok: false,
      matchedRequestId: null,
      reason: 'requests fetch failed: ' + rqErr.message,
    }
  }
  const reqRows = (requests ?? []) as Array<{
    id: string
    wedding_id: string
    status: string
    generated_at: string
  }>
  if (reqRows.length === 0) {
    return { ok: true, matchedRequestId: null, reason: 'no outstanding requests' }
  }

  // 3. For each request, load couple names + try a fuzzy match.
  const reviewerNorm = normaliseName(review.reviewer_name)
  let matchedRequestId: string | null = null
  let matchedWeddingId: string | null = null

  for (const r of reqRows) {
    const { data: people } = await supabase
      .from('people')
      .select('first_name, last_name, role')
      .eq('wedding_id', r.wedding_id)
      .in('role', ['partner1', 'partner2', 'bride', 'groom', 'partner'])
    const peopleRows =
      (people ?? []) as Array<{
        first_name: string | null
        last_name: string | null
        role: string
      }>
    if (peopleRows.length === 0) continue
    const deduped = dedupePeopleByName(peopleRows)
    if (matchesReviewerName(reviewerNorm, deduped)) {
      matchedRequestId = r.id
      matchedWeddingId = r.wedding_id
      break
    }
  }

  if (!matchedRequestId || !matchedWeddingId) {
    return { ok: true, matchedRequestId: null, reason: 'no fuzzy match' }
  }

  // 4. Update the request + the review.
  const now = new Date().toISOString()
  await supabase
    .from('review_solicit_requests')
    .update({
      status: 'review_received',
      review_id: review.id,
      response_received_at: now,
    })
    .eq('id', matchedRequestId)

  await supabase
    .from('reviews')
    .update({ wedding_id: matchedWeddingId })
    .eq('id', review.id)

  return { ok: true, matchedRequestId }
}

function normaliseName(raw: string): string {
  return raw
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

function matchesReviewerName(
  reviewerNorm: string,
  people: Array<{ first_name: string | null; last_name: string | null }>,
): boolean {
  if (!reviewerNorm) return false
  const reviewerTokens = new Set(reviewerNorm.split(' ').filter((t) => t.length >= 2))
  for (const p of people) {
    const candidate = [p.first_name, p.last_name].filter(Boolean).join(' ')
    if (!candidate) continue
    const candNorm = normaliseName(candidate)
    if (!candNorm) continue
    if (candNorm === reviewerNorm) return true
    // Token-overlap: reviewer "Sarah K" matches couple "Sarah Kim" via
    // exact first-name match + first-letter-of-last (Knot anonymises).
    const candTokens = candNorm.split(' ').filter((t) => t.length >= 2)
    if (candTokens.length === 0) continue
    // Full first-name match + matching last-name OR last-initial:
    const reviewerFirst = [...reviewerTokens][0]
    const reviewerLast = [...reviewerTokens][reviewerTokens.size - 1]
    const candFirst = candTokens[0]
    const candLast = candTokens[candTokens.length - 1]
    if (reviewerFirst === candFirst) {
      if (!reviewerLast || reviewerLast === reviewerFirst) {
        // Reviewer-only-first-name shape — couple-first-name match is
        // enough only when the couple has just one first name in scope.
        if (candTokens.length === 1) return true
        continue
      }
      if (reviewerLast === candLast) return true
      // Knot last-initial shape: reviewer "sarah k", couple "sarah kim"
      if (reviewerLast.length === 1 && candLast.startsWith(reviewerLast)) {
        return true
      }
    }
  }
  return false
}
