/**
 * S2 (2026-09-14 security audit) — the shared OAuth state signer.
 *
 * Four things this pins:
 *
 *   1. The key is STATE_SIGNING_SECRET and nothing else. CRON_SECRET
 *      used to sign Google Ads, Meta Ads, TikTok Ads and Instagram
 *      states; Zoom fell back to a literal that is in the repository.
 *      Both must be inert now.
 *   2. Unset means throw on mint and `not_configured` on verify, never
 *      a fallback key.
 *   3. The user id is inside the signature, so a state minted for one
 *      member of a venue cannot be presented by another.
 *   4. The nonce is consumed. A captured callback URL replayed inside
 *      the ten-minute window is refused the second time.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  OAUTH_STATE_TTL_MS,
  __resetConsumedNoncesForTest,
  isOAuthStateConfigured,
  mintOAuthState,
  verifyOAuthState,
} from '../oauth-state'

const SECRET = 'x'.repeat(48)
const VENUE = '11111111-1111-4111-8111-111111111111'
const USER = '22222222-2222-4222-8222-222222222222'

const ORIGINAL = {
  STATE_SIGNING_SECRET: process.env.STATE_SIGNING_SECRET,
  CRON_SECRET: process.env.CRON_SECRET,
  ZOOM_STATE_SECRET: process.env.ZOOM_STATE_SECRET,
  NEXTAUTH_SECRET: process.env.NEXTAUTH_SECRET,
}

beforeEach(() => {
  __resetConsumedNoncesForTest()
  process.env.STATE_SIGNING_SECRET = SECRET
  vi.spyOn(console, 'warn').mockImplementation(() => {})
})

afterEach(() => {
  vi.restoreAllMocks()
  vi.useRealTimers()
  for (const [k, v] of Object.entries(ORIGINAL)) {
    if (v === undefined) delete process.env[k]
    else process.env[k] = v
  }
})

describe('round trip', () => {
  it('verifies a freshly minted state and returns the bound identity', () => {
    const state = mintOAuthState({ provider: 'google_ads', venueId: VENUE, userId: USER })
    const result = verifyOAuthState(state, 'google_ads')

    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.payload.venueId).toBe(VENUE)
    expect(result.payload.userId).toBe(USER)
    expect(result.payload.provider).toBe('google_ads')
  })

  it('carries returnTo when one is given', () => {
    const state = mintOAuthState({
      provider: 'zoom',
      venueId: VENUE,
      userId: USER,
      returnTo: '/settings/zoom',
    })
    const result = verifyOAuthState(state, 'zoom')

    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.payload.returnTo).toBe('/settings/zoom')
  })

  it('mints a different state every time', () => {
    const a = mintOAuthState({ provider: 'instagram', venueId: VENUE, userId: USER })
    const b = mintOAuthState({ provider: 'instagram', venueId: VENUE, userId: USER })
    expect(a).not.toBe(b)
  })
})

describe('key handling', () => {
  it('throws on mint when STATE_SIGNING_SECRET is unset', () => {
    delete process.env.STATE_SIGNING_SECRET
    expect(() =>
      mintOAuthState({ provider: 'google_ads', venueId: VENUE, userId: USER }),
    ).toThrow(/STATE_SIGNING_SECRET/)
  })

  it('throws on mint when the secret is too short to be random', () => {
    process.env.STATE_SIGNING_SECRET = 'tiny'
    expect(() =>
      mintOAuthState({ provider: 'google_ads', venueId: VENUE, userId: USER }),
    ).toThrow(/STATE_SIGNING_SECRET/)
  })

  it('reports not_configured on verify rather than throwing', () => {
    const state = mintOAuthState({ provider: 'google_ads', venueId: VENUE, userId: USER })
    delete process.env.STATE_SIGNING_SECRET

    const result = verifyOAuthState(state, 'google_ads')
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.reason).toBe('not_configured')
  })

  it('isOAuthStateConfigured tracks the variable', () => {
    expect(isOAuthStateConfigured()).toBe(true)
    delete process.env.STATE_SIGNING_SECRET
    expect(isOAuthStateConfigured()).toBe(false)
  })

  it('ignores CRON_SECRET entirely — the old signing key is inert', () => {
    const state = mintOAuthState({ provider: 'meta_ads', venueId: VENUE, userId: USER })
    // Rotating CRON_SECRET must not invalidate an outstanding state, and
    // setting it must not make an unsigned one verify.
    process.env.CRON_SECRET = 'y'.repeat(64)
    expect(verifyOAuthState(state, 'meta_ads').ok).toBe(true)

    __resetConsumedNoncesForTest()
    delete process.env.STATE_SIGNING_SECRET
    expect(verifyOAuthState(state, 'meta_ads').ok).toBe(false)
  })

  it('ignores the old Zoom fallback chain', () => {
    delete process.env.STATE_SIGNING_SECRET
    process.env.ZOOM_STATE_SECRET = 'z'.repeat(64)
    process.env.NEXTAUTH_SECRET = 'n'.repeat(64)
    expect(isOAuthStateConfigured()).toBe(false)
    expect(() =>
      mintOAuthState({ provider: 'zoom', venueId: VENUE, userId: USER }),
    ).toThrow()
  })

  it('refuses a state signed with a different key', () => {
    const state = mintOAuthState({ provider: 'tiktok_ads', venueId: VENUE, userId: USER })
    process.env.STATE_SIGNING_SECRET = 'w'.repeat(48)

    const result = verifyOAuthState(state, 'tiktok_ads')
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.reason).toBe('bad_signature')
  })
})

describe('tamper resistance', () => {
  it('refuses a state whose payload was edited to another venue', () => {
    const state = mintOAuthState({ provider: 'google_ads', venueId: VENUE, userId: USER })
    const [payloadB64, sig] = state.split('.')
    const payload = JSON.parse(Buffer.from(payloadB64, 'base64url').toString('utf-8'))
    payload.venueId = '33333333-3333-4333-8333-333333333333'
    const forged = `${Buffer.from(JSON.stringify(payload), 'utf-8').toString('base64url')}.${sig}`

    const result = verifyOAuthState(forged, 'google_ads')
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.reason).toBe('bad_signature')
  })

  it('refuses a state minted for a different provider', () => {
    const state = mintOAuthState({ provider: 'meta_ads', venueId: VENUE, userId: USER })

    const result = verifyOAuthState(state, 'tiktok_ads')
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.reason).toBe('provider_mismatch')
  })

  it('refuses a missing or malformed token', () => {
    expect(verifyOAuthState(null, 'zoom')).toEqual({ ok: false, reason: 'missing' })
    expect(verifyOAuthState('', 'zoom')).toEqual({ ok: false, reason: 'missing' })
    expect(verifyOAuthState('nodot', 'zoom')).toEqual({ ok: false, reason: 'malformed' })
    expect(verifyOAuthState('.sig', 'zoom')).toEqual({ ok: false, reason: 'malformed' })
    expect(verifyOAuthState('payload.', 'zoom')).toEqual({ ok: false, reason: 'malformed' })
  })
})

describe('freshness and replay', () => {
  it('expires after the ten-minute window', () => {
    vi.useFakeTimers()
    const state = mintOAuthState({ provider: 'instagram', venueId: VENUE, userId: USER })

    vi.advanceTimersByTime(OAUTH_STATE_TTL_MS + 1000)

    const result = verifyOAuthState(state, 'instagram')
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.reason).toBe('expired')
  })

  it('still verifies just inside the window', () => {
    vi.useFakeTimers()
    const state = mintOAuthState({ provider: 'instagram', venueId: VENUE, userId: USER })

    vi.advanceTimersByTime(OAUTH_STATE_TTL_MS - 1000)

    expect(verifyOAuthState(state, 'instagram').ok).toBe(true)
  })

  it('refuses the same state a second time — the nonce is consumed', () => {
    const state = mintOAuthState({ provider: 'google_ads', venueId: VENUE, userId: USER })

    expect(verifyOAuthState(state, 'google_ads').ok).toBe(true)

    const replay = verifyOAuthState(state, 'google_ads')
    expect(replay.ok).toBe(false)
    if (replay.ok) return
    expect(replay.reason).toBe('replayed')
  })

  it('does not let a failed verify consume the nonce', () => {
    const state = mintOAuthState({ provider: 'google_ads', venueId: VENUE, userId: USER })

    // Wrong provider fails before the nonce is touched.
    expect(verifyOAuthState(state, 'zoom').ok).toBe(false)
    // So the genuine callback still works.
    expect(verifyOAuthState(state, 'google_ads').ok).toBe(true)
  })
})
