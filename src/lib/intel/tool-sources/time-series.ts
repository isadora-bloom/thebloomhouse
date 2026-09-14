/**
 * Time-series tool source — the "has this changed?" half of the battery.
 *
 * W12 of NOVEMBER-PLAN.md wave 2. After W3 the brain may only state a number a
 * tool handed it, so five questions the database can actually answer came back
 * as a refusal. This source answers them:
 *
 *   Q1  median inquiry-to-first-reply, month by month, and its 12-month change
 *   Q7  inquiry volume in the week after a named holiday vs baseline, and how
 *       that cohort converted
 *   Q11 booking lead-time distribution, and whether it is shortening,
 *       lengthening or stable
 *   Q12 June (or any month) inquiry volume year over year, with the honest
 *       caveat that marketing changes are not controlled for
 *   Q14 inquiry-to-tour ratio for summer EVENT dates against the other seasons
 *
 * Everything is computed over the identity-first spine: `couples` and
 * `touchpoints`, loaded once by the cohort loader, turned into per-couple facts
 * by `buildCoupleFacts`. That reuse is deliberate — "first reply", "toured" and
 * "messageable inbound" have exactly one definition in this codebase and this
 * source does not get a second one.
 *
 * No period parameter, on purpose. The cohort loader's only bound is a lower
 * bound, and quietly applying one would make a year-over-year comparison look
 * like a collapse and a trend look like a step change. All five metrics read
 * full history and say so.
 */

import type Anthropic from '@anthropic-ai/sdk'
import type { SupabaseClient } from '@supabase/supabase-js'
import { insufficient, type HonestCount, type IntelToolSource, type ToolSourceDeps } from './types'
import { loadCohortData } from '@/lib/services/cohort/data'
import { buildCoupleFacts, type CoupleFacts } from '@/lib/services/cohort/facts'
import { computeLeadTime } from '@/lib/services/cohort/lead-time'
import { computeYoY } from '@/lib/services/cohort/yoy'
import {
  MONTH_LABEL,
  fetchAllRows,
  median,
  round2,
  season,
  zonedParts,
} from '@/lib/services/cohort/helpers'
import { MIN_DISTRIBUTION_N, type CohortData } from '@/lib/services/cohort/types'

// ---------------------------------------------------------------------------
// Honesty primitives
// ---------------------------------------------------------------------------

/** A number with its sample size attached. `value` is null whenever the sample
 *  is too small to say anything, so a caller can never read a placeholder as a
 *  measurement. */
export interface HonestValue extends HonestCount {
  value: number | null
}

/** Headline bar. Same one the cohort layer uses, so a median here and a median
 *  on /intel agree about when they are allowed to speak. */
const MIN_N = MIN_DISTRIBUTION_N

/** Bar for one slice of a headline: one calendar month, one season, one
 *  holiday window. CHOSEN, not sourced: below five observations a median is
 *  one or two people having an unusual week, and a rate is noise. */
const MIN_SLICE_N = 5

const DAY_MS = 86_400_000
const YEAR_MS = 365 * DAY_MS

/** Wrap a computed value in its sample size, refusing below `minN`. */
export function honest(
  value: number | null,
  n: number,
  minN: number,
  units: string,
): HonestValue {
  if (n <= 0) return { value: null, ...insufficient(0, `no ${units} on record`) }
  if (n < minN) {
    return {
      value: null,
      ...insufficient(n, `only ${n} ${units}; ${minN} is the smallest sample worth quoting`),
    }
  }
  if (value === null || !Number.isFinite(value)) {
    return { value: null, ...insufficient(n, `${units} could not be measured`) }
  }
  return { value: round2(value), n, enoughData: true }
}

/** A rate, carrying the denominator as its n. Null denominator is refused, not
 *  reported as zero. */
export function honestRate(
  numerator: number,
  denominator: number,
  minN: number,
  units: string,
): HonestValue {
  if (denominator <= 0) return { value: null, ...insufficient(0, `no ${units} on record`) }
  if (denominator < minN) {
    return {
      value: null,
      ...insufficient(
        denominator,
        `only ${denominator} ${units}; ${minN} is the smallest sample worth quoting`,
      ),
    }
  }
  return { value: round2(numerator / denominator), n: denominator, enoughData: true }
}

