/**
 * Correlation engine — the tours channel (NOVEMBER-PLAN.md wave 7, W47).
 *
 * Four things are pinned here, all against a fake Supabase client, no
 * database:
 *
 *   1. loadTourDayCounts groups a booking and its outcome into one tour,
 *      counts three tours across two days as 2 and 1, and leaves a
 *      cancelled tour out of the held count while keeping it in `seen`.
 *   2. buildSeries emits a `tours` channel from those rows, and emits no
 *      channel at all when the venue held no tours (an all-zero series
 *      would widen the Bonferroni family for nothing).
 *   3. computeCorrelationsForVenue pairs an External Context channel
 *      against tours and persists the row, which is the whole point of
 *      the workstream: before this, macro channels could only ever pair
 *      against inquiries.
 *   4. The label and the signal class a coordinator sees for it.
 *
 * The pair test needs a denser fixture than three tours. MIN_NONZERO_DAYS
 * is twelve, and it was deliberately not relaxed for tours, so a fixture
 * of two tour days correctly produces no pair at all. Twenty tour days is
 * the smallest fixture that can clear the bar honestly.
 */
import { describe, it, expect } from 'vitest'
import type { SupabaseClient } from '@supabase/supabase-js'
import {
  loadTourDayCounts,
  buildSeries,
  computeCorrelationsForVenue,
} from '../correlation-engine'
import { formatSeriesLabel, classifySeries, classifyPair } from '@/lib/utils/format-series-label'

const VENUE_A = '33333333-3333-3333-3333-333333333301'
const COUPLE_1 = '44444444-4444-4444-4444-444444444401'
const COUPLE_2 = '44444444-4444-4444-4444-444444444402'
const COUPLE_3 = '44444444-4444-4444-4444-444444444403'

type Row = Record<string, unknown>

/**
 * Minimal chainable fake. Honours `.eq` and `.in` (the venue scope and the
 * action-type filter both matter to what we are proving) and ignores the
 * range filters, which is safe because every fixture row is inside the
 * window by construction. Not a general Supabase mock.
 */
function fakeSupabase(
  tables: Record<string, Row[]>,
  sink: { inserted: Row[]; updated: Row[] } = { inserted: [], updated: [] },
): SupabaseClient {
  return {
    from(table: string) {
      let rows = [...(tables[table] ?? [])]
      const settled = (value: unknown) => Promise.resolve(value)
      const builder: Record<string, unknown> = {
        select: () => builder,
        eq: (k: string, v: unknown) => {
          rows = rows.filter((r) => r[k] === v)
          return builder
        },
        in: (k: string, vs: unknown[]) => {
          rows = rows.filter((r) => vs.includes(r[k]))
          return builder
        },
        neq: (k: string, v: unknown) => {
          rows = rows.filter((r) => r[k] !== v)
          return builder
        },
        is: () => builder,
        not: () => builder,
        or: () => builder,
        gte: () => builder,
        lte: () => builder,
        order: () => builder,
        limit: () => builder,
        maybeSingle: () => settled({ data: rows[0] ?? null, error: null }),
        single: () => settled({ data: rows[0] ?? null, error: null }),
        insert: (row: Row) => {
          sink.inserted.push(row)
          return settled({ data: null, error: null })
        },
        update: (row: Row) => {
          sink.updated.push(row)
          return builder
        },
        then: (resolve: (v: { data: Row[]; error: null }) => unknown) =>
          Promise.resolve({ data: rows, error: null }).then(resolve),
      }
      return builder
    },
  } as unknown as SupabaseClient
}

/** UTC day key `offset` days before now. Same grid the engine uses. */
function dayAgo(offset: number): string {
  return new Date(Date.now() - offset * 86400e3).toISOString().slice(0, 10)
}

function tourTouchpoint(args: {
  coupleId: string
  actionType: string
  tourDay: string
  /** Defaults to venue A. Named explicitly by the isolation case. */
  venueId?: string
  /** Cancellations stamp occurred_at with the cancellation moment, so the
   *  tour time has to travel in raw_payload. */
  cancelledOn?: string
}): Row {
  const scheduled = `${args.tourDay}T15:00:00.000Z`
  const base = {
    venue_id: args.venueId ?? VENUE_A,
    couple_id: args.coupleId,
    raw_payload: { scheduled_start: scheduled },
  }
  if (args.actionType === 'tour_cancelled') {
    return {
      ...base,
      action_type: 'tour_cancelled',
      occurred_at: `${args.cancelledOn ?? args.tourDay}T09:00:00.000Z`,
    }
  }
  return { ...base, action_type: args.actionType, occurred_at: scheduled }
}

