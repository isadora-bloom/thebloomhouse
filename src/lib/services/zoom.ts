/**
 * Bloom House: Zoom Integration Service
 *
 * Handles OAuth token refresh, recording listing, transcript fetch + parsing
 * (WEBVTT), and surfacing meeting transcripts into the wedding interaction
 * timeline.
 *
 * Storage model:
 *   - zoom_connections          OAuth tokens, multi-account per venue
 *   - processed_zoom_meetings   Dedup log + transcript text + recording urls
 *   - interactions              Surfaced as type='meeting' rows so Zoom
 *                               transcripts appear in the same wedding
 *                               timeline as emails/calls/sms.
 *
 * Why interactions, not sage_conversations:
 *   sage_conversations is the venue-coordinator chat log (role='user'/'assistant',
 *   model_used, tokens_used). A Zoom meeting is a real-world inbound conversation
 *   between the venue and the couple — it sits naturally next to phone calls,
 *   voicemails, and emails in the wedding timeline. Migration 100 extends the
 *   type CHECK to permit 'meeting'.
 *
 * Token refresh:
 *   Zoom access tokens expire in ~1 hour. We refresh when expires_at is within
 *   60s of now. If refresh fails permanently we set is_active=false and throw
 *   "reconnect needed" so the caller can prompt the user.
 */

import { createServiceClient } from '@/lib/supabase/service'

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface ZoomConnection {
  id: string
  venue_id: string
  zoom_user_id: string
  account_email: string | null
  access_token: string
  refresh_token: string
  expires_at: string
  scope: string | null
  is_active: boolean
  created_at: string
  updated_at: string
}

export interface ZoomRecordingFile {
  id?: string
  file_type?: string
  recording_type?: string
  download_url?: string
  status?: string
}

export interface ZoomMeetingSummary {
  meetingId: string
  uuid: string
  topic: string
  startTime: string
  durationMinutes: number
  transcriptUrl: string | null
  recordingUrls: Array<{ type: string; url: string }>
}

