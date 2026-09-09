/**
 * Step 1 of the onboarding cleanup pipeline — reclassify interaction
 * direction from Gmail's own SENT label.
 *
 * Extracted from scripts/reclassify-direction-from-gmail.ts (kept as a
 * thin CLI wrapper). Direction + from_email must be correct before any
 * downstream cleanup step can trust them, so this always runs first.
 *
 * Re-fetches Gmail labels for every venue interaction with a
 * gmail_message_id. If the SENT label is present (or the From header
 * is a self-learned venue-owned address), direction is forced to
 * 'outbound'. Side-effect: when a row flips inbound → outbound, any
 * signal-inference engagement_events tied to it (false positives —
 * patterns matched on the venue's own marketing copy) are deleted.
 */

import type { SupabaseClient } from '@supabase/supabase-js'
import { getGmailClient } from '@/lib/services/email/gmail'
import type { CleanupStepResult } from './types'
import { emptyResult } from './types'

const FALSE_POSITIVE_EVENT_TYPES = [
  'tour_requested', 'high_specificity', 'sustained_engagement',
  'high_commitment_signal', 'tour_scheduled', 'contract_sent', 'email_reply_received',
]

function extractEmail(header: string): string {
  const m = header.match(/<([^>]+)>/)
  return ((m ? m[1] : header) ?? '').toLowerCase().trim()
}

interface GmailConnection { id: string; email_address: string }
interface Interaction {
  id: string
  gmail_message_id: string | null
  gmail_connection_id: string | null
  direction: string
  from_email: string | null
  wedding_id: string | null
}

