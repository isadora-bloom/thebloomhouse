/**
 * PostgREST `.or()` value escaping — 2026-09-14 security review, item 5.
 *
 * `searchKnowledgeBase` splits the couple's raw chat message into words and
 * interpolates each one into an `.or()` filter string. Two things had to be
 * true and neither was: a word containing a LIKE wildcard must not widen the
 * match, and a word containing the filter grammar must not end the clause
 * early and turn the chat into a 400.
 */
import { describe, it, expect } from 'vitest'
import { escapeIlike } from '@/lib/db/escape-ilike'

describe('escapeIlike', () => {
  it('escapes the LIKE wildcards so they match literally', () => {
    expect(escapeIlike('100%')).toBe('100\\%')
    expect(escapeIlike('a_b')).toBe('a\\_b')
    expect(escapeIlike('%%')).toBe('\\%\\%')
  })

  it('neutralises every character that carries meaning in the filter grammar', () => {
    for (const ch of [',', '(', ')', '.', "'", '"', '\\']) {
      const out = escapeIlike(`a${ch}b`)
      expect(out, `"${ch}" survived`).not.toContain(ch)
      expect(out).toBe('a b')
    }
  })

  it('leaves ordinary text alone', () => {
    expect(escapeIlike('cancellation policy')).toBe('cancellation policy')
    expect(escapeIlike('bar')).toBe('bar')
  })

  it('never emits a stray backslash that could escape the wrong thing', () => {
    // A caller-supplied backslash is replaced before the wildcard escapes go
    // in, so the only backslashes in the output are the ones this function
    // added, and each is followed by a wildcard.
    const out = escapeIlike('\\%weird\\_input\\')
    for (const m of out.matchAll(/\\(.?)/g)) {
      expect(['%', '_']).toContain(m[1])
    }
  })

  it('builds a filter clause that a message of pure punctuation cannot break', () => {
    // The literal case from the review: ",()%" in a couple's message.
    const word = escapeIlike(',()%')
    const clause = `question.ilike.%${word}%`
    // One comma-free clause. If any of the four characters had survived,
    // splitting the assembled .or() string on commas would give more than
    // one part, or the brackets would open a group that never closes.
    expect(clause.split(',')).toHaveLength(1)
    expect(clause).not.toContain('(')
    expect(clause).not.toContain(')')
    // And the wildcard is escaped, so the pattern is not `%%...%%`.
    expect(clause).toBe('question.ilike.%   \\%%')
  })
})
