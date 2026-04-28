import { NextRequest, NextResponse } from 'next/server'
import { getCoupleAuth, unauthorized, badRequest, serverError } from '@/lib/api/auth-helpers'
import { extractRecipeFromBuffer, RecipeValidationError } from '@/lib/services/bar-recipe-extract'

// ---------------------------------------------------------------------------
// POST /api/bar-recipes/extract-upload
// Multipart form: { file: File, weddingId: string }
// Returns: { recipe: BarRecipeRow }
//
// Cap: 10 MB. Accepts image/* and application/pdf only.
// ---------------------------------------------------------------------------

const MAX_BYTES = 10 * 1024 * 1024 // 10 MB

export async function POST(request: NextRequest) {
  const auth = await getCoupleAuth()
  if (!auth) return unauthorized()

  let formData: FormData
  try {
    formData = await request.formData()
  } catch {
    return badRequest('Expected multipart/form-data')
  }

  const file = formData.get('file')
  const weddingId = (formData.get('weddingId') as string | null)?.trim() ?? ''

  if (!(file instanceof File)) return badRequest('Missing file')
  if (!weddingId) return badRequest('Missing weddingId')
  if (weddingId !== auth.weddingId) {
    return NextResponse.json({ error: 'weddingId does not match authenticated session' }, { status: 403 })
  }

  if (file.size > MAX_BYTES) {
    return NextResponse.json(
      { error: `File too large. Max ${Math.round(MAX_BYTES / 1024 / 1024)} MB.` },
      { status: 413 }
    )
  }

  const mimeType = (file.type || '').toLowerCase()
  const isImage = mimeType.startsWith('image/')
  const isPdf = mimeType === 'application/pdf'
  if (!isImage && !isPdf) {
    return badRequest('Only images (jpg, png, webp, gif) or PDFs are accepted.')
  }

  try {
    const buffer = Buffer.from(await file.arrayBuffer())
    const recipe = await extractRecipeFromBuffer(buffer, mimeType, weddingId, auth.venueId)
    return NextResponse.json({ recipe })
  } catch (error) {
    if (error instanceof RecipeValidationError) {
      return NextResponse.json({ error: error.message }, { status: 422 })
    }
    return serverError(error)
  }
}