const EMPTY_TABLES: Record<string, Row[]> = {
  weddings: [],
  engagement_events: [],
  tangential_signals: [],
  touchpoints: [],
  fred_indicators: [],
  external_calendar_events: [],
  government_events: [],
  venue_cultural_moment_state: [],
  cultural_moments: [],
  venues: [{ id: VENUE_A, state: 'VA' }],
  intelligence_insights: [],
}

describe('loadTourDayCounts', () => {
  it('counts three tours across two days, one booking plus outcome each', async () => {
    const dayOne = dayAgo(10)
    const dayTwo = dayAgo(8)
    const supabase = fakeSupabase({
      ...EMPTY_TABLES,
      touchpoints: [
        // Two tours on day one, each with a booking and its attendance
        // sweep. Four rows, two tours.
        tourTouchpoint({ coupleId: COUPLE_1, actionType: 'tour_booked', tourDay: dayOne }),
        tourTouchpoint({ coupleId: COUPLE_1, actionType: 'tour_attended', tourDay: dayOne }),
        tourTouchpoint({ coupleId: COUPLE_2, actionType: 'tour_booked', tourDay: dayOne }),
        tourTouchpoint({ coupleId: COUPLE_2, actionType: 'tour_attended', tourDay: dayOne }),
        // One tour on day two, booked with no outcome recorded yet.
        tourTouchpoint({ coupleId: COUPLE_3, actionType: 'tour_booked', tourDay: dayTwo }),
      ],
    })

    const counts = await loadTourDayCounts(
      supabase,
      VENUE_A,
      new Date(Date.now() - 90 * 86400e3),
      new Date(),
    )

    expect(counts.held.get(dayOne)).toBe(2)
    expect(counts.held.get(dayTwo)).toBe(1)
    expect([...counts.held.values()].reduce((a, b) => a + b, 0)).toBe(3)
  })

  it('leaves a cancelled tour out of the held count but keeps it in seen', async () => {
    const day = dayAgo(12)
    const supabase = fakeSupabase({
      ...EMPTY_TABLES,
      touchpoints: [
        tourTouchpoint({ coupleId: COUPLE_1, actionType: 'tour_booked', tourDay: day }),
        tourTouchpoint({ coupleId: COUPLE_1, actionType: 'tour_attended', tourDay: day }),
        tourTouchpoint({ coupleId: COUPLE_2, actionType: 'tour_booked', tourDay: day }),
        tourTouchpoint({
          coupleId: COUPLE_2,
          actionType: 'tour_cancelled',
          tourDay: day,
          cancelledOn: dayAgo(14),
        }),
      ],
    })

    const counts = await loadTourDayCounts(
      supabase,
      VENUE_A,
      new Date(Date.now() - 90 * 86400e3),
      new Date(),
    )

    expect(counts.held.get(day)).toBe(1)
    expect(counts.seen.get(day)).toBe(2)
  })

  it('reads only the venue it was asked about', async () => {
    const day = dayAgo(9)
    const otherVenue = '33333333-3333-3333-3333-333333333302'
    const supabase = fakeSupabase({
      ...EMPTY_TABLES,
      touchpoints: [
        tourTouchpoint({ coupleId: COUPLE_1, actionType: 'tour_attended', tourDay: day }),
        tourTouchpoint({
          coupleId: COUPLE_2,
          actionType: 'tour_attended',
          tourDay: day,
          venueId: otherVenue,
        }),
      ],
    })

    const counts = await loadTourDayCounts(
      supabase,
      VENUE_A,
      new Date(Date.now() - 90 * 86400e3),
      new Date(),
    )

    expect(counts.held.get(day)).toBe(1)
  })
})

