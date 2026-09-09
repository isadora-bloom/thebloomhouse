import { describe, it, expect } from 'vitest'
import {
  generateEventCode,
  hashInviteToken,
  mintInviteToken,
  validateCoupleInvite,
  checkRegistrationEligibility,
  type CoupleInviteRow,
} from '../provision'

/**
 * W1 (2026-09-08). These cover the two decisions that used to be a single
 * `.eq('event_code', eventCode)`: is this invitation good, and is this
 * person allowed an account on this wedding. No database, no network.
 */

const NOW = new Date('2026-09-08T12:00:00.000Z')

function invite(overrides: Partial<CoupleInviteRow> = {}): CoupleInviteRow {
  return {
    id: 'inv-1',
    venue_id: 'venue-1',
    wedding_id: 'wed-1',
    email: 'sarah@example.com',
    expires_at: '2026-09-22T12:00:00.000Z',
    used_at: null,
    ...overrides,
  }
}

describe('generateEventCode', () => {
  it('takes three letters of the slug and three digits', () => {
    expect(generateEventCode('hawthorne-manor')).toMatch(/^HAW-\d{3}$/)
  })

  it('strips non-letters before taking the prefix', () => {
    expect(generateEventCode('3-oaks-farm')).toMatch(/^OAK-\d{3}$/)
  })

  it('falls back to BLM when the slug has no letters', () => {
    expect(generateEventCode('123')).toMatch(/^BLM-\d{3}$/)
    expect(generateEventCode(null)).toMatch(/^BLM-\d{3}$/)
    expect(generateEventCode(undefined)).toMatch(/^BLM-\d{3}$/)
  })

  it('never produces fewer than three digits', () => {
    for (let i = 0; i < 200; i++) {
      expect(generateEventCode('fernhill-barn')).toMatch(/^FER-[1-9]\d{2}$/)
    }
  })
})

describe('invite tokens', () => {
  it('mints 128 bits of hex and a matching sha256', () => {
    const { token, tokenHash } = mintInviteToken()
    expect(token).toMatch(/^[0-9a-f]{32}$/)
    expect(tokenHash).toMatch(/^[0-9a-f]{64}$/)
    expect(hashInviteToken(token)).toBe(tokenHash)
  })

  it('does not repeat itself', () => {
    const seen = new Set<string>()
    for (let i = 0; i < 500; i++) seen.add(mintInviteToken().token)
    expect(seen.size).toBe(500)
  })

  it('hashes the trimmed token, so a copied link with whitespace still works', () => {
    const { token, tokenHash } = mintInviteToken()
    expect(hashInviteToken(`  ${token}\n`)).toBe(tokenHash)
  })

  it('never returns the token as its own hash', () => {
    const { token, tokenHash } = mintInviteToken()
    expect(tokenHash).not.toBe(token)
  })
})

