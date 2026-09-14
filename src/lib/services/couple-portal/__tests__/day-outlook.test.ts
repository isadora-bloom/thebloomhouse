/**
 * The wedding-day weather card, and the fallback that makes it honest
 * (W52).
 *
 * The point of this surface is the sentence under the number. A couple
 * eighteen months out and a couple eight days out see the same card, and
 * only one of them is looking at a forecast. If the card ever stops
 * saying which is which, it has started making a promise the venue
 * cannot keep on a Saturday in June.
 *
 * So: the mode chain (forecast when there is a real row inside the
 * horizon, the month's own record otherwise, nothing at all when there
 * is neither), and the copy that says so out loud.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'
import {
  FORECAST_HORIZON_DAYS,
  buildDayOutlookCard,
  emptyOutlook,
  loadDayOutlook,
  type DayOutlookFacts,
} from '../day-outlook'

const VENUE = 'venue-1'

/** Midday UTC on 14 September 2026. */
const NOW = Date.UTC(2026, 8, 14, 12)

function isoDaysFromNow(days: number): string {
  return new Date(NOW + days * 86_400_000).toISOString().slice(0, 10)
}

// ─────────────────────────────────────────────────────────────────────
// The builder
// ─────────────────────────────────────────────────────────────────────

describe('buildDayOutlookCard — forecast mode', () => {
  const facts: DayOutlookFacts = {
    mode: 'forecast',
    date: '2026-09-20',
    forecast: { highTemp: 74.4, lowTemp: 58.1, precipitation: 0, conditions: 'Clear' },
    typical: null,
  }

  it('leads with the high, rounded, in degrees', () => {
    expect(buildDayOutlookCard(facts)!.headline).toBe('74°F')
  })

  it('says plainly that it is a forecast and that it will move', () => {
    const card = buildDayOutlookCard(facts)!
    expect(card.basis).toMatch(/actual forecast/i)
    expect(card.basis).toMatch(/move a little/i)
    expect(card.mode).toBe('forecast')
  })

  it('describes rain in words rather than in inches', () => {
    const wet = buildDayOutlookCard({ ...facts, forecast: { ...facts.forecast!, precipitation: 0.8 } })!
    expect(wet.body).toMatch(/properly wet/i)
    expect(wet.body).not.toContain('0.8')
  })

  it('renders nothing when the forecast row is empty in every field that matters', () => {
    expect(
      buildDayOutlookCard({
        ...facts,
        forecast: { highTemp: null, lowTemp: null, precipitation: null, conditions: null },
      }),
    ).toBeNull()
  })
})

describe('buildDayOutlookCard — typical mode', () => {
  const facts: DayOutlookFacts = {
    mode: 'typical',
    date: '2028-06-10',
    forecast: null,
    typical: { monthLabel: 'June', daytimeTempF: 81.2, daytimePrecipProbPct: 18 },
  }

  it('says out loud that this is the month, not their day', () => {
    const card = buildDayOutlookCard(facts)!
    expect(card.basis).toMatch(/too far out for a forecast/i)
    expect(card.basis).toMatch(/venue/i)
    expect(card.mode).toBe('typical')
  })

  it('names the month in the body so the number is never mistaken for their date', () => {
    expect(buildDayOutlookCard(facts)!.body).toContain('June')
  })

  it('never claims a forecast it does not have', () => {
    expect(buildDayOutlookCard(facts)!.basis).not.toMatch(/actual forecast/i)
  })

  it('renders nothing when the month record holds neither a temperature nor a rain chance', () => {
    expect(
      buildDayOutlookCard({
        ...facts,
        typical: { monthLabel: 'June', daytimeTempF: null, daytimePrecipProbPct: null },
      }),
    ).toBeNull()
  })
})

describe('buildDayOutlookCard — nothing to say', () => {
  it('renders nothing rather than an empty card', () => {
    expect(buildDayOutlookCard(emptyOutlook('2028-06-10'))).toBeNull()
    expect(buildDayOutlookCard(emptyOutlook(null))).toBeNull()
  })
})

// ─────────────────────────────────────────────────────────────────────
// The fallback chain
// ─────────────────────────────────────────────────────────────────────

vi.mock('@/lib/services/intel/weather', () => ({
  getWeatherForDateRange: vi.fn(),
}))
vi.mock('@/lib/services/intel/climate-context', () => ({
  getVenueClimateContext: vi.fn(),
}))

const CLIMATE_AVAILABLE = {
  venueId: VENUE,
  available: true,
  promptBlock: 'June here is warm.',
  monthProfile: {
    month: 6,
    monthLabel: 'June',
    daytimeTempF: 81,
    daytimePrecipProbPct: 18,
    tempTrendF: null,
    precipTrendPct: null,
  },
  // Business numbers. The loader must not carry these across.
  recentAnomalies: [
    {
      description: 'A wet fortnight',
      startDate: '2026-06-01',
      durationDays: 14,
      severity: 'moderate',
      inquiriesDuring: 3,
      inquiriesTypical: 11,
      toursDuring: 1,
      toursTypical: 6,
    },
  ],
}

