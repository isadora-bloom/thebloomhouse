/**
 * Demo identity — HMAC-signed, HttpOnly token for the /demo entry path.
 *
 * The pre-fix design wrote `bloom_demo=true` from client-side JS via
 * document.cookie. That cookie was an unforgeable "I am the demo" token
 * to the rest of the server: requirePlan early-returned ok, getPlatformAuth
 * returned the demo coordinator, resolvePlatformScope returned Hawthorne,
 * and /api/portal/sage trusted body.venueId/weddingId outright. A paid
 * coordinator on starter tier could flip the cookie in DevTools and run
 * Sage against their REAL venue's data — free Intelligence-tier Sage
 * forever. Three independent audits (engineer F1+F13, YC B4, venue
 * operator G/21) flagged this as the worst revenue hole in the codebase.
 *
 * Root-cause fix: the demo identity is now a server-issued, HMAC-SHA256
 * signed, HttpOnly cookie. JS cannot read or write it. Tampered or
 * expired tokens fall through to normal auth.
 *
 * Token shape: base64url(payloadJson) + '.' + base64url(hmac).
 *
 * Mirrors the working pattern in `gmail-oauth-state.ts`. Constant-time
 * compare via `crypto.timingSafeEqual` — never `===` on signatures.
 */

import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto'
import { recordCounter } from '@/lib/observability/metrics'
import { redactError } from '@/lib/observability/redact'

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/**
 * Cookie name for the signed token. Distinct from the legacy `bloom_demo`
 * value-cookie name so the new code path is unambiguous in greps.
 *
 * Old code wrote `bloom_demo=true` from JS — an open bypass. New code
 * writes `bloom_demo_token=<signed>` from the server with HttpOnly. Old
 * cookies on existing clients are inert (no reader) and expire with their
 * existing 24h TTL.
 */
export const DEMO_TOKEN_COOKIE = 'bloom_demo_token'

/**
 * Companion non-HttpOnly UI hint cookie. Set alongside the token cookie
 * when minting; cleared alongside on exit. Client components that only
 * needed to KNOW the user is in demo mode (DemoBanner visibility,
 * default-IDs in hooks, gear-menu role override) read THIS instead of
 * the auth-bearing token.
 *
 * The hint has ZERO auth power on the server — every server-side check
 * verifies the signed token, never the hint. A user that flips
 * `bloom_demo_hint=1` in DevTools just gets a confused-looking demo
 * banner; the next API call fails plan gating because the token is
 * missing.
 */
export const DEMO_HINT_COOKIE = 'bloom_demo_hint'

/** 24h validity, matching the legacy `bloom_demo` cookie's max-age. */
const TWENTY_FOUR_HOURS_MS = 24 * 60 * 60 * 1000

/** Cookie max-age in seconds — 24 hours, matches the token expiry. */
export const DEMO_TOKEN_MAX_AGE_SECONDS = 24 * 60 * 60

/**
 * Crestwood Collection demo venue (Hawthorne Manor). The legacy code
 * spread this UUID across resolve-platform-scope.ts, auth-helpers.ts,
 * and use-venue-id.ts as DEMO_VENUE_ID. We embed it in the signed
 * payload so the server reads the venue id from the verified token,
 * not a hardcoded constant — any future demo-venue swap touches one
 * line here.
 */
export const DEMO_VENUE_ID = '22222222-2222-2222-2222-222222222201'

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface DemoTokenPayload {
  /** Token kind — sentinel so other token shapes can't masquerade. */
  kind: 'demo'
  /** Issued-at, ms since epoch. */
  iat: number
  /** Expires-at, ms since epoch. */
  exp: number
  /** Random nonce so two tokens minted in the same ms differ. */
  nonce: string
  /** Demo venue UUID baked into the verified payload. */
  demo_venue_id: string
}

export type DemoVerifyResult =
  | { ok: true; payload: DemoTokenPayload }
  | {
      ok: false
      reason: 'missing' | 'malformed' | 'tampered' | 'expired' | 'wrong_kind' | 'not_configured'
    }

// ---------------------------------------------------------------------------
// Key resolution
// ---------------------------------------------------------------------------

/**
 * Resolve the HMAC signing key. Throws on missing/short secrets so the
 * env var is impossible to forget — fail-closed is the only safe posture
 * for an auth-bearing token.
 *
 * - Production: missing → throw (loud in Vercel logs, request 500s, ops fixes).
 * - Dev: same posture. NO `if NODE_ENV === 'development'` backdoor — that
 *   was the CSRF-token shape that bit Stream B in 2026-04. If the env is
 *   missing locally, set it in `.env.local` (any 32-char hex string works).
 */
function getSigningKey(): Buffer {
  const secret = process.env.DEMO_SIGNING_SECRET
  if (!secret || secret.length < 16) {
    throw new Error(
      'DEMO_SIGNING_SECRET is missing or too short (need >= 16 chars). ' +
        'Generate with `openssl rand -hex 32` and set in .env.local + Vercel.',
    )
  }
  return Buffer.from(secret, 'utf-8')
}

// ---------------------------------------------------------------------------
// Sign
// ---------------------------------------------------------------------------

export interface SignDemoTokenOptions {
  /**
   * Override the demo venue baked into the payload. Defaults to
   * DEMO_VENUE_ID (Hawthorne Manor). Tests may override; production
   * callers should leave this unset.
   */
  demoVenueId?: string
  /**
   * Override the issue time, ms since epoch. Tests use this to build
   * already-expired tokens. Production callers must leave this unset.
   */
  iat?: number
  /**
   * Override the validity window in ms. Defaults to 24h. Tests use this
   * to mint short-lived tokens for expiry tests.
   */
  ttlMs?: number
}

