/**
 * One signed-state implementation for every outbound OAuth round trip
 * that is not Gmail. S2, 2026-09-14 security audit.
 *
 * What was wrong with the four it replaces:
 *
 *   - google-ads-oauth.ts (shared by Meta Ads and TikTok Ads through
 *     marketing-spend/connectors/shared.ts) and instagram-meta.ts both
 *     signed the state with CRON_SECRET. That is the cron and admin-ops
 *     bearer token. Anyone holding it could mint a state for any venue,
 *     and every venue's OAuth round trip was one env var away from the
 *     whole ops surface.
 *   - /api/auth/zoom fell back through ZOOM_STATE_SECRET → CRON_SECRET →
 *     NEXTAUTH_SECRET → the string literal 'bloom-zoom-state-dev-secret',
 *     which is in the repository. On a deploy with none of those three
 *     set, the signing key was public.
 *   - None of them bound the state to the user who started the flow,
 *     only to the venue, so any member of a venue could complete another
 *     member's consent round trip.
 *   - None of them consumed the state. A captured callback URL replayed
 *     inside the ten-minute window worked every time.
 *
 * The shape here follows `src/lib/services/email/gmail-oauth-state.ts`,
 * which already got this right: base64url(payload) + '.' + base64url(hmac),
 * keyed on STATE_SIGNING_SECRET, throwing when that is unset rather than
 * falling back to an empty key. Same key, same failure mode, one module.
 *
 * REPLAY WINDOW — read this before trusting the nonce
 * ===================================================
 * The consumed-nonce set lives in the process, not the database. On
 * Vercel that means a replay is caught only when it lands on the same
 * lambda instance as the first use. It is a real defence against the
 * common case (a callback URL sitting in browser history, a referrer
 * leak, a shoulder-surfed address bar) and not a guarantee. The three
 * checks that always hold are the signature, the ten-minute expiry, and
 * the live-session identity check the callbacks do against the payload.
 * Promote the set to a table if a provider ever needs a hard guarantee.
 */

import { createHmac, randomUUID, timingSafeEqual } from 'node:crypto'

/** Ten minutes. Longer than any consent screen takes, short enough that a
 *  leaked callback URL is stale by the time it is found. */
export const OAUTH_STATE_TTL_MS = 10 * 60 * 1000

/** Which flow the state belongs to. Mixing them is a bug, so it is signed. */
export type OAuthStateProvider =
  | 'google_ads'
  | 'meta_ads'
  | 'tiktok_ads'
  | 'instagram'
  | 'zoom'

export interface OAuthStatePayload {
  provider: OAuthStateProvider
  /** Venue the connection will land on. */
  venueId: string
  /** The user who clicked Connect. Re-checked against the live session. */
  userId: string
  /** Single-use marker. */
  nonce: string
  /** Issue time, ms since epoch. */
  ts: number
  /** Where to send the operator afterwards. Zoom uses it; the rest do not. */
  returnTo?: string
}

export type OAuthStateVerifyResult =
  | { ok: true; payload: OAuthStatePayload }
  | { ok: false; reason: OAuthStateFailure }

export type OAuthStateFailure =
  | 'missing'
  | 'not_configured'
  | 'malformed'
  | 'bad_signature'
  | 'expired'
  | 'replayed'
  | 'provider_mismatch'

// ---------------------------------------------------------------------------
// Key
// ---------------------------------------------------------------------------

/**
 * Same contract as demo-token.ts and gmail-oauth-state.ts: throw rather
 * than sign with a fallback. A state token signed with a key an attacker
 * can guess is worse than no state token, because the callback trusts it.
 */
function getSigningKey(): Buffer {
  const secret = process.env.STATE_SIGNING_SECRET
  if (!secret || secret.length < 16) {
    throw new Error(
      'STATE_SIGNING_SECRET is missing or too short (need >= 16 chars). ' +
        'Generate with `openssl rand -hex 32` and set in .env.local + Vercel.',
    )
  }
  return Buffer.from(secret, 'utf-8')
}

/** True when a state token can be minted at all. Lets a /start route answer
 *  503 with a useful message instead of throwing a 500. */
export function isOAuthStateConfigured(): boolean {
  try {
    getSigningKey()
    return true
  } catch {
    return false
  }
}

// ---------------------------------------------------------------------------
// Consumed-nonce set
// ---------------------------------------------------------------------------

