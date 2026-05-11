/**
 * Bloom House — Wave 15 review-to-couple precision matcher.
 *
 * Anchor docs:
 *   - bloom-constitution.md (forensic identity reconstruction; evidence
 *     precision is constitutional. Reviews older than the couple's
 *     inquiry are NEVER theirs — that's a hard rule.)
 *   - bloom-wave4-identity-reconstruction.md (evidence loader gets
 *     stricter; the prompt + schema stay sealed)
 *   - feedback_deep_fix_vs_bandaid.md (deterministic rule, NOT an LLM
 *     judge — first-name match + temporal guard is unambiguous)
 *
 * What this module does
 * ---------------------
 * Replaces the loose "any surname token contained in reviewer_name"
 * match with a stricter rule shared between reconstruct.ts (Wave 4)
 * and build-timeline.ts (Wave 12):
 *
 *   - FIRST-NAME match required: the first token of reviewer_name
 *     must align with first_name of partner1 OR partner2. A surname
 *     token match alone is NOT sufficient.
 *   - Temporal guard: the review's review_date MUST be >= the
 *     wedding's inquiry_date OR within 6 months of event_date.
 *     Reviews older than the couple's inquiry are NEVER theirs.
 *   - Defer on ambiguity: when first-name match succeeds and the
 *     review last-name token matches MULTIPLE candidate weddings,
 *     log to review_match_review_queue instead of guessing.
 *
 * This module exports both:
 *   - matchReviewToCouple(): pure scoring — does a SINGLE review match a
 *     known wedding's partner list?
 *   - filterReviewsForCouple(): the high-level loader used by Wave 4
 *     reconstruct + Wave 12 timeline — given all venue reviews, returns
 *     ONLY rows that pass first-name + temporal guard.
 *
 * Defer-to-queue behaviour lives in deferAmbiguousReview() which is
 * called from the higher-level orchestrator when multiple weddings
 * compete for the same review.
 */

import type { SupabaseClient } from '@supabase/supabase-js'

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface PartnerNamePair {
  /** 'partner1' / 'partner2' / null when role unknown */
  role: string | null
  first_name: string | null
  last_name: string | null
}

export interface MatchableReview {
  id: string
  reviewer_name: string | null
  review_date: string | null
}

export interface WeddingTemporalAnchor {
  inquiry_date: string | null
  /** wedding_date or event_date — same column in this codebase */
  wedding_date: string | null
}

export type ReviewMatchVerdict =
  | { matched: true; matchReason: 'first_name_full' | 'first_name_only' }
  | { matched: false; reason:
      | 'no_reviewer_name'
      | 'no_first_name_match'
      | 'pre_inquiry_temporal'
      | 'too_old_post_event'
      | 'no_anchor_dates'
  }

// ---------------------------------------------------------------------------
// Normalisation
// ---------------------------------------------------------------------------

