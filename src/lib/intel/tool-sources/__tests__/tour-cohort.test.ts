/**
 * W32 tool source: explicit-window tour cohort. NOVEMBER-PLAN.md wave 4,
 * battery Q37 link 1.
 *
 * Fake Supabase, table-keyed, same shared fake weather-tours.ts /
 * capacity.ts use. Nothing here touches a database.
 */
import { describe, it, expect } from 'vitest'
import { tourCohortSource, TOOL_GET_TOUR_COHORT, TOUR_COHORT_CAP } from '../tour-cohort'
import { makeFakeSupabase } from './fake-supabase'

const VENUE_ID = 'venue-1'
const TZ = 'America/New_York'

interface TourResult {
  periodFrom: string
  periodTo: string
  defaultedToLastSevenDays: boolean
  outcome: string
  timezone: string
  n: number
  returned: number
  cap: number
  capped: boolean
  capNote?: string
  note?: string
  tours: Array<{
    coupleId: string
    names: string | null
    outcome: string
    tourAt: string
    tourAtVenueLocal: string | null
  }>
}

/** Saturday of the test weekend, 1:15pm America/New_York (EDT, UTC-4). */
const COUPLE_A_TOUR_ISO = '2026-09-12T17:15:00.000Z'
/** Sunday of the test weekend, 11am America/New_York. Booked, then
 *  cancelled the following Monday — occurred_at on the cancellation
 *  touchpoint is the cancellation moment, not the tour time. */
const COUPLE_B_TOUR_ISO = '2026-09-13T15:00:00.000Z'
const COUPLE_B_CANCEL_ISO = '2026-09-14T09:00:00.000Z'
/** Sunday of the test weekend, 3pm America/New_York. Booked, no outcome
 *  recorded yet. */
const COUPLE_C_TOUR_ISO = '2026-09-13T19:00:00.000Z'
/** The following Saturday — outside the test weekend, inside a later
 *  "next week" window. */
const COUPLE_D_TOUR_ISO = '2026-09-20T18:00:00.000Z'

const WEEKEND_COUPLES = [
  { id: 'couple-a', primary_contact_name: 'Anya', partner_contact_name: 'Brian', lifecycle_state: 'resolved' },
  { id: 'couple-b', primary_contact_name: 'Caitlin', partner_contact_name: 'Caleb', lifecycle_state: 'resolved' },
  { id: 'couple-c', primary_contact_name: 'Tara', partner_contact_name: 'Brent', lifecycle_state: 'resolved' },
  { id: 'couple-d', primary_contact_name: 'Nora', partner_contact_name: 'Sam', lifecycle_state: 'resolved' },
]

const WEEKEND_TOUCHPOINTS = [
  // Couple A: booked and attended, same underlying tour time.
  { couple_id: 'couple-a', action_type: 'tour_booked', occurred_at: COUPLE_A_TOUR_ISO, raw_payload: null },
  { couple_id: 'couple-a', action_type: 'tour_attended', occurred_at: COUPLE_A_TOUR_ISO, raw_payload: null },
  // Couple B: booked, then cancelled two days later. Tour time only
  // recoverable from the cancellation's raw_payload.scheduled_start.
  { couple_id: 'couple-b', action_type: 'tour_booked', occurred_at: COUPLE_B_TOUR_ISO, raw_payload: null },
  {
    couple_id: 'couple-b',
    action_type: 'tour_cancelled',
    occurred_at: COUPLE_B_CANCEL_ISO,
    raw_payload: { scheduled_start: COUPLE_B_TOUR_ISO },
  },
  // Couple C: booked, nothing else yet.
  { couple_id: 'couple-c', action_type: 'tour_booked', occurred_at: COUPLE_C_TOUR_ISO, raw_payload: null },
  // Couple D: attended, but the following weekend — must not leak into
  // a query for the earlier one.
  { couple_id: 'couple-d', action_type: 'tour_attended', occurred_at: COUPLE_D_TOUR_ISO, raw_payload: null },
]

function fakeClient(touchpoints: unknown[], couples: unknown[]) {
  return makeFakeSupabase((table) => {
    if (table === 'venue_config') return { data: { timezone: TZ } }
    if (table === 'touchpoints') return { data: touchpoints }
    if (table === 'couples') return { data: couples }
    return { data: [] }
  })
}

