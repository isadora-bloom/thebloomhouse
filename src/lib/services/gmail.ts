/**
 * Bloom House: Gmail API Service
 *
 * Fetches and sends emails via the Gmail API using the `googleapis` package.
 * Handles OAuth token storage per venue (in venue_config.gmail_tokens) and
 * tracks sync state in the email_sync_state table.
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
 * Read stored Gmail tokens for a venue from venue_config.
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
 * Persist Gmail tokens to venue_config.gmail_tokens.
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
 * Ensure stored tokens are fresh. If the access token is expired (or will
 * expire within 5 minutes), use the refresh token to get a new one and
 * persist the updated tokens.
 */
async function ensureFreshTokens(
  venueId: string,
  tokens: GmailTokens
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

    await storeTokens(venueId, refreshed)
    console.log(`[gmail] Refreshed access token for venue ${venueId}`)
    return refreshed
  } catch (err) {
    console.error(`[gmail] Token refresh failed for venue ${venueId}:`, err)
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
 * Exchange an authorization code for tokens and store them in venue_config.
 * Returns true on success, false on failure.
 */
export async function handleOAuthCallback(
  venueId: string,
  code: string,
  redirectUri: string
): Promise<boolean> {
  if (!google) {
    console.warn('[gmail] googleapis not available — cannot handle OAuth callback')
    return false
  }

  const auth = getOAuth2Client()
  if (!auth) return false

  auth.redirectUri = redirectUri

  try {
    const { tokens } = await auth.getToken(code)

    if (!tokens.access_token || !tokens.refresh_token) {
      console.error('[gmail] OAuth token exchange returned incomplete tokens')
      return false
    }

    const gmailTokens: GmailTokens = {
      access_token: tokens.access_token,
      refresh_token: tokens.refresh_token,
      expiry_date: tokens.expiry_date ?? Date.now() + 3600 * 1000,
      token_type: tokens.token_type ?? 'Bearer',
    }

    await storeTokens(venueId, gmailTokens)
    console.log(`[gmail] OAuth tokens stored for venue ${venueId}`)
    return true
  } catch (err) {
    console.error(`[gmail] OAuth token exchange failed for venue ${venueId}:`, err)
    return false
  }
}

// ---------------------------------------------------------------------------
// Exported: getGmailClient
// ---------------------------------------------------------------------------

/**
 * Create an authenticated Gmail API client from stored tokens.
 * Handles token refresh if the access token is expired.
 * Returns null if no tokens are stored or googleapis is unavailable.
 */
export async function getGmailClient(venueId: string) {
  if (!google) {
    console.warn('[gmail] googleapis not available — cannot create Gmail client')
    return null
  }

  const storedTokens = await getStoredTokens(venueId)
  if (!storedTokens) {
    console.warn(`[gmail] No Gmail tokens found for venue ${venueId}`)
    return null
  }

  const tokens = await ensureFreshTokens(venueId, storedTokens)
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
 * Fetch emails since last sync using the history API (or list API for the
 * initial sync when no history ID exists). Updates email_sync_state.
 *
 * Returns an array of parsed email objects.
 */
export async function fetchNewEmails(
  venueId: string,
  maxResults = 50
): Promise<ParsedEmail[]> {
  const gmail = await getGmailClient(venueId)
  if (!gmail) return []

  const syncState = await getSyncState(venueId)
  const emails: ParsedEmail[] = []

  try {
    let messageIds: string[] = []

    if (syncState?.last_history_id) {
      // Incremental sync via history API
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

        // Deduplicate
        messageIds = [...new Set(messageIds)]
      } catch (historyErr: unknown) {
        // History ID may have expired (404) — fall back to list
        const errObj = historyErr as { code?: number }
        if (errObj.code === 404) {
          console.warn(`[gmail] History ID expired for venue ${venueId} — falling back to list`)
          messageIds = await fetchMessageIdsByList(gmail, maxResults)
        } else {
          throw historyErr
        }
      }
    } else {
      // Initial sync — use list API
      messageIds = await fetchMessageIdsByList(gmail, maxResults)
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
        })
      } catch (msgErr) {
        console.error(`[gmail] Failed to fetch message ${messageId}:`, msgErr)
      }
    }

    // Get the current history ID for next sync
    const profileResponse = await gmail.users.getProfile({ userId: 'me' })
    const currentHistoryId = String(profileResponse.data.historyId ?? '')

    await updateSyncState(venueId, currentHistoryId, 'synced')

    console.log(
      `[gmail] Fetched ${emails.length} new emails for venue ${venueId}`
    )
  } catch (err) {
    const errorMessage = err instanceof Error ? err.message : String(err)
    console.error(`[gmail] Sync failed for venue ${venueId}:`, errorMessage)
    await updateSyncState(venueId, null, 'error', errorMessage)
  }

  return emails
}

/**
 * Fetch message IDs using the list API (used for initial sync or history fallback).
 */
async function fetchMessageIdsByList(
  gmail: ReturnType<typeof google.gmail>,
  maxResults: number
): Promise<string[]> {
  const listResponse = await gmail.users.messages.list({
    userId: 'me',
    maxResults,
    labelIds: ['INBOX'],
  })

  return (listResponse.data.messages ?? [])
    .map((m: { id?: string }) => m.id)
    .filter((id: string | undefined): id is string => !!id)
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
  threadId?: string
): Promise<string | null> {
  const gmail = await getGmailClient(venueId)
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