export interface ZoomSyncResult {
  fetched: number
  newlyProcessed: number
  matched: number
  skippedNoTranscript: number
  errors: number
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const ZOOM_OAUTH_AUTHORIZE = 'https://zoom.us/oauth/authorize'
const ZOOM_OAUTH_TOKEN = 'https://zoom.us/oauth/token'
const ZOOM_OAUTH_REVOKE = 'https://zoom.us/oauth/revoke'
const ZOOM_API_BASE = 'https://api.zoom.us/v2'

export const ZOOM_SCOPES = ['recording:read', 'meeting:read', 'user:read']

// Refresh tokens whose expires_at is within this many ms of now
const REFRESH_BUFFER_MS = 60 * 1000

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

function getEnv() {
  const clientId = process.env.ZOOM_CLIENT_ID
  const clientSecret = process.env.ZOOM_CLIENT_SECRET
  const redirectUri = process.env.ZOOM_REDIRECT_URI
  return { clientId, clientSecret, redirectUri }
}

function basicAuthHeader(): string {
  const { clientId, clientSecret } = getEnv()
  if (!clientId || !clientSecret) {
    throw new Error('ZOOM_CLIENT_ID / ZOOM_CLIENT_SECRET not configured')
  }
  const raw = `${clientId}:${clientSecret}`
  return 'Basic ' + Buffer.from(raw).toString('base64')
}

async function persistTokens(
  connectionId: string,
  patch: Partial<{
    access_token: string
    refresh_token: string
    expires_at: string
    scope: string | null
    is_active: boolean
  }>
): Promise<void> {
  const supabase = createServiceClient()
  await supabase
    .from('zoom_connections')
    .update({ ...patch, updated_at: new Date().toISOString() })
    .eq('id', connectionId)
}

async function markInactive(connectionId: string): Promise<void> {
  await persistTokens(connectionId, { is_active: false })
}

// ---------------------------------------------------------------------------
// Exported: parseVtt — pure, exported for tests
// ---------------------------------------------------------------------------

/**
 * Strip cue numbers, WEBVTT headers, and timestamp lines from a VTT string,
 * returning the joined spoken text. Defensive against missing newlines, BOMs,
 * and \r\n endings.
 */
export function parseVtt(vtt: string): string {
  if (!vtt) return ''
  return vtt
    .replace(/^﻿/, '') // strip BOM
    .split(/\r?\n/)
    .filter((rawLine) => {
      const line = rawLine.trim()
      if (!line) return false
      if (line === 'WEBVTT') return false
      if (line.startsWith('NOTE')) return false
      if (line.startsWith('STYLE')) return false
      // Pure cue identifier (sequence number)
      if (/^\d+$/.test(line)) return false
      // Timestamp line: 00:00:00.000 --> 00:00:00.000 (with optional cue settings)
      if (/^\d{1,2}:\d{2}:\d{2}\.\d{1,3}\s*-->\s*\d{1,2}:\d{2}:\d{2}\.\d{1,3}/.test(line))
        return false
      // Short MM:SS.mmm --> MM:SS.mmm form
      if (/^\d{1,2}:\d{2}\.\d{1,3}\s*-->\s*\d{1,2}:\d{2}\.\d{1,3}/.test(line))
        return false
      return true
    })
    .join(' ')
    .replace(/\s+/g, ' ')
    .trim()
}

// ---------------------------------------------------------------------------
// Exported: getZoomClient
// ---------------------------------------------------------------------------

/**
 * Resolve the first active zoom_connections row for a venue, refresh the
 * access token if it's about to expire, and return a small client object the
 * caller can use to make Zoom API requests.
 *
 * Throws "reconnect needed" if there are no active connections, or if a
 * refresh fails and we couldn't recover.
 */
export async function getZoomClient(
  venueId: string
): Promise<{
  accessToken: string
  accountEmail: string | null
  connectionId: string
  zoomUserId: string
}> {
  const supabase = createServiceClient()

  const { data: connections, error } = await supabase
    .from('zoom_connections')
    .select('*')
    .eq('venue_id', venueId)
    .eq('is_active', true)
    .order('updated_at', { ascending: false })
    .limit(1)

  if (error) {
    console.error('[zoom] failed to load zoom_connections:', error.message)
    throw new Error('reconnect needed')
  }

  const conn = (connections ?? [])[0] as ZoomConnection | undefined
  if (!conn) {
    throw new Error('reconnect needed')
  }

  const expiresMs = new Date(conn.expires_at).getTime()
  const isExpiring = !Number.isFinite(expiresMs) || expiresMs < Date.now() + REFRESH_BUFFER_MS

  if (!isExpiring) {
    return {
      accessToken: conn.access_token,
      accountEmail: conn.account_email,
      connectionId: conn.id,
      zoomUserId: conn.zoom_user_id,
    }
  }

  // Refresh
  try {
    const res = await fetch(ZOOM_OAUTH_TOKEN, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        Authorization: basicAuthHeader(),
      },
      body: new URLSearchParams({
        grant_type: 'refresh_token',
        refresh_token: conn.refresh_token,
      }),
    })

    if (!res.ok) {
      const errText = await res.text().catch(() => '')
      console.error(
        `[zoom] refresh failed for connection ${conn.id} (HTTP ${res.status}): ${errText}`
      )
      await markInactive(conn.id)
      throw new Error('reconnect needed')
    }

    const tokens = (await res.json()) as {
      access_token?: string
      refresh_token?: string
      expires_in?: number
      scope?: string
    }

    if (!tokens.access_token) {
      console.error('[zoom] refresh returned no access_token:', tokens)
      await markInactive(conn.id)
      throw new Error('reconnect needed')
    }

    const newExpiresAt = new Date(
      Date.now() + (tokens.expires_in ?? 3600) * 1000
    ).toISOString()

