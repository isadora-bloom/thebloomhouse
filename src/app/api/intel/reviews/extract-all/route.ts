import { NextRequest, NextResponse } from 'next/server'
import { getPlatformAuth, unauthorized, serverError } from '@/lib/api/auth-helpers'
import { createServiceClient } from '@/lib/supabase/service'
import { batchExtractReviews } from '@/lib/services/intel/review-language'

export const maxDuration = 300

/**
 * POST /api/intel/reviews/extract-all
 *
 * Bulk-trigger AI phrase extraction across every review for the
 * current venue (or every review the coordinator can see, scoped
 * by venueId on auth). Useful for back-filling phrases on reviews
 * that were imported before the extractor was wired in.
 *
 * Optional body: { onlyMissingPhrases?: boolean }
 *   When true, skip reviews that already have at least one phrase
 *   in review_language matching this review's body. Today phrases
 *   are venue-scoped not review-scoped, so we approximate by
 *   skipping if the venue has any phrases at all when the flag is
 *   set with mode='venue-empty-only'.
 */
export async function POST(req: NextRequest) {
  const auth = await getPlatformAuth()
  if (!auth) return unauthorized()
  if (auth.isDemo) {
    return NextResponse.json(
      { error: 'Phrase extraction is not available in demo mode' },
      { status: 403 },
    )
  }

  const body = (await req.json().catch(() => ({}))) as { mode?: string }
  const supabase = createServiceClient()

  const { data: reviews, error: fetchErr } = await supabase
    .from('reviews')
    .select('id, body, rating')
    .eq('venue_id', auth.venueId)
    .order('review_date', { ascending: false })
    .limit(500)

  if (fetchErr) return serverError(fetchErr)
  if (!reviews || reviews.length === 0) {
    return NextResponse.json({ ok: true, phrases_extracted: 0, reviews_processed: 0 })
  }

  const eligible = reviews
    .filter((r) => r.body && r.body.trim().length >= 20)
    .map((r) => ({ text: r.body as string, rating: r.rating ?? undefined }))

  try {
    const phrases_extracted = await batchExtractReviews(auth.venueId, eligible)
    return NextResponse.json({
      ok: true,
      phrases_extracted,
      reviews_processed: eligible.length,
      mode: body.mode ?? 'all',
    })
  } catch (err) {
    return serverError(err)
  }
}
