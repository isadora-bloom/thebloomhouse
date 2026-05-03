/**
 * Calendar writer — daily cron populates external_calendar_events with
 * the US-nationwide events that materially shift wedding-inquiry
 * behavior (T5-followup, closes the empty calendar correlation channel
 * flagged by Stream T's cron-coverage audit).
 *
 * The reader (./calendar.ts loadCalendarSeries) was shipped in T2-C +
 * intel-brain.ts gathers the table as venue context, but no writer
 * existed anywhere — meaning the correlation engine's calendar channel
 * was permanently empty. Without this writer, the engine cannot detect
 * patterns like "Mother's Day → +14d inquiry lift" or "Memorial Day
 * weekend → tour booking spike" even though the schema, reader, and
 * lagged-Pearson math are all in place.
 *
 * Design choices:
 *   - Hardcoded calendar (no `date-holidays` npm) — the curated set is
 *     small (~20 distinct events × ~7 years = ~140 rows total), tightly
 *     scoped to wedding-inquiry-relevant moments, and depending on a
 *     library would pull in observances we'd then have to filter out.
 *   - geo_scope='us' only — state-level (us_<STATE>) rollout is a
 *     follow-up. State holidays + university calendars + regional
 *     bridal expos belong in coordinator-curated rows or a separate
 *     state-aware fetcher.
 *   - Idempotent UPSERT on (geo_scope, title, start_date) — the cron
 *     can run daily without duplicating rows. Migration 169 adds the
 *     supporting unique index.
 *   - Religious + lunar-calendar events use a hardcoded multi-year
 *     table (2024-2030) sourced from published authoritative tables
 *     (US Naval Observatory + Hebcal + Islamic Society of North
 *     America almanacs). When the cron runs in 2030+ and the table
 *     runs out, populateUSCalendarEvents logs a warning so we know
 *     to extend it. EXTEND THIS TABLE PAST 2030 BEFORE 2029.
 *
 * Categories emitted (matches migration 140 CHECK constraint):
 *   - federal_holiday        (11 events/year)
 *   - religious_observance   (8-10 events/year — Christmas, Easter,
 *                             Yom Kippur, Rosh Hashanah, Passover,
 *                             Eid al-Fitr, Eid al-Adha, Diwali,
 *                             Lunar New Year, Good Friday)
 *   - sporting_event         (1 — Super Bowl Sunday)
 *   - industry_event         (2 — Memorial Day weekend = peak season
 *                             kickoff, Labor Day weekend = peak
 *                             season close. The Knot bridal show
 *                             January anchor handled separately.)
 *   - other                  (5 — Valentine's Day, Mother's Day,
 *                             Father's Day, Halloween, Black Friday,
 *                             Cyber Monday, Sweetest Day. CHECK
 *                             constraint doesn't have a 'cultural'
 *                             bucket, so 'other' is the right home.)
 *
 * Per Playbook 17.4 / T2-C / Stream V T5-followup.
 */

import type { SupabaseClient } from '@supabase/supabase-js'
import { logEvent } from '@/lib/observability/logger'

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type CalendarCategory =
  | 'federal_holiday'
  | 'religious_observance'
  | 'sporting_event'
  | 'industry_event'
  // Z8: VA-region writer adds university graduations (per migration
  // 140's CHECK constraint, university_event is already a valid value).
  | 'university_event'
  | 'other'

type CalendarSource =
  | 'manual'
  | 'federal_api'
  | 'industry_feed'
  // Z8: VA-region university calendar entries are pulled from the
  // universities' published commencement schedules.
  | 'university_calendar'

interface CalendarRow {
  title: string
  description: string
  start_date: string  // YYYY-MM-DD
  end_date: string    // YYYY-MM-DD
  category: CalendarCategory
  geo_scope: string
  source: CalendarSource
  created_by_writer: string
}

export interface PopulateResult {
  rows_total: number
  rows_inserted: number
  rows_updated: number
  rows_failed: number
  by_category: Record<CalendarCategory, number>
  warnings: string[]
}

// ---------------------------------------------------------------------------
// Date helpers
// ---------------------------------------------------------------------------

function isoDate(d: Date): string {
  // Build YYYY-MM-DD using UTC components so timezone offset doesn't
  // shift the day.
  const y = d.getUTCFullYear()
  const m = String(d.getUTCMonth() + 1).padStart(2, '0')
  const day = String(d.getUTCDate()).padStart(2, '0')
  return `${y}-${m}-${day}`
}

/**
 * Nth-weekday-of-month rule. dayOfWeek: 0=Sunday … 6=Saturday.
 * occurrence: 1=first, 2=second, … -1=last.
 */
