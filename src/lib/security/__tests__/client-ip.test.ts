/**
 * Rate-limit keys come from a header the caller cannot write.
 * 2026-09-14 security review, item 6.
 *
 * The public sage-preview limit is keyed on this function and nothing else,
 * so if the caller controls the value they control the bucket, and the limit
 * is decorative. The leftmost entry of x-forwarded-for is exactly that: a
 * value the client sent. The rightmost is the one our own proxy appended.
 */
import { describe, it, expect } from 'vitest'
import { clientIpForRateLimit } from '@/lib/security/client-ip'

function req(headers: Record<string, string>) {
  return { headers: new Headers(headers) } as unknown as Parameters<
    typeof clientIpForRateLimit
  >[0]
}

describe('clientIpForRateLimit', () => {
  it('ignores a client-supplied left-hand entry in the forwarded chain', () => {
    // The attacker sent "9.9.9.9"; Vercel appended the real address.
    expect(clientIpForRateLimit(req({ 'x-forwarded-for': '9.9.9.9, 203.0.113.7' }))).toBe(
      '203.0.113.7',
    )
  })

  it('puts a rotating spoofed header into one bucket, not a fresh one each time', () => {
    const a = clientIpForRateLimit(req({ 'x-forwarded-for': 'a.a.a.a, 203.0.113.7' }))
    const b = clientIpForRateLimit(req({ 'x-forwarded-for': 'b.b.b.b, 203.0.113.7' }))
    const c = clientIpForRateLimit(req({ 'x-forwarded-for': '1.2.3.4, 5.6.7.8, 203.0.113.7' }))
    expect(new Set([a, b, c]).size).toBe(1)
  })

  it('prefers the platform header over the forwarded chain', () => {
    const ip = clientIpForRateLimit(
      req({
        'x-vercel-forwarded-for': '198.51.100.4',
        'x-forwarded-for': '9.9.9.9, 203.0.113.7',
      }),
    )
    expect(ip).toBe('198.51.100.4')
  })

  it('falls back through the other platform headers in order', () => {
    expect(clientIpForRateLimit(req({ 'cf-connecting-ip': '198.51.100.9' }))).toBe('198.51.100.9')
    expect(clientIpForRateLimit(req({ 'x-real-ip': '198.51.100.10' }))).toBe('198.51.100.10')
  })

  it('still normalises ports and bracketed IPv6', () => {
    expect(clientIpForRateLimit(req({ 'x-forwarded-for': '203.0.113.7:51234' }))).toBe('203.0.113.7')
    expect(clientIpForRateLimit(req({ 'x-forwarded-for': '[2001:db8::1]:8080' }))).toBe('2001:db8::1')
    expect(clientIpForRateLimit(req({ 'x-real-ip': '2001:db8::1' }))).toBe('2001:db8::1')
  })

  it('gives an unattributable caller its own bucket rather than a shared one', () => {
    const a = clientIpForRateLimit(req({}))
    const b = clientIpForRateLimit(req({}))
    expect(a).toMatch(/^anon:/)
    expect(a).not.toBe(b)
  })

  it('skips empty entries at the right-hand end of the chain', () => {
    expect(clientIpForRateLimit(req({ 'x-forwarded-for': '203.0.113.7, ' }))).toBe('203.0.113.7')
  })
})
