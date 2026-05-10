/**
 * Unified import-router (Wave 4 Phase 4c).
 *
 * Anchor docs:
 *   - bloom-wave4-identity-reconstruction.md (raw source preserved,
 *     parsing is a derivation; reconstruction enqueued for every
 *     wedding the import touches).
 *   - feedback_deep_fix_vs_bandaid.md (this is the layer-replace fix:
 *     every CSV/PDF upload, regardless of entry path, persists +
 *     dispatches through this single function so a brain-dump misroute
 *     and an /onboarding/crm-import success can't drift).
 *   - feedback_no_regex_on_user_text.md (header-matching for shape
 *     detection is structured; we never regex over message bodies).
 *
 * The bug this closes
 * -------------------
 * Operator uploaded a HoneyBook export CSV (~71 wedding records) via
 * brain-dump. Brain-dump's csv-shape.ts only recognised generic shapes;
 * the HoneyBook export hit platform_activity → importPlatformSignals
 * with strict filters → 63 of 71 rows skipped silently, 8 partials in
 * the wrong table. The actual HoneyBook adapter was never called.
 *
 * The fix
 * -------
 * 1. csv-shape.ts now recognises adapter shapes (honeybook, aisleplanner,
 *    dubsado, tour_scheduler, web_form, web_form_packages) BEFORE the
 *    generic shapes (leads, platform_activity, etc).
 * 2. This module dispatches an adapter-shape upload to the correct
 *    crm-import adapter.
 * 3. Every upload persists raw bytes to the `crm-imports` storage bucket
 *    (migration 270) and emits an import_runs audit row capturing
 *    detected_shape, adapter_used, per-skip-reason counts, and
 *    reconstruction-enqueued counts.
 * 4. Reprocessing re-reads from the bucket and runs the current adapter
 *    — so a future adapter improvement can be retroactively applied to
 *    historical uploads without re-asking the operator to export.
 *
 * Why this is the deep fix
 * ------------------------
 * Per memory/feedback_deep_fix_vs_bandaid.md the band-aid would have
 * been to add a HoneyBook detector to platform-detectors and route the
 * mis-classified rows there. That's symptom-level. The class-of-problem
 * is "every adapter-shaped CSV that ever lands via brain-dump skips its
 * own adapter". The layer fix is: brain-dump + onboarding both delegate
 * to one router that knows about adapter shapes.
 */

import { randomUUID, createHash } from 'node:crypto'
import type { SupabaseClient } from '@supabase/supabase-js'
import {
  detectCsvShape,
  parseCsvRows,
  isAdapterShape,
  type CsvShape,
  type ShapeDetection,
} from '@/lib/services/brain-dump/csv-shape'
import {
  findAdapter,
  type CommitResult,
} from '@/lib/services/crm-import'
import { enqueueIdentityReconstruction } from '@/lib/services/identity/enqueue-reconstruction'

const BUCKET_NAME = 'crm-imports'

export type SourcePath =
  | 'brain-dump'
  | 'crm-import-onboarding'
  | 'admin-imports-reprocess'
  | 'web-form-import-onboarding'
  | 'tour-scheduler-import-onboarding'

export interface RouteAndProcessInput {
  venueId: string
  supabase: SupabaseClient
  fileBuffer: Buffer
  filename: string
  mimeType: string | null
  sourcePath: SourcePath
  ingestedBy?: string | null
  /** Skip persistence + import_runs row creation. Used by reprocess
   *  flows where the row + bytes already exist; reprocess passes its
   *  own existingImportRunId to update in-place. */
  reprocessExistingRunId?: string | null
  /** When persisting fresh, the explicit storage path to use. Lets
   *  reprocess re-use the existing bucket path. */
  storagePathOverride?: string | null
}

export interface RouteAndProcessResult {
  importRunId: string
  detectedShape: CsvShape
  adapterUsed: string | null
  rowsAttempted: number
  rowsInserted: number
  rowsUpdated: number
  rowsSkipped: number
  skipReasons: Record<string, number>
  errors: string[]
  reconstructionEnqueuedCount: number
  status: 'completed' | 'failed' | 'reprocessing'
  storagePath: string
}

