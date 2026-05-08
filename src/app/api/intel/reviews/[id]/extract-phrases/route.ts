import { NextRequest, NextResponse } from 'next/server'
import { getPlatformAuth, unauthorized, badRequest, serverError } from '@/lib/api/auth-helpers'
import { createServiceClient } from '@/lib/supabase/service'
import { extractReviewLanguage } from '@/lib/services/intel/review-language'

export const maxDuration = 60

/**
 * POST /api/intel/reviews/[id]/extract-phrases
 *
 * Trigger AI phrase extraction for a single existing review row.
 * Useful when reviews were imported before the extractor ran, or
 * when the coordinator wants to re-mine a review after editing
 * the body. Returns the count of phrases pulled.
 */
export async function POST(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const auth = await getPlatformAuth()
  if (!auth) return unauthorized()
  if (auth.isDemo) {
    return NextResponse.json(
      { error: 'Phrase extraction is not available in demo mode' },
      { status: 403 },
    )
  }

  const { id } = await params
  if (!id) return badRequest('review id is required')

  const supabase = createServiceClient()
  const { data: review, error: fetchErr } = await supabase
    .from('reviews')
    .select('id, venue_id, body, rating')
    .eq('id', id)
    .single()

  if (fetchErr || !review) return badRequest('review not found')
  if (review.venue_id !== auth.venueId) {
    return NextResponse.json({ error: 'forbidden' }, { status: 403 })
  }
  if (!review.body || review.body.trim().length < 20) {
    return badRequest('review body too short to extract phrases')
  }

  try {
    const phrases = await extractReviewLanguage(
      review.venue_id,
      review.body,
      review.rating ?? undefined,
    )
    return NextResponse.json({ ok: true, phrases_extracted: phrases.length })
  } catch (err) {
    return serverError(err)
  }
}
