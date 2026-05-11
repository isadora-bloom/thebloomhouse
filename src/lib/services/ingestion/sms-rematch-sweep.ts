/**
 * Bloom House — SMS rematch sweep.
 *
 * Fans the SMS name + event-context matcher (sms-name-match.ts) over
 * every active venue's unlinked SMS rows. Runs hourly via the cron
 * dispatcher; the manual button on /agent/audio-inbox calls the same
 * function for an on-demand pass.
 *
 * Idempotent — only touches rows where person_id IS NULL OR wedding_id
 * IS NULL. Once a row is linked it skips on every subsequent pass.
 */

import { createServiceClient } from '@/lib/supabase/service'
import { tryMatchSmsByName } from './sms-name-match'

const LOOKBACK_DAYS = 90
const MAX_PER_VENUE = 200

export interface RematchVenueResult {
  venueId: string
  scanned: number
  matched: number
  updated: number
}

export interface RematchSweepResult {
  venuesProcessed: number
  totalScanned: number
  totalMatched: number
  totalUpdated: number
  perVenue: RematchVenueResult[]
}

export async function rematchSmsForVenue(
  venueId: string,
): Promise<RematchVenueResult> {
  const supabase = createServiceClient()
  const since = new Date(Date.now() - LOOKBACK_DAYS * 86_400_000).toISOString()
  const out: RematchVenueResult = { venueId, scanned: 0, matched: 0, updated: 0 }

  const { data: rows } = await supabase
    .from('interactions')
    .select('id, full_body, body_preview, from_email')
    .eq('venue_id', venueId)
    .eq('type', 'sms')
    .eq('direction', 'inbound')
    .or('person_id.is.null,wedding_id.is.null')
    .gte('timestamp', since)
    .limit(MAX_PER_VENUE)

  const list = (rows ?? []) as Array<{
    id: string
    full_body: string | null
    body_preview: string | null
    from_email: string | null
  }>

  for (const row of list) {
    out.scanned++
    const text = (row.full_body ?? row.body_preview ?? '').trim()
    if (!text) continue

    const match = await tryMatchSmsByName({
      supabase,
      venueId,
      body: text,
      fromPhone: row.from_email,
    })
    if (!match) continue
    out.matched++

    const { error } = await supabase
      .from('interactions')
      .update({ person_id: match.personId, wedding_id: match.weddingId })
      .eq('id', row.id)
    if (!error) out.updated++
  }

  return out
}

/**
 * Iterate every venue with at least one OpenPhone connection. Skip
 * venues with no SMS history.
 */
export async function rematchSmsAllVenues(): Promise<RematchSweepResult> {
  const supabase = createServiceClient()
  const out: RematchSweepResult = {
    venuesProcessed: 0,
    totalScanned: 0,
    totalMatched: 0,
    totalUpdated: 0,
    perVenue: [],
  }

  // Cheap proxy for "venues that might have SMS" — anyone with an
  // openphone_connections row. We could also pull from the interactions
  // table but the connections list is smaller.
  const { data: connections } = await supabase
    .from('openphone_connections')
    .select('venue_id')
    .eq('is_active', true)

  const venueIds = Array.from(
    new Set(((connections ?? []) as Array<{ venue_id: string }>).map((c) => c.venue_id)),
  )

  for (const venueId of venueIds) {
    const result = await rematchSmsForVenue(venueId)
    out.venuesProcessed++
    out.totalScanned += result.scanned
    out.totalMatched += result.matched
    out.totalUpdated += result.updated
    out.perVenue.push(result)
  }

  return out
}
