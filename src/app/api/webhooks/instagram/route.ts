/**
 * /api/webhooks/instagram — Meta Messaging webhook for Instagram DMs.
 *
 * Wave 3, W28. Spec: HANDLE-IDENTITY-SPEC.md §4.
 *
 * GET  — Meta's subscription handshake. Echoes hub.challenge back as
 *        plain text when hub.verify_token matches INSTAGRAM_VERIFY_TOKEN.
 * POST — an event batch. The body is HMAC-signed with the app secret and
 *        arrives as X-Hub-Signature-256.
 *
 * Env-gated and dry until credentials exist: with any of the three env
 * vars unset the route answers 503 `instagram_not_configured` and does
 * nothing else. Same posture as /api/webhooks/twilio, which refuses
 * until TWILIO_AUTH_TOKEN lands. No crash, no half-processing.
 *
 * Verification follows the repo's own pattern rather than Meta's sample
 * code: read the raw body FIRST, verify against those exact bytes, parse
 * second. That is what /api/webhooks/calendly does, and it is the only
 * order that works, because any reserialise changes the bytes the HMAC
 * was computed over.
 *
 * Acknowledge fast, work after. Meta retries on any non-2xx and escalates
 * to disabling the subscription after repeated failures, so this route
 * returns 200 for everything except a failed signature (401) and a
 * missing configuration (503). Ingestion runs after the response is
 * constructed, bounded by MAX_MESSAGES_PER_DELIVERY, and every failure
 * inside it is caught and logged rather than thrown.
 *
 * Multi-venue routing is by entry[].id, the Instagram business account
 * id, looked up against instagram_connections (migration 401). An event
 * for an account no venue claims is logged and dropped, never guessed at.
 */

import { NextRequest, NextResponse } from 'next/server'
import { createServiceClient } from '@/lib/supabase/service'
import {
  checkVerifyHandshake,
  findConnectionByIgBusinessId,
  readInstagramEnv,
  verifyMetaSignature,
} from '@/lib/services/integrations/instagram-meta'
import {
  ingestInstagramDm,
  parseInstagramWebhook,
  type InstagramInboundMessage,
} from '@/lib/services/ingestion/instagram-dm'
import { apiError } from '@/lib/api/api-error'

/**
 * Ceiling on one delivery. Meta batches, and an unbounded loop inside a
 * serverless function is how you turn a busy hour into a timeout. Anything
 * over the ceiling is logged with its message ids so it can be replayed;
 * dropping it silently would break the standing rule that information
 * cannot go unsurfaced.
 */
const MAX_MESSAGES_PER_DELIVERY = 25

function notConfigured(missing: string[]): NextResponse {
  return NextResponse.json(
    {
      error: 'instagram_not_configured',
      missing,
      message:
        'Instagram DMs need INSTAGRAM_APP_ID, INSTAGRAM_APP_SECRET and ' +
        'INSTAGRAM_VERIFY_TOKEN set on the server. See ' +
        '/settings/integrations/instagram.',
    },
    { status: 503 },
  )
}

// ---------------------------------------------------------------------------
// GET — subscription handshake
// ---------------------------------------------------------------------------

export async function GET(request: NextRequest) {
  const envCheck = readInstagramEnv()
  if (!envCheck.ok) return notConfigured(envCheck.missing)

  const challenge = checkVerifyHandshake(
    request.nextUrl.searchParams,
    envCheck.env.verifyToken,
  )
  if (challenge === null) {
    console.warn('[webhook/instagram] verification handshake refused')
    return NextResponse.json({ error: 'verification_failed' }, { status: 403 })
  }

  // Meta wants the challenge back as bare text, not JSON.
  return new NextResponse(challenge, {
    status: 200,
    headers: { 'Content-Type': 'text/plain; charset=utf-8' },
  })
}

// ---------------------------------------------------------------------------
// POST — event batch
// ---------------------------------------------------------------------------

