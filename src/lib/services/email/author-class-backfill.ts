/**
 * Bloom House — Wave 27 author-class backfill.
 *
 * Anchor docs:
 *   - bloom-constitution.md (forensic record; historical interactions
 *     must carry the same author_class dimension as new ones)
 *   - bloom-data-integrity-sweep.md (idempotent reclassification
 *     pattern — re-runs converge, never diverge)
 *
 * What this service does
 * ----------------------
 * Drains the migration-293 pending index — inbound interactions with
 * author_class='unknown'. Per-venue, batched, idempotent. Outbound
 * rows were synchronously backfilled by migration 293 (operator / sage
 * via drafts.auto_sent linkage) so this only touches inbound.
 *
 * Triggered by the cron route ('author_class_backfill'). Each tick:
 *   - Iterates active venues
 *   - For each venue, pulls up to MAX_PER_VENUE inbound 'unknown' rows
 *   - Classifies in BATCH_SIZE-sized parallel groups
 *   - Per-row update is handled inside classifyAuthor (writes
 *     author_class + prompt_version + decided_at when persisted)
 *
 * Cost estimate
 * -------------
 * ~$0.0003/email × ~12,000 rows for a Rixey-sized historical tail =
 * ~$3.60 per full backfill. Capped per-tick so the cron stays fast
 * and degraded-Anthropic incidents don't burn the whole queue.
 */

import { createServiceClient } from '@/lib/supabase/service'
import { classifyAuthor } from './author-classifier'
import { logEvent } from '@/lib/observability/logger'

const BATCH_SIZE = 50
const DEFAULT_MAX_PER_VENUE = 500

export interface BackfillVenueResult {
  venueId: string
  scanned: number
  classified: number
  errors: number
}

export interface BackfillRunResult {
  venuesProcessed: number
  totalScanned: number
  totalClassified: number
  totalErrors: number
  perVenue: BackfillVenueResult[]
}

interface InteractionRow {
  id: string
  venue_id: string
  from_email: string | null
  from_name: string | null
  subject: string | null
  full_body: string | null
  extracted_identity: Record<string, unknown> | null
}

/**
 * Classify a chunk of inbound 'unknown' rows for a single venue.
 * Idempotent and bounded — pass maxRows to cap the work per call.
 */
export async function runAuthorClassBackfillForVenue(
  venueId: string,
  maxRows: number = DEFAULT_MAX_PER_VENUE,
): Promise<BackfillVenueResult> {
  const supabase = createServiceClient()
  const out: BackfillVenueResult = {
    venueId,
    scanned: 0,
    classified: 0,
    errors: 0,
  }

  // Pending index is partial: (venue_id, author_class) WHERE
  // author_class='unknown' AND direction='inbound' (mig 293). The
  // explicit direction filter belt-and-suspenders the index predicate.
  const { data, error } = await supabase
    .from('interactions')
    .select('id, venue_id, from_email, from_name, subject, full_body, extracted_identity')
    .eq('venue_id', venueId)
    .eq('direction', 'inbound')
    .eq('author_class', 'unknown')
    .order('timestamp', { ascending: false })
    .limit(maxRows)

  if (error) {
    logEvent({
      level: 'warn',
      msg: 'author_class backfill query failed',
      venueId,
      actor: 'system',
      event_type: 'author_class.backfill',
      outcome: 'fail',
      data: { error: error.message },
    })
    out.errors += 1
    return out
  }

  const rows = (data ?? []) as InteractionRow[]
  out.scanned = rows.length

  if (rows.length === 0) return out

  for (let i = 0; i < rows.length; i += BATCH_SIZE) {
    const batch = rows.slice(i, i + BATCH_SIZE)
    const results = await Promise.allSettled(
      batch.map((row) =>
        classifyAuthor({
          venueId,
          interactionId: row.id,
          from_email: row.from_email,
          from_name: row.from_name,
          subject: row.subject,
          body: row.full_body ?? '',
          extracted_identity: row.extracted_identity,
        }),
      ),
    )

    for (const r of results) {
      if (r.status === 'fulfilled') {
        // classifyAuthor swallows persist failures and falls back to
        // 'unknown' — count those as errors so the cron output is honest.
        if (r.value.author_class === 'unknown') {
          out.errors += 1
        } else {
          out.classified += 1
        }
      } else {
        out.errors += 1
      }
    }
  }

  logEvent({
    level: 'info',
    msg: 'author_class backfill venue tick',
    venueId,
    actor: 'system',
    event_type: 'author_class.backfill',
    outcome: 'ok',
    data: {
      scanned: out.scanned,
      classified: out.classified,
      errors: out.errors,
    },
  })

  return out
}

/**
 * Sweep every active venue with at least one pending 'unknown' inbound.
 * The cron handler calls this; ops can also POST it via the cron route.
 */
export async function runAuthorClassBackfill(): Promise<BackfillRunResult> {
  const supabase = createServiceClient()
  const overall: BackfillRunResult = {
    venuesProcessed: 0,
    totalScanned: 0,
    totalClassified: 0,
    totalErrors: 0,
    perVenue: [],
  }

  const { data, error } = await supabase
    .from('interactions')
    .select('venue_id')
    .eq('direction', 'inbound')
    .eq('author_class', 'unknown')
    .limit(10_000)

  if (error) {
    logEvent({
      level: 'error',
      msg: 'author_class backfill venue scan failed',
      actor: 'system',
      event_type: 'author_class.backfill',
      outcome: 'fail',
      data: { error: error.message },
    })
    return overall
  }

  const venueIds = new Set<string>()
  for (const r of (data ?? []) as Array<{ venue_id: string | null }>) {
    if (r.venue_id) venueIds.add(r.venue_id)
  }

  for (const venueId of venueIds) {
    const result = await runAuthorClassBackfillForVenue(venueId)
    overall.perVenue.push(result)
    overall.venuesProcessed += 1
    overall.totalScanned += result.scanned
    overall.totalClassified += result.classified
    overall.totalErrors += result.errors
  }

  return overall
}