    await persistTokens(conn.id, {
      access_token: tokens.access_token,
      refresh_token: tokens.refresh_token ?? conn.refresh_token,
      expires_at: newExpiresAt,
      scope: tokens.scope ?? conn.scope,
    })

    return {
      accessToken: tokens.access_token,
      accountEmail: conn.account_email,
      connectionId: conn.id,
      zoomUserId: conn.zoom_user_id,
    }
  } catch (err) {
    if (err instanceof Error && err.message === 'reconnect needed') throw err
    console.error('[zoom] refresh threw:', err)
    await markInactive(conn.id).catch(() => undefined)
    throw new Error('reconnect needed')
  }
}

// ---------------------------------------------------------------------------
// Exported: fetchRecordings
// ---------------------------------------------------------------------------

interface ZoomMeetingApi {
  uuid?: string
  id?: number | string
  topic?: string
  start_time?: string
  duration?: number
  recording_files?: ZoomRecordingFile[]
}

interface ZoomRecordingsResponse {
  meetings?: ZoomMeetingApi[]
  next_page_token?: string
}

/**
 * Paginate through `/users/me/recordings` for the lookback window. Returns a
 * normalized list. Filters out meetings without any recording_files.
 */
export async function fetchRecordings(
  venueId: string,
  opts: { sinceDays?: number } = {}
): Promise<ZoomMeetingSummary[]> {
  const { accessToken } = await getZoomClient(venueId)

  const sinceDays = opts.sinceDays ?? 30
  const to = new Date()
  const from = new Date(to.getTime() - sinceDays * 24 * 60 * 60 * 1000)
  const fromStr = from.toISOString().split('T')[0]
  const toStr = to.toISOString().split('T')[0]

  const out: ZoomMeetingSummary[] = []
  let pageToken: string | undefined

  // Hard cap iterations to avoid runaway loops on a misbehaving API.
  for (let i = 0; i < 20; i++) {
    const url = new URL(`${ZOOM_API_BASE}/users/me/recordings`)
    url.searchParams.set('from', fromStr)
    url.searchParams.set('to', toStr)
    url.searchParams.set('page_size', '100')
    if (pageToken) url.searchParams.set('next_page_token', pageToken)

    const res = await fetch(url.toString(), {
      headers: { Authorization: `Bearer ${accessToken}` },
    })

    if (!res.ok) {
      const errText = await res.text().catch(() => '')
      console.error(
        `[zoom] recordings list failed (HTTP ${res.status}): ${errText.slice(0, 300)}`
      )
      // 401 here usually means our token is invalid — surface as reconnect.
      if (res.status === 401) throw new Error('reconnect needed')
      break
    }

    const data = (await res.json()) as ZoomRecordingsResponse
    const meetings = data.meetings ?? []

    for (const m of meetings) {
      const files = m.recording_files ?? []
      if (!m.uuid && !m.id) continue
      const transcriptFile = files.find(
        (f) => f.file_type === 'TRANSCRIPT' || f.recording_type === 'audio_transcript'
      )
      const recordingUrls = files
        .filter((f) => f.file_type !== 'TRANSCRIPT' && f.download_url)
        .map((f) => ({ type: f.file_type ?? f.recording_type ?? 'unknown', url: f.download_url! }))

      out.push({
        meetingId: String(m.id ?? m.uuid),
        uuid: String(m.uuid ?? m.id),
        topic: m.topic ?? '',
        startTime: m.start_time ?? '',
        durationMinutes: typeof m.duration === 'number' ? m.duration : 0,
        transcriptUrl: transcriptFile?.download_url ?? null,
        recordingUrls,
      })
    }

    pageToken = data.next_page_token
    if (!pageToken) break
  }

  return out
}

// ---------------------------------------------------------------------------
// Exported: extractTranscriptText
// ---------------------------------------------------------------------------

