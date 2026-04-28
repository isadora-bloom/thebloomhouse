import { NextRequest, NextResponse } from 'next/server'
import { getCoupleAuth, unauthorized, badRequest, serverError } from '@/lib/api/auth-helpers'
import { extractRecipeFromUrl, RecipeValidationError } from '@/lib/services/bar-recipe-extract'

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
  if (!weddingId) return badRequest('Missing weddingId')
  if (weddingId !== auth.weddingId) {
    return NextResponse.json({ error: 'weddingId does not match authenticated session' }, { status: 403 })
  }

  try {
    const recipe = await extractRecipeFromUrl(url, weddingId, auth.venueId)
    return NextResponse.json({ recipe })
  } catch (error) {
    if (error instanceof RecipeValidationError) {
      return NextResponse.json({ error: error.message }, { status: 422 })
    }
    if (error instanceof Error && /could not fetch recipe page/i.test(error.message)) {
      return NextResponse.json({ error: error.message }, { status: 422 })
    }
    return serverError(error)
  }
}
