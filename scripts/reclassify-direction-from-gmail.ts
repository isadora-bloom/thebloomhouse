// Re-fetch Gmail labels for every venue interaction with a
// gmail_message_id and re-classify direction based on the SENT
// label. This is the data-side counterpart to the email-pipeline
// fix in b08c0d4 — for the historical pile of rows that were
// inserted before the SENT-label check existed.
//
// What it does per row:
//   1. Fetch labelIds from Gmail for the message
//   2. If SENT label is present → ensure direction='outbound'
//   3. If from_email differs from the actual From header → fix it
//
// Idempotent. Already-correct rows skip silently.
//
// Side-effect cleanup: when a row flips inbound → outbound, any
// engagement_events that signal-inference fired with that row's
// interaction_id (false positives — patterns matched on Sage's own
// marketing copy) are deleted, and the wedding's heat score is
// recomputed.
//
// Usage:
//   npx tsx scripts/reclassify-direction-from-gmail.ts
//   npx tsx scripts/reclassify-direction-from-gmail.ts --apply
//   npx tsx scripts/reclassify-direction-from-gmail.ts --apply --venue <uuid>
import { createClient } from '@supabase/supabase-js'
import { readFileSync } from 'node:fs'
import { getGmailClient } from '../src/lib/services/gmail'