/** nonce -> the ms timestamp after which the entry can be forgotten. */
const consumedNonces = new Map<string, number>()

/** Bound the set so a flood of callbacks cannot grow it without limit. */
const MAX_TRACKED_NONCES = 10_000

function sweepExpiredNonces(now: number): void {
  for (const [nonce, expiresAt] of consumedNonces) {
    if (expiresAt <= now) consumedNonces.delete(nonce)
  }
}

/**
 * Record a nonce as used. Returns false when it was already used, which
 * is the replay case.
 */
function consumeNonce(nonce: string, now: number): boolean {
  sweepExpiredNonces(now)
  if (consumedNonces.has(nonce)) return false
  if (consumedNonces.size >= MAX_TRACKED_NONCES) {
    // Drop the oldest insertion. Map iterates in insertion order, and the
    // oldest entry is the one closest to expiring anyway.
    const oldest = consumedNonces.keys().next()
    if (!oldest.done) consumedNonces.delete(oldest.value)
  }
  consumedNonces.set(nonce, now + OAUTH_STATE_TTL_MS)
  return true
}

/** Test seam. Not called by any route. */
export function __resetConsumedNoncesForTest(): void {
  consumedNonces.clear()
}

// ---------------------------------------------------------------------------
// Mint
// ---------------------------------------------------------------------------

/**
 * Mint a signed, single-use state token. Throws when STATE_SIGNING_SECRET
 * is unset — call isOAuthStateConfigured() first if you would rather
 * answer 503 than 500.
 */
export function mintOAuthState(input: {
  provider: OAuthStateProvider
  venueId: string
  userId: string
  returnTo?: string
}): string {
  const payload: OAuthStatePayload = {
    provider: input.provider,
    venueId: input.venueId,
    userId: input.userId,
    nonce: randomUUID(),
    ts: Date.now(),
    ...(input.returnTo ? { returnTo: input.returnTo } : {}),
  }
  const payloadB64 = Buffer.from(JSON.stringify(payload), 'utf-8').toString('base64url')
  const sig = createHmac('sha256', getSigningKey()).update(payloadB64).digest('base64url')
  return `${payloadB64}.${sig}`
}

// ---------------------------------------------------------------------------
// Verify
// ---------------------------------------------------------------------------

/**
 * Verify signature, provider, freshness and single use. Identity is NOT
 * checked here: the callback compares payload.venueId / payload.userId
 * against its own live session, which is the check that matters and the
 * one a caller must not be able to skip by passing the wrong argument.
 *
 * A successful verify consumes the nonce, so calling this twice on the
 * same token fails the second time even within the TTL.
 */
export function verifyOAuthState(
  token: string | null | undefined,
  expectedProvider: OAuthStateProvider,
): OAuthStateVerifyResult {
  if (!token) return { ok: false, reason: 'missing' }

  let key: Buffer
  try {
    key = getSigningKey()
  } catch {
    return { ok: false, reason: 'not_configured' }
  }

  const dot = token.lastIndexOf('.')
  if (dot < 1 || dot === token.length - 1) return { ok: false, reason: 'malformed' }

  const payloadB64 = token.slice(0, dot)
  const sig = token.slice(dot + 1)

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

  let payload: OAuthStatePayload
  try {
    payload = JSON.parse(
      Buffer.from(payloadB64, 'base64url').toString('utf-8'),
    ) as OAuthStatePayload
  } catch {
    return { ok: false, reason: 'malformed' }
  }

  if (
    !payload ||
    typeof payload.provider !== 'string' ||
    typeof payload.venueId !== 'string' ||
    typeof payload.userId !== 'string' ||
    typeof payload.nonce !== 'string' ||
    typeof payload.ts !== 'number' ||
    (payload.returnTo !== undefined && typeof payload.returnTo !== 'string')
  ) {
    return { ok: false, reason: 'malformed' }
  }

  if (payload.provider !== expectedProvider) {
    return { ok: false, reason: 'provider_mismatch' }
  }

  const now = Date.now()
  const age = now - payload.ts
  if (age < 0 || age > OAUTH_STATE_TTL_MS) return { ok: false, reason: 'expired' }

  if (!consumeNonce(payload.nonce, now)) return { ok: false, reason: 'replayed' }

  return { ok: true, payload }
}
