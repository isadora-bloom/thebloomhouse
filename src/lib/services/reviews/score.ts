/**
 * Bloom House: Review Scoring (NOVEMBER-PLAN.md W46).
 *
 * reviews.sentiment_score and reviews.themes have existed since migration
 * 031, and src/lib/services/intel/review-language.ts already scores review
 * text (extractReviewLanguage), but nothing ever wrote the result back onto
 * the reviews row itself — every insert path left both columns null.
 *
 * This is the one shared helper every review-insert path calls. It reuses
 * extractReviewLanguage rather than making a second AI call: that function
 * already returns a per-phrase sentiment + theme for the review body (and,
 * as a side effect, upserts review_language, which is unchanged behaviour).
 * We aggregate those phrases into one sentiment_score (mean) and one themes
 * list (distinct, sorted) and write both onto the row.
 *
 * scheduleReviewScoring() is the call sites' entry point: fire-and-forget,
 * matches the shape already used for other post-insert background work in
 * this repo (see stitchWebFormVisits in crm-import/web-form.ts and the
 * replayReviewRows call in reviews/google-places.ts) — a scoring failure
 * must never block or fail the review import itself.
 */

import { createServiceClient } from '@/lib/supabase/service'
import { writeOrLog } from '@/lib/db/write-or-log'
import { extractReviewLanguage } from '@/lib/services/intel/review-language'
import { logEvent } from '@/lib/observability/logger'

type ServiceClient = ReturnType<typeof createServiceClient>

export interface ScoreReviewRowArgs {
  reviewId: string
  venueId: string
  body: string
  rating?: number | null
  /** Inject a client in tests; defaults to a fresh service-role client. */
  supabase?: ServiceClient
}

export interface ScoreReviewRowResult {
  scored: boolean
  sentimentScore: number | null
  themes: string[]
  phraseCount: number
}

const NO_SCORE: ScoreReviewRowResult = {
  scored: false,
  sentimentScore: null,
  themes: [],
  phraseCount: 0,
}

/**
 * Score one review row and write sentiment_score + themes back onto it.
 * No-op when the body is blank or extraction finds nothing notable to say
 * (extractReviewLanguage already returns [] for a generic one-liner) —
 * columns are left null rather than written as a false zero.
 *
 * Runs as the service role, so it clears the migration 345 column guard
 * (reviews_column_guard bypasses for auth.role() = 'service_role').
 */
export async function scoreReviewRow(
  args: ScoreReviewRowArgs,
): Promise<ScoreReviewRowResult> {
  const { reviewId, venueId, body, rating } = args
  if (!body || !body.trim()) return NO_SCORE

  const phrases = await extractReviewLanguage(venueId, body, rating ?? undefined)
  if (phrases.length === 0) return NO_SCORE

  const meanSentiment =
    phrases.reduce((sum, p) => sum + p.sentiment, 0) / phrases.length
  const sentimentScore = Math.round(meanSentiment * 100) / 100
  const themes = Array.from(new Set(phrases.map((p) => p.theme))).sort()

  const supabase = args.supabase ?? createServiceClient()
  await writeOrLog(
    supabase
      .from('reviews')
      .update({ sentiment_score: sentimentScore, themes })
      .eq('id', reviewId),
    { op: 'reviews.sentiment_score_update', venueId },
  )

  return { scored: true, sentimentScore, themes, phraseCount: phrases.length }
}

/**
 * Fire-and-forget entry point for insert call sites. Never throws and
 * never awaited by the caller — the AI call + write happen out-of-band.
 * A failure (AI call, extraction, or the DB write) is logged and dropped;
 * it must never fail or slow down the review import that triggered it.
 */
export function scheduleReviewScoring(args: ScoreReviewRowArgs): void {
  void scoreReviewRow(args).catch((err) => {
    logEvent({
      level: 'error',
      msg: 'reviews.score_failed',
      event_type: 'reviews.sentiment_score',
      outcome: 'fail',
      venueId: args.venueId,
      actor: 'review_scoring',
      data: {
        reviewId: args.reviewId,
        message: err instanceof Error ? err.message : String(err),
      },
    })
  })
}
