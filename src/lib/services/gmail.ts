/**
 * Bloom House: Gmail API Service
 *
 * Fetches and sends emails via the Gmail API using the `googleapis` package.
 *
 * Supports multi-Gmail connections: each venue can have multiple connected
 * Gmail accounts stored in the `gmail_connections` table. Backward compatible
 * with the legacy `venue_config.gmail_tokens` field — if a connection is
 * requested and only the legacy field exists, it is automatically migrated
 * to a `gmail_connections` row.
 *
 * If `googleapis` is not installed, all exports degrade to stub functions
 * that log a warning and return null/empty arrays.
 */

import { createServiceClient } from '@/lib/supabase/service'

// ---------------------------------------------------------------------------
// Graceful dependency check
// ---------------------------------------------------------------------------

// eslint-disable-next-line @typescript-eslint/no-explicit-any
let google: any = null

try {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const googleapis = require('googleapis')
  google = googleapis.google
} catch {
  console.warn(
    '[gmail] googleapis package not installed — Gmail integration disabled. ' +
      'Run `npm install googleapis` to enable.'
  )
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const GMAIL_SCOPES = [
  'https://www.googleapis.com/auth/gmail.readonly',
  'https://www.googleapis.com/auth/gmail.send',
  'https://www.googleapis.com/auth/gmail.modify',
]

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface GmailTokens {
  access_token: string
  refresh_token: string
  expiry_date: number
  token_type: string
}

export interface ParsedEmail {
  messageId: string
  threadId: string
  from: string
  to: string
  subject: string
  body: string
  date: string
  labels: string[]
  /** Which gmail_connection this email came from */
  connectionId?: string
  /**
   * Select RFC-2822 headers that identify machine-generated bulk mail. Kept
   * lowercase-keyed. Only the headers the pipeline actually uses are carried:
   *   - list-unsubscribe      → bulk/list mail
   *   - list-id               → mailing list identifier
   *   - precedence            → 'bulk' | 'list' | 'junk' signals
   *   - auto-submitted        → 'auto-generated' / 'auto-replied' (RFC 3834)
   *   - return-path           → for bounce-adjacent detection
   * Consumers should treat a missing key as "absent" (no header).
   */
  headers?: Record<string, string>
}

/** Headers we capture from Gmail messages. Kept small and explicit. */
const CAPTURED_HEADERS = [
  'list-unsubscribe',
  'list-id',
  'precedence',
  'auto-submitted',
  'return-path',
] as const

function pickCapturedHeaders(
  headers: Array<{ name: string; value: string }>
): Record<string, string> {
  const out: Record<string, string> = {}
  for (const h of headers) {
    const key = (h.name || '').toLowerCase()
    if ((CAPTURED_HEADERS as readonly string[]).includes(key) && h.value) {
      out[key] = h.value
    }
  }
  return out
}

export interface GmailConnection {
  id: string
  venue_id: string
  user_id: string | null
  email_address: string
  gmail_tokens: GmailTokens
  is_primary: boolean
  label: string | null
  sync_enabled: boolean
  last_sync_at: string | null
  last_history_id: string | null
  status: string
  error_message: string | null
  created_at: string
  updated_at: string
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

function getOAuth2Client() {
  if (!google) return null

  const clientId = process.env.GOOGLE_CLIENT_ID
  const clientSecret = process.env.GOOGLE_CLIENT_SECRET

  if (!clientId || !clientSecret) {
    console.warn('[gmail] GOOGLE_CLIENT_ID or GOOGLE_CLIENT_SECRET not set')
    return null
  }

  return new google.auth.OAuth2(clientId, clientSecret)
}

/**
 * Migrate legacy venue_config.gmail_tokens to gmail_connections table.
 * Called on first access when no gmail_connections rows exist but
 * venue_config.gmail_tokens does.
 */
async function migrateLegacyTokens(venueId: string): Promise<GmailConnection | null> {
  const supabase = createServiceClient()

  const { data: config } = await supabase
    .from('venue_config')
    .select('gmail_tokens, coordinator_email')
    .eq('venue_id', venueId)
    .single()

  if (!config?.gmail_tokens) return null

  const tokens = config.gmail_tokens as GmailTokens
  const email = config.coordinator_email || 'unknown@gmail.com'

  // Insert into gmail_connections
  const { data: connection, error } = await supabase
    .from('gmail_connections')
    .insert({
      venue_id: venueId,
      email_address: email,
      gmail_tokens: tokens,
      is_primary: true,
      label: 'Primary Inbox',
      sync_enabled: true,
      status: 'active',
    })
    .select()
    .single()

  if (error) {
    console.error(`[gmail] Failed to migrate legacy tokens for venue ${venueId}:`, error.message)
    return null
  }

  console.log(`[gmail] Migrated legacy tokens to gmail_connections for venue ${venueId}`)
  return connection as GmailConnection
}

/**
 * Get all gmail connections for a venue. If none exist but legacy
 * venue_config.gmail_tokens does, migrate it first.
 */
export async function getConnections(venueId: string): Promise<GmailConnection[]> {
  const supabase = createServiceClient()

  const { data: connections } = await supabase
    .from('gmail_connections')
    .select('*')
    .eq('venue_id', venueId)
    .order('is_primary', { ascending: false })
    .order('created_at', { ascending: true })

  if (connections && connections.length > 0) {
    return connections as GmailConnection[]
  }

  // No connections — try migrating legacy tokens
  const migrated = await migrateLegacyTokens(venueId)
  if (migrated) return [migrated]

  return []
}

/**
 * Get a specific connection, or the primary one for the venue.
 */
async function getConnection(venueId: string, connectionId?: string): Promise<GmailConnection | null> {
  const supabase = createServiceClient()

  if (connectionId) {
    const { data } = await supabase
      .from('gmail_connections')
      .select('*')
      .eq('id', connectionId)
      .eq('venue_id', venueId)
      .single()
    return (data as GmailConnection) ?? null
  }

  // Get primary connection
  const { data: primary } = await supabase
    .from('gmail_connections')
    .select('*')
    .eq('venue_id', venueId)
    .eq('is_primary', true)
    .limit(1)
    .maybeSingle()

  if (primary) return primary as GmailConnection

  // Fallback: first active connection
  const { data: first } = await supabase
    .from('gmail_connections')
    .select('*')
    .eq('venue_id', venueId)
    .eq('status', 'active')
    .order('created_at', { ascending: true })
    .limit(1)
    .maybeSingle()

  if (first) return first as GmailConnection

  // Try legacy migration
  return await migrateLegacyTokens(venueId)
}

/**
 * Read stored Gmail tokens for a venue from venue_config (legacy).
 * Kept for backward compatibility during migration period.
 */
async function getStoredTokens(venueId: string): Promise<GmailTokens | null> {
  const supabase = createServiceClient()

  const { data, error } = await supabase
    .from('venue_config')
    .select('gmail_tokens')
    .eq('venue_id', venueId)
    .single()

  if (error || !data?.gmail_tokens) return null

  return data.gmail_tokens as GmailTokens
}

/**
 * Persist Gmail tokens to venue_config.gmail_tokens (legacy).
 */
async function storeTokens(venueId: string, tokens: GmailTokens): Promise<void> {
  const supabase = createServiceClient()

  const { error } = await supabase
    .from('venue_config')
    .update({ gmail_tokens: tokens })
    .eq('venue_id', venueId)

  if (error) {
    console.error(`[gmail] Failed to store tokens for venue ${venueId}:`, error.message)
  }
}

/**
 * Persist tokens to a gmail_connections row.
 */
async function storeConnectionTokens(connectionId: string, tokens: GmailTokens): Promise<void> {
  const supabase = createServiceClient()

  const { error } = await supabase
    .from('gmail_connections')
    .update({ gmail_tokens: tokens, updated_at: new Date().toISOString() })
    .eq('id', connectionId)

  if (error) {
    console.error(`[gmail] Failed to store tokens for connection ${connectionId}:`, error.message)
  }
}

/**
 * Ensure stored tokens are fresh. If the access token is expired (or will
 * expire within 5 minutes), use the refresh token to get a new one and
 * persist the updated tokens.
 */
async function ensureFreshTokens(
  tokens: GmailTokens,
  connectionId?: string,
  venueId?: string
): Promise<GmailTokens | null> {
  const bufferMs = 5 * 60 * 1000 // 5 minutes
  const isExpired = tokens.expiry_date < Date.now() + bufferMs

  if (!isExpired) return tokens

  const auth = getOAuth2Client()
  if (!auth) return null

  auth.setCredentials({
    access_token: tokens.access_token,
    refresh_token: tokens.refresh_token,
    expiry_date: tokens.expiry_date,
    token_type: tokens.token_type,
  })

  try {
    const { credentials } = await auth.refreshAccessToken()

    const refreshed: GmailTokens = {
      access_token: credentials.access_token!,
      refresh_token: credentials.refresh_token ?? tokens.refresh_token,
      expiry_date: credentials.expiry_date!,
      token_type: credentials.token_type ?? 'Bearer',
    }

    // Store refreshed tokens
    if (connectionId) {
      await storeConnectionTokens(connectionId, refreshed)
    } else if (venueId) {
      await storeTokens(venueId, refreshed)
    }

    console.log(`[gmail] Refreshed access token for ${connectionId ?? venueId}`)
    return refreshed
  } catch (err) {
    console.error(`[gmail] Token refresh failed:`, err)

    // Mark connection as error if we have a connectionId
    if (connectionId) {
      const supabase = createServiceClient()
      await supabase
        .from('gmail_connections')
        .update({
          status: 'error',
          error_message: 'Token refresh failed — reconnect Gmail',
          updated_at: new Date().toISOString(),
        })
        .eq('id', connectionId)
    }
    return null
  }
}

/**
 * Update the email_sync_state table after a sync attempt.
 */
async function updateSyncState(
  venueId: string,
  historyId: string | null,
  status: 'synced' | 'error',
  errorMessage?: string
): Promise<void> {
  const supabase = createServiceClient()

  const payload: Record<string, unknown> = {
    venue_id: venueId,
    status,
    last_sync_at: new Date().toISOString(),
    error_message: errorMessage ?? null,
  }

  if (historyId) {
    payload.last_history_id = historyId
  }

  const { error } = await supabase
    .from('email_sync_state')
    .upsert(payload, { onConflict: 'venue_id' })

  if (error) {
    console.error(`[gmail] Failed to update sync state for venue ${venueId}:`, error.message)
  }
}

/**
 * Update a connection's sync state.
 */
async function updateConnectionSyncState(
  connectionId: string,
  historyId: string | null,
  status: 'active' | 'error',
  errorMessage?: string
): Promise<void> {
  const supabase = createServiceClient()

  const payload: Record<string, unknown> = {
    last_sync_at: new Date().toISOString(),
    status,
    error_message: errorMessage ?? null,
    updated_at: new Date().toISOString(),
  }

  if (historyId) {
    payload.last_history_id = historyId
  }

  await supabase.from('gmail_connections').update(payload).eq('id', connectionId)
}

/**
 * Read the last sync state for a venue.
 */
async function getSyncState(
  venueId: string
): Promise<{ last_history_id: string | null; last_sync_at: string | null } | null> {
  const supabase = createServiceClient()

  const { data, error } = await supabase
    .from('email_sync_state')
    .select('last_history_id, last_sync_at')
    .eq('venue_id', venueId)
    .single()

  if (error || !data) return null

  return {
    last_history_id: data.last_history_id as string | null,
    last_sync_at: data.last_sync_at as string | null,
  }
}

/**
 * Extract a header value from a Gmail message's headers array.
 */
function getHeader(headers: Array<{ name: string; value: string }>, name: string): string {
  const header = headers.find((h) => h.name.toLowerCase() === name.toLowerCase())
  return header?.value ?? ''
}

// ---------------------------------------------------------------------------
// Exported: parseEmailBody
// ---------------------------------------------------------------------------

/**
 * Extract plain text body from a Gmail message payload.
 * Handles multipart/alternative and base64url encoding.
 */
export function parseEmailBody(payload: Record<string, unknown>): string {
  if (!payload) return ''

  // Simple single-part message
  const mimeType = payload.mimeType as string | undefined
  const body = payload.body as { data?: string; size?: number } | undefined

  if (mimeType === 'text/plain' && body?.data) {
    return Buffer.from(body.data, 'base64url').toString('utf-8')
  }

  // Multipart message — recurse into parts
  const parts = payload.parts as Array<Record<string, unknown>> | undefined
  if (parts && Array.isArray(parts)) {
    // Prefer text/plain over text/html
    for (const part of parts) {
      const partMime = part.mimeType as string | undefined
      const partBody = part.body as { data?: string; size?: number } | undefined

      if (partMime === 'text/plain' && partBody?.data) {
        return Buffer.from(partBody.data, 'base64url').toString('utf-8')
      }

      // Recurse into nested multipart
      if (partMime?.startsWith('multipart/')) {
        const nested = parseEmailBody(part)
        if (nested) return nested
      }
    }

    // Fallback: try text/html if no plain text found
    for (const part of parts) {
      const partMime = part.mimeType as string | undefined
      const partBody = part.body as { data?: string; size?: number } | undefined

      if (partMime === 'text/html' && partBody?.data) {
        // Return raw HTML — caller can strip tags if needed
        return Buffer.from(partBody.data, 'base64url').toString('utf-8')
      }
    }
  }

  // Last resort: body data on the top-level payload
  if (body?.data) {
    return Buffer.from(body.data, 'base64url').toString('utf-8')
  }

  return ''
}

// ---------------------------------------------------------------------------
// Exported: getOAuthUrl
// ---------------------------------------------------------------------------

/**
 * Generate a Google OAuth consent URL for Gmail access.
 * The venue ID is passed through the `state` parameter so the callback
 * knows which venue to associate the tokens with.
 */
export function getOAuthUrl(venueId: string, redirectUri: string): string | null {
  if (!google) {
    console.warn('[gmail] googleapis not available — cannot generate OAuth URL')
    return null
  }

  const auth = getOAuth2Client()
  if (!auth) return null

  auth.redirectUri = redirectUri

  return auth.generateAuthUrl({
    access_type: 'offline',
    scope: GMAIL_SCOPES,
    prompt: 'consent',
    state: venueId,
  })
}

// ---------------------------------------------------------------------------
// Exported: handleOAuthCallback
// ---------------------------------------------------------------------------

/**
 * Exchange an authorization code for tokens and store them.
 * Creates a gmail_connections row and also writes to venue_config for
 * backward compatibility.
 *
 * Returns the created connection ID on success, null on failure.
 */
export async function handleOAuthCallback(
  venueId: string,
  code: string,
  redirectUri: string,
  userId?: string
): Promise<string | null> {
  if (!google) {
    console.warn('[gmail] googleapis not available — cannot handle OAuth callback')
    return null
  }

  const auth = getOAuth2Client()
  if (!auth) return null

  auth.redirectUri = redirectUri

  try {
    const { tokens } = await auth.getToken(code)

    if (!tokens.access_token || !tokens.refresh_token) {
      console.error('[gmail] OAuth token exchange returned incomplete tokens')
      return null
    }

    const gmailTokens: GmailTokens = {
      access_token: tokens.access_token,
      refresh_token: tokens.refresh_token,
      expiry_date: tokens.expiry_date ?? Date.now() + 3600 * 1000,
      token_type: tokens.token_type ?? 'Bearer',
    }

    // Get email address from the token
    auth.setCredentials(gmailTokens)
    const gmail = google.gmail({ version: 'v1', auth })
    let emailAddress = 'unknown@gmail.com'
    try {
      const profile = await gmail.users.getProfile({ userId: 'me' })
      emailAddress = profile.data.emailAddress ?? emailAddress
    } catch {
      // Best effort
    }

    // Store in venue_config for backward compatibility
    await storeTokens(venueId, gmailTokens)

    const supabase = createServiceClient()

    // Check if any connection is primary for this venue
    const { data: existingPrimary } = await supabase
      .from('gmail_connections')
      .select('id')
      .eq('venue_id', venueId)
      .eq('is_primary', true)
      .limit(1)
      .maybeSingle()

    // Create gmail_connections row
    const { data: connection, error } = await supabase
      .from('gmail_connections')
      .upsert(
        {
          venue_id: venueId,
          user_id: userId ?? null,
          email_address: emailAddress,
          gmail_tokens: gmailTokens,
          is_primary: !existingPrimary, // primary if no existing primary
          label: null,
          sync_enabled: true,
          status: 'active',
          error_message: null,
          updated_at: new Date().toISOString(),
        },
        { onConflict: 'venue_id,email_address' }
      )
      .select('id')
      .single()

    if (error) {
      console.error(`[gmail] Failed to create gmail_connection for venue ${venueId}:`, error.message)
      // Tokens are still in venue_config, so old flow works
      return null
    }

    console.log(`[gmail] OAuth tokens stored for venue ${venueId} (connection ${connection.id})`)
    return connection.id as string
  } catch (err) {
    console.error(`[gmail] OAuth token exchange failed for venue ${venueId}:`, err)
    return null
  }
}

// ---------------------------------------------------------------------------
// Exported: getGmailClient
// ---------------------------------------------------------------------------

/**
 * Create an authenticated Gmail API client.
 *
 * If connectionId is provided, uses that specific connection's tokens.
 * Otherwise uses the primary connection for the venue.
 * Falls back to legacy venue_config.gmail_tokens if no connections exist.
 *
 * Returns null if no tokens are stored or googleapis is unavailable.
 */
export async function getGmailClient(venueId: string, connectionId?: string) {
  if (!google) {
    console.warn('[gmail] googleapis not available — cannot create Gmail client')
    return null
  }

  // Try connections first
  const connection = await getConnection(venueId, connectionId)

  if (connection) {
    const tokens = await ensureFreshTokens(connection.gmail_tokens, connection.id)
    if (!tokens) return null

    const auth = getOAuth2Client()
    if (!auth) return null

    auth.setCredentials({
      access_token: tokens.access_token,
      refresh_token: tokens.refresh_token,
      expiry_date: tokens.expiry_date,
      token_type: tokens.token_type,
    })

    return google.gmail({ version: 'v1', auth })
  }

  // Fallback to legacy venue_config tokens
  const storedTokens = await getStoredTokens(venueId)
  if (!storedTokens) {
    console.warn(`[gmail] No Gmail tokens found for venue ${venueId}`)
    return null
  }

  const tokens = await ensureFreshTokens(storedTokens, undefined, venueId)
  if (!tokens) return null

  const auth = getOAuth2Client()
  if (!auth) return null

  auth.setCredentials({
    access_token: tokens.access_token,
    refresh_token: tokens.refresh_token,
    expiry_date: tokens.expiry_date,
    token_type: tokens.token_type,
  })

  return google.gmail({ version: 'v1', auth })
}

// ---------------------------------------------------------------------------
// Exported: fetchNewEmails
// ---------------------------------------------------------------------------

/**
 * Fetch emails from ALL active gmail_connections for a venue.
 * Falls back to the legacy single-connection flow if no connections exist.
 *
 * Returns an array of parsed email objects, each tagged with the connectionId
 * it came from.
 */
export async function fetchNewEmails(
  venueId: string,
  maxResults = 50,
  opts?: { sinceDays?: number; extraQuery?: string; includeAllLabels?: boolean }
): Promise<ParsedEmail[]> {
  const connections = await getConnections(venueId)

  if (connections.length === 0) {
    // Legacy flow — single connection from venue_config
    return fetchNewEmailsLegacy(venueId, maxResults, opts)
  }

  const allEmails: ParsedEmail[] = []

  for (const conn of connections) {
    if (!conn.sync_enabled || conn.status === 'disconnected') continue

    try {
      const emails = await fetchNewEmailsFromConnection(conn, maxResults, opts)
      allEmails.push(...emails)
    } catch (err) {
      console.error(`[gmail] Failed to fetch from connection ${conn.id} (${conn.email_address}):`, err)
      const errorMessage = err instanceof Error ? err.message : String(err)
      await updateConnectionSyncState(conn.id, null, 'error', errorMessage)
    }
  }

  // Also update the venue-level sync state
  await updateSyncState(venueId, null, 'synced')

  console.log(`[gmail] Fetched ${allEmails.length} new emails across ${connections.length} connections for venue ${venueId}`)
  return allEmails
}

/**
 * Fetch emails from a specific gmail_connection.
 */
async function fetchNewEmailsFromConnection(
  conn: GmailConnection,
  maxResults: number,
  opts?: { sinceDays?: number; extraQuery?: string; includeAllLabels?: boolean }
): Promise<ParsedEmail[]> {
  const gmail = await getGmailClient(conn.venue_id, conn.id)
  if (!gmail) return []

  const emails: ParsedEmail[] = []

  try {
    let messageIds: string[] = []

    // Backfill mode: ignore history_id and pull the whole window. Used
    // when a venue onboards mid-flight and needs their existing inbox
    // imported, not just deltas.
    // When opts.extraQuery is set, force the list path — the history API
    // can't filter by Gmail search syntax.
    const forceListPath = (opts?.sinceDays && opts.sinceDays > 0) || Boolean(opts?.extraQuery)
    if (forceListPath) {
      messageIds = await fetchMessageIdsByList(gmail, maxResults, opts)
    } else if (conn.last_history_id) {
      // Incremental sync via history API
      try {
        const historyResponse = await gmail.users.history.list({
          userId: 'me',
          startHistoryId: conn.last_history_id,
          historyTypes: ['messageAdded'],
          maxResults,
        })

        const historyRecords = historyResponse.data.history ?? []

        for (const record of historyRecords) {
          const messagesAdded = record.messagesAdded ?? []
          for (const added of messagesAdded) {
            if (added.message?.id) {
              messageIds.push(added.message.id)
            }
          }
        }

        messageIds = [...new Set(messageIds)]
      } catch (historyErr: unknown) {
        const errObj = historyErr as { code?: number }
        if (errObj.code === 404) {
          console.warn(`[gmail] History ID expired for connection ${conn.id} — falling back to list`)
          messageIds = await fetchMessageIdsByList(gmail, maxResults, opts)
        } else {
          throw historyErr
        }
      }
    } else {
      messageIds = await fetchMessageIdsByList(gmail, maxResults, opts)
    }

    // Fetch full message details
    for (const messageId of messageIds.slice(0, maxResults)) {
      try {
        const msgResponse = await gmail.users.messages.get({
          userId: 'me',
          id: messageId,
          format: 'full',
        })

        const msg = msgResponse.data
        const headers = (msg.payload?.headers ?? []) as Array<{ name: string; value: string }>

        emails.push({
          messageId: msg.id ?? messageId,
          threadId: msg.threadId ?? '',
          from: getHeader(headers, 'From'),
          to: getHeader(headers, 'To'),
          subject: getHeader(headers, 'Subject'),
          body: parseEmailBody(msg.payload as Record<string, unknown>),
          date: getHeader(headers, 'Date'),
          labels: (msg.labelIds ?? []) as string[],
          connectionId: conn.id,
          headers: pickCapturedHeaders(headers),
        })
      } catch (msgErr) {
        console.error(`[gmail] Failed to fetch message ${messageId}:`, msgErr)
      }
    }

    // Get the current history ID for next sync
    const profileResponse = await gmail.users.getProfile({ userId: 'me' })
    const currentHistoryId = String(profileResponse.data.historyId ?? '')

    await updateConnectionSyncState(conn.id, currentHistoryId, 'active')
  } catch (err) {
    const errorMessage = err instanceof Error ? err.message : String(err)
    console.error(`[gmail] Sync failed for connection ${conn.id}:`, errorMessage)
    await updateConnectionSyncState(conn.id, null, 'error', errorMessage)
  }

  return emails
}

/**
 * Legacy single-connection fetch (for venues that haven't migrated).
 */
async function fetchNewEmailsLegacy(
  venueId: string,
  maxResults: number,
  opts?: { sinceDays?: number; extraQuery?: string; includeAllLabels?: boolean }
): Promise<ParsedEmail[]> {
  const gmail = await getGmailClient(venueId)
  if (!gmail) return []

  const syncState = await getSyncState(venueId)
  const emails: ParsedEmail[] = []

  try {
    let messageIds: string[] = []

    const forceListPathLegacy = (opts?.sinceDays && opts.sinceDays > 0) || Boolean(opts?.extraQuery)
    if (forceListPathLegacy) {
      messageIds = await fetchMessageIdsByList(gmail, maxResults, opts)
    } else if (syncState?.last_history_id) {
      try {
        const historyResponse = await gmail.users.history.list({
          userId: 'me',
          startHistoryId: syncState.last_history_id,
          historyTypes: ['messageAdded'],
          maxResults,
        })

        const historyRecords = historyResponse.data.history ?? []

        for (const record of historyRecords) {
          const messagesAdded = record.messagesAdded ?? []
          for (const added of messagesAdded) {
            if (added.message?.id) {
              messageIds.push(added.message.id)
            }
          }
        }

        messageIds = [...new Set(messageIds)]
      } catch (historyErr: unknown) {
        const errObj = historyErr as { code?: number }
        if (errObj.code === 404) {
          console.warn(`[gmail] History ID expired for venue ${venueId} — falling back to list`)
          messageIds = await fetchMessageIdsByList(gmail, maxResults, opts)
        } else {
          throw historyErr
        }
      }
    } else {
      messageIds = await fetchMessageIdsByList(gmail, maxResults, opts)
    }

    for (const messageId of messageIds.slice(0, maxResults)) {
      try {
        const msgResponse = await gmail.users.messages.get({
          userId: 'me',
          id: messageId,
          format: 'full',
        })

        const msg = msgResponse.data
        const headers = (msg.payload?.headers ?? []) as Array<{ name: string; value: string }>

        emails.push({
          messageId: msg.id ?? messageId,
          threadId: msg.threadId ?? '',
          from: getHeader(headers, 'From'),
          to: getHeader(headers, 'To'),
          subject: getHeader(headers, 'Subject'),
          body: parseEmailBody(msg.payload as Record<string, unknown>),
          date: getHeader(headers, 'Date'),
          labels: (msg.labelIds ?? []) as string[],
          headers: pickCapturedHeaders(headers),
        })
      } catch (msgErr) {
        console.error(`[gmail] Failed to fetch message ${messageId}:`, msgErr)
      }
    }

    const profileResponse = await gmail.users.getProfile({ userId: 'me' })
    const currentHistoryId = String(profileResponse.data.historyId ?? '')

    await updateSyncState(venueId, currentHistoryId, 'synced')

    console.log(`[gmail] Fetched ${emails.length} new emails for venue ${venueId}`)
  } catch (err) {
    const errorMessage = err instanceof Error ? err.message : String(err)
    console.error(`[gmail] Sync failed for venue ${venueId}:`, errorMessage)
    await updateSyncState(venueId, null, 'error', errorMessage)
  }

  return emails
}

/**
 * Fetch message IDs using the list API (used for initial sync or history fallback).
 *
 * Excludes Gmail's auto-categorised Promotions + Social buckets at fetch time.
 * Gmail's categoriser is very good — this alone drops 30–60% of noise before
 * it ever reaches our classifier, saving tokens and reducing false-positive
 * inquiries from newsletter blasts / LinkedIn notifications.
 *
 * Forums + Updates stay in; inquiry form submissions from Zola/Knot often
 * land in Updates.
 */
async function fetchMessageIdsByList(
  gmail: ReturnType<typeof google.gmail>,
  maxResults: number,
  opts?: { sinceDays?: number; extraQuery?: string; includeAllLabels?: boolean }
): Promise<string[]> {
  // Base query: strip Gmail's auto-categorised promos/social (the usual
  // suspects the classifier would filter out anyway). When sinceDays is
  // set we also add `newer_than:Nd` so backfill pulls the full window
  // instead of whatever the last 50 messages happen to be. extraQuery
  // lets a caller add additional Gmail search terms (e.g.
  // `from:(calendly.com OR honeybook.com)` for scheduling-tool backfill).
  const parts = ['-category:promotions', '-category:social']
  if (opts?.sinceDays && opts.sinceDays > 0) {
    parts.push(`newer_than:${Math.floor(opts.sinceDays)}d`)
  }
  if (opts?.extraQuery) parts.push(opts.extraQuery)
  const q = parts.join(' ')

  // Paginate through the list API so we can actually pull weeks of mail
  // for a backfill — Gmail caps per-page at 500. Default restricts to
  // INBOX — but scheduling-tool emails (Calendly in Gmail's Updates tab,
  // or auto-archived by user filters) often sit outside INBOX. Callers
  // that want to reach those pass includeAllLabels: true.
  const ids: string[] = []
  let pageToken: string | undefined = undefined
  const perPage = Math.min(500, Math.max(1, maxResults))
  while (ids.length < maxResults) {
    const remaining = maxResults - ids.length
    const pageSize = Math.min(perPage, remaining)
    const listArgs: Record<string, unknown> = {
      userId: 'me',
      maxResults: pageSize,
      q,
      ...(pageToken ? { pageToken } : {}),
    }
    if (!opts?.includeAllLabels) listArgs.labelIds = ['INBOX']
    const listResponse: { data: { messages?: Array<{ id?: string }>; nextPageToken?: string } } =
      await gmail.users.messages.list(listArgs)
    const batch: string[] = (listResponse.data.messages ?? [])
      .map((m) => m.id)
      .filter((id): id is string => !!id)
    ids.push(...batch)
    const next: string | undefined = listResponse.data.nextPageToken
    if (!next || batch.length === 0) break
    pageToken = next
  }
  return ids
}

// ---------------------------------------------------------------------------
// Exported: sendEmail
// ---------------------------------------------------------------------------

/**
 * Send an email (or reply if threadId is provided).
 * Constructs a proper MIME message with RFC 2822 headers.
 *
 * Returns the sent message ID, or null on failure.
 */
export async function sendEmail(
  venueId: string,
  to: string,
  subject: string,
  body: string,
  threadId?: string,
  connectionId?: string
): Promise<string | null> {
  const gmail = await getGmailClient(venueId, connectionId)
  if (!gmail) return null

  try {
    // Get the authenticated user's email for the From header
    const profileResponse = await gmail.users.getProfile({ userId: 'me' })
    const fromEmail = profileResponse.data.emailAddress ?? ''

    // Build RFC 2822 MIME message
    const messageParts = [
      `From: ${fromEmail}`,
      `To: ${to}`,
      `Subject: ${subject}`,
      'MIME-Version: 1.0',
      'Content-Type: text/plain; charset="UTF-8"',
    ]

    // If replying to a thread, add In-Reply-To and References headers
    if (threadId) {
      try {
        const threadResponse = await gmail.users.threads.get({
          userId: 'me',
          id: threadId,
          format: 'metadata',
          metadataHeaders: ['Message-ID'],
        })

        const messages = threadResponse.data.messages ?? []
        if (messages.length > 0) {
          const lastMessage = messages[messages.length - 1]
          const lastHeaders = (lastMessage.payload?.headers ?? []) as Array<{
            name: string
            value: string
          }>
          const lastMessageId = getHeader(lastHeaders, 'Message-ID')
          if (lastMessageId) {
            messageParts.push(`In-Reply-To: ${lastMessageId}`)
            messageParts.push(`References: ${lastMessageId}`)
          }
        }
      } catch (threadErr) {
        console.warn(`[gmail] Could not fetch thread ${threadId} for reply headers:`, threadErr)
      }
    }

    // Blank line separates headers from body
    messageParts.push('', body)

    const rawMessage = messageParts.join('\r\n')
    const encodedMessage = Buffer.from(rawMessage).toString('base64url')

    const sendParams: { userId: string; requestBody: { raw: string; threadId?: string } } = {
      userId: 'me',
      requestBody: { raw: encodedMessage },
    }

    if (threadId) {
      sendParams.requestBody.threadId = threadId
    }

    const sendResponse = await gmail.users.messages.send(sendParams)

    console.log(
      `[gmail] Sent email to ${to} for venue ${venueId} (message ID: ${sendResponse.data.id})`
    )

    return sendResponse.data.id ?? null
  } catch (err) {
    console.error(`[gmail] Failed to send email for venue ${venueId}:`, err)
    return null
  }
}
