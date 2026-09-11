/**
 * Relative-age back-derivation (wave 3, W23).
 *
 * The trap this is guarding is "5mo" being read as five minutes, which
 * would put a five-month-old follow on today's ribbon and make a cold
 * lead look warm. The second trap is the anchor: everything is measured
 * from the capture, so a replay next year lands on the same instant.
 */

import { describe, it, expect } from 'vitest'
import { parseRelativeAge } from '../date-parser'

const CAPTURE = '2026-09-09T12:00:00.000Z'

function at(raw: string): string | null {
  return parseRelativeAge(raw, CAPTURE)?.occurred_at ?? null
}

describe('short forms', () => {
  it('minutes', () => expect(at('20m')).toBe('2026-09-09T11:40:00.000Z'))
  it('hours', () => expect(at('3h')).toBe('2026-09-09T09:00:00.000Z'))
  it('days', () => expect(at('2d')).toBe('2026-09-07T12:00:00.000Z'))
  it('weeks', () => expect(at('1w')).toBe('2026-09-02T12:00:00.000Z'))
  it('months step the calendar, not 30 days of milliseconds', () => {
    expect(at('5mo')).toBe('2026-04-09T12:00:00.000Z')
  })
  it('years', () => expect(at('2y')).toBe('2024-09-09T12:00:00.000Z'))
  it('does not confuse months with minutes', () => {
    expect(at('5mo')).not.toBe(at('5m'))
  })
})

describe('long forms', () => {
  it('reads "2 days ago"', () => expect(at('2 days ago')).toBe('2026-09-07T12:00:00.000Z'))
  it('reads "about 3 weeks ago"', () => expect(at('about 3 weeks ago')).toBe('2026-08-19T12:00:00.000Z'))
  it('reads "now"', () => expect(at('now')).toBe(CAPTURE))
  it('reads "yesterday"', () => expect(at('yesterday')).toBe('2026-09-08T12:00:00.000Z'))
})

describe('absolute forms', () => {
  it('a month and a day this year', () => expect(at('May 04')).toBe('2026-05-04T00:00:00.000Z'))
  it('a month and a day that has not happened yet is last year', () => {
    expect(at('Dec 12')).toBe('2025-12-12T00:00:00.000Z')
  })
  it('day then month', () => expect(at('4 May')).toBe('2026-05-04T00:00:00.000Z'))
  it('an explicit year wins', () => expect(at('May 4 2023')).toBe('2023-05-04T00:00:00.000Z'))
  it('a month and a year is the first of that month', () => {
    expect(at('Mar 2026')).toBe('2026-03-01T00:00:00.000Z')
    expect(at('March 2026')).toBe('2026-03-01T00:00:00.000Z')
  })
  it('an ISO date', () => expect(at('2026-05-04')).toBe('2026-05-04T00:00:00.000Z'))
})

describe('precision travels with the answer', () => {
  it('a week is a week, not a day (Wave 4 W31: was falsely day-precise)', () => {
    expect(parseRelativeAge('1w', CAPTURE)?.precision).toBe('week')
    expect(parseRelativeAge('3 weeks ago', CAPTURE)?.precision).toBe('week')
  })
  it('a day is still a day', () => {
    expect(parseRelativeAge('2d', CAPTURE)?.precision).toBe('day')
  })
  it('minutes are exact', () => {
    expect(parseRelativeAge('20m', CAPTURE)?.precision).toBe('exact')
  })
  it('hours are hours', () => {
    expect(parseRelativeAge('3h', CAPTURE)?.precision).toBe('hour')
  })
  it('a relative month is a month, same as a bare month', () => {
    expect(parseRelativeAge('5mo', CAPTURE)?.precision).toBe('month')
    expect(parseRelativeAge('Mar 2026', CAPTURE)?.precision).toBe('month')
  })
  it('keeps the string it came from', () => {
    expect(parseRelativeAge('2d', CAPTURE)?.source).toBe('2d')
  })
})

describe('nothing rather than a guess', () => {
  for (const junk of ['', '   ', 'sometime', 'Followed by jen_bee', 'Verified', 'Smarch 40']) {
    it(`returns null for ${JSON.stringify(junk)}`, () => {
      expect(parseRelativeAge(junk, CAPTURE)).toBeNull()
    })
  }
  it('returns null for null and undefined', () => {
    expect(parseRelativeAge(null, CAPTURE)).toBeNull()
    expect(parseRelativeAge(undefined, CAPTURE)).toBeNull()
  })
  it('returns null when the anchor is unusable', () => {
    expect(parseRelativeAge('2d', 'not-a-date')).toBeNull()
  })
})

describe('the anchor is the capture, not the clock', () => {
  it('gives the same answer for the same capture whenever it runs', () => {
    const a = parseRelativeAge('2d', CAPTURE)
    const b = parseRelativeAge('2d', new Date(CAPTURE))
    expect(a?.occurred_at).toBe(b?.occurred_at)
  })
  it('moves with the capture, so two captures of the same age differ', () => {
    expect(parseRelativeAge('2d', '2026-09-09T12:00:00.000Z')?.occurred_at).not.toBe(
      parseRelativeAge('2d', '2026-08-09T12:00:00.000Z')?.occurred_at,
    )
  })
})