export async function reclassifyDirectionFromGmail(
  sb: SupabaseClient,
  venueId: string,
  apply: boolean,
): Promise<CleanupStepResult> {
  const result = emptyResult('reclassify_direction', '1. Reclassify direction from Gmail labels')

  const { data: connData, error: connErr } = await sb
    .from('gmail_connections')
    .select('id, email_address')
    .eq('venue_id', venueId)
  if (connErr) {
    result.ok = false
    result.errors.push(connErr.message)
    return result
  }
  const conns = (connData ?? []) as GmailConnection[]
  if (conns.length === 0) {
    result.skipped = true
    result.skipReason = 'No gmail_connections for this venue.'
    return result
  }

  const clients = new Map<string, NonNullable<Awaited<ReturnType<typeof getGmailClient>>>>()
  for (const c of conns) {
    const client = await getGmailClient(venueId, c.id)
    if (client) clients.set(c.id, client)
  }
  if (clients.size === 0) {
    result.skipped = true
    result.skipReason = 'No usable Gmail clients (token refresh failed).'
    return result
  }

  const venueOwnSenders = new Set<string>()
  for (const c of conns) venueOwnSenders.add(c.email_address.toLowerCase().trim())
  const { data: priorOutbounds } = await sb
    .from('interactions')
    .select('from_email')
    .eq('venue_id', venueId)
    .eq('direction', 'outbound')
    .not('from_email', 'is', null)
    .limit(1000)
  for (const r of (priorOutbounds ?? []) as Array<{ from_email: string | null }>) {
    const e = (r.from_email ?? '').toLowerCase().trim()
    if (e) venueOwnSenders.add(e)
  }

  const PAGE = 200
  let from = 0
  let scanned = 0
  let directionFlipped = 0
  let fromEmailFixed = 0
  let notInGmail = 0
  let alreadyCorrect = 0
  const flippedIds: string[] = []
  const weddingsTouched = new Set<string>()
  const samples: string[] = []

  for (;;) {
    const { data, error } = await sb
      .from('interactions')
      .select('id, gmail_message_id, gmail_connection_id, direction, from_email, wedding_id')
      .eq('venue_id', venueId)
      .not('gmail_message_id', 'is', null)
      .range(from, from + PAGE - 1)
      .order('created_at', { ascending: true })
    if (error) { result.errors.push(`fetch @${from}: ${error.message}`); break }
    const rows = (data ?? []) as Interaction[]
    if (rows.length === 0) break

    for (const r of rows) {
      scanned++
      if (!r.gmail_message_id) continue

      const tryConnIds = Array.from(new Set([r.gmail_connection_id, ...conns.map((c) => c.id)].filter((v): v is string => Boolean(v))))
      let labels: string[] | null = null
      let actualFromHeader: string | null = null
      for (const cid of tryConnIds) {
        const client = clients.get(cid)
        if (!client) continue
        try {
          const msg = await client.users.messages.get({
            userId: 'me',
            id: r.gmail_message_id,
            format: 'metadata',
            metadataHeaders: ['From'],
          })
          labels = (msg.data.labelIds ?? []) as string[]
          const headers = (msg.data.payload?.headers ?? []) as Array<{ name?: string | null; value?: string | null }>
          const fromHeader = headers.find((h) => (h.name ?? '').toLowerCase() === 'from')?.value ?? ''
          actualFromHeader = fromHeader || null
          break
        } catch (err) {
          const code = (err as { code?: number })?.code
          if (code === 404) continue
          result.errors.push(`${r.id}: gmail fetch error code=${code}`)
          break
        }
      }
      if (labels === null) { notInGmail++; continue }

      const isSent = labels.some((l) => l.toUpperCase() === 'SENT')
      const realFromEmail = actualFromHeader ? extractEmail(actualFromHeader) : null
      const isVenueOwnFrom = Boolean(realFromEmail && venueOwnSenders.has(realFromEmail))
      const targetDirection = (isSent || isVenueOwnFrom) ? 'outbound' : 'inbound'

      const directionWrong = r.direction !== targetDirection
      const fromEmailWrong = Boolean(realFromEmail && r.from_email && r.from_email.toLowerCase() !== realFromEmail)

      if (!directionWrong && !fromEmailWrong) {
        alreadyCorrect++
        continue
      }

      const patch: Record<string, unknown> = {}
      if (directionWrong) {
        patch.direction = targetDirection
        directionFlipped++
        flippedIds.push(r.id)
        if (r.wedding_id) weddingsTouched.add(r.wedding_id)
        if (samples.length < 8) samples.push(`interaction ${r.id.slice(0, 8)}…: direction ${r.direction} → ${targetDirection}`)
      }
      if (fromEmailWrong && realFromEmail) {
        patch.from_email = realFromEmail
        fromEmailFixed++
      }
      if (apply) {
        const { error: updErr } = await sb.from('interactions').update(patch).eq('id', r.id)
        if (updErr) result.errors.push(`${r.id}: update failed: ${updErr.message}`)
      }
    }

    if (rows.length < PAGE) break
    from += PAGE
  }

  let falsePositivesDeleted = 0
  if (apply && flippedIds.length > 0) {
    const CHUNK = 100
    for (let i = 0; i < flippedIds.length; i += CHUNK) {
      const chunk = flippedIds.slice(i, i + CHUNK)
      const { data: badEvents } = await sb
        .from('engagement_events')
        .select('id, metadata')
        .eq('venue_id', venueId)
        .in('event_type', FALSE_POSITIVE_EVENT_TYPES)
      const eventsToDelete: string[] = []
      for (const e of (badEvents ?? []) as Array<{ id: string; metadata: { interaction_id?: string | null } | null }>) {
        const iid = e.metadata?.interaction_id
        if (iid && chunk.includes(iid)) eventsToDelete.push(e.id)
      }
      for (let j = 0; j < eventsToDelete.length; j += CHUNK) {
        const dchunk = eventsToDelete.slice(j, j + CHUNK)
        await sb.from('engagement_events').delete().in('id', dchunk)
        falsePositivesDeleted += dchunk.length
      }
    }
  }

  result.counts = {
    scanned,
    already_correct: alreadyCorrect,
    direction_flipped: directionFlipped,
    from_email_fixed: fromEmailFixed,
    not_found_in_gmail: notInGmail,
    false_positive_events_deleted: falsePositivesDeleted,
    weddings_touched: weddingsTouched.size,
  }
  result.samples = samples
  return result
}
