import { NextRequest, NextResponse } from 'next/server'
import { getPlatformAuth, unauthorized, badRequest, serverError } from '@/lib/api/auth-helpers'
import { createServiceClient } from '@/lib/supabase/service'
import { importReviews, type ReviewRow } from '@/lib/services/brain-dump/imports'
import { batchExtractReviews } from '@/lib/services/intel/review-language'

/**
 * POST /api/intel/reviews/import
 *
 * Commit a confirmed batch of reviews to the reviews table AND
 * auto-mine phrases into review_language on the same call. Without
 * the phrase extraction the bulk-paste flow only fills the source-
 * reviews list and the Voice DNA + Approved Phrases surfaces stay
 * empty - which defeats the point of importing the reviews.
 *
 * Body: { reviews: ReviewRow[] }
 *
 * Two-phase response: import first (deterministic + fast), then
 * extract phrases (LLM, slower). With Claude's ~2s latency per
 * review + 500ms inter-call delay, 30 reviews takes ~75s; route
 * runs at maxDuration=300 to stay under the Vercel cap.
 */
export const maxDuration = 300

export async function POST(req: NextRequest) {
  const auth = await getPlatformAuth()
  if (!auth) return unauthorized()
  if (auth.isDemo) {
    return NextResponse.json({ error: 'demo mode' }, { status: 403 })
  }

  const body = (await req.json().catch(() => null)) as { reviews?: ReviewRow[] } | null
  if (!body?.reviews || !Array.isArray(body.reviews) || body.reviews.length === 0) {
    return badRequest('reviews array required')
  }
  if (body.reviews.length > 500) {
    return badRequest('cap is 500 reviews per call')
  }

  try {
    const supabase = createServiceClient()
    const summary = await importReviews({
      supabase,
      venueId: auth.venueId,
      rows: body.reviews,
    })

    // Phrase extraction. Pass ALL input reviews even though some may
    // have been skipped as dupes - extractReviewLanguage dedups
    // internally on (venue_id, phrase) so re-running is idempotent.
    // Frequency increments on existing phrases, which is the right
    // signal for "this phrase appears in N reviews."
    let phrases_extracted = 0
    try {
      phrases_extracted = await batchExtractReviews(
        auth.venueId,
        body.reviews.map((r) => ({ text: r.body, rating: r.rating })),
      )
    } catch (err) {
      console.error('[reviews/import] phrase extraction failed:', err)
      // Don't fail the whole call - the reviews landed.
    }

    return NextResponse.json({ ok: true, summary, phrases_extracted })
  } catch (err) {
    return serverError(err)
  }
}
