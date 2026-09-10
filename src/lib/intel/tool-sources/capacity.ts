/**
 * Prime-Saturday capacity and year-over-year booking pace. NOVEMBER-
 * PLAN.md wave 2, W14. Battery Q39.
 *
 * "Prime Saturdays" defaults to May, June, September, October — tunable
 * via `prime_months` since that default is a convention, not a fact the
 * database holds. "Open" = no `weddings` row with status='booked' lands
 * on that date for this venue; a date can still be under active
 * negotiation and count as open, because negotiation is not a hold on
 * the calendar. "Pace" compares bookings signed (weddings.booked_at)
 * from 1 January through today's calendar date this year against the
 * same window last year.
 */
import type { IntelToolSource, ToolSourceDeps } from './types'
import { insufficient } from './types'

const DEFAULT_PRIME_MONTHS = [5, 6, 9, 10]
const DEFAULT_HORIZON_MONTHS = 12
const MAX_HORIZON_MONTHS = 24
/** Below this many bookings across BOTH years combined, a pace
 *  comparison is noise, not a signal. */
const MIN_PACE_SAMPLE = 3
/** Cap on how many open dates are listed in one answer, mirrors
 *  TOUR_NAME_RESOLVE_CAP in tools.ts — the count is never capped, only
 *  the list. */
const MAX_OPEN_DATES_LISTED = 60

interface WeddingDateRow {
  wedding_date: string
}

interface BookedAtRow {
  booked_at: string
}

function addMonthsIso(dateIso: string, months: number): string {
  const d = new Date(`${dateIso}T00:00:00Z`)
  d.setUTCMonth(d.getUTCMonth() + months)
  return d.toISOString().slice(0, 10)
}

/** Every Saturday from `startIso` to `endIso` inclusive whose month is in
 *  `primeMonths` (1-12). */
function saturdaysInRange(startIso: string, endIso: string, primeMonths: readonly number[]): string[] {
  const out: string[] = []
  const monthSet = new Set(primeMonths)
  const end = new Date(`${endIso}T00:00:00Z`)
  const d = new Date(`${startIso}T00:00:00Z`)
  const dow = d.getUTCDay() // 0 = Sunday .. 6 = Saturday
  const offsetToSaturday = (6 - dow + 7) % 7
  d.setUTCDate(d.getUTCDate() + offsetToSaturday)
  while (d.getTime() <= end.getTime()) {
    if (monthSet.has(d.getUTCMonth() + 1)) out.push(d.toISOString().slice(0, 10))
    d.setUTCDate(d.getUTCDate() + 7)
  }
  return out
}

function parsePrimeMonths(args: Record<string, unknown>): number[] {
  const raw = args.prime_months
  if (!Array.isArray(raw) || raw.length === 0) return DEFAULT_PRIME_MONTHS
  const months = raw
    .map((v) => (typeof v === 'number' ? Math.floor(v) : NaN))
    .filter((v) => Number.isInteger(v) && v >= 1 && v <= 12)
  return months.length > 0 ? Array.from(new Set(months)).sort((a, b) => a - b) : DEFAULT_PRIME_MONTHS
}

function parseHorizonMonths(args: Record<string, unknown>): number {
  const raw = args.horizon_months
  if (typeof raw === 'number' && Number.isFinite(raw) && raw > 0 && raw <= MAX_HORIZON_MONTHS) {
    return Math.floor(raw)
  }
  return DEFAULT_HORIZON_MONTHS
}