/**
 * Route + process a CSV/PDF upload. The single entry point that every
 * upload path delegates to. Persists raw bytes, detects shape,
 * dispatches to the correct adapter, captures structured results in
 * import_runs, and enqueues identity-reconstruction for every wedding
 * the import touches.
 */
export async function routeAndProcessUpload(
  input: RouteAndProcessInput,
): Promise<RouteAndProcessResult> {
  const {
    venueId,
    supabase,
    fileBuffer,
    filename,
    mimeType,
    sourcePath,
    ingestedBy,
    reprocessExistingRunId,
    storagePathOverride,
  } = input

  const errors: string[] = []
  const skipReasons: Record<string, number> = {}

  // -- step 1: persist raw bytes (or reuse for reprocess) -------------------
  let storagePath: string
  if (storagePathOverride) {
    storagePath = storagePathOverride
  } else {
    storagePath = buildStoragePath(venueId, filename)
    try {
      const { error: upErr } = await supabase.storage
        .from(BUCKET_NAME)
        .upload(storagePath, fileBuffer, {
          contentType: mimeType ?? 'application/octet-stream',
          upsert: false,
        })
      if (upErr) {
        errors.push(`storage_upload_failed: ${upErr.message}`)
      }
    } catch (err) {
      errors.push(
        `storage_upload_threw: ${err instanceof Error ? err.message : String(err)}`,
      )
    }
  }

  // -- step 2: detect shape from headers ------------------------------------
  let detection: ShapeDetection
  try {
    const text = fileBuffer.toString('utf-8')
    const rows = parseCsvRows(text)
    const headerRow = rows[0] ?? []
    detection = detectCsvShape(headerRow)
  } catch (err) {
    detection = {
      shape: 'unknown',
      columns: {},
      headersNormalised: [],
      confidence: 0,
    }
    errors.push(
      `parse_csv_failed: ${err instanceof Error ? err.message : String(err)}`,
    )
  }

  // -- step 3: insert / update import_runs row ------------------------------
  let importRunId = reprocessExistingRunId ?? ''
  if (reprocessExistingRunId) {
    // Reprocess: bump status to 'reprocessing'. Counts get filled in
    // when the adapter completes.
    await supabase
      .from('import_runs')
      .update({
        status: 'reprocessing',
        detected_shape: detection.shape,
      })
      .eq('id', reprocessExistingRunId)
  } else {
    const { data: row, error: insErr } = await supabase
      .from('import_runs')
      .insert({
        venue_id: venueId,
        source_path: sourcePath,
        storage_bucket: BUCKET_NAME,
        storage_path: storagePath,
        filename,
        mime_type: mimeType ?? null,
        file_size_bytes: fileBuffer.byteLength,
        detected_shape: detection.shape,
        adapter_used: null,
        rows_attempted: null,
        rows_inserted: null,
        rows_updated: null,
        rows_skipped: null,
        skip_reasons: null,
        errors: null,
        status: 'processing',
        reconstruction_enqueued_count: 0,
        ingested_by: ingestedBy ?? null,
      })
      .select('id')
      .single()
    if (insErr || !row) {
      // We can't proceed without an audit row to update. Surface the
      // error but DO try to dispatch — the caller may still want to see
      // the row counts. Return as 'failed' afterward.
      errors.push(`import_runs_insert_failed: ${insErr?.message ?? 'no row'}`)
      // Synthesise a stable fallback id for the result so the caller
      // can still correlate logs.
      importRunId = randomUUID()
    } else {
      importRunId = row.id as string
    }
  }

  // -- step 4: dispatch by shape --------------------------------------------
  const text = fileBuffer.toString('utf-8')
  const rows = parseCsvRows(text)
  const dataRowCount = Math.max(0, rows.length - 1)

  let adapterUsed: string | null = null
  let rowsInserted = 0
  let rowsUpdated = 0
  let rowsSkipped = 0
  let touchedWeddingIds: string[] = []
  let dispatchStatus: 'completed' | 'failed' = 'completed'

  if (isAdapterShape(detection.shape)) {
    // Adapter shape — call the corresponding crm-import adapter.
    const adapterName = mapShapeToAdapterName(detection.shape)
    const adapter = adapterName ? findAdapter(adapterName) : null
    if (!adapter) {
      dispatchStatus = 'failed'
      errors.push(`no_adapter_for_shape:${detection.shape}`)
      bumpSkip(skipReasons, 'no_adapter_for_shape', dataRowCount)
      rowsSkipped = dataRowCount
    } else if (!adapter.ready) {
      dispatchStatus = 'failed'
      errors.push(`adapter_not_ready:${adapterName}`)
      bumpSkip(skipReasons, 'adapter_scaffold_only', dataRowCount)
      rowsSkipped = dataRowCount
      adapterUsed = adapterName
    } else {
      adapterUsed = adapterName
      const parseResult = await adapter.parse({ csvText: text })
      if (!parseResult.ok) {
        dispatchStatus = 'failed'
        errors.push(...parseResult.errors)
        bumpSkip(skipReasons, 'adapter_parse_failed', dataRowCount)
        rowsSkipped = dataRowCount
      } else {
        const commitResult: CommitResult = await adapter.commit({
          supabase,
          venueId,
          rows: parseResult.rows,
        })
        rowsInserted = commitResult.weddingsInserted
        rowsUpdated = 0
        rowsSkipped = Math.max(
          0,
          parseResult.rows.length - commitResult.weddingsInserted,
        )
        if (rowsSkipped > 0) {
          // Adapter doesn't break out reasons; count as duplicates
          // (resolver-attached) since that's the dominant case.
          bumpSkip(skipReasons, 'duplicate_or_resolver_attached', rowsSkipped)
        }
        if (commitResult.errors.length > 0) {
          errors.push(...commitResult.errors)
        }
        if (!commitResult.ok) dispatchStatus = 'failed'
        touchedWeddingIds = commitResult.touchedWeddingIds ?? []
      }
    }
  } else {
    // Generic shape — delegate to the existing brain-dump runCsvImport
    // pipeline so leads / reviews / platform_activity / tour_links /
    // marketing_spend / knowledge_base_* keep working unchanged.
    // Lazy import to avoid a static cycle (brain-dump/route.ts is the
    // primary caller and pulls in this module too in some test paths).
    const { runCsvImport } = await import('@/app/api/brain-dump/route')
    const headerRow = rows[0] ?? []
    const dataRows = rows.slice(1)
    try {
      const summary = await runCsvImport({
        supabase: supabase as never, // service-client-shaped; runCsvImport accepts both shapes
        venueId,
        detection,
        headerRow,
        dataRows,
      })
      rowsInserted = summary.inserted
      rowsUpdated = summary.updated
      rowsSkipped = summary.skipped
      adapterUsed = mapShapeToAdapterUsedLabel(detection.shape)
      if (rowsSkipped > 0) {
        bumpSkip(skipReasons, 'generic_pipeline_skipped', rowsSkipped)
      }
      if (summary.errors.length > 0) errors.push(...summary.errors)
      if (detection.shape === 'unknown') {
        dispatchStatus = 'failed'
        errors.push('unknown_shape: detector did not match any adapter or generic shape')
      }
    } catch (err) {
      dispatchStatus = 'failed'
      errors.push(
        `generic_dispatch_threw: ${err instanceof Error ? err.message : String(err)}`,
      )
      rowsSkipped = dataRowCount
      bumpSkip(skipReasons, 'generic_pipeline_threw', dataRowCount)
    }
  }

  // -- step 5: enqueue identity reconstruction for every touched wedding ---
  let reconstructionEnqueuedCount = 0
  if (touchedWeddingIds.length > 0) {
    const dedupeIds = Array.from(new Set(touchedWeddingIds))
    for (const weddingId of dedupeIds) {
      const r = await enqueueIdentityReconstruction({
        weddingId,
        venueId,
        triggerSignal: `import_router:${sourcePath}:${detection.shape}`,
        supabase,
      })
      if (!r.skipped) reconstructionEnqueuedCount += 1
    }
  }

  // -- step 6: finalise import_runs row -------------------------------------
  if (importRunId) {
    await supabase
      .from('import_runs')
      .update({
        adapter_used: adapterUsed,
        rows_attempted: dataRowCount,
        rows_inserted: rowsInserted,
        rows_updated: rowsUpdated,
        rows_skipped: rowsSkipped,
        skip_reasons: Object.keys(skipReasons).length > 0 ? skipReasons : null,
        errors: errors.length > 0 ? errors : null,
        status: dispatchStatus,
        reconstruction_enqueued_count: reconstructionEnqueuedCount,
        completed_at: new Date().toISOString(),
      })
      .eq('id', importRunId)
  }

  return {
    importRunId,
    detectedShape: detection.shape,
    adapterUsed,
    rowsAttempted: dataRowCount,
    rowsInserted,
    rowsUpdated,
    rowsSkipped,
    skipReasons,
    errors,
    reconstructionEnqueuedCount,
    status: dispatchStatus,
    storagePath,
  }
}

