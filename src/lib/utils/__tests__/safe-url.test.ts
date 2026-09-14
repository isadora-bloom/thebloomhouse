/**
 * S5 (2026-09-14 security audit, item 12) — href/src values out of the
 * database.
 */

import { describe, it, expect } from 'vitest'
import { safeHttpUrl, safeHref } from '../safe-url'

describe('safeHttpUrl', () => {
  it('passes an ordinary https URL through', () => {
    expect(safeHttpUrl('https://rixeymanor.com/tours')).toBe(
      'https://rixeymanor.com/tours',
    )
  })

  it('passes http as well', () => {
    expect(safeHttpUrl('http://example.com/')).toBe('http://example.com/')
  })

  it('gives a bare domain the https it was missing', () => {
    expect(safeHttpUrl('rixeymanor.com')).toBe('https://rixeymanor.com/')
  })

  it.each([
    ['javascript:alert(document.cookie)'],
    ['JaVaScRiPt:alert(1)'],
    ['data:text/html,<script>alert(1)</script>'],
    ['vbscript:msgbox(1)'],
    ['file:///etc/passwd'],
  ])('refuses %s', (payload) => {
    expect(safeHttpUrl(payload)).toBeNull()
  })

  it('refuses a protocol-relative URL', () => {
    expect(safeHttpUrl('//evil.example/steal')).toBeNull()
  })

  it('refuses embedded credentials', () => {
    expect(safeHttpUrl('https://rixeymanor.com@evil.example/')).toBeNull()
  })

  it('refuses a non-string, a blank and junk', () => {
    expect(safeHttpUrl(null)).toBeNull()
    expect(safeHttpUrl(undefined)).toBeNull()
    expect(safeHttpUrl(42)).toBeNull()
    expect(safeHttpUrl('')).toBeNull()
    expect(safeHttpUrl('   ')).toBeNull()
    expect(safeHttpUrl('https://')).toBeNull()
  })

  it('is not fooled by leading whitespace around a scheme', () => {
    expect(safeHttpUrl('  javascript:alert(1)')).toBeNull()
  })
})

describe('safeHref', () => {
  it('returns undefined rather than null so JSX drops the attribute', () => {
    expect(safeHref('javascript:alert(1)')).toBeUndefined()
    expect(safeHref('https://example.com/')).toBe('https://example.com/')
  })
})
