import { describe, it, expect } from 'vitest'
import { capacityToolSource } from '../capacity'
import { makeFakeSupabase } from './fake-supabase'

const VENUE_ID = 'venue-1'

interface CapacityResult {
  n: number
  enoughData: boolean
  primeMonths: number[]
  horizonMonths: number
  totalPrimeSaturdays: number
  bookedPrimeSaturdays: number
  openSaturdays: { n: number; dates: string[]; truncated: boolean }
  pace:
    | { n: number; enoughData: true; thisYear: { n: number }; lastYear: { n: number }; delta: number; aheadOfLastYear: boolean }
    | { n: number; enoughData: false; reason: string }
}

async function run(
  args: Record<string, unknown>,
  weddingRows: unknown[] = [],
  bookedAtRows: { thisYear?: unknown[]; lastYear?: unknown[] } = {},
): Promise<CapacityResult> {
  let call = 0
  const supabase = makeFakeSupabase((table) => {
    if (table === 'weddings') {
      call++
      // First call is the "open Saturdays" (status=booked, wedding_date range)
      // query; the next two are the this-year / last-year booked_at pace
      // queries, in that order (Promise.all preserves array order but not
      // necessarily call order across a real network — the fake resolves
      // synchronously per query so this is deterministic here).
      if (call === 1) return { data: weddingRows }
      if (call === 2) return { data: bookedAtRows.thisYear ?? [] }
      return { data: bookedAtRows.lastYear ?? [] }
    }
    return { data: [] }
  })
  return (await capacityToolSource.run(VENUE_ID, args, {
    supabase,
    today: '2026-09-09',
  })) as CapacityResult
}

describe('capacity tool source', () => {
  it('is registered against battery Q39', () => {
    expect(capacityToolSource.batteryQuestions).toContain('39')
    expect(capacityToolSource.tool.name).toBe('get_prime_saturday_capacity')
  })

  it('defaults prime months to May, June, September, October over a 12-month horizon', async () => {
    const result = await run({})
    expect(result.primeMonths).toEqual([5, 6, 9, 10])
    expect(result.totalPrimeSaturdays).toBeGreaterThan(0)
    for (const d of result.openSaturdays.dates) {
      const parsed = new Date(`${d}T00:00:00Z`)
      expect(parsed.getUTCDay()).toBe(6) // every date is a Saturday
      expect([5, 6, 9, 10]).toContain(parsed.getUTCMonth() + 1)
    }
  })

  it('excludes a Saturday with a booked wedding from the open list', async () => {
    const unbooked = await run({ prime_months: [9], horizon_months: 1 })
    expect(unbooked.openSaturdays.n).toBeGreaterThan(0)
    const target = unbooked.openSaturdays.dates[0]

    const booked = await run({ prime_months: [9], horizon_months: 1 }, [{ wedding_date: target }])
    expect(booked.openSaturdays.dates).not.toContain(target)
    expect(booked.bookedPrimeSaturdays).toBe(1)
    expect(booked.openSaturdays.n).toBe(unbooked.openSaturdays.n - 1)
  })

  it('computes pace as this-year bookings vs last-year bookings through the same calendar date', async () => {
    const result = await run(
      {},
      [],
      {
        thisYear: [{ booked_at: '2026-03-01T00:00:00Z' }, { booked_at: '2026-06-15T00:00:00Z' }],
        lastYear: [{ booked_at: '2025-04-01T00:00:00Z' }],
      },
    )
    expect(result.pace.enoughData).toBe(true)
    if (result.pace.enoughData) {
      expect(result.pace.thisYear.n).toBe(2)
      expect(result.pace.lastYear.n).toBe(1)
      expect(result.pace.delta).toBe(1)
      expect(result.pace.aheadOfLastYear).toBe(true)
    }
  })

  it('refuses the pace comparison honestly when too few bookings exist', async () => {
    const result = await run({}, [], { thisYear: [], lastYear: [] })
    expect(result.pace.enoughData).toBe(false)
    if (!result.pace.enoughData) {
      expect(result.pace.reason).toMatch(/fewer than 3/)
    }
  })

  it('falls back to defaults for an out-of-range prime_months or horizon_months', async () => {
    const result = await run({ prime_months: [13, -1, 0], horizon_months: 999 })
    expect(result.primeMonths).toEqual([5, 6, 9, 10])
    expect(result.horizonMonths).toBe(12)
  })
})
