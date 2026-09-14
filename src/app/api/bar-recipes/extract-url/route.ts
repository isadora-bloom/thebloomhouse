import { NextRequest, NextResponse } from 'next/server'
import { getCoupleAuth, unauthorized, badRequest, serverError } from '@/lib/api/auth-helpers'
import { extractRecipeFromUrl, RecipeValidationError } from '@/lib/services/bar-recipe-extract'
import { apiError } from '@/lib/api/api-error'

// ---------------------------------------------------------------------------
// POST /api/bar-recipes/extract-url
// Body: { url: string, weddingId: string }
// Returns: { recipe: BarRecipeRow }
//
// venueId is pulled from the authenticated couple's session (or the demo
// cookie). The supplied weddingId must match the caller's wedding.
// ---------------------------------------------------------------------------

export async function POST(request: NextRequest) {
  const auth = await getCoupleAuth()
  if (!auth) return unauthorized()

  let body: { url?: string; weddingId?: string }
  try {
    body = await request.json()
  } catch {
    return badRequest('Invalid JSON body')
  }

  const url = body?.url?.trim()
  const weddingId = body?.weddingId?.trim()

  if (!url) return badRequest('Missing url')
  // S5 (2026-09-14 security audit, item 9): refuse at the edge as well as
  // in the service. The service is the authority; this is so a 2kb-plus
  // paste never reaches it in the first place.
  if (url.length > 2048) return badRequest('That URL is too long.')
  if (!weddingId) return badRequest('Missing weddingId')
  if (weddingId !== auth.weddingId) {
    return NextResponse.json({ error: 'weddingId does not match authenticated session' }, { status: 403 })
  }

  try {
    const recipe = await extractRecipeFromUrl(url, weddingId, auth.venueId)
    return NextResponse.json({ recipe })
  } catch (error) {
    if (error instanceof RecipeValidationError) {
      return apiError(error, undefined, 422)
    }
    if (error instanceof Error && /could not fetch recipe page/i.test(error.message)) {
      return apiError(error, undefined, 422)
    }
    return serverError(error)
  }
}
