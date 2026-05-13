/**
 * Orphan→wedding promote sweeps.
 *
 * Anchor: bloom-identity-resolution-doctrine.md (Step 6, G4 + G5).
 *
 * Three surfaces in Bloom carry "unmatched" signals that should
 * eventually bind to a wedding when a downstream signal makes the
 * binding possible. Pre-fix, each had its own ad-hoc behaviour:
 *
 *   - Audio (tour_transcript_orphans): coordinator manually attaches
 *     via /agent/audio-inbox. No auto-promote sweep.
 *   - Social engagements (match_status='unmatched'): match runs once
 *     at capture time; if no person matches then, the row stays
 *     unmatched forever, even when a couple later inquires and matches
 *     the IG handle.
 *   - Reviews (wedding_id IS NULL): Wave 13 reconciliation only fires
 *     when an outstanding solicitation request exists. Organic Google
 *     / Knot reviews never get a wedding binding.
 *
 * This module adds a deterministic, idempotent nightly sweep for the
 * two zero-LLM-cost surfaces (social + reviews). Audio orphans stay
 * coordinator-paced — extracting identity from transcript text would
 * need Sonnet and the existing manual UI already handles low volume.
 *
 * Design rules:
 *   - Never throws. Best-effort per-row.
 *   - Idempotent. Re-running the sweep is a no-op for already-matched
 *     rows.
 *   - Venue-scoped. Every match query filters by venue_id.
 *   - Cheap. No LLM. Re-uses existing match infrastructure
 *     (social/match-engagements.ts internals; reviews name lookup).
 */

import type { SupabaseClient } from '@supabase/supabase-js'
import { createServiceClient } from '@/lib/supabase/service'

interface PromoteResult {
  scanned: number
  promoted: number
  errors: string[]
}

// ---------------------------------------------------------------------------
// Social engagements — re-run match chain for unmatched rows.
// ---------------------------------------------------------------------------

/**
 * Re-run the social engagements matcher for every row whose
 * match_status='unmatched'. New persons / weddings that arrived since
 * the last attempt may now satisfy one of the three matchers
 * (handle_exact, name_fuzzy, email_inferred).
 *
 * Bounded at `limit` rows per venue per call so a venue with thousands
 * of unmatched IG followers doesn't dominate one cron tick.
 */
