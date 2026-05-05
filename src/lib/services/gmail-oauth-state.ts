/**
 * Gmail OAuth — HMAC-signed state token (PROJECT-AUDIT-V2 GAP-13).
 *
 * The OAuth `state` parameter is the only piece of data that survives
 * the round-trip through Google's consent screen. We use it to:
 *   - prevent CSRF (a stolen authorization code can only be redeemed
 *     by a request that knows the matching state nonce)
 *   - bind the callback to the exact venue / user that initiated the
 *     flow (so the callback never trusts client-side query params)
 *   - enforce a 10-minute freshness window on the consent flow
 *
 * The token is a base64url(`payload.signature`) where payload is a
 * JSON document and signature is HMAC-SHA256 over the payload bytes
 * keyed by STATE_SIGNING_SECRET.
 *
 * If STATE_SIGNING_SECRET is not configured, sign/verify both fail
 * closed — no implicit fallback to an empty key.
 */

import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto'

export interface GmailOAuthStatePayload {
  /** UUID of the venue the connection will land in. */
  venueId: string
  /** UUID of the user who initiated the flow. */
  userId: string
  /** Random nonce to make every state unique even within the same ms. */
  nonce: string
  /** Issue time, ms since epoch. */
  ts: number
  /** Path to redirect back to after success/failure. */
  returnTo: string
}

const TEN_MINUTES_MS = 10 * 60 * 1000

function getSigningKey(): Buffer {
  const secret = process.env.STATE_SIGNING_SECRET
  if (!secret || secret.length < 16) {
    throw new Error('STATE_SIGNING_SECRET is missing or too short (need >= 16 chars)')
  }
  return Buffer.from(secret, 'utf-8')
}

/**
 * Mint a fresh signed state token. The caller passes the venue/user
 * context they just authenticated; the token captures it for the
 * callback to verify.
 */
export function signGmailOAuthState(input: {
  venueId: string
  userId: string
  returnTo: string
}): string {
  const payload: GmailOAuthStatePayload = {
    venueId: input.venueId,
    userId: input.userId,
    nonce: randomBytes(16).toString('hex'),
    ts: Date.now(),
    returnTo: input.returnTo,
  }
  const payloadJson = JSON.stringify(payload)
  const payloadB64 = Buffer.from(payloadJson, 'utf-8').toString('base64url')
  const sig = createHmac('sha256', getSigningKey())
    .update(payloadB64)
    .digest('base64url')
  return `${payloadB64}.${sig}`
}

export type StateVerifyResult =
  | { ok: true; payload: GmailOAuthStatePayload }
  | { ok: false; reason: 'missing' | 'malformed' | 'bad_signature' | 'expired' | 'not_configured' }

/**
 * Verify a signed state token. Returns a tagged union so callers can
 * surface the precise failure mode (telemetry, error codes).
 */
export function verifyGmailOAuthState(token: string | null | undefined): StateVerifyResult {
  if (!token) return { ok: false, reason: 'missing' }

  let key: Buffer
  try {
    key = getSigningKey()
  } catch {
    return { ok: false, reason: 'not_configured' }
  }

  const dot = token.lastIndexOf('.')
  if (dot < 1 || dot === token.length - 1) {
    return { ok: false, reason: 'malformed' }
  }
  const payloadB64 = token.slice(0, dot)
  const sig = token.slice(dot + 1)

  // Constant-time signature compare to thwart timing attacks.
  let expected: string
  try {
    expected = createHmac('sha256', key).update(payloadB64).digest('base64url')
  } catch {
    return { ok: false, reason: 'malformed' }
  }
  const a = Buffer.from(sig, 'utf-8')
  const b = Buffer.from(expected, 'utf-8')
  if (a.length !== b.length || !timingSafeEqual(a, b)) {
    return { ok: false, reason: 'bad_signature' }
  }

  // Decode + freshness window
  let payload: GmailOAuthStatePayload
  try {
    const json = Buffer.from(payloadB64, 'base64url').toString('utf-8')
    payload = JSON.parse(json) as GmailOAuthStatePayload
  } catch {
    return { ok: false, reason: 'malformed' }
  }

  if (
    !payload ||
    typeof payload.venueId !== 'string' ||
    typeof payload.userId !== 'string' ||
    typeof payload.nonce !== 'string' ||
    typeof payload.ts !== 'number' ||
    typeof payload.returnTo !== 'string'
  ) {
    return { ok: false, reason: 'malformed' }
  }

  const age = Date.now() - payload.ts
  if (age < 0 || age > TEN_MINUTES_MS) {
    return { ok: false, reason: 'expired' }
  }

  return { ok: true, payload }
}

/**
 * Clamp a returnTo path to safe values. Only relative paths on our
 * own domain are allowed — never absolute URLs (open-redirect).
 */
export function safeReturnTo(raw: string | null | undefined, fallback = '/settings/gmail'): string {
  if (!raw) return fallback
  if (typeof raw !== 'string') return fallback
  if (!raw.startsWith('/')) return fallback
  if (raw.startsWith('//')) return fallback
  return raw
}
