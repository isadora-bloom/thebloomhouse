/**
 * W12 tool sources — time series and operator patterns.
 *
 * Every test drives the sources through a hand-built Supabase stand-in and
 * pins the clock with `deps.today`, so nothing here touches the network and
 * nothing changes answer when the real date moves.
 *
 * What is being pinned, question by question:
 *   Q1  the median and its 12-month change, and that a thin month refuses
 *   Q7  a holiday week measured per day against a per-day baseline
 *   Q11 the lead-time verdict, shortening against lengthening
 *   Q12 that a percentage change off a tiny base is refused, not printed
 *   Q14 that "summer" means the season of the WEDDING DATE
 *   Q22 that hours come from venue_config, not from UTC
 *   Q23 that "replied once" means exactly one outbound message
 *   Q24 that loss reasons are grouped verbatim and never inferred
 */

import { describe, it, expect } from 'vitest'
import { timeSeriesSource } from '@/lib/intel/tool-sources/time-series'
import { operatorPatternsSource } from '@/lib/intel/tool-sources/operator-patterns'
import type { ToolSourceDeps } from '@/lib/intel/tool-sources/types'
import type { SupabaseClient } from '@supabase/supabase-js'

const VENUE = 'venue-1'
const TODAY = '2026-09-09'

// ---------------------------------------------------------------------------
// Supabase stand-in
// ---------------------------------------------------------------------------

type Row = Record<string, unknown>
type Db = Record<string, Row[]>

interface Filter {
  op: 'eq' | 'gte' | 'lte' | 'in' | 'notNull' | 'isNull'
  column: string
  value?: unknown
}

function matches(row: Row, f: Filter): boolean {
  const v = row[f.column]
  switch (f.op) {
    case 'eq':
      return v === f.value
    case 'gte':
      return String(v) >= String(f.value)
    case 'lte':
      return String(v) <= String(f.value)
    case 'in':
      return Array.isArray(f.value) && f.value.includes(v)
    case 'notNull':
      return v !== null && v !== undefined
    case 'isNull':
      return v === null || v === undefined
  }
}

/**
 * A chainable query builder covering exactly the PostgREST surface the two
 * sources and the cohort loader they reuse actually call: select, eq, gte,
 * lte, in, not(col,'is',null), is, order, limit, range, maybeSingle, and
 * awaiting the chain directly.
 */
function makeClient(db: Db): SupabaseClient {
  function builder(table: string) {
    const filters: Filter[] = []
    let sort: { column: string; ascending: boolean } | null = null
    let cap = Infinity

    function rows(): Row[] {
      let out = (db[table] ?? []).filter((r) => filters.every((f) => matches(r, f)))
      if (sort) {
        const { column, ascending } = sort
        out = [...out].sort((a, b) => {
          const av = String(a[column] ?? '')
          const bv = String(b[column] ?? '')
          return ascending ? av.localeCompare(bv) : bv.localeCompare(av)
        })
      }
      return out.slice(0, cap === Infinity ? undefined : cap)
    }

    function page(from: number, to: number) {
      return { data: rows().slice(from, to + 1), error: null }
    }

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const api: any = {
      select: () => api,
      eq: (column: string, value: unknown) => {
        filters.push({ op: 'eq', column, value })
        return api
      },
      gte: (column: string, value: unknown) => {
        filters.push({ op: 'gte', column, value })
        return api
      },
      lte: (column: string, value: unknown) => {
        filters.push({ op: 'lte', column, value })
        return api
      },
      in: (column: string, value: unknown[]) => {
        filters.push({ op: 'in', column, value })
        return api
      },
      is: (column: string, value: unknown) => {
        filters.push({ op: value === null ? 'isNull' : 'eq', column, value })
        return api
      },
      not: (column: string, op: string, value: unknown) => {
        if (op === 'is' && value === null) filters.push({ op: 'notNull', column })
        return api
      },
      order: (column: string, opts?: { ascending?: boolean }) => {
        sort = { column, ascending: opts?.ascending !== false }
        return api
      },
      limit: (n: number) => {
        cap = n
        return api
      },
      range: (from: number, to: number) => Promise.resolve(page(from, to)),
      maybeSingle: () => Promise.resolve({ data: rows()[0] ?? null, error: null }),
      single: () => Promise.resolve({ data: rows()[0] ?? null, error: null }),
      then: (onOk: (v: unknown) => unknown, onErr?: (e: unknown) => unknown) =>
        Promise.resolve({ data: rows(), error: null }).then(onOk, onErr),
    }
    return api
  }

  return { from: (table: string) => builder(table) } as unknown as SupabaseClient
}