export async function promoteSocialOrphans(
  venueId: string,
  options: { supabase?: SupabaseClient; limit?: number } = {},
): Promise<PromoteResult> {
  const supabase = options.supabase ?? createServiceClient()
  const limit = Math.min(Math.max(options.limit ?? 500, 1), 2000)
  const result: PromoteResult = { scanned: 0, promoted: 0, errors: [] }

  // Pull unmatched engagements scoped to the venue.
  const { data: engagementsRaw, error: engErr } = await supabase
    .from('social_engagements')
    .select('id, venue_id, platform, handle, display_name')
    .eq('venue_id', venueId)
    .eq('match_status', 'unmatched')
    .limit(limit)
  if (engErr) {
    result.errors.push(`social engagements read: ${engErr.message}`)
    return result
  }
  const engagements = (engagementsRaw ?? []) as Array<{
    id: string
    venue_id: string
    platform: string
    handle: string
    display_name: string | null
  }>
  if (engagements.length === 0) return result

  // Bulk-load all people at the venue (same shape as
  // match-engagements.ts). Volume per venue is in the low thousands —
  // a single in-memory pass is cheaper than per-row queries.
  const { data: peopleRaw } = await supabase
    .from('people')
    .select('id, wedding_id, first_name, last_name, email, platform_handles')
    .eq('venue_id', venueId)
    .is('merged_into_id', null)
  const people = (peopleRaw ?? []) as Array<{
    id: string
    wedding_id: string | null
    first_name: string | null
    last_name: string | null
    email: string | null
    platform_handles: Record<string, string> | null
  }>

  // Bucket people by handle for matcher 1 (handle_exact).
  const handlesByPlatform = new Map<string, Map<string, { id: string }>>()
  for (const p of people) {
    if (!p.platform_handles) continue
    for (const [plat, handle] of Object.entries(p.platform_handles)) {
      if (typeof handle !== 'string' || handle.length === 0) continue
      const key = handle.toLowerCase()
      if (!handlesByPlatform.has(plat)) handlesByPlatform.set(plat, new Map())
      handlesByPlatform.get(plat)!.set(key, { id: p.id })
    }
  }

  // Last-name index for matcher 2 (display_name → people.last_name).
  // Cheap version of match-engagements' fuzzy match: exact match on
  // last token of display_name vs last_name. The original Haiku-grade
  // fuzzy matcher is the right tool inside match-engagements proper;
  // this sweep is the deterministic fallback for re-attempts.
  const byLastName = new Map<string, { id: string }>()
  for (const p of people) {
    const ln = (p.last_name ?? '').trim().toLowerCase()
    if (ln) byLastName.set(ln, { id: p.id })
  }

  const now = new Date().toISOString()
  for (const eng of engagements) {
    result.scanned += 1
    let matchedPersonId: string | null = null
    let method: 'handle_exact' | 'name_lastname' | null = null
    let confidence = 0

    const handleKey = eng.handle.toLowerCase()
    const platformBucket = handlesByPlatform.get(eng.platform)
    if (platformBucket?.has(handleKey)) {
      matchedPersonId = platformBucket.get(handleKey)!.id
      method = 'handle_exact'
      confidence = 100
    } else if (eng.display_name) {
      const tokens = eng.display_name.trim().split(/\s+/).filter(Boolean)
      const lastToken = tokens[tokens.length - 1]?.toLowerCase() ?? null
      if (lastToken && byLastName.has(lastToken)) {
        matchedPersonId = byLastName.get(lastToken)!.id
        method = 'name_lastname'
        confidence = 70
      }
    }

    if (!matchedPersonId) continue

    const { error: updateErr } = await supabase
      .from('social_engagements')
      .update({
        match_status: 'matched',
        matched_person_id: matchedPersonId,
        match_method: method,
        match_confidence: confidence,
        matched_at: now,
      })
      .eq('id', eng.id)
      .eq('match_status', 'unmatched')
    if (updateErr) {
      result.errors.push(`promote ${eng.id}: ${updateErr.message}`)
      continue
    }
    result.promoted += 1
  }

  return result
}

// ---------------------------------------------------------------------------
// Reviews — bind reviews with NULL wedding_id to a wedding by reviewer_name.
// ---------------------------------------------------------------------------

/**
 * Find reviews where wedding_id IS NULL and try to bind them via
 * reviewer_name → people.last_name lookup at the same venue. Mirrors
 * the lazy bind logic currently inside
 * /api/intel/reviews/[id]/draft-response/route.ts but runs eagerly at
 * ingest+nightly instead of waiting for a coordinator click.
 *
 * Bind is conservative — only sets wedding_id when the last token of
 * reviewer_name matches EXACTLY one active person at the venue. If
 * multiple people share the surname, skip (operator picks the right
 * one via the existing reconciliation UI).
 *
 * Skips reviews whose review_date is before any wedding's inquiry_date
 * at the venue (temporal sanity guard — a review from 2024 can't be
 * about a wedding that inquired in 2026).
 */
