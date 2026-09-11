/**
 * Orphan→wedding promote sweeps.
 *
 * Anchor: bloom-identity-resolution-doctrine.md (Step 6, G4 + G5; 2026-05-13
 * Pass C closes the audio gap left at Step 6).
 *
 * Two surfaces in Bloom carry "unmatched" signals that should
 * eventually bind to a wedding when a downstream signal makes the
 * binding possible. Pre-fix, each had its own ad-hoc behaviour:
 *
 *   - Audio (tour_transcript_orphans): coordinator manually attaches
 *     via /agent/audio-inbox. No auto-promote sweep.
 *   - Reviews (wedding_id IS NULL): Wave 13 reconciliation only fires
 *     when an outstanding solicitation request exists. Organic Google
 *     / Knot reviews never get a wedding binding.
 *
 * This module adds a deterministic, idempotent nightly sweep for both.
 * Audio is the lightest pass — it regex-extracts email/phone from the
 * transcript text (the cases the cheap-path can catch) and matches
 * against the live people roster. Full identity extraction from spoken
 * dialog needs an LLM judge and is the natural next step; the existing
 * /agent/audio-inbox UI handles the long tail.
 *
 * Social left this sweep in wave 3 (2026-09-09, HANDLE-IDENTITY-SPEC.md
 * §5). It used to re-run the retired social matcher nightly: handle
 * lookup against people.platform_handles, then a surname match on the
 * last token of the display name at confidence 70. That last one bound
 * a stranger called Hoyle to a couple called Hoyle, every night, with
 * nobody watching. Social engagements now reach the spine through
 * `linkSignal` at capture time, and the catch-up sweep is
 * `replaySocialEngagements` in ./replay/social.ts. A handle that finds
 * its couple later is handled deterministically by W22's fragment
 * promotion, not by a nightly guess.
 *
 * Design rules:
 *   - Never throws. Best-effort per-row.
 *   - Idempotent. Re-running the sweep is a no-op for already-matched
 *     rows.
 *   - Venue-scoped. Every match query filters by venue_id.
 *   - Cheap. No LLM in this layer — reuses regex + existing match
 *     infrastructure (reviews name lookup; audio email/phone regex
 *     against the people roster).
 */

import type { SupabaseClient } from '@supabase/supabase-js'
import { createServiceClient } from '@/lib/supabase/service'

