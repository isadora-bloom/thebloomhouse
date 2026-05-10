/**
 * POST /api/admin/imports/reprocess
 *
 * Wave 4 Phase 4c — re-run an existing CSV/PDF upload through the
 * unified import-router. Used to fix mis-routed historical uploads
 * without re-asking the operator to export.
 *
 * Body shapes (one of):
 *   { importRunId: string }
 *     — re-process the file at the existing import_runs row's storage
 *       path. Updates the SAME import_runs row in-place (status moves
 *       to 'reprocessing', counts get re-stamped on completion).
 *   { storagePath: string, venueId: string,
 *     filename?: string, mimeType?: string,
 *     bucket?: 'crm-imports' | 'brain-dump' }
 *     — re-process a file by explicit bucket path. Used to retro-fix
 *       brain-dump uploads that pre-date Phase 4c (their bytes live
 *       in 'brain-dump' bucket; reprocessing creates a NEW import_runs
 *       row in 'crm-imports' for the audit trail going forward).
 *
 * Auth:
 *   - getPlatformAuth (coordinator-only) — primary
 *   - CRON_SECRET via Authorization: Bearer ... — for ops scripts.
 *
 * Anchor docs:
 *   - bloom-wave4-identity-reconstruction.md (raw source preserved →
 *     reprocess is a function of the bucket + the current adapter set;
 *     the schema doesn't have to evolve to support replay).
 */

import { NextRequest, NextResponse } from 'next/server'
import { createServiceClient } from '@/lib/supabase/service'
import { getPlatformAuth } from '@/lib/api/auth-helpers'
import { verifyCronAuth } from '@/lib/cron-auth'
import { routeAndProcessUpload } from '@/lib/services/import-router/route-and-process'

interface RequestBody {
  importRunId?: string
  storagePath?: string
  venueId?: string
  filename?: string
  mimeType?: string
  bucket?: string
}

export async function POST(request: NextRequest): Promise<NextResponse> {
  // Dual auth — platform OR cron secret.
  const auth = await getPlatformAuth()
  let venueIdFromAuth: string | null = auth?.venueId ?? null
  let userIdFromAuth: string | null = auth?.userId ?? null
  if (!auth) {
    const cron = verifyCronAuth(request, { jobName: 'import_reprocess' })
    if (!cron.ok) {
      return NextResponse.json({ error: 'unauthorized' }, { status: cron.status ?? 401 })
    }
  }

  let body: RequestBody
  try {
    body = (await request.json()) as RequestBody
  } catch {
    return NextResponse.json({ error: 'invalid_json' }, { status: 400 })
  }

  const supabase = createServiceClient()

  // Resolve which import_runs row + bucket path we're reprocessing.
  let importRunId: string | null = null
  let bucket: string = 'crm-imports'
  let storagePath: string
  let venueId: string
  let filename: string
  let mimeType: string

  if (body.importRunId) {
    const { data: run, error: fetchErr } = await supabase
      .from('import_runs')
      .select('id, venue_id, storage_bucket, storage_path, filename, mime_type')
      .eq('id', body.importRunId)
      .single()
    if (fetchErr || !run) {
      return NextResponse.json({ error: 'import_run_not_found' }, { status: 404 })
    }
    if (venueIdFromAuth && run.venue_id !== venueIdFromAuth) {
      return NextResponse.json({ error: 'forbidden' }, { status: 403 })
    }
    importRunId = run.id as string
    bucket = (run.storage_bucket as string) ?? 'crm-imports'
    storagePath = run.storage_path as string
    venueId = run.venue_id as string
    filename = (run.filename as string) ?? 'reprocessed.csv'
    mimeType = (run.mime_type as string) ?? 'text/csv'
  } else if (body.storagePath && body.venueId) {
    if (venueIdFromAuth && body.venueId !== venueIdFromAuth) {
      return NextResponse.json({ error: 'forbidden' }, { status: 403 })
    }
    storagePath = body.storagePath
    venueId = body.venueId
    bucket = body.bucket ?? 'crm-imports'
    filename = body.filename ?? storagePath.split('/').pop() ?? 'reprocessed.csv'
    mimeType = body.mimeType ?? 'text/csv'
  } else {
    return NextResponse.json(
      { error: 'must supply importRunId OR (storagePath + venueId)' },
      { status: 400 },
    )
  }

  // Download the file from the bucket. We allow either the crm-imports
  // bucket OR the legacy brain-dump bucket — see route-doc above.
  const { data: file, error: dlErr } = await supabase.storage
    .from(bucket)
    .download(storagePath)
  if (dlErr || !file) {
    return NextResponse.json(
      { error: 'storage_download_failed', detail: dlErr?.message },
      { status: 500 },
    )
  }
  const buffer = Buffer.from(await file.arrayBuffer())

  // Reprocess. When reprocessing an existing import_runs row, the
  // router updates THAT row in-place (status → reprocessing → completed).
  // When reprocessing by storagePath (no existing row), the router
  // creates a NEW row tagged source_path='admin-imports-reprocess'.
  const result = await routeAndProcessUpload({
    venueId,
    supabase,
    fileBuffer: buffer,
    filename,
    mimeType,
    sourcePath: 'admin-imports-reprocess',
    ingestedBy: userIdFromAuth ?? null,
    reprocessExistingRunId: importRunId,
    storagePathOverride: bucket === 'crm-imports' ? storagePath : null,
  })

  return NextResponse.json({
    ok: result.status !== 'failed',
    importRunId: result.importRunId,
    detectedShape: result.detectedShape,
    adapterUsed: result.adapterUsed,
    rowsAttempted: result.rowsAttempted,
    rowsInserted: result.rowsInserted,
    rowsUpdated: result.rowsUpdated,
    rowsSkipped: result.rowsSkipped,
    skipReasons: result.skipReasons,
    errors: result.errors,
    reconstructionEnqueuedCount: result.reconstructionEnqueuedCount,
    status: result.status,
    sourceBucket: bucket,
    sourcePath: storagePath,
  })
}
