/**
 * S5 (2026-09-14 security audit, item 9) — credential shapes in log lines.
 *
 * The PII behaviour is covered by the module's own history; these are the
 * new claims, plus the two regression guards that matter (an ordinary log
 * line must still read as itself).
 */

import { describe, it, expect } from 'vitest'
import { redact, redactObject } from '../redact'

describe('redact: credentials', () => {
  it('redacts an Authorization bearer header', () => {
    const out = redact('Authorization: Bearer sk-live-4f8a2b9c1d7e6f3a0b5c8d2e')
    expect(out).not.toContain('sk-live-4f8a2b9c1d7e6f3a0b5c8d2e')
    expect(out).toContain('[REDACTED_TOKEN]')
  })

  it('redacts an access_token JSON field', () => {
    const out = redact('{"access_token":"zm_9f8e7d6c5b4a3f2e1d0c9b8a","expires_in":3600}')
    expect(out).not.toContain('zm_9f8e7d6c5b4a3f2e1d0c9b8a')
    expect(out).toContain('[REDACTED_TOKEN]')
    // The non-secret field is still readable, which is the point of
    // logging the line at all.
    expect(out).toContain('expires_in')
  })

  it('redacts a refresh_token however it is spelled', () => {
    for (const key of ['refresh_token', 'refreshToken', 'refresh-token']) {
      const out = redact(`${key}=abcdef0123456789abcdef`)
      expect(out).not.toContain('abcdef0123456789abcdef')
    }
  })

  it('redacts a client_secret and an api_key', () => {
    expect(redact('client_secret: 0123456789abcdef')).not.toContain('0123456789abcdef')
    expect(redact('api_key = sk_test_9876543210')).not.toContain('sk_test_9876543210')
  })

  it('redacts a bare JWT', () => {
    // Assembled at runtime rather than pasted as a literal. A JWT-shaped
    // string in a tracked file trips scripts/check-no-secrets.mjs, and
    // that guard is right to be blunt about it — a reviewer cannot tell a
    // fixture from a live Supabase key by looking. Encoding two obviously
    // fake segments here gives the same shape with nothing to mistake.
    const seg = (o: unknown) => Buffer.from(JSON.stringify(o)).toString('base64url')
    const jwt = [
      seg({ alg: 'HS256', typ: 'JWT' }),
      seg({ sub: 'redact-test', iss: 'nobody' }),
      seg({ note: 'not a signature, just padding to the right length' }),
    ].join('.')
    const out = redact(`token expired: ${jwt}`)
    expect(out).not.toContain(jwt)
    expect(out).toContain('[REDACTED_TOKEN]')
  })

  it('leaves an ordinary line alone', () => {
    const line = 'refresh failed for connection 41 (HTTP 401)'
    expect(redact(line)).toBe(line)
  })

  it('does not eat a word that merely contains "bearer"', () => {
    expect(redact('the bearer of this message')).toBe('the bearer of this message')
  })

  it('still redacts email and phone', () => {
    const out = redact('chloe@example.com rang on 555-123-4567')
    expect(out).toContain('[REDACTED_EMAIL]')
    expect(out).toContain('[REDACTED_PHONE]')
  })

  it('reaches into a structured event through redactObject', () => {
    const out = redactObject({
      msg: 'zoom refresh failed',
      detail: { body: '{"refresh_token":"abcdef0123456789abcdef"}' },
      status: 400,
    })
    expect(JSON.stringify(out)).not.toContain('abcdef0123456789abcdef')
    expect(out.status).toBe(400)
  })
})