/**
 * Mint a fresh signed demo token. Throws if `DEMO_SIGNING_SECRET` is
 * missing. The caller (server action) is responsible for setting it as
 * an HttpOnly cookie via `cookies().set()`.
 */
export function signDemoToken(opts: SignDemoTokenOptions = {}): string {
  const key = getSigningKey()
  const iat = opts.iat ?? Date.now()
  const ttl = opts.ttlMs ?? TWENTY_FOUR_HOURS_MS
  const payload: DemoTokenPayload = {
    kind: 'demo',
    iat,
    exp: iat + ttl,
    nonce: randomBytes(16).toString('hex'),
    demo_venue_id: opts.demoVenueId ?? DEMO_VENUE_ID,
  }
  const payloadB64 = Buffer.from(JSON.stringify(payload), 'utf-8').toString('base64url')
  const sig = createHmac('sha256', key).update(payloadB64).digest('base64url')
  return `${payloadB64}.${sig}`
}

// ---------------------------------------------------------------------------
// Verify
// ---------------------------------------------------------------------------

/**
 * Verify a token. Returns a discriminated union so callers can branch
 * on the precise failure mode for telemetry. Every verify path emits a
 * `demo_token_verify` counter with `outcome` in
 * { ok | tampered | expired | missing | malformed | wrong_kind |
 *   not_configured }.
 *
 * NEVER call `===` on signatures — uses `crypto.timingSafeEqual` to
 * thwart timing attacks. The buffer length-mismatch short-circuit is
 * intentional (the cmp would throw otherwise) and not a timing leak
 * against attackers (they don't get to learn how long the right sig is —
 * the format is public).
 */
export function verifyDemoToken(token: string | null | undefined): DemoVerifyResult {
  if (!token) {
    void recordCounter('demo_token_verify', { dimension: { outcome: 'missing' } })
    return { ok: false, reason: 'missing' }
  }

  let key: Buffer
  try {
    key = getSigningKey()
  } catch (err) {
    // Production hits this if DEMO_SIGNING_SECRET isn't set — fail closed
    // and surface the misconfig in logs (one-line redactError so any
    // accidental key leak in the message is stripped).
    console.error('[demo-token] verify aborted, signing secret missing:', redactError(err))
    void recordCounter('demo_token_verify', { dimension: { outcome: 'not_configured' } })
    return { ok: false, reason: 'not_configured' }
  }

  const dot = token.lastIndexOf('.')
  if (dot < 1 || dot === token.length - 1) {
    void recordCounter('demo_token_verify', { dimension: { outcome: 'malformed' } })
    return { ok: false, reason: 'malformed' }
  }
  const payloadB64 = token.slice(0, dot)
  const sig = token.slice(dot + 1)

  let expected: string
  try {
    expected = createHmac('sha256', key).update(payloadB64).digest('base64url')
  } catch (err) {
    console.error('[demo-token] hmac compute failed:', redactError(err))
    void recordCounter('demo_token_verify', { dimension: { outcome: 'malformed' } })
    return { ok: false, reason: 'malformed' }
  }
  const a = Buffer.from(sig, 'utf-8')
  const b = Buffer.from(expected, 'utf-8')
  if (a.length !== b.length || !timingSafeEqual(a, b)) {
    void recordCounter('demo_token_verify', { dimension: { outcome: 'tampered' } })
    return { ok: false, reason: 'tampered' }
  }

  // Decode + shape-check
  let payload: DemoTokenPayload
  try {
    const json = Buffer.from(payloadB64, 'base64url').toString('utf-8')
    payload = JSON.parse(json) as DemoTokenPayload
  } catch (err) {
    console.error('[demo-token] payload parse failed:', redactError(err))
    void recordCounter('demo_token_verify', { dimension: { outcome: 'malformed' } })
    return { ok: false, reason: 'malformed' }
  }

  if (
    !payload ||
    payload.kind !== 'demo' ||
    typeof payload.iat !== 'number' ||
    typeof payload.exp !== 'number' ||
    typeof payload.nonce !== 'string' ||
    typeof payload.demo_venue_id !== 'string'
  ) {
    void recordCounter('demo_token_verify', { dimension: { outcome: 'wrong_kind' } })
    return { ok: false, reason: 'wrong_kind' }
  }

  const now = Date.now()
  if (payload.exp <= now || payload.iat > now + 60_000 /* 1m skew tolerance */) {
    void recordCounter('demo_token_verify', { dimension: { outcome: 'expired' } })
    return { ok: false, reason: 'expired' }
  }

  void recordCounter('demo_token_verify', { dimension: { outcome: 'ok' } })
  return { ok: true, payload }
}

// ---------------------------------------------------------------------------
// Cookie helpers
// ---------------------------------------------------------------------------

/**
 * Standard cookie options for the signed token. HttpOnly so JS cannot
 * read it; sameSite=lax so it survives top-level navigations from
 * /demo → /, /demo/agent → /agent (the rewrites in middleware) but not
 * cross-site iframes.
 */
export function demoTokenCookieOptions() {
  return {
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'lax' as const,
    maxAge: DEMO_TOKEN_MAX_AGE_SECONDS,
    path: '/',
  }
}

/**
 * Companion UI-hint cookie options. NOT HttpOnly so client components can
 * read it for purely cosmetic decisions (banner visibility, default IDs).
 * The hint has zero auth power.
 */
export function demoHintCookieOptions() {
  return {
    httpOnly: false,
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'lax' as const,
    maxAge: DEMO_TOKEN_MAX_AGE_SECONDS,
    path: '/',
  }
}