// ---------------------------------------------------------------------------
// Shared spine load
// ---------------------------------------------------------------------------

/** The slice of the spine both W12 sources compute over.
 *
 *  `operator-patterns.ts` imports this rather than repeating the load: the two
 *  sources answer different questions off exactly the same rows, and having
 *  two loaders would be two chances for them to disagree. */
export interface SpineSlice {
  data: CohortData
  /** Engaged couples, merged-away tombstones already dropped. */
  facts: CoupleFacts[]
  /** Venue local time, from venue_config. Every hour, weekday and month
   *  bucket in both sources is expressed in it. */
  timezone: string
  /** couple id -> partner name, for display. The cohort loader only selects
   *  the primary contact. */
  partnerName: Map<string, string | null>
  /** couple id -> legacy weddings row id, for the one fact (loss reason) that
   *  the spine does not carry. */
  weddingId: Map<string, string | null>
}

interface CoupleSideRow {
  id: string
  partner_contact_name: string | null
  source_wedding_id: string | null
  merged_into_id: string | null
}

/** Venue local time. `venue_config.timezone` is the operator-facing setting;
 *  it defaults to America/New_York in migration 001 and we fall back to the
 *  same value when the row or the column is unreadable. */
async function loadVenueTimezone(
  supabase: SupabaseClient,
  venueId: string,
): Promise<string> {
  const { data } = await supabase
    .from('venue_config')
    .select('timezone')
    .eq('venue_id', venueId)
    .maybeSingle()
  const tz = (data as { timezone?: unknown } | null)?.timezone
  return typeof tz === 'string' && tz.trim().length > 0 ? tz.trim() : 'America/New_York'
}

export async function loadSpineSlice(
  supabase: SupabaseClient,
  venueId: string,
): Promise<SpineSlice> {
  const [data, timezone, sideRows] = await Promise.all([
    loadCohortData(supabase, venueId),
    loadVenueTimezone(supabase, venueId),
    fetchAllRows<CoupleSideRow>(() =>
      supabase
        .from('couples')
        .select('id, partner_contact_name, source_wedding_id, merged_into_id')
        .eq('venue_id', venueId),
    ),
  ])

  const partnerName = new Map<string, string | null>()
  const weddingId = new Map<string, string | null>()
  const mergedAway = new Set<string>()
  for (const row of sideRows) {
    partnerName.set(row.id, row.partner_contact_name)
    weddingId.set(row.id, row.source_wedding_id)
    if (row.merged_into_id) mergedAway.add(row.id)
  }

  // The cohort loader does not exclude merged-away couples, so its counts can
  // run ahead of getVenueOverview by the number of tombstones. Drop them here
  // rather than quietly disagreeing with the canonical readers.
  const withTimezone: CohortData = { ...data, timezone }
  const facts = buildCoupleFacts(withTimezone).filter((f) => !mergedAway.has(f.couple.id))

  return { data: withTimezone, facts, timezone, partnerName, weddingId }
}

/** Display name for a couple: primary and partner when both are known. */
export function displayName(slice: SpineSlice, f: CoupleFacts): string | null {
  const primary = f.couple.primary_contact_name?.trim() || null
  const partner = slice.partnerName.get(f.couple.id)?.trim() || null
  if (primary && partner) return `${primary} & ${partner}`
  return primary ?? partner ?? null
}

/** `deps.today` may be a bare date or a full timestamp. Midday UTC keeps a
 *  bare date on the same calendar day in every venue timezone we serve. */
export function todayMs(today: string): number {
  const iso = today.length <= 10 ? `${today}T12:00:00Z` : today
  const ms = Date.parse(iso)
  return Number.isFinite(ms) ? ms : Date.parse(`${new Date().toISOString().slice(0, 10)}T12:00:00Z`)
}

// ---------------------------------------------------------------------------
// Q1 — response time month by month
// ---------------------------------------------------------------------------

