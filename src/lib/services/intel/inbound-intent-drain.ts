/**
 * Bloom House — Inbound intent drain (cron safety net).
 *
 * Mirror of inbound-haiku-drain.ts. Drains the partial index
 * idx_interactions_intent_pending — inbound interactions where
 * intent_classified_at IS NULL.
 *
 * Two roles:
 *   1. Safety net for the fire-and-forget intent classifier wired into
 *      the email pipeline / openphone / zoom. If a Vercel function
 *      tears down before the detached promise lands, this catches the
 *      row on the next tick.
 *   2. Historical backfill — every inbound row that landed before mig
 *      327 (and every row whose fire-and-forget missed) has
 *      intent_classified_at IS NULL and will be picked up here.
 *
 * Bounds
 * ------
 *   - 50 rows per tick (cap on the SELECT).
 *   - Concurrency = 5 inside the worker via Promise.allSettled batches.
 *   - 5-minute buffer (created_at < now() - interval '5 minutes') so
 *     freshly-inserted rows get a chance via the synchronous fire-and-
 *     forget path before the cron touches them.
 *
 * Channel hint: derived from interactions.type so the classifier prompt
 * gets the right context per row.
 *
 * Cost ~$0.0003/row. Rixey historical tail of ~12k inbound rows ~$3.60.
 */

import { createServiceClient } from '@/lib/supabase/service'
import { classifyInboundIntent } from './inbound-intent-classifier'
import { logEvent } from '@/lib/observability/logger'

const ROWS_PER_TICK = 50
const CONCURRENCY = 5
const BUFFER_MINUTES = 5

export interface InboundIntentDrainResult {
  scanned: number
  classified: number
  errors: number
  hadRows: boolean
}

interface PendingRow {
  id: string
  venue_id: string
  type: string | null
  full_body: string | null
  subject: string | null
  from_email: string | null
}

function channelFromType(t: string | null): 'email' | 'sms' | 'call' | 'voicemail' | 'meeting' | 'brain_dump' | 'web_form' | 'other' {
  switch (t) {
    case 'email': return 'email'
    case 'sms': return 'sms'
    case 'call':
    case 'call_summary': return 'call'
    case 'voicemail': return 'voicemail'
    case 'meeting': return 'meeting'
    case 'web_form': return 'web_form'
    default: return 'other'
  }
}

/**
 * One drain tick. NEVER throws.
 */
export async function runInboundIntentDrain(): Promise<InboundIntentDrainResult> {
  const supabase = createServiceClient()
  const out: InboundIntentDrainResult = {
    scanned: 0,
    classified: 0,
    errors: 0,
    hadRows: false,
  }

  const bufferCutoff = new Date(Date.now() - BUFFER_MINUTES * 60_000).toISOString()

  const { data, error } = await supabase
    .from('interactions')
    .select('id, venue_id, type, full_body, subject, from_email')
    .is('intent_classified_at', null)
    .eq('direction', 'inbound')
    .lt('created_at', bufferCutoff)
    .order('created_at', { ascending: true })
    .limit(ROWS_PER_TICK)

  if (error) {
    logEvent({
      level: 'error',
      msg: 'inbound_intent drain query failed',
      actor: 'system',
      event_type: 'inbound_intent.drain',
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
        classifyInboundIntent({
          interactionId: row.id,
          body: row.full_body,
          subject: row.subject,
          venueId: row.venue_id,
          channel: channelFromType(row.type),
          fromEmail: row.from_email,
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
    msg: 'inbound_intent drain tick',
    actor: 'system',
    event_type: 'inbound_intent.drain',
    outcome: 'ok',
    data: {
      scanned: out.scanned,
      classified: out.classified,
      errors: out.errors,
    },
  })

  return out
}
