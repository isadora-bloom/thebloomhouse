/**
 * S5 (2026-09-14 security audit, item 1).
 *
 * Reads the real next.config.ts and asserts the header block is there and
 * says what it is meant to say. The point of reading the config rather
 * than a copy is that a future edit which drops frame-ancestors, or
 * narrows the matcher so the public signing page stops being covered,
 * fails here instead of in production.
 */

import { describe, it, expect } from 'vitest'
import nextConfig, { SECURITY_HEADERS } from '../../../../next.config'

function headerValue(key: string): string {
  const found = SECURITY_HEADERS.find((h) => h.key.toLowerCase() === key.toLowerCase())
  if (!found) throw new Error(`header ${key} is not shipped`)
  return found.value
}

describe('security headers', () => {
  it('ships a headers() block covering every route', async () => {
    expect(typeof nextConfig.headers).toBe('function')
    const blocks = await nextConfig.headers!()
    expect(blocks.length).toBeGreaterThan(0)
    const sources = blocks.map((b) => b.source)
    expect(sources).toContain('/:path*')
    const all = blocks.find((b) => b.source === '/:path*')!
    expect(all.headers.map((h) => h.key)).toEqual(
      SECURITY_HEADERS.map((h) => h.key),
    )
  })

  it('names every header the audit asked for', () => {
    const keys = SECURITY_HEADERS.map((h) => h.key)
    expect(keys).toContain('Content-Security-Policy')
    expect(keys).toContain('X-Frame-Options')
    expect(keys).toContain('Strict-Transport-Security')
    expect(keys).toContain('Referrer-Policy')
    expect(keys).toContain('X-Content-Type-Options')
    expect(keys).toContain('Permissions-Policy')
  })

  it('refuses to be framed, twice over', () => {
    expect(headerValue('Content-Security-Policy')).toContain("frame-ancestors 'none'")
    expect(headerValue('X-Frame-Options')).toBe('DENY')
  })

  it('pins HSTS at two years with subdomains and preload', () => {
    expect(headerValue('Strict-Transport-Security')).toBe(
      'max-age=63072000; includeSubDomains; preload',
    )
  })

  it('sets the remaining scalar headers to the audited values', () => {
    expect(headerValue('Referrer-Policy')).toBe('strict-origin-when-cross-origin')
    expect(headerValue('X-Content-Type-Options')).toBe('nosniff')
  })

  it('closes the injection-amplifying CSP directives', () => {
    const csp = headerValue('Content-Security-Policy')
    expect(csp).toContain("object-src 'none'")
    expect(csp).toContain("base-uri 'self'")
    expect(csp).toContain("form-action 'self'")
    expect(csp).toContain("default-src 'self'")
  })

  it('denies the powerful features in Permissions-Policy', () => {
    const pp = headerValue('Permissions-Policy')
    for (const feature of ['camera', 'microphone', 'geolocation', 'payment', 'usb']) {
      expect(pp).toContain(`${feature}=()`)
    }
  })

  it('covers the public contract signing page', async () => {
    // /join/contract/[token] has no login and takes a typed signature, so
    // it is the page clickjacking would actually pay off on. The catch-all
    // matcher has to match it.
    const blocks = await nextConfig.headers!()
    const all = blocks.find((b) => b.source === '/:path*')
    expect(all).toBeTruthy()
    // '/:path*' is Next's catch-all; spelled out so a narrowing edit is
    // visible in the diff rather than silently dropping the page.
    expect(all!.source).toBe('/:path*')
  })
})