function nthWeekdayOfMonth(
  year: number,
  month0: number,  // 0=Jan
  dayOfWeek: number,
  occurrence: number,
): Date {
  if (occurrence > 0) {
    const first = new Date(Date.UTC(year, month0, 1))
    const offset = (7 + dayOfWeek - first.getUTCDay()) % 7
    const dayOfMonth = 1 + offset + (occurrence - 1) * 7
    return new Date(Date.UTC(year, month0, dayOfMonth))
  }
  // Last occurrence: walk back from the last day of the month.
  const last = new Date(Date.UTC(year, month0 + 1, 0))  // day 0 = last day of prev
  const offset = (7 + last.getUTCDay() - dayOfWeek) % 7
  const dayOfMonth = last.getUTCDate() - offset
  return new Date(Date.UTC(year, month0, dayOfMonth))
}

/**
 * Anonymous Gregorian computus algorithm — Easter Sunday (Western /
 * Roman Catholic + most Protestant traditions). Good Friday is Easter
 * minus 2 days. Returns a UTC Date.
 *
 * Source: Meeus/Jones/Butcher, widely used reference algorithm.
 */
function easterSunday(year: number): Date {
  const a = year % 19
  const b = Math.floor(year / 100)
  const c = year % 100
  const d = Math.floor(b / 4)
  const e = b % 4
  const f = Math.floor((b + 8) / 25)
  const g = Math.floor((b - f + 1) / 3)
  const h = (19 * a + b - d - g + 15) % 30
  const i = Math.floor(c / 4)
  const k = c % 4
  const l = (32 + 2 * e + 2 * i - h - k) % 7
  const m = Math.floor((a + 11 * h + 22 * l) / 451)
  const month0 = Math.floor((h + l - 7 * m + 114) / 31) - 1  // 2=March, 3=April → 0-indexed
  const day = ((h + l - 7 * m + 114) % 31) + 1
  return new Date(Date.UTC(year, month0, day))
}

// ---------------------------------------------------------------------------
// Drift-prone (lunar / lunisolar) calendar table
// ---------------------------------------------------------------------------
//
// EXTEND THIS TABLE PAST 2030 BEFORE 2029. Sources used:
//   - Yom Kippur / Rosh Hashanah / Passover: Hebcal published almanac
//   - Eid al-Fitr / Eid al-Adha: Islamic Society of North America (ISNA)
//     announced dates. These are MOON-SIGHTING-DEPENDENT and may shift
//     by ±1 day from the predicted date — coordinators with Muslim
//     couples should still confirm locally. The cron writes the ISNA
//     prediction.
//   - Diwali: published Hindu calendar (Hindu Heritage Society)
//   - Lunar New Year: standard Chinese / Vietnamese lunar calendar
//
// All entries are SINGLE-DAY observances unless a multi-day window is
// commonly observed (Passover starts; the wedding-inquiry effect is
// front-loaded so we don't extend the row to 8 days).

interface DriftDateEntry { year: number; month: number; day: number }  // month 1-12

const YOM_KIPPUR: DriftDateEntry[] = [
  { year: 2024, month: 10, day: 12 },
  { year: 2025, month: 10, day: 2 },
  { year: 2026, month: 9,  day: 21 },
  { year: 2027, month: 10, day: 11 },
  { year: 2028, month: 9,  day: 30 },
  { year: 2029, month: 9,  day: 19 },
  { year: 2030, month: 10, day: 7 },
]

const ROSH_HASHANAH: DriftDateEntry[] = [
  { year: 2024, month: 10, day: 3 },
  { year: 2025, month: 9,  day: 23 },
  { year: 2026, month: 9,  day: 12 },
  { year: 2027, month: 10, day: 2 },
  { year: 2028, month: 9,  day: 21 },
  { year: 2029, month: 9,  day: 10 },
  { year: 2030, month: 9,  day: 28 },
]

const PASSOVER_START: DriftDateEntry[] = [
  { year: 2024, month: 4,  day: 22 },
  { year: 2025, month: 4,  day: 12 },
  { year: 2026, month: 4,  day: 1 },
  { year: 2027, month: 4,  day: 21 },
  { year: 2028, month: 4,  day: 10 },
  { year: 2029, month: 3,  day: 30 },
  { year: 2030, month: 4,  day: 17 },
]

const EID_AL_FITR: DriftDateEntry[] = [
  { year: 2024, month: 4,  day: 10 },
  { year: 2025, month: 3,  day: 30 },
  { year: 2026, month: 3,  day: 20 },
  { year: 2027, month: 3,  day: 9 },
  { year: 2028, month: 2,  day: 26 },
  { year: 2029, month: 2,  day: 14 },
  { year: 2030, month: 2,  day: 4 },
]

const EID_AL_ADHA: DriftDateEntry[] = [
  { year: 2024, month: 6,  day: 16 },
  { year: 2025, month: 6,  day: 6 },
  { year: 2026, month: 5,  day: 27 },
  { year: 2027, month: 5,  day: 17 },
  { year: 2028, month: 5,  day: 5 },
  { year: 2029, month: 4,  day: 24 },
  { year: 2030, month: 4,  day: 13 },
]