export async function POST(request: NextRequest) {
  const envCheck = readInstagramEnv()
  if (!envCheck.ok) return notConfigured(envCheck.missing)

  // Raw bytes first. The signature is over these exact bytes.
  let rawBody: string
  try {
    rawBody = await request.text()
  } catch (err) {
    return apiError(err, undefined, 400)
  }

  const signature = request.headers.get('x-hub-signature-256')
  if (!verifyMetaSignature(rawBody, signature, envCheck.env.appSecret)) {
    console.warn('[webhook/instagram] signature verification failed', {
      hasHeader: Boolean(signature),
      bodyBytes: rawBody.length,
    })
    return NextResponse.json({ error: 'invalid_signature' }, { status: 401 })
  }

  let body: unknown
  try {
    body = JSON.parse(rawBody)
  } catch {
    // Signed but unparseable. Acknowledge so Meta stops retrying a body
    // that will never parse, and log it loudly.
    console.error('[webhook/instagram] signed body was not JSON')
    return NextResponse.json({ received: true, parsed: false })
  }

  const messages = parseInstagramWebhook(body)
  if (messages.length === 0) {
    // Read receipts, reactions, echoes, or a non-instagram object. All
    // legitimate; nothing to ingest.
    return NextResponse.json({ received: true, ingested: 0 })
  }

  const accepted = messages.slice(0, MAX_MESSAGES_PER_DELIVERY)
  if (messages.length > accepted.length) {
    console.warn(
      `[webhook/instagram] delivery carried ${messages.length} messages, ` +
        `processing ${accepted.length}. Deferred mids: ` +
        messages
          .slice(MAX_MESSAGES_PER_DELIVERY)
          .map((m) => m.mid)
          .join(','),
    )
  }

  const summary = await processMessages(accepted)

  return NextResponse.json({
    received: true,
    ingested: summary.linked,
    duplicates: summary.duplicates,
    dropped: summary.dropped,
  })
}

interface ProcessSummary {
  linked: number
  duplicates: number
  dropped: number
}

/**
 * Route each message to its venue and ingest it. Bounded, sequential,
 * and fail-soft per message: one bad message must not cost the rest of
 * the batch.
 *
 * Connection lookups are memoised per delivery because Meta batches by
 * account, so the common case is one lookup serving every message.
 */
async function processMessages(
  messages: InstagramInboundMessage[],
): Promise<ProcessSummary> {
  const supabase = createServiceClient()
  const summary: ProcessSummary = { linked: 0, duplicates: 0, dropped: 0 }
  const connectionCache = new Map<
    string,
    Awaited<ReturnType<typeof findConnectionByIgBusinessId>>
  >()

  for (const message of messages) {
    try {
      let resolved = connectionCache.get(message.igBusinessId)
      if (resolved === undefined) {
        resolved = await findConnectionByIgBusinessId(message.igBusinessId)
        connectionCache.set(message.igBusinessId, resolved)
      }
      if (!resolved) {
        summary.dropped += 1
        console.warn(
          `[webhook/instagram] no venue claims Instagram account ` +
            `${message.igBusinessId} (mid ${message.mid}). Connect it at ` +
            '/settings/integrations/instagram.',
        )
        continue
      }

      const result = await ingestInstagramDm({
        supabase,
        venueId: resolved.connection.venueId,
        pageToken: resolved.pageToken,
        message,
      })

      if (result.outcome === 'linked') summary.linked += 1
      else if (result.outcome === 'duplicate') summary.duplicates += 1
      else summary.dropped += 1

      console.log(
        `[webhook/instagram] mid=${message.mid} outcome=${result.outcome} ` +
          `handle=${result.handleResolved ? 'resolved' : 'unresolved'} ` +
          `action=${result.action ?? 'n/a'} ` +
          `couple=${result.matchedCoupleId ?? 'none'}`,
      )
    } catch (err) {
      summary.dropped += 1
      console.error(
        `[webhook/instagram] message ${message.mid} failed:`,
        err instanceof Error ? err.message : err,
      )
    }
  }

  return summary
}
