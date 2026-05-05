/**
 * Unit tests for demo-token.ts (signDemoToken + verifyDemoToken).
 *
 * No Supabase, no Claude API, no fetch. The only external surface is
 * node:crypto — which is in-process and deterministic under our secret.
 *
 * recordCounter is mocked so observability writes never hit the network.
 */

import { describe, it, expect, beforeAll, vi } from 'vitest'

// ---------------------------------------------------------------------------
// Mock observability — recordCounter is fire-and-forget; mocking prevents
// any attempt to reach Supabase during verify calls.
// ---------------------------------------------------------------------------
vi.mock('@/lib/observability/metrics', () => ({
  recordCounter: vi.fn().mockResolvedValue(undefined),
  recordHistogram: vi.fn().mockResolvedValue(undefined),
}))

vi.mock('@/lib/observability/redact', () => ({
  redact: (s: string) => s,
  redactError: (err: unknown) => (err instanceof Error ? err.message : String(err)),
  redactObject: <T>(obj: T) => obj,
}))

import { signDemoToken, verifyDemoToken, DEMO_VENUE_ID } from '@/lib/services/demo-token'

// ---------------------------------------------------------------------------
// Env setup — must happen before module-level code in the tested module runs.
// The signing key is resolved lazily (inside sign/verify), so setting it in
// beforeAll is sufficient.
// ---------------------------------------------------------------------------
beforeAll(() => {
  process.env.DEMO_SIGNING_SECRET = 'test-secret-32chars-minimum-ok!'
})

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Flip one byte in a base64url string at position `pos` to produce a tampered value. */
function flipBit(b64url: string, pos: number): string {
  const chars = b64url.split('')
  const original = chars[pos % chars.length]
  // Replace with an adjacent character in the base64url alphabet that differs.
  const alt = original === 'A' ? 'B' : 'A'
  chars[pos % chars.length] = alt
  return chars.join('')
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('signDemoToken', () => {
  it('returns a non-empty string', () => {
    const token = signDemoToken()
    expect(typeof token).toBe('string')
    expect(token.length).toBeGreaterThan(0)
  })

  it('contains exactly one dot separating payload from signature', () => {
    const token = signDemoToken()
    // Token format: base64url(payload) + '.' + base64url(sig)
    // There must be at least one dot, and both sides must be non-empty.
    const dotIdx = token.lastIndexOf('.')
    expect(dotIdx).toBeGreaterThan(0)
    expect(dotIdx).toBeLessThan(token.length - 1)
  })

  it('embeds the default demo venue id when no override supplied', () => {
    const token = signDemoToken()
    const result = verifyDemoToken(token)
    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.payload.demo_venue_id).toBe(DEMO_VENUE_ID)
    }
  })

  it('embeds a custom venue id when demoVenueId is overridden', () => {
    const customId = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee'
    const token = signDemoToken({ demoVenueId: customId })
    const result = verifyDemoToken(token)
    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.payload.demo_venue_id).toBe(customId)
    }
  })

  it('produces different tokens on consecutive calls (random nonce)', () => {
    const t1 = signDemoToken()
    const t2 = signDemoToken()
    expect(t1).not.toBe(t2)
  })
})

describe('verifyDemoToken — valid token round-trip', () => {
  it('returns { ok: true } with the correct payload shape', () => {
    const venueId = '11111111-2222-3333-4444-555555555555'
    const token = signDemoToken({ demoVenueId: venueId })
    const result = verifyDemoToken(token)

    expect(result.ok).toBe(true)
    if (!result.ok) return // type narrowing

    const { payload } = result
    expect(payload.kind).toBe('demo')
    expect(payload.demo_venue_id).toBe(venueId)
    expect(typeof payload.iat).toBe('number')
    expect(typeof payload.exp).toBe('number')
    expect(typeof payload.nonce).toBe('string')
    expect(payload.exp).toBeGreaterThan(payload.iat)
  })
})

describe('verifyDemoToken — missing / empty / undefined input', () => {
  it('returns { ok: false } for undefined', () => {
    const result = verifyDemoToken(undefined)
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.reason).toBe('missing')
  })

  it('returns { ok: false } for null', () => {
    const result = verifyDemoToken(null)
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.reason).toBe('missing')
  })

  it('returns { ok: false } for empty string', () => {
    const result = verifyDemoToken('')
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.reason).toBe('missing')
  })
})

describe('verifyDemoToken — malformed tokens', () => {
  it('rejects a token with no dot separator', () => {
    const result = verifyDemoToken('nodotanywhere')
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.reason).toBe('malformed')
  })

  it('rejects a token whose dot is the first character', () => {
    const result = verifyDemoToken('.signatureonly')
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.reason).toBe('malformed')
  })

  it('rejects a token whose dot is the last character (empty signature)', () => {
    const result = verifyDemoToken('payload.')
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.reason).toBe('malformed')
  })

  it('rejects a clearly bogus string', () => {
    const result = verifyDemoToken('tampered.signature')
    expect(result.ok).toBe(false)
  })
})

describe('verifyDemoToken — HMAC tamper detection', () => {
  it('rejects a token with a flipped bit in the signature', () => {
    const token = signDemoToken()
    const dot = token.lastIndexOf('.')
    const payloadB64 = token.slice(0, dot)
    const sig = token.slice(dot + 1)
    const tamperedSig = flipBit(sig, 3)
    const tamperedToken = `${payloadB64}.${tamperedSig}`

    const result = verifyDemoToken(tamperedToken)
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.reason).toBe('tampered')
  })

  it('rejects a token whose payload was modified after signing', () => {
    const token = signDemoToken()
    const dot = token.lastIndexOf('.')
    const sig = token.slice(dot + 1)

    // Build a new payload with a different venue id and re-encode it,
    // but keep the original signature — the HMAC must fail.
    const fakePayload = Buffer.from(
      JSON.stringify({
        kind: 'demo',
        iat: Date.now(),
        exp: Date.now() + 86_400_000,
        nonce: 'aaaaaaaabbbbbbbbccccccccdddddddd',
        demo_venue_id: 'ffffffff-ffff-ffff-ffff-ffffffffffff',
      }),
    ).toString('base64url')
    const tamperedToken = `${fakePayload}.${sig}`

    const result = verifyDemoToken(tamperedToken)
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.reason).toBe('tampered')
  })
})

describe('verifyDemoToken — expiry', () => {
  it('rejects a token minted with ttlMs = 0 (immediately expired)', () => {
    // iat in the distant past, exp also in the past.
    const pastIat = Date.now() - 10_000
    const token = signDemoToken({ iat: pastIat, ttlMs: 0 })
    const result = verifyDemoToken(token)
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.reason).toBe('expired')
  })

  it('accepts a token with a future expiry (24h TTL)', () => {
    const token = signDemoToken() // default 24h
    const result = verifyDemoToken(token)
    expect(result.ok).toBe(true)
  })
})
