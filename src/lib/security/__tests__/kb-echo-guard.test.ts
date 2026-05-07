import { describe, it, expect } from 'vitest'
import { detectKbEcho } from '../kb-echo-guard'

describe('detectKbEcho', () => {
  it('returns matched=false on empty KB', () => {
    const r = detectKbEcho('Some draft text that is plenty long enough', [])
    expect(r.matched).toBe(false)
    expect(r.longestMatchWords).toBe(0)
    expect(r.sampleSnippet).toBeNull()
    expect(r.kbEntryIndex).toBeNull()
  })

  it('returns matched=false when draft has no KB overlap', () => {
    const r = detectKbEcho(
      'We can absolutely accommodate your guest list and look forward to discussing.',
      [{ answer: 'The venue holds up to 200 guests with table seating arrangements.' }],
    )
    expect(r.matched).toBe(false)
  })

  it('detects an exact 8-token verbatim echo', () => {
    const kbAnswer = 'We host weddings between May and October every calendar year here.'
    const draft = `Thanks for asking — we host weddings between May and October every calendar year here. Let us know.`
    const r = detectKbEcho(draft, [{ answer: kbAnswer }])
    expect(r.matched).toBe(true)
    expect(r.longestMatchWords).toBeGreaterThanOrEqual(8)
    expect(r.kbEntryIndex).toBe(0)
    expect(r.sampleSnippet).toContain('host weddings between May and October')
  })

  it('returns matched=false on a 7-token echo (below threshold)', () => {
    // 7 contiguous tokens: "host weddings between May and October every"
    const kbAnswer = 'We host weddings between May and October every calendar year here.'
    // Insert an intervening token after "and" so contiguous matches max at 6 (or 4).
    const draft = `we host weddings between May and finally October every. Then we say something else.`
    const r = detectKbEcho(draft, [{ answer: kbAnswer }])
    expect(r.matched).toBe(false)
  })

  it('picks the longest run when multiple matches exist', () => {
    const kbAnswer = 'Our pricing is fully inclusive of catering tables linens and standard service.'
    const shortEchoKb = 'Hours are nine to five every weekday with a one-hour lunch.'
    const draft =
      'Hours are nine to five every weekday with a one-hour lunch. Also, our pricing is fully inclusive of catering tables linens and standard service today.'
    const r = detectKbEcho(draft, [{ answer: shortEchoKb }, { answer: kbAnswer }])
    expect(r.matched).toBe(true)
    expect(r.kbEntryIndex).toBe(1)
    expect(r.longestMatchWords).toBeGreaterThan(10)
  })

  it('treats casing and punctuation differences as the same token', () => {
    const kbAnswer = 'Our deposit is twenty percent due at signing of the venue agreement.'
    const draft = `OUR DEPOSIT IS TWENTY PERCENT, due at signing of the venue agreement!`
    const r = detectKbEcho(draft, [{ answer: kbAnswer }])
    expect(r.matched).toBe(true)
    expect(r.kbEntryIndex).toBe(0)
  })

  it('returns matched=false when draft is shorter than n-gram threshold', () => {
    const r = detectKbEcho(
      'Yes please',
      [{ answer: 'Yes please that works fine for our team and schedule today.' }],
    )
    expect(r.matched).toBe(false)
  })

  it('returns matched=false when KB answer is shorter than n-gram threshold', () => {
    const r = detectKbEcho(
      'Yes please that works fine for our team and schedule today.',
      [{ answer: 'Yes please' }],
    )
    expect(r.matched).toBe(false)
  })
})
