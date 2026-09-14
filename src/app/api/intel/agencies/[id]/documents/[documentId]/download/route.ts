import { NextRequest, NextResponse } from 'next/server'
import { writeOrLog } from '@/lib/db/write-or-log'
import { createHash } from 'crypto'
import {
  getPlatformAuth,
  unauthorized,
  badRequest,
  notFound,
  serverError,
} from '@/lib/api/auth-helpers'
import { requirePlan, planErrorBody } from '@/lib/auth/require-plan'
import { requireAgencyScope } from '@/lib/services/intel/agency-access'
import { createServiceClient } from '@/lib/supabase/service'

interface RouteContext {
  params: Promise<{ id: string; documentId: string }>
}

const STORAGE_BUCKET = 'agency-documents'
const SIGNED_URL_TTL_SECONDS = 60

/**
 * Hosts we are willing to 302 to. Deliberately short: these are the
 * services a coordinator actually pastes an agency contract link from.
 * Anything else is handed back as JSON rather than redirected, so this
 * endpoint cannot be used to launder a phishing destination behind our
 * own domain.
 */
const EXTERNAL_DOCUMENT_HOSTS: readonly string[] = [
  'drive.google.com',
  'docs.google.com',
  'dropbox.com',
  'box.com',
  'sharepoint.com',
  'onedrive.live.com',
  '1drv.ms',
  'notion.so',
  'hellosign.com',
  'docusign.net',
  'docusign.com',
  'adobe.com',
]

function isAllowedExternalDocumentUrl(raw: string): boolean {
  let parsed: URL
  try {
    parsed = new URL(raw)
  } catch {
    return false
  }
  if (parsed.protocol !== 'https:') return false
  if (parsed.username || parsed.password) return false
  const host = parsed.hostname.toLowerCase()
  return EXTERNAL_DOCUMENT_HOSTS.some((h) => host === h || host.endsWith(`.${h}`))
}

/**
 * GET /api/intel/agencies/[id]/documents/[documentId]/download
 *
 * Wave 6E depth pass. Mints a short-lived signed URL for the
 * agency_documents row's storage object, then 302-redirects.
 *
 * Permission boundary: requireAgencyScope. The row lookup below uses the
 * service-role client, so RLS is not in the picture and the check has to
 * be explicit. Once the agency is in scope and the row points at an
 * in-bucket path, we issue a 60-second signed URL.
 *
 * External URLs (Drive / Dropbox links pasted via the URL form) used to
 * be handed straight to NextResponse.redirect, which made this endpoint a
 * general-purpose open redirect on the app's own origin: a link that
 * reads as ours and lands on whatever the row says. They now have to be
 * https and on a known document host, and anything else comes back as
 * JSON the operator can read and click deliberately.
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
  // S5 (2026-09-14 audit item 5). The comment below used to claim
  // "agency_documents RLS gates whether the caller can resolve the row" —
  // it does not, because the lookup two lines down uses the service-role
  // client, which is defined as the client RLS does not apply to. Any
  // authenticated coordinator who knew an agency id and a document id got
  // a signed URL to another venue's signed contract, and an audit row was
  // written confirming the download. The scope check is the gate.
  const denied = await requireAgencyScope(agencyId, auth)
  if (denied) return denied

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

    // Write an audit row BEFORE redirecting so a download attempt always
    // leaves a trace even if the user closes the tab mid-redirect.
    void (async () => {
      try {
        const ipHeader =
          request.headers.get('x-forwarded-for')?.split(',')[0]?.trim() ??
          request.headers.get('x-real-ip')
        const uaHeader = request.headers.get('user-agent')
        const salt = documentId // per-document salt — non-reversible across docs
        const ipHash = ipHeader
          ? createHash('sha256')
              .update(`${salt}:${ipHeader}`)
              .digest('hex')
              .slice(0, 32)
          : null
        const userAgentHash = uaHeader
          ? createHash('sha256')
              .update(`${salt}:${uaHeader}`)
              .digest('hex')
              .slice(0, 32)
          : null
        await writeOrLog(service.from('agency_document_downloads').insert({
          document_id: documentId,
          agency_id: agencyId,
          downloaded_by: auth.userId,
          ip_hash: ipHash,
          user_agent_hash: userAgentHash,
        }), { op: 'agency_document_downloads.insert', venueId: null })
      } catch (err) {
        console.warn('[documents/download] audit write failed:', err)
      }
    })()

    // Heuristic: in-bucket paths don't have a scheme; external URLs do.
    const isExternal = /^[a-z][a-z0-9+.-]*:/i.test(doc.file_url as string)
    if (isExternal) {
      const target = doc.file_url as string
      if (!isAllowedExternalDocumentUrl(target)) {
        return NextResponse.json(
          {
            error:
              'This document is a link to an outside service we do not redirect to. Open it yourself if you trust it.',
            url: target,
          },
          { status: 409 },
        )
      }
      return NextResponse.redirect(target, 302)
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
