import { NextRequest, NextResponse } from 'next/server'
import { getPlatformAuth, unauthorized, badRequest, serverError } from '@/lib/api/auth-helpers'
import { createServiceClient } from '@/lib/supabase/service'
import { importReviews, type ReviewRow } from '@/lib/services/brain-dump/imports'

/**
 * POST /api/intel/reviews/import
 *
 * Commit a confirmed batch of reviews to the reviews table.
 * Body: { reviews: ReviewRow[] }
 * Used by the paste-extraction confirm step. Coordinator already
 * edited any mis-parses in the preview table.
 */
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
    return NextResponse.json({ ok: true, summary })
  } catch (err) {
    return serverError(err)
  }
}