function deps(db: Db, today = TODAY): ToolSourceDeps {
  return { supabase: makeClient(db), today }
}

// ---------------------------------------------------------------------------
// Fixture builder
// ---------------------------------------------------------------------------

interface Spec {
  id: string
  name?: string
  partner?: string | null
  lifecycle?: 'resolved' | 'booked' | 'ghost' | 'completed' | 'channel_scoped'
  weddingDate?: string | null
  /** The first inbound message the venue could answer, ISO. */
  inbound?: string
  /** Hours after `inbound` that the first venue reply went out. */
  replyAfterHours?: number | null
  /** Further outbound messages, each a day after the last. */
  extraReplies?: number
  toured?: boolean
  weddingRowId?: string | null
  mergedInto?: string | null
}

interface Fixture {
  db: Db
  specs: Spec[]
}

function build(specs: Spec[], timezone = 'UTC', extra: Db = {}): Fixture {
  const couples: Row[] = []
  const touchpoints: Row[] = []
  let tp = 0

  const push = (
    coupleId: string,
    channel: string,
    action: string,
    occurredAt: string,
    outbound = false,
  ) => {
    tp++
    touchpoints.push({
      id: `tp-${tp}`,
      venue_id: VENUE,
      couple_id: coupleId,
      channel,
      action_type: action,
      occurred_at: occurredAt,
      signal_tier: 'high',
      confidence_tier: 'high',
      raw_payload: outbound ? { direction: 'outbound' } : { direction: 'inbound' },
    })
  }

  for (const s of specs) {
    couples.push({
      id: s.id,
      venue_id: VENUE,
      lifecycle_state: s.lifecycle ?? 'resolved',
      channel_scope: null,
      wedding_date: s.weddingDate ?? null,
      heat_score: null,
      created_at: s.inbound ?? '2026-01-01T00:00:00Z',
      last_progression_at: s.inbound ?? '2026-01-01T00:00:00Z',
      primary_contact_name: s.name ?? s.id,
      partner_contact_name: s.partner ?? null,
      source_wedding_id: s.weddingRowId ?? null,
      merged_into_id: s.mergedInto ?? null,
    })

    if (s.inbound) {
      push(s.id, 'gmail', 'reply', s.inbound)
      const inboundMs = Date.parse(s.inbound)
      if (s.replyAfterHours !== null && s.replyAfterHours !== undefined) {
        const first = new Date(inboundMs + s.replyAfterHours * 3600_000)
        push(s.id, 'gmail', 'venue_sent', first.toISOString(), true)
        for (let i = 1; i <= (s.extraReplies ?? 0); i++) {
          push(
            s.id,
            'gmail',
            'venue_sent',
            new Date(first.getTime() + i * 86_400_000).toISOString(),
            true,
          )
        }
      }
      if (s.toured) {
        push(s.id, 'calendly', 'tour_attended', new Date(inboundMs + 14 * 86_400_000).toISOString())
      }
    }
  }

  return {
    specs,
    db: {
      couples,
      touchpoints,
      couple_progression_events: [],
      venues: [{ id: VENUE }],
      venue_config: [{ venue_id: VENUE, timezone }],
      weddings: [],
      marketing_spend_records: [],
      marketing_spend: [],
      ...extra,
    },
  }
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const run = (source: typeof timeSeriesSource, args: Record<string, unknown>, db: Db): Promise<any> =>
  source.run(VENUE, args, deps(db))

// ---------------------------------------------------------------------------
// Registration
// ---------------------------------------------------------------------------

describe('W12 tool sources — contract', () => {
  it('both sources bind venueId outside the schema and take only the parameters they support', () => {
    for (const source of [timeSeriesSource, operatorPatternsSource]) {
      const props = source.tool.input_schema.properties ?? {}
      expect(Object.keys(props)).not.toContain('venue_id')
      expect(Object.keys(props)).not.toContain('venueId')
      expect(source.tool.input_schema.required).toEqual(['metric'])
      expect(source.subjects.length).toBeGreaterThan(0)
      expect(source.batteryQuestions.length).toBeGreaterThan(0)
    }
    expect(timeSeriesSource.tool.name).toBe('get_time_series')
    expect(operatorPatternsSource.tool.name).toBe('get_operator_patterns')
  })

  it('refuses an unknown metric instead of guessing one', async () => {
    const { db } = build([])
    const r = await run(timeSeriesSource, { metric: 'revenue' }, db)
    expect(r.error).toMatch(/metric is required/)
  })

  it('returns an honest empty when there is no venue in scope', async () => {
    const { db } = build([])
    const r = await timeSeriesSource.run('', { metric: 'lead_time' }, deps(db))
    expect((r as { enoughData: boolean }).enoughData).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// Q1
// ---------------------------------------------------------------------------

function responseFixture(): Fixture {
  const specs: Spec[] = []
  // Sixteen inquiries inside the last twelve months, answered in two hours.
  const recent = [
    '2025-10-05',
    '2025-12-20',
    '2026-01-09',
    '2026-02-14',
    '2026-03-11',
    '2026-04-20',
    '2026-05-02',
    '2026-06-05',
    '2026-06-06',
    '2026-06-07',
    '2026-06-08',
    '2026-06-09',
    '2026-07-10',
    '2026-08-15',
    '2026-09-01',
    '2026-09-02',
  ]
  recent.forEach((d, i) =>
    specs.push({ id: `r${i}`, inbound: `${d}T10:00:00Z`, replyAfterHours: 2 }),
  )
  // Nine in the twelve months before that, answered in ten hours.
  const prior = [
    '2024-10-01',
    '2024-11-01',
    '2024-12-01',
    '2025-01-01',
    '2025-02-01',
    '2025-03-01',
    '2025-04-01',
    '2025-05-01',
    '2025-06-01',
  ]
  prior.forEach((d, i) =>
    specs.push({ id: `p${i}`, inbound: `${d}T10:00:00Z`, replyAfterHours: 10 }),
  )
  return build(specs)
}

describe('Q1 — response time month by month', () => {
  it('gives a median, a twelve-month comparison and a direction', async () => {
    const { db } = responseFixture()
    const r = await run(timeSeriesSource, { metric: 'response_time_trend' }, db)

    expect(r.battery).toBe('Q1')
    expect(r.last12Months).toMatchObject({ value: 2, n: 16, enoughData: true })
    expect(r.previous12Months).toMatchObject({ value: 10, n: 9, enoughData: true })
    expect(r.changeHours).toBe(-8)
    expect(r.direction).toBe('faster')
    expect(r.overallMedianHours.n).toBe(25)
  })

  it('runs the last twelve calendar months, newest last, and refuses a thin month', async () => {
    const { db } = responseFixture()
    const r = await run(timeSeriesSource, { metric: 'response_time_trend' }, db)

    expect(r.byMonth).toHaveLength(12)
    expect(r.byMonth[0].month).toBe('2025-10')
    expect(r.byMonth[11].month).toBe('2026-09')

    // June has five answered inquiries, which is the bar, so it may speak.
    const june = r.byMonth.find((m: { month: string }) => m.month === '2026-06')
    expect(june.medianHours).toMatchObject({ value: 2, n: 5, enoughData: true })

    // July has one, so it refuses and says why rather than printing a median.
    const july = r.byMonth.find((m: { month: string }) => m.month === '2026-07')
    expect(july.medianHours.value).toBeNull()
    expect(july.medianHours).toMatchObject({ n: 1, enoughData: false })
    expect(july.medianHours.reason).toMatch(/only 1/)
  })

  it('counts inquiries that were never answered separately from the median', async () => {
    const { db } = build([
      { id: 'a', inbound: '2026-08-01T10:00:00Z', replyAfterHours: 3 },
      { id: 'b', inbound: '2026-08-02T10:00:00Z', replyAfterHours: null },
      { id: 'c', inbound: '2026-08-03T10:00:00Z', replyAfterHours: null },
    ])
    const r = await run(timeSeriesSource, { metric: 'response_time_trend' }, db)
    expect(r.neverReplied.n).toBe(2)
    // One answered inquiry is not a median.
    expect(r.overallMedianHours.value).toBeNull()
    expect(r.overallMedianHours).toMatchObject({ n: 1, enoughData: false })
  })

  it('leaves merged-away couples out of the counts', async () => {
    const { db } = build([
      { id: 'a', inbound: '2026-08-01T10:00:00Z', replyAfterHours: 3 },
      { id: 'b', inbound: '2026-08-02T10:00:00Z', replyAfterHours: 3, mergedInto: 'a' },
    ])
    const r = await run(timeSeriesSource, { metric: 'response_time_trend' }, db)
    expect(r.overallMedianHours.n).toBe(1)
  })
})

// ---------------------------------------------------------------------------
// Q7
// ---------------------------------------------------------------------------

describe('Q7 — the week after a holiday', () => {
  it('measures the holiday week per day against a per-day baseline', async () => {
    const specs: Spec[] = []
    // Twenty ordinary arrivals spread over January and March.
    let i = 0
    for (const day of [10, 12, 14, 16, 18, 20, 22, 24, 26, 28]) {
      specs.push({ id: `jan-${i++}`, inbound: `2026-01-${day}T10:00:00Z`, replyAfterHours: 1 })
    }
    for (const day of [1, 3, 5, 7, 9, 11, 13, 15, 17, 31]) {
      const dd = String(day).padStart(2, '0')
      specs.push({ id: `mar-${i++}`, inbound: `2026-03-${dd}T10:00:00Z`, replyAfterHours: 1 })
    }
    // Eight in the week after Valentine's Day 2026 (15th to 21st of February).
    for (const day of [15, 16, 17, 18, 19, 20, 21, 21]) {
      specs.push({
        id: `vd-${i++}`,
        inbound: `2026-02-${day}T10:00:00Z`,
        replyAfterHours: 1,
        lifecycle: day <= 17 ? 'booked' : 'resolved',
      })
    }
    const { db } = build(specs)

    const r = await run(timeSeriesSource, { metric: 'holiday_spike', holiday: "Valentine's Day" }, db)
    expect(r.battery).toBe('Q7')
    expect(r.observationSpan).toMatchObject({ from: '2026-01-10', to: '2026-03-31', days: 81 })
    expect(r.baseline.days).toBe(74)
    expect(r.baseline.inquiries.n).toBe(20)

    expect(r.holidays).toHaveLength(1)
    const vd = r.holidays[0]
    expect(vd.holiday).toBe("Valentine's Day")
    expect(vd.windowDays).toBe(7)
    expect(vd.inquiries.n).toBe(8)
    expect(vd.inquiriesPerDay.value).toBeCloseTo(8 / 7, 2)
    expect(vd.liftVsBaseline.value).toBeGreaterThan(3)
    // Three of the eight booked, against a baseline cohort that booked none.
    expect(vd.bookedRate).toMatchObject({ value: 0.38, n: 8, enoughData: true })
    expect(r.baseline.bookedRate).toMatchObject({ value: 0, n: 20, enoughData: true })
  })

  it('names the holidays it knows rather than returning an empty list', async () => {
    const { db } = build([{ id: 'a', inbound: '2026-02-16T10:00:00Z', replyAfterHours: 1 }])
    const r = await run(timeSeriesSource, { metric: 'holiday_spike', holiday: 'Easter' }, db)
    expect(r.error).toMatch(/Valentine/)
  })

  it('refuses when there are no inquiries to build a baseline from', async () => {
    const { db } = build([])
    const r = await run(timeSeriesSource, { metric: 'holiday_spike' }, db)
    expect(r.enoughData).toBe(false)
    expect(r.holidays).toEqual([])
  })
})

// ---------------------------------------------------------------------------
// Q11
// ---------------------------------------------------------------------------

describe('Q11 — booking lead time', () => {
  it('calls it shortening when the recent cohort books closer in', async () => {
    const specs: Spec[] = []
    // Ten recent inquiries, each two hundred days out.
    for (let i = 0; i < 10; i++) {
      const day = String(1 + i).padStart(2, '0')
      specs.push({
        id: `recent-${i}`,
        inbound: `2026-06-${day}T10:00:00Z`,
        replyAfterHours: 1,
        weddingDate: '2026-12-18',
      })
    }
    // Nine from the year before, each far further out.
    for (let i = 0; i < 9; i++) {
      const day = String(1 + i).padStart(2, '0')
      specs.push({
        id: `prior-${i}`,
        inbound: `2025-06-${day}T10:00:00Z`,
        replyAfterHours: 1,
        weddingDate: '2026-11-01',
      })
    }
    // Three with no date at all.
    for (let i = 0; i < 3; i++) {
      specs.push({ id: `nodate-${i}`, inbound: '2026-05-01T10:00:00Z', replyAfterHours: 1 })
    }
    const { db } = build(specs)

    const r = await run(timeSeriesSource, { metric: 'lead_time' }, db)
    expect(r.battery).toBe('Q11')
    expect(r.couplesWithDate.n).toBe(19)
    expect(r.couplesWithoutDate.n).toBe(3)
    expect(r.last12Months.value).toBeGreaterThan(190)
    expect(r.last12Months.value).toBeLessThan(200)
    expect(r.previous12Months.value).toBeGreaterThan(505)
    expect(r.previous12Months.value).toBeLessThan(520)
    expect(r.direction).toBe('shortening')
    expect(r.histogram.length).toBeGreaterThan(0)
  })

  it('says unknown rather than guessing a direction from one cohort', async () => {
    const specs: Spec[] = []
    for (let i = 0; i < 10; i++) {
      const day = String(1 + i).padStart(2, '0')
      specs.push({
        id: `recent-${i}`,
        inbound: `2026-06-${day}T10:00:00Z`,
        replyAfterHours: 1,
        weddingDate: '2026-12-18',
      })
    }
    const { db } = build(specs)
    const r = await run(timeSeriesSource, { metric: 'lead_time' }, db)
    expect(r.previous12Months.enoughData).toBe(false)
    expect(r.direction).toBe('unknown')
    expect(r.changeDays).toBeNull()
  })
})

// ---------------------------------------------------------------------------
// Q12
// ---------------------------------------------------------------------------

describe('Q12 — a calendar month year over year', () => {
  it('refuses a percentage change off a base of three', async () => {
    const specs: Spec[] = []
    for (let i = 0; i < 3; i++) {
      specs.push({ id: `ly-${i}`, inbound: `2025-06-0${i + 1}T10:00:00Z`, replyAfterHours: 1 })
    }
    for (let i = 0; i < 7; i++) {
      specs.push({ id: `ty-${i}`, inbound: `2026-06-0${i + 1}T10:00:00Z`, replyAfterHours: 1 })
    }
    const { db } = build(specs)

    const r = await run(timeSeriesSource, { metric: 'monthly_volume_yoy', month: 6 }, db)
    expect(r.battery).toBe('Q12')
    expect(r.focusMonth).toBe('June')
    expect(r.monthly).toHaveLength(1)
    expect(r.monthly[0].thisYear.n).toBe(7)
    expect(r.monthly[0].lastYear.n).toBe(3)
    expect(r.monthly[0].changePct.value).toBeNull()
    expect(r.monthly[0].changePct.reason).toMatch(/only 3 inquiries/)
    expect(r.everyYearOnRecord).toEqual([
      { year: 2025, inquiries: { n: 3 } },
      { year: 2026, inquiries: { n: 7 } },
    ])
    expect(r.marketingSpendAvailable).toBe(false)
    expect(r.caveat).toMatch(/not controlled for/)
  })

  it('gives the percentage once last year has a real base', async () => {
    const specs: Spec[] = []
    for (let i = 0; i < 10; i++) {
      const day = String(i + 1).padStart(2, '0')
      specs.push({ id: `ly-${i}`, inbound: `2025-06-${day}T10:00:00Z`, replyAfterHours: 1 })
    }
    for (let i = 0; i < 6; i++) {
      const day = String(i + 1).padStart(2, '0')
      specs.push({ id: `ty-${i}`, inbound: `2026-06-${day}T10:00:00Z`, replyAfterHours: 1 })
    }
    const { db } = build(specs)
    const r = await run(timeSeriesSource, { metric: 'monthly_volume_yoy', month: 6 }, db)
    expect(r.monthly[0].changePct).toMatchObject({ value: -40, n: 10, enoughData: true })
  })
})

// ---------------------------------------------------------------------------
// Q14
// ---------------------------------------------------------------------------

describe('Q14 — inquiry to tour by season of the event', () => {
  it('buckets on the wedding date, not on when the inquiry arrived', async () => {
    const specs: Spec[] = []
    // Six August weddings, three of which toured. One of them enquired in
    // January, which is the case that separates event season from arrival season.
    for (let i = 0; i < 6; i++) {
      const day = String(i + 1).padStart(2, '0')
      specs.push({
        id: `sum-${i}`,
        inbound: i === 0 ? '2026-01-15T10:00:00Z' : `2026-03-${day}T10:00:00Z`,
        replyAfterHours: 1,
        weddingDate: '2026-08-22',
        toured: i < 3,
      })
    }
    // Six October weddings, one of which toured.
    for (let i = 0; i < 6; i++) {
      const day = String(i + 1).padStart(2, '0')
      specs.push({
        id: `fall-${i}`,
        inbound: `2026-03-${day}T11:00:00Z`,
        replyAfterHours: 1,
        weddingDate: '2026-10-10',
        toured: i < 1,
      })
    }
    specs.push({ id: 'nodate', inbound: '2026-03-01T10:00:00Z', replyAfterHours: 1 })
    const { db } = build(specs)

    const all = await run(timeSeriesSource, { metric: 'inquiry_to_tour_by_season' }, db)
    expect(all.battery).toBe('Q14')
    expect(all.seasons).toHaveLength(4)
    expect(all.couplesWithoutWeddingDate.n).toBe(1)

    const summer = all.seasons.find((s: { season: string }) => s.season === 'Summer')
    expect(summer.inquiries.n).toBe(6)
    expect(summer.toured.n).toBe(3)
    expect(summer.inquiryToTour).toMatchObject({ value: 0.5, n: 6, enoughData: true })

    const fall = all.seasons.find((s: { season: string }) => s.season === 'Fall')
    expect(fall.inquiryToTour.value).toBeCloseTo(0.17, 2)

    // Spring has no weddings at all, so it refuses rather than reporting nought.
    const spring = all.seasons.find((s: { season: string }) => s.season === 'Spring')
    expect(spring.inquiryToTour.value).toBeNull()
    expect(spring.inquiryToTour.enoughData).toBe(false)
  })

  it('honours the season filter', async () => {
    const { db } = build([{ id: 'a', inbound: '2026-03-01T10:00:00Z', weddingDate: '2026-08-01' }])
    const r = await run(timeSeriesSource, { metric: 'inquiry_to_tour_by_season', season: 'summer' }, db)
    expect(r.seasons).toHaveLength(1)
    expect(r.seasons[0].season).toBe('Summer')
  })
})

// ---------------------------------------------------------------------------
// Q22
// ---------------------------------------------------------------------------

function timingSpecs(): Spec[] {
  // Monday 1 June 2026. Inquiry lands at 14:00 UTC, answered two hours later.
  return Array.from({ length: 6 }, (_, i) => ({
    id: `t${i}`,
    inbound: '2026-06-01T14:00:00Z',
    replyAfterHours: 2,
  }))
}

describe('Q22 — when replies go out against when inquiries arrive', () => {
  it('buckets by hour and weekday and ranks the arrival hours it can measure', async () => {
    const { db } = build(timingSpecs(), 'UTC')
    const r = await run(operatorPatternsSource, { metric: 'reply_timing' }, db)

    expect(r.battery).toBe('Q22')
    expect(r.timezone).toBe('UTC')
    expect(r.replies.n).toBe(6)
    expect(r.replies.byHour[16].n).toBe(6)
    expect(r.inquiries.byHour[14].n).toBe(6)
    expect(r.replies.byWeekday.find((d: { weekday: string }) => d.weekday === 'Monday').n).toBe(6)

    const at14 = r.responseSpeedByArrivalHour[14]
    expect(at14.medianHours).toMatchObject({ value: 2, n: 6, enoughData: true })
    expect(r.fastestArrivalHour.hour).toBe(14)
    expect(r.slowestArrivalHour.hour).toBe(14)
  })

  it('reads the hours in the venue timezone from venue_config, not in UTC', async () => {
    const { db } = build(timingSpecs(), 'America/New_York')
    const r = await run(operatorPatternsSource, { metric: 'reply_timing' }, db)
    expect(r.timezone).toBe('America/New_York')
    // 16:00 UTC on the first of June is midday in New York.
    expect(r.replies.byHour[12].n).toBe(6)
    expect(r.replies.byHour[16].n).toBe(0)
    expect(r.inquiries.byHour[10].n).toBe(6)
  })

  it('will not rank an hour it has too few inquiries for', async () => {
    const { db } = build([{ id: 'a', inbound: '2026-06-01T14:00:00Z', replyAfterHours: 2 }], 'UTC')
    const r = await run(operatorPatternsSource, { metric: 'reply_timing' }, db)
    expect(r.fastestArrivalHour.enoughData).toBe(false)
    expect(r.responseSpeedByArrivalHour[14].medianHours.value).toBeNull()
  })
})

// ---------------------------------------------------------------------------
// Q23
// ---------------------------------------------------------------------------

describe('Q23 — replied once and never followed up', () => {
  it('counts exactly one outbound message, and keeps never-replied separate', async () => {
    const specs: Spec[] = []
    for (let i = 0; i < 6; i++) {
      const day = String(i + 1).padStart(2, '0')
      specs.push({
        id: `once-${i}`,
        name: `Once ${i}`,
        partner: 'Partner',
        inbound: `2026-06-${day}T10:00:00Z`,
        replyAfterHours: 1,
        lifecycle: i === 0 ? 'booked' : 'resolved',
      })
    }
    for (let i = 0; i < 4; i++) {
      const day = String(i + 1).padStart(2, '0')
      specs.push({
        id: `chased-${i}`,
        inbound: `2026-07-${day}T10:00:00Z`,
        replyAfterHours: 1,
        extraReplies: 2,
      })
    }
    for (let i = 0; i < 2; i++) {
      specs.push({ id: `ignored-${i}`, inbound: '2026-07-20T10:00:00Z', replyAfterHours: null })
    }
    const { db } = build(specs)

    const r = await run(operatorPatternsSource, { metric: 'single_reply_no_follow_up' }, db)
    expect(r.battery).toBe('Q23')
    expect(r.coupleCount.n).toBe(6)
    expect(r.ofCouplesEverReplied).toMatchObject({ value: 0.6, n: 10, enoughData: true })
    expect(r.stillOpen.n).toBe(5)
    expect(r.neverRepliedAtAll.n).toBe(2)

    const channels = r.byInquiryChannel.map((c: { label: string }) => c.label)
    expect(channels).toEqual(['gmail'])
    expect(r.byReplyWeekday[0].n).toBeGreaterThan(0)

    // Names for the operator, ids alongside for the model to chain on.
    expect(r.couples[0].name).toMatch(/ & Partner$/)
    expect(r.couples[0].coupleId).toMatch(/^once-/)
    expect(r.truncated).toBe(false)
  })

  it('refuses the share when too few couples were ever replied to', async () => {
    const { db } = build([
      { id: 'a', inbound: '2026-06-01T10:00:00Z', replyAfterHours: 1 },
      { id: 'b', inbound: '2026-06-02T10:00:00Z', replyAfterHours: 1, extraReplies: 1 },
    ])
    const r = await run(operatorPatternsSource, { metric: 'single_reply_no_follow_up' }, db)
    expect(r.coupleCount.n).toBe(1)
    expect(r.ofCouplesEverReplied.value).toBeNull()
    expect(r.ofCouplesEverReplied.enoughData).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// Q24
// ---------------------------------------------------------------------------

describe('Q24 — replied to, and it turned out to be a mismatch', () => {
  it('groups the recorded reasons verbatim and never invents one', async () => {
    const specs: Spec[] = []
    for (let i = 0; i < 12; i++) {
      const day = String(i + 1).padStart(2, '0')
      specs.push({
        id: `c-${i}`,
        name: `Couple ${i}`,
        inbound: `2026-05-${day}T10:00:00Z`,
        replyAfterHours: i < 6 ? 1 : 20,
        weddingRowId: i < 7 ? `w-${i}` : null,
      })
    }
    const weddings = [
      { id: 'w-0', venue_id: VENUE, status: 'lost', lost_at: '2026-06-01', lost_reason: 'Budget' },
      { id: 'w-1', venue_id: VENUE, status: 'lost', lost_at: '2026-06-02', lost_reason: 'Budget' },
      { id: 'w-2', venue_id: VENUE, status: 'lost', lost_at: '2026-06-03', lost_reason: 'budget' },
      { id: 'w-3', venue_id: VENUE, status: 'lost', lost_at: '2026-06-04', lost_reason: null },
      { id: 'w-4', venue_id: VENUE, status: 'lost', lost_at: '2026-06-05', lost_reason: 'Date gone' },
      { id: 'w-5', venue_id: VENUE, status: 'lost', lost_at: '2026-06-06', lost_reason: 'Date gone' },
      { id: 'w-6', venue_id: VENUE, status: 'booked', lost_at: null, lost_reason: null },
      // A lost wedding with no couple pointing at it must not appear at all.
      { id: 'w-99', venue_id: VENUE, status: 'lost', lost_at: '2026-06-09', lost_reason: 'Ghosted' },
    ]
    const { db } = build(specs, 'UTC', { weddings })

    const r = await run(operatorPatternsSource, { metric: 'replied_but_mismatch' }, db)
    expect(r.battery).toBe('Q24')
    expect(r.repliedAndLost.n).toBe(6)
    expect(r.withRecordedReason.n).toBe(5)
    expect(r.withoutRecordedReason.n).toBe(1)
    expect(r.repliedWithNoLegacyRecord.n).toBe(5)

    // Three spellings of one reason, grouped, with the operator's own wording,
    // and nothing sorted into an inferred category.
    expect(r.reasons).toEqual([
      { reason: 'Budget', n: 3, share: 0.6 },
      { reason: 'Date gone', n: 2, share: 0.4 },
    ])

    // The six that were lost are the six that got the fastest replies.
    expect(r.replyTime.lostCouples).toMatchObject({ value: 1, n: 6, enoughData: true })
    expect(r.replyTime.allAnsweredInquiries).toMatchObject({ n: 12, enoughData: true })

    expect(r.couples.every((c: { reason: string | null }) => c.reason !== null)).toBe(true)
    expect(r.couples[0].coupleId).toMatch(/^c-/)
    expect(r.source).toMatch(/legacy table/)
  })

  it('reports nothing rather than something when no wedding was marked lost', async () => {
    const { db } = build([{ id: 'a', inbound: '2026-05-01T10:00:00Z', replyAfterHours: 2 }])
    const r = await run(operatorPatternsSource, { metric: 'replied_but_mismatch' }, db)
    expect(r.repliedAndLost.n).toBe(0)
    expect(r.reasons).toEqual([])
    expect(r.shareOfRepliedThatWereLost.enoughData).toBe(false)
  })
})
