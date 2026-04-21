import { NextResponse } from 'next/server'
import { getPlatformAuth } from '@/lib/api/auth-helpers'
import { createServiceClient } from '@/lib/supabase/service'
import { getGmailClient, getConnections } from '@/lib/services/gmail'
import {
  extractEmailAddress,
  extractName,
  findOrCreateContact,
} from '@/lib/services/email-pipeline'

// ---------------------------------------------------------------------------
// POST /api/agent/backfill-senders
//
// Recovers sender identity on historical interactions that were inserted
// before migration 063 + the findOrCreateContact fix. For every inbound
// email with a gmail_message_id but no from_email / person_id, we
// re-fetch the message headers from Gmail, populate from_email /
// from_name, and upsert a person via findOrCreateContact.
//
// Chunked: processes up to ?limit= rows per call (default 50, max 200).
// Call repeatedly until `remaining` is 0. Safe to re-run.
// ---------------------------------------------------------------------------

type GmailHeader = { name: string; value: string }

function getHeader(headers: GmailHeader[], name: string): string {
  const h = headers.find((x) => x.name?.toLowerCase() === name.toLowerCase())
  return h?.value ?? ''
}

export async function POST(req: Request) {
  const auth = await getPlatformAuth()
  if (!auth) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const url = new URL(req.url)
  const rawLimit = Number(url.searchParams.get('limit') ?? '50')
  const limit = Math.max(1, Math.min(200, Number.isFinite(rawLimit) ? rawLimit : 50))

  const venueId = auth.venueId
  if (!venueId) {
    return NextResponse.json({ error: 'No venue in scope' }, { status: 400 })
  }

  const supabase = createServiceClient()

  // Fetch candidates: inbound emails missing sender attribution.
  const { data: candidates, error: candidatesError } = await supabase
    .from('interactions')
    .select('id, gmail_message_id, gmail_connection_id, from_email, from_name, person_id')
    .eq('venue_id', venueId)
    .eq('type', 'email')
    .eq('direction', 'inbound')
    .not('gmail_message_id', 'is', null)
    .or('from_email.is.null,person_id.is.null')
    .order('timestamp', { ascending: false })
    .limit(limit)

  if (candidatesError) {
    return NextResponse.json({ error: candidatesError.message }, { status: 500 })
  }

  if (!candidates || candidates.length === 0) {
    return NextResponse.json({ processed: 0, remaining: 0, updated: 0, failed: 0, missing: 0 })
  }

  // Pre-load all connections for this venue so we can retry a different one
  // when a message isn't in the primary inbox.
  const connections = await getConnections(venueId)
  const connectionIds = [null, ...connections.map((c) => c.id)] // null = legacy/default

  // Build a cache of gmail clients keyed by connectionId-or-null so we only
  // refresh tokens once per connection per request.
  const clientCache = new Map<string, Awaited<ReturnType<typeof getGmailClient>>>()
  async function clientFor(connectionId: string | null) {
    const key = connectionId ?? '__default__'
    if (clientCache.has(key)) return clientCache.get(key) ?? null
    const client = await getGmailClient(venueId, connectionId ?? undefined)
    clientCache.set(key, client)
    return client
  }

  let updated = 0
  let failed = 0
  let missing = 0

  for (const row of candidates) {
    const messageId = row.gmail_message_id as string | null
    if (!messageId) continue

    // Try the row's stored connection first, then every other connection,
    // then the legacy default. Stop on the first successful fetch.
    const tryOrder = Array.from(
      new Set<string | null>([
        (row.gmail_connection_id as string | null) ?? null,
        ...connectionIds,
      ])
    )

    let fromHeader = ''
    let fetched = false

    for (const connId of tryOrder) {
      try {
        const gmail = await clientFor(connId)
        if (!gmail) continue

        const msg = await gmail.users.messages.get({
          userId: 'me',
          id: messageId,
          format: 'metadata',
          metadataHeaders: ['From', 'To'],
        })
        const headers = (msg.data.payload?.headers ?? []) as GmailHeader[]
        fromHeader = getHeader(headers, 'From')
        fetched = true
        break
      } catch (err: unknown) {
        const code = (err as { code?: number })?.code
        if (code === 404) {
          // Message not in this mailbox — try the next connection.
          continue
        }
        // Other errors (rate limit, network) bubble up as a failure.
        console.error(`[backfill-senders] gmail fetch failed for ${messageId}:`, err)
        break
      }
    }

    if (!fetched) {
      missing++
      continue
    }

    if (!fromHeader) {
      failed++
      continue
    }

    const fromEmail = extractEmailAddress(fromHeader)
    const fromName = extractName(fromHeader)

    // Upsert the person and link it. Reuse the canonical pipeline helper so
    // this recovery path and the live pipeline stay in lockstep.
    const { personId } = await findOrCreateContact(venueId, fromEmail, fromName)

    const patch: Record<string, unknown> = {
      from_email: fromEmail,
      from_name: fromName,
    }
    if (personId && !row.person_id) {
      patch.person_id = personId
    }

    const { error: updateError } = await supabase
      .from('interactions')
      .update(patch)
      .eq('id', row.id)

    if (updateError) {
      console.error(`[backfill-senders] update failed for ${row.id}:`, updateError.message)
      failed++
    } else {
      updated++
    }
  }

  // How many remain after this batch?
  const { count: remaining } = await supabase
    .from('interactions')
    .select('id', { count: 'exact', head: true })
    .eq('venue_id', venueId)
    .eq('type', 'email')
    .eq('direction', 'inbound')
    .not('gmail_message_id', 'is', null)
    .or('from_email.is.null,person_id.is.null')

  return NextResponse.json({
    processed: candidates.length,
    updated,
    failed,
    missing,
    remaining: remaining ?? 0,
  })
}