const env = Object.fromEntries(
  readFileSync('.env.local', 'utf8')
    .split('\n')
    .filter((l) => l && !l.startsWith('#') && l.includes('='))
    .map((l) => {
      const i = l.indexOf('=')
      return [l.slice(0, i).trim(), l.slice(i + 1).trim().replace(/^['"]|['"]$/g, '')]
    }),
)
for (const k of Object.keys(env)) if (!process.env[k]) process.env[k] = env[k]

const sb = createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, {
  auth: { persistSession: false },
})

const args = process.argv.slice(2)
const apply = args.includes('--apply')
const venueIdx = args.indexOf('--venue')
const venueId = venueIdx >= 0 ? args[venueIdx + 1] : 'f3d10226-4c5c-47ad-b89b-98ad63842492'

interface GmailConnection {
  id: string
  email_address: string
}

async function loadConnections(): Promise<GmailConnection[]> {
  const { data } = await sb
    .from('gmail_connections')
    .select('id, email_address')
    .eq('venue_id', venueId)
  return (data ?? []) as GmailConnection[]
}

function extractEmail(header: string): string {
  const m = header.match(/<([^>]+)>/)
  return ((m ? m[1] : header) ?? '').toLowerCase().trim()
}

interface Interaction {
  id: string
  gmail_message_id: string | null
  gmail_connection_id: string | null
  direction: string
  from_email: string | null
  wedding_id: string | null
}

async function main() {
  console.log(`\n=== Reclassify direction from Gmail labels — venue ${venueId} ${apply ? '(apply)' : '(dry-run)'} ===\n`)

  const conns = await loadConnections()
  if (conns.length === 0) {
    console.error('No gmail_connections for this venue. Aborting.')
    process.exit(1)
  }
  console.log(`gmail connections: ${conns.length}`)
  // Use the production getGmailClient so we get its token-refresh
  // logic — raw OAuth2 with stale tokens 401s for every fetch.
  const clients = new Map<string, NonNullable<Awaited<ReturnType<typeof getGmailClient>>>>()
  for (const c of conns) {
    const client = await getGmailClient(venueId, c.id)
    if (client) clients.set(c.id, client)
  }
  if (clients.size === 0) {
    console.error('No usable Gmail clients (token refresh failed?). Aborting.')
    process.exit(1)
  }

  // Self-learned set of venue-owned sender addresses from the rows
  // already classified as outbound. Used as a fallback when Gmail
  // doesn't tag a message SENT but the From is clearly venue-owned.
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
  console.log(`venue-own senders (from connections + prior outbounds): ${venueOwnSenders.size}`)

  const PAGE = 200
  let from = 0
  let scanned = 0
  let directionFlipped = 0
  let fromEmailFixed = 0
  let notInGmail = 0
  let alreadyCorrect = 0
  const flippedIds: string[] = []
  const weddingsTouched = new Set<string>()

  for (;;) {
    const { data, error } = await sb
      .from('interactions')
      .select('id, gmail_message_id, gmail_connection_id, direction, from_email, wedding_id')
      .eq('venue_id', venueId)
      .not('gmail_message_id', 'is', null)
      .range(from, from + PAGE - 1)
      .order('created_at', { ascending: true })
    if (error) { console.error(`fetch @${from}: ${error.message}`); break }
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
          // Non-404 → log and stop trying this row
          console.warn(`  ${r.id}: gmail fetch error code=${code}`)
          break
        }
      }
      if (labels === null) { notInGmail++; continue }

      const isSent = labels.some((l) => l.toUpperCase() === 'SENT')
      // Some Gmail edge cases (send-mail-as, forwarding rules,
      // calendar self-invites) produce messages whose From header is
      // a venue-owned address but which Gmail labels as INBOX, not
      // SENT. Treat these as outbound regardless — the customer
      // never sent it. Venue-owned set is built from the from_email
      // values we've already classified as outbound elsewhere
      // (self-learning), so this only fires once at least one true
      // outbound has been recorded for the venue.
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
      }
      if (fromEmailWrong && realFromEmail) {
        patch.from_email = realFromEmail
        fromEmailFixed++
      }
      if (apply) {
        const { error: updErr } = await sb.from('interactions').update(patch).eq('id', r.id)
        if (updErr) console.error(`  ${r.id}: update failed: ${updErr.message}`)
      }
    }

    if (rows.length < PAGE) break
    from += PAGE
  }

  console.log(`scanned:                ${scanned}`)
  console.log(`already correct:        ${alreadyCorrect}`)
  console.log(`direction flipped:      ${directionFlipped}`)
  console.log(`from_email fixed:       ${fromEmailFixed}`)
  console.log(`not found in gmail:     ${notInGmail}`)

  // Side-effect cleanup: delete signal-inference engagement events
  // tied to interactions that just flipped to outbound. These are
  // false positives (Sage's marketing copy matched tour_request /
  // high_specificity / etc patterns).
  if (apply && flippedIds.length > 0) {
    console.log(`\nCleaning up false-positive engagement events for ${flippedIds.length} flipped interactions...`)
    const CHUNK = 100
    let deleted = 0
    for (let i = 0; i < flippedIds.length; i += CHUNK) {
      const chunk = flippedIds.slice(i, i + CHUNK)
      const { data: badEvents } = await sb
        .from('engagement_events')
        .select('id, metadata')
        .eq('venue_id', venueId)
        .in('event_type', ['tour_requested', 'high_specificity', 'sustained_engagement', 'high_commitment_signal', 'tour_scheduled', 'contract_sent', 'email_reply_received'])
      const eventsToDelete: string[] = []
      for (const e of (badEvents ?? []) as Array<{ id: string; metadata: { interaction_id?: string | null } | null }>) {
        const iid = e.metadata?.interaction_id
        if (iid && chunk.includes(iid)) eventsToDelete.push(e.id)
      }
      if (eventsToDelete.length > 0) {
        for (let j = 0; j < eventsToDelete.length; j += CHUNK) {
          const dchunk = eventsToDelete.slice(j, j + CHUNK)
          await sb.from('engagement_events').delete().in('id', dchunk)
          deleted += dchunk.length
        }
      }
    }
    console.log(`deleted false-positive engagement events: ${deleted}`)
    console.log(`weddings touched (will need heat recompute): ${weddingsTouched.size}`)
  }
  if (!apply && (directionFlipped > 0 || fromEmailFixed > 0)) {
    console.log(`\nDry-run complete. Re-run with --apply to write.`)
  }
}

main().catch((err) => { console.error(err); process.exit(1) })