/** The last `count` calendar months ending with the month `today` falls in,
 *  oldest first, as 'YYYY-MM' keys in venue local time. */
function recentMonthKeys(today: string, tz: string, count: number): string[] {
  const parts = zonedParts(new Date(todayMs(today)).toISOString(), tz)
  const year = parts?.year ?? new Date().getUTCFullYear()
  const month = parts?.month ?? 1
  const keys: string[] = []
  for (let back = count - 1; back >= 0; back--) {
    const total = year * 12 + (month - 1) - back
    const y = Math.floor(total / 12)
    const m = (total % 12) + 1
    keys.push(`${y}-${String(m).padStart(2, '0')}`)
  }
  return keys
}

/** How much a median has to move before we call it a change. CHOSEN: a tenth
 *  of the earlier median. Smaller than that on a venue's volume is drift. */
const TREND_SENSITIVITY = 0.1

function verdict(
  recent: HonestValue,
  prior: HonestValue,
  fasterWord: string,
  slowerWord: string,
): { direction: string; changed: number | null } {
  if (!recent.enoughData || !prior.enoughData || recent.value === null || prior.value === null) {
    return { direction: 'unknown', changed: null }
  }
  const delta = recent.value - prior.value
  if (Math.abs(delta) < TREND_SENSITIVITY * Math.abs(prior.value)) {
    return { direction: 'stable', changed: round2(delta) }
  }
  return { direction: delta < 0 ? fasterWord : slowerWord, changed: round2(delta) }
}

function responseTimeTrend(slice: SpineSlice, today: string) {
  const replied = slice.facts.filter(
    (f) => f.responseHours !== null && f.firstMessageableInboundAt !== null,
  )
  const allHours = replied.map((f) => f.responseHours as number)

  // Month by month, keyed on when the inquiry arrived, not on when it was
  // answered — otherwise a slow reply lands in the wrong month.
  const perMonth = new Map<string, number[]>()
  for (const f of replied) {
    const p = zonedParts(f.firstMessageableInboundAt as string, slice.timezone)
    if (!p) continue
    const list = perMonth.get(p.monthKey)
    if (list) list.push(f.responseHours as number)
    else perMonth.set(p.monthKey, [f.responseHours as number])
  }
  const byMonth = recentMonthKeys(today, slice.timezone, 12).map((key) => {
    const hours = perMonth.get(key) ?? []
    return {
      month: key,
      medianHours: honest(median(hours), hours.length, MIN_SLICE_N, 'answered inquiries'),
    }
  })

  const now = todayMs(today)
  const last12: number[] = []
  const prior12: number[] = []
  for (const f of replied) {
    const age = now - Date.parse(f.firstMessageableInboundAt as string)
    if (age < 0) continue
    if (age <= YEAR_MS) last12.push(f.responseHours as number)
    else if (age <= 2 * YEAR_MS) prior12.push(f.responseHours as number)
  }
  const recent = honest(median(last12), last12.length, MIN_N, 'answered inquiries')
  const previous = honest(median(prior12), prior12.length, MIN_N, 'answered inquiries')
  const v = verdict(recent, previous, 'faster', 'slower')

  return {
    metric: 'response_time_trend',
    battery: 'Q1',
    timezone: slice.timezone,
    unit: 'hours from the inquiry landing to the first venue reply',
    overallMedianHours: honest(median(allHours), allHours.length, MIN_N, 'answered inquiries'),
    byMonth,
    last12Months: recent,
    previous12Months: previous,
    changeHours: v.changed,
    direction: v.direction,
    neverReplied: {
      n: slice.facts.filter((f) => f.hasMessageableInbound && !f.hasReply).length,
      note: 'Inquiries the venue could have replied to in writing and never did. They are counted here, never folded into the median.',
    },
    note:
      'Measured only over inquiries the venue could reply to in writing. A self-service ' +
      'Calendly booking is inbound but is not a message awaiting an answer, so it is excluded.',
  }
}

