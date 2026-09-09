/**
 * Bloom House — Reviews → spine origin adapter.
 *
 * Anchor: ORIGIN-INGESTION-SPEC.md §5 ("reviews currently NEVER reach
 * the spine"). Reviews are forensic identity evidence: a review is a
 * couple, post-event, naming the venue in their own words. Until now
 * the `reviews` table fed Voice DNA + positioning USPs but never bound
 * to a couple on the identity spine, so the review's authorship was
 * invisible to the journey ribbon + couple intel.
 *
 * What this module does
 * ---------------------
 * Turns each `reviews` row into a `NormalizedSignal` and routes it
 * through `linkSignal` (the canonical creation/bind chokepoint). The
 * matcher binds the review to a couple by reviewer name; medium/low
 * confidence lands in the candidate queue, which is the correct,
 * conservative outcome for review authorship (per review-match.ts: a
 * review is NEVER bound on a surname token alone).
 *
 * Idempotency
 * -----------
 * external_id = `review:{source}:{source_review_id}` (falling back to
 * the row id when source_review_id is null). Combined with
 * venue_id + channel, this is the UNIQUE(venue_id, channel, external_id)
 * rerun-safety key on touchpoints/fragments — re-running this replay is
 * a no-op (linkSignal returns action 'duplicate').
 *
 * Pre-bound reviews
 * -----------------
 * The shipped `reviews` table (migration 031) does NOT carry a
 * `wedding_id` column. If a deployment has added one (or any
 * `*_wedding_id` alias), we read it defensively and pass it as
 * `legacy_wedding_id` so the touchpoint anchors to the existing couple
 * via couples.source_wedding_id without re-running the matcher. When
 * the column is absent the field is simply omitted and the matcher
 * binds by reviewer name.
 *
 * Contract: accepts the Supabase service client as a parameter — it
 * does NOT construct one. See scripts/data-integrity-check.ts for the
 * createClient + .env.local pattern a CLI caller would use.
 *
 * Callers (November plan finding 4)
 * ----------------------------------
 * replayAllOrigins (./index.ts) calls replayReviews for a full
 * historical catch-up, but as of the 2026-07 origin-replay build had no
 * caller of its own — a full replay only ran if something invoked the
 * orchestrator, and nothing did. `pollGooglePlacesForVenue`
 * (lib/services/reviews/google-places.ts, the handler behind the weekly
 * `google_places_reviews_refresh` cron) now calls replayReviewRows with
 * just the newly-inserted rows after each poll, so new Google reviews
 * reach the spine on the same cadence they reach the reviews table.
 * Paste-only sources (Knot/WW/Zola/Yelp/Facebook, via /intel/reviews/paste)
 * still only reach the spine via a manual replayAllOrigins/replayReviews
 * run — no live write path calls it for those.
 */

import type { SupabaseClient } from '@supabase/supabase-js'
import { linkSignal, type NormalizedSignal } from '@/lib/spine/cascade'

export const REVIEWS_ADAPTER_CHANNEL = 'review' as const
export const REVIEWS_ADAPTER_ACTION = 'review_left' as const

/** Shape we read from `reviews` (migration 031). `wedding_id` is
 *  optional because the shipped schema has no such column — we select
 *  it defensively for deployments that added one. Exported so callers
 *  that already hold freshly-inserted review rows (e.g. the Google
 *  Places poller) can pass them straight to replayReviewRows without a
 *  round-trip re-fetch. */
export interface ReviewRow {
  id: string
  source: string | null
  source_review_id: string | null
  reviewer_name: string | null
  rating: number | null
  title: string | null
  body: string | null
  review_date: string | null
  response_text: string | null
  is_featured: boolean | null
  themes: string[] | null
  created_at: string | null
  /** Present only on deployments that added a match column. */
  wedding_id?: string | null
}

/** Columns confirmed against migration 031. `wedding_id` is appended
 *  optimistically; if the column doesn't exist PostgREST errors and we
 *  retry without it (see fetchReviews). */
const REVIEW_COLUMNS_WITH_WEDDING =
  'id, source, source_review_id, reviewer_name, rating, title, body, ' +
  'review_date, response_text, is_featured, themes, created_at, wedding_id'

const REVIEW_COLUMNS_BASE =
  'id, source, source_review_id, reviewer_name, rating, title, body, ' +
  'review_date, response_text, is_featured, themes, created_at'

/**
 * Load all reviews for the venue. Tries the `wedding_id`-bearing
 * projection first; on a missing-column error falls back to the base
 * projection so this works against both the shipped schema and any
 * future match-column addition.
 */