describe('validateCoupleInvite', () => {
  const good = { token: 'abc', email: 'sarah@example.com', now: NOW }

  it('accepts an unused, unexpired invite for the right address', () => {
    expect(validateCoupleInvite(invite(), good)).toEqual({ ok: true })
  })

  it('is case-insensitive and whitespace-tolerant on the email', () => {
    const check = validateCoupleInvite(invite({ email: 'Sarah@Example.com ' }), {
      ...good,
      email: '  SARAH@example.COM',
    })
    expect(check.ok).toBe(true)
  })

  it('rejects a missing token', () => {
    const check = validateCoupleInvite(invite(), { ...good, token: '' })
    expect(check).toMatchObject({ ok: false, reason: 'missing_token' })
  })

  it('rejects a whitespace-only token', () => {
    const check = validateCoupleInvite(invite(), { ...good, token: '   ' })
    expect(check).toMatchObject({ ok: false, reason: 'missing_token' })
  })

  it('rejects a token with no matching row', () => {
    expect(validateCoupleInvite(null, good)).toMatchObject({
      ok: false,
      reason: 'not_found',
    })
  })

  it('rejects an invite that has already been redeemed', () => {
    const check = validateCoupleInvite(
      invite({ used_at: '2026-09-08T11:00:00.000Z' }),
      good,
    )
    expect(check).toMatchObject({ ok: false, reason: 'already_used' })
  })

  it('rejects an expired invite', () => {
    const check = validateCoupleInvite(
      invite({ expires_at: '2026-09-08T11:59:59.000Z' }),
      good,
    )
    expect(check).toMatchObject({ ok: false, reason: 'expired' })
  })

  it('treats the expiry instant itself as expired', () => {
    const check = validateCoupleInvite(
      invite({ expires_at: NOW.toISOString() }),
      good,
    )
    expect(check).toMatchObject({ ok: false, reason: 'expired' })
  })

  it('rejects an unparseable expiry rather than letting it through', () => {
    const check = validateCoupleInvite(invite({ expires_at: 'not a date' }), good)
    expect(check).toMatchObject({ ok: false, reason: 'expired' })
  })

  it('rejects a forwarded link redeemed by a different address', () => {
    const check = validateCoupleInvite(invite(), {
      ...good,
      email: 'someone.else@example.com',
    })
    expect(check).toMatchObject({ ok: false, reason: 'email_mismatch' })
  })

  it('rejects an invite belonging to another venue', () => {
    const check = validateCoupleInvite(invite(), { ...good, venueId: 'venue-2' })
    expect(check).toMatchObject({ ok: false, reason: 'venue_mismatch' })
  })

  it('checks used before expired, so a spent link says so plainly', () => {
    const check = validateCoupleInvite(
      invite({ used_at: '2026-09-01T00:00:00.000Z', expires_at: '2026-09-02T00:00:00.000Z' }),
      good,
    )
    expect(check).toMatchObject({ ok: false, reason: 'already_used' })
  })

  it('gives the same message for not-found and wrong-venue, so probing tells you nothing', () => {
    const notFound = validateCoupleInvite(null, good)
    const wrongVenue = validateCoupleInvite(invite(), { ...good, venueId: 'venue-2' })
    expect(notFound.ok).toBe(false)
    expect(wrongVenue.ok).toBe(false)
    if (!notFound.ok && !wrongVenue.ok) {
      expect(notFound.message).toBe(wrongVenue.message)
      // and it does not name the check that failed
      expect(notFound.message).not.toMatch(/expired|different email|already been used/i)
    }
  })
})

describe('checkRegistrationEligibility', () => {
  it('allows the first partner on a booked wedding', () => {
    expect(
      checkRegistrationEligibility({
        weddingStatus: 'booked',
        coupleAccountCount: 0,
        emailAlreadyRegistered: false,
      }),
    ).toEqual({ ok: true, partnerNumber: 1 })
  })

  it('allows the second partner', () => {
    expect(
      checkRegistrationEligibility({
        weddingStatus: 'booked',
        coupleAccountCount: 1,
        emailAlreadyRegistered: false,
      }),
    ).toEqual({ ok: true, partnerNumber: 2 })
  })

  it('allows a completed wedding, so a couple keeps their portal after the day', () => {
    expect(
      checkRegistrationEligibility({
        weddingStatus: 'completed',
        coupleAccountCount: 0,
        emailAlreadyRegistered: false,
      }),
    ).toEqual({ ok: true, partnerNumber: 1 })
  })

  it('refuses a wedding that is still an enquiry', () => {
    expect(
      checkRegistrationEligibility({
        weddingStatus: 'inquiry',
        coupleAccountCount: 0,
        emailAlreadyRegistered: false,
      }),
    ).toMatchObject({ ok: false, reason: 'wedding_not_bookable' })
  })

  it('refuses a lost wedding', () => {
    expect(
      checkRegistrationEligibility({
        weddingStatus: 'lost',
        coupleAccountCount: 0,
        emailAlreadyRegistered: false,
      }),
    ).toMatchObject({ ok: false, reason: 'wedding_not_bookable' })
  })

  it('refuses a null status', () => {
    expect(
      checkRegistrationEligibility({
        weddingStatus: null,
        coupleAccountCount: 0,
        emailAlreadyRegistered: false,
      }),
    ).toMatchObject({ ok: false, reason: 'wedding_not_bookable' })
  })

  it('caps at two accounts', () => {
    expect(
      checkRegistrationEligibility({
        weddingStatus: 'booked',
        coupleAccountCount: 2,
        emailAlreadyRegistered: false,
      }),
    ).toMatchObject({ ok: false, reason: 'account_cap' })
  })

  it('points a repeat registration at sign-in before it mentions the cap', () => {
    expect(
      checkRegistrationEligibility({
        weddingStatus: 'booked',
        coupleAccountCount: 2,
        emailAlreadyRegistered: true,
      }),
    ).toMatchObject({ ok: false, reason: 'email_already_registered' })
  })
})
