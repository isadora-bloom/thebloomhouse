/**
 * Bloom House: Holiday & Event Calendar Ingestion Service
 *
 * Provides a comprehensive calendar of holidays, cultural events, sporting
 * events, academic dates, and seasonal markers that affect wedding venue
 * operations — from booking competition to hotel availability to demand
 * patterns.
 *
 * This is a static/computed data source (no external API needed for v1).
 * Can optionally be enriched via Nager.Date API for federal holidays.
 *
 * Nager.Date API (free): https://date.nager.at/api/v3/PublicHolidays/{year}/US
 */

import { createServiceClient } from '@/lib/supabase/service'

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface CalendarEvent {
  date: string              // YYYY-MM-DD
  name: string
  type: CalendarEventType
  impact: 'high' | 'medium' | 'low'
  impact_notes: string      // Why this matters for wedding venues
  region?: string           // Default 'US'; can be state-specific (e.g. 'VA')
  demand_modifier?: number  // 1.0 = normal, 1.5 = 50% above normal, 0.5 = below normal
}

export type CalendarEventType =
  | 'federal_holiday'
  | 'cultural'
  | 'religious'
  | 'academic'
  | 'sporting'
  | 'seasonal'
  | 'industry'

// ---------------------------------------------------------------------------
// Easter calculation (Computus algorithm)
// ---------------------------------------------------------------------------

function getEasterDate(year: number): Date {
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
  const month = Math.floor((h + l - 7 * m + 114) / 31)
  const day = ((h + l - 7 * m + 114) % 31) + 1
  return new Date(year, month - 1, day)
}

// ---------------------------------------------------------------------------
// Helper: nth weekday of month
// ---------------------------------------------------------------------------

function nthWeekdayOfMonth(
  year: number,
  month: number,    // 0-indexed
  weekday: number,  // 0=Sun, 1=Mon, ... 6=Sat
  nth: number       // 1-based; use -1 for last
): Date {
  if (nth > 0) {
    const first = new Date(year, month, 1)
    const firstWeekday = first.getDay()
    let dayOffset = weekday - firstWeekday
    if (dayOffset < 0) dayOffset += 7
    const targetDay = 1 + dayOffset + (nth - 1) * 7
    return new Date(year, month, targetDay)
  } else {
    // Last occurrence
    const last = new Date(year, month + 1, 0)
    const lastWeekday = last.getDay()
    let dayOffset = lastWeekday - weekday
    if (dayOffset < 0) dayOffset += 7
    return new Date(year, month + 1, -dayOffset)
  }
}

function fmt(d: Date): string {
  return d.toISOString().split('T')[0]
}

// ---------------------------------------------------------------------------
// Approximate religious observance dates
// ---------------------------------------------------------------------------

/**
 * Approximate Passover (15 Nisan) — simplified calculation.
 * For production, use a Hebrew calendar library.
 */
function getApproxPassover(year: number): string {
  // Passover dates for known years; fallback to late March/April estimate
  const known: Record<number, string> = {
    2025: '2025-04-13',
    2026: '2026-04-02',
    2027: '2027-04-22',
    2028: '2028-04-11',
    2029: '2029-03-31',
    2030: '2030-04-18',
  }
  return known[year] || `${year}-04-10` // safe approximate
}

/**
 * Approximate Rosh Hashanah — simplified.
 */
function getApproxRoshHashanah(year: number): string {
  const known: Record<number, string> = {
    2025: '2025-09-23',
    2026: '2026-09-12',
    2027: '2027-10-02',
    2028: '2028-09-21',
    2029: '2029-09-10',
    2030: '2030-09-28',
  }
  return known[year] || `${year}-09-20`
}

/**
 * Approximate Ramadan start — shifts ~11 days earlier each year.
 */
function getApproxRamadanStart(year: number): string {
  const known: Record<number, string> = {
    2025: '2025-02-28',
    2026: '2026-02-18',
    2027: '2027-02-08',
    2028: '2028-01-28',
    2029: '2029-01-16',
    2030: '2030-01-06',
  }
  return known[year] || `${year}-03-01`
}

