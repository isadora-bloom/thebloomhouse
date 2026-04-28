/**
 * Bloom House: OpenPhone (Quo) Service
 *
 * Polls OpenPhone for inbound/outbound SMS, voicemails, and call summaries
 * and lands them in the same `interactions` table that Gmail emails feed
 * into — so coordinator-side phone activity shows up in the Agent inbox
 * alongside email.
 *
 * The OpenPhone API uses a raw API key in the Authorization header
 * (NOT `Bearer <key>`).
 *
 * Schema notes:
 *   openphone_connections   one row per venue (UNIQUE on venue_id) — api_key,
 *                           phone_numbers (jsonb array), last_synced_at.
 *   processed_sms_messages  dedup log keyed on (venue_id, openphone_message_id).
 *
 * The interactions table (migration 002, 063) doesn't have `from_phone`.
 * We store the E.164 number in `from_email` (which is the canonical "who
 * sent this" surface in the inbox) and persist the structured number in
 * `processed_sms_messages.from_number` for retrieval. The `type` column's
 * CHECK constraint allows 'sms' | 'voicemail' | 'call'; we map
 * 'call_summary' → 'call' for the interactions row but keep
 * 'call_summary' as the channel value in processed_sms_messages.
 */

import { createServiceClient } from '@/lib/supabase/service'

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const OPENPHONE_API_BASE = 'https://api.openphone.com/v1'
const DEFAULT_SINCE_HOURS = 24

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface OpenPhoneConnection {
  id: string
  venue_id: string
  api_key: string
  phone_numbers: OpenPhonePhoneNumber[]
  workspace_label: string | null
  is_active: boolean
  last_synced_at: string | null
  created_at: string
  updated_at: string
}

export interface OpenPhonePhoneNumber {
  /** OpenPhone's internal phone number id, e.g. "PN123abc..." */
  id: string
  /** E.164-ish phone number string, e.g. "+15551234567" */
  phoneNumber: string
  /** Display label set in OpenPhone */
  name?: string | null
  /** Local toggle — coordinator can opt-out a personal cell */
  enabled?: boolean
}