// ---------------------------------------------------------------------------
// Q7 — the week after a holiday
// ---------------------------------------------------------------------------

/**
 * The holidays Q7 names, plus New Year's Day because engagement season is the
 * real spike an operator is thinking of.
 *
 * The cohort layer already has a `holidayWindow` helper, but its windows are
 * built for a different question (which days sit inside a broad browsing
 * window) and it carries neither Mother's Day nor Christmas, the two the
 * question names. So the dates are computed here instead of stretching that
 * helper into a shape its other callers do not want.
 */
const HOLIDAYS: { name: string; date: (year: number) => { month: number; day: number } }[] = [
  { name: "New Year's Day", date: () => ({ month: 1, day: 1 }) },
  { name: "Valentine's Day", date: () => ({ month: 2, day: 14 }) },
  { name: "Mother's Day", date: (y) => secondSundayOfMay(y) },
  { name: 'Christmas Day', date: () => ({ month: 12, day: 25 }) },
]

/** US Mother's Day: the second Sunday in May. */
function secondSundayOfMay(year: number): { month: number; day: number } {
  const firstDow = new Date(Date.UTC(year, 4, 1)).getUTCDay()
  const firstSunday = 1 + ((7 - firstDow) % 7)
  return { month: 5, day: firstSunday + 7 }
}

/** Days counted as "the week after". CHOSEN: the seven days following the
 *  holiday, which is what the question means by "the Monday after". */
const HOLIDAY_WINDOW_DAYS = 7

function dayKey(year: number, month: number, day: number): string {
  return `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`
}

function holidaySpike(slice: SpineSlice, today: string, only?: string) {
  // One arrival per couple, on the day its first inbound signal landed.
  const arrivals: { dateKey: string; booked: boolean }[] = []
  for (const f of slice.facts) {
    if (!f.firstInboundAt) continue
    const p = zonedParts(f.firstInboundAt, slice.timezone)
    if (!p) continue
    arrivals.push({ dateKey: p.dateKey, booked: f.booked })
  }

  if (arrivals.length === 0) {
    return {
      metric: 'holiday_spike',
      battery: 'Q7',
      timezone: slice.timezone,
      ...insufficient(0, 'no inquiries on record, so there is no baseline to compare a holiday week against'),
      holidays: [],
    }
  }

  const keys = arrivals.map((a) => a.dateKey).sort()
  const spanFrom = keys[0]
  const spanToMs = Math.min(todayMs(today), Date.parse(`${keys[keys.length - 1]}T12:00:00Z`))
  const spanTo = new Date(spanToMs).toISOString().slice(0, 10)
  const spanDays = Math.max(
    1,
    Math.round((Date.parse(`${spanTo}T12:00:00Z`) - Date.parse(`${spanFrom}T12:00:00Z`)) / DAY_MS) + 1,
  )

  const fromYear = Number(spanFrom.slice(0, 4))
  const toYear = Number(spanTo.slice(0, 4))

  const wanted = HOLIDAYS.filter((h) => !only || h.name.toLowerCase() === only.toLowerCase())
  const holidayDays = new Set<string>()
  const perHoliday = wanted.map((h) => {
    const days = new Set<string>()
    const years: number[] = []
    // From the year before the span, because a Christmas window runs into the
    // following January and would otherwise be missed at the start of the data.
    for (let y = fromYear - 1; y <= toYear + 1; y++) {
      const d = h.date(y)
      const startMs = Date.UTC(y, d.month - 1, d.day, 12) + DAY_MS
      for (let i = 0; i < HOLIDAY_WINDOW_DAYS; i++) {
        const ms = startMs + i * DAY_MS
        if (ms < Date.parse(`${spanFrom}T12:00:00Z`) || ms > spanToMs) continue
        const dt = new Date(ms)
        days.add(dayKey(dt.getUTCFullYear(), dt.getUTCMonth() + 1, dt.getUTCDate()))
        if (!years.includes(y)) years.push(y)
      }
    }
    for (const d of days) holidayDays.add(d)
    return { name: h.name, days, years }
  })

  const baselineDays = spanDays - holidayDays.size
  const baselineArrivals = arrivals.filter((a) => !holidayDays.has(a.dateKey))
  const baselinePerDay = honest(
    baselineDays > 0 ? baselineArrivals.length / baselineDays : null,
    baselineArrivals.length,
    MIN_N,
    'inquiries outside the holiday weeks',
  )
  const baselineBooked = honestRate(
    baselineArrivals.filter((a) => a.booked).length,
    baselineArrivals.length,
    MIN_N,
    'inquiries outside the holiday weeks',
  )

  const holidays = perHoliday.map((h) => {
    const cohort = arrivals.filter((a) => h.days.has(a.dateKey))
    const perDay = honest(
      h.days.size > 0 ? cohort.length / h.days.size : null,
      cohort.length,
      MIN_SLICE_N,
      `inquiries in the week after ${h.name}`,
    )
    const lift =
      perDay.value !== null && baselinePerDay.value !== null && baselinePerDay.value > 0
        ? { value: round2(perDay.value / baselinePerDay.value), n: cohort.length, enoughData: true }
        : {
            value: null,
            ...insufficient(
              cohort.length,
              'either the holiday week or the baseline is too thin to compare',
            ),
          }
    return {
      holiday: h.name,
      yearsObserved: h.years,
      windowDays: h.days.size,
      inquiries: { n: cohort.length },
      inquiriesPerDay: perDay,
      liftVsBaseline: lift,
      bookedRate: honestRate(
        cohort.filter((a) => a.booked).length,
        cohort.length,
        MIN_SLICE_N,
        `inquiries in the week after ${h.name}`,
      ),
    }
  })

  return {
    metric: 'holiday_spike',
    battery: 'Q7',
    timezone: slice.timezone,
    window: `the ${HOLIDAY_WINDOW_DAYS} days following each holiday`,
    observationSpan: { from: spanFrom, to: spanTo, days: spanDays },
    baseline: {
      days: baselineDays,
      inquiries: { n: baselineArrivals.length },
      inquiriesPerDay: baselinePerDay,
      bookedRate: baselineBooked,
    },
    holidays,
    note:
      'One arrival per couple, dated by their first inbound signal. Lift is holiday inquiries ' +
      'per day divided by baseline inquiries per day, so a shorter window is not penalised.',
  }
}