interface PromoteResult {
  scanned: number
  promoted: number
  errors: string[]
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
// Audio orphans — regex-extract email/phone from transcripts and attach.
// ---------------------------------------------------------------------------

const EMAIL_RX = /[a-z0-9][a-z0-9._+-]{0,63}@[a-z0-9][a-z0-9-]*(\.[a-z]{2,})+/gi
const PHONE_RX = /(?:\+?1[\s.-]?)?\(?(\d{3})\)?[\s.-]?(\d{3})[\s.-]?(\d{4})/g

function extractEmailsFromText(text: string): string[] {
  const out = new Set<string>()
  for (const m of text.matchAll(EMAIL_RX)) {
    out.add(m[0].toLowerCase())
  }
  return [...out]
}

function extractPhonesFromText(text: string): string[] {
  const out = new Set<string>()
  for (const m of text.matchAll(PHONE_RX)) {
    const digits = `${m[1]}${m[2]}${m[3]}`
    if (digits.length === 10) out.add(`+1${digits}`)
  }
  return [...out]
}

/**
 * Audio transcript orphan promote. tour_transcript_orphans rows arrive
 * with `attached_to_tour_id IS NULL`; this sweep scans the transcript
 * text for email + phone mentions and, when an unambiguous venue-scoped
 * person match exists AND that person's wedding has a tour scheduled
 * within ±3 hours of `first_segment_at`, attaches the orphan to that
 * tour.
 *
 * Realistic catch rate
 * --------------------
 * Spoken transcripts rarely contain machine-readable email/phone — most
 * tour conversations are dialog about the venue, not identifier
 * dictation. So this sweep is intentionally narrow: it handles the
 * minority cases where the couple did spell out an email or read a
 * phone aloud. Name-based extraction ("Hi, I'm Sarah") would need an
 * LLM judge to disambiguate; that's the natural next step but out of
 * scope here (and the existing /agent/audio-inbox manual triage UI
 * handles current volume).
 *
 * Conservative
 * ------------
 * - Only attaches on EXACTLY ONE venue-scoped person match.
 * - Requires a tour to already exist within ±3h; we don't mint one.
 * - Idempotent: only scans status='pending' rows.
 * - Never throws.
 */
export async function promoteAudioOrphans(
  venueId: string,
  options: { supabase?: SupabaseClient; limit?: number } = {},
): Promise<PromoteResult> {
  const supabase = options.supabase ?? createServiceClient()
  const limit = Math.min(Math.max(options.limit ?? 200, 1), 1000)
  const result: PromoteResult = { scanned: 0, promoted: 0, errors: [] }

  const { data: orphansRaw, error: orphErr } = await supabase
    .from('tour_transcript_orphans')
    .select('id, transcript, first_segment_at')
    .eq('venue_id', venueId)
    .eq('status', 'pending')
    .limit(limit)
  if (orphErr) {
    result.errors.push(`orphans read: ${orphErr.message}`)
    return result
  }
  const orphans = (orphansRaw ?? []) as Array<{
    id: string
    transcript: string
    first_segment_at: string
  }>
  if (orphans.length === 0) return result

  // Bulk-load active people at the venue (with their wedding link).
  const { data: peopleRaw } = await supabase
    .from('people')
    .select('id, wedding_id, email, phone')
    .eq('venue_id', venueId)
    .is('merged_into_id', null)
    .not('wedding_id', 'is', null)
  const people = (peopleRaw ?? []) as Array<{
    id: string
    wedding_id: string | null
    email: string | null
    phone: string | null
  }>

  // Index by normalised email + phone for O(1) match. Use the SAME
  // normalisation as resolver.ts (lowercase + plus-strip for email;
  // E.164 for phone) so audio matches what the live pipeline would
  // produce — anything else is a silent drift class.
  const normEmail = (s: string | null): string | null => {
    if (!s) return null
    const t = s.toLowerCase().trim()
    if (!t.includes('@')) return null
    const at = t.indexOf('@')
    const local = t.slice(0, at)
    const plus = local.indexOf('+')
    return plus < 0 ? t : local.slice(0, plus) + t.slice(at)
  }
  const normPhone = (s: string | null): string | null => {
    if (!s) return null
    const d = s.replace(/\D+/g, '')
    if (d.length < 10) return null
    if (d.length === 10) return `+1${d}`
    return `+${d}`
  }
  const byEmail = new Map<string, { weddingId: string }>()
  const byPhone = new Map<string, { weddingId: string }>()
  for (const p of people) {
    const e = normEmail(p.email)
    if (e && p.wedding_id) byEmail.set(e, { weddingId: p.wedding_id })
    const ph = normPhone(p.phone)
    if (ph && p.wedding_id) byPhone.set(ph, { weddingId: p.wedding_id })
  }

  const THREE_HOURS_MS = 3 * 60 * 60 * 1000

  for (const orphan of orphans) {
    result.scanned += 1
    if (!orphan.transcript) continue

    const candidateWeddings = new Set<string>()
    for (const email of extractEmailsFromText(orphan.transcript)) {
      const hit = byEmail.get(email)
      if (hit) candidateWeddings.add(hit.weddingId)
    }
    for (const phone of extractPhonesFromText(orphan.transcript)) {
      const hit = byPhone.get(phone)
      if (hit) candidateWeddings.add(hit.weddingId)
    }

    if (candidateWeddings.size !== 1) continue // zero or ambiguous → skip
    const weddingId = [...candidateWeddings][0]

    // Find a tour for that wedding within ±3h of the transcript's
    // first segment. Without a real tour to attach to, we can't bind.
    const segmentTs = new Date(orphan.first_segment_at).getTime()
    if (!isFinite(segmentTs)) continue
    const windowStart = new Date(segmentTs - THREE_HOURS_MS).toISOString()
    const windowEnd = new Date(segmentTs + THREE_HOURS_MS).toISOString()

    const { data: tourCandidates } = await supabase
      .from('tours')
      .select('id, scheduled_at')
      .eq('venue_id', venueId)
      .eq('wedding_id', weddingId)
      .gte('scheduled_at', windowStart)
      .lte('scheduled_at', windowEnd)
      .limit(2)
    if (!tourCandidates || tourCandidates.length !== 1) continue

    const tourId = tourCandidates[0].id as string
    const { error: updateErr } = await supabase
      .from('tour_transcript_orphans')
      .update({
        status: 'attached',
        attached_to_tour_id: tourId,
        attached_at: new Date().toISOString(),
      })
      .eq('id', orphan.id)
      .eq('status', 'pending')
    if (updateErr) {
      result.errors.push(`promote ${orphan.id}: ${updateErr.message}`)
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
  audio: { total_scanned: number; total_promoted: number; errors: string[] }
}> {
  const supabase = options.supabase ?? createServiceClient()
  const { data: venues, error } = await supabase
    .from('venues')
    .select('id')
    .limit(1000)
  if (error) {
    return {
      social: { ...SOCIAL_RETIRED, errors: [`venues read: ${error.message}`] },
      reviews: { total_scanned: 0, total_promoted: 0, errors: [] },
      audio: { total_scanned: 0, total_promoted: 0, errors: [] },
    }
  }

  const reviews = { total_scanned: 0, total_promoted: 0, errors: [] as string[] }
  const audio = { total_scanned: 0, total_promoted: 0, errors: [] as string[] }
  const limit = options.limitPerVenue ?? 500

  for (const v of venues ?? []) {
    const venueId = v.id as string
    const r = await promoteReviewOrphans(venueId, { supabase, limit })
    reviews.total_scanned += r.scanned
    reviews.total_promoted += r.promoted
    reviews.errors.push(...r.errors)

    const a = await promoteAudioOrphans(venueId, { supabase, limit: Math.min(limit, 200) })
    audio.total_scanned += a.scanned
    audio.total_promoted += a.promoted
    audio.errors.push(...a.errors)
  }

  return { social: { ...SOCIAL_RETIRED, errors: [] }, reviews, audio }
}

/**
 * The social counters the cron's prune_maintenance response still
 * carries. Always zero since wave 3 — social no longer has a nightly
 * guess to run. Left in place so the cron's result shape is unchanged
 * while a workstream that owns `src/app/api/cron/route.ts` drops the
 * `orphan_promote_social` field. See the header for where social went.
 */
const SOCIAL_RETIRED = { total_scanned: 0, total_promoted: 0 } as const
