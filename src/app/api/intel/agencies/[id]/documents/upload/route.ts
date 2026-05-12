import { NextRequest, NextResponse } from 'next/server'
import {
  getPlatformAuth,
  unauthorized,
  badRequest,
  serverError,
} from '@/lib/api/auth-helpers'
import { requirePlan, planErrorBody } from '@/lib/auth/require-plan'
import { createServiceClient } from '@/lib/supabase/service'
import { createDocument } from '@/lib/services/intel/marketing-agency-profile'

interface RouteContext {
  params: Promise<{ id: string }>
}

/**
 * POST /api/intel/agencies/[id]/documents/upload
 *
 * Wave 6E depth pass — native file uploads for agency documents.
 *
 * Accepts multipart/form-data:
 *   - file:           binary
 *   - name:           display name (optional, falls back to filename)
 *   - kind:           contract|sow|monthly_report|... (optional)
 *   - engagementId:   uuid (optional)
 *   - effectiveDate:  YYYY-MM-DD (optional)
 *   - expiresAt:      YYYY-MM-DD (optional)
 *   - notes:          string (optional)
 *
 * The bucket itself is locked to service_role (migration 308) — all
 * access funnels through this endpoint so the agency_documents row
 * acts as the canonical permission boundary. Download happens via the
 * sibling /[documentId]/download route which mints a short-lived
 * signed URL.
 */

export const maxDuration = 60

const STORAGE_BUCKET = 'agency-documents'

// 25 MB hard cap, mirroring the migration 308 bucket setting.
const MAX_BYTES = 25 * 1024 * 1024

// Whitelist enforced here (not on bucket) because Supabase's
// allowed_mime_types churns the schema cache when changed.
const ALLOWED_MIME = new Set([
  'application/pdf',
  'application/msword',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'application/vnd.ms-excel',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  'application/vnd.ms-powerpoint',
  'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  'image/png',
  'image/jpeg',
  'image/webp',
  'text/csv',
  'text/plain',
  'text/markdown',
])

function slugify(input: string): string {
  return input
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9.]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60) || 'file'
}

function extFromName(name: string): string {
  const match = name.match(/\.([a-z0-9]{1,8})$/i)
  return match ? match[1].toLowerCase() : ''
}

export async function POST(request: NextRequest, ctx: RouteContext) {
  const plan = await requirePlan(request, 'pre_opening')
  if (!plan.ok) return NextResponse.json(planErrorBody(plan), { status: plan.status })
  const auth = await getPlatformAuth()
  if (!auth) return unauthorized()
  if (auth.isDemo) {
    return NextResponse.json(
      { error: 'demo cannot upload documents' },
      { status: 403 },
    )
  }
  const { id: agencyId } = await ctx.params
  if (!agencyId) return badRequest('agency id required')

  let form: FormData
  try {
    form = await request.formData()
  } catch {
    return badRequest('expected multipart/form-data')
  }

  const file = form.get('file')
  if (!(file instanceof Blob)) {
    return badRequest('file field missing or not a Blob')
  }
  if (file.size === 0) return badRequest('empty file')
  if (file.size > MAX_BYTES) {
    return badRequest(
      `file is ${(file.size / 1024 / 1024).toFixed(1)}MB; max is 25MB`,
    )
  }

  const mime = (file as File).type || 'application/octet-stream'
  if (!ALLOWED_MIME.has(mime)) {
    return badRequest(
      `unsupported MIME ${mime}. Allowed: PDF, Word, Excel, PowerPoint, images (png/jpeg/webp), CSV, plain text, markdown.`,
    )
  }

  const originalName =
    (typeof form.get('name') === 'string' && (form.get('name') as string).trim()) ||
    ((file as File).name ?? 'document')
  const ext = extFromName((file as File).name ?? originalName)

  // Pre-allocate the document ID so the storage path can encode it.
  // Lets us correlate the file with its row even if the insert fails
  // (orphan cleanup script can match the path back to a missing row).
  const service = createServiceClient()
  const docId = crypto.randomUUID()
  const baseSlug = slugify(originalName.replace(/\.[a-z0-9]{1,8}$/i, ''))
  const storagePath = `${agencyId}/${docId}-${baseSlug}${ext ? '.' + ext : ''}`

  // Upload to storage via service-role.
  const fileBuf = Buffer.from(await file.arrayBuffer())
  const uploadResp = await service.storage
    .from(STORAGE_BUCKET)
    .upload(storagePath, fileBuf, {
      contentType: mime,
      upsert: false,
    })
  if (uploadResp.error) {
    return NextResponse.json(
      { error: `upload failed: ${uploadResp.error.message}` },
      { status: 500 },
    )
  }

  try {
    const document = await createDocument({
      agencyId,
      engagementId:
        typeof form.get('engagementId') === 'string'
          ? (form.get('engagementId') as string)
          : null,
      name: originalName,
      // file_url stores the storage path. Download endpoint mints a
      // signed URL at request time. We DO NOT store the signed URL —
      // signed URLs expire and storing them invites stale links.
      fileUrl: storagePath,
      fileSizeBytes: file.size,
      mimeType: mime,
      kind:
        typeof form.get('kind') === 'string'
          ? (form.get('kind') as string)
          : null,
      effectiveDate:
        typeof form.get('effectiveDate') === 'string'
          ? (form.get('effectiveDate') as string)
          : null,
      expiresAt:
        typeof form.get('expiresAt') === 'string'
          ? (form.get('expiresAt') as string)
          : null,
      notes:
        typeof form.get('notes') === 'string'
          ? (form.get('notes') as string)
          : null,
      uploadedBy: auth.userId,
    })
    return NextResponse.json({ document }, { status: 201 })
  } catch (err) {
    // Best-effort cleanup of the orphaned upload. Don't block the
    // error response on this; if it fails, the orphan-cleanup cron
    // (future) will catch it.
    void service.storage.from(STORAGE_BUCKET).remove([storagePath])
    if (err instanceof Error) return badRequest(err.message)
    return serverError(err)
  }
}