// ---------------------------------------------------------------------------
// Q11 — booking lead time
// ---------------------------------------------------------------------------

function leadTime(slice: SpineSlice, today: string) {
  const base = computeLeadTime(slice.facts)
  const now = todayMs(today)

  const leadDaysFor = (f: CoupleFacts): number | null => {
    if (!f.couple.wedding_date) return null
    const weddingMs = Date.parse(f.couple.wedding_date)
    const firstMs = Date.parse(f.firstTouchAt)
    if (!Number.isFinite(weddingMs) || !Number.isFinite(firstMs)) return null
    const days = (weddingMs - firstMs) / DAY_MS
    return days > 0 ? days : null
  }

  const recentDays: number[] = []
  const priorDays: number[] = []
  const byYear = new Map<number, number[]>()
  for (const f of slice.facts) {
    const days = leadDaysFor(f)
    if (days === null) continue
    const firstMs = Date.parse(f.firstTouchAt)
    const age = now - firstMs
    if (age >= 0 && age <= YEAR_MS) recentDays.push(days)
    else if (age > YEAR_MS && age <= 2 * YEAR_MS) priorDays.push(days)
    const p = zonedParts(f.firstTouchAt, slice.timezone)
    if (!p) continue
    const list = byYear.get(p.year)
    if (list) list.push(days)
    else byYear.set(p.year, [days])
  }

  const recent = honest(median(recentDays), recentDays.length, MIN_N, 'couples with a date')
  const previous = honest(median(priorDays), priorDays.length, MIN_N, 'couples with a date')
  const v = verdict(recent, previous, 'shortening', 'lengthening')

  return {
    metric: 'lead_time',
    battery: 'Q11',
    timezone: slice.timezone,
    unit: 'days from the first signal to the wedding date',
    medianDays: honest(base.dist.median, base.dist.n, MIN_N, 'couples with a date'),
    quartiles: base.dist.enoughData
      ? { p25: base.dist.p25, p75: base.dist.p75, p90: base.dist.p90, n: base.dist.n }
      : { ...insufficient(base.dist.n, 'too few couples with a wedding date to quote quartiles') },
    histogram: base.histogram,
    couplesWithDate: { n: base.couplesWithDate },
    couplesWithoutDate: { n: base.couplesWithoutDate },
    last12Months: recent,
    previous12Months: previous,
    changeDays: v.changed,
    direction: v.direction === 'unknown' ? 'unknown' : v.direction,
    byInquiryYear: [...byYear.entries()]
      .sort((a, b) => a[0] - b[0])
      .map(([year, days]) => ({
        year,
        medianDays: honest(median(days), days.length, MIN_SLICE_N, 'couples with a date'),
      })),
    note:
      'Couples with no wedding date on record are counted separately and are never treated as ' +
      'a zero lead time. A date on or before the first signal is a backfill artefact and is dropped.',
  }
}

