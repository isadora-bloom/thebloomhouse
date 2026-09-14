/**
 * Platform-shift tool source tests (NOVEMBER-PLAN.md wave 7, W48).
 *
 * Covers: two platforms / three months with a real share shift computed,
 * a platform with zero rows reported as absent (never a fake zero), and
 * venue isolation through the fake Supabase client — rows seeded under a
 * different venue must never enter the computation.
 */
import { describe, it, expect } from 'vitest'
import { makeFakeSupabase, type FakeRow } from './fake-supabase-memory'
import {
  computePlatformShift,
  platformShiftSource,
  fetchMarketingMetricRows,
  type RawMarketingMetricRow,
  type PlatformShiftResult,
} from '../platform-shift'

const TODAY = '2026-09-01' // months covered for a 3-month window: 07, 08, 09
const VENUE = 'venue-a'

function row(source: string, metric: string, label: string, value: number): RawMarketingMetricRow {
  return { source, metric, label, value }
}

/** A marketing_metric engagement_events row, as the real table stores it. */
function eventRow(over: Partial<FakeRow> & { venue_id: string; metadata: Record<string, unknown> }): FakeRow {
  return {
    id: `ev-${Math.random()}`,
    event_type: 'marketing_metric',
    direction: 'inbound',
    ...over,
  }
}

describe('computePlatformShift — pure computation', () => {
  it('two platforms, three months: share shift is computed correctly', () => {
    const rows: RawMarketingMetricRow[] = [
      row('instagram', 'likes', '2026-07', 800),
      row('instagram', 'likes', '2026-08', 650),
      row('instagram', 'likes', '2026-09', 500),
      row('tiktok', 'likes', '2026-07', 200),
      row('tiktok', 'likes', '2026-08', 450),
      row('tiktok', 'likes', '2026-09', 900),
    ]
    const result = computePlatformShift(rows, TODAY, 3)

    expect(result.enoughData).toBe(true)
    expect(result.n).toBe(6)
    expect(result.monthsCovered).toEqual(['2026-07', '2026-08', '2026-09'])

    const ig = result.platforms.find((p) => p.platform === 'instagram')!
    const tt = result.platforms.find((p) => p.platform === 'tiktok')!
    expect(ig.hasData).toBe(true)
    expect(tt.hasData).toBe(true)

    // July: 800 vs 200 of 1000 total.
    expect(ig.months[0]!.volume).toBe(800)
    expect(ig.months[0]!.share).toBeCloseTo(0.8, 5)
    expect(tt.months[0]!.share).toBeCloseTo(0.2, 5)
    // First month in the window has no prior month to diff against.
    expect(ig.months[0]!.shareChangeFromPriorMonth).toBeNull()

    // September: 500 vs 900 of 1400 total — the shift has fully crossed over.
    expect(ig.months[2]!.share).toBeCloseTo(500 / 1400, 5)
    expect(tt.months[2]!.share).toBeCloseTo(900 / 1400, 5)

    // Instagram's share fell every month; TikTok's rose every month.
    expect(ig.months[2]!.share!).toBeLessThan(ig.months[0]!.share!)
    expect(tt.months[2]!.share!).toBeGreaterThan(tt.months[0]!.share!)

    // Month-over-month share change is signed and opposite between the two
    // platforms (one gains exactly what the other loses, aside from other
    // platforms that carry zero volume here).
    const igChange = ig.months[2]!.shareChangeFromPriorMonth!
    const ttChange = tt.months[2]!.shareChangeFromPriorMonth!
    expect(igChange).toBeLessThan(0)
    expect(ttChange).toBeGreaterThan(0)
    expect(igChange + ttChange).toBeCloseTo(0, 5)
  })

  it('a platform with no rows is reported as absent, never as a fake zero', () => {
    const rows: RawMarketingMetricRow[] = [
      row('instagram', 'likes', '2026-07', 100),
      row('tiktok', 'likes', '2026-07', 50),
    ]
    const result = computePlatformShift(rows, TODAY, 3)

    const pinterest = result.platforms.find((p) => p.platform === 'pinterest')!
    const facebook = result.platforms.find((p) => p.platform === 'facebook')!
    const google = result.platforms.find((p) => p.platform === 'google')!

    for (const p of [pinterest, facebook, google]) {
      expect(p.hasData).toBe(false)
      for (const m of p.months) {
        expect(m.volume).toBeNull() // never 0
        expect(m.share).toBeNull()
        expect(m.shareChangeFromPriorMonth).toBeNull()
      }
    }
    expect(result.absentPlatforms).toEqual(
      expect.arrayContaining(['Pinterest', 'Facebook/Meta', 'Google']),
    )
    expect(result.absentPlatforms).not.toContain('Instagram')
    expect(result.absentPlatforms).not.toContain('TikTok')
  })

  it('reports honestly when nothing at all has landed', () => {
    const result = computePlatformShift([], TODAY, 3)
    expect(result.enoughData).toBe(false)
    expect(result.n).toBe(0)
    expect(result.reason).toBeTruthy()
    expect(result.platforms.every((p) => !p.hasData)).toBe(true)
    expect(result.absentPlatforms).toHaveLength(5)
  })

  it('excludes spend from the engagement volume sum', () => {
    const rows: RawMarketingMetricRow[] = [
      row('instagram', 'likes', '2026-07', 100),
      row('instagram', 'spend', '2026-07', 5000),
    ]
    const result = computePlatformShift(rows, TODAY, 3)
    const ig = result.platforms.find((p) => p.platform === 'instagram')!
    expect(ig.months[0]!.volume).toBe(100)
    expect(ig.metricsIncluded).toEqual(['likes'])
  })

  it('rolls google / google_analytics / google_business / google_ads into one platform', () => {
    const rows: RawMarketingMetricRow[] = [
      row('google', 'sessions', '2026-07', 10),
      row('google_analytics', 'sessions', '2026-07', 20),
      row('google_business', 'leads', '2026-07', 5),
    ]
    const result = computePlatformShift(rows, TODAY, 3)
    const google = result.platforms.find((p) => p.platform === 'google')!
    expect(google.months[0]!.volume).toBe(35)
    expect(google.metricsIncluded.sort()).toEqual(['leads', 'sessions'])
  })
})