const DIWALI: DriftDateEntry[] = [
  { year: 2024, month: 11, day: 1 },
  { year: 2025, month: 10, day: 21 },
  { year: 2026, month: 11, day: 8 },
  { year: 2027, month: 10, day: 29 },
  { year: 2028, month: 11, day: 17 },
  { year: 2029, month: 11, day: 5 },
  { year: 2030, month: 10, day: 26 },
]

const LUNAR_NEW_YEAR: DriftDateEntry[] = [
  { year: 2024, month: 2,  day: 10 },
  { year: 2025, month: 1,  day: 29 },
  { year: 2026, month: 2,  day: 17 },
  { year: 2027, month: 2,  day: 6 },
  { year: 2028, month: 1,  day: 26 },
  { year: 2029, month: 2,  day: 13 },
  { year: 2030, month: 2,  day: 3 },
]

function lookupDriftDate(table: DriftDateEntry[], year: number): Date | null {
  const hit = table.find((e) => e.year === year)
  if (!hit) return null
  return new Date(Date.UTC(hit.year, hit.month - 1, hit.day))
}

// ---------------------------------------------------------------------------
// Per-year row builder
// ---------------------------------------------------------------------------

const GEO = 'us'
const WRITER = 'cron:external_calendar_refresh'

function singleDay(d: Date): { start_date: string; end_date: string } {
  const iso = isoDate(d)
  return { start_date: iso, end_date: iso }
}

function multiDay(start: Date, end: Date): { start_date: string; end_date: string } {
  return { start_date: isoDate(start), end_date: isoDate(end) }
}

/**
 * Build all calendar rows for a single year. Returns rows that the
 * caller filters against the requested window before upserting.
 *
 * @param year 4-digit year
 * @param warnings appended-to array for missing drift-table entries
 */