function getApproxRamadanEnd(year: number): string {
  const known: Record<number, string> = {
    2025: '2025-03-30',
    2026: '2026-03-20',
    2027: '2027-03-09',
    2028: '2028-02-26',
    2029: '2029-02-14',
    2030: '2030-02-04',
  }
  return known[year] || `${year}-03-30`
}

/**
 * Approximate Diwali date.
 */
function getApproxDiwali(year: number): string {
  const known: Record<number, string> = {
    2025: '2025-10-20',
    2026: '2026-11-08',
    2027: '2027-10-29',
    2028: '2028-10-17',
    2029: '2029-11-05',
    2030: '2030-10-26',
  }
  return known[year] || `${year}-10-25`
}

// ---------------------------------------------------------------------------
// Main Holiday/Event Generator
// ---------------------------------------------------------------------------

/**
 * Returns a comprehensive list of holidays, cultural events, religious
 * observances, academic dates, sporting events, and seasonal markers
 * for a given year. All dates that matter for wedding venue operations.
 */
export function getHolidaysForYear(year: number): CalendarEvent[] {
  const easter = getEasterDate(year)

  const events: CalendarEvent[] = [

    // =====================================================================
    // FEDERAL HOLIDAYS
    // =====================================================================
    {
      date: `${year}-01-01`,
      name: "New Year's Day",
      type: 'federal_holiday',
      impact: 'medium',
      impact_notes: 'Popular elopement date. Hotels booked for NYE. Some inquiries pause over holidays.',
      demand_modifier: 1.3,
    },
    {
      date: fmt(nthWeekdayOfMonth(year, 0, 1, 3)), // 3rd Monday of January
      name: 'Martin Luther King Jr. Day',
      type: 'federal_holiday',
      impact: 'low',
      impact_notes: 'Long weekend may attract destination weddings. Minor impact on local bookings.',
      demand_modifier: 1.1,
    },
    {
      date: fmt(nthWeekdayOfMonth(year, 1, 1, 3)), // 3rd Monday of February
      name: "Presidents' Day",
      type: 'federal_holiday',
      impact: 'low',
      impact_notes: 'Long weekend. Some winter elopements or small ceremonies.',
      demand_modifier: 1.1,
    },
    {
      date: fmt(nthWeekdayOfMonth(year, 4, 1, -1)), // Last Monday of May
      name: 'Memorial Day',
      type: 'federal_holiday',
      impact: 'high',
      impact_notes: 'Major long weekend. Peak wedding demand. Hotels book up fast. Book premium pricing.',
      demand_modifier: 1.8,
    },
    {
      date: `${year}-06-19`,
      name: 'Juneteenth',
      type: 'federal_holiday',
      impact: 'low',
      impact_notes: 'Federal holiday. Some vendor schedule impacts. Growing cultural significance.',
      demand_modifier: 1.0,
    },
    {
      date: `${year}-07-04`,
      name: 'Independence Day',
      type: 'federal_holiday',
      impact: 'high',
      impact_notes: 'Major demand date. Fireworks create magical backdrop. Hotels and vendors at capacity. Premium pricing.',
      demand_modifier: 1.9,
    },
    {
      date: fmt(nthWeekdayOfMonth(year, 8, 1, 1)), // 1st Monday of September
      name: 'Labor Day',
      type: 'federal_holiday',
      impact: 'high',
      impact_notes: 'Last major summer long weekend. Very high wedding demand. Marks end of peak season for some markets.',
      demand_modifier: 1.8,
    },
    {
      date: fmt(nthWeekdayOfMonth(year, 9, 1, 2)), // 2nd Monday of October
      name: 'Columbus Day / Indigenous Peoples\' Day',
      type: 'federal_holiday',
      impact: 'medium',
      impact_notes: 'Long weekend in peak fall foliage season. Popular for fall weddings. Hotel competition.',
      demand_modifier: 1.4,
    },
    {
      date: `${year}-11-11`,
      name: 'Veterans Day',
      type: 'federal_holiday',
      impact: 'low',
      impact_notes: 'Federal holiday. Some vendor closures. Patriotic-themed weddings possible.',
      demand_modifier: 1.0,
    },
    {
      date: fmt(nthWeekdayOfMonth(year, 10, 4, 4)), // 4th Thursday of November
      name: 'Thanksgiving',
      type: 'federal_holiday',
      impact: 'medium',
      impact_notes: 'Long weekend. Destination wedding opportunity. Most local couples avoid. Hotel rates spike.',
      demand_modifier: 0.7,
    },
    {
      date: `${year}-12-25`,
      name: 'Christmas Day',
      type: 'federal_holiday',
      impact: 'medium',
      impact_notes: 'Popular elopement date. Most traditional weddings avoid. Magical winter setting for intimate ceremonies.',
      demand_modifier: 0.6,
    },
    {
      date: `${year}-12-31`,
      name: "New Year's Eve",
      type: 'federal_holiday',
      impact: 'high',
      impact_notes: 'Very popular wedding date. Premium pricing opportunity. Hotels at peak rates. Book well in advance.',
      demand_modifier: 2.0,
    },

    // =====================================================================
    // CULTURAL DATES
    // =====================================================================
    {
      date: `${year}-02-14`,
      name: "Valentine's Day",
      type: 'cultural',
      impact: 'high',
      impact_notes: 'Popular elopement and engagement date. High inquiry volume. Romantic associations drive demand.',
      demand_modifier: 1.6,
    },
    {
      date: fmt(nthWeekdayOfMonth(year, 4, 0, 2)), // 2nd Sunday of May
      name: "Mother's Day",
      type: 'cultural',
      impact: 'medium',
      impact_notes: 'Most couples avoid this date. Brunch venues may have conflicts. Can reduce weekend availability.',
      demand_modifier: 0.7,
    },
    {
      date: fmt(nthWeekdayOfMonth(year, 5, 0, 3)), // 3rd Sunday of June
      name: "Father's Day",
      type: 'cultural',
      impact: 'medium',
      impact_notes: 'Some couples avoid. Peak wedding season so competing demand. Saturday before is prime.',
      demand_modifier: 0.8,
    },
    {
      date: `${year}-10-31`,
      name: 'Halloween',
      type: 'cultural',
      impact: 'medium',
      impact_notes: 'Growing wedding theme trend. If it falls on a Saturday, expect themed wedding demand. Hotel competition for events.',
      demand_modifier: 1.2,
    },

    // =====================================================================
    // RELIGIOUS OBSERVANCES
    // =====================================================================
    {
      date: fmt(easter),
      name: 'Easter Sunday',
      type: 'religious',
      impact: 'medium',
      impact_notes: 'Most couples avoid. Long weekend can boost Saturday before. Church venue conflicts.',
      demand_modifier: 0.6,
    },
    {
      date: fmt(new Date(easter.getTime() - 2 * 24 * 60 * 60 * 1000)), // Good Friday
      name: 'Good Friday',
      type: 'religious',
      impact: 'low',
      impact_notes: 'Some couples and vendors observe. Consider in Christian-heavy markets.',
      demand_modifier: 0.8,
    },
    {
      date: getApproxPassover(year),
      name: 'Passover (begins)',
      type: 'religious',
      impact: 'medium',
      impact_notes: 'Jewish couples and guests avoid weddings during 8-day observance. Plan around in markets with significant Jewish population.',
      demand_modifier: 0.8,
    },
    {
      date: getApproxRoshHashanah(year),
      name: 'Rosh Hashanah',
      type: 'religious',
      impact: 'medium',
      impact_notes: 'Jewish New Year. 2-day observance. Avoid scheduling Jewish weddings. Guest availability may be affected.',
      demand_modifier: 0.8,
    },
    {
      date: getApproxRamadanStart(year),
      name: 'Ramadan (begins)',
      type: 'religious',
      impact: 'low',
      impact_notes: 'Month-long observance. Muslim couples typically avoid weddings during Ramadan. Catering timing matters.',
      demand_modifier: 0.9,
    },
    {
      date: getApproxRamadanEnd(year),
      name: 'Eid al-Fitr (Ramadan ends)',
      type: 'religious',
      impact: 'medium',
      impact_notes: 'Celebration marking end of Ramadan. Popular date for Muslim weddings. Expect increased demand.',
      demand_modifier: 1.3,
    },
    {
      date: getApproxDiwali(year),
      name: 'Diwali',
      type: 'religious',
      impact: 'medium',
      impact_notes: 'Hindu/Sikh festival of lights. Popular wedding period for South Asian couples. Expect themed events.',
      demand_modifier: 1.3,
    },

    // =====================================================================
    // ACADEMIC / COLLEGE EVENTS
    // =====================================================================
    {
      date: `${year}-05-17`,
      name: 'UVA Graduation Weekend (approx)',
      type: 'academic',
      impact: 'high',
      impact_notes: 'Hotels in Charlottesville sell out completely. Restaurants overbooked. Avoid scheduling or charge premium. Major traffic.',
      region: 'VA',
      demand_modifier: 0.5, // Hotels full = bad for out-of-town guests
    },
    {
      date: `${year}-05-10`,
      name: 'College Graduation Season (general start)',
      type: 'academic',
      impact: 'medium',
      impact_notes: 'May weekends compete with graduation ceremonies nationally. Hotel availability tight in college towns.',
      demand_modifier: 0.8,
    },
    {
      date: `${year}-08-20`,
      name: 'College Move-In Season (approx)',
      type: 'academic',
      impact: 'low',
      impact_notes: 'Hotel rooms scarce in college towns. Traffic increases. Usually late August.',
      region: 'VA',
      demand_modifier: 0.9,
    },
    {
      date: `${year}-05-24`,
      name: 'College Graduation Season (general end)',
      type: 'academic',
      impact: 'medium',
      impact_notes: 'Late May graduations wrap up. Hotel pressure eases. Leading into Memorial Day weekend.',
      demand_modifier: 0.9,
    },

    // =====================================================================
    // SPORTING EVENTS
    // =====================================================================
    {
      date: `${year}-02-09`,
      name: 'Super Bowl Sunday (approx)',
      type: 'sporting',
      impact: 'high',
      impact_notes: 'Strongly avoid scheduling weddings on Super Bowl Sunday. Guest attendance drops. Sports bars and hotels packed.',
      demand_modifier: 0.3,
    },
    // College football Saturdays — Sept through November
    {
      date: `${year}-09-06`,
      name: 'College Football Season Opens',
      type: 'sporting',
      impact: 'medium',
      impact_notes: 'Saturday weddings in college towns compete with football game days through November. UVA home games affect Charlottesville hotels and traffic.',
      region: 'VA',
      demand_modifier: 0.9,
    },
    {
      date: `${year}-11-22`,
      name: 'Rivalry Weekend (College Football)',
      type: 'sporting',
      impact: 'medium',
      impact_notes: 'Annual rivalry games (UVA-VT etc.) cause hotel surges and traffic in affected areas.',
      region: 'VA',
      demand_modifier: 0.7,
    },

    // =====================================================================
    // SEASONAL MARKERS
    // =====================================================================
    {
      date: `${year}-03-14`,
      name: 'Spring Break (typical start, varies by school)',
      type: 'seasonal',
      impact: 'low',
      impact_notes: 'Some families travel. Slightly reduced weekend availability for destination guests. Vendor availability may be affected.',
      demand_modifier: 0.9,
    },
    {
      date: `${year}-03-20`,
      name: 'Spring Equinox',
      type: 'seasonal',
      impact: 'low',
      impact_notes: 'Marks start of spring wedding season in most markets. Inquiry volume typically increases from here.',
      demand_modifier: 1.1,
    },
    {
      date: `${year}-04-01`,
      name: 'Spring Wedding Season Opens',
      type: 'seasonal',
      impact: 'medium',
      impact_notes: 'April-June is peak inquiry and booking season. Staff up. Response times matter most now.',
      demand_modifier: 1.4,
    },
    {
      date: `${year}-06-20`,
      name: 'Summer Solstice (approx)',
      type: 'seasonal',
      impact: 'low',
      impact_notes: 'Longest day of the year. Outdoor ceremonies benefit from extended golden hour. Popular for garden weddings.',
      demand_modifier: 1.2,
    },
    {
      date: `${year}-09-22`,
      name: 'Fall Equinox',
      type: 'seasonal',
      impact: 'low',
      impact_notes: 'Marks start of fall wedding season. Foliage begins changing in northern markets.',
      demand_modifier: 1.1,
    },
    {
      date: `${year}-10-10`,
      name: 'Peak Fall Foliage (Virginia/Mid-Atlantic, approx)',
      type: 'seasonal',
      impact: 'high',
      impact_notes: 'Peak fall foliage in Virginia mountains. Highest weekend demand for outdoor venues. Premium pricing opportunity. Book tours to show property at its best.',
      region: 'VA',
      demand_modifier: 1.8,
    },
    {
      date: `${year}-10-17`,
      name: 'Peak Fall Foliage (Northeast, approx)',
      type: 'seasonal',
      impact: 'high',
      impact_notes: 'Peak foliage for New England and Northeast venues. Leaf-peeper tourism competes for hotel rooms.',
      demand_modifier: 1.6,
    },
    {
      date: `${year}-12-15`,
      name: 'Holiday Season Peak',
      type: 'seasonal',
      impact: 'medium',
      impact_notes: 'Corporate holiday parties compete for venue dates. Wedding inquiries slow but elopement demand rises. Festive decor is a selling point.',
      demand_modifier: 0.8,
    },
    {
      date: `${year}-01-15`,
      name: 'Engagement Season Peak',
      type: 'industry',
      impact: 'high',
      impact_notes: 'Post-holiday engagement announcements drive highest inquiry volume of the year. Response speed critical. January is make-or-break for filling the calendar.',
      demand_modifier: 1.6,
    },
    {
      date: `${year}-02-01`,
      name: 'Wedding Show Season',
      type: 'industry',
      impact: 'medium',
      impact_notes: 'Major bridal shows in January-February drive burst of inquiries. Prepare follow-up sequences. Have pricing and availability ready.',
      demand_modifier: 1.3,
    },
  ]

  return events.sort((a, b) => a.date.localeCompare(b.date))
}