async function fetchReviews(
  supabase: SupabaseClient,
  venueId: string,
): Promise<ReviewRow[]> {
  const withWedding = await supabase
    .from('reviews')
    .select(REVIEW_COLUMNS_WITH_WEDDING)
    .eq('venue_id', venueId)
    .order('review_date', { ascending: true })

  if (!withWedding.error) {
    return (withWedding.data ?? []) as unknown as ReviewRow[]
  }

  // Undefined column → retry without wedding_id. PostgREST code 42703
  // (undefined_column) or a message mentioning the column.
  const msg = withWedding.error.message ?? ''
  const isMissingColumn =
    withWedding.error.code === '42703' || /wedding_id/i.test(msg)
  if (!isMissingColumn) {
    throw new Error(`[reviews-adapter] fetch failed: ${msg}`)
  }

  const base = await supabase
    .from('reviews')
    .select(REVIEW_COLUMNS_BASE)
    .eq('venue_id', venueId)
    .order('review_date', { ascending: true })

  if (base.error) {
    throw new Error(`[reviews-adapter] fetch failed: ${base.error.message}`)
  }
  return (base.data ?? []) as unknown as ReviewRow[]
}

/** Build the rerun-safe external id for a review. */
function externalIdFor(row: ReviewRow): string {
  const source = (row.source ?? 'other').trim() || 'other'
  const sid = (row.source_review_id ?? '').trim() || row.id
  return `review:${source}:${sid}`
}

/** A review's review_date is a `date` (no time). Normalise to an ISO
 *  timestamp at UTC midnight so occurred_at is a valid ISO string. */
function occurredAtFor(row: ReviewRow): string {
  if (row.review_date) {
    const t = Date.parse(row.review_date)
    if (Number.isFinite(t)) return new Date(t).toISOString()
  }
  // Fall back to ingestion time — better than an empty occurred_at.
  if (row.created_at) {
    const t = Date.parse(row.created_at)
    if (Number.isFinite(t)) return new Date(t).toISOString()
  }
  return new Date().toISOString()
}

/** Map one review row to a NormalizedSignal. */
function toSignal(row: ReviewRow): NormalizedSignal {
  const reviewerName = row.reviewer_name?.trim() || null
  const weddingId = row.wedding_id ? row.wedding_id : null

  const signal: NormalizedSignal = {
    external_id: externalIdFor(row),
    channel: REVIEWS_ADAPTER_CHANNEL,
    action_type: REVIEWS_ADAPTER_ACTION,
    occurred_at: occurredAtFor(row),
    signal_tier: 'medium',
    identity_hint: reviewerName,
    primary_name: reviewerName,
    // A review is authored by the couple — refuse minting from a
    // non-couple author elsewhere, but here authorship is definitional.
    author_class: 'couple',
    raw_payload: {
      review_id: row.id,
      source: row.source,
      source_review_id: row.source_review_id,
      reviewer_name: row.reviewer_name,
      rating: row.rating,
      title: row.title,
      body: row.body,
      review_date: row.review_date,
      response_text: row.response_text,
      is_featured: row.is_featured,
      themes: row.themes,
    },
  }

  // Only set legacy_wedding_id when a real pre-match exists, so the
  // matcher binds by name for the (common) unmatched case.
  if (weddingId) signal.legacy_wedding_id = weddingId

  return signal
}

export interface ReplayReviewsArgs {
  supabase: SupabaseClient
  venueId: string
}

export interface ReplayReviewsResult {
  processed: number
  linked: number
}

export interface ReplayReviewRowsArgs {
  supabase: SupabaseClient
  venueId: string
  rows: ReviewRow[]
}

/**
 * Route a given set of review rows through linkSignal. Idempotent via
 * external_id (re-runs return 'duplicate'). `linked` counts signals
 * that bound to a couple — either attached (high tier / legacy_wedding_id)
 * or minted a new channel-scoped couple. candidate_medium / candidate_low /
 * fragment outcomes are counted as processed-but-not-linked: the review
 * landed on the spine (as an orphan touchpoint + candidate queue row) but
 * did not yet bind to a couple, which is the correct conservative result.
 *
 * Extracted out of replayReviews (which now just fetches all rows and
 * delegates here) so a caller that already holds a small, known set of
 * rows — the Google Places poller inserting this week's new reviews,
 * for instance — can replay just those rows instead of re-running the
 * matcher over the venue's entire review history on every call.
 */
export async function replayReviewRows(
  args: ReplayReviewRowsArgs,
): Promise<ReplayReviewsResult> {
  const { supabase, venueId, rows } = args

  let processed = 0
  let linked = 0

  for (const row of rows) {
    const signal = toSignal(row)
    try {
      const result = await linkSignal({
        supabase,
        venueId,
        signal,
        bypassCache: true,
        source: 'reviews-replay',
      })
      processed += 1
      if (result.action === 'attached' || result.action === 'minted') {
        linked += 1
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      console.warn(
        `[reviews-adapter] linkSignal failed for review ${row.id}: ${msg}`,
      )
      // Count as processed so the caller sees the row was attempted;
      // a transient link failure shouldn't abort the whole replay.
      processed += 1
    }
  }

  return { processed, linked }
}

/**
 * Iterate every review for the venue and replay all of them. Used by
 * the Phase-2 origin-replay orchestrator (replayAllOrigins) for a
 * full historical catch-up run.
 */
export async function replayReviews(
  args: ReplayReviewsArgs,
): Promise<ReplayReviewsResult> {
  const { supabase, venueId } = args
  const rows = await fetchReviews(supabase, venueId)
  return replayReviewRows({ supabase, venueId, rows })
}