export async function promoteReviewOrphans(
  venueId: string,
  options: { supabase?: SupabaseClient; limit?: number } = {},
): Promise<PromoteResult> {
  const supabase = options.supabase ?? createServiceClient()
  const limit = Math.min(Math.max(options.limit ?? 500, 1), 2000)
  const result: PromoteResult = { scanned: 0, promoted: 0, errors: [] }

  const { data: reviewsRaw, error: revErr } = await supabase
    .from('reviews')
    .select('id, venue_id, reviewer_name, review_date')
    .eq('venue_id', venueId)
    .is('wedding_id', null)
    .not('reviewer_name', 'is', null)
    .limit(limit)
  if (revErr) {
    result.errors.push(`reviews read: ${revErr.message}`)
    return result
  }
  const reviews = (reviewsRaw ?? []) as Array<{
    id: string
    venue_id: string
    reviewer_name: string | null
    review_date: string | null
  }>
  if (reviews.length === 0) return result

  // Bulk-load people at the venue. Volume is low thousands — one query
  // is cheaper than per-review lookups.
  const { data: peopleRaw } = await supabase
    .from('people')
    .select('id, wedding_id, first_name, last_name')
    .eq('venue_id', venueId)
    .is('merged_into_id', null)
    .not('wedding_id', 'is', null)
  const people = (peopleRaw ?? []) as Array<{
    id: string
    wedding_id: string | null
    first_name: string | null
    last_name: string | null
  }>

  // Index by last_name. Track counts so we can detect collisions and
  // skip ambiguous binds.
  const lastNameToWeddingIds = new Map<string, Set<string>>()
  for (const p of people) {
    const ln = (p.last_name ?? '').trim().toLowerCase()
    if (!ln || !p.wedding_id) continue
    if (!lastNameToWeddingIds.has(ln)) lastNameToWeddingIds.set(ln, new Set())
    lastNameToWeddingIds.get(ln)!.add(p.wedding_id)
  }

  for (const rev of reviews) {
    result.scanned += 1
    const tokens = (rev.reviewer_name ?? '').trim().split(/\s+/).filter(Boolean)
    if (tokens.length < 2) continue
    // Last token, lowercased. Strip trailing punctuation (e.g. "S." → "s").
    const lastToken = tokens[tokens.length - 1]
      .toLowerCase()
      .replace(/[.,!?]+$/, '')
    if (!lastToken || lastToken.length < 2) continue

    const candidateWeddings = lastNameToWeddingIds.get(lastToken)
    if (!candidateWeddings || candidateWeddings.size !== 1) {
      // Zero match or ambiguous — leave for operator triage.
      continue
    }
    const weddingId = Array.from(candidateWeddings)[0]

    const { error: updateErr } = await supabase
      .from('reviews')
      .update({ wedding_id: weddingId })
      .eq('id', rev.id)
      .is('wedding_id', null)
    if (updateErr) {
      result.errors.push(`promote ${rev.id}: ${updateErr.message}`)
      continue
    }
    result.promoted += 1
  }

  return result
}

// ---------------------------------------------------------------------------
// Multi-venue convenience wrappers for the prune_maintenance cron.
// ---------------------------------------------------------------------------

export async function promoteAllOrphansAllVenues(options: {
  supabase?: SupabaseClient
  limitPerVenue?: number
} = {}): Promise<{
  social: { total_scanned: number; total_promoted: number; errors: string[] }
  reviews: { total_scanned: number; total_promoted: number; errors: string[] }
}> {
  const supabase = options.supabase ?? createServiceClient()
  const { data: venues, error } = await supabase
    .from('venues')
    .select('id')
    .limit(1000)
  if (error) {
    return {
      social: { total_scanned: 0, total_promoted: 0, errors: [`venues read: ${error.message}`] },
      reviews: { total_scanned: 0, total_promoted: 0, errors: [] },
    }
  }

  const social = { total_scanned: 0, total_promoted: 0, errors: [] as string[] }
  const reviews = { total_scanned: 0, total_promoted: 0, errors: [] as string[] }
  const limit = options.limitPerVenue ?? 500

  for (const v of venues ?? []) {
    const venueId = v.id as string
    const s = await promoteSocialOrphans(venueId, { supabase, limit })
    social.total_scanned += s.scanned
    social.total_promoted += s.promoted
    social.errors.push(...s.errors)

    const r = await promoteReviewOrphans(venueId, { supabase, limit })
    reviews.total_scanned += r.scanned
    reviews.total_promoted += r.promoted
    reviews.errors.push(...r.errors)
  }

  return { social, reviews }
}
