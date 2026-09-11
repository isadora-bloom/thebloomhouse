/**
 * Venue-timezone calendar boundaries for the tours page (Wave 4, W31).
 *
 * The bug: "upcoming" and "this year" used to compare against a
 * boundary built from the browser's local clock, not the venue's own
 * timezone. A tour late in the evening near a zone boundary could read
 * as the wrong day, or the wrong year, depending on where the
 * coordinator's browser happened to sit. `venueCalendarParts` and the
 * two boundary predicates below resolve each tour against its own
 * venue's zone instead.
 */

import { describe, it, expect } from 'vitest'
import {
  venueCalendarParts,
  calendarDayNumber,
  isOnOrAfterVenueToday,
  isVenueThisYear,
} from '../page'

const NY = 'America/New_York'

describe('venueCalendarParts', () => {
  it('reads the venue-local calendar date, not the UTC one', () => {
    // 11pm on 31 Dec in America/New_York (EST, UTC-5) is already
    // 4am 1 Jan in UTC.
    expect(venueCalendarParts('2027-01-01T04:00:00.000Z', NY)).toEqual({
      year: 2026,
      month: 12,
      day: 31,
    })
  })

  it('returns null for an unparseable instant', () => {
    expect(venueCalendarParts('not-a-date', NY)).toBeNull()
  })
})

describe('a tour at 11pm venue time on 31 December counts as this year', () => {
  const tourAt11pmDec31NY = '2027-01-01T04:00:00.000Z' // UTC already rolled to 1 Jan
  const nowStillDec31NY = '2026-12-31T20:00:00.000Z' // 3pm on 31 Dec in NY

  it('isVenueThisYear says yes, using the venue zone', () => {
    expect(isVenueThisYear(tourAt11pmDec31NY, NY, nowStillDec31NY)).toBe(true)
  })

  it('the naive UTC year would have said no — this is the bug being fixed', () => {
    expect(new Date(tourAt11pmDec31NY).getUTCFullYear()).toBe(2027)
    expect(new Date(nowStillDec31NY).getUTCFullYear()).toBe(2026)
  })

  it('isOnOrAfterVenueToday also treats it as still today, so it stays "upcoming"', () => {
    expect(isOnOrAfterVenueToday(tourAt11pmDec31NY, NY, nowStillDec31NY)).toBe(true)
  })
})

describe('isVenueThisYear', () => {
  it('is false once the venue-local calendar has actually turned over', () => {
    const earlyJanNY = '2026-01-01T10:00:00.000Z' // 5am 1 Jan in NY
    const nowStillDec31NY = '2025-12-31T20:00:00.000Z' // 3pm 31 Dec in NY
    expect(isVenueThisYear(earlyJanNY, NY, nowStillDec31NY)).toBe(false)
  })

  it('is false when either instant is unparseable', () => {
    expect(isVenueThisYear('nope', NY, '2026-01-01T00:00:00.000Z')).toBe(false)
    expect(isVenueThisYear('2026-01-01T00:00:00.000Z', NY, 'nope')).toBe(false)
  })
})

describe('isOnOrAfterVenueToday', () => {
  it('is false for a tour that already ran, in venue-local terms', () => {
    const yesterdayNY = '2026-06-01T13:00:00.000Z' // 9am 1 Jun in NY
    const todayNY = '2026-06-02T13:00:00.000Z' // 9am 2 Jun in NY
    expect(isOnOrAfterVenueToday(yesterdayNY, NY, todayNY)).toBe(false)
  })

  it('is true for later today and for future days, in venue-local terms', () => {
    const laterTodayNY = '2026-06-02T23:00:00.000Z' // 7pm 2 Jun in NY
    const todayNY = '2026-06-02T13:00:00.000Z' // 9am 2 Jun in NY
    expect(isOnOrAfterVenueToday(laterTodayNY, NY, todayNY)).toBe(true)
  })
})

describe('calendarDayNumber', () => {
  it('orders consecutive days by one', () => {
    const d1 = calendarDayNumber({ year: 2026, month: 12, day: 31 })
    const d2 = calendarDayNumber({ year: 2027, month: 1, day: 1 })
    expect(d2 - d1).toBe(1)
  })
})