describe('loadDayOutlook', () => {
  beforeEach(async () => {
    const { getWeatherForDateRange } = await import('@/lib/services/intel/weather')
    const { getVenueClimateContext } = await import('@/lib/services/intel/climate-context')
    // Call counts matter in several of these, and the vitest config does
    // not clear them between tests.
    vi.clearAllMocks()
    vi.mocked(getWeatherForDateRange).mockResolvedValue([])
    vi.mocked(getVenueClimateContext).mockResolvedValue(CLIMATE_AVAILABLE as never)
  })

  it('uses the forecast when the day is inside the horizon and a row exists', async () => {
    const { getWeatherForDateRange } = await import('@/lib/services/intel/weather')
    const date = isoDaysFromNow(5)
    vi.mocked(getWeatherForDateRange).mockResolvedValue([
      { venue_id: VENUE, date, high_temp: 70, low_temp: 55, precipitation: 0, conditions: 'Clear', source: 'open-meteo' },
    ])

    const facts = await loadDayOutlook(VENUE, date, NOW)
    expect(facts.mode).toBe('forecast')
    expect(facts.forecast?.highTemp).toBe(70)
  })

  it('falls back to the month when the day is inside the horizon but no forecast row exists yet', async () => {
    const facts = await loadDayOutlook(VENUE, isoDaysFromNow(3), NOW)
    expect(facts.mode).toBe('typical')
    expect(facts.typical?.monthLabel).toBe('June')
  })

  it(`does not even ask for a forecast beyond ${FORECAST_HORIZON_DAYS} days`, async () => {
    const { getWeatherForDateRange } = await import('@/lib/services/intel/weather')
    const facts = await loadDayOutlook(VENUE, isoDaysFromNow(FORECAST_HORIZON_DAYS + 1), NOW)
    expect(vi.mocked(getWeatherForDateRange)).not.toHaveBeenCalled()
    expect(facts.mode).toBe('typical')
  })

  it('falls back to the month for a date already past', async () => {
    const { getWeatherForDateRange } = await import('@/lib/services/intel/weather')
    const facts = await loadDayOutlook(VENUE, isoDaysFromNow(-2), NOW)
    expect(vi.mocked(getWeatherForDateRange)).not.toHaveBeenCalled()
    expect(facts.mode).toBe('typical')
  })

  it('carries no business number across from the climate context', async () => {
    const facts = await loadDayOutlook(VENUE, isoDaysFromNow(400), NOW)
    const serialised = JSON.stringify(facts)
    expect(serialised).not.toContain('inquiries')
    expect(serialised).not.toContain('tours')
    expect(serialised).not.toContain('A wet fortnight')
  })

  it('says nothing at all when the venue has no climate record either', async () => {
    const { getVenueClimateContext } = await import('@/lib/services/intel/climate-context')
    vi.mocked(getVenueClimateContext).mockResolvedValue({
      venueId: VENUE,
      available: false,
      promptBlock: null,
      monthProfile: null,
      recentAnomalies: [],
    } as never)

    const facts = await loadDayOutlook(VENUE, isoDaysFromNow(400), NOW)
    expect(facts.mode).toBe('none')
    expect(buildDayOutlookCard(facts)).toBeNull()
  })

  it('says nothing at all when the wedding date is unknown, and reads nothing', async () => {
    const { getVenueClimateContext } = await import('@/lib/services/intel/climate-context')
    const facts = await loadDayOutlook(VENUE, null, NOW)
    expect(facts.mode).toBe('none')
    expect(vi.mocked(getVenueClimateContext)).not.toHaveBeenCalled()
  })

  it('falls through to the month when the forecast read throws, rather than failing the card', async () => {
    const { getWeatherForDateRange } = await import('@/lib/services/intel/weather')
    vi.mocked(getWeatherForDateRange).mockRejectedValue(new Error('weather is down'))
    const facts = await loadDayOutlook(VENUE, isoDaysFromNow(2), NOW)
    expect(facts.mode).toBe('typical')
  })

  it('says nothing at all when both reads throw', async () => {
    const { getWeatherForDateRange } = await import('@/lib/services/intel/weather')
    const { getVenueClimateContext } = await import('@/lib/services/intel/climate-context')
    vi.mocked(getWeatherForDateRange).mockRejectedValue(new Error('weather is down'))
    vi.mocked(getVenueClimateContext).mockRejectedValue(new Error('climate is down'))
    const facts = await loadDayOutlook(VENUE, isoDaysFromNow(2), NOW)
    expect(facts.mode).toBe('none')
  })
})