describe('platformShiftSource — claims Q42, no venue in its schema', () => {
  it('exposes only months and claims Q42', () => {
    expect(platformShiftSource.tool.name).toBe('get_platform_engagement_shift')
    const props = platformShiftSource.tool.input_schema.properties as Record<string, unknown>
    expect(Object.keys(props)).toEqual(['months'])
    expect(platformShiftSource.batteryQuestions).toEqual(['42'])
    expect(JSON.stringify(platformShiftSource.tool.input_schema)).not.toContain('venue')
  })
})

describe('platformShiftSource.run — venue isolation', () => {
  it('never counts rows seeded under a different venue', async () => {
    const supabase = makeFakeSupabase({
      engagement_events: [
        eventRow({
          venue_id: VENUE,
          metadata: { source: 'instagram', metric: 'likes', label: '2026-07', value: 100 },
        }),
        eventRow({
          venue_id: VENUE,
          metadata: { source: 'tiktok', metric: 'likes', label: '2026-07', value: 40 },
        }),
        // Different venue — must never leak into venue-a's computation.
        eventRow({
          venue_id: 'venue-b',
          metadata: { source: 'instagram', metric: 'likes', label: '2026-07', value: 99999 },
        }),
      ],
    })

    const resultA = (await platformShiftSource.run(VENUE, {}, { supabase, today: TODAY })) as PlatformShiftResult
    expect(resultA.n).toBe(2)
    const ig = resultA.platforms.find((p) => p.platform === 'instagram')!
    expect(ig.months.find((m) => m.month === '2026-07')!.volume).toBe(100)

    const rowsB = await fetchMarketingMetricRows(supabase, 'venue-b')
    expect(rowsB).toHaveLength(1)
    expect(rowsB[0]!.value).toBe(99999)

    // Nothing seeded for a third venue — an empty scope must read as
    // honestly empty, not throw.
    const resultC = (await platformShiftSource.run('venue-c', {}, { supabase, today: TODAY })) as PlatformShiftResult
    expect(resultC.n).toBe(0)
    expect(resultC.enoughData).toBe(false)
  })

  it('ignores rows with the wrong event_type or outbound direction', async () => {
    const supabase = makeFakeSupabase({
      engagement_events: [
        eventRow({
          venue_id: VENUE,
          direction: 'outbound', // not a couple-side observation — excluded
          metadata: { source: 'instagram', metric: 'likes', label: '2026-07', value: 500 },
        }),
        eventRow({
          venue_id: VENUE,
          event_type: 'tour_requested', // wrong event type
          metadata: { source: 'instagram', metric: 'likes', label: '2026-07', value: 500 },
        }),
      ],
    })
    const rows = await fetchMarketingMetricRows(supabase, VENUE)
    expect(rows).toHaveLength(0)
  })
})