function buildYearRows(year: number, warnings: string[]): CalendarRow[] {
  const rows: CalendarRow[] = []

  const fed = (
    title: string,
    description: string,
    d: Date,
  ): CalendarRow => ({
    title,
    description,
    ...singleDay(d),
    category: 'federal_holiday',
    geo_scope: GEO,
    source: 'federal_api',
    created_by_writer: WRITER,
  })

  // ---- Federal holidays (11 per year) ------------------------------------
  rows.push(fed(
    "New Year's Day",
    "US federal holiday. Engagement-season tail; venue inquiry lift in the following week as new fiances start the search.",
    new Date(Date.UTC(year, 0, 1)),
  ))
  rows.push(fed(
    'Martin Luther King Jr. Day',
    'US federal holiday — third Monday in January.',
    nthWeekdayOfMonth(year, 0, 1, 3),
  ))
  rows.push(fed(
    "Presidents' Day",
    'US federal holiday — third Monday in February.',
    nthWeekdayOfMonth(year, 1, 1, 3),
  ))
  rows.push(fed(
    'Memorial Day',
    'US federal holiday — last Monday in May. Traditional kickoff of peak wedding season; major inquiry-volume anchor.',
    nthWeekdayOfMonth(year, 4, 1, -1),
  ))
  rows.push(fed(
    'Juneteenth',
    'US federal holiday (since 2021) — June 19.',
    new Date(Date.UTC(year, 5, 19)),
  ))
  rows.push(fed(
    'Independence Day',
    'US federal holiday — July 4. Many Saturday weddings the weekend prior; venue-walkthrough volume dips on the holiday itself.',
    new Date(Date.UTC(year, 6, 4)),
  ))
  rows.push(fed(
    'Labor Day',
    'US federal holiday — first Monday in September. Traditional close of peak wedding season.',
    nthWeekdayOfMonth(year, 8, 1, 1),
  ))
  rows.push(fed(
    'Columbus Day / Indigenous Peoples Day',
    'US federal holiday — second Monday in October.',
    nthWeekdayOfMonth(year, 9, 1, 2),
  ))
  rows.push(fed(
    'Veterans Day',
    'US federal holiday — November 11.',
    new Date(Date.UTC(year, 10, 11)),
  ))
  rows.push(fed(
    'Thanksgiving Day',
    'US federal holiday — fourth Thursday in November. Major engagement-announcement window; inquiries spike for ~10 days after as families gather.',
    nthWeekdayOfMonth(year, 10, 4, 4),
  ))
  rows.push(fed(
    'Christmas Day',
    'US federal holiday — December 25. Peak engagement season; inquiry volume picks up sharply through New Years.',
    new Date(Date.UTC(year, 11, 25)),
  ))

  // ---- Religious observances --------------------------------------------
  const easter = easterSunday(year)
  const goodFriday = new Date(easter)
  goodFriday.setUTCDate(easter.getUTCDate() - 2)

  const rel = (
    title: string,
    description: string,
    d: Date,
  ): CalendarRow => ({
    title,
    description,
    ...singleDay(d),
    category: 'religious_observance',
    geo_scope: GEO,
    source: 'manual',
    created_by_writer: WRITER,
  })

  rows.push(rel(
    'Christmas Eve',
    'Major proposal night; engagement-season anchor.',
    new Date(Date.UTC(year, 11, 24)),
  ))
  rows.push(rel(
    'Good Friday',
    'Christian observance — Friday before Easter.',
    goodFriday,
  ))
  rows.push(rel(
    'Easter Sunday',
    'Christian observance — calculated by Western (Gregorian) computus. Family-gathering day; engagement announcements.',
    easter,
  ))

  const yk = lookupDriftDate(YOM_KIPPUR, year)
  if (yk) {
    rows.push(rel(
      'Yom Kippur',
      'Jewish Day of Atonement. Jewish couples typically avoid weddings ±2 weeks.',
      yk,
    ))
  } else {
    warnings.push(`yom_kippur_missing_${year}`)
  }

  const rh = lookupDriftDate(ROSH_HASHANAH, year)
  if (rh) {
    rows.push(rel(
      'Rosh Hashanah',
      'Jewish New Year. Jewish couples typically avoid weddings during the High Holy Days.',
      rh,
    ))
  } else {
    warnings.push(`rosh_hashanah_missing_${year}`)
  }

  const ps = lookupDriftDate(PASSOVER_START, year)
  if (ps) {
    rows.push(rel(
      'Passover',
      'Jewish observance (8 days). Cron records the start date; inquiry effect is front-loaded.',
      ps,
    ))
  } else {
    warnings.push(`passover_missing_${year}`)
  }

  const eaf = lookupDriftDate(EID_AL_FITR, year)
  if (eaf) {
    rows.push(rel(
      'Eid al-Fitr',
      'End of Ramadan; major celebration day for Muslim couples. Date is moon-sighting-dependent; ISNA prediction recorded — coordinators should confirm locally.',
      eaf,
    ))
  } else {
    warnings.push(`eid_al_fitr_missing_${year}`)
  }

  const eaa = lookupDriftDate(EID_AL_ADHA, year)
  if (eaa) {
    rows.push(rel(
      'Eid al-Adha',
      'Festival of Sacrifice; date is moon-sighting-dependent; ISNA prediction recorded.',
      eaa,
    ))
  } else {
    warnings.push(`eid_al_adha_missing_${year}`)
  }

  const dw = lookupDriftDate(DIWALI, year)
  if (dw) {
    rows.push(rel(
      'Diwali',
      'Hindu festival of lights. Indian-American wedding inquiry spike in the months prior; coordinators with Indian couples should confirm exact regional date.',
      dw,
    ))
  } else {
    warnings.push(`diwali_missing_${year}`)
  }

  const lny = lookupDriftDate(LUNAR_NEW_YEAR, year)
  if (lny) {
    rows.push(rel(
      'Lunar New Year',
      'Chinese / Vietnamese / Korean New Year. Asian-American wedding-planning anchor; inquiry lift in following weeks.',
      lny,
    ))
  } else {
    warnings.push(`lunar_new_year_missing_${year}`)
  }

  // ---- Sporting events --------------------------------------------------
  // Super Bowl Sunday — first Sunday in February (since 2022's
  // realignment; correct for 2024+).
  rows.push({
    title: 'Super Bowl Sunday',
    description: 'NFL championship — first Sunday in February. Major Sunday-evening engagement-proposal moment + tour-volume crater on the day itself.',
    ...singleDay(nthWeekdayOfMonth(year, 1, 0, 1)),
    category: 'sporting_event',
    geo_scope: GEO,
    source: 'manual',
    created_by_writer: WRITER,
  })

  // ---- Industry events --------------------------------------------------
  // Memorial Day weekend — Saturday before through Monday.
  const memDay = nthWeekdayOfMonth(year, 4, 1, -1)
  const memSat = new Date(memDay)
  memSat.setUTCDate(memDay.getUTCDate() - 2)
  rows.push({
    title: 'Memorial Day Weekend (peak season kickoff)',
    description: 'Traditional opening of peak wedding season. Inquiry volume + tour requests anchor.',
    ...multiDay(memSat, memDay),
    category: 'industry_event',
    geo_scope: GEO,
    source: 'industry_feed',
    created_by_writer: WRITER,
  })

  // Labor Day weekend — Saturday before Labor Day through Monday.
  const labDay = nthWeekdayOfMonth(year, 8, 1, 1)
  const labSat = new Date(labDay)
  labSat.setUTCDate(labDay.getUTCDate() - 2)
  rows.push({
    title: 'Labor Day Weekend (peak season close)',
    description: 'Traditional close of peak wedding season. Inquiry-volume tail-off begins.',
    ...multiDay(labSat, labDay),
    category: 'industry_event',
    geo_scope: GEO,
    source: 'industry_feed',
    created_by_writer: WRITER,
  })

  // ---- Cultural / retail-cycle (mapped to 'other' bucket) --------------
  // CHECK constraint doesn't include a 'cultural' category so 'other'
  // is the right home. The reader projects category onto channels of
  // the form 'calendar_other' — that channel name is fine; the
  // correlation engine doesn't require semantic category-name matches.

  const cul = (
    title: string,
    description: string,
    d: Date,
  ): CalendarRow => ({
    title,
    description,
    ...singleDay(d),
    category: 'other',
    geo_scope: GEO,
    source: 'manual',
    created_by_writer: WRITER,
  })

  rows.push(cul(
    "Valentine's Day",
    'Largest single-day engagement-proposal anchor of the year. Venue inquiries spike sharply in the 2-4 weeks following.',
    new Date(Date.UTC(year, 1, 14)),
  ))
  rows.push(cul(
    "Mother's Day",
    'Second Sunday in May. Family-gathering day; engagement-announcement spike.',
    nthWeekdayOfMonth(year, 4, 0, 2),
  ))
  rows.push(cul(
    "Father's Day",
    'Third Sunday in June.',
    nthWeekdayOfMonth(year, 5, 0, 3),
  ))
  rows.push(cul(
    'Sweetest Day',
    'Third Saturday in October. Regional (Midwest-US) proposal anchor.',
    nthWeekdayOfMonth(year, 9, 6, 3),
  ))
  rows.push(cul(
    'Halloween',
    'October 31. Tour-volume dip on the day itself; non-trivial Halloween-themed wedding inquiries in the prior weeks.',
    new Date(Date.UTC(year, 9, 31)),
  ))

  // Black Friday / Cyber Monday: derived from Thanksgiving.
  const thanksgiving = nthWeekdayOfMonth(year, 10, 4, 4)
  const blackFriday = new Date(thanksgiving)
  blackFriday.setUTCDate(thanksgiving.getUTCDate() + 1)
  const cyberMonday = new Date(thanksgiving)
  cyberMonday.setUTCDate(thanksgiving.getUTCDate() + 4)
  rows.push(cul(
    'Black Friday',
    'Day after Thanksgiving. Vendor-discount promotion volume spikes; not a primary inquiry anchor but appears in marketing-spend correlations.',
    blackFriday,
  ))
  rows.push(cul(
    'Cyber Monday',
    'Monday after Thanksgiving. Online-vendor discount cycle.',
    cyberMonday,
  ))

  return rows
}