function normalise(s: string | null | undefined): string {
  if (!s) return ''
  return s
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

function splitTokens(s: string | null | undefined): string[] {
  const n = normalise(s)
  if (!n) return []
  return n.split(' ').filter((t) => t.length >= 2)
}

/** First name extraction from reviewer_name. "Lauren and Thomas S" → "lauren".
 *  "Sarah Chen" → "sarah". Single-token names ("anonymous") return the token. */
function firstNameToken(reviewerName: string | null): string | null {
  const tokens = splitTokens(reviewerName)
  return tokens[0] ?? null
}

/** All name tokens (first + middle/last + couple-name parts). */
function allTokens(reviewerName: string | null): string[] {
  return splitTokens(reviewerName)
}

// ---------------------------------------------------------------------------
// Temporal guard
// ---------------------------------------------------------------------------

/** 6 months in milliseconds (using 30-day months as a defensive bound;
 *  reviews posted >6mo after the event are extremely rare and almost
 *  always belong to a different couple with the same name). */
const POST_EVENT_WINDOW_MS = 6 * 30 * 24 * 60 * 60 * 1000

/**
 * The constitutional rule: review.review_date MUST be >= inquiry_date
 * (a review predating the couple's first contact with the venue can't
 * possibly be theirs) OR — when inquiry_date is missing — within 6
 * months either side of event_date.
 *
 * Returns:
 *   'ok' — temporally consistent with this wedding
 *   'pre_inquiry_temporal' — review predates the wedding's inquiry
 *   'too_old_post_event' — review > 6 months after the event
 *   'no_anchor_dates' — neither inquiry_date nor wedding_date available;
 *                       fail-safe defer (return false)
 */
export function temporalAlignment(
  review: MatchableReview,
  wedding: WeddingTemporalAnchor,
): 'ok' | 'pre_inquiry_temporal' | 'too_old_post_event' | 'no_anchor_dates' {
  if (!review.review_date) return 'no_anchor_dates'
  const reviewT = Date.parse(review.review_date)
  if (!Number.isFinite(reviewT)) return 'no_anchor_dates'

  const inquiryT = wedding.inquiry_date ? Date.parse(wedding.inquiry_date) : NaN
  const weddingT = wedding.wedding_date ? Date.parse(wedding.wedding_date) : NaN

  // Hard rule: review predating inquiry is NEVER theirs.
  if (Number.isFinite(inquiryT)) {
    if (reviewT < inquiryT) return 'pre_inquiry_temporal'
  } else if (Number.isFinite(weddingT)) {
    // No inquiry — fall back to event date. Anchor to event - 18 months
    // as the earliest plausible inquiry (typical lead time).
    const plausibleInquiryT = weddingT - 18 * 30 * 24 * 60 * 60 * 1000
    if (reviewT < plausibleInquiryT) return 'pre_inquiry_temporal'
  } else {
    return 'no_anchor_dates'
  }

  // Soft rule: review > 6mo AFTER event_date is highly unlikely to
  // belong to this couple.
  if (Number.isFinite(weddingT) && reviewT > weddingT + POST_EVENT_WINDOW_MS) {
    return 'too_old_post_event'
  }

  return 'ok'
}

// ---------------------------------------------------------------------------
// First-name match
// ---------------------------------------------------------------------------

/**
 * Does the reviewer's first-name align with partner1's OR partner2's
 * first_name? Optionally requires a last-name match too for a "full"
 * verdict.
 */
export function matchByFirstName(
  review: MatchableReview,
  partners: PartnerNamePair[],
): { ok: boolean; tier: 'full' | 'first_only' | 'none' } {
  const reviewerFirst = firstNameToken(review.reviewer_name)
  if (!reviewerFirst) return { ok: false, tier: 'none' }

  const reviewerTokens = allTokens(review.reviewer_name)
  // Also include any token that LOOKS like a first name (handles
  // "Lauren and Thomas S" — "Lauren" + "Thomas" should both be checked).
  // The "and" / "&" conjunctions are filtered by normalise().
  const candidateFirsts = new Set<string>([reviewerFirst])
  for (const t of reviewerTokens) {
    if (t.length >= 3 && t !== 'and') candidateFirsts.add(t)
  }

  let fullMatch = false
  let firstOnly = false

  for (const p of partners) {
    const pFirst = normalise(p.first_name)
    const pLast = normalise(p.last_name)
    if (!pFirst) continue
    if (!candidateFirsts.has(pFirst)) continue
    // First-name hit. Promote to "full" if a last-name token also matches.
    if (pLast && reviewerTokens.some((t) => t === pLast)) {
      fullMatch = true
    } else {
      firstOnly = true
    }
  }

  if (fullMatch) return { ok: true, tier: 'full' }
  if (firstOnly) return { ok: true, tier: 'first_only' }
  return { ok: false, tier: 'none' }
}

// ---------------------------------------------------------------------------
// Combined verdict
// ---------------------------------------------------------------------------

export function matchReviewToCouple(
  review: MatchableReview,
  partners: PartnerNamePair[],
  wedding: WeddingTemporalAnchor,
): ReviewMatchVerdict {
  if (!review.reviewer_name || !review.reviewer_name.trim()) {
    return { matched: false, reason: 'no_reviewer_name' }
  }

  const temporal = temporalAlignment(review, wedding)
  if (temporal === 'pre_inquiry_temporal') {
    return { matched: false, reason: 'pre_inquiry_temporal' }
  }
  if (temporal === 'too_old_post_event') {
    return { matched: false, reason: 'too_old_post_event' }
  }
  if (temporal === 'no_anchor_dates') {
    return { matched: false, reason: 'no_anchor_dates' }
  }

  const nm = matchByFirstName(review, partners)
  if (!nm.ok) return { matched: false, reason: 'no_first_name_match' }

  return {
    matched: true,
    matchReason: nm.tier === 'full' ? 'first_name_full' : 'first_name_only',
  }
}

// ---------------------------------------------------------------------------
// Bulk filter for reconstruct + timeline
// ---------------------------------------------------------------------------

export interface FilterReviewsArgs {
  reviews: MatchableReview[]
  partners: PartnerNamePair[]
  wedding: WeddingTemporalAnchor
}

export type ReviewMatchFailReason =
  | 'no_reviewer_name'
  | 'no_first_name_match'
  | 'pre_inquiry_temporal'
  | 'too_old_post_event'
  | 'no_anchor_dates'

export interface FilterReviewsResult {
  kept: MatchableReview[]
  dropped: Array<{
    review: MatchableReview
    reason: ReviewMatchFailReason
  }>
}

/**
 * Apply the Wave 15 precision filter to a list of venue-scoped reviews
 * for ONE wedding. Used by both reconstruct.ts and build-timeline.ts.
 */
export function filterReviewsForCouple(args: FilterReviewsArgs): FilterReviewsResult {
  const kept: MatchableReview[] = []
  const dropped: FilterReviewsResult['dropped'] = []
  for (const r of args.reviews) {
    const v = matchReviewToCouple(r, args.partners, args.wedding)
    if (v.matched) {
      kept.push(r)
    } else {
      dropped.push({ review: r, reason: v.reason })
    }
  }
  return { kept, dropped }
}

// ---------------------------------------------------------------------------
// Ambiguity defer-to-queue
// ---------------------------------------------------------------------------

export interface AmbiguousReviewCandidate {
  wedding_id: string
  partner1_name: string | null
  partner2_name: string | null
  inquiry_date: string | null
  wedding_date: string | null
  match_reason:
    | 'first_name_match'
    | 'surname_match_only'
    | 'temporal_pre_inquiry'
}

export interface DeferAmbiguousReviewArgs {
  supabase: SupabaseClient
  venueId: string
  reviewId: string
  candidates: AmbiguousReviewCandidate[]
  deferReason:
    | 'ambiguous_multiple_candidates'
    | 'pre_inquiry_review'
    | 'surname_only_no_first_match'
}

/**
 * Insert a row into review_match_review_queue for operator decision.
 * UNIQUE INDEX uq_review_match_queue_review_reason collapses repeated
 * defers of the same (venue, review, reason). Never throws.
 */
export async function deferAmbiguousReview(
  args: DeferAmbiguousReviewArgs,
): Promise<{ ok: boolean; queueRowId: string | null }> {
  try {
    // SELECT-then-UPSERT pattern. We don't want PostgREST's upsert
    // because the candidates jsonb shouldn't overwrite the original
    // snapshot if the row exists — first defer wins.
    const { data: existing } = await args.supabase
      .from('review_match_review_queue')
      .select('id')
      .eq('venue_id', args.venueId)
      .eq('review_id', args.reviewId)
      .eq('defer_reason', args.deferReason)
      .maybeSingle()

    if (existing) {
      return { ok: true, queueRowId: (existing as { id: string }).id }
    }

    const insertRow = {
      venue_id: args.venueId,
      review_id: args.reviewId,
      candidates: args.candidates,
      defer_reason: args.deferReason,
    }
    const { data, error } = await args.supabase
      .from('review_match_review_queue')
      .insert(insertRow)
      .select('id')
      .single()
    if (error || !data) {
      console.warn('[review-match] defer insert failed:', error?.message)
      return { ok: false, queueRowId: null }
    }
    return { ok: true, queueRowId: (data as { id: string }).id }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    console.warn('[review-match] defer threw:', msg)
    return { ok: false, queueRowId: null }
  }
}