export interface SyncResult {
  inserted: number
  skipped: number
  errors: string[]
  byChannel: { sms: number; voicemail: number; call_summary: number }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function normalizePhone(phone: string | null | undefined): string | null {
  if (!phone) return null
  const digits = phone.replace(/\D/g, '')
  if (digits.length === 11 && digits.startsWith('1')) return digits.slice(1)
  if (digits.length === 10) return digits
  return digits.slice(-10) || null
}

async function openPhoneFetch(
  apiKey: string,
  path: string,
  params?: Record<string, string | undefined>
): Promise<unknown> {
  const qs = new URLSearchParams()
  if (params) {
    for (const [k, v] of Object.entries(params)) {
      if (v != null && v !== '') qs.set(k, v)
    }
  }
  const url = `${OPENPHONE_API_BASE}${path}${qs.toString() ? `?${qs.toString()}` : ''}`
  const res = await fetch(url, {
    method: 'GET',
    // Raw key — OpenPhone does NOT use `Bearer`.
    headers: { Authorization: apiKey, 'Content-Type': 'application/json' },
    cache: 'no-store',
  })
  if (!res.ok) {
    const text = await res.text().catch(() => '')
    if (res.status === 401 || res.status === 403) {
      throw new Error(
        `OpenPhone authentication failed (${res.status}). The API key in openphone_connections may be invalid or revoked. ${text}`
      )
    }
    if (res.status === 404) {
      // Some accounts don't have voicemails / call-summaries enabled. Treat
      // 404 as "endpoint unavailable for this workspace" upstream.
      const err = new Error(`OpenPhone ${path} returned 404`)
      ;(err as Error & { code?: number }).code = 404
      throw err
    }
    throw new Error(`OpenPhone ${path} failed (${res.status}): ${text || res.statusText}`)
  }
  return res.json()
}

function unwrapList<T>(payload: unknown): T[] {
  if (!payload) return []
  if (Array.isArray(payload)) return payload as T[]
  const obj = payload as Record<string, unknown>
  if (Array.isArray(obj.data)) return obj.data as T[]
  if (Array.isArray(obj.messages)) return obj.messages as T[]
  if (Array.isArray(obj.calls)) return obj.calls as T[]
  if (Array.isArray(obj.voicemails)) return obj.voicemails as T[]
  if (Array.isArray(obj.phoneNumbers)) return obj.phoneNumbers as T[]
  if (Array.isArray(obj.callSummaries)) return obj.callSummaries as T[]
  if (Array.isArray(obj.results)) return obj.results as T[]
  return []
}

// ---------------------------------------------------------------------------
// Connection lookup
// ---------------------------------------------------------------------------

/**
 * Read the openphone_connections row for a venue. Throws a clear error if
 * no connection exists or the row is inactive. Use getConnectionMaybe()
 * for soft lookup paths (e.g. cron iteration).
 */
export async function getConnection(venueId: string): Promise<OpenPhoneConnection> {
  const conn = await getConnectionMaybe(venueId)
  if (!conn) {
    throw new Error(
      `OpenPhone is not configured for venue ${venueId}. Add an API key at /settings/openphone first.`
    )
  }
  if (!conn.is_active) {
    throw new Error(
      `OpenPhone connection for venue ${venueId} is inactive. Re-enable it at /settings/openphone.`
    )
  }
  if (!conn.api_key || !conn.api_key.trim()) {
    throw new Error(
      `OpenPhone connection for venue ${venueId} has an empty API key. Re-paste the key at /settings/openphone.`
    )
  }
  return conn
}

export async function getConnectionMaybe(
  venueId: string
): Promise<OpenPhoneConnection | null> {
  const supabase = createServiceClient()
  const { data, error } = await supabase
    .from('openphone_connections')
    .select('*')
    .eq('venue_id', venueId)
    .maybeSingle()
  if (error) {
    console.error(`[openphone] getConnection(${venueId}) failed:`, error.message)
    return null
  }
  if (!data) return null
  // phone_numbers is jsonb — coerce shape.
  const phoneNumbers = Array.isArray(data.phone_numbers)
    ? (data.phone_numbers as OpenPhonePhoneNumber[])
    : []
  return { ...(data as OpenPhoneConnection), phone_numbers: phoneNumbers }
}

// ---------------------------------------------------------------------------
// Discover phone numbers
// ---------------------------------------------------------------------------

/**
 * Call /phone-numbers and persist the discovered numbers on
 * openphone_connections.phone_numbers. Existing `enabled` flags are
 * preserved so toggling off a personal cell isn't undone on re-discovery.
 *
 * Returns the merged phone-number list.
 */
export async function discoverPhoneNumbers(
  venueId: string
): Promise<OpenPhonePhoneNumber[]> {
  const conn = await getConnection(venueId)

  const payload = await openPhoneFetch(conn.api_key, '/phone-numbers')
  const raw = unwrapList<Record<string, unknown>>(payload)

  // Preserve existing enabled flags by id.
  const prev = new Map<string, OpenPhonePhoneNumber>()
  for (const p of conn.phone_numbers ?? []) {
    if (p?.id) prev.set(p.id, p)
  }

  const merged: OpenPhonePhoneNumber[] = raw
    .map((p) => {
      const id = (p.id as string) || ''
      const phoneNumber =
        (p.phoneNumber as string) ||
        (p.number as string) ||
        (p.phone as string) ||
        ''
      const name =
        (p.name as string | null) ??
        (p.label as string | null) ??
        null
      if (!id || !phoneNumber) return null
      const existing = prev.get(id)
      return {
        id,
        phoneNumber,
        name,
        // Default to enabled when first discovered. Coordinators can opt out.
        enabled: existing?.enabled ?? true,
      } as OpenPhonePhoneNumber
    })
    .filter((p): p is OpenPhonePhoneNumber => p !== null)

  const supabase = createServiceClient()
  const { error } = await supabase
    .from('openphone_connections')
    .update({
      phone_numbers: merged,
      updated_at: new Date().toISOString(),
    })
    .eq('venue_id', venueId)
  if (error) {
    throw new Error(`Failed to persist OpenPhone phone numbers: ${error.message}`)
  }
  return merged
}

// ---------------------------------------------------------------------------
// Identity link — match phone to an existing person
// ---------------------------------------------------------------------------

/**
 * Look up a person via contacts(type='phone'). Returns the venue-scoped
 * person_id if a match exists, otherwise null. We never speculatively
 * create a person — that's identity-resolution's job.
 *
 * Matching is done on the trailing-10-digit normalized form so the
 * coordinator can store numbers as "(540) 388-8912" or "+1 540-388-8912"
 * and either form matches an inbound +15403888912.
 */
async function findPersonIdByPhone(
  venueId: string,
  phone: string | null
): Promise<string | null> {
  const normalized = normalizePhone(phone)
  if (!normalized) return null

  const supabase = createServiceClient()
  // Pull all phone contacts joined to people in this venue and normalize
  // server-side. This is small (a venue has dozens to low thousands of
  // people max) so we don't need a SQL function for it.
  const { data, error } = await supabase
    .from('contacts')
    .select('value, person_id, people!inner(id, venue_id)')
    .eq('type', 'phone')
    .eq('people.venue_id', venueId)
  if (error || !data) return null

  for (const row of data as Array<{ value: string; person_id: string }>) {
    if (normalizePhone(row.value) === normalized) {
      return row.person_id
    }
  }
  return null
}

// ---------------------------------------------------------------------------
// Sync core
// ---------------------------------------------------------------------------

interface IngestRow {
  channel: 'sms' | 'voicemail' | 'call_summary'
  openphone_message_id: string
  direction: 'inbound' | 'outbound'
  from_number: string | null
  to_number: string | null
  body_text: string
  occurred_at: string | null
}

/** Map our channel string → interactions.type CHECK value. */
function channelToInteractionType(
  channel: IngestRow['channel']
): 'sms' | 'voicemail' | 'call' {
  if (channel === 'voicemail') return 'voicemail'
  if (channel === 'call_summary') return 'call'
  return 'sms'
}

function pickOccurredAt(raw: Record<string, unknown>): string | null {
  const candidates = [
    raw.createdAt,
    raw.created_at,
    raw.completedAt,
    raw.completed_at,
    raw.answeredAt,
    raw.answered_at,
    raw.timestamp,
  ]
  for (const c of candidates) {
    if (typeof c === 'string' && c) return c
    if (c instanceof Date) return c.toISOString()
  }
  return null
}

function pickDirection(raw: Record<string, unknown>): 'inbound' | 'outbound' {
  const d = (raw.direction as string) || (raw.type as string) || 'inbound'
  return d === 'outbound' || d === 'sent' ? 'outbound' : 'inbound'
}

function pickBody(raw: Record<string, unknown>, fallback?: string): string {
  const candidates = [
    raw.body,
    raw.text,
    raw.content,
    raw.transcript,
    raw.transcription,
    raw.summary,
    fallback,
  ]
  for (const c of candidates) {
    if (typeof c === 'string' && c.trim()) return c
  }
  return ''
}

function ingestRowsFromMessage(raw: Record<string, unknown>): IngestRow | null {
  const id = (raw.id as string) || ''
  if (!id) return null
  return {
    channel: 'sms',
    openphone_message_id: id,
    direction: pickDirection(raw),
    from_number: (raw.from as string | null) ?? null,
    to_number: Array.isArray(raw.to)
      ? ((raw.to as string[])[0] ?? null)
      : ((raw.to as string | null) ?? null),
    body_text: pickBody(raw).slice(0, 5000),
    occurred_at: pickOccurredAt(raw),
  }
}

function ingestRowsFromVoicemail(raw: Record<string, unknown>): IngestRow | null {
  const id = (raw.id as string) || ''
  if (!id) return null
  // Voicemails arrive on a phone number, not from one in some shapes —
  // keep both fields when available.
  const transcript = pickBody(raw)
  return {
    channel: 'voicemail',
    openphone_message_id: `vm_${id}`,
    direction: 'inbound',
    from_number: (raw.from as string | null) ?? null,
    to_number: (raw.to as string | null) ?? null,
    body_text: transcript ? `[Voicemail] ${transcript}`.slice(0, 5000) : '[Voicemail]',
    occurred_at: pickOccurredAt(raw),
  }
}

function ingestRowsFromCallSummary(raw: Record<string, unknown>): IngestRow | null {
  // Call-summaries reference a callId; messages reference id. Some
  // workspaces return the call id as `callId` on the summary row.
  const callId = (raw.callId as string) || (raw.id as string) || ''
  if (!callId) return null
  const summary = pickBody(raw)
  if (!summary) return null
  return {
    channel: 'call_summary',
    openphone_message_id: `call_${callId}`,
    direction: pickDirection(raw),
    from_number: (raw.from as string | null) ?? null,
    to_number: Array.isArray(raw.to)
      ? ((raw.to as string[])[0] ?? null)
      : ((raw.to as string | null) ?? null),
    body_text: `[Call summary] ${summary}`.slice(0, 5000),
    occurred_at: pickOccurredAt(raw),
  }
}

/**
 * Sync recent SMS, voicemails, and call summaries from OpenPhone into
 * processed_sms_messages (dedup) + interactions (inbox surface).
 */
export async function syncMessages(
  venueId: string,
  opts: { sinceHours?: number } = {}
): Promise<SyncResult> {
  const conn = await getConnection(venueId)

  const sinceHours = Math.max(1, Math.floor(opts.sinceHours ?? DEFAULT_SINCE_HOURS))
  const sinceIso = new Date(Date.now() - sinceHours * 60 * 60 * 1000).toISOString()

  // Resolve the active phone numbers (those the coordinator hasn't
  // toggled off). If the connection has none yet, discover on the fly so
  // a freshly-saved key still produces results without a separate click.
  let phoneNumbers = (conn.phone_numbers ?? []).filter((p) => p.enabled !== false)
  if (phoneNumbers.length === 0) {
    const discovered = await discoverPhoneNumbers(venueId)
    phoneNumbers = discovered.filter((p) => p.enabled !== false)
  }

  const result: SyncResult = {
    inserted: 0,
    skipped: 0,
    errors: [],
    byChannel: { sms: 0, voicemail: 0, call_summary: 0 },
  }

  if (phoneNumbers.length === 0) {
    result.errors.push('No OpenPhone phone numbers discovered for this workspace.')
    return result
  }

  const supabase = createServiceClient()

  // Pre-load already-processed ids for this venue so we can dedup before
  // the row INSERT (the UNIQUE constraint protects us anyway, but this
  // keeps the cost log clean).
  const { data: alreadyProcessed } = await supabase
    .from('processed_sms_messages')
    .select('openphone_message_id')
    .eq('venue_id', venueId)
  const processedIds = new Set<string>(
    (alreadyProcessed ?? []).map((r) => r.openphone_message_id as string)
  )

  for (const phone of phoneNumbers) {
    const phoneNumberId = phone.id

    // ---- SMS messages -----------------------------------------------------
    let messages: Array<Record<string, unknown>> = []
    try {
      const payload = await openPhoneFetch(conn.api_key, '/messages', {
        phoneNumberId,
        since: sinceIso,
        maxResults: '100',
      })
      messages = unwrapList<Record<string, unknown>>(payload)
    } catch (err) {
      result.errors.push(
        `messages(${phone.phoneNumber}): ${err instanceof Error ? err.message : String(err)}`
      )
    }

    for (const m of messages) {
      const row = ingestRowsFromMessage(m)
      if (!row) continue
      const wrote = await persistRow(venueId, conn, row, processedIds)
      if (wrote) {
        result.inserted++
        result.byChannel.sms++
      } else {
        result.skipped++
      }
    }

    // ---- Voicemails -------------------------------------------------------
    let voicemails: Array<Record<string, unknown>> = []
    try {
      const payload = await openPhoneFetch(conn.api_key, '/voicemails', {
        phoneNumberId,
        since: sinceIso,
        maxResults: '50',
      })
      voicemails = unwrapList<Record<string, unknown>>(payload)
    } catch (err) {
      const e = err as Error & { code?: number }
      if (e.code !== 404) {
        result.errors.push(
          `voicemails(${phone.phoneNumber}): ${e.message ?? String(err)}`
        )
      }
    }

    for (const v of voicemails) {
      const row = ingestRowsFromVoicemail(v)
      if (!row) continue
      const wrote = await persistRow(venueId, conn, row, processedIds)
      if (wrote) {
        result.inserted++
        result.byChannel.voicemail++
      } else {
        result.skipped++
      }
    }

    // ---- Call summaries ---------------------------------------------------
    // Try /call-summaries first (some workspaces don't have it), then
    // fall back to /calls and pull whatever transcript / summary the
    // payload carries.
    let callRows: Array<Record<string, unknown>> = []
    try {
      const payload = await openPhoneFetch(conn.api_key, '/call-summaries', {
        phoneNumberId,
        since: sinceIso,
        maxResults: '50',
      })
      callRows = unwrapList<Record<string, unknown>>(payload)
    } catch (err) {
      const e = err as Error & { code?: number }
      if (e.code === 404) {
        try {
          const payload = await openPhoneFetch(conn.api_key, '/calls', {
            phoneNumberId,
            since: sinceIso,
            maxResults: '50',
          })
          callRows = unwrapList<Record<string, unknown>>(payload)
        } catch (callErr) {
          result.errors.push(
            `calls(${phone.phoneNumber}): ${callErr instanceof Error ? callErr.message : String(callErr)}`
          )
        }
      } else {
        result.errors.push(
          `call-summaries(${phone.phoneNumber}): ${e.message ?? String(err)}`
        )
      }
    }

    for (const c of callRows) {
      const row = ingestRowsFromCallSummary(c)
      if (!row) continue
      const wrote = await persistRow(venueId, conn, row, processedIds)
      if (wrote) {
        result.inserted++
        result.byChannel.call_summary++
      } else {
        result.skipped++
      }
    }
  }

  // Update last_synced_at regardless of insert count — a successful poll
  // with zero new rows is still a successful poll.
  const { error: stampErr } = await supabase
    .from('openphone_connections')
    .update({
      last_synced_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    })
    .eq('venue_id', venueId)
  if (stampErr) {
    result.errors.push(`last_synced_at: ${stampErr.message}`)
  }

  return result
}

/**
 * Insert into processed_sms_messages then mirror into interactions.
 * Returns true if a new row was written, false if dedup'd.
 */
async function persistRow(
  venueId: string,
  _conn: OpenPhoneConnection,
  row: IngestRow,
  processedIds: Set<string>
): Promise<boolean> {
  if (processedIds.has(row.openphone_message_id)) return false

  const supabase = createServiceClient()

  // 1) Dedup log
  const { error: dedupErr } = await supabase.from('processed_sms_messages').insert({
    venue_id: venueId,
    openphone_message_id: row.openphone_message_id,
    direction: row.direction,
    channel: row.channel,
    from_number: row.from_number,
    to_number: row.to_number,
    body_text: row.body_text,
    occurred_at: row.occurred_at,
  })
  if (dedupErr) {
    // 23505 = unique violation. Treat as already-processed.
    if ((dedupErr as { code?: string }).code === '23505') {
      processedIds.add(row.openphone_message_id)
      return false
    }
    console.error(
      `[openphone] processed_sms_messages insert failed (${row.openphone_message_id}):`,
      dedupErr.message
    )
    return false
  }
  processedIds.add(row.openphone_message_id)

  // 2) Identity link — only against existing people for this venue.
  // Inbound calls come from the client; outbound go to the client. We
  // match on whichever side is the *external* number.
  const externalNumber =
    row.direction === 'inbound' ? row.from_number : row.to_number
  const personId = await findPersonIdByPhone(venueId, externalNumber)

  // 3) Inbox-visible interaction
  const interactionType = channelToInteractionType(row.channel)
  const occurred = row.occurred_at ?? new Date().toISOString()
  const subject =
    row.channel === 'sms'
      ? `${row.direction === 'inbound' ? 'SMS from' : 'SMS to'} ${externalNumber ?? 'unknown'}`
      : row.channel === 'voicemail'
        ? `Voicemail from ${externalNumber ?? 'unknown'}`
        : `Call ${row.direction === 'inbound' ? 'from' : 'with'} ${externalNumber ?? 'unknown'}`

  const interactionPayload: Record<string, unknown> = {
    venue_id: venueId,
    person_id: personId,
    type: interactionType,
    direction: row.direction,
    subject,
    body_preview: row.body_text.slice(0, 300),
    full_body: row.body_text,
    // interactions has no from_phone column. Surface the number where
    // the inbox already looks for sender identity.
    from_email: externalNumber,
    from_name: null,
    timestamp: occurred,
  }

  const { error: interErr } = await supabase
    .from('interactions')
    .insert(interactionPayload)
  if (interErr) {
    console.error(
      `[openphone] interactions insert failed (${row.openphone_message_id}):`,
      interErr.message
    )
    // Don't undo the processed_sms_messages row — the dedup log is the
    // source of truth and a manual reprocess is cheap.
  }

  return true
}

// ---------------------------------------------------------------------------
// Cron fan-out
// ---------------------------------------------------------------------------

/**
 * Iterate every active openphone_connections row and run syncMessages.
 * Per-venue failures are caught and recorded so one bad workspace
 * doesn't take the cron down.
 */
export async function syncAllVenues(): Promise<Record<string, SyncResult | { error: string }>> {
  const supabase = createServiceClient()
  const { data: connections } = await supabase
    .from('openphone_connections')
    .select('venue_id, is_active')
    .eq('is_active', true)

  const out: Record<string, SyncResult | { error: string }> = {}
  for (const c of connections ?? []) {
    const venueId = c.venue_id as string
    try {
      out[venueId] = await syncMessages(venueId, { sinceHours: 1 })
    } catch (err) {
      out[venueId] = { error: err instanceof Error ? err.message : String(err) }
      console.error(`[openphone] sync failed for venue ${venueId}:`, err)
    }
  }
  return out
}