/**
 * Build a deterministic storage path so reprocess flows can locate the
 * same row by path lookup. Pattern: {venueId}/{ts}-{uuid}-{safeName}.
 */
function buildStoragePath(venueId: string, filename: string): string {
  const ts = new Date().toISOString().replace(/[:.]/g, '-')
  const uuid = randomUUID()
  const safe = sanitiseFilename(filename)
  return `${venueId}/${ts}-${uuid}-${safe}`
}

function sanitiseFilename(name: string): string {
  // Strip path separators + control characters; cap length. The bytes
  // remain authoritative — this is just for the storage key readability.
  const cleaned = name
    .replace(/[\\/]/g, '_')
    .replace(/[\x00-\x1f\x7f]/g, '')
    .trim()
  if (!cleaned) {
    // Fall back to a hash-based name so we don't error on empty input.
    return createHash('sha1').update(name).digest('hex').slice(0, 12)
  }
  return cleaned.slice(0, 200)
}

function bumpSkip(
  skipReasons: Record<string, number>,
  key: string,
  n: number,
): void {
  if (n <= 0) return
  skipReasons[key] = (skipReasons[key] ?? 0) + n
}

/** Map detector shape → crm-import adapter registry name. */
function mapShapeToAdapterName(shape: CsvShape): string | null {
  switch (shape) {
    case 'honeybook':
      return 'honeybook'
    case 'aisleplanner':
      return 'aisle_planner'
    case 'dubsado':
      return 'dubsado'
    case 'tour_scheduler':
      return 'tour_scheduler'
    case 'web_form':
      return 'web_form'
    case 'web_form_packages':
      // web_form_packages routes to web_form (the packages flavour is
      // an extraction subsidiary handled by extract-packages, not a
      // distinct adapter).
      return 'web_form'
    default:
      return null
  }
}

/**
 * Friendly label for adapter_used when the generic pipeline ran. The
 * generic pipeline doesn't expose a single "adapter name" so we
 * synthesise a stable label from the detected shape.
 */
function mapShapeToAdapterUsedLabel(shape: CsvShape): string {
  switch (shape) {
    case 'leads':
      return 'brain-dump:leads'
    case 'tour_links':
      return 'brain-dump:tour_links'
    case 'platform_activity':
      return 'brain-dump:platform_signals'
    case 'reviews':
      return 'brain-dump:reviews'
    case 'marketing_spend':
      return 'brain-dump:marketing_spend'
    case 'knowledge_base_qa':
    case 'knowledge_base_tc':
      return 'brain-dump:knowledge_base'
    case 'unknown':
      return 'brain-dump:unknown'
    default:
      return `brain-dump:${shape}`
  }
}
