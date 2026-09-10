import { describe, it, expect } from 'vitest'
import { lostDealsToolSource } from '../lost-deals'
import { makeFakeSupabase } from './fake-supabase'

const VENUE_ID = 'venue-1'

describe('lost-deals tool source', () => {
  it('is registered against battery Q40', () => {
    expect(lostDealsToolSource.batteryQuestions).toContain('40')
    expect(lostDealsToolSource.tool.name).toBe('get_lost_deal_reasons')
  })

  it('only queries lost_deals filtered to lost_at_stage=tour', async () => {
    let sawStageFilter = false
    const supabase = makeFakeSupabase((table, calls) => {
      if (table === 'lost_deals') {
        sawStageFilter = calls.some(
          (c) => c.method === 'eq' && c.args[0] === 'lost_at_stage' && c.args[1] === 'tour',
        )
        return { data: [] }
      }
      return { data: [] }
    })
    await lostDealsToolSource.run(VENUE_ID, {}, { supabase, today: '2026-09-09' })
    expect(sawStageFilter).toBe(true)
  })

  it('refuses with insufficient data below the minimum deal count', async () => {
    const supabase = makeFakeSupabase((table) => {
      if (table === 'lost_deals') {
        return { data: [{ reason_category: 'pricing', reason_detail: 'too expensive' }] }
      }
      return { data: [] }
    })
    const result = (await lostDealsToolSource.run(VENUE_ID, {}, {
      supabase,
      today: '2026-09-09',
    })) as { n: number; enoughData: boolean; reason?: string }
    expect(result.enoughData).toBe(false)
    expect(result.n).toBe(1)
    expect(result.reason).toMatch(/fewer than 5/)
  })

  it('builds a reason distribution and top-3 with anonymised examples, no couple identity', async () => {
    const rows = [
      { reason_category: 'competitor', reason_detail: 'Sarah Jones said they went with a barn venue instead' },
      { reason_category: 'competitor', reason_detail: 'chose a cheaper option nearby' },
      { reason_category: 'competitor', reason_detail: null },
      { reason_category: 'pricing', reason_detail: 'budget did not stretch that far' },
      { reason_category: 'date_unavailable', reason_detail: 'their date was already booked' },
      { reason_category: 'ghosted', reason_detail: null },
    ]
    const supabase = makeFakeSupabase((table) => {
      if (table === 'lost_deals') return { data: rows }
      return { data: [] }
    })
    const result = (await lostDealsToolSource.run(VENUE_ID, {}, {
      supabase,
      today: '2026-09-09',
    })) as {
      n: number
      enoughData: boolean
      distribution: Array<{ reason: string; n: number; pct: number }>
      topReasons: Array<{ reason: string; n: number; example: string | null }>
    }

    expect(result.enoughData).toBe(true)
    expect(result.n).toBe(6)
    expect(result.distribution[0].n).toBe(3) // competitor is the top reason
    expect(result.topReasons.length).toBeLessThanOrEqual(3)

    const serialised = JSON.stringify(result)
    expect(serialised).not.toMatch(/Sarah Jones/)
    expect(serialised).not.toMatch(/wedding_id/i)
    expect(serialised).not.toMatch(/couple_id/i)
  })

  it('honours a custom lookback_days argument', async () => {
    let sawGte: unknown
    const supabase = makeFakeSupabase((table, calls) => {
      if (table === 'lost_deals') {
        sawGte = calls.find((c) => c.method === 'gte')?.args[1]
        return { data: [] }
      }
      return { data: [] }
    })
    await lostDealsToolSource.run(VENUE_ID, { lookback_days: 30 }, { supabase, today: '2026-09-09' })
    expect(typeof sawGte).toBe('string')
    expect(sawGte as string).toMatch(/2026-08-1[01]/) // 30 days before 2026-09-09
  })
})