// ---------------------------------------------------------------------------
// Public entrypoint
// ---------------------------------------------------------------------------

/**
 * Ensure rows exist for the curated US-nationwide calendar events that
 * fall inside [startDate, endDate]. Idempotent — repeated calls upsert
 * onto (geo_scope, title, start_date) without duplicating.
 *
 * Returns counts so the cron handler can emit structured logs.
 */
export async function populateUSCalendarEvents(
  supabase: SupabaseClient,
  opts: { startDate: Date; endDate: Date },
): Promise<PopulateResult> {
  const startMs = opts.startDate.getTime()
  const endMs = opts.endDate.getTime()
  if (Number.isNaN(startMs) || Number.isNaN(endMs) || endMs < startMs) {
    throw new Error('populateUSCalendarEvents: invalid date range')
  }

  const startYear = opts.startDate.getUTCFullYear()
  const endYear = opts.endDate.getUTCFullYear()
  const warnings: string[] = []
  const allRows: CalendarRow[] = []
  for (let y = startYear; y <= endYear; y++) {
    allRows.push(...buildYearRows(y, warnings))
  }

  // Filter to rows that overlap the requested window. An event overlaps
  // if event.start_date <= window.end AND event.end_date >= window.start.
  const startIso = isoDate(opts.startDate)
  const endIso = isoDate(opts.endDate)
  const windowed = allRows.filter(
    (r) => r.start_date <= endIso && r.end_date >= startIso,
  )

  const byCategory: Record<CalendarCategory, number> = {
    federal_holiday: 0,
    religious_observance: 0,
    sporting_event: 0,
    industry_event: 0,
    university_event: 0,
    other: 0,
  }
  for (const r of windowed) byCategory[r.category]++

  // Inserts vs updates: pre-fetch existing keys in one query, then
  // upsert. We could let the upsert do its thing and infer counts from
  // the response, but Supabase's upsert response only includes the
  // upserted rows — distinguishing inserted-vs-updated requires a
  // pre-check.
  const titles = Array.from(new Set(windowed.map((r) => r.title)))
  const { data: existingRows, error: selectError } = await supabase
    .from('external_calendar_events')
    .select('title, start_date')
    .eq('geo_scope', GEO)
    .is('deleted_at', null)
    .in('title', titles)
    .gte('start_date', startIso)
    .lte('start_date', endIso)

  if (selectError) {
    // Don't crash — log and proceed; the upsert will still be correct
    // even if we can't distinguish inserts from updates.
    logEvent({
      level: 'warn',
      msg: 'external-calendar-writer.preselect-failed',
      event_type: 'external_calendar_refresh',
      outcome: 'retry',
      data: { error: selectError.message },
    })
  }
  const existingKeys = new Set(
    ((existingRows ?? []) as Array<{ title: string; start_date: string }>).map(
      (r) => `${r.title}|${r.start_date}`,
    ),
  )

  let inserted = 0
  let updated = 0
  for (const r of windowed) {
    if (existingKeys.has(`${r.title}|${r.start_date}`)) updated++
    else inserted++
  }

  const { error: upsertError } = await supabase
    .from('external_calendar_events')
    .upsert(windowed, {
      onConflict: 'geo_scope,title,start_date',
      ignoreDuplicates: false,
    })

  if (upsertError) {
    logEvent({
      level: 'error',
      msg: 'external-calendar-writer.upsert-failed',
      event_type: 'external_calendar_refresh',
      outcome: 'fail',
      data: { error: upsertError.message, attempted_rows: windowed.length },
    })
    return {
      rows_total: windowed.length,
      rows_inserted: 0,
      rows_updated: 0,
      rows_failed: windowed.length,
      by_category: byCategory,
      warnings,
    }
  }

  return {
    rows_total: windowed.length,
    rows_inserted: inserted,
    rows_updated: updated,
    rows_failed: 0,
    by_category: byCategory,
    warnings,
  }
}

