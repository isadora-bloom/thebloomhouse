/**
 * weather-cancellation.ts (W67, 2026-09-14 verification gap).
 *
 * Three behaviours pinned, none of which need the LLM narrator or the
 * persist layer: every scenario here is engineered so no bucket clears
 * the 1.5x-baseline trigger (either because there are zero cancellations
 * anywhere, or because the cancellations land in the 'clear' bucket,
 * which is excluded from ever triggering). That keeps `buckets` — the
 * one field every return path carries — as the sole thing under test,
 * and lets these stay unit tests against a fake Supabase client instead
 * of an integration test against callAIJson / gateForBrainCall / the
 * intelligence_insights table.
 *
 *  1. Severity from a real NWS alert wins over the day's `conditions`
 *     text — a day marked 'Clear sky' still buckets as 'severe_weather'
 *     when a severe alert covers it.
 *  2. There is no keyword branch on `conditions` for tornado/hurricane
 *     (W49 removed the dead Open-Meteo string-match — those two literal
 *     substrings can never appear in Open-Meteo's condition text, but
 *     this pins that a *word* like "Tornado" appearing in `conditions`
 *     for some other reason does not itself cause a severe_weather
 *     bucket without a real alert backing it).
 *  3. When the alert feed fails closed (getAlertDayMap's own contract:
 *     network/parse errors never throw, they degrade to an empty map),
 *     tours that WOULD have bucketed as severe_weather with alert data
 *     fall back to 'clear' weather.data, which can never be a trigger
 *     bucket — so a real cluster of cancellations on those days produces
 *     no cancellation-flag insight rather than a fabricated one.
 */
import { describe, it, expect, vi } from 'vitest'
import type { SupabaseClient } from '@supabase/supabase-js'
import { analyzeWeatherCancellations } from '../weather-cancellation'

// nws-alerts.ts is a small, self-contained module (only imports
// redactError) — safe to importOriginal and only replace the one
// network-backed function, unlike the canonical.ts mock elsewhere in
// this wave (see monthly-story.test.ts).
vi.mock('@/lib/services/intel/nws-alerts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/services/intel/nws-alerts')>()
  return { ...actual, getAlertDayMap: vi.fn() }
})

import { getAlertDayMap } from '@/lib/services/intel/nws-alerts'

const VENUE_ID = 'venue-weather-test'

interface WeatherRowFixture {
  date: string
  high_temp: number | null
  low_temp: number | null
  precipitation: number | null
  conditions: string | null
}

interface TourRowFixture {
  id: string
  scheduled_at: string
  outcome: string
  cancellation_reason: string | null
}

/** Minimal chainable fake — every call in the source path either awaits
 *  the chain directly (thenable) or terminates on `.maybeSingle()`. No
 *  filter is actually applied; the fixture supplies exactly the rows
 *  each table should return for this venue. Same shape as the fake
 *  client in autonomous-sender.test.ts. */
function makeFakeSupabase(fixture: {
  venue: { latitude: number | null; longitude: number | null; noaa_station_id: string | null } | null
  weatherRows: WeatherRowFixture[]
  tourRows: TourRowFixture[]
}): SupabaseClient {
  function builder(table: string) {
    const chain: {
      select: () => typeof chain
      eq: () => typeof chain
      gte: () => typeof chain
      lte: () => typeof chain
      not: () => typeof chain
      neq: () => typeof chain
      maybeSingle: () => Promise<{ data: unknown; error: null }>
      then: (
        resolve: (v: { data: unknown; error: null }) => unknown,
        reject?: (e: unknown) => unknown,
      ) => Promise<unknown>
    } = {
      select: () => chain,
      eq: () => chain,
      gte: () => chain,
      lte: () => chain,
      not: () => chain,
      neq: () => chain,
      maybeSingle: async () => ({ data: table === 'venues' ? fixture.venue : null, error: null }),
      then: (resolve, reject) => {
        const data = table === 'weather_data' ? fixture.weatherRows : table === 'tours' ? fixture.tourRows : []
        return Promise.resolve({ data, error: null }).then(resolve, reject)
      },
    }
    return chain
  }
  return { from: (table: string) => builder(table) } as unknown as SupabaseClient
}

const VENUE_WITH_GEO = { latitude: 38.9, longitude: -77.6, noaa_station_id: null }

/** 20 tours (MIN_TOTAL_TOURS) spread across two ten-tour cohorts, all
 *  matched to weather rows so every one lands in a bucket. */
function buildTours(opts: {
  groupADates: string[]
  groupAOutcomes: string[]
  groupBDates: string[]
  groupBOutcomes: string[]
}): TourRowFixture[] {
  const rows: TourRowFixture[] = []
  opts.groupADates.forEach((date, i) => {
    rows.push({
      id: `a${i}`,
      scheduled_at: `${date}T14:00:00.000Z`,
      outcome: opts.groupAOutcomes[i],
      cancellation_reason: opts.groupAOutcomes[i] === 'cancelled' ? 'weather' : null,
    })
  })
  opts.groupBDates.forEach((date, i) => {
    rows.push({
      id: `b${i}`,
      scheduled_at: `${date}T14:00:00.000Z`,
      outcome: opts.groupBOutcomes[i],
      cancellation_reason: null,
    })
  })
  return rows
}

