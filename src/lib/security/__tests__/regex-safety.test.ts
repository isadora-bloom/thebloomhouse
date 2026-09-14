/**
 * S5 (2026-09-14 security audit, item 4) — stored-regex ReDoS.
 */

import { describe, it, expect } from 'vitest'
import {
  assessRegexSafety,
  safeRegexTest,
  MAX_PATTERN_LENGTH,
  MAX_HAYSTACK_CHARS,
} from '../regex-safety'

describe('assessRegexSafety', () => {
  it('rejects the canonical catastrophic pattern', () => {
    const verdict = assessRegexSafety('^(a+)+$')
    expect(verdict.ok).toBe(false)
    if (!verdict.ok) expect(verdict.reason).toMatch(/nested quantifier/)
  })

  it.each([
    ['^(a+)+$'],
    ['(a*)*'],
    ['(?:\\d+)+'],
    ['(ab{2,})+'],
    ['(x?)*'],
    ['((a|b)+)+'],
  ])('rejects nested quantifier %s', (source) => {
    expect(assessRegexSafety(source).ok).toBe(false)
  })

  it.each([
    ['The Knot Pro Network'],
    ['^New (Lead|Message) for'],
    ['reply:?\\s*https?://email\\.partner\\.theknot\\.com'],
    ['(?:weddingwire|theknot)\\.com'],
    ['\\b\\d{2,4}\\s*guests\\b'],
    ['(abc)+'],
    ['[a-z]+@[a-z]+'],
  ])('accepts an ordinary footer pattern %s', (source) => {
    const verdict = assessRegexSafety(source)
    expect(verdict.ok).toBe(true)
  })

  it('rejects numeric backreferences', () => {
    const verdict = assessRegexSafety('(foo)\\1')
    expect(verdict.ok).toBe(false)
    if (!verdict.ok) expect(verdict.reason).toMatch(/backreference/)
  })

  it('rejects named backreferences', () => {
    expect(assessRegexSafety('(?<w>foo)\\k<w>').ok).toBe(false)
  })

  it('does not mistake an escaped backslash for a backreference', () => {
    expect(assessRegexSafety('a\\\\b').ok).toBe(true)
  })

  it('does not mistake a literal quantifier char for a quantifier', () => {
    expect(assessRegexSafety('(a\\+)+').ok).toBe(true)
    expect(assessRegexSafety('(a[+*])+').ok).toBe(true)
  })

  it('caps the pattern length', () => {
    const long = 'a'.repeat(MAX_PATTERN_LENGTH + 1)
    const verdict = assessRegexSafety(long)
    expect(verdict.ok).toBe(false)
    if (!verdict.ok) expect(verdict.reason).toMatch(/cap is 200/)
  })

  it('rejects a pattern that does not compile', () => {
    expect(assessRegexSafety('([').ok).toBe(false)
  })

  it('rejects an empty pattern', () => {
    expect(assessRegexSafety('').ok).toBe(false)
  })
})

describe('safeRegexTest', () => {
  it('matches a good pattern', () => {
    expect(safeRegexTest('the knot pro network', 'Sent via The Knot Pro Network')).toBe(true)
    expect(safeRegexTest('zola', 'Sent via The Knot')).toBe(false)
  })

  it('refuses a catastrophic pattern instead of running it', () => {
    const skips: string[] = []
    // 40k of 'a' with no trailing 'b' is the exponential input for
    // ^(a+)+$. If this ever actually ran, the test would never finish.
    const haystack = 'a'.repeat(40_000) + 'b'
    const started = Date.now()
    expect(safeRegexTest('^(a+)+$', haystack, (r) => skips.push(r))).toBe(false)
    expect(Date.now() - started).toBeLessThan(1_000)
    expect(skips[0]).toMatch(/nested quantifier/)
  })

  it('caps the haystack it hands a pattern', () => {
    // The needle sits past the cap, so a capped match cannot find it.
    const haystack = 'x'.repeat(MAX_HAYSTACK_CHARS + 50) + 'NEEDLE'
    expect(safeRegexTest('NEEDLE', haystack)).toBe(false)
    expect(safeRegexTest('NEEDLE', 'NEEDLE' + haystack)).toBe(true)
  })

  it('never throws on a broken pattern', () => {
    expect(() => safeRegexTest('([', 'anything')).not.toThrow()
    expect(safeRegexTest('([', 'anything')).toBe(false)
  })
})