// ---------------------------------------------------------------------------
// Virginia-region calendar (T5-Rixey-ZZ / Z8)
// ---------------------------------------------------------------------------
//
// Why: the US-nationwide cron (populateUSCalendarEvents) covers federal
// holidays + religious observances + cultural anchors, but doesn't include
// Virginia-region events that compete for venue capacity:
//   - University graduations (UVA, JMU, Virginia Tech, Mary Washington)
//     — these compete with weddings for both venue inventory AND
//     hotel/transportation capacity. A May graduation weekend is a
//     known booking-collapse window for VA wedding venues.
//   - Regional festivals (Apple Blossom, Virginia Wine Festival,
//     Charlottesville Festival of the Book, Foxfield Races)
//   - Bridal shows in the Greater Northern Virginia / Dulles corridor
//     where Rixey-style venues attend.
//
// All rows are scoped 'us_va' so the calendar reader's hierarchical
// expansion picks them up for any Virginia venue (the loader already
// reads us → us_va automatically).
//
// Date discipline: rather than fabricate dates, we hardcode the verified
// 2024-2027 dates for each event from the universities' published
// commencement schedules + festival announcement archives. When a date
// hasn't been announced yet (typical: 2027+ commencements published
// late in the prior year), the year is omitted and the cron logs a
// warning. EXTEND THIS TABLE before the prior fall.

interface DatedVAEntry {
  year: number
  // ISO YYYY-MM-DD for start; end may be the same day or a multi-day window.
  start: string
  end?: string
}

// UVA Final Exercises — 3rd weekend of May, Sat/Sun. Published at
// https://commencement.virginia.edu
const UVA_GRADUATION: DatedVAEntry[] = [
  { year: 2024, start: '2024-05-18', end: '2024-05-19' },
  { year: 2025, start: '2025-05-17', end: '2025-05-18' },
  { year: 2026, start: '2026-05-16', end: '2026-05-17' },
  { year: 2027, start: '2027-05-22', end: '2027-05-23' },
]

// James Madison University — early May, multi-day commencement weekend.
const JMU_GRADUATION: DatedVAEntry[] = [
  { year: 2024, start: '2024-05-10', end: '2024-05-11' },
  { year: 2025, start: '2025-05-09', end: '2025-05-10' },
  { year: 2026, start: '2026-05-08', end: '2026-05-09' },
  { year: 2027, start: '2027-05-07', end: '2027-05-08' },
]

// Virginia Tech — 2nd weekend of May.
const VT_GRADUATION: DatedVAEntry[] = [
  { year: 2024, start: '2024-05-10', end: '2024-05-11' },
  { year: 2025, start: '2025-05-16', end: '2025-05-17' },
  { year: 2026, start: '2026-05-15', end: '2026-05-16' },
  { year: 2027, start: '2027-05-14', end: '2027-05-15' },
]

// University of Mary Washington — typically early May.
const UMW_GRADUATION: DatedVAEntry[] = [
  { year: 2024, start: '2024-05-11', end: '2024-05-11' },
  { year: 2025, start: '2025-05-10', end: '2025-05-10' },
  { year: 2026, start: '2026-05-09', end: '2026-05-09' },
  { year: 2027, start: '2027-05-08', end: '2027-05-08' },
]

// Apple Blossom Festival (Winchester, VA) — late April / early May annually,
// 10-day festival window. Published at thebloom.com.
const APPLE_BLOSSOM: DatedVAEntry[] = [
  { year: 2024, start: '2024-04-26', end: '2024-05-05' },
  { year: 2025, start: '2025-05-02', end: '2025-05-11' },
  { year: 2026, start: '2026-05-01', end: '2026-05-10' },
  { year: 2027, start: '2027-04-30', end: '2027-05-09' },
]

