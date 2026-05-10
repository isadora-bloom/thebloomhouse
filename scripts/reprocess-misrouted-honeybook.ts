/**
 * Wave 4 Phase 4c — one-shot reprocess script for Rixey's misrouted
 * HoneyBook export.
 *
 * The HoneyBook CSV (`January-2025-March-2026-Booked Client-report-
 * (HoneyBook).csv`, ~71 wedding records) was uploaded via brain-dump
 * before Phase 4c shipped. The file lives in the brain-dump bucket;
 * 8 partial rows landed in tangential_signals, 63 rows were skipped.
 *
 * Run this script once after migration 270 has been applied + the
 * import-router code has shipped. It identifies brain-dump bucket
 * objects matching HoneyBook export filename patterns and re-runs each
 * through routeAndProcessUpload(), so:
 *   1. Each file is persisted to the crm-imports bucket.
 *   2. An import_runs row is created with detected_shape='honeybook'.
 *   3. The honeybook adapter runs against all 71 rows.
 *   4. Identity-reconstruction is enqueued for every wedding the
 *      adapter touched.
 *
 * Usage:
 *   node --env-file=.env.local --import tsx scripts/reprocess-misrouted-honeybook.ts <venueId>
 *
 * The venueId is required so we don't accidentally mass-reprocess
 * across venues.
 */

import { createClient } from '@supabase/supabase-js'
import { routeAndProcessUpload } from '../src/lib/services/import-router/route-and-process'

const FILENAME_PATTERNS = [
  /honeybook/i,
  /booked[-\s_]*client/i,
  /january.*\d{4}.*march.*\d{4}/i,
  /client[-\s_]*report/i,
]

async function main() {
  const venueId = process.argv[2]
  if (!venueId) {
    console.error('Usage: scripts/reprocess-misrouted-honeybook.ts <venueId>')
    process.exit(2)
  }

  const url = process.env.NEXT_PUBLIC_SUPABASE_URL
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY
  if (!url || !serviceKey) {
    console.error('NEXT_PUBLIC_SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY must be set')
    process.exit(1)
  }

  const supabase = createClient(url, serviceKey, {
    auth: { autoRefreshToken: false, persistSession: false },
  })

  // List brain-dump bucket objects under the venue prefix.
  const { data: objects, error } = await supabase.storage
    .from('brain-dump')
    .list(venueId, { limit: 1000, sortBy: { column: 'created_at', order: 'desc' } })

  if (error) {
    console.error('Failed to list brain-dump bucket:', error.message)
    process.exit(1)
  }
  if (!objects) {
    console.log('No objects found in brain-dump bucket for venue', venueId)
    return
  }

  const candidates = objects.filter((obj) => {
    if (!obj.name) return false
    if (!obj.name.toLowerCase().endsWith('.csv')) return false
    if ((obj.metadata?.size ?? 0) < 10_000) return false
    return FILENAME_PATTERNS.some((re) => re.test(obj.name))
  })

  console.log(`Found ${candidates.length} candidate misrouted HoneyBook CSVs:`)
  for (const c of candidates) {
    console.log(`  - ${venueId}/${c.name} (${c.metadata?.size ?? '?'} bytes)`)
  }
  if (candidates.length === 0) return

  let totalRowsInserted = 0
  let totalReconstructionEnqueued = 0
  for (const candidate of candidates) {
    const fullPath = `${venueId}/${candidate.name}`
    console.log(`\nReprocessing ${fullPath} ...`)
    const { data: file, error: dlErr } = await supabase.storage
      .from('brain-dump')
      .download(fullPath)
    if (dlErr || !file) {
      console.error(`  download failed: ${dlErr?.message}`)
      continue
    }
    const buffer = Buffer.from(await file.arrayBuffer())

    // Re-upload bytes into crm-imports + create a fresh import_runs row.
    // The brain-dump bucket copy stays put — re-uploading is cheap and
    // preserves the audit trail.
    const result = await routeAndProcessUpload({
      venueId,
      supabase,
      fileBuffer: buffer,
      filename: candidate.name,
      mimeType: 'text/csv',
      sourcePath: 'admin-imports-reprocess',
      ingestedBy: null,
    })
    console.log(
      `  detected_shape=${result.detectedShape} adapter=${result.adapterUsed}`
    )
    console.log(
      `  rows: attempted=${result.rowsAttempted} inserted=${result.rowsInserted} ` +
      `skipped=${result.rowsSkipped} reconstruction_enqueued=${result.reconstructionEnqueuedCount}`,
    )
    if (result.errors.length > 0) {
      console.log(`  errors:`, result.errors.slice(0, 3))
    }
    totalRowsInserted += result.rowsInserted
    totalReconstructionEnqueued += result.reconstructionEnqueuedCount
  }
  console.log(
    `\nTotal: ${totalRowsInserted} rows inserted, ${totalReconstructionEnqueued} ` +
    `weddings enqueued for identity reconstruction.`,
  )
}

void main().catch((err) => {
  console.error(err)
  process.exit(1)
})
