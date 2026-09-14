import { describe, it, expect } from 'vitest'
import { safeReturnTo } from '../gmail-oauth-state'

const FALLBACK = '/settings/gmail'

describe('safeReturnTo', () => {
  it('keeps an ordinary in-app path', () => {
    expect(safeReturnTo('/settings/gmail')).toBe('/settings/gmail')
    expect(safeReturnTo('/agent/inbox?tab=needs-reply')).toBe('/agent/inbox?tab=needs-reply')
    expect(safeReturnTo('/intel/dashboard#health')).toBe('/intel/dashboard#health')
  })

  it('falls back on absent or non-path input', () => {
    expect(safeReturnTo(null)).toBe(FALLBACK)
    expect(safeReturnTo(undefined)).toBe(FALLBACK)
    expect(safeReturnTo('')).toBe(FALLBACK)
    expect(safeReturnTo('settings/gmail')).toBe(FALLBACK)
    expect(safeReturnTo('https://evil.com/')).toBe(FALLBACK)
    expect(safeReturnTo('javascript:alert(1)')).toBe(FALLBACK)
  })

  it('refuses protocol-relative URLs', () => {
    expect(safeReturnTo('//evil.com')).toBe(FALLBACK)
    expect(safeReturnTo('//evil.com/path')).toBe(FALLBACK)
  })

  // The two the audit named. Both passed the old three-line check.
  it('refuses a backslash, which a URL parser reads as a slash', () => {
    expect(safeReturnTo('/\\evil.com')).toBe(FALLBACK)
    expect(safeReturnTo('/\\\\evil.com')).toBe(FALLBACK)
    expect(safeReturnTo('/settings\\..\\..\\evil.com')).toBe(FALLBACK)
  })

  it('refuses encoded control characters', () => {
    expect(safeReturnTo('/%09/evil.com')).toBe(FALLBACK)
    expect(safeReturnTo('/%0a/evil.com')).toBe(FALLBACK)
    expect(safeReturnTo('/%0D%0Aevil')).toBe(FALLBACK)
    expect(safeReturnTo('/%00')).toBe(FALLBACK)
  })

  it('refuses literal control characters', () => {
    expect(safeReturnTo('/\t/evil.com')).toBe(FALLBACK)
    expect(safeReturnTo('/\n/evil.com')).toBe(FALLBACK)
    expect(safeReturnTo('/\r/evil.com')).toBe(FALLBACK)
  })

  it('refuses a path that normalises out to protocol-relative', () => {
    // Passes "starts with /" and "does not start with //", then resolves
    // to //evil.com the moment a parser handles the '..'.
    expect(safeReturnTo('/..//evil.com')).toBe(FALLBACK)
    expect(safeReturnTo('/a/../..//evil.com')).toBe(FALLBACK)
  })

  it('returns the normalised path, not the raw input', () => {
    // Whatever the caller redirects to must be the thing that was checked.
    expect(safeReturnTo('/settings/../agent/inbox')).toBe('/agent/inbox')
  })

  it('refuses an absurdly long value', () => {
    expect(safeReturnTo('/' + 'a'.repeat(600))).toBe(FALLBACK)
  })

  it('honours a caller-supplied fallback', () => {
    expect(safeReturnTo('https://evil.com', '/onboarding')).toBe('/onboarding')
  })
})
