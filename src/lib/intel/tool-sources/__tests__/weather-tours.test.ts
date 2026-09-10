import { describe, it, expect } from 'vitest'
import { weatherToursToolSource } from '../weather-tours'
import { makeFakeSupabase } from './fake-supabase'

const VENUE_ID = 'venue-1'

describe('weather-tours tool source', () => {
  it('is registered against battery Q10', () => {
    expect(weatherToursToolSource.batteryQuestions).toContain('10')
    expect(weatherToursToolSource.tool.name).toBe('get_weather_tour_outcomes')
  })

  it('refuses honestly with the exact reason when no weather history is stored', async () => {
    const supabase = makeFakeSupabase((table) => {
      if (table === 'weather_data') return { data: [] }
      return { data: [] }
    })
    const result = (await weatherToursToolSource.run(VENUE_ID, {}, {
      supabase,
      today: '2026-09-09',
    })) as { n: number; enoughData: boolean; reason?: string }
    expect(result.enoughData).toBe(false)
    expect(result.reason).toBe('no weather history stored')
  })

  it('never fetches a live forecast: only reads weather_data and tours', async () => {
    const tablesQueried: string[] = []
    const supabase = makeFakeSupabase((table) => {
      tablesQueried.push(table)
      if (table === 'weather_data') {
        return { data: [{ date: '2026-06-06', high_temp: 80, low_temp: 60, precipitation: 0 }] }
      }
      return { data: [] }
    })
    await weatherToursToolSource.run(VENUE_ID, {}, { supabase, today: '2026-09-09' })
    expect(tablesQueried).toEqual(['weather_data', 'tours'])
  })

  it('refuses when weather history exists but no tour dates overlap it', async () => {
    const supabase = makeFakeSupabase((table) => {
      if (table === 'weather_data') {
        return { data: [{ date: '2020-01-01', high_temp: 40, low_temp: 20, precipitation: 0 }] }
      }
      if (table === 'tours') {
        return { data: [{ scheduled_at: '2026-06-06T14:00:00Z', outcome: 'completed' }] }
      }
      return { data: [] }
    })
    const result = (await weatherToursToolSource.run(VENUE_ID, {}, {
      supabase,
      today: '2026-09-09',
    })) as { n: number; enoughData: boolean; reason?: string }
    expect(result.enoughData).toBe(false)
    expect(result.reason).toMatch(/none.*overlap/)
  })

  it('buckets tours by bad vs fair weather and computes no-show/reschedule/conversion rates', async () => {
    const weather = [
      // Bad weather days (heavy rain), 8 of them
      ...Array.from({ length: 8 }, (_, i) => ({
        date: `2026-06-0${i + 1}`,
        high_temp: 70,
        low_temp: 55,
        precipitation: 1.2,
      })),
      // Fair weather days, 8 of them
      ...Array.from({ length: 8 }, (_, i) => ({
        date: `2026-07-0${i + 1}`,
        high_temp: 75,
        low_temp: 60,
        precipitation: 0,
      })),
    ]
    const tours = [
      // Bad weather, 8 tours: 2 no-show, 1 rescheduled, 5 showed up (3
      // completed, 1 booked, 1 lost) -> converted 1/5 = 20%.
      { scheduled_at: '2026-06-01T14:00:00Z', outcome: 'no_show' },
      { scheduled_at: '2026-06-02T14:00:00Z', outcome: 'no_show' },
      { scheduled_at: '2026-06-03T14:00:00Z', outcome: 'rescheduled' },
      { scheduled_at: '2026-06-04T14:00:00Z', outcome: 'completed' },
      { scheduled_at: '2026-06-05T14:00:00Z', outcome: 'completed' },
      { scheduled_at: '2026-06-06T14:00:00Z', outcome: 'completed' },
      { scheduled_at: '2026-06-07T14:00:00Z', outcome: 'booked' },
      { scheduled_at: '2026-06-08T14:00:00Z', outcome: 'lost' },
      // Fair weather, 8 tours: 0 no-show, all 8 showed up, 5 booked ->
      // converted 5/8 = 62.5%.
      { scheduled_at: '2026-07-01T14:00:00Z', outcome: 'booked' },
      { scheduled_at: '2026-07-02T14:00:00Z', outcome: 'booked' },
      { scheduled_at: '2026-07-03T14:00:00Z', outcome: 'booked' },
      { scheduled_at: '2026-07-04T14:00:00Z', outcome: 'booked' },
      { scheduled_at: '2026-07-05T14:00:00Z', outcome: 'booked' },
      { scheduled_at: '2026-07-06T14:00:00Z', outcome: 'completed' },
      { scheduled_at: '2026-07-07T14:00:00Z', outcome: 'completed' },
      { scheduled_at: '2026-07-08T14:00:00Z', outcome: 'completed' },
    ]
    const supabase = makeFakeSupabase((table) => {
      if (table === 'weather_data') return { data: weather }
      if (table === 'tours') return { data: tours }
      return { data: [] }
    })
    const result = (await weatherToursToolSource.run(VENUE_ID, {}, {
      supabase,
      today: '2026-09-09',
    })) as {
      n: number
      enoughData: boolean
      badWeather: { n: number; noShowRatePct: number | null; convertedRatePct: number | null }
      fairWeather: { n: number; noShowRatePct: number | null; convertedRatePct: number | null }
    }

    expect(result.enoughData).toBe(true)
    expect(result.n).toBe(16)
    expect(result.badWeather.n).toBe(8)
    expect(result.badWeather.noShowRatePct).toBe(25) // 2/8
    expect(result.fairWeather.n).toBe(8)
    expect(result.fairWeather.noShowRatePct).toBe(0)
    // Bad weather converts worse than fair weather among tours that showed up.
    expect(result.badWeather.convertedRatePct).toBe(20) // 1/5
    expect(result.fairWeather.convertedRatePct).toBe(62.5) // 5/8
  })
})