// ---------------------------------------------------------------------------
// Q12 — month volume year over year
// ---------------------------------------------------------------------------

const MARKETING_CAVEAT =
  'This is volume, not cause. Marketing changes are not controlled for: a quieter June could be ' +
  'a quieter market, a changed listing, or spend that moved. Unless the spend figures below are ' +
  'present and stable, the year-over-year number cannot separate those.'

async function monthlyVolumeYoY(
  slice: SpineSlice,
  supabase: SupabaseClient,
  focusMonth?: number,
) {
  const yoy = await computeYoY(slice.data, slice.facts, supabase)

  // Every year in the data for the focused month, so "declining year over
  // year" is not decided on two points when there are five.
  const perYearMonth = new Map<string, number>()
  for (const f of slice.facts) {
    if (!f.firstInboundAt) continue
    const p = zonedParts(f.firstInboundAt, slice.timezone)
    if (!p) continue
    const key = `${p.year}-${p.month}`
    perYearMonth.set(key, (perYearMonth.get(key) ?? 0) + 1)
  }

  const monthly = yoy.monthly
    .filter((m) => !focusMonth || m.month === focusMonth)
    .map((m) => ({
      month: m.month,
      label: m.label,
      thisYear: { n: m.thisYear },
      lastYear: { n: m.lastYear },
      // computeYoY divides by whatever last year happened to be. A change from
      // 2 to 4 is not "up 100%", so the percentage is refused under the slice bar.
      changePct:
        m.lastYear >= MIN_SLICE_N
          ? { value: Math.round(((m.thisYear - m.lastYear) / m.lastYear) * 100), n: m.lastYear, enoughData: true }
          : {
              value: null,
              ...insufficient(
                m.lastYear,
                `only ${m.lastYear} inquiries in ${m.label} last year; a percentage change off that base would be noise`,
              ),
            },
      thisYearSpendCents: m.thisYearSpendCents,
      lastYearSpendCents: m.lastYearSpendCents,
    }))

  const years = [...new Set([...perYearMonth.keys()].map((k) => Number(k.split('-')[0])))].sort()

  return {
    metric: 'monthly_volume_yoy',
    battery: 'Q12',
    timezone: slice.timezone,
    focusMonth: focusMonth ? MONTH_LABEL[focusMonth] : null,
    thisYear: yoy.thisYearLabel,
    lastYear: yoy.lastYearLabel,
    monthly,
    everyYearOnRecord: focusMonth
      ? years.map((year) => ({
          year,
          inquiries: { n: perYearMonth.get(`${year}-${focusMonth}`) ?? 0 },
        }))
      : [],
    marketingSpendAvailable: yoy.marketingSpendAvailable,
    marketingNote: yoy.marketingNote,
    caveat: MARKETING_CAVEAT,
    note:
      'One arrival per couple, in the month of its first inbound signal, so a couple who emailed ' +
      'five times moves the count by one. "This year" is anchored to the most recent arrival in ' +
      'the data, not the wall clock, so a paused import does not read as a collapse.',
  }
}

