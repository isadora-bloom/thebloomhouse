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
import { recordEngagementEvent } from '@/lib/services/heat-mapping'

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const OPENPHONE_API_BASE = 'https://api.openphone.com/v1'
// First-sync backfill window — pulls this far back when a venue connects
// OpenPhone for the first time + on any sync where last_synced_at is null
// (e.g. a fresh connection or one that had its watermark reset for a
// historical re-pull). 180 days catches active conversations with booked
// couples that started months earlier; older threads are usually past-
// event chatter not worth backfilling.
const FIRST_SYNC_DAYS = 180

// Overlap window applied to every subsequent sync. The next sync starts
// from `last_synced_at - OVERLAP_MIN` rather than exactly last_synced_at,
// so if Quo timestamps lag or our clock skews slightly we never miss a
// message at the boundary. processed_sms_messages dedups so the overlap
// never double-writes.
const OVERLAP_MIN = 15

// Hard ceiling on any backfill window — prevents a buggy caller from
// asking for "all time" and racking up Quo API costs.
const MAX_BACKFILL_DAYS = 365

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
  params?: Record<string, string | string[] | undefined>
): Promise<unknown> {
  // 2026-05-11: support array params. Quo (formerly OpenPhone) now requires
  // `participants` (array) on /messages and /calls. The legacy single-value
  // signature stays back-compat — string values still get one key/value.
  const qs = new URLSearchParams()
  if (params) {
    for (const [k, v] of Object.entries(params)) {
      if (v == null) continue
      if (Array.isArray(v)) {
        for (const item of v) {
          if (item != null && item !== '') qs.append(k, item)
        }
      } else if (v !== '') {
        qs.set(k, v)
      }
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

  // Tier 1: contacts table (the canonical multi-channel address store).
  const { data: contactRows } = await supabase
    .from('contacts')
    .select('value, person_id, people!inner(id, venue_id)')
    .eq('type', 'phone')
    .eq('people.venue_id', venueId)

  for (const row of (contactRows ?? []) as Array<{ value: string; person_id: string }>) {
    if (normalizePhone(row.value) === normalized) return row.person_id
  }

  // Tier 2: people.phone (denormalised cache). The Calendly webhook +
  // CRM importers write phone here directly via resolveIdentity; if the
  // contacts row didn't get written for some reason, this catches the
  // match anyway. Indirectly covers the "tours have a phone" case —
  // tour booking through Calendly writes the phone to people.phone for
  // the matched/created person, so any subsequent SMS from that number
  // resolves here.
  const { data: peopleRows } = await supabase
    .from('people')
    .select('id, phone')
    .eq('venue_id', venueId)
    .not('phone', 'is', null)

  for (const row of (peopleRows ?? []) as Array<{ id: string; phone: string | null }>) {
    if (row.phone && normalizePhone(row.phone) === normalized) return row.id
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
  // Quo (formerly OpenPhone) returns direction as 'incoming' | 'outgoing'.
  // Legacy callers used 'inbound' | 'outbound' | 'sent'. Accept all
  // variants so a future API rename doesn't silently flip every message
  // to the wrong direction (which is exactly what bit Rixey on 2026-05-11:
  // every outbound SMS got tagged inbound, the venue's own phone became
  // the externalNumber, and the resolver minted a synthetic wedding for
  // "couple with phone = venue line").
  const d = ((raw.direction as string) || (raw.type as string) || 'inbound').toLowerCase()
  if (d === 'outbound' || d === 'outgoing' || d === 'sent') return 'outbound'
  return 'inbound'
}

/**
 * Normalise a Quo phone-number field. The API has shipped both plain
 * strings ("+15551234567") and object-wrapped ({ phoneNumber:
 * "+15551234567" }) shapes depending on endpoint + workspace tier.
 * Returns the bare E.164 string or null.
 */
function pickPhone(raw: unknown): string | null {
  if (!raw) return null
  if (typeof raw === 'string') return raw.trim() || null
  if (typeof raw === 'object') {
    const obj = raw as { phoneNumber?: unknown; number?: unknown }
    const candidate = (obj.phoneNumber as string) ?? (obj.number as string) ?? null
    return candidate && typeof candidate === 'string' ? candidate.trim() || null : null
  }
  return null
}

function pickFirstPhone(raw: unknown): string | null {
  if (Array.isArray(raw) && raw.length > 0) return pickPhone(raw[0])
  return pickPhone(raw)
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
    from_number: pickPhone(raw.from),
    to_number: pickFirstPhone(raw.to),
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
    from_number: pickPhone(raw.from),
    to_number: pickFirstPhone(raw.to),
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
  // 2026-05-11: in modern Quo (formerly OpenPhone), summary + transcript
  // are NOT inlined on the /calls list endpoint — they live on the
  // separate /v1/calls/{id}/summary and /v1/calls/{id}/transcriptions
  // endpoints. The caller of this function fetches those and stuffs
  // the text onto raw.transcript / raw.summary before calling us, so
  // pickBody picks it up. When neither is present we still record the
  // call as an interaction (zero-body placeholder) so the lead's
  // timeline shows "Call · 4 min" even without transcript text.
  const placeholder = (() => {
    const direction = pickDirection(raw)
    const dur = (raw.duration as number | null) ?? (raw.durationSeconds as number | null) ?? null
    const mins = dur != null ? Math.round(dur / 60) : null
    const verb = direction === 'inbound' ? 'Inbound call' : 'Outbound call'
    return mins != null ? `${verb} · ${mins} min · (no transcript)` : `${verb} · (no transcript)`
  })()
  const bodyText = summary ? `[Call] ${summary}`.slice(0, 5000) : placeholder
  return {
    channel: 'call_summary',
    openphone_message_id: `call_${callId}`,
    direction: pickDirection(raw),
    from_number: pickPhone(raw.from),
    to_number: pickFirstPhone(raw.to),
    body_text: bodyText,
    occurred_at: pickOccurredAt(raw),
  }
}

/**
 * Fetch the per-call summary + transcription from Quo and merge onto the
 * raw call object so ingestRowsFromCallSummary can read them via pickBody.
 *
 * Quo's `/calls` list endpoint only returns metadata; summaries +
 * transcriptions live on dedicated endpoints. We try summary first
 * (cheap, AI-condensed) then transcription (verbose, full text). When
 * both fail (e.g. call wasn't recorded, or the workspace doesn't have
 * AI summaries enabled), the call still lands as a placeholder
 * interaction so the lead's timeline reflects the call happened.
 *
 * Both endpoints 404 on calls without transcripts — that's expected
 * and quiet.
 */
async function hydrateCallTranscript(
  apiKey: string,
  rawCall: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const callId = (rawCall.id as string) || (rawCall.callId as string) || ''
  if (!callId) return rawCall

  const hydrated: Record<string, unknown> = { ...rawCall }

  // Summary first — short, free, AI-generated.
  try {
    const summaryPayload = await openPhoneFetch(apiKey, `/calls/${callId}/summary`)
    const sObj = summaryPayload as { data?: Record<string, unknown> } | Record<string, unknown> | null
    const data = (sObj as { data?: Record<string, unknown> })?.data ?? sObj
    if (data && typeof data === 'object') {
      const summaryText = (data as Record<string, unknown>).summary
      if (typeof summaryText === 'string' && summaryText.trim()) {
        hydrated.summary = summaryText
      }
    }
  } catch (err) {
    const e = err as Error & { code?: number }
    if (e.code !== 404) {
      // Log but don't throw — the placeholder will still land.
      console.warn(`[openphone] /calls/${callId}/summary failed:`, e.message)
    }
  }

  // Transcription — full text. Quo's transcript shape carries an array
  // of dialogue segments; join the speaker-tagged text into a single
  // body so the operator can read it without leaving the inbox.
  try {
    const transcriptPayload = await openPhoneFetch(apiKey, `/calls/${callId}/transcriptions`)
    const tObj = transcriptPayload as { data?: Record<string, unknown> } | Record<string, unknown> | null
    const data = (tObj as { data?: Record<string, unknown> })?.data ?? tObj
    if (data && typeof data === 'object') {
      const segments = (data as Record<string, unknown>).dialogue
      if (Array.isArray(segments)) {
        const lines = segments
          .map((seg: unknown) => {
            const s = seg as { identifier?: string; userId?: string; content?: string }
            const speaker = s.identifier || s.userId || 'Speaker'
            const text = s.content?.trim()
            return text ? `${speaker}: ${text}` : null
          })
          .filter((line): line is string => line !== null)
        if (lines.length > 0) hydrated.transcript = lines.join('\n')
      }
      const plain = (data as Record<string, unknown>).transcript
      if (!hydrated.transcript && typeof plain === 'string' && plain.trim()) {
        hydrated.transcript = plain
      }
    }
  } catch (err) {
    const e = err as Error & { code?: number }
    if (e.code !== 404) {
      console.warn(`[openphone] /calls/${callId}/transcriptions failed:`, e.message)
    }
  }

  return hydrated
}

/**
 * Sync SMS, voicemails, and call summaries from OpenPhone (Quo) into
 * processed_sms_messages (dedup) + interactions (inbox surface).
 *
 * Window resolution (in priority order):
 *   1. Caller passes explicit sinceHours → use it (capped at
 *      MAX_BACKFILL_DAYS). For scripts that want a forced historical
 *      pull or for the operator-triggered "Sync now" with an override.
 *   2. Caller passes explicit sinceIso → use it verbatim. Lets a
 *      historical-backfill script bound the window precisely.
 *   3. conn.last_synced_at IS NOT NULL → use last_synced_at - OVERLAP
 *      (catches messages updated between the previous sync's start and
 *      its stamp; processed_sms_messages dedups any double-write).
 *   4. last_synced_at IS NULL → first sync ever for this venue. Pull
 *      FIRST_SYNC_DAYS back so the venue's existing history (Gabriella,
 *      Lea, Sarah threads etc.) is in Bloom from day one.
 *
 * The previous behaviour was "always last 24h" which silently dropped
 * every conversation older than yesterday — exactly the symptom
 * Isadora hit on 2026-05-11 when she connected OpenPhone and only saw
 * 28 of months of history.
 */
export async function syncMessages(
  venueId: string,
  opts: { sinceHours?: number; sinceIso?: string } = {}
): Promise<SyncResult> {
  const conn = await getConnection(venueId)

  let sinceIso: string
  if (opts.sinceIso) {
    sinceIso = opts.sinceIso
  } else if (opts.sinceHours != null) {
    const cappedHours = Math.min(
      Math.max(1, Math.floor(opts.sinceHours)),
      MAX_BACKFILL_DAYS * 24,
    )
    sinceIso = new Date(Date.now() - cappedHours * 60 * 60 * 1000).toISOString()
  } else if (conn.last_synced_at) {
    const watermark = new Date(conn.last_synced_at).getTime() - OVERLAP_MIN * 60 * 1000
    sinceIso = new Date(watermark).toISOString()
  } else {
    sinceIso = new Date(Date.now() - FIRST_SYNC_DAYS * 24 * 60 * 60 * 1000).toISOString()
    console.log(
      `[openphone] first sync for venue ${venueId} — pulling ${FIRST_SYNC_DAYS}d history`,
    )
  }

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

  // 2026-05-11 Quo API rewrite. The legacy /messages?phoneNumberId=X&since=Y
  // pattern was deprecated. Quo now requires:
  //   - participants[] (the OTHER side of the conversation) on /messages + /calls
  //   - listing conversations first via /conversations to enumerate participants
  //   - createdAfter (since is deprecated)
  //
  // Strategy: list every conversation on every venue phone, then for each
  // conversation fetch messages + calls scoped to that participant. This
  // catches both known clients AND unknown numbers (the rixey-portal
  // pattern only iterates known phones; Bloom needs both).
  for (const phone of phoneNumbers) {
    const phoneNumberId = phone.id

    // List conversations on this venue line.
    let conversations: Array<Record<string, unknown>> = []
    try {
      // Paginate. maxResults is required and capped at 100.
      let pageToken: string | null = null
      do {
        const params: Record<string, string | string[] | undefined> = {
          phoneNumbers: [phone.phoneNumber],
          updatedAfter: sinceIso,
          maxResults: '100',
        }
        if (pageToken) params.pageToken = pageToken
        const payload: unknown = await openPhoneFetch(conn.api_key, '/conversations', params)
        const page = unwrapList<Record<string, unknown>>(payload)
        conversations.push(...page)
        pageToken =
          (payload as { nextPageToken?: string | null } | null)?.nextPageToken ?? null
      } while (pageToken)
    } catch (err) {
      result.errors.push(
        `conversations(${phone.phoneNumber}): ${err instanceof Error ? err.message : String(err)}`,
      )
      continue
    }

    // For each conversation, pull messages + calls for its participant(s).
    for (const conv of conversations) {
      const participants = (conv.participants as string[] | undefined) ?? []
      // De-dup + filter empty.
      const otherParties = Array.from(new Set(participants.filter((p) => !!p && p !== phone.phoneNumber)))
      if (otherParties.length === 0) continue

      // ---- SMS messages -------------------------------------------------
      let messages: Array<Record<string, unknown>> = []
      try {
        const payload = await openPhoneFetch(conn.api_key, '/messages', {
          phoneNumberId,
          participants: otherParties,
          createdAfter: sinceIso,
          maxResults: '100',
        })
        messages = unwrapList<Record<string, unknown>>(payload)
      } catch (err) {
        result.errors.push(
          `messages(${phone.phoneNumber} -> ${otherParties.join(',')}): ${err instanceof Error ? err.message : String(err)}`,
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

      // ---- Calls (with optional transcript / summary) -------------------
      let callRows: Array<Record<string, unknown>> = []
      try {
        const payload = await openPhoneFetch(conn.api_key, '/calls', {
          phoneNumberId,
          participants: otherParties,
          createdAfter: sinceIso,
          maxResults: '50',
        })
        callRows = unwrapList<Record<string, unknown>>(payload)
      } catch (err) {
        const e = err as Error & { code?: number }
        if (e.code !== 404) {
          result.errors.push(
            `calls(${phone.phoneNumber} -> ${otherParties.join(',')}): ${e.message ?? String(err)}`,
          )
        }
      }

      for (const c of callRows) {
        // 2026-05-11: hydrate summary + transcript via the per-call
        // endpoints (not inline on /calls in modern Quo). hydrateCallTranscript
        // never throws — silent 404s + warnings on other errors. The
        // call still records as a placeholder interaction if no
        // transcript exists, so the lead timeline shows the call.
        const hydrated = await hydrateCallTranscript(conn.api_key, c)
        const row = ingestRowsFromCallSummary(hydrated)
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

    // ---- Voicemails ---------------------------------------------------
    // The /voicemails endpoint is still phone-line-scoped (per the Quo
    // docs); it doesn't take participants. Keep the legacy call shape
    // but switch the parameter name.
    let voicemails: Array<Record<string, unknown>> = []
    try {
      const payload = await openPhoneFetch(conn.api_key, '/voicemails', {
        phoneNumberId,
        createdAfter: sinceIso,
        maxResults: '50',
      })
      voicemails = unwrapList<Record<string, unknown>>(payload)
    } catch (err) {
      const e = err as Error & { code?: number }
      if (e.code !== 404) {
        result.errors.push(
          `voicemails(${phone.phoneNumber}): ${e.message ?? String(err)}`,
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

  // 2) Identity link. The external party is `from_number` on inbound,
  // `to_number` on outbound. Three-tier match chain:
  //   (a) Phone match against `contacts(type='phone')` — most reliable.
  //   (b) LLM name + event-context extraction from the body, matched
  //       against existing people. Runs on BOTH directions: inbound
  //       carries self-identification ("Hi, this is Sarah"); outbound
  //       carries addressee identification ("Hi Sarah, your tour is..."),
  //       and the prompt extracts whichever name the body surfaces.
  //   (c) Identity resolver create-fresh — phone-only signal mints a
  //       new person + wedding. INBOUND ONLY: an unknown couple texting
  //       the venue is a new prospect. Outbound to an unknown number is
  //       just as likely a vendor, friend, or wrong number; we leave
  //       the interaction unmatched and let the operator decide.
  const externalNumber =
    row.direction === 'inbound' ? row.from_number : row.to_number
  let personId = await findPersonIdByPhone(venueId, externalNumber)
  let weddingId: string | null = null

  if (!personId && row.channel === 'sms' && row.body_text) {
    try {
      const { tryMatchSmsByName } = await import('./sms-name-match')
      const nameMatch = await tryMatchSmsByName({
        supabase,
        venueId,
        body: row.body_text,
        fromPhone: externalNumber,
      })
      if (nameMatch) {
        personId = nameMatch.personId
        weddingId = nameMatch.weddingId
        console.log(
          `[openphone] linked ${row.direction} SMS to existing person by name: ${nameMatch.matchedName} (conf ${nameMatch.confidence})`,
        )
      }
    } catch (err) {
      console.warn('[openphone] sms-name-match failed (non-fatal):', err)
    }
  }

  // Resolver create-fresh: INBOUND only. Outbound to an unknown number
  // is more likely a vendor/friend/wrong-number than a fresh prospect;
  // creating a wedding for them pollutes the lead list. Surface as
  // unmatched and let the operator attach if it really is a couple.
  if (!personId && externalNumber && row.direction === 'inbound') {
    try {
      const { resolveIdentity } = await import('@/lib/services/identity/resolver')
      const resolved = await resolveIdentity(
        venueId,
        {
          email: null,
          phone: externalNumber,
          fullName: null,
          weddingDate: null,
          partner1Name: null,
          partner2Name: null,
        },
        {
          sourceLabel: `openphone:${row.channel}`,
          supabase,
          inquirySignalAt: row.occurred_at ?? undefined,
        },
      )
      personId = resolved.personId
      weddingId = resolved.weddingId
    } catch (err) {
      console.warn('[openphone] resolveIdentity failed (non-fatal):', err)
    }
  }

  if (!weddingId && personId) {
    // Hydrate wedding_id from the matched person so the interaction
    // gets linked.
    const { data: personRow } = await supabase
      .from('people')
      .select('wedding_id')
      .eq('id', personId)
      .maybeSingle()
    weddingId = (personRow?.wedding_id as string | null) ?? null
  }

  // 3) Inbox-visible interaction
  const interactionType = channelToInteractionType(row.channel)
  const occurred = row.occurred_at ?? new Date().toISOString()
  const subject =
    row.channel === 'sms'
      ? `${row.direction === 'inbound' ? 'SMS from' : 'SMS to'} ${externalNumber ?? 'unknown'}`
      : row.channel === 'voicemail'
        ? `Voicemail from ${externalNumber ?? 'unknown'}`
        : `Call ${row.direction === 'inbound' ? 'from' : 'with'} ${externalNumber ?? 'unknown'}`

  // Pattern 3 (BLOOM-PATTERNS-ZOOM-OUT.md): body-extract parity. Voice
  // / SMS / voicemail bodies often carry "yeah email me at..." or joint
  // handles. Same chain that runs on emails. ownEmails empty: voice
  // channels don't quote venue's own email-domain often, and the
  // resolver downstream filters venue-match anyway.
  const { extractIdentityFromEmail } = await import(
    '@/lib/services/identity/body-extract'
  )
  const voiceExtractedIdentity = extractIdentityFromEmail(
    { subject, body: row.body_text },
    { ownEmails: new Set<string>() },
  )

  const interactionPayload: Record<string, unknown> = {
    venue_id: venueId,
    person_id: personId,
    wedding_id: weddingId,
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
    // T5-Rixey-BBB: SMS / voicemail / call signals from OpenPhone
    // are touchpoints — the lead reached out via a known channel
    // they discovered the venue through.
    // signal-class-justified: phone-channel signals are touchpoint
    signal_class: 'touchpoint',
    // Wave 28 (mig 294): phone/voice channels surface in /agent/audio-inbox.
    surface: 'voice_capture',
    // Wave 27 (mig 293): inbound from external phone = couple voice;
    // outbound from venue line = operator. The Haiku author classifier
    // re-checks bodies later but this is a safe synchronous default.
    author_class: row.direction === 'inbound' ? 'couple' : 'operator',
    // Pattern 3: every channel populates extracted_identity for
    // forensic record + retroactive linkage scripts.
    extracted_identity: voiceExtractedIdentity,
  }

  const { data: insertedInteraction, error: interErr } = await supabase
    .from('interactions')
    .insert(interactionPayload)
    .select('id')
    .maybeSingle()
  if (interErr) {
    console.error(
      `[openphone] interactions insert failed (${row.openphone_message_id}):`,
      interErr.message
    )
    // Don't undo the processed_sms_messages row — the dedup log is the
    // source of truth and a manual reprocess is cheap.
  }

  // Wave 28 voice-heat wiring (2026-05-12). Fire an engagement_event so
  // SMS / call / voicemail signals actually bump heat scores. Email-side
  // pipeline already fires events through processIncomingEmail; voice
  // channels were missed and that left every SMS-heavy lead at heat_score
  // = 0 (Justin & Sandy at Rixey with 27+ SMS sat at 0 until this fix).
  //
  // Inbound channel → event-type mapping:
  //   sms          → 'sms_received'
  //   call         → 'call_inbound' or 'call_inbound_with_transcript'
  //                  if a real transcript landed in the body
  //   voicemail    → 'voicemail_received'
  // Outbound channels fire 'sms_sent' / 'call_outbound' which score 0
  // or low — venue-side activity, kept for audit symmetry but the
  // read-side direction='inbound' filter in recalculateHeatScore means
  // they never inflate heat anyway.
  //
  // Fire-and-forget: a heat-write failure never blocks the SMS persist.
  // recordEngagementEvent only fires when wedding_id is set; orphan
  // signals don't count toward heat.
  if (weddingId) {
    const eventType = pickVoiceEventType(row)
    if (eventType) {
      const interactionId = (insertedInteraction?.id as string | undefined) ?? null
      void recordEngagementEvent(
        venueId,
        weddingId,
        eventType,
        row.direction,
        {
          source: 'openphone',
          channel: row.channel,
          openphone_message_id: row.openphone_message_id,
          interaction_id: interactionId,
        },
        row.occurred_at ?? undefined,
      ).catch((err) => {
        console.warn(
          `[openphone] heat fire failed (${row.openphone_message_id}, ${eventType}):`,
          err instanceof Error ? err.message : String(err),
        )
      })
    }

    // 2026-05-12 (mig 313). SMS scheduling extractor — fire-and-forget on
    // inbound SMS only. The Haiku judge reads the last 30d of SMS for the
    // wedding and writes/updates a tours row when the thread evidences a
    // confirmed or completed visit. Trigger trg_tours_touch_has_toured
    // (mig 306) then stamps weddings.has_toured_in_person, which closes
    // the Sage prompt awareness loop (no more "come tour" drafts after a
    // tour). Inbound only because the venue-side messages are echoes; the
    // signal we need (couple agreeing / thanking post-tour) is in the
    // inbound side.
    if (row.direction === 'inbound' && row.channel === 'sms') {
      void (async () => {
        try {
          const { extractTourSignalsFromSmsThread } = await import(
            '@/lib/services/sms/scheduling-extractor'
          )
          await extractTourSignalsFromSmsThread({
            supabase,
            weddingId,
            venueId,
          })
        } catch (err) {
          console.warn(
            `[openphone] sms scheduling extractor failed (${row.openphone_message_id}):`,
            err instanceof Error ? err.message : String(err),
          )
        }
      })()
    }
  }

  // Inbound-intent classifier (mig 327, Anja Putman / RM-1152). Fires on
  // every inbound voice/SMS/call/voicemail. Required for the Anja class
  // of bug: logistics chatter on a fresh phone number gets minted as a
  // hot inquiry. The classifier emits intent_class (client_logistics,
  // family_member_proxy, vendor_communication, etc) so downstream heat
  // scoring + Sage drafts + sequences route correctly. Fire-and-forget.
  if (row.direction === 'inbound' && insertedInteraction?.id) {
    const intentChannel =
      row.channel === 'sms'
        ? 'sms'
        : row.channel === 'voicemail'
          ? 'voicemail'
          : 'call'
    void (async () => {
      try {
        const { classifyInboundIntent } = await import(
          '@/lib/services/intel/inbound-intent-classifier'
        )
        await classifyInboundIntent({
          interactionId: insertedInteraction.id as string,
          body: row.body_text,
          subject: null,
          venueId,
          channel: intentChannel,
          supabase,
        })
      } catch (err) {
        console.warn(
          `[openphone] intent-classify failed (${row.openphone_message_id}):`,
          err instanceof Error ? err.message : String(err),
        )
      }
    })()
  }

  // ---------------------------------------------------------------------------
  // Pattern 9: voice-channel parity hooks (mig 318)
  // ---------------------------------------------------------------------------
  // The next three blocks run on every SMS write (lifecycle folder) +
  // every inbound SMS (escalation classifier + auto-reply). All are
  // fire-and-forget. None of them can block the persist path.
  const interactionId = (insertedInteraction?.id as string | undefined) ?? null
  if (row.channel === 'sms' && externalNumber) {
    // W3: SMS lifecycle folder. Runs on every direction so a venue-side
    // outbound moves the thread from awaiting_venue to awaiting_couple
    // without waiting for the next inbound.
    void (async () => {
      try {
        const { updateSmsThreadLifecycleFolder } = await import(
          '@/lib/services/sms/lifecycle'
        )
        await updateSmsThreadLifecycleFolder({
          supabase,
          venueId,
          phone: externalNumber,
        })
      } catch (err) {
        console.warn(
          `[openphone] sms lifecycle folder update failed (${row.openphone_message_id}):`,
          err instanceof Error ? err.message : String(err),
        )
      }
    })()

    if (row.direction === 'inbound' && interactionId && row.body_text) {
      // W5: SMS escalation classifier. Stamps the row + fires admin
      // notification when triggered. Runs BEFORE the auto-reply path so
      // an escalated thread skips auto-reply via the trigger row read.
      void (async () => {
        try {
          const { classifyAndPersistSmsEscalation } = await import(
            '@/lib/services/sms/escalation-classifier'
          )
          await classifyAndPersistSmsEscalation({
            venueId,
            interactionId,
            weddingId,
            body: row.body_text,
            fromPhone: externalNumber,
          })
        } catch (err) {
          console.warn(
            `[openphone] sms escalation classifier failed (${row.openphone_message_id}):`,
            err instanceof Error ? err.message : String(err),
          )
        }
      })()

      // W1: SMS auto-reply rules. Reads channel='sms' rules from
      // auto_send_rules; lands drafts in pending_sms_drafts. Operator
      // hits Send manually until P6 routability ships. Skipped when
      // escalation has just been requested (gate inside tryGenerateSmsAutoReply
      // reads the row's sms_escalation_requested_at column).
      //
      // Small delay-via-microtask: ensure the escalation classifier above
      // has a chance to land before auto-reply reads the row. Both are
      // void IIFEs so timing is not strict; the auto-reply path re-reads
      // the row anyway so a late-arriving escalation still blocks the
      // draft on the next inbound. Acceptable for this iteration.
      void (async () => {
        try {
          const { tryGenerateSmsAutoReply } = await import(
            '@/lib/services/sms/auto-reply'
          )
          await tryGenerateSmsAutoReply({
            venueId,
            weddingId,
            personId,
            triggerInteractionId: interactionId,
            externalPhone: externalNumber,
          })
        } catch (err) {
          console.warn(
            `[openphone] sms auto-reply failed (${row.openphone_message_id}):`,
            err instanceof Error ? err.message : String(err),
          )
        }
      })()
    }
  }

  return true
}

/**
 * Map an ingested voice/SMS row to the heat-mapping event_type that
 * matches its channel + direction. Returns null when there's nothing
 * to fire (unrecognised channel — defensive only, the channel type
 * union already constrains the input).
 *
 * Direction is honoured: inbound rows produce couple-side event types
 * (sms_received / call_inbound / voicemail_received); outbound rows
 * produce venue-side types (sms_sent / call_outbound). The read-side
 * filter in recalculateHeatScore drops outbound rows from the sum, so
 * the venue-side types are purely audit. Voicemails are always
 * inbound by construction (you don't leave yourself a voicemail).
 *
 * Call rows escalate to call_inbound_with_transcript when the body
 * carries real transcript text (the hydrator merged summary or
 * transcription). The placeholder "Inbound call · 4 min · (no
 * transcript)" string starts with "Inbound call" or "Outbound call" —
 * the [Call] prefix is the marker that real text landed.
 */
function pickVoiceEventType(row: IngestRow): string | null {
  if (row.channel === 'sms') {
    return row.direction === 'inbound' ? 'sms_received' : 'sms_sent'
  }
  if (row.channel === 'voicemail') {
    return 'voicemail_received'
  }
  if (row.channel === 'call_summary') {
    if (row.direction === 'outbound') return 'call_outbound'
    const hasTranscript = row.body_text.startsWith('[Call]')
    return hasTranscript ? 'call_inbound_with_transcript' : 'call_inbound'
  }
  return null
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
      // Don't pass sinceHours — let syncMessages resolve the window from
      // last_synced_at (incremental sync) OR FIRST_SYNC_DAYS for a fresh
      // connection. The previous code forced sinceHours:1, which capped
      // every cron tick at 1h regardless of how stale the connection was
      // — venues that just connected would never get their backfill.
      out[venueId] = await syncMessages(venueId)
    } catch (err) {
      out[venueId] = { error: err instanceof Error ? err.message : String(err) }
      console.error(`[openphone] sync failed for venue ${venueId}:`, err)
    }
  }
  return out
}
