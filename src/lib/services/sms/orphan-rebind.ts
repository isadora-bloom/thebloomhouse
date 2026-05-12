/**
 * SMS orphan engagement-event rebinder.
 *
 * Class-of-problem: an inbound SMS persists fast (interactions + dedup
 * row), but the heat-event fire is paged through `recordEngagementEvent`
 * which gates on `weddingId`. When the SMS arrives a microsecond before
 * the per-couple wedding row resolves (identity-resolver race, or a
 * wedding minted in a later step of the same tick), the engagement_event
 * lands with `wedding_id = NULL` and never contributes to the heat
 * score. The read-side filter in recalculateHeatScore matches on
 * wedding_id, so an orphan event is invisible forever.
 *
 * Live case (Justin & Sandy at Rixey, RM-1139): 14 inbound SMS, heat = 0,
 * because every SMS-driven engagement_event landed orphan during the
 * lead's first 48 hours.
 *
 * This rebinder walks orphan rows whose metadata carries either:
 *   • metadata.interaction_id  — the interactions row id minted at SMS
 *     persist time. If that interaction has been linked to a wedding
 *     (sync wedding_id update on the resolver step, or async name-match
 *     sweep), we promote the wedding_id to the event.
 *   • metadata.openphone_message_id — the OpenPhone message id. Maps to
 *     the dedup row in processed_sms_messages, but the canonical link is
 *     via the interaction that points to the same processed message. We
 *     resolve by joining through interactions on the same message id (if
 *     the schema stores it) or by date+sender.
 *
 * Idempotent. Safe to re-run. Fire-and-forget engagement_events update;
 * recalculateHeatScore call is sequenced AFTER the bulk rebind so each
 * affected wedding gets exactly one recompute regardless of how many
 * orphan events it had.
 *
 * 2026-05-12 / mig 313.
 */

import type { SupabaseClient } from '@supabase/supabase-js'
import { recalculateHeatScore } from '@/lib/services/heat-mapping'
import { logEvent } from '@/lib/observability/logger'

interface OrphanRow {
  id: string
  venue_id: string
  metadata: Record<string, unknown> | null
}

export interface OrphanRebindResult {
  rebound: number
  recomputed: number
  skipped: number
}

/**
 * Rebind orphan engagement_events to their now-resolvable wedding rows
 * and recompute heat for each affected wedding exactly once.
 */