// ---------------------------------------------------------------------------
// Get events for a date range (for dashboard display)
// ---------------------------------------------------------------------------

/**
 * Returns calendar events within a given date range.
 * Useful for "upcoming date conflicts" widget on the dashboard.
 */
export function getEventsInRange(
  startDate: string,
  endDate: string,
  options?: { region?: string; minImpact?: 'high' | 'medium' | 'low' }
): CalendarEvent[] {
  const startYear = new Date(startDate).getFullYear()
  const endYear = new Date(endDate).getFullYear()

  const allEvents: CalendarEvent[] = []
  for (let year = startYear; year <= endYear; year++) {
    allEvents.push(...getHolidaysForYear(year))
  }

  return allEvents.filter(e => {
    if (e.date < startDate || e.date > endDate) return false
    if (options?.region && e.region && e.region !== options.region) return false
    if (options?.minImpact) {
      const impactOrder = { high: 3, medium: 2, low: 1 }
      if (impactOrder[e.impact] < impactOrder[options.minImpact]) return false
    }
    return true
  })
}

/**
 * Get the seasonal advisory for the current period.
 * Returns a human-readable description of where we are in the
 * wedding industry seasonal cycle.
 */
export function getSeasonalAdvisory(date?: Date): {
  label: string
  description: string
  inquiry_trend: 'rising' | 'peak' | 'declining' | 'low'
  booking_trend: 'rising' | 'peak' | 'declining' | 'low'
} {
  const d = date || new Date()
  const month = d.getMonth() // 0-indexed

  const seasonalMap: Record<number, {
    label: string
    description: string
    inquiry_trend: 'rising' | 'peak' | 'declining' | 'low'
    booking_trend: 'rising' | 'peak' | 'declining' | 'low'
  }> = {
    0: { // January
      label: 'Engagement Season',
      description: 'Holiday engagements drive the year\'s highest inquiry volume. Response speed is critical — couples are actively comparing venues.',
      inquiry_trend: 'peak',
      booking_trend: 'rising',
    },
    1: { // February
      label: 'Inquiry Peak',
      description: 'Post-engagement and Valentine\'s keep inquiries high. Wedding shows drive bursts. This is your best opportunity to fill the calendar.',
      inquiry_trend: 'peak',
      booking_trend: 'rising',
    },
    2: { // March
      label: 'Booking Sprint',
      description: 'Couples who inquired in Jan/Feb are booking tours and signing contracts. Conversion rates should be highest now.',
      inquiry_trend: 'declining',
      booking_trend: 'peak',
    },
    3: { // April
      label: 'Spring Wedding Season',
      description: 'Wedding season begins. Active events keep the team busy while bookings continue for fall and next year.',
      inquiry_trend: 'declining',
      booking_trend: 'peak',
    },
    4: { // May
      label: 'Peak Season',
      description: 'One of the busiest months for weddings. Graduation weekend competition for hotels. Balance event execution with new inquiries.',
      inquiry_trend: 'declining',
      booking_trend: 'declining',
    },
    5: { // June
      label: 'Peak Season',
      description: 'Traditional "wedding month." High event volume. New inquiries slow as most couples planning this year have already booked.',
      inquiry_trend: 'low',
      booking_trend: 'declining',
    },
    6: { // July
      label: 'Summer Events',
      description: 'July 4th weekend is premium. Summer weddings continue. Inquiries pick up for next year as newly engaged couples start planning.',
      inquiry_trend: 'rising',
      booking_trend: 'low',
    },
    7: { // August
      label: 'Late Summer',
      description: 'Wedding volume steady. College move-in may affect hotel availability. Next-year bookings building.',
      inquiry_trend: 'rising',
      booking_trend: 'low',
    },
    8: { // September
      label: 'Fall Season Opens',
      description: 'Labor Day weekend is premium. Fall foliage season begins. This is the second peak for weddings after May/June.',
      inquiry_trend: 'rising',
      booking_trend: 'rising',
    },
    9: { // October
      label: 'Fall Peak',
      description: 'Peak fall foliage drives highest autumn demand. Premium pricing opportunity. Fill remaining dates aggressively.',
      inquiry_trend: 'peak',
      booking_trend: 'peak',
    },
    10: { // November
      label: 'Shoulder Season',
      description: 'Wedding volume drops after Thanksgiving. Focus on closing remaining inquiries and preparing for engagement season.',
      inquiry_trend: 'declining',
      booking_trend: 'declining',
    },
    11: { // December
      label: 'Holiday / Engagement Season',
      description: 'Wedding volume low but NYE is premium. Christmas proposals drive January inquiry wave. Prepare marketing for January.',
      inquiry_trend: 'low',
      booking_trend: 'low',
    },
  }

  return seasonalMap[month] || seasonalMap[0]
}

