/**
 * Bloom House: AI Briefing Generator
 *
 * Generates weekly and monthly intelligence briefings for wedding venues.
 * Aggregates data from weddings, trends, weather, economics, and anomaly
 * detection, then uses AI to produce structured, actionable summaries.
 *
 * Briefing types:
 *   - weekly:  7-day window, tactical recommendations
 *   - monthly: 30-day window, strategic / month-over-month analysis
 *   - anomaly: triggered ad-hoc by anomaly detection (not generated here)
 */

import { createServiceClient } from '@/lib/supabase/service'
import { callAIJson } from '@/lib/ai/client'
import { detectTrendDeviations } from './trends'
import { getWeatherForDateRange } from './weather'
import { getLatestIndicators, calculateDemandScore } from './economics'
import { getActiveAlerts } from './anomaly-detection'
import { sendEmail } from './gmail'

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface BriefingMetrics {
  new_inquiries: number
  tours_scheduled: number
  bookings: number
  lost_deals: number
  revenue_booked: number
}

interface BriefingContent {
  summary: string
  metrics: BriefingMetrics
  demand_outlook: { score: number; outlook: string }
  trend_highlights: string[]
  weather_outlook: string
  anomaly_summary: string[]
  recommendations: string[]
  generated_at: string
}

interface MonthlyBriefingContent extends BriefingContent {
  month_over_month: {
    inquiries_change: number
    bookings_change: number
    revenue_change: number
  }
  strategic_recommendations: string[]
}