export async function rebindOrphanEngagementEvents(
  supabase: SupabaseClient,
): Promise<OrphanRebindResult> {
  const startedAt = Date.now()

  // Pull a bounded batch of orphans. 1000/tick is well above the steady-
  // state arrival rate (a Rixey-sized venue produces ~10s of orphans/day
  // at worst; even a backlog clears in a few ticks). The partial index
  // from migration 313 (engagement_events_orphan_wedding_idx) makes this
  // a cheap scan.
  const { data: rows, error } = await supabase
    .from('engagement_events')
    .select('id, venue_id, metadata')
    .is('wedding_id', null)
    .order('created_at', { ascending: true })
    .limit(1000)

  if (error) {
    logEvent({
      level: 'error',
      msg: 'orphan_engagement_rebind_fetch_failed',
      event_type: 'sms.orphan_rebind',
      outcome: 'fail',
      data: { error: error.message },
    })
    return { rebound: 0, recomputed: 0, skipped: 0 }
  }

  const orphans = (rows ?? []) as OrphanRow[]
  if (orphans.length === 0) {
    return { rebound: 0, recomputed: 0, skipped: 0 }
  }

  // Bucket orphans by candidate interaction_id (preferred) or openphone
  // message id (fallback). The fallback path joins through
  // processed_sms_messages → interactions; if no interaction was minted
  // (truly orphan engagement event with no inbox surface), we skip.
  const interactionIds = new Set<string>()
  const messageIds = new Set<string>()
  for (const o of orphans) {
    const meta = o.metadata ?? {}
    const ix = typeof meta.interaction_id === 'string' ? meta.interaction_id : null
    const mid =
      typeof meta.openphone_message_id === 'string' ? meta.openphone_message_id : null
    if (ix) interactionIds.add(ix)
    else if (mid) messageIds.add(mid)
  }

  // Build a (interaction_id → wedding_id) map by fetching the joined
  // interactions in one batch. Filtering by venue_id is not needed at
  // this step — the orphan row's venue_id is the source of truth for the
  // recompute call; an interaction with a different venue_id would
  // indicate a deeper corruption that this sweep is not responsible for
  // repairing (data-integrity invariant covers that class).
  const interactionMap = new Map<string, { wedding_id: string | null; venue_id: string }>()
  if (interactionIds.size > 0) {
    const { data: ix } = await supabase
      .from('interactions')
      .select('id, wedding_id, venue_id')
      .in('id', Array.from(interactionIds))
    for (const r of ix ?? []) {
      interactionMap.set(r.id as string, {
        wedding_id: (r.wedding_id as string | null) ?? null,
        venue_id: r.venue_id as string,
      })
    }
  }

  // For openphone-message-id-only orphans, look up the matching
  // interaction row. The Wave 28 ingest path stores no message_id on
  // interactions directly (it lives on processed_sms_messages). Use that
  // table as the bridge: openphone_message_id → from_number/to_number +
  // occurred_at → interaction row by (venue_id, type='sms', timestamp).
  // Keep this path conservative — only rebind when the dedup row has a
  // wedding_id-bearing interaction inside ±30s of the message timestamp.
  const messageMap = new Map<string, { wedding_id: string | null; venue_id: string }>()
  if (messageIds.size > 0) {
    const { data: dedup } = await supabase
      .from('processed_sms_messages')
      .select('venue_id, openphone_message_id, from_number, to_number, occurred_at')
      .in('openphone_message_id', Array.from(messageIds))
    for (const m of dedup ?? []) {
      const venueId = m.venue_id as string
      const occurred = m.occurred_at as string | null
      if (!occurred) continue
      const occMs = new Date(occurred).getTime()
      if (!Number.isFinite(occMs)) continue
      const phone = (m.from_number as string | null) ?? (m.to_number as string | null)
      if (!phone) continue
      // Match the corresponding interaction row by venue + sms + ±30s
      // around occurred_at + matching phone surface (we stored the phone
      // in interactions.from_email). One row in practice.
      const lo = new Date(occMs - 30_000).toISOString()
      const hi = new Date(occMs + 30_000).toISOString()
      const { data: ix } = await supabase
        .from('interactions')
        .select('id, wedding_id, venue_id, from_email')
        .eq('venue_id', venueId)
        .eq('type', 'sms')
        .gte('timestamp', lo)
        .lte('timestamp', hi)
        .limit(5)
      const match = (ix ?? []).find((r) => (r.from_email as string | null) === phone)
      if (match) {
        messageMap.set(m.openphone_message_id as string, {
          wedding_id: (match.wedding_id as string | null) ?? null,
          venue_id: match.venue_id as string,
        })
      }
    }
  }

  // Walk orphans + apply updates. Collect (venue, wedding) pairs for the
  // post-rebind recompute pass so each wedding scores recompute once.
  const recomputeKeys = new Set<string>()
  let rebound = 0
  let skipped = 0

  for (const o of orphans) {
    const meta = o.metadata ?? {}
    const ix = typeof meta.interaction_id === 'string' ? meta.interaction_id : null
    const mid =
      typeof meta.openphone_message_id === 'string' ? meta.openphone_message_id : null

    let resolved: { wedding_id: string | null; venue_id: string } | undefined
    if (ix) resolved = interactionMap.get(ix)
    else if (mid) resolved = messageMap.get(mid)

    if (!resolved || !resolved.wedding_id) {
      skipped++
      continue
    }

    const { error: updErr } = await supabase
      .from('engagement_events')
      .update({ wedding_id: resolved.wedding_id })
      .eq('id', o.id)

    if (updErr) {
      skipped++
      logEvent({
        level: 'warn',
        msg: 'orphan_engagement_rebind_update_failed',
        venueId: o.venue_id,
        event_type: 'sms.orphan_rebind',
        outcome: 'fail',
        data: { engagement_event_id: o.id, error: updErr.message },
      })
      continue
    }
    rebound++
    recomputeKeys.add(`${o.venue_id}::${resolved.wedding_id}`)
  }

  // Sequence recompute AFTER bulk update so a wedding with 14 orphan
  // events gets exactly one heat_score recompute. Failures here don't
  // unwind the rebind — the next daily tick + manual recompute path
  // will retry.
  let recomputed = 0
  for (const key of recomputeKeys) {
    const [venueId, weddingId] = key.split('::')
    try {
      await recalculateHeatScore(venueId, weddingId)
      recomputed++
    } catch (err) {
      logEvent({
        level: 'warn',
        msg: 'orphan_engagement_rebind_recompute_failed',
        venueId,
        event_type: 'sms.orphan_rebind',
        outcome: 'fail',
        data: { wedding_id: weddingId, error: err instanceof Error ? err.message : String(err) },
      })
    }
  }

  logEvent({
    level: 'info',
    msg: 'orphan_engagement_rebind_complete',
    event_type: 'sms.orphan_rebind',
    outcome: 'ok',
    latency_ms: Date.now() - startedAt,
    data: { rebound, recomputed, skipped, scanned: orphans.length },
  })

  return { rebound, recomputed, skipped }
}