// ---------------------------------------------------------------------------
// Q14 — inquiry-to-tour by season of the event
// ---------------------------------------------------------------------------

const SEASONS = ['spring', 'summer', 'fall', 'winter'] as const
type Season = (typeof SEASONS)[number]

const SEASON_MONTHS: Record<Season, string> = {
  spring: 'March to May',
  summer: 'June to August',
  fall: 'September to November',
  winter: 'December to February',
}

function inquiryToTourBySeason(slice: SpineSlice, today: string, only?: Season) {
  const now = todayMs(today)

  const buckets = new Map<Season, CoupleFacts[]>(SEASONS.map((s) => [s, []]))
  let withoutDate = 0
  for (const f of slice.facts) {
    if (!f.couple.wedding_date) {
      withoutDate++
      continue
    }
    const month = Number(f.couple.wedding_date.slice(5, 7))
    if (!month || month < 1 || month > 12) {
      withoutDate++
      continue
    }
    buckets.get(season(month))?.push(f)
  }

  const wanted = only ? [only] : [...SEASONS]
  const seasons = wanted.map((s) => {
    const group = buckets.get(s) ?? []
    const recent = group.filter((f) => {
      const age = now - Date.parse(f.firstTouchAt)
      return age >= 0 && age <= YEAR_MS
    })
    const previous = group.filter((f) => {
      const age = now - Date.parse(f.firstTouchAt)
      return age > YEAR_MS && age <= 2 * YEAR_MS
    })
    const rateOf = (list: CoupleFacts[], label: string) =>
      honestRate(list.filter((f) => f.toured).length, list.length, MIN_SLICE_N, label)
    const recentRate = rateOf(recent, `${s} couples who inquired in the last year`)
    const priorRate = rateOf(previous, `${s} couples who inquired the year before`)
    const v = verdict(recentRate, priorRate, 'falling', 'rising')
    return {
      season: s[0].toUpperCase() + s.slice(1),
      eventMonths: SEASON_MONTHS[s],
      inquiries: { n: group.length },
      toured: { n: group.filter((f) => f.toured).length },
      inquiryToTour: rateOf(group, `${s} couples`),
      inquiryToBooked: honestRate(
        group.filter((f) => f.booked).length,
        group.length,
        MIN_SLICE_N,
        `${s} couples`,
      ),
      last12Months: recentRate,
      previous12Months: priorRate,
      direction: v.direction,
      change: v.changed,
    }
  })

  return {
    metric: 'inquiry_to_tour_by_season',
    battery: 'Q14',
    timezone: slice.timezone,
    basis:
      'Season of the wedding date, not of the inquiry. A couple who enquired in January for an ' +
      'August wedding is a summer couple here.',
    seasons,
    couplesWithoutWeddingDate: {
      n: withoutDate,
      note: 'No date on record, so they cannot be placed in a season. Excluded from every ratio above.',
    },
    note:
      'A tour counts when the spine has a tour_attended signal or a booking, which implies one. ' +
      'A tour booked and never attended is not a tour.',
  }
}

// ---------------------------------------------------------------------------
// Tool definition
// ---------------------------------------------------------------------------

const METRICS = [
  'response_time_trend',
  'holiday_spike',
  'lead_time',
  'monthly_volume_yoy',
  'inquiry_to_tour_by_season',
] as const
type Metric = (typeof METRICS)[number]

const HOLIDAY_NAMES = HOLIDAYS.map((h) => h.name)

