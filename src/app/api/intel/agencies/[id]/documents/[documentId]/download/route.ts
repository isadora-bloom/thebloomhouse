import { NextRequest, NextResponse } from 'next/server'
import {
  getPlatformAuth,
  unauthorized,
  badRequest,
  notFound,
  serverError,
} from '@/lib/api/auth-helpers'
import { requirePlan, planErrorBody } from '@/lib/auth/require-plan'
import { createServiceClient } from '@/lib/supabase/service'

interface RouteContext {
  params: Promise<{ id: string; documentId: string }>
}

const STORAGE_BUCKET = 'agency-documents'
const SIGNED_URL_TTL_SECONDS = 60

/**
 * GET /api/intel/agencies/[id]/documents/[documentId]/download
 *
 * Wave 6E depth pass. Mints a short-lived signed URL for the
 * agency_documents row's storage object, then 302-redirects.
 *
 * Permission boundary: agency_documents RLS gates whether the caller
 * can resolve the row. Once resolved + the row points at an in-bucket
 * path (vs an external URL), we issue a signed URL.
 *
 * External URLs (Drive / Dropbox links pasted via the URL form) are
 * passed straight through as a redirect — no signing needed.
 */
export async function GET(request: NextRequest, ctx: RouteContext) {
  const plan = await requirePlan(request, 'pre_opening')
  if (!plan.ok) return NextResponse.json(planErrorBody(plan), { status: plan.status })
  const auth = await getPlatformAuth()
  if (!auth) return unauthorized()
  const { id: agencyId, documentId } = await ctx.params
  if (!agencyId || !documentId) {
    return badRequest('agency id and document id required')
  }

  const service = createServiceClient()
  try {
    const { data: doc } = await service
      .from('agency_documents')
      .select('id, agency_id, name, file_url, mime_type, deleted_at')
      .eq('id', documentId)
      .eq('agency_id', agencyId)
      .maybeSingle()
    if (!doc || doc.deleted_at) return notFound('Document')
    if (!doc.file_url) {
      return NextResponse.json(
        { error: 'document has no file_url' },
        { status: 400 },
      )
    }

    // Heuristic: in-bucket paths don't have a scheme; external URLs do.
    const isExternal = /^https?:\/\//.test(doc.file_url as string)
    if (isExternal) {
      return NextResponse.redirect(doc.file_url as string, 302)
    }

    const signed = await service.storage
      .from(STORAGE_BUCKET)
      .createSignedUrl(doc.file_url as string, SIGNED_URL_TTL_SECONDS, {
        download: (doc.name as string) ?? undefined,
      })
    if (signed.error || !signed.data?.signedUrl) {
      return NextResponse.json(
        {
          error: `signing failed: ${signed.error?.message ?? 'unknown'}`,
        },
        { status: 500 },
      )
    }
    return NextResponse.redirect(signed.data.signedUrl, 302)
  } catch (err) {
    return serverError(err)
  }
}