describe('tour-cohort tool source', () => {
  it('is registered against battery Q37 and takes no venue id in its schema', () => {
    expect(tourCohortSource.batteryQuestions).toContain('37')
    expect(tourCohortSource.tool.name).toBe(TOOL_GET_TOUR_COHORT)
    const props = tourCohortSource.tool.input_schema.properties as Record<string, unknown>
    expect(props).not.toHaveProperty('venue_id')
    expect(Object.keys(props ?? {}).sort()).toEqual(['outcome', 'period_from', 'period_to'])
    expect(tourCohortSource.tool.input_schema.additionalProperties).toBe(false)
  })

  it('resolves a past window (the weekend just gone), one row per physical tour', async () => {
    const supabase = fakeClient(WEEKEND_TOUCHPOINTS, WEEKEND_COUPLES)
    const result = (await tourCohortSource.run(
      VENUE_ID,
      { period_from: '2026-09-12', period_to: '2026-09-13' },
      { supabase, today: '2026-09-14' },
    )) as TourResult

    expect(result.periodFrom).toBe('2026-09-12')
    expect(result.periodTo).toBe('2026-09-13')
    expect(result.defaultedToLastSevenDays).toBe(false)
    expect(result.n).toBe(3)
    expect(result.tours.map((t) => t.coupleId)).toEqual(['couple-a', 'couple-b', 'couple-c'])
    expect(result.tours.map((t) => t.names)).toEqual(['Anya & Brian', 'Caitlin & Caleb', 'Tara & Brent'])
    // Booked + attended touchpoints on the same tour time collapse to one
    // row with the terminal outcome, not two rows.
    expect(result.tours[0].outcome).toBe('attended')
    // Cancelled wins over the booking that preceded it, and its tour time
    // came from raw_payload, not the cancellation timestamp.
    expect(result.tours[1].outcome).toBe('cancelled')
    expect(result.tours[1].tourAt).toBe(COUPLE_B_TOUR_ISO)
    // A booking with no outcome yet reads as scheduled, not dropped.
    expect(result.tours[2].outcome).toBe('scheduled')
    // The following weekend's tour must not leak into this window.
    expect(result.tours.some((t) => t.coupleId === 'couple-d')).toBe(false)
  })

  it('resolves a future window the same way it resolves a past one', async () => {
    const supabase = fakeClient(WEEKEND_TOUCHPOINTS, WEEKEND_COUPLES)
    const result = (await tourCohortSource.run(
      VENUE_ID,
      { period_from: '2026-09-19', period_to: '2026-09-20' },
      { supabase, today: '2026-09-14' },
    )) as TourResult

    expect(result.n).toBe(1)
    expect(result.tours[0].coupleId).toBe('couple-d')
    expect(result.tours[0].outcome).toBe('attended')
    expect(result.defaultedToLastSevenDays).toBe(false)
  })

  it('says plainly there is nobody to name when the window holds no tours', async () => {
    const supabase = fakeClient(WEEKEND_TOUCHPOINTS, WEEKEND_COUPLES)
    const result = (await tourCohortSource.run(
      VENUE_ID,
      { period_from: '2026-01-01', period_to: '2026-01-07' },
      { supabase, today: '2026-09-14' },
    )) as TourResult

    expect(result.n).toBe(0)
    expect(result.tours).toEqual([])
    expect(result.note).toBe('No tours matched this window. There is nobody to name.')
  })

  it('defaults to the last 7 days when no window is given, matching the ground-truth probe call shape', async () => {
    const supabase = fakeClient(WEEKEND_TOUCHPOINTS, WEEKEND_COUPLES)
    // Ground-truth calls every source with `{}` (scripts/battery-ground-truth.ts).
    const result = (await tourCohortSource.run(VENUE_ID, {}, {
      supabase,
      today: '2026-09-14',
    })) as TourResult

    expect(result.defaultedToLastSevenDays).toBe(true)
    expect(result.periodFrom).toBe('2026-09-08')
    expect(result.periodTo).toBe('2026-09-14')
  })

  it('caps the list at 50 and says so, without losing the true count', async () => {
    const manyCouples = Array.from({ length: 52 }, (_, i) => ({
      id: `couple-cap-${i}`,
      primary_contact_name: `First${i}`,
      partner_contact_name: `Second${i}`,
      lifecycle_state: 'resolved',
    }))
    const manyTouchpoints = manyCouples.map((c, i) => ({
      couple_id: c.id,
      action_type: 'tour_attended',
      occurred_at: `2026-09-12T${String(10 + Math.floor(i / 30)).padStart(2, '0')}:${String(i % 30).padStart(2, '0')}:00.000Z`,
      raw_payload: null,
    }))
    const supabase = fakeClient(manyTouchpoints, manyCouples)
    const result = (await tourCohortSource.run(
      VENUE_ID,
      { period_from: '2026-09-12', period_to: '2026-09-12' },
      { supabase, today: '2026-09-14' },
    )) as TourResult

    expect(result.n).toBe(52)
    expect(result.returned).toBe(TOUR_COHORT_CAP)
    expect(result.tours.length).toBe(TOUR_COHORT_CAP)
    expect(result.capped).toBe(true)
    expect(result.capNote).toContain('52')
    expect(result.capNote).toContain(String(TOUR_COHORT_CAP))
  })

  it('renders the tour time in the venue local timezone, not UTC or the server clock', async () => {
    const supabase = fakeClient(WEEKEND_TOUCHPOINTS, WEEKEND_COUPLES)
    const result = (await tourCohortSource.run(
      VENUE_ID,
      { period_from: '2026-09-12', period_to: '2026-09-13' },
      { supabase, today: '2026-09-14' },
    )) as TourResult

    expect(result.timezone).toBe(TZ)
    const tourA = result.tours.find((t) => t.coupleId === 'couple-a')
    expect(tourA).toBeTruthy()

    const expectedVenueLocal = new Intl.DateTimeFormat('en-US', {
      weekday: 'short',
      month: 'short',
      day: 'numeric',
      hour: 'numeric',
      minute: '2-digit',
      hour12: true,
      timeZone: TZ,
    }).format(new Date(COUPLE_A_TOUR_ISO))
    const utcRendering = new Intl.DateTimeFormat('en-US', {
      weekday: 'short',
      month: 'short',
      day: 'numeric',
      hour: 'numeric',
      minute: '2-digit',
      hour12: true,
      timeZone: 'UTC',
    }).format(new Date(COUPLE_A_TOUR_ISO))

    expect(tourA?.tourAtVenueLocal).toBe(expectedVenueLocal)
    // 17:15 UTC is a different clock hour in America/New_York (EDT, UTC-4)
    // — this is the assertion that would fail if the timezone were ignored.
    expect(tourA?.tourAtVenueLocal).not.toBe(utcRendering)
  })
})