async function run(
  venueId: string,
  args: Record<string, unknown>,
  deps: ToolSourceDeps,
): Promise<unknown> {
  const primeMonths = parsePrimeMonths(args)
  const horizonMonths = parseHorizonMonths(args)
  const today = deps.today.slice(0, 10)
  const horizonEnd = addMonthsIso(today, horizonMonths)

  const candidateSaturdays = saturdaysInRange(today, horizonEnd, primeMonths)

  const { data: bookedRows, error: bookedErr } = await deps.supabase
    .from('weddings')
    .select('wedding_date')
    .eq('venue_id', venueId)
    .eq('status', 'booked')
    .not('wedding_date', 'is', null)
    .gte('wedding_date', today)
    .lte('wedding_date', horizonEnd)
    .limit(2000)

  if (bookedErr) {
    return { n: 0, enoughData: false, reason: `weddings read failed: ${bookedErr.message}` }
  }

  const bookedDates = new Set(
    ((bookedRows ?? []) as WeddingDateRow[]).map((r) => String(r.wedding_date).slice(0, 10)),
  )
  const openDates = candidateSaturdays.filter((d) => !bookedDates.has(d))
  const bookedPrimeSaturdays = candidateSaturdays.length - openDates.length

  // ---- pace: bookings signed by this calendar date, this year vs last ----
  const [yearStr, monthStr, dayStr] = today.split('-')
  const thisYearStart = `${yearStr}-01-01T00:00:00.000Z`
  const thisYearThroughEnd = `${today}T23:59:59.999Z`
  const lastYear = String(Number(yearStr) - 1)
  const lastYearStart = `${lastYear}-01-01T00:00:00.000Z`
  const lastYearThroughDate = `${lastYear}-${monthStr}-${dayStr}`
  const lastYearThroughEnd = `${lastYearThroughDate}T23:59:59.999Z`

  const [thisYearRes, lastYearRes] = await Promise.all([
    deps.supabase
      .from('weddings')
      .select('booked_at')
      .eq('venue_id', venueId)
      .not('booked_at', 'is', null)
      .gte('booked_at', thisYearStart)
      .lte('booked_at', thisYearThroughEnd)
      .limit(2000),
    deps.supabase
      .from('weddings')
      .select('booked_at')
      .eq('venue_id', venueId)
      .not('booked_at', 'is', null)
      .gte('booked_at', lastYearStart)
      .lte('booked_at', lastYearThroughEnd)
      .limit(2000),
  ])

  const base = {
    primeMonths,
    horizonMonths,
    horizonEnd,
    totalPrimeSaturdays: candidateSaturdays.length,
    bookedPrimeSaturdays,
    openSaturdays: {
      n: openDates.length,
      dates: openDates.slice(0, MAX_OPEN_DATES_LISTED),
      truncated: openDates.length > MAX_OPEN_DATES_LISTED,
    },
  }

  if (thisYearRes.error || lastYearRes.error) {
    return {
      n: candidateSaturdays.length,
      enoughData: true,
      ...base,
      pace: insufficient(
        0,
        `booked_at read failed: ${thisYearRes.error?.message ?? lastYearRes.error?.message}`,
      ),
    }
  }

  const thisYearN = ((thisYearRes.data ?? []) as BookedAtRow[]).length
  const lastYearN = ((lastYearRes.data ?? []) as BookedAtRow[]).length
  const paceTotal = thisYearN + lastYearN

  const pace =
    paceTotal < MIN_PACE_SAMPLE
      ? insufficient(
          paceTotal,
          `fewer than ${MIN_PACE_SAMPLE} bookings recorded across both years to compare pace`,
        )
      : {
          n: paceTotal,
          enoughData: true,
          thisYear: { n: thisYearN, through: today },
          lastYear: { n: lastYearN, through: lastYearThroughDate },
          delta: thisYearN - lastYearN,
          aheadOfLastYear: thisYearN > lastYearN,
        }

  return {
    n: candidateSaturdays.length,
    enoughData: true,
    ...base,
    pace,
  }
}

export const capacityToolSource: IntelToolSource = {
  tool: {
    name: 'get_prime_saturday_capacity',
    description:
      'Prime Saturdays (May, June, September and October by default, tunable) in the months ahead ' +
      '(12 by default, tunable): which dates have no booked wedding for this venue yet, and how this ' +
      "year's booking pace compares to bookings signed by the same calendar date last year. 'Open' " +
      'means no wedding with status=booked lands on that date; a date under active negotiation still ' +
      'counts as open. Use this for capacity questions ("which Saturdays are still open") and pacing ' +
      'questions ("am I ahead of last year").',
    input_schema: {
      type: 'object',
      properties: {
        prime_months: {
          type: 'array',
          items: { type: 'number' },
          description:
            'Month numbers (1-12) that count as prime season. Defaults to [5, 6, 9, 10] ' +
            '(May, June, September, October).',
        },
        horizon_months: {
          type: 'number',
          description: 'How many months ahead to look for open Saturdays. Defaults to 12.',
        },
      },
      additionalProperties: false,
    },
  },
  subjects: [
    'open Saturdays',
    'prime-season availability',
    'booking pace versus last year',
    'which dates are still open',
  ],
  batteryQuestions: ['39'],
  run,
}