const tool: Anthropic.Tool = {
  name: 'get_time_series',
  description:
    'Trends over time for this venue, computed from the couples and touchpoints spine. Pick one metric:\n' +
    '- response_time_trend: median hours from an inquiry landing to the first venue reply, month by ' +
    'month for the last twelve months, plus the last twelve months against the twelve before them, ' +
    'plus how many inquiries were never replied to.\n' +
    '- holiday_spike: inquiries per day in the seven days after New Year, Valentine\'s, Mother\'s Day ' +
    'and Christmas against the rest of the year, and how that cohort converted.\n' +
    '- lead_time: days from first signal to wedding date, as a median, quartiles and a histogram, with ' +
    'whether it is shortening, lengthening or stable.\n' +
    '- monthly_volume_yoy: inquiry volume by calendar month this year against last year, every year on ' +
    'record for a focused month, and the marketing spend alongside where it exists. Volume only; it ' +
    'cannot tell you why.\n' +
    '- inquiry_to_tour_by_season: inquiry-to-tour ratio grouped by the season of the WEDDING DATE, with ' +
    'the last twelve months against the twelve before.\n' +
    'Every count and rate carries its n and refuses rather than quoting a number off a handful of ' +
    'couples. All five read the full history; there is no date filter.',
  input_schema: {
    type: 'object',
    properties: {
      metric: {
        type: 'string',
        enum: [...METRICS],
        description: 'Which series to compute.',
      },
      month: {
        type: 'integer',
        minimum: 1,
        maximum: 12,
        description:
          'monthly_volume_yoy only. Focus one calendar month, 1 = January. June is 6. Omit for all twelve.',
      },
      season: {
        type: 'string',
        enum: [...SEASONS],
        description:
          'inquiry_to_tour_by_season only. Focus one season of wedding dates. Omit for all four.',
      },
      holiday: {
        type: 'string',
        enum: HOLIDAY_NAMES,
        description: 'holiday_spike only. Focus one holiday. Omit for all of them.',
      },
    },
    required: ['metric'],
    additionalProperties: false,
  },
}

function readMetric(args: Record<string, unknown>): Metric | null {
  const raw = args.metric
  return typeof raw === 'string' && (METRICS as readonly string[]).includes(raw)
    ? (raw as Metric)
    : null
}

export const timeSeriesSource: IntelToolSource = {
  tool,
  subjects: [
    'response time month by month and how it has changed over a year',
    'inquiry volume in the week after a holiday, and whether that cohort converts',
    'booking lead time and whether it is shortening or lengthening',
    'inquiry volume for a calendar month year over year',
    'inquiry-to-tour ratio by the season of the wedding date',
  ],
  // 'Q45' (W67, wave 9): the holiday/seasonal leg of "tours against
  // external context" (W47) — this source already answers the calendar-
  // effect questions (Q7/Q12/Q14) on the inquiry side.
  batteryQuestions: ['Q1', 'Q7', 'Q11', 'Q12', 'Q14', 'Q45'],

  async run(venueId, args, deps: ToolSourceDeps) {
    const metric = readMetric(args)
    if (!metric) {
      return {
        error: `metric is required and must be one of: ${METRICS.join(', ')}.`,
      }
    }
    if (!venueId) {
      return { ...insufficient(0, 'no venue in scope'), metric }
    }

    const slice = await loadSpineSlice(deps.supabase, venueId)

    switch (metric) {
      case 'response_time_trend':
        return responseTimeTrend(slice, deps.today)
      case 'holiday_spike': {
        const only = typeof args.holiday === 'string' ? args.holiday.trim() : undefined
        if (only && !HOLIDAY_NAMES.some((h) => h.toLowerCase() === only.toLowerCase())) {
          return {
            error: `"${only}" is not one of the holidays on record. Available: ${HOLIDAY_NAMES.join(', ')}. Omit the argument for all of them.`,
          }
        }
        return holidaySpike(slice, deps.today, only)
      }
      case 'lead_time':
        return leadTime(slice, deps.today)
      case 'monthly_volume_yoy': {
        const raw = Number(args.month)
        const month = Number.isInteger(raw) && raw >= 1 && raw <= 12 ? raw : undefined
        return monthlyVolumeYoY(slice, deps.supabase, month)
      }
      case 'inquiry_to_tour_by_season': {
        const raw = args.season
        const s =
          typeof raw === 'string' && (SEASONS as readonly string[]).includes(raw)
            ? (raw as Season)
            : undefined
        return inquiryToTourBySeason(slice, deps.today, s)
      }
    }
  },
}