// ---------------------------------------------------------------------------
// Database seeding
// ---------------------------------------------------------------------------

/**
 * Seeds calendar events for a venue into the database.
 * Uses venue_config feature_flags to store calendar preferences,
 * and can optionally populate a calendar_events table if it exists.
 */
export async function seedCalendarForVenue(
  venueId: string,
  year: number
): Promise<{ seeded: number; errors: number }> {
  const supabase = createServiceClient()
  const events = getHolidaysForYear(year)

  // Try to insert into calendar_events table (may not exist yet)
  // If the table doesn't exist, store in venue_config.feature_flags
  try {
    const rows = events.map(e => ({
      date: e.date,
      name: e.name,
      type: e.type,
      region: e.region || 'US',
      impacts_demand: e.impact !== 'low',
      demand_modifier: e.demand_modifier || 1.0,
    }))

    const { error } = await supabase
      .from('calendar_events')
      .upsert(rows, { onConflict: 'date,name' })

    if (error) {
      if (error.message?.includes('does not exist') || error.code === '42P01') {
        // Table doesn't exist yet — fall back to venue_config storage
        console.log('[calendar-ingest] calendar_events table not yet created, storing in venue_config')

        const { error: configError } = await supabase
          .from('venue_config')
          .update({
            feature_flags: {
              calendar_events_year: year,
              calendar_events_count: events.length,
              calendar_seeded_at: new Date().toISOString(),
            },
          })
          .eq('venue_id', venueId)

        if (configError) {
          console.error('[calendar-ingest] Failed to update venue_config:', configError.message)
          return { seeded: 0, errors: 1 }
        }

        return { seeded: events.length, errors: 0 }
      }

      console.error('[calendar-ingest] Failed to seed events:', error.message)
      return { seeded: 0, errors: 1 }
    }

    console.log(`[calendar-ingest] Seeded ${events.length} calendar events for ${year}`)
    return { seeded: events.length, errors: 0 }
  } catch (err) {
    console.error('[calendar-ingest] seedCalendarForVenue failed:', err)
    return { seeded: 0, errors: 1 }
  }
}