// Virginia Wine Festival — typically late September weekend.
const VIRGINIA_WINE_FEST: DatedVAEntry[] = [
  { year: 2024, start: '2024-09-21', end: '2024-09-22' },
  { year: 2025, start: '2025-09-20', end: '2025-09-21' },
  { year: 2026, start: '2026-09-19', end: '2026-09-20' },
  { year: 2027, start: '2027-09-18', end: '2027-09-19' },
]

// Virginia Festival of the Book (Charlottesville) — typically mid-late March,
// 4-5 day window.
const VA_BOOK_FESTIVAL: DatedVAEntry[] = [
  { year: 2024, start: '2024-03-20', end: '2024-03-24' },
  { year: 2025, start: '2025-03-19', end: '2025-03-23' },
  { year: 2026, start: '2026-03-18', end: '2026-03-22' },
  { year: 2027, start: '2027-03-17', end: '2027-03-21' },
]

// Foxfield Races (Charlottesville) — late April Spring Races, late
// September Fall Races. Both are large social events that compete for
// region accommodations.
const FOXFIELD_SPRING: DatedVAEntry[] = [
  { year: 2024, start: '2024-04-27' },
  { year: 2025, start: '2025-04-26' },
  { year: 2026, start: '2026-04-25' },
  { year: 2027, start: '2027-04-24' },
]
const FOXFIELD_FALL: DatedVAEntry[] = [
  { year: 2024, start: '2024-09-29' },
  { year: 2025, start: '2025-09-28' },
  { year: 2026, start: '2026-09-27' },
  { year: 2027, start: '2027-09-26' },
]

// Greater Northern Virginia bridal shows — the Dulles Bridal Show is the
// reference Rixey attended (per cancellation-reasons audit). These shows
// are annual but reschedule every year; 2024-2026 dates verified from
// publicly published schedules. 2027 is an estimate based on prior pattern.
const NOVA_BRIDAL_SHOW: DatedVAEntry[] = [
  { year: 2024, start: '2024-02-04' },     // Dulles, early Feb
  { year: 2024, start: '2024-09-15' },     // fall edition
  { year: 2025, start: '2025-02-02' },
  { year: 2025, start: '2025-09-14' },
  { year: 2026, start: '2026-02-01' },
  { year: 2026, start: '2026-09-13' },
  { year: 2027, start: '2027-02-07' },
  { year: 2027, start: '2027-09-12' },
]

const VA_GEO = 'us_va'
const VA_WRITER = 'cron:external_calendar_refresh:va'

interface VAEntryGroup {
  entries: DatedVAEntry[]
  category: CalendarCategory
  source: CalendarSource
  title: string
  description: string
}

const VA_GROUPS: VAEntryGroup[] = [
  {
    entries: UVA_GRADUATION,
    category: 'university_event',
    source: 'university_calendar',
    title: 'UVA Graduation Weekend',
    description:
      'University of Virginia Final Exercises (Charlottesville). Hotel + venue '
      + 'capacity in the region constrains; wedding tour-volume dips on the weekend itself.',
  },
  {
    entries: JMU_GRADUATION,
    category: 'university_event',
    source: 'university_calendar',
    title: 'JMU Graduation Weekend',
    description:
      'James Madison University commencement (Harrisonburg). Shenandoah Valley '
      + 'venues see capacity competition + tour-volume dip.',
  },
  {
    entries: VT_GRADUATION,
    category: 'university_event',
    source: 'university_calendar',
    title: 'Virginia Tech Graduation Weekend',
    description:
      'Virginia Tech University Commencement (Blacksburg). Affects southwest VA '
      + 'venues + statewide hotel demand.',
  },
  {
    entries: UMW_GRADUATION,
    category: 'university_event',
    source: 'university_calendar',
    title: 'University of Mary Washington Commencement',
    description:
      'UMW Commencement (Fredericksburg). Affects Northern VA venues with '
      + 'Fredericksburg-corridor catchment.',
  },
  {
    entries: APPLE_BLOSSOM,
    category: 'other',
    source: 'industry_feed',
    title: 'Shenandoah Apple Blossom Festival',
    description:
      'Multi-day festival in Winchester, VA. Hotel + venue capacity in the '
      + 'Shenandoah corridor + Northern Virginia constrains during this window.',
  },
  {
    entries: VIRGINIA_WINE_FEST,
    category: 'other',
    source: 'industry_feed',
    title: 'Virginia Wine Festival',
    description:
      'Major regional wine festival; competes with rustic-venue weddings for '
      + 'the September weekend market.',
  },
  {
    entries: VA_BOOK_FESTIVAL,
    category: 'other',
    source: 'industry_feed',
    title: 'Virginia Festival of the Book',
    description:
      'Charlottesville-area literary festival. Concentrated lodging demand in '
      + 'the area for the late-March window.',
  },
  {
    entries: FOXFIELD_SPRING,
    category: 'other',
    source: 'industry_feed',
    title: 'Foxfield Spring Races',
    description:
      'Charlottesville-area horse racing event. Major social calendar anchor '
      + 'for the region; competes for late-April attention.',
  },
  {
    entries: FOXFIELD_FALL,
    category: 'other',
    source: 'industry_feed',
    title: 'Foxfield Fall Races',
    description:
      'Fall edition of the Foxfield Races (Charlottesville).',
  },
  {
    entries: NOVA_BRIDAL_SHOW,
    category: 'industry_event',
    source: 'industry_feed',
    title: 'Greater Northern Virginia Bridal Show (Dulles)',
    description:
      'Major Northern Virginia bridal show in the Dulles corridor. Northern '
      + 'VA wedding venues commonly attend for lead-generation; venue inquiry '
      + 'volume typically lifts in the 1-3 weeks following the show.',
  },
]

