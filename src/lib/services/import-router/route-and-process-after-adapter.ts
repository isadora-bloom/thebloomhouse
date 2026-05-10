/**
 * Post-adapter persistence helper (Wave 4 Phase 4c).
 *
 * The /api/onboarding/crm-import endpoint dispatches an explicit
 * adapter (the operator picks HoneyBook / Dubsado / Aisle Planner /
 * generic_csv from the UI), so it doesn't go through the unified
 * shape-detection flow. To keep raw-source persistence + import_runs
 * audit + reconstruction-enqueue uniform across all upload paths, this
 * helper runs AFTER the adapter commits and:
 *
 *   1. Persists the raw CSV/JSON bytes to the crm-imports bucket.
 *   2. Inserts one import_runs row with detected_shape = adapter name
 *      (since the operator declared it explicitly).
 *   3. Enqueues identity-reconstruction for every wedding the commit
 *      touched (commitResult.touchedWeddingIds).
 *
 * Errors are non-fatal — the import itself already committed. The
 * caller logs + falls through.
 */

import { randomUUID } from 'node:crypto'
import type { SupabaseClient } from '@supabase/supabase-js'
import type { CommitResult } from '@/lib/services/crm-import'
import { enqueueIdentityReconstruction } from '@/lib/services/identity/enqueue-reconstruction'

const BUCKET_NAME = 'crm-imports'

export interface PersistAndEnqueueInput {
  supabase: SupabaseClient
  venueId: string
  ingestedBy?: string | null
  sourcePath:
    | 'crm-import-onboarding'
    | 'web-form-import-onboarding'
    | 'tour-scheduler-import-onboarding'
  adapterName: string
  csvText: string | null
  jsonText: string | null
  filename: string
  commitResult: CommitResult
}

export interface PersistAndEnqueueResult {
  importRunId: string | null
  reconstructionEnqueuedCount: number
}

export async function persistAndEnqueueAfterAdapterCommit(
  input: PersistAndEnqueueInput,
): Promise<PersistAndEnqueueResult> {
  const {
    supabase,
    venueId,
    ingestedBy,
    sourcePath,
    adapterName,
    csvText,
    jsonText,
    filename,
    commitResult,
  } = input

  // 1. Persist raw bytes (CSV or JSON, whichever the operator supplied).
  const text = csvText ?? jsonText ?? ''
  const buffer = Buffer.from(text, 'utf-8')
  const ts = new Date().toISOString().replace(/[:.]/g, '-')
  const storagePath = `${venueId}/${ts}-${randomUUID()}-${sanitiseFilename(filename)}`
  let stored = false
  if (buffer.byteLength > 0) {
    try {
      const { error: upErr } = await supabase.storage
        .from(BUCKET_NAME)
        .upload(storagePath, buffer, {
          contentType: jsonText ? 'application/json' : 'text/csv',
          upsert: false,
        })
      stored = !upErr
    } catch {
      stored = false
    }
  }

  // 2. Write import_runs row.
  const skipRows = Math.max(
    0,
    // Adapter doesn't expose row-attempt count; reconstruct from
    // commit counts. weddings_inserted is the closest proxy to a
    // success row count; the rest is "skipped or attached to existing".
    0,
  )
  let importRunId: string | null = null
  try {
    const { data: row, error: insErr } = await supabase
      .from('import_runs')
      .insert({
        venue_id: venueId,
        source_path: sourcePath,
        storage_bucket: BUCKET_NAME,
        storage_path: stored ? storagePath : `(unstored)/${filename}`,
        filename,
        mime_type: jsonText ? 'application/json' : 'text/csv',
        file_size_bytes: buffer.byteLength,
        // Map the explicit adapter name into the detected_shape slot so
        // the imports admin page can filter by shape uniformly.
        detected_shape: mapAdapterToShape(adapterName),
        adapter_used: adapterName,
        rows_attempted: null,
        rows_inserted: commitResult.weddingsInserted,
        rows_updated: 0,
        rows_skipped: skipRows,
        skip_reasons: null,
        errors: commitResult.errors.length > 0 ? commitResult.errors : null,
        status: commitResult.ok ? 'completed' : 'failed',
        reconstruction_enqueued_count: 0,
        ingested_by: ingestedBy ?? null,
        completed_at: new Date().toISOString(),
      })
      .select('id')
      .single()
    if (!insErr && row) importRunId = row.id as string
  } catch {
    importRunId = null
  }

  // 3. Enqueue identity-reconstruction for every touched wedding.
  let reconstructionEnqueuedCount = 0
  const touchedWeddingIds = commitResult.touchedWeddingIds ?? []
  if (touchedWeddingIds.length > 0) {
    const dedupeIds = Array.from(new Set(touchedWeddingIds))
    for (const weddingId of dedupeIds) {
      const r = await enqueueIdentityReconstruction({
        weddingId,
        venueId,
        triggerSignal: `import_router:${sourcePath}:${adapterName}`,
        supabase,
      })
      if (!r.skipped) reconstructionEnqueuedCount += 1
    }
  }

  // Stamp the count back on the import_runs row.
  if (importRunId) {
    try {
      await supabase
        .from('import_runs')
        .update({ reconstruction_enqueued_count: reconstructionEnqueuedCount })
        .eq('id', importRunId)
    } catch {
      // non-fatal
    }
  }

  return { importRunId, reconstructionEnqueuedCount }
}

function sanitiseFilename(name: string): string {
  const cleaned = (name ?? '')
    .replace(/[\\/]/g, '_')
    .replace(/[\x00-\x1f\x7f]/g, '')
    .trim()
  return (cleaned || 'unnamed-import').slice(0, 200)
}

/** Map adapter registry name → detected_shape value used by csv-shape. */
function mapAdapterToShape(adapterName: string): string {
  switch (adapterName) {
    case 'honeybook':
      return 'honeybook'
    case 'dubsado':
      return 'dubsado'
    case 'aisle_planner':
      return 'aisleplanner'
    case 'tour_scheduler':
      return 'tour_scheduler'
    case 'web_form':
      return 'web_form'
    case 'generic_csv':
      return 'leads' // closest semantic — generic_csv produces lead rows
    default:
      return adapterName
  }
}
