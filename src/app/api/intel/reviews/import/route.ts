import { NextRequest, NextResponse } from 'next/server'
import { getPlatformAuth, unauthorized, badRequest, serverError } from '@/lib/api/auth-helpers'
import { requirePlan, planErrorBody } from '@/lib/auth/require-plan'
import { createServiceClient } from '@/lib/supabase/service'
import { importReviews, type ReviewRow } from '@/lib/services/brain-dump/imports'

/**
 * POST /api/intel/reviews/import
 *
 * Commit a confirmed batch of reviews to the reviews table. Phrase
 * mining into review_language, plus reviews.sentiment_score /
 * reviews.themes, now happens automatically per newly-inserted row
 * inside importReviews (src/lib/services/brain-dump/imports.ts,
 * NOVEMBER-PLAN.md W46) — fire-and-forget, so it no longer needs a
 * second explicit extraction pass here. (Patch note: before W46 this
 * route called batchExtractReviews() on every input review after
 * import; doing that AND the new per-insert scoring would have scored
 * each new review twice, double-counting review_language.frequency.
 * The old call is removed rather than kept as a duplicate.)
 *
 * Body: { reviews: ReviewRow[] }
 *
 * Import is deterministic + fast (no LLM call in the request path);
 * scoring happens out-of-band afterwards, so phrases_extracted below
 * reflects rows inserted this call, not a synchronous extraction count.
 */
export const maxDuration = 60

export async function POST(req: NextRequest) {
  const plan = await requirePlan(req, 'pre_opening')
  if (!plan.ok) return NextResponse.json(planErrorBody(plan), { status: plan.status })

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

    // Phrase mining + sentiment scoring now runs automatically inside
    // importReviews for every newly-inserted row (fire-and-forget, W46),
    // so there is nothing left to trigger here. phrases_extracted stays
    // in the response shape for the paste page's "Mined N phrases"
    // banner, but is honestly unknown at response time rather than a
    // guessed number — the page already treats a missing/non-number
    // value as "don't show the banner".
    return NextResponse.json({ ok: true, summary })
  } catch (err) {
    return serverError(err)
  }
}
