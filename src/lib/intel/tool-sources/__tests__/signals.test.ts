/**
 * Conversion-signals tool source (battery Q25, Q28).
 *
 * The failure this guards against is a lift of 5.0 printed over three couples.
 * So the tests check the denominators travel with the ratio, that a thin
 * cohort comes back with enoughData false and a reason, and that the content
 * keyword matcher catches a reel without catching every mention of a board.
 */

import { describe, it, expect } from 'vitest'
import type { TouchpointRow } from '@/lib/services/cohort/types'
import { makeFakeSupabase, type FakeRow } from './fake-supabase'
import { runConversionSignals, findContentMentions, signalsSource } from '../signals'

const VENUE = 'venue-1'
const TODAY = '2026-09-09'

interface RateBlock {
  couples: number
  n: number
  booked: number
  ghosted: number
  enoughData: boolean
  reason?: string
  bookedPercent: number | null
}
interface SignalsResult {
  coverage: { couplesInCohort: number; touchpointsScanned: number }
  preTourSignals: {
    cohort: { n: number; bookers: number; ghosted: number }
    n: number
    enoughData: boolean
    reason?: string
    signals: Array<{
      signal: string
      bookersWithSignal: number
      bookersTotal: number
      ghostsWithSignal: number
      ghostsTotal: number
      lift: number | null
    }>
  }
  contentMentions: {
    definition: string
    mentioners: RateBlock
    nonMentioners: RateBlock
    perFamily: Array<{ family: string; couplesMentioning: number; bookedPercent: number | null; enoughData: boolean }>
    examples: { n: number; of: number; couples: Array<{ coupleId: string; names: string | null; outcome: string; mentions: Array<{ family: string; quote: string }> }> }
  }
  caveat: string
}

const TOUR_AT = '2026-01-20T15:00:00.000Z'
const REEL_BODY = 'We saw your Instagram reel of the barn at sunset and had to write.'

function tpRow(over: Partial<TouchpointRow> & { venue_id?: string }): FakeRow {
  return {
    id: 'tp',
    venue_id: VENUE,
    couple_id: 'c',
    channel: 'gmail',
    action_type: 'reply',
    occurred_at: '2026-01-10T09:00:00.000Z',
    signal_tier: 'high',
    confidence_tier: 'high',
    raw_payload: null,
    ...over,
  }
}

/**
 * Twenty couples that reached a booked tour: ten signed, ten went quiet.
 * Every booker sent three messages before the tour; only two of the ghosts
 * did. Seven bookers and three ghosts mentioned a reel.
 */
function cohortTables() {
  const couples: FakeRow[] = []
  const touchpoints: FakeRow[] = []

  const make = (id: string, state: string, extraInbound: number, mentionsReel: boolean) => {
    couples.push({
      id,
      venue_id: VENUE,
      lifecycle_state: state,
      channel_scope: null,
      wedding_date: '2026-10-01',
      heat_score: 20,
      created_at: '2026-01-09T00:00:00.000Z',
      last_progression_at: '2026-01-20T00:00:00.000Z',
      primary_contact_name: `Couple ${id}`,
    })
    touchpoints.push(
      tpRow({
        id: `${id}-in0`,
        couple_id: id,
        occurred_at: '2026-01-10T09:00:00.000Z',
        raw_payload: mentionsReel ? { body: REEL_BODY } : { body: 'Are you free in October?' },
      }),
    )
    for (let i = 0; i < extraInbound; i++) {
      touchpoints.push(
        tpRow({
          id: `${id}-in${i + 1}`,
          couple_id: id,
          occurred_at: `2026-01-1${2 + i}T09:00:00.000Z`,
          raw_payload: { body: 'One more question about the barn.' },
        }),
      )
    }
    touchpoints.push(
      tpRow({ id: `${id}-tour`, couple_id: id, action_type: 'tour_booked', channel: 'calendly', occurred_at: TOUR_AT }),
    )
  }

  for (let i = 0; i < 10; i++) make(`b${i}`, 'booked', 2, i < 7)
  for (let i = 0; i < 10; i++) make(`g${i}`, 'ghost', i < 2 ? 2 : 0, i < 3)

  // Never in the cohort: an un-acknowledged prospect and another venue.
  couples.push({
    id: 'scoped',
    venue_id: VENUE,
    lifecycle_state: 'channel_scoped',
    channel_scope: 'the_knot',
    wedding_date: null,
    heat_score: 0,
    created_at: '2026-01-09T00:00:00.000Z',
    last_progression_at: '2026-01-09T00:00:00.000Z',
    primary_contact_name: 'Anonymous Saver',
  })
  couples.push({
    id: 'elsewhere',
    venue_id: 'venue-2',
    lifecycle_state: 'booked',
    channel_scope: null,
    wedding_date: null,
    heat_score: 0,
    created_at: '2026-01-09T00:00:00.000Z',
    last_progression_at: '2026-01-09T00:00:00.000Z',
    primary_contact_name: 'Other Venue Couple',
  })

  return {
    venues: [{ id: VENUE, timezone: 'America/New_York' }],
    couples,
    touchpoints,
    couple_progression_events: [] as FakeRow[],
  }
}

