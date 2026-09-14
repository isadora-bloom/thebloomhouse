/**
 * The hand-rolled PDF writer. Not a rendering test, a structure one: the
 * file has to be something a reader will open, and the text has to be
 * inside it rather than running off the right-hand edge.
 */

import { describe, it, expect } from 'vitest'
import { contractBlocks, renderPdf, toLatin1, wrapLine } from '../pdf'

function asText(bytes: Uint8Array): string {
  let out = ''
  for (const b of bytes) out += String.fromCharCode(b)
  return out
}

describe('toLatin1', () => {
  it('folds the typographic characters a template picks up from a paste', () => {
    expect(toLatin1('‘quote’')).toBe("'quote'")
    expect(toLatin1('“quote”')).toBe('"quote"')
    expect(toLatin1('a – b')).toBe('a - b')
    expect(toLatin1('wait…')).toBe('wait...')
  })

  it('keeps accented Latin-1 as it is', () => {
    expect(toLatin1('café')).toBe('café')
  })

  it('drops what it cannot represent rather than printing a placeholder', () => {
    expect(toLatin1('a 中 b')).toBe('a  b')
  })
})

describe('wrapLine', () => {
  it('keeps a short line on one line', () => {
    expect(wrapLine('Total: $18,500.', 10.5, 'regular')).toEqual(['Total: $18,500.'])
  })

  it('breaks a long paragraph into several', () => {
    const long = 'The balance is due 30 days before the wedding. '.repeat(6)
    const lines = wrapLine(long, 10.5, 'regular')
    expect(lines.length).toBeGreaterThan(2)
    // Nothing lost.
    expect(lines.join(' ').replace(/\s+/g, ' ').trim()).toBe(
      long.replace(/\s+/g, ' ').trim(),
    )
  })

  it('hard-breaks a single word longer than the page', () => {
    const lines = wrapLine('x'.repeat(400), 10.5, 'regular')
    expect(lines.length).toBeGreaterThan(1)
    expect(lines.join('')).toBe('x'.repeat(400))
  })

  it('returns one empty line for empty input rather than nothing', () => {
    expect(wrapLine('   ', 10.5, 'regular')).toEqual([''])
  })
})

describe('renderPdf', () => {
  const doc = {
    title: 'Wedding agreement',
    intro: 'This is the agreement between Chloe and Ryan and Crestwood Farm.',
    sections: [
      { heading: '1. What you have booked', lines: ['Package: Saturday Full Weekend.'] },
      { heading: '2. What it costs', lines: ['Total: $18,500.', 'Deposit: $5,000.'] },
    ],
    closing: 'Questions go to Sarah Chen.',
  }

  it('writes a file a reader will open', () => {
    const text = asText(renderPdf(contractBlocks(doc)))
    expect(text.startsWith('%PDF-1.4')).toBe(true)
    expect(text.trimEnd().endsWith('%%EOF')).toBe(true)
    expect(text).toContain('/Type /Catalog')
    expect(text).toContain('/Type /Pages')
    expect(text).toContain('xref')
    expect(text).toContain('startxref')
  })

  it('points the cross-reference table at the real byte offsets', () => {
    const text = asText(renderPdf(contractBlocks(doc)))
    const start = Number(text.match(/startxref\s+(\d+)/)?.[1])
    expect(text.slice(start, start + 4)).toBe('xref')

    const offsets = [...text.matchAll(/^(\d{10}) 00000 n $/gm)].map((m) => Number(m[1]))
    expect(offsets.length).toBeGreaterThan(4)
    offsets.forEach((off, i) => {
      expect(text.slice(off)).toMatch(new RegExp(`^${i + 1} 0 obj`))
    })
  })

  it('puts the words in the file', () => {
    const text = asText(renderPdf(contractBlocks(doc)))
    expect(text).toContain('Wedding agreement')
    expect(text).toContain('Total: $18,500.')
  })

  it('escapes the characters that would close a PDF string early', () => {
    const text = asText(
      renderPdf([
        { text: 'a (b) c \\ d', face: 'regular', size: 10, spaceBefore: 0 },
      ]),
    )
    expect(text).toContain('a \\(b\\) c \\\\ d')
  })

  it('starts a second page rather than running off the bottom', () => {
    const many = Array.from({ length: 200 }, (_, i) => ({
      text: `Clause line number ${i}, which says something about the wedding.`,
      face: 'regular' as const,
      size: 10.5,
      spaceBefore: 2,
    }))
    const text = asText(renderPdf(many))
    const pageCount = Number(text.match(/\/Count (\d+)/)?.[1])
    expect(pageCount).toBeGreaterThan(1)
    expect(text).toContain(`Page 1 of ${pageCount}`)
    expect(text).toContain(`Page ${pageCount} of ${pageCount}`)
  })
})