describe('analyzeWeatherCancellations', () => {
  it('buckets a day as severe_weather from a real NWS alert even though conditions reads clear', async () => {
    // Ten tours on an alert-covered day whose Open-Meteo conditions say
    // "Clear sky" (the alert must win), ten on a genuinely clear day
    // with no alert. Zero cancellations anywhere, so baselineRate stays
    // 0 and nothing can trigger — the test only inspects `buckets`.
    const alertDay = '2026-01-05'
    const clearDay = '2026-01-12'
    vi.mocked(getAlertDayMap).mockResolvedValue(
      new Map([[alertDay, { event: 'Tornado Warning', severity: 'Extreme', onset: null, ends: null }]]),
    )

    const weatherRows: WeatherRowFixture[] = [
      { date: alertDay, high_temp: 55, low_temp: 40, precipitation: 0, conditions: 'Clear sky' },
      { date: clearDay, high_temp: 55, low_temp: 40, precipitation: 0, conditions: 'Clear sky' },
    ]
    const tourRows = buildTours({
      groupADates: Array(10).fill(alertDay),
      groupAOutcomes: Array(10).fill('completed'),
      groupBDates: Array(10).fill(clearDay),
      groupBOutcomes: Array(10).fill('completed'),
    })

    const supabase = makeFakeSupabase({ venue: VENUE_WITH_GEO, weatherRows, tourRows })
    const result = await analyzeWeatherCancellations(supabase, VENUE_ID)

    expect(result.ok).toBe(true)
    expect(result.buckets?.severe_weather?.tours).toBe(10)
    expect(result.buckets?.clear?.tours).toBe(10)
    // The literal-conditions bucket ('clear') must NOT have absorbed the
    // alert day's tours just because the text said "Clear sky".
    expect(result.buckets?.clear?.tours).not.toBe(20)
  })

  it('does not bucket as severe_weather from a "tornado"/"hurricane" substring in conditions alone (no keyword branch)', async () => {
    // No alert on record at all. If the dead keyword branch W49 removed
    // ever came back, a conditions string containing "Tornado" would
    // wrongly land here as severe_weather.
    const day = '2026-02-01'
    vi.mocked(getAlertDayMap).mockResolvedValue(new Map())

    const weatherRows: WeatherRowFixture[] = [
      { date: day, high_temp: 60, low_temp: 45, precipitation: 0, conditions: 'Tornado watch area, currently calm' },
    ]
    const tourRows = buildTours({
      groupADates: Array(20).fill(day),
      groupAOutcomes: Array(20).fill('completed'),
      groupBDates: [],
      groupBOutcomes: [],
    })

    const supabase = makeFakeSupabase({ venue: VENUE_WITH_GEO, weatherRows, tourRows })
    const result = await analyzeWeatherCancellations(supabase, VENUE_ID)

    expect(result.ok).toBe(true)
    expect(result.buckets?.severe_weather).toBeUndefined()
    expect(result.buckets?.clear?.tours).toBe(20)
  })

  it('fails closed: an alert-feed outage yields no cancellation flag instead of a fabricated one', async () => {
    // getAlertDayMap rejecting simulates the network/parse failure its
    // own module contract says degrades to an empty map (never throws
    // upward) — analyzeWeatherCancellations wraps the call in a .catch
    // for exactly this. Eight of the ten "would-be-severe" day tours
    // cancelled; had the alert resolved, that day would have bucketed
    // as severe_weather at an 80% cancel rate against a 40% baseline —
    // comfortably over the 1.5x trigger. Without the feed, those tours
    // fall into 'clear' (mild conditions, no precipitation), which the
    // detector never treats as a trigger candidate, so no insight fires.
    const wouldBeSevereDay = '2026-03-01'
    const clearDay = '2026-03-08'
    vi.mocked(getAlertDayMap).mockRejectedValue(new Error('NWS API unreachable'))

    const weatherRows: WeatherRowFixture[] = [
      { date: wouldBeSevereDay, high_temp: 70, low_temp: 50, precipitation: 0, conditions: 'Clear sky' },
      { date: clearDay, high_temp: 70, low_temp: 50, precipitation: 0, conditions: 'Clear sky' },
    ]
    const tourRows = buildTours({
      groupADates: Array(10).fill(wouldBeSevereDay),
      groupAOutcomes: [
        'cancelled', 'cancelled', 'cancelled', 'cancelled',
        'cancelled', 'cancelled', 'cancelled', 'cancelled',
        'completed', 'completed',
      ],
      groupBDates: Array(10).fill(clearDay),
      groupBOutcomes: Array(10).fill('completed'),
    })

    const supabase = makeFakeSupabase({ venue: VENUE_WITH_GEO, weatherRows, tourRows })
    const result = await analyzeWeatherCancellations(supabase, VENUE_ID)

    // No throw, no severe_weather bucket, and — the actual assertion the
    // test name promises — no cancellation-flag insight: dataGated with
    // no_signal, never a triggered/persisted result.
    expect(result.ok).toBe(true)
    expect(result.buckets?.severe_weather).toBeUndefined()
    expect(result.buckets?.clear?.tours).toBe(20)
    expect(result.buckets?.clear?.cancellations).toBe(8)
    expect(result.dataGated).toBe(true)
    expect(result.gatedReason).toBe('no_signal')
    expect(result.insightId).toBeUndefined()
  })
})