interface BriefingRow {
  id: string
  venue_id: string
  briefing_type: string
  content: BriefingContent | MonthlyBriefingContent
  delivered_via: string | null
  delivered_at: string | null
  created_at: string
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

/**
 * Query wedding-related metrics for a venue over a date window.
 */
async function getWeddingMetrics(
  venueId: string,
  fromDate: string,
  toDate: string
): Promise<BriefingMetrics> {
  const supabase = createServiceClient()

  // New inquiries in the window
  const { count: newInquiries } = await supabase
    .from('weddings')
    .select('id', { count: 'exact', head: true })
    .eq('venue_id', venueId)
    .gte('created_at', fromDate)
    .lte('created_at', toDate)

  // Tours scheduled in the window
  const { count: toursScheduled } = await supabase
    .from('weddings')
    .select('id', { count: 'exact', head: true })
    .eq('venue_id', venueId)
    .not('tour_date', 'is', null)
    .gte('tour_date', fromDate)
    .lte('tour_date', toDate)

  // Bookings confirmed in the window
  const { count: bookings } = await supabase
    .from('weddings')
    .select('id', { count: 'exact', head: true })
    .eq('venue_id', venueId)
    .eq('status', 'booked')
    .gte('booked_at', fromDate)
    .lte('booked_at', toDate)

  // Lost deals in the window
  const { count: lostDeals } = await supabase
    .from('weddings')
    .select('id', { count: 'exact', head: true })
    .eq('venue_id', venueId)
    .eq('status', 'lost')
    .gte('updated_at', fromDate)
    .lte('updated_at', toDate)

  // Revenue booked in the window
  const { data: revenueRows } = await supabase
    .from('weddings')
    .select('quoted_price')
    .eq('venue_id', venueId)
    .eq('status', 'booked')
    .gte('booked_at', fromDate)
    .lte('booked_at', toDate)

  const revenueBooked = (revenueRows ?? []).reduce(
    (sum, row) => sum + (Number(row.quoted_price) || 0),
    0
  )

  return {
    new_inquiries: newInquiries ?? 0,
    tours_scheduled: toursScheduled ?? 0,
    bookings: bookings ?? 0,
    lost_deals: lostDeals ?? 0,
    revenue_booked: revenueBooked,
  }
}

// ---------------------------------------------------------------------------
// System prompts
// ---------------------------------------------------------------------------

const WEEKLY_SYSTEM_PROMPT = `You are the intelligence analyst for a wedding venue. Generate a concise, actionable weekly briefing. Be specific with numbers. Recommendations should be concrete actions the venue can take THIS WEEK. Tone: professional but warm, like a trusted advisor.

Return a JSON object with these exact fields:
- summary: string (2-3 sentence executive summary of the week)
- trend_highlights: string[] (2-3 notable trend movements in plain English)
- weather_outlook: string (natural language weather summary for the next 14 days)
- anomaly_summary: string[] (active anomalies in plain English, empty array if none)
- recommendations: string[] (2-4 actionable recommendations for this week)

Be direct and specific. Use actual numbers from the data provided. Do not hedge or use vague language.`

const MONTHLY_SYSTEM_PROMPT = `You are the intelligence analyst for a wedding venue. Generate a strategic monthly briefing. Focus on big-picture trends, month-over-month momentum, and longer-term strategic recommendations. Tone: professional but warm, like a trusted advisor delivering a board-level summary.

Return a JSON object with these exact fields:
- summary: string (2-3 sentence executive summary of the month)
- trend_highlights: string[] (2-3 notable trend movements over the month)
- weather_outlook: string (general seasonal weather outlook)
- anomaly_summary: string[] (anomalies that occurred this month, empty array if none)
- recommendations: string[] (2-4 actionable tactical recommendations)
- strategic_recommendations: string[] (2-3 bigger-picture strategic recommendations for the coming month)

Use actual numbers. Compare current month to prior month where data allows. Be decisive in your recommendations.`

// ---------------------------------------------------------------------------
// 1. generateWeeklyBriefing
// ---------------------------------------------------------------------------

/**
 * Gathers data from the last 7 days and generates an AI-powered weekly
 * briefing. Inserts the result into ai_briefings and returns it.
 */
export async function generateWeeklyBriefing(
  venueId: string
): Promise<BriefingContent> {
  const fromDate = daysAgo(7)
  const toDate = today()

  // Gather all data sources in parallel
  const [metrics, deviations, weather, indicators, alerts] = await Promise.all([
    getWeddingMetrics(venueId, fromDate, toDate),
    detectTrendDeviations(venueId),
    getWeatherForDateRange(venueId, today(), daysFromNow(14)),
    getLatestIndicators(),
    getActiveAlerts(venueId),
  ])

  const demandScore = calculateDemandScore(indicators)

  // Build a weather summary for the AI prompt
  const weatherSummary = weather.length > 0
    ? weather.map((w) => {
        const parts = [`${w.date}:`]
        if (w.high_temp != null) parts.push(`High ${w.high_temp}F`)
        if (w.low_temp != null) parts.push(`Low ${w.low_temp}F`)
        if (w.precipitation != null) parts.push(`Precip ${w.precipitation}in`)
        if (w.conditions) parts.push(w.conditions)
        return parts.join(' ')
      }).join('\n')
    : 'No weather data available.'

  // Format trend deviations
  const trendSummary = deviations.length > 0
    ? deviations.map(
        (d) =>
          `"${d.term}" (${d.category}): ${d.direction} ${Math.abs(d.changePercent)}%`
      ).join('\n')
    : 'No significant trend deviations detected.'

  // Format anomaly alerts
  const alertSummary = (alerts ?? []).length > 0
    ? (alerts as { alert_type: string; metric_name: string; ai_explanation: string | null }[])
        .map((a) => `[${a.alert_type}] ${a.metric_name}: ${a.ai_explanation ?? 'No explanation'}`)
        .join('\n')
    : 'No active anomaly alerts.'

  // Call AI to generate the briefing narrative
  const aiResult = await callAIJson<{
    summary: string
    trend_highlights: string[]
    weather_outlook: string
    anomaly_summary: string[]
    recommendations: string[]
  }>({
    systemPrompt: WEEKLY_SYSTEM_PROMPT,
    userPrompt: `Weekly data for the venue (last 7 days):

METRICS:
- New inquiries: ${metrics.new_inquiries}
- Tours scheduled: ${metrics.tours_scheduled}
- Bookings confirmed: ${metrics.bookings}
- Lost deals: ${metrics.lost_deals}
- Revenue booked: $${metrics.revenue_booked.toLocaleString()}

DEMAND SCORE: ${demandScore.score}/100 (${demandScore.outlook})

SEARCH TREND DEVIATIONS:
${trendSummary}

14-DAY WEATHER FORECAST:
${weatherSummary}

ANOMALY ALERTS:
${alertSummary}

Generate the weekly briefing.`,
    maxTokens: 1500,
    temperature: 0.4,
    venueId,
    taskType: 'weekly_briefing',
  })

  // Assemble the full content object
  const content: BriefingContent = {
    summary: aiResult.summary,
    metrics,
    demand_outlook: { score: demandScore.score, outlook: demandScore.outlook },
    trend_highlights: aiResult.trend_highlights ?? [],
    weather_outlook: aiResult.weather_outlook,
    anomaly_summary: aiResult.anomaly_summary ?? [],
    recommendations: aiResult.recommendations ?? [],
    generated_at: new Date().toISOString(),
  }

  // Persist to ai_briefings
  const supabase = createServiceClient()
  const { error } = await supabase.from('ai_briefings').insert({
    venue_id: venueId,
    briefing_type: 'weekly',
    content,
  })

  if (error) {
    console.error('[briefings] Failed to insert weekly briefing:', error.message)
  }

  // Email the briefing to the venue's briefing address
  await deliverBriefingEmail(venueId, 'Weekly Intelligence Briefing', content.summary)

  return content
}

// ---------------------------------------------------------------------------
// 2. generateMonthlyBriefing
// ---------------------------------------------------------------------------

/**
 * Gathers data from the last 30 days, compares with the prior 30 days,
 * and generates a strategic monthly briefing.
 */
export async function generateMonthlyBriefing(
  venueId: string
): Promise<MonthlyBriefingContent> {
  const currentFrom = daysAgo(30)
  const currentTo = today()
  const priorFrom = daysAgo(60)
  const priorTo = daysAgo(31)

  // Gather current period + prior period metrics + all other data sources
  const [
    currentMetrics,
    priorMetrics,
    deviations,
    weather,
    indicators,
    alerts,
  ] = await Promise.all([
    getWeddingMetrics(venueId, currentFrom, currentTo),
    getWeddingMetrics(venueId, priorFrom, priorTo),
    detectTrendDeviations(venueId),
    getWeatherForDateRange(venueId, today(), daysFromNow(14)),
    getLatestIndicators(),
    getActiveAlerts(venueId),
  ])

  const demandScore = calculateDemandScore(indicators)

  // Month-over-month changes
  const mom = {
    inquiries_change: currentMetrics.new_inquiries - priorMetrics.new_inquiries,
    bookings_change: currentMetrics.bookings - priorMetrics.bookings,
    revenue_change: currentMetrics.revenue_booked - priorMetrics.revenue_booked,
  }

  // Build weather summary
  const weatherSummary = weather.length > 0
    ? weather.map((w) => {
        const parts = [`${w.date}:`]
        if (w.high_temp != null) parts.push(`High ${w.high_temp}F`)
        if (w.low_temp != null) parts.push(`Low ${w.low_temp}F`)
        if (w.precipitation != null) parts.push(`Precip ${w.precipitation}in`)
        if (w.conditions) parts.push(w.conditions)
        return parts.join(' ')
      }).join('\n')
    : 'No weather data available.'

  // Format trend deviations
  const trendSummary = deviations.length > 0
    ? deviations.map(
        (d) =>
          `"${d.term}" (${d.category}): ${d.direction} ${Math.abs(d.changePercent)}%`
      ).join('\n')
    : 'No significant trend deviations detected.'

  // Format anomaly alerts
  const alertSummary = (alerts ?? []).length > 0
    ? (alerts as { alert_type: string; metric_name: string; ai_explanation: string | null }[])
        .map((a) => `[${a.alert_type}] ${a.metric_name}: ${a.ai_explanation ?? 'No explanation'}`)
        .join('\n')
    : 'No active anomaly alerts.'

  // Call AI to generate the monthly briefing
  const aiResult = await callAIJson<{
    summary: string
    trend_highlights: string[]
    weather_outlook: string
    anomaly_summary: string[]
    recommendations: string[]
    strategic_recommendations: string[]
  }>({
    systemPrompt: MONTHLY_SYSTEM_PROMPT,
    userPrompt: `Monthly data for the venue (last 30 days):

CURRENT MONTH METRICS:
- New inquiries: ${currentMetrics.new_inquiries}
- Tours scheduled: ${currentMetrics.tours_scheduled}
- Bookings confirmed: ${currentMetrics.bookings}
- Lost deals: ${currentMetrics.lost_deals}
- Revenue booked: $${currentMetrics.revenue_booked.toLocaleString()}

PRIOR MONTH METRICS (for comparison):
- New inquiries: ${priorMetrics.new_inquiries}
- Tours scheduled: ${priorMetrics.tours_scheduled}
- Bookings confirmed: ${priorMetrics.bookings}
- Lost deals: ${priorMetrics.lost_deals}
- Revenue booked: $${priorMetrics.revenue_booked.toLocaleString()}

MONTH-OVER-MONTH CHANGES:
- Inquiries: ${mom.inquiries_change >= 0 ? '+' : ''}${mom.inquiries_change}
- Bookings: ${mom.bookings_change >= 0 ? '+' : ''}${mom.bookings_change}
- Revenue: ${mom.revenue_change >= 0 ? '+' : ''}$${mom.revenue_change.toLocaleString()}

DEMAND SCORE: ${demandScore.score}/100 (${demandScore.outlook})

SEARCH TREND DEVIATIONS:
${trendSummary}

UPCOMING WEATHER:
${weatherSummary}

ANOMALY ALERTS:
${alertSummary}

Generate the monthly briefing with strategic recommendations.`,
    maxTokens: 2000,
    temperature: 0.4,
    venueId,
    taskType: 'monthly_briefing',
  })

  // Assemble the full content object
  const content: MonthlyBriefingContent = {
    summary: aiResult.summary,
    metrics: currentMetrics,
    demand_outlook: { score: demandScore.score, outlook: demandScore.outlook },
    trend_highlights: aiResult.trend_highlights ?? [],
    weather_outlook: aiResult.weather_outlook,
    anomaly_summary: aiResult.anomaly_summary ?? [],
    recommendations: aiResult.recommendations ?? [],
    month_over_month: mom,
    strategic_recommendations: aiResult.strategic_recommendations ?? [],
    generated_at: new Date().toISOString(),
  }

  // Persist to ai_briefings
  const supabase2 = createServiceClient()
  const { error } = await supabase2.from('ai_briefings').insert({
    venue_id: venueId,
    briefing_type: 'monthly',
    content,
  })

  if (error) {
    console.error('[briefings] Failed to insert monthly briefing:', error.message)
  }

  // Email the briefing to the venue's briefing address
  await deliverBriefingEmail(venueId, 'Monthly Intelligence Briefing', content.summary)

  return content
}

// ---------------------------------------------------------------------------
// 3. getLatestBriefing
// ---------------------------------------------------------------------------

/**
 * Returns the most recent briefing for a venue, optionally filtered by type.
 * Defaults to 'weekly' if no type is specified.
 */
export async function getLatestBriefing(
  venueId: string,
  type: string = 'weekly'
): Promise<BriefingRow | null> {
  const supabase = createServiceClient()

  const { data, error } = await supabase
    .from('ai_briefings')
    .select('*')
    .eq('venue_id', venueId)
    .eq('briefing_type', type)
    .order('created_at', { ascending: false })
    .limit(1)
    .single()

  if (error || !data) return null

  return data as BriefingRow
}

// ---------------------------------------------------------------------------
// 4. getAllBriefings
// ---------------------------------------------------------------------------

/**
 * Returns recent briefings for a venue, newest first.
 * Default limit is 10.
 */
export async function getAllBriefings(
  venueId: string,
  limit: number = 10
): Promise<BriefingRow[]> {
  const supabase = createServiceClient()

  const { data, error } = await supabase
    .from('ai_briefings')
    .select('*')
    .eq('venue_id', venueId)
    .order('created_at', { ascending: false })
    .limit(limit)

  if (error) {
    console.error('[briefings] Error fetching briefings:', error.message)
    return []
  }

  return (data ?? []) as BriefingRow[]
}

// ---------------------------------------------------------------------------
// 5. deliverBriefingEmail (shared helper)
// ---------------------------------------------------------------------------

/**
 * Sends a briefing summary email to the venue's briefing_email address
 * using the venue's authenticated Gmail. Fails silently if Gmail is not
 * connected or no briefing_email is configured.
 */
async function deliverBriefingEmail(
  venueId: string,
  subjectPrefix: string,
  summary: string
): Promise<void> {
  try {
    const supabase = createServiceClient()
    const { data: venue } = await supabase
      .from('venues')
      .select('briefing_email, name')
      .eq('id', venueId)
      .single()

    const briefingEmail = venue?.briefing_email as string | null
    if (!briefingEmail) return

    const subject = `${venue?.name ?? 'Bloom House'} — ${subjectPrefix}`
    const body = `${subjectPrefix}\n\n${summary}\n\nView the full briefing in your Bloom House dashboard.`

    const messageId = await sendEmail(venueId, briefingEmail, subject, body)
    if (messageId) {
      console.log(`[briefings] Sent ${subjectPrefix} to ${briefingEmail}`)
    }
  } catch (err) {
    console.error(`[briefings] Email delivery failed for ${venueId}:`, err)
  }
}