describe('buildSeries tours channel', () => {
  it('emits a tours channel from spine touchpoints', async () => {
    const dayOne = dayAgo(10)
    const dayTwo = dayAgo(8)
    const supabase = fakeSupabase({
      ...EMPTY_TABLES,
      touchpoints: [
        tourTouchpoint({ coupleId: COUPLE_1, actionType: 'tour_attended', tourDay: dayOne }),
        tourTouchpoint({ coupleId: COUPLE_2, actionType: 'tour_attended', tourDay: dayOne }),
        tourTouchpoint({ coupleId: COUPLE_3, actionType: 'tour_booked', tourDay: dayTwo }),
      ],
    })

    const series = await buildSeries(supabase, VENUE_A)
    const tours = series.find((s) => s.channel === 'tours')

    expect(tours).toBeDefined()
    expect(tours!.values.get(dayOne)).toBe(2)
    expect(tours!.values.get(dayTwo)).toBe(1)
  })

  it('emits no tours channel when the venue held none', async () => {
    const supabase = fakeSupabase(EMPTY_TABLES)
    const series = await buildSeries(supabase, VENUE_A)
    expect(series.find((s) => s.channel === 'tours')).toBeUndefined()
  })
})

describe('external context pairs against tours', () => {
  it('computes and persists a calendar to tours correlation', async () => {
    // Twenty tour days, each with a one-day calendar event on the same
    // day. The two series move together exactly, so the pair clears the
    // 0.6 floor without needing the threshold relaxed.
    const tourDays = Array.from({ length: 20 }, (_, i) => dayAgo(5 + i * 3))
    const sink = { inserted: [] as Row[], updated: [] as Row[] }
    const supabase = fakeSupabase(
      {
        ...EMPTY_TABLES,
        touchpoints: tourDays.map((day, i) =>
          tourTouchpoint({
            coupleId: [COUPLE_1, COUPLE_2, COUPLE_3][i % 3]!,
            actionType: 'tour_attended',
            tourDay: day,
          }),
        ),
        external_calendar_events: tourDays.map((day) => ({
          category: 'holiday',
          start_date: day,
          end_date: day,
          influence_weight: 1,
          geo_scope: 'us',
          deleted_at: null,
        })),
      },
      sink,
    )

    const insights = await computeCorrelationsForVenue({ supabase, venueId: VENUE_A })

    const pair = insights.find((i) => i.channelB === 'tours')
    expect(pair).toBeDefined()
    expect(pair!.channelA).toBe('calendar_holiday')
    expect(pair!.pairClass).toBe('macro_x_venue')
    expect(Math.abs(pair!.r)).toBeGreaterThanOrEqual(0.6)
    // The headline a coordinator reads should name the tours channel in
    // English, not print the raw channel id.
    expect(pair!.headline).toContain('Tours Held')

    // And it reaches intelligence_insights through the existing write
    // path, with the channel ids preserved for the row key.
    const written = sink.inserted.find(
      (r) => (r.data_points as Record<string, unknown> | undefined)?.channel_b === 'tours',
    )
    expect(written).toBeDefined()
    expect((written!.data_points as Record<string, unknown>).pair_key).toContain('tours')
    expect(written!.venue_id).toBe(VENUE_A)
  })

  it('produces no tour pair from a two-day fixture, because the significance bar holds', async () => {
    const dayOne = dayAgo(10)
    const dayTwo = dayAgo(8)
    const supabase = fakeSupabase({
      ...EMPTY_TABLES,
      touchpoints: [
        tourTouchpoint({ coupleId: COUPLE_1, actionType: 'tour_attended', tourDay: dayOne }),
        tourTouchpoint({ coupleId: COUPLE_2, actionType: 'tour_attended', tourDay: dayOne }),
        tourTouchpoint({ coupleId: COUPLE_3, actionType: 'tour_attended', tourDay: dayTwo }),
      ],
      external_calendar_events: [dayOne, dayTwo].map((day) => ({
        category: 'holiday',
        start_date: day,
        end_date: day,
        influence_weight: 1,
        geo_scope: 'us',
        deleted_at: null,
      })),
    })

    const insights = await computeCorrelationsForVenue({ supabase, venueId: VENUE_A })
    expect(insights.find((i) => i.channelB === 'tours')).toBeUndefined()
  })
})

describe('tours channel labelling', () => {
  it('reads as plain English and classifies as a venue outcome', () => {
    expect(formatSeriesLabel('tours')).toBe('Tours Held')
    expect(classifySeries('tours')).toBe('venue')
    expect(classifyPair('fred_MORTGAGE30US', 'tours')).toBe('macro_x_venue')
    expect(classifyPair('instagram_signals', 'tours')).toBe('venue_x_social')
    // government_signals comes from external-context/government.ts, not
    // tangential_signals, despite the suffix. A shutdown is exogenous, so
    // shutdown against tours has to read as macro against venue.
    expect(classifySeries('government_signals')).toBe('macro')
    expect(classifyPair('government_signals', 'tours')).toBe('macro_x_venue')
  })
})
