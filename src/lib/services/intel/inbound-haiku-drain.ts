/**
 * Bloom House — Inbound Haiku drain (cron safety net).
 *
 * Anchor docs
 * -----------
 *   - BLOOM-PATTERNS-ZOOM-OUT.md Pattern 5.
 *   - bloom-data-integrity-sweep.md: idempotent reclassification —
 *     re-runs converge, never diverge.
 *
 * What this service does
 * ----------------------
 * Drains the partial index idx_interactions_haiku_pending — inbound
 * interactions with haiku_classified_at IS NULL. Two roles:
 *
 *   1. Safety net for the fire-and-forget classifier wired into the
 *      email pipeline. If a Vercel function tears down before the
 *      detached promise lands, this catches the row on the next tick.
 *   2. Historical backfill — every inbound row that landed before mig
 *      311 has haiku_classified_at IS NULL and will be picked up here.
 *
 * Bounds
 * ------
 *   - 50 rows per tick total (cap on the SELECT).
 *   - Concurrency = 5 inside the worker via Promise.allSettled batches.
 *   - 5-minute buffer (created_at < now() - interval '5 minutes') so
 *     freshly-inserted rows get a chance via the synchronous fire-and-
 *     forget path before the cron touches them. Avoids two parallel
 *     classifies on the same row even though the UPDATE is guarded by
 *     a haiku_classified_at IS NULL predicate.
 *
 * Cost ~$0.0003/row. A Rixey-sized historical tail of ~12k inbound
 * rows is ~$3.60 total spread across ticks.
 */

import { createServiceClient } from '@/lib/supabase/service'
import { classifyInboundInteraction } from './inbound-haiku-classifier'
import { logEvent } from '@/lib/observability/logger'

const ROWS_PER_TICK = 50
const CONCURRENCY = 5
const BUFFER_MINUTES = 5

export interface InboundHaikuDrainResult {
  scanned: number
  classified: number
  errors: number
  hadRows: boolean
}

interface PendingRow {
  id: string
  venue_id: string
  full_body: string | null
  subject: string | null
}

/**
 * One drain tick. Returns counts so cron telemetry can show progress.
 * NEVER throws — every error is logged and counted.
 */
export async function runInboundHaikuDrain(): Promise<InboundHaikuDrainResult> {
  const supabase = createServiceClient()
  const out: InboundHaikuDrainResult = {
    scanned: 0,
    classified: 0,
    errors: 0,
    hadRows: false,
  }

  const bufferCutoff = new Date(Date.now() - BUFFER_MINUTES * 60_000).toISOString()

  const { data, error } = await supabase
    .from('interactions')
    .select('id, venue_id, full_body, subject')
    .is('haiku_classified_at', null)
    .eq('direction', 'inbound')
    .lt('created_at', bufferCutoff)
    .order('created_at', { ascending: true })
    .limit(ROWS_PER_TICK)

  if (error) {
    logEvent({
      level: 'error',
      msg: 'inbound_haiku drain query failed',
      actor: 'system',
      event_type: 'inbound_haiku.drain',
      outcome: 'fail',
      data: { error: error.message },
    })
    out.errors += 1
    return out
  }

  const rows = (data ?? []) as PendingRow[]
  out.scanned = rows.length
  out.hadRows = rows.length > 0

  if (rows.length === 0) return out

  for (let i = 0; i < rows.length; i += CONCURRENCY) {
    const batch = rows.slice(i, i + CONCURRENCY)
    const results = await Promise.allSettled(
      batch.map((row) =>
        classifyInboundInteraction({
          interactionId: row.id,
          body: row.full_body,
          subject: row.subject,
          venueId: row.venue_id,
          supabase,
        }),
      ),
    )

    for (const r of results) {
      if (r.status === 'fulfilled') {
        out.classified += 1
      } else {
        out.errors += 1
      }
    }
  }

  logEvent({
    level: 'info',
    msg: 'inbound_haiku drain tick',
    actor: 'system',
    event_type: 'inbound_haiku.drain',
    outcome: 'ok',
    data: {
      scanned: out.scanned,
      classified: out.classified,
      errors: out.errors,
    },
  })

  return out
}
