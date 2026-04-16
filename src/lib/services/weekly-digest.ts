/**
 * Bloom House: Dynamic Weekly Digest Generator
 *
 * Replaces the static weekly briefing with a rich, intelligence-powered
 * digest that pulls from real venue data across 6 structured sections:
 *
 *   1. Leads Needing Attention
 *   2. Performance This Week
 *   3. Pattern Spotlight
 *   4. Seasonal Advisory
 *   5. Event Prep Alerts
 *   6. Quick Wins
 *
 * Each section is populated from intelligence_insights, weddings,
 * market_intelligence, weather_data, and related tables.
 */

import { createServiceClient } from '@/lib/supabase/service'
import { callAIJson } from '@/lib/ai/client'

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface DigestItem {
  text: string
  priority: 'high' | 'medium' | 'low'
  meta?: Record<string, unknown>
}

export interface DigestSection {
  heading: string
  icon: string
  items: DigestItem[]
}

export interface DigestMetrics {
  inquiries_this_week: number
  inquiries_last_week: number
  bookings_this_week: number
  bookings_last_week: number
  lost_this_week: number
  revenue_this_week: number
  avg_response_time_minutes: number | null
}

export interface WeeklyDigest {
  venue_id: string
  venue_name: string
  week_start: string
  week_end: string
  title: string
  summary: string
  sections: DigestSection[]
  metrics: DigestMetrics
  generated_at: string
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function daysAgo(days: number): string {
  const d = new Date()
  d.setDate(d.getDate() - days)
  return d.toISOString().split('T')[0]
}

function daysFromNow(days: number): string {
  const d = new Date()
  d.setDate(d.getDate() + days)
  return d.toISOString().split('T')[0]
}

function today(): string {
  return new Date().toISOString().split('T')[0]
}

function weekStart(): string {
  const d = new Date()
  d.setDate(d.getDate() - d.getDay() + 1) // Monday
  return d.toISOString().split('T')[0]
}

function formatMinutes(mins: number): string {
  if (mins < 60) return `${Math.round(mins)}min`
  if (mins < 1440) return `${(mins / 60).toFixed(1)}hr`
  return `${(mins / 1440).toFixed(1)} days`
}

// ---------------------------------------------------------------------------
// Section 1: Leads Needing Attention
// ---------------------------------------------------------------------------

async function buildLeadsSection(
  venueId: string
): Promise<DigestSection> {
  const supabase = createServiceClient()
  const items: DigestItem[] = []

  // High-priority insights about lead conversion and response time
  const { data: leadInsights } = await supabase
    .from('intelligence_insights')
    .select('title, priority, category, data_points')
    .eq('venue_id', venueId)
    .in('category', ['lead_conversion', 'response_time'])
    .in('status', ['new', 'seen'])
    .in('priority', ['critical', 'high'])
    .order('impact_score', { ascending: false })
    .limit(3)

  for (const insight of leadInsights ?? []) {
    items.push({
      text: insight.title,
      priority: insight.priority === 'critical' ? 'high' : (insight.priority as 'high' | 'medium' | 'low'),
      meta: { category: insight.category },
    })
  }

  // Stalled leads: active weddings with no interaction in 5+ days
  const fiveDaysAgo = daysAgo(5)
  const { data: stalledWeddings } = await supabase
    .from('weddings')
    .select('id, couple_name, status, updated_at, booking_value')
    .eq('venue_id', venueId)
    .in('status', ['inquiry', 'tour_scheduled', 'tour_completed', 'proposal_sent'])
    .lt('updated_at', fiveDaysAgo)
    .order('booking_value', { ascending: false })
    .limit(5)

  for (const w of stalledWeddings ?? []) {
    const daysSince = Math.floor(
      (Date.now() - new Date(w.updated_at).getTime()) / 86_400_000
    )
    const value = w.booking_value ? ` ($${Number(w.booking_value).toLocaleString()})` : ''
    items.push({
      text: `${w.couple_name ?? 'Unknown'} — stalled at "${w.status}" for ${daysSince} days${value}`,
      priority: daysSince > 10 ? 'high' : 'medium',
      meta: { wedding_id: w.id, days_stalled: daysSince },
    })
  }

  return {
    heading: 'Leads Needing Attention',
    icon: '\u{1F6A8}', // rotating light
    items,
  }
}

// ---------------------------------------------------------------------------
// Section 2: Performance This Week
// ---------------------------------------------------------------------------

async function buildPerformanceSection(
  venueId: string
): Promise<{ section: DigestSection; metrics: DigestMetrics }> {
  const supabase = createServiceClient()
  const items: DigestItem[] = []

  const thisWeekStart = daysAgo(7)
  const thisWeekEnd = today()
  const lastWeekStart = daysAgo(14)
  const lastWeekEnd = daysAgo(8)

  // This week counts
  const [thisInquiries, thisTours, thisBookings, thisLost, thisRevenue] = await Promise.all([
    supabase
      .from('weddings')
      .select('id', { count: 'exact', head: true })
      .eq('venue_id', venueId)
      .gte('created_at', thisWeekStart)
      .lte('created_at', thisWeekEnd),
    supabase
      .from('weddings')
      .select('id', { count: 'exact', head: true })
      .eq('venue_id', venueId)
      .not('tour_date', 'is', null)
      .gte('tour_date', thisWeekStart)
      .lte('tour_date', thisWeekEnd),
    supabase
      .from('weddings')
      .select('id', { count: 'exact', head: true })
      .eq('venue_id', venueId)
      .eq('status', 'booked')
      .gte('booked_at', thisWeekStart)
      .lte('booked_at', thisWeekEnd),
    supabase
      .from('weddings')
      .select('id', { count: 'exact', head: true })
      .eq('venue_id', venueId)
      .eq('status', 'lost')
      .gte('updated_at', thisWeekStart)
      .lte('updated_at', thisWeekEnd),
    supabase
      .from('weddings')
      .select('quoted_price')
      .eq('venue_id', venueId)
      .eq('status', 'booked')
      .gte('booked_at', thisWeekStart)
      .lte('booked_at', thisWeekEnd),
  ])

  // Last week counts for comparison
  const [lastInquiries, lastBookings] = await Promise.all([
    supabase
      .from('weddings')
      .select('id', { count: 'exact', head: true })
      .eq('venue_id', venueId)
      .gte('created_at', lastWeekStart)
      .lte('created_at', lastWeekEnd),
    supabase
      .from('weddings')
      .select('id', { count: 'exact', head: true })
      .eq('venue_id', venueId)
      .eq('status', 'booked')
      .gte('booked_at', lastWeekStart)
      .lte('booked_at', lastWeekEnd),
  ])

  // Average response time this week
  const { data: responseData } = await supabase
    .from('weddings')
    .select('inquiry_date, first_response_at')
    .eq('venue_id', venueId)
    .not('first_response_at', 'is', null)
    .not('inquiry_date', 'is', null)
    .gte('inquiry_date', thisWeekStart)
    .lte('inquiry_date', thisWeekEnd)

  let avgResponseMinutes: number | null = null
  if (responseData && responseData.length > 0) {
    const totalMinutes = responseData.reduce((sum, w) => {
      const diff =
        (new Date(w.first_response_at as string).getTime() -
          new Date(w.inquiry_date as string).getTime()) /
        60_000
      return sum + Math.max(0, diff)
    }, 0)
    avgResponseMinutes = totalMinutes / responseData.length
  }

  const revenueBooked = (thisRevenue.data ?? []).reduce(
    (sum, row) => sum + (Number(row.quoted_price) || 0),
    0
  )

  const inquiriesThisWeek = thisInquiries.count ?? 0
  const inquiriesLastWeek = lastInquiries.count ?? 0
  const bookingsThisWeek = thisBookings.count ?? 0
  const bookingsLastWeek = lastBookings.count ?? 0

  // Build summary items
  const inquiryDelta = inquiriesThisWeek - inquiriesLastWeek
  const deltaLabel =
    inquiryDelta > 0
      ? `(+${inquiryDelta} vs last week)`
      : inquiryDelta < 0
        ? `(${inquiryDelta} vs last week)`
        : '(same as last week)'

  items.push({
    text: `${inquiriesThisWeek} new inquiries ${deltaLabel}`,
    priority: inquiryDelta < 0 ? 'medium' : 'low',
  })
  items.push({
    text: `${bookingsThisWeek} bookings confirmed, ${thisLost.count ?? 0} lost`,
    priority: (thisLost.count ?? 0) > bookingsThisWeek ? 'high' : 'low',
  })
  items.push({
    text: `${thisTours.count ?? 0} tours scheduled`,
    priority: 'low',
  })
  if (revenueBooked > 0) {
    items.push({
      text: `$${revenueBooked.toLocaleString()} revenue booked this week`,
      priority: 'low',
    })
  }
  if (avgResponseMinutes !== null) {
    items.push({
      text: `Average response time: ${formatMinutes(avgResponseMinutes)}`,
      priority: avgResponseMinutes > 240 ? 'high' : avgResponseMinutes > 60 ? 'medium' : 'low',
    })
  }

  return {
    section: {
      heading: 'Performance This Week',
      icon: '\u{1F4CA}', // bar chart
      items,
    },
    metrics: {
      inquiries_this_week: inquiriesThisWeek,
      inquiries_last_week: inquiriesLastWeek,
      bookings_this_week: bookingsThisWeek,
      bookings_last_week: bookingsLastWeek,
      lost_this_week: thisLost.count ?? 0,
      revenue_this_week: revenueBooked,
      avg_response_time_minutes: avgResponseMinutes,
    },
  }
}

// ---------------------------------------------------------------------------
// Section 3: Pattern Spotlight
// ---------------------------------------------------------------------------

async function buildPatternSpotlight(
  venueId: string
): Promise<DigestSection> {
  const supabase = createServiceClient()
  const items: DigestItem[] = []

  // Top insight by impact score from last 7 days
  const { data: topInsights } = await supabase
    .from('intelligence_insights')
    .select('title, body, action, impact_score, priority, category')
    .eq('venue_id', venueId)
    .in('status', ['new', 'seen'])
    .gte('created_at', daysAgo(7))
    .order('impact_score', { ascending: false })
    .limit(1)

  if (topInsights && topInsights.length > 0) {
    const top = topInsights[0]
    items.push({
      text: `${top.title} — ${top.body?.substring(0, 200)}${(top.body?.length ?? 0) > 200 ? '...' : ''}`,
      priority: top.priority === 'critical' ? 'high' : (top.priority as 'high' | 'medium' | 'low'),
      meta: { action: top.action, category: top.category, impact_score: top.impact_score },
    })
    if (top.action) {
      items.push({
        text: `Recommended action: ${top.action}`,
        priority: 'medium',
      })
    }
  } else {
    items.push({
      text: 'No new pattern insights detected this week. The intelligence engine will continue monitoring.',
      priority: 'low',
    })
  }

  return {
    heading: 'Pattern Spotlight',
    icon: '\u{1F50D}', // magnifying glass
    items,
  }
}

// ---------------------------------------------------------------------------
// Section 4: Seasonal Advisory
// ---------------------------------------------------------------------------

async function buildSeasonalAdvisory(
  venueId: string
): Promise<DigestSection> {
  const supabase = createServiceClient()
  const items: DigestItem[] = []

  // Get venue region for market intelligence
  const { data: venue } = await supabase
    .from('venues')
    .select('state, latitude, longitude')
    .eq('id', venueId)
    .single()

  // Market intelligence — inquiry seasonality
  if (venue?.state) {
    const { data: market } = await supabase
      .from('market_intelligence')
      .select('inquiry_seasonality, booking_seasonality, region_name')
      .eq('region_key', venue.state)
      .order('data_year', { ascending: false })
      .limit(1)
      .maybeSingle()

    if (market?.inquiry_seasonality) {
      const currentMonth = new Date().getMonth() // 0-indexed
      const seasonality = market.inquiry_seasonality as number[]
      const currentFactor = seasonality[currentMonth] ?? 1.0

      let seasonalText: string
      if (currentFactor > 1.3) {
        seasonalText = `Peak season in ${market.region_name ?? venue.state}: inquiry volume is typically ${Math.round((currentFactor - 1) * 100)}% above average this month`
        items.push({ text: seasonalText, priority: 'high' })
      } else if (currentFactor < 0.7) {
        seasonalText = `Slow season in ${market.region_name ?? venue.state}: inquiry volume is typically ${Math.round((1 - currentFactor) * 100)}% below average this month`
        items.push({ text: seasonalText, priority: 'medium' })
      } else {
        seasonalText = `Moderate season in ${market.region_name ?? venue.state}: inquiry volume is near average for this time of year`
        items.push({ text: seasonalText, priority: 'low' })
      }
    }
  }

  // Weather outlook for the next 14 days (if data exists)
  const { data: weather } = await supabase
    .from('weather_data')
    .select('date, high_temp, low_temp, precipitation, conditions')
    .eq('venue_id', venueId)
    .gte('date', today())
    .lte('date', daysFromNow(14))
    .order('date', { ascending: true })

  if (weather && weather.length > 0) {
    const rainyDays = weather.filter(
      (w) => (w.precipitation ?? 0) > 0.25 || (w.conditions ?? '').toLowerCase().includes('rain')
    )
    if (rainyDays.length > 3) {
      items.push({
        text: `${rainyDays.length} days with rain expected in the next 2 weeks — review backup plans for outdoor events`,
        priority: 'high',
      })
    } else if (rainyDays.length > 0) {
      items.push({
        text: `${rainyDays.length} days with possible rain in the next 2 weeks`,
        priority: 'low',
      })
    }

    const highTemps = weather.map((w) => w.high_temp ?? 0).filter((t) => t > 0)
    if (highTemps.length > 0) {
      const maxTemp = Math.max(...highTemps)
      const minTemp = Math.min(...highTemps)
      items.push({
        text: `Temperature range: ${minTemp}-${maxTemp}F over the next 2 weeks`,
        priority: maxTemp > 95 || minTemp < 32 ? 'medium' : 'low',
      })
    }
  }

  // Upcoming capacity pressure
  const { count: upcomingCount } = await supabase
    .from('weddings')
    .select('id', { count: 'exact', head: true })
    .eq('venue_id', venueId)
    .eq('status', 'booked')
    .gte('wedding_date', today())
    .lte('wedding_date', daysFromNow(60))

  if ((upcomingCount ?? 0) > 0) {
    items.push({
      text: `${upcomingCount} booked events in the next 60 days`,
      priority: (upcomingCount ?? 0) > 8 ? 'high' : 'low',
    })
  }

  if (items.length === 0) {
    items.push({
      text: 'No seasonal data available yet. Add your venue location to enable market and weather intelligence.',
      priority: 'low',
    })
  }

  return {
    heading: 'Seasonal Advisory',
    icon: '\u{1F326}\uFE0F', // sun behind cloud
    items,
  }
}

// ---------------------------------------------------------------------------
// Section 5: Event Prep Alerts
// ---------------------------------------------------------------------------

async function buildEventPrepAlerts(
  venueId: string
): Promise<DigestSection> {
  const supabase = createServiceClient()
  const items: DigestItem[] = []

  // Weddings in the next 14 days
  const { data: upcomingWeddings } = await supabase
    .from('weddings')
    .select('id, couple_name, wedding_date, status')
    .eq('venue_id', venueId)
    .eq('status', 'booked')
    .gte('wedding_date', today())
    .lte('wedding_date', daysFromNow(14))
    .order('wedding_date', { ascending: true })
    .limit(10)

  if (!upcomingWeddings || upcomingWeddings.length === 0) {
    items.push({
      text: 'No events scheduled in the next 14 days.',
      priority: 'low',
    })
    return {
      heading: 'Event Prep Alerts',
      icon: '\u{1F4C5}', // calendar
      items,
    }
  }

  for (const wedding of upcomingWeddings) {
    const weddingDate = new Date(wedding.wedding_date as string)
    const daysUntil = Math.ceil(
      (weddingDate.getTime() - Date.now()) / 86_400_000
    )
    const dateLabel = weddingDate.toLocaleDateString('en-US', {
      weekday: 'short',
      month: 'short',
      day: 'numeric',
    })

    // Check for incomplete checklist items
    const { count: incompleteChecklist } = await supabase
      .from('checklist_items')
      .select('id', { count: 'exact', head: true })
      .eq('wedding_id', wedding.id)
      .eq('completed', false)

    // Check for missing finalized sections
    const { count: unfinalized } = await supabase
      .from('section_finalisations')
      .select('id', { count: 'exact', head: true })
      .eq('wedding_id', wedding.id)
      .is('finalised_at', null)

    const alerts: string[] = []
    if ((incompleteChecklist ?? 0) > 0) {
      alerts.push(`${incompleteChecklist} checklist items incomplete`)
    }
    if ((unfinalized ?? 0) > 0) {
      alerts.push(`${unfinalized} sections not finalized`)
    }

    const alertText = alerts.length > 0 ? ` [${alerts.join(', ')}]` : ''

    items.push({
      text: `${wedding.couple_name ?? 'Unknown'} — ${dateLabel} (${daysUntil}d away)${alertText}`,
      priority: daysUntil <= 3 ? 'high' : daysUntil <= 7 ? 'medium' : 'low',
      meta: { wedding_id: wedding.id, days_until: daysUntil },
    })
  }

  return {
    heading: 'Event Prep Alerts',
    icon: '\u{1F4C5}', // calendar
    items,
  }
}

// ---------------------------------------------------------------------------
// Section 6: Quick Wins
// ---------------------------------------------------------------------------

async function buildQuickWins(
  venueId: string
): Promise<DigestSection> {
  const supabase = createServiceClient()
  const items: DigestItem[] = []

  // Low-effort, high-impact recommendations from intelligence_insights
  const { data: quickWinInsights } = await supabase
    .from('intelligence_insights')
    .select('title, action, priority, category')
    .eq('venue_id', venueId)
    .eq('insight_type', 'recommendation')
    .in('status', ['new', 'seen'])
    .in('priority', ['high', 'medium'])
    .order('impact_score', { ascending: false })
    .limit(4)

  for (const insight of quickWinInsights ?? []) {
    items.push({
      text: insight.action ?? insight.title,
      priority: insight.priority as 'high' | 'medium' | 'low',
      meta: { category: insight.category },
    })
  }

  // If no insights, check for common quick wins from data
  if (items.length === 0) {
    // Check for stalled leads to follow up on
    const { count: stalledCount } = await supabase
      .from('weddings')
      .select('id', { count: 'exact', head: true })
      .eq('venue_id', venueId)
      .in('status', ['inquiry', 'tour_scheduled', 'tour_completed', 'proposal_sent'])
      .lt('updated_at', daysAgo(5))

    if ((stalledCount ?? 0) > 0) {
      items.push({
        text: `Follow up with ${stalledCount} stalled leads that haven't been contacted in 5+ days`,
        priority: 'medium',
      })
    }

    // Check for recent outcomes that improved
    const { data: outcomes } = await supabase
      .from('insight_outcomes')
      .select('insight_id, improvement_pct, verdict')
      .eq('venue_id', venueId)
      .eq('verdict', 'improved')
      .order('outcome_measured_at', { ascending: false })
      .limit(1)

    if (outcomes && outcomes.length > 0) {
      items.push({
        text: `Your last acted-on insight showed ${Math.round(outcomes[0].improvement_pct ?? 0)}% improvement — keep acting on high-priority insights`,
        priority: 'low',
      })
    }
  }

  if (items.length === 0) {
    items.push({
      text: 'No quick wins identified this week. The intelligence engine needs more operational data to surface recommendations.',
      priority: 'low',
    })
  }

  return {
    heading: 'Quick Wins',
    icon: '\u{26A1}', // lightning bolt
    items,
  }
}

// ---------------------------------------------------------------------------
// AI Summary Generation
// ---------------------------------------------------------------------------

const DIGEST_SUMMARY_PROMPT = `You are the intelligence analyst for a wedding venue. Based on the structured weekly digest data provided, write a concise 1-2 sentence executive summary that captures the most important takeaway for the venue coordinator. Be specific with numbers. Tone: professional but warm, like a trusted advisor.

Return a JSON object with:
- summary: string (1-2 sentence executive summary)`

async function generateDigestSummary(
  venueName: string,
  sections: DigestSection[],
  metrics: DigestMetrics,
  venueId: string
): Promise<string> {
  try {
    const sectionsText = sections
      .map(
        (s) =>
          `${s.heading}:\n${s.items.map((i) => `  [${i.priority}] ${i.text}`).join('\n')}`
      )
      .join('\n\n')

    const result = await callAIJson<{ summary: string }>({
      systemPrompt: DIGEST_SUMMARY_PROMPT,
      userPrompt: `Venue: ${venueName}

METRICS:
- Inquiries this week: ${metrics.inquiries_this_week} (last week: ${metrics.inquiries_last_week})
- Bookings: ${metrics.bookings_this_week} (last week: ${metrics.bookings_last_week})
- Lost: ${metrics.lost_this_week}
- Revenue: $${metrics.revenue_this_week.toLocaleString()}
- Avg response time: ${metrics.avg_response_time_minutes !== null ? formatMinutes(metrics.avg_response_time_minutes) : 'N/A'}

SECTIONS:
${sectionsText}

Generate the executive summary.`,
      maxTokens: 300,
      temperature: 0.3,
      venueId,
      taskType: 'weekly_digest_summary',
    })

    return result.summary
  } catch (err) {
    console.error('[weekly-digest] AI summary generation failed:', err)
    // Fallback to a mechanical summary
    const highItems = sections.flatMap((s) => s.items.filter((i) => i.priority === 'high'))
    if (highItems.length > 0) {
      return `${highItems.length} high-priority items require attention this week. ${metrics.inquiries_this_week} new inquiries received, ${metrics.bookings_this_week} bookings confirmed.`
    }
    return `${metrics.inquiries_this_week} inquiries, ${metrics.bookings_this_week} bookings this week. Review the digest sections below for details.`
  }
}

// ---------------------------------------------------------------------------
// Main: generateWeeklyDigest
// ---------------------------------------------------------------------------

/**
 * Generates a comprehensive weekly intelligence digest for a venue
 * by pulling from real operational data and intelligence insights.
 */
export async function generateWeeklyDigest(
  venueId: string
): Promise<WeeklyDigest> {
  const supabase = createServiceClient()

  // Get venue name
  const { data: venue } = await supabase
    .from('venues')
    .select('name')
    .eq('id', venueId)
    .single()

  const venueName = venue?.name ?? 'Unknown Venue'
  const wsStart = weekStart()
  const wsEnd = today()

  // Build all sections in parallel
  const [leadsSection, performanceResult, patternSection, seasonalSection, eventPrepSection, quickWinsSection] =
    await Promise.all([
      buildLeadsSection(venueId),
      buildPerformanceSection(venueId),
      buildPatternSpotlight(venueId),
      buildSeasonalAdvisory(venueId),
      buildEventPrepAlerts(venueId),
      buildQuickWins(venueId),
    ])

  const sections: DigestSection[] = [
    leadsSection,
    performanceResult.section,
    patternSection,
    seasonalSection,
    eventPrepSection,
    quickWinsSection,
  ]

  // Generate AI summary
  const summary = await generateDigestSummary(
    venueName,
    sections,
    performanceResult.metrics,
    venueId
  )

  // Format the week title
  const weekStartDate = new Date(wsStart)
  const title = `Week of ${weekStartDate.toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' })}`

  const digest: WeeklyDigest = {
    venue_id: venueId,
    venue_name: venueName,
    week_start: wsStart,
    week_end: wsEnd,
    title,
    summary,
    sections,
    metrics: performanceResult.metrics,
    generated_at: new Date().toISOString(),
  }

  // Store in ai_briefings
  const { error } = await supabase.from('ai_briefings').insert({
    venue_id: venueId,
    briefing_type: 'weekly',
    content: {
      title: digest.title,
      summary: digest.summary,
      sections: digest.sections,
      metrics: digest.metrics,
      generated_at: digest.generated_at,
      week_start: digest.week_start,
      week_end: digest.week_end,
      venue_name: digest.venue_name,
      // Preserve backward-compat fields for existing UI
      demand_outlook: { score: 0, outlook: 'neutral' },
      trend_highlights: [],
      weather_outlook: '',
      anomaly_summary: [],
      recommendations: [],
    },
  })

  if (error) {
    console.error('[weekly-digest] Failed to store digest:', error.message)
  }

  return digest
}