describe('conversion-signals tool source', () => {
  it('exposes only since and claims Q25 and Q28', () => {
    expect(signalsSource.tool.name).toBe('get_conversion_signals')
    const props = signalsSource.tool.input_schema.properties as Record<string, unknown>
    expect(Object.keys(props)).toEqual(['since'])
    expect(signalsSource.batteryQuestions).toEqual(['25', '28'])
    expect(JSON.stringify(signalsSource.tool.input_schema)).not.toContain('venue')
  })

  it('reports pre-tour signals with both cohort sizes, not a bare lift', async () => {
    const supabase = makeFakeSupabase(cohortTables())
    const out = (await runConversionSignals(VENUE, {}, { supabase, today: TODAY })) as SignalsResult

    expect(out.coverage.couplesInCohort).toBe(20)
    expect(out.preTourSignals.cohort.n).toBe(20)
    expect(out.preTourSignals.cohort.bookers).toBe(10)
    expect(out.preTourSignals.cohort.ghosted).toBe(10)
    expect(out.preTourSignals.enoughData).toBe(true)

    const three = out.preTourSignals.signals.find((s) => s.signal.startsWith('3+ inbound'))!
    expect(three.bookersWithSignal).toBe(10)
    expect(three.bookersTotal).toBe(10)
    expect(three.ghostsWithSignal).toBe(2)
    expect(three.ghostsTotal).toBe(10)
    expect(three.lift).toBe(5)

    // Every signal row carries its denominators, whatever the lift is.
    for (const s of out.preTourSignals.signals) {
      expect(s.bookersTotal).toBe(10)
      expect(s.ghostsTotal).toBe(10)
    }
  })

  it('compares content mentioners against the rest, with n on both sides', async () => {
    const supabase = makeFakeSupabase(cohortTables())
    const out = (await runConversionSignals(VENUE, {}, { supabase, today: TODAY })) as SignalsResult

    expect(out.contentMentions.mentioners.couples).toBe(10)
    expect(out.contentMentions.mentioners.n).toBe(10)
    expect(out.contentMentions.mentioners.enoughData).toBe(true)
    expect(out.contentMentions.mentioners.bookedPercent).toBe(70)

    expect(out.contentMentions.nonMentioners.n).toBe(10)
    expect(out.contentMentions.nonMentioners.bookedPercent).toBe(30)

    const insta = out.contentMentions.perFamily.find((f) => f.family === 'instagram')!
    expect(insta.couplesMentioning).toBe(10)
    expect(insta.bookedPercent).toBe(70)

    const blog = out.contentMentions.perFamily.find((f) => f.family === 'blog')!
    expect(blog.couplesMentioning).toBe(0)
    expect(blog.bookedPercent).toBeNull()
    expect(blog.enoughData).toBe(false)

    // Evidence, not just a rate.
    const first = out.contentMentions.examples.couples[0]
    expect(first.mentions[0].family).toBe('instagram')
    expect(first.mentions[0].quote).toMatch(/reel/i)
    expect(first.names).toMatch(/Couple /)

    expect(out.caveat).toMatch(/do not say a signal caused a booking/i)
  })

  it('refuses to call anything a pattern when the cohort is tiny', async () => {
    const base = cohortTables()
    const keep = new Set(['b0', 'b1', 'g0'])
    const supabase = makeFakeSupabase({
      ...base,
      couples: base.couples.filter((c) => keep.has(c.id as string)),
      touchpoints: base.touchpoints.filter((t) => keep.has(t.couple_id as string)),
    })
    const out = (await runConversionSignals(VENUE, {}, { supabase, today: TODAY })) as SignalsResult

    expect(out.preTourSignals.cohort.bookers).toBe(2)
    expect(out.preTourSignals.enoughData).toBe(false)
    expect(out.preTourSignals.reason).toMatch(/minimum/i)
    // The raw counts are still there to report.
    expect(out.preTourSignals.signals[0].bookersTotal).toBe(2)
    expect(out.contentMentions.mentioners.enoughData).toBe(false)
    expect(out.contentMentions.mentioners.bookedPercent).toBeNull()
  })

  describe('findContentMentions', () => {
    const tp = (body: string, over: Partial<TouchpointRow> = {}): TouchpointRow => ({
      id: 'x',
      couple_id: 'c',
      channel: 'gmail',
      action_type: 'reply',
      occurred_at: '2026-01-10T09:00:00.000Z',
      signal_tier: 'high',
      confidence_tier: 'high',
      raw_payload: { body },
      ...over,
    })

    it('finds a reel, a pin and a blog post, one entry per family', () => {
      const found = findContentMentions([
        tp('Loved the Instagram reel'),
        tp('And the reel again', { id: 'y' }),
        tp('Found you on Pinterest', { id: 'z' }),
        tp('Read your blog post about winter weddings', { id: 'w' }),
      ])
      const families = found.map((f) => f.family).sort()
      expect(families).toEqual(['blog', 'instagram', 'pinterest'])
      expect(found.find((f) => f.family === 'instagram')!.quote).toMatch(/reel/i)
    })

    it('ignores what the venue itself wrote', () => {
      expect(
        findContentMentions([tp('Have you seen our Instagram reel?', { action_type: 'venue_sent' })]),
      ).toEqual([])
      expect(
        findContentMentions([tp('Have you seen our Instagram reel?', { raw_payload: { body: 'reel', direction: 'outbound' } })]),
      ).toEqual([])
    })

    it('does not treat ordinary wedding talk as a content mention', () => {
      expect(findContentMentions([tp('We want a long head table and a mood board')])).toEqual([])
      expect(findContentMentions([tp('Our story starts in 2019')])).toEqual([])
    })
  })
})