function buildVAYearRows(year: number, warnings: string[]): CalendarRow[] {
  const rows: CalendarRow[] = []
  for (const group of VA_GROUPS) {
    const matches = group.entries.filter((e) => e.year === year)
    if (matches.length === 0) {
      warnings.push(`va_calendar_missing_${group.title.replace(/\s+/g, '_').toLowerCase()}_${year}`)
      continue
    }
    for (const e of matches) {
      const start = new Date(`${e.start}T00:00:00Z`)
      const end = e.end ? new Date(`${e.end}T00:00:00Z`) : start
      rows.push({
        title: group.title,
        description: group.description,
        ...multiDay(start, end),
        category: group.category,
        geo_scope: VA_GEO,
        source: group.source,
        created_by_writer: VA_WRITER,
      })
    }
  }
  return rows
}

/**
 * Ensure rows exist for the curated Virginia-region calendar events that
 * fall inside [startDate, endDate]. Idempotent — repeated calls upsert
 * onto (geo_scope, title, start_date) without duplicating.
 *
 * Mirrors populateUSCalendarEvents structure but targets geo_scope='us_va'.
 * The calendar reader's hierarchical expansion automatically picks these
 * up for any venue with state='VA' (us → us_va).
 *
 * Per T5-Rixey-ZZ / Z8.
 */
export async function populateVirginiaCalendarEvents(
  supabase: SupabaseClient,
  opts: { startDate: Date; endDate: Date },
): Promise<PopulateResult> {
  const startMs = opts.startDate.getTime()
  const endMs = opts.endDate.getTime()
  if (Number.isNaN(startMs) || Number.isNaN(endMs) || endMs < startMs) {
    throw new Error('populateVirginiaCalendarEvents: invalid date range')
  }

  const startYear = opts.startDate.getUTCFullYear()
  const endYear = opts.endDate.getUTCFullYear()
  const warnings: string[] = []
  const allRows: CalendarRow[] = []
  for (let y = startYear; y <= endYear; y++) {
    allRows.push(...buildVAYearRows(y, warnings))
  }

  const startIso = isoDate(opts.startDate)
  const endIso = isoDate(opts.endDate)
  const windowed = allRows.filter(
    (r) => r.start_date <= endIso && r.end_date >= startIso,
  )

  const byCategory: Record<CalendarCategory, number> = {
    federal_holiday: 0,
    religious_observance: 0,
    sporting_event: 0,
    industry_event: 0,
    university_event: 0,
    other: 0,
  }
  for (const r of windowed) byCategory[r.category]++

  const titles = Array.from(new Set(windowed.map((r) => r.title)))
  const { data: existingRows, error: selectError } = await supabase
    .from('external_calendar_events')
    .select('title, start_date')
    .eq('geo_scope', VA_GEO)
    .is('deleted_at', null)
    .in('title', titles)
    .gte('start_date', startIso)
    .lte('start_date', endIso)

  if (selectError) {
    logEvent({
      level: 'warn',
      msg: 'va-calendar-writer.preselect-failed',
      event_type: 'external_calendar_refresh',
      outcome: 'retry',
      data: { error: selectError.message },
    })
  }
  const existingKeys = new Set(
    ((existingRows ?? []) as Array<{ title: string; start_date: string }>).map(
      (r) => `${r.title}|${r.start_date}`,
    ),
  )

  let inserted = 0
  let updated = 0
  for (const r of windowed) {
    if (existingKeys.has(`${r.title}|${r.start_date}`)) updated++
    else inserted++
  }

  const { error: upsertError } = await supabase
    .from('external_calendar_events')
    .upsert(windowed, {
      onConflict: 'geo_scope,title,start_date',
      ignoreDuplicates: false,
    })

  if (upsertError) {
    logEvent({
      level: 'error',
      msg: 'va-calendar-writer.upsert-failed',
      event_type: 'external_calendar_refresh',
      outcome: 'fail',
      data: { error: upsertError.message, attempted_rows: windowed.length },
    })
    return {
      rows_total: windowed.length,
      rows_inserted: 0,
      rows_updated: 0,
      rows_failed: windowed.length,
      by_category: byCategory,
      warnings,
    }
  }

  return {
    rows_total: windowed.length,
    rows_inserted: inserted,
    rows_updated: updated,
    rows_failed: 0,
    by_category: byCategory,
    warnings,
  }
}
