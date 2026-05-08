import { NextRequest, NextResponse } from 'next/server'
import { getPlatformAuth, unauthorized, badRequest, serverError } from '@/lib/api/auth-helpers'
import { callAIJson } from '@/lib/ai/client'

/**
 * POST /api/intel/reviews/extract-from-text
 *
 * Bulk-paste reviews extractor. Coordinator pastes a long blob (up
 * to ~200KB) of reviews from Knot / WeddingWire / Google / etc. as
 * unstructured text; Claude returns a list of structured review rows
 * for the coordinator to confirm before insert.
 *
 * The page-side flow:
 *   POST extract-from-text -> { reviews: [...] }
 *   coordinator reviews + edits in a preview table
 *   POST /api/intel/reviews/import to commit
 *
 * NOT inserting on the same call so the coordinator can fix
 * mis-parses before they hit the table.
 */

export const maxDuration = 120

const PROMPT = `You are extracting wedding venue reviews from a coordinator's pasted text. The text was copied from a venue listing platform (The Knot, WeddingWire, Google Business, Zola, Yelp, etc.) so reviews are concatenated together with reviewer names, dates, ratings, and bodies in some order.

Extract every distinct review. Return a JSON array of objects with this exact shape:

{
  "reviews": [
    {
      "reviewer_name": "Sarah K.",
      "rating": 5,
      "body": "We had our wedding at Rixey in October and ...",
      "review_date": "2024-10-15",
      "source": "the_knot",
      "title": "Magical day"
    }
  ]
}

Rules:
- reviewer_name: pull from the text. If only first-name-last-initial, use exactly what's there. If anonymous, use "Anonymous reviewer".
- rating: integer 1-5. If not visible, default to 5 (most platforms hide reviews under 4 stars).
- body: the actual review text the reviewer wrote. Skip "Vendor response", "Vendor message", etc.
- review_date: ISO date if extractable. If only a relative time ("3 months ago"), leave null.
- source: the_knot / wedding_wire / google / zola / yelp / facebook / other. Infer from the text style.
- title: the review's subject line if present, else null.

Skip:
- Vendor responses
- Reply-to-review threads
- Star summaries / aggregate stats
- Navigation / UI text the coordinator accidentally pasted

Return only valid JSON. No prose, no markdown.`

interface ExtractedReview {
  reviewer_name: string
  rating: number
  body: string
  review_date: string | null
  source: string
  title: string | null
}

interface ExtractResult {
  reviews: ExtractedReview[]
}

export async function POST(req: NextRequest) {
  const auth = await getPlatformAuth()
  if (!auth) return unauthorized()
  if (auth.isDemo) {
    return NextResponse.json(
      { error: 'Bulk review extraction is not available in demo mode' },
      { status: 403 },
    )
  }

  const body = (await req.json().catch(() => null)) as { text?: string } | null
  if (!body?.text || typeof body.text !== 'string') {
    return badRequest('text is required')
  }
  const text = body.text.trim()
  if (text.length < 50) {
    return badRequest('paste at least 50 characters of review text')
  }
  if (text.length > 200_000) {
    return badRequest('paste exceeds 200 KB cap; split into smaller chunks')
  }

  try {
    const result = await callAIJson<ExtractResult>({
      systemPrompt: PROMPT,
      userPrompt: `Extract reviews from this text:\n\n"""\n${text}\n"""`,
      maxTokens: 8000,
      temperature: 0.1,
      venueId: auth.venueId,
      taskType: 'reviews_paste_extract',
      contentTier: 1,
      tier: 'sonnet',
      promptVersion: 'reviews.paste.v1',
    })

    const reviews = (result.reviews ?? [])
      .filter((r) => r.reviewer_name && r.body && r.body.trim().length >= 20)
      .map((r) => ({
        reviewer_name: String(r.reviewer_name).slice(0, 200),
        rating: Math.max(1, Math.min(5, Math.round(Number(r.rating) || 5))),
        body: String(r.body).trim().slice(0, 5000),
        review_date: r.review_date || null,
        source: String(r.source || 'other').toLowerCase(),
        title: r.title ? String(r.title).slice(0, 200) : null,
      }))

    return NextResponse.json({ ok: true, reviews, count: reviews.length })
  } catch (err) {
    return serverError(err)
  }
}