/**
 * Fetch a TRANSCRIPT recording_file's download_url and return the cleaned
 * spoken text. Zoom transcript URLs require the access token either as a
 * Bearer header OR as a `?access_token=` query param. We use the header.
 *
 * Returns '' on any HTTP error so the caller can still record dedup info.
 */
export async function extractTranscriptText(
  transcriptUrl: string,
  accessToken: string
): Promise<string> {
  try {
    const res = await fetch(transcriptUrl, {
      headers: { Authorization: `Bearer ${accessToken}` },
    })
    if (!res.ok) {
      console.error(`[zoom] transcript fetch failed (HTTP ${res.status})`)
      return ''
    }
    const vtt = await res.text()
    return parseVtt(vtt)
  } catch (err) {
    console.error('[zoom] transcript fetch threw:', err)
    return ''
  }
}

// ---------------------------------------------------------------------------
// Exported: syncMeetings
// ---------------------------------------------------------------------------

/**
 * Best-effort match of a Zoom meeting to a wedding by participant/topic name.
 * Returns the matched wedding_id or null.
 */
async function matchWeddingByName(
  venueId: string,
  topic: string,
  participantNames: string[]
): Promise<string | null> {
  const supabase = createServiceClient()

  // Build a token list from topic + participants. Lowercase, dedup.
  const tokens = new Set<string>()
  const topicTokens = (topic || '').match(/\b[A-Za-z][A-Za-z'\-]+\b/g) ?? []
  for (const t of topicTokens) tokens.add(t.toLowerCase())
  for (const n of participantNames) {
    for (const part of n.split(/\s+/)) {
      const cleaned = part.replace(/[^A-Za-z'-]/g, '').toLowerCase()
      if (cleaned.length >= 2) tokens.add(cleaned)
    }
  }
  if (tokens.size === 0) return null

  // Pull weddings for the venue + people. Single round-trip each.
  const { data: weddings } = await supabase
    .from('weddings')
    .select('id, couple_names')
    .eq('venue_id', venueId)

  const { data: people } = await supabase
    .from('people')
    .select('wedding_id, first_name, last_name, role')
    .in('wedding_id', (weddings ?? []).map((w) => w.id as string))

  for (const w of weddings ?? []) {
    const couple = (w.couple_names as string | null) ?? ''
    if (couple) {
      for (const t of tokens) {
        if (couple.toLowerCase().includes(t)) return w.id as string
      }
    }
  }

  for (const p of people ?? []) {
    const first = ((p.first_name as string | null) ?? '').toLowerCase()
    const last = ((p.last_name as string | null) ?? '').toLowerCase()
    if (first && tokens.has(first)) return p.wedding_id as string
    if (last && tokens.has(last)) return p.wedding_id as string
  }

  return null
}

/**
 * Orchestrate a full sync for one venue:
 *   1. Fetch recordings in the lookback window.
 *   2. Skip any meeting already in processed_zoom_meetings.
 *   3. Download + clean the transcript.
 *   4. Best-effort match to a wedding by name.
 *   5. Insert into processed_zoom_meetings (dedup + storage of transcript).
 *   6. Insert a corresponding interactions row (type='meeting') so the
 *      transcript surfaces in the wedding timeline.
 */
export async function syncMeetings(
  venueId: string,
  opts: { sinceDays?: number } = {}
): Promise<ZoomSyncResult> {
  const supabase = createServiceClient()

  let client: { accessToken: string; accountEmail: string | null; connectionId: string; zoomUserId: string }
  try {
    client = await getZoomClient(venueId)
  } catch (err) {
    if (err instanceof Error && err.message === 'reconnect needed') {
      throw err
    }
    throw err
  }

  const recordings = await fetchRecordings(venueId, opts)

  // Dedup against processed_zoom_meetings
  const { data: existing } = await supabase
    .from('processed_zoom_meetings')
    .select('zoom_meeting_id')
    .eq('venue_id', venueId)

  const seen = new Set<string>(
    (existing ?? []).map((r) => r.zoom_meeting_id as string)
  )

  const result: ZoomSyncResult = {
    fetched: recordings.length,
    newlyProcessed: 0,
    matched: 0,
    skippedNoTranscript: 0,
    errors: 0,
  }

  for (const meeting of recordings) {
    if (seen.has(meeting.meetingId)) continue

    if (!meeting.transcriptUrl) {
      result.skippedNoTranscript++
      // Still record dedup so we don't keep re-checking the same meeting.
      try {
        await supabase.from('processed_zoom_meetings').insert({
          venue_id: venueId,
          zoom_meeting_id: meeting.meetingId,
          zoom_meeting_uuid: meeting.uuid,
          meeting_topic: meeting.topic || null,
          meeting_start_time: meeting.startTime || null,
          duration_minutes: meeting.durationMinutes || null,
          participant_names: [],
          transcript_text: null,
          recording_urls: meeting.recordingUrls,
        })
        seen.add(meeting.meetingId)
      } catch (err) {
        console.error('[zoom] dedup insert (no transcript) failed:', err)
        result.errors++
      }
      continue
    }

    const transcriptText = await extractTranscriptText(meeting.transcriptUrl, client.accessToken)
    if (!transcriptText) {
      result.errors++
      continue
    }

    // Extract participant names from topic (best effort — VTT speaker labels
    // would require a richer parser. The topic plus matched wedding is enough
    // for the current matching heuristic.)
    const topicNames = (meeting.topic || '').match(/\b[A-Z][a-z]{1,}\b/g) ?? []

    const matchedWeddingId = await matchWeddingByName(venueId, meeting.topic, topicNames)
    if (matchedWeddingId) result.matched++

    try {
      const { error: pmError } = await supabase.from('processed_zoom_meetings').insert({
        venue_id: venueId,
        zoom_meeting_id: meeting.meetingId,
        zoom_meeting_uuid: meeting.uuid,
        wedding_id: matchedWeddingId,
        meeting_topic: meeting.topic || null,
        meeting_start_time: meeting.startTime || null,
        duration_minutes: meeting.durationMinutes || null,
        participant_names: topicNames,
        transcript_text: transcriptText.slice(0, 50000),
        recording_urls: meeting.recordingUrls,
      })
      if (pmError) {
        console.error('[zoom] processed_zoom_meetings insert failed:', pmError.message)
        result.errors++
        continue
      }
      seen.add(meeting.meetingId)
      result.newlyProcessed++

      // Surface into the interaction timeline. Only insert when we have a
      // wedding match — interactions without wedding_id are allowed but
      // wouldn't show on a couple's page either way, so we attach when known.
      const subject = meeting.topic
        ? `Zoom: ${meeting.topic}`
        : `Zoom meeting${meeting.startTime ? ` (${meeting.startTime.split('T')[0]})` : ''}`
      const bodyPreview = transcriptText.slice(0, 500)

      const { error: iError } = await supabase.from('interactions').insert({
        venue_id: venueId,
        wedding_id: matchedWeddingId,
        type: 'meeting',
        direction: 'inbound',
        subject,
        body_preview: bodyPreview,
        full_body: transcriptText.slice(0, 50000),
        timestamp: meeting.startTime || new Date().toISOString(),
      })
      if (iError) {
        console.error('[zoom] interactions insert failed:', iError.message)
        // Don't bump errors — dedup already happened, transcript is stored.
      }
    } catch (err) {
      console.error('[zoom] sync row insert threw:', err)
      result.errors++
    }
  }

  return result
}

// ---------------------------------------------------------------------------
// Exported: token-revocation helper used by /disconnect
// ---------------------------------------------------------------------------

export async function revokeZoomToken(token: string): Promise<boolean> {
  try {
    const res = await fetch(ZOOM_OAUTH_REVOKE, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        Authorization: basicAuthHeader(),
      },
      body: new URLSearchParams({ token }),
    })
    return res.ok
  } catch (err) {
    console.error('[zoom] revoke failed:', err)
    return false
  }
}
