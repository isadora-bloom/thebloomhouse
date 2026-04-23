/**
 * Bloom House: Intelligence Brain Service
 *
 * The AI backbone for the intelligence dashboard. Handles:
 * - Natural language queries about venue data (NLQ)
 * - Marketing positioning suggestions from review language + trends
 * - Query feedback logging
 *
 * NLQ approach: rather than translating natural language to SQL (fragile,
 * injection risk), we pull a summary of recent venue data, feed it as context
 * alongside the question, and let the AI reason over it conversationally.
 */

import { createServiceClient } from '@/lib/supabase/service'
import { callAI, callAIJson } from '@/lib/ai/client'

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface NLQResult {
  response: string
  queryId: string
  tokensUsed: number
  cost: number
}

interface PositioningSuggestion {
  title: string
  rationale: string
  copy_example: string
}

interface PositioningSuggestionsResult {
  suggestions: PositioningSuggestion[]
}

interface VenueDataContext {
  venueName: string
  recentWeddings: WeddingSummary[]
  pipelineCounts: Record<string, number>
  sourceAttribution: SourceAttributionRow[]
  trendDeviations: TrendDeviationRow[]
  recentRecommendations: RecommendationRow[]
  weatherForecast: WeatherRow[]
  economicIndicators: Record<string, number>
  consultantMetrics: ConsultantMetricRow[]
  topPhrases: PhraseRow[]
}

interface WeddingSummary {
  id: string
  status: string
  source: string | null
  wedding_date: string | null
  guest_count_estimate: number | null
  booking_value: number | null
  inquiry_date: string | null
  booked_at: string | null
  lost_at: string | null
  lost_reason: string | null
  heat_score: number
  temperature_tier: string
}

interface SourceAttributionRow {
  source: string
  period_start: string
  period_end: string
  spend: number | null
  inquiries: number | null
  tours: number | null
  bookings: number | null
  revenue: number | null
  cost_per_inquiry: number | null
  cost_per_booking: number | null
  conversion_rate: number | null
  roi: number | null
}

interface TrendDeviationRow {
  term: string
  week: string
  interest: number
}

interface RecommendationRow {
  recommendation_type: string
  title: string
  body: string
  priority: number
  status: string
  created_at: string
}

interface WeatherRow {
  date: string
  high_temp: number | null
  low_temp: number | null
  precipitation: number | null
  conditions: string | null
}

interface ConsultantMetricRow {
  consultant_id: string
  period_start: string
  period_end: string
  inquiries_handled: number | null
  tours_booked: number | null
  bookings_closed: number | null
  conversion_rate: number | null
  avg_response_time_minutes: number | null
  avg_booking_value: number | null
}

interface PhraseRow {
  phrase: string
  theme: string
  sentiment_score: number
  frequency: number
}

// ---------------------------------------------------------------------------
// System prompt builder
// ---------------------------------------------------------------------------

function buildNLQSystemPrompt(venueName: string): string {
  return `You are the intelligence analyst for ${venueName}. You have access to the venue's recent data and your job is to answer questions about venue performance, bookings, marketing, trends, and operations.

Answer questions conversationally but precisely. Always cite specific numbers when available. If you don't have enough data to answer confidently, say so. Never make up statistics.

You understand the following data:

WEDDINGS (booking pipeline):
- Statuses: inquiry → tour_scheduled → tour_completed → proposal_sent → booked → completed. Can also be "lost" or "cancelled".
- Sources: the_knot, wedding_wire, here_comes_the_guide, zola, honeybook, google, google_ads, google_business, instagram, facebook, pinterest, tiktok, venue_calculator, website, direct, referral, walk_in, csv_import, vendor_referral, other
- Each wedding has: booking_value, guest_count_estimate, heat_score (lead temperature), temperature_tier
- Key dates: inquiry_date, wedding_date, booked_at, lost_at

SOURCE ATTRIBUTION:
- Marketing spend vs results per source (inquiries, tours, bookings, revenue)
- Calculated metrics: cost_per_inquiry, cost_per_booking, conversion_rate, ROI

SEARCH TRENDS:
- Google Trends interest scores for wedding-related terms in the venue's metro
- Recent data points show whether demand is rising or falling

TREND RECOMMENDATIONS:
- AI-generated actionable recommendations based on trend deviations
- Types: pricing, marketing, staffing, content, outreach

WEATHER:
- 14-day forecast for the venue location (high/low temps, precipitation, conditions)

ECONOMIC INDICATORS:
- Consumer sentiment, personal savings rate, disposable income, housing starts, consumer confidence
- These signal overall wedding spending appetite

CONSULTANT METRICS:
- Performance per coordinator: inquiries handled, tours booked, bookings closed, conversion rate, response time

REVIEW LANGUAGE:
- Notable phrases extracted from reviews, grouped by theme (coordinator, space, flexibility, value, etc.)
- Each phrase has a sentiment score and frequency count

When answering:
- Be direct and actionable — venue owners are busy
- Compare numbers when relevant (this month vs last, one source vs another)
- If asked about trends, explain what the trend means for the business
- If asked "how are we doing", give a balanced overview covering pipeline health, conversion, and any notable signals
- Format currency as dollars, percentages to one decimal place
- Use markdown formatting for readability (bold key numbers, use bullet points for lists)`
}

// ---------------------------------------------------------------------------
// Data gathering
// ---------------------------------------------------------------------------

/**
 * Pull a summary of recent venue data for the AI to reason over.
 * Gathers the last 30 days of weddings, latest attribution, trends, etc.
 */
async function gatherVenueData(venueId: string): Promise<VenueDataContext> {
  const supabase = createServiceClient()

  const thirtyDaysAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000)
    .toISOString()
    .split('T')[0]

  const fourteenDaysFromNow = new Date(Date.now() + 14 * 24 * 60 * 60 * 1000)
    .toISOString()
    .split('T')[0]

  const today = new Date().toISOString().split('T')[0]

  // Run all queries in parallel
  const [
    venueResult,
    weddingsResult,
    allWeddingsResult,
    attributionResult,
    trendsResult,
    recommendationsResult,
    weatherResult,
    consultantResult,
    phrasesResult,
    indicatorsResult,
  ] = await Promise.all([
    // Venue name
    supabase
      .from('venues')
      .select('name')
      .eq('id', venueId)
      .single(),

    // Recent weddings (inquiries/status changes in last 30 days)
    supabase
      .from('weddings')
      .select('id, status, source, wedding_date, guest_count_estimate, booking_value, inquiry_date, booked_at, lost_at, lost_reason, heat_score, temperature_tier')
      .eq('venue_id', venueId)
      .gte('updated_at', thirtyDaysAgo)
      .order('updated_at', { ascending: false })
      .limit(50),

    // All active weddings for pipeline counts
    supabase
      .from('weddings')
      .select('status')
      .eq('venue_id', venueId)
      .not('status', 'in', '("completed","lost","cancelled")'),

    // Latest source attribution
    supabase
      .from('source_attribution')
      .select('source, period_start, period_end, spend, inquiries, tours, bookings, revenue, cost_per_inquiry, cost_per_booking, conversion_rate, roi')
      .eq('venue_id', venueId)
      .order('calculated_at', { ascending: false })
      .limit(20),

    // Recent trend data (last 8 weeks)
    supabase
      .from('search_trends')
      .select('term, week, interest')
      .eq('venue_id', venueId)
      .gte('week', new Date(Date.now() - 8 * 7 * 24 * 60 * 60 * 1000).toISOString().split('T')[0])
      .order('week', { ascending: false })
      .limit(100),

    // Recent recommendations
    supabase
      .from('trend_recommendations')
      .select('recommendation_type, title, body, priority, status, created_at')
      .eq('venue_id', venueId)
      .order('created_at', { ascending: false })
      .limit(10),

    // Weather forecast (next 14 days)
    supabase
      .from('weather_data')
      .select('date, high_temp, low_temp, precipitation, conditions')
      .eq('venue_id', venueId)
      .gte('date', today)
      .lte('date', fourteenDaysFromNow)
      .order('date', { ascending: true }),

    // Consultant metrics (most recent period)
    supabase
      .from('consultant_metrics')
      .select('consultant_id, period_start, period_end, inquiries_handled, tours_booked, bookings_closed, conversion_rate, avg_response_time_minutes, avg_booking_value')
      .eq('venue_id', venueId)
      .order('calculated_at', { ascending: false })
      .limit(10),

    // Top review phrases
    supabase
      .from('review_language')
      .select('phrase, theme, sentiment_score, frequency')
      .eq('venue_id', venueId)
      .order('frequency', { ascending: false })
      .limit(15),

    // Latest economic indicators
    supabase
      .from('economic_indicators')
      .select('indicator_name, value')
      .order('date', { ascending: false })
      .limit(10),
  ])

  // Build pipeline counts from active weddings
  const pipelineCounts: Record<string, number> = {}
  for (const row of allWeddingsResult.data ?? []) {
    const status = row.status as string
    pipelineCounts[status] = (pipelineCounts[status] ?? 0) + 1
  }

  // Deduplicate economic indicators (take latest per indicator)
  const indicators: Record<string, number> = {}
  for (const row of indicatorsResult.data ?? []) {
    const name = row.indicator_name as string
    if (!(name in indicators)) {
      indicators[name] = Number(row.value)
    }
  }

  return {
    venueName: (venueResult.data?.name as string) ?? 'Unknown Venue',
    recentWeddings: (weddingsResult.data ?? []) as WeddingSummary[],
    pipelineCounts,
    sourceAttribution: (attributionResult.data ?? []) as SourceAttributionRow[],
    trendDeviations: (trendsResult.data ?? []) as TrendDeviationRow[],
    recentRecommendations: (recommendationsResult.data ?? []) as RecommendationRow[],
    weatherForecast: (weatherResult.data ?? []) as WeatherRow[],
    economicIndicators: indicators,
    consultantMetrics: (consultantResult.data ?? []) as ConsultantMetricRow[],
    topPhrases: (phrasesResult.data ?? []) as PhraseRow[],
  }
}

/**
 * Format venue data into a readable context block for the AI.
 */
function formatDataContext(data: VenueDataContext): string {
  const sections: string[] = []

  // Pipeline summary
  if (Object.keys(data.pipelineCounts).length > 0) {
    const pipelineLines = Object.entries(data.pipelineCounts)
      .map(([status, count]) => `  ${status}: ${count}`)
      .join('\n')
    sections.push(`ACTIVE PIPELINE:\n${pipelineLines}`)
  }

  // Recent weddings
  if (data.recentWeddings.length > 0) {
    const weddingLines = data.recentWeddings.map((w) => {
      const parts = [`status=${w.status}`, `source=${w.source ?? 'unknown'}`]
      if (w.booking_value) parts.push(`value=$${w.booking_value}`)
      if (w.guest_count_estimate) parts.push(`guests=${w.guest_count_estimate}`)
      if (w.wedding_date) parts.push(`date=${w.wedding_date}`)
      if (w.inquiry_date) parts.push(`inquiry=${w.inquiry_date}`)
      if (w.heat_score) parts.push(`heat=${w.heat_score} (${w.temperature_tier})`)
      if (w.lost_reason) parts.push(`lost_reason="${w.lost_reason}"`)
      return `  - ${parts.join(', ')}`
    }).join('\n')
    sections.push(`RECENT WEDDINGS (last 30 days activity):\n${weddingLines}`)
  } else {
    sections.push('RECENT WEDDINGS: No wedding activity in the last 30 days.')
  }

  // Source attribution
  if (data.sourceAttribution.length > 0) {
    const attrLines = data.sourceAttribution.map((a) => {
      const parts = [`source=${a.source}`, `period=${a.period_start} to ${a.period_end}`]
      if (a.spend != null) parts.push(`spend=$${a.spend}`)
      if (a.inquiries != null) parts.push(`inquiries=${a.inquiries}`)
      if (a.tours != null) parts.push(`tours=${a.tours}`)
      if (a.bookings != null) parts.push(`bookings=${a.bookings}`)
      if (a.revenue != null) parts.push(`revenue=$${a.revenue}`)
      if (a.cost_per_inquiry != null) parts.push(`CPI=$${a.cost_per_inquiry}`)
      if (a.cost_per_booking != null) parts.push(`CPB=$${a.cost_per_booking}`)
      if (a.conversion_rate != null) parts.push(`conv=${a.conversion_rate}%`)
      if (a.roi != null) parts.push(`ROI=${a.roi}%`)
      return `  - ${parts.join(', ')}`
    }).join('\n')
    sections.push(`SOURCE ATTRIBUTION:\n${attrLines}`)
  }

  // Search trends
  if (data.trendDeviations.length > 0) {
    // Group by term and show latest interest values
    const byTerm = new Map<string, { week: string; interest: number }[]>()
    for (const row of data.trendDeviations) {
      if (!byTerm.has(row.term)) byTerm.set(row.term, [])
      byTerm.get(row.term)!.push({ week: row.week, interest: row.interest })
    }
    const trendLines = Array.from(byTerm.entries())
      .map(([term, points]) => {
        const sorted = points.sort((a, b) => b.week.localeCompare(a.week))
        const latest = sorted[0]
        const oldest = sorted[sorted.length - 1]
        return `  - "${term}": latest=${latest.interest} (${latest.week}), earliest in window=${oldest.interest} (${oldest.week})`
      })
      .join('\n')
    sections.push(`SEARCH TRENDS (last 8 weeks):\n${trendLines}`)
  }

  // Recommendations
  if (data.recentRecommendations.length > 0) {
    const recLines = data.recentRecommendations.map((r) =>
      `  - [${r.recommendation_type}] ${r.title} (priority=${r.priority}, status=${r.status})`
    ).join('\n')
    sections.push(`RECENT AI RECOMMENDATIONS:\n${recLines}`)
  }

  // Weather
  if (data.weatherForecast.length > 0) {
    const weatherLines = data.weatherForecast.map((w) =>
      `  - ${w.date}: ${w.conditions ?? 'N/A'}, high=${w.high_temp ?? '?'}°F, low=${w.low_temp ?? '?'}°F, precip=${w.precipitation ?? 0}in`
    ).join('\n')
    sections.push(`WEATHER FORECAST (next 14 days):\n${weatherLines}`)
  }

  // Economic indicators
  if (Object.keys(data.economicIndicators).length > 0) {
    const ecoLines = Object.entries(data.economicIndicators)
      .map(([name, value]) => `  - ${name}: ${value}`)
      .join('\n')
    sections.push(`ECONOMIC INDICATORS (latest):\n${ecoLines}`)
  }

  // Consultant metrics
  if (data.consultantMetrics.length > 0) {
    const consultLines = data.consultantMetrics.map((c) => {
      const parts = [`consultant=${c.consultant_id.substring(0, 8)}...`]
      if (c.inquiries_handled != null) parts.push(`inquiries=${c.inquiries_handled}`)
      if (c.tours_booked != null) parts.push(`tours=${c.tours_booked}`)
      if (c.bookings_closed != null) parts.push(`bookings=${c.bookings_closed}`)
      if (c.conversion_rate != null) parts.push(`conv=${c.conversion_rate}%`)
      if (c.avg_response_time_minutes != null) parts.push(`avg_response=${c.avg_response_time_minutes}min`)
      if (c.avg_booking_value != null) parts.push(`avg_value=$${c.avg_booking_value}`)
      return `  - ${parts.join(', ')}`
    }).join('\n')
    sections.push(`CONSULTANT METRICS:\n${consultLines}`)
  }

  // Review language
  if (data.topPhrases.length > 0) {
    const phraseLines = data.topPhrases.map((p) =>
      `  - "${p.phrase}" (theme=${p.theme}, sentiment=${p.sentiment_score}, freq=${p.frequency})`
    ).join('\n')
    sections.push(`TOP REVIEW PHRASES:\n${phraseLines}`)
  }

  return sections.join('\n\n')
}

// ---------------------------------------------------------------------------
// Exported functions
// ---------------------------------------------------------------------------

/**
 * Answer a natural language question about venue data.
 *
 * Gathers recent venue data (weddings, attribution, trends, weather, etc.),
 * feeds it as context alongside the question to the AI, logs the query and
 * response, and returns the answer.
 */
export async function answerNaturalLanguageQuery(
  venueId: string,
  userId: string,
  query: string
): Promise<NLQResult> {
  const supabase = createServiceClient()

  // Gather all relevant venue data
  const venueData = await gatherVenueData(venueId)
  const dataContext = formatDataContext(venueData)

  // Call AI with venue data as context
  const aiResult = await callAI({
    systemPrompt: buildNLQSystemPrompt(venueData.venueName),
    userPrompt: `Here is the current data for ${venueData.venueName}:\n\n${dataContext}\n\n---\n\nQuestion: ${query}`,
    maxTokens: 1500,
    temperature: 0.3,
    venueId,
    taskType: 'natural_language_query',
  })

  // Log the query and response
  const { data: logEntry, error: logError } = await supabase
    .from('natural_language_queries')
    .insert({
      venue_id: venueId,
      user_id: userId,
      query_text: query,
      response_text: aiResult.text,
      model_used: 'claude-sonnet-4-20250514',
      tokens_used: aiResult.inputTokens + aiResult.outputTokens,
      cost: aiResult.cost,
    })
    .select('id')
    .single()

  if (logError) {
    console.error('[intel-brain] Failed to log NLQ:', logError.message)
  }

  return {
    response: aiResult.text,
    queryId: (logEntry?.id as string) ?? '',
    tokensUsed: aiResult.inputTokens + aiResult.outputTokens,
    cost: aiResult.cost,
  }
}

/**
 * Generate 3-5 marketing positioning suggestions based on review language,
 * trend data, and venue configuration.
 */
export async function generatePositioningSuggestions(
  venueId: string
): Promise<PositioningSuggestionsResult> {
  const supabase = createServiceClient()

  // Pull review language, trend data, and venue config in parallel
  const [venueResult, configResult, phrasesResult, trendsResult, attributionResult] = await Promise.all([
    supabase
      .from('venues')
      .select('name')
      .eq('id', venueId)
      .single(),

    supabase
      .from('venue_config')
      .select('business_name, catering_model, bar_model, capacity, base_price')
      .eq('venue_id', venueId)
      .single(),

    supabase
      .from('review_language')
      .select('phrase, theme, sentiment_score, frequency')
      .eq('venue_id', venueId)
      .order('frequency', { ascending: false })
      .limit(25),

    supabase
      .from('search_trends')
      .select('term, week, interest')
      .eq('venue_id', venueId)
      .gte('week', new Date(Date.now() - 8 * 7 * 24 * 60 * 60 * 1000).toISOString().split('T')[0])
      .order('week', { ascending: false })
      .limit(80),

    supabase
      .from('source_attribution')
      .select('source, inquiries, bookings, revenue, roi')
      .eq('venue_id', venueId)
      .order('calculated_at', { ascending: false })
      .limit(10),
  ])

  const venueName = (venueResult.data?.name as string) ?? 'the venue'
  const config = configResult.data
  const phrases = phrasesResult.data ?? []
  const trends = trendsResult.data ?? []
  const attribution = attributionResult.data ?? []

  // Build context for positioning AI
  const contextParts: string[] = []

  contextParts.push(`Venue: ${venueName}`)
  if (config) {
    const details: string[] = []
    if (config.capacity) details.push(`capacity=${config.capacity}`)
    if (config.base_price) details.push(`base_price=$${config.base_price}`)
    if (config.catering_model) details.push(`catering=${config.catering_model}`)
    if (config.bar_model) details.push(`bar=${config.bar_model}`)
    if (details.length > 0) contextParts.push(`Venue details: ${details.join(', ')}`)
  }

  if (phrases.length > 0) {
    const phrasesByTheme = new Map<string, string[]>()
    for (const p of phrases) {
      const theme = p.theme as string
      if (!phrasesByTheme.has(theme)) phrasesByTheme.set(theme, [])
      phrasesByTheme.get(theme)!.push(`"${p.phrase}" (sentiment=${p.sentiment_score}, freq=${p.frequency})`)
    }
    const phraseText = Array.from(phrasesByTheme.entries())
      .map(([theme, items]) => `  ${theme}: ${items.join(', ')}`)
      .join('\n')
    contextParts.push(`Review language by theme:\n${phraseText}`)
  }

  if (trends.length > 0) {
    const byTerm = new Map<string, number[]>()
    for (const t of trends) {
      const term = t.term as string
      if (!byTerm.has(term)) byTerm.set(term, [])
      byTerm.get(term)!.push(t.interest as number)
    }
    const trendText = Array.from(byTerm.entries())
      .map(([term, values]) => `  "${term}": avg interest=${Math.round(values.reduce((s, v) => s + v, 0) / values.length)}`)
      .join('\n')
    contextParts.push(`Trending search terms:\n${trendText}`)
  }

  if (attribution.length > 0) {
    const attrText = attribution.map((a) => {
      const parts = [`${a.source}`]
      if (a.inquiries != null) parts.push(`inq=${a.inquiries}`)
      if (a.bookings != null) parts.push(`bookings=${a.bookings}`)
      if (a.roi != null) parts.push(`ROI=${a.roi}%`)
      return `  ${parts.join(', ')}`
    }).join('\n')
    contextParts.push(`Source performance:\n${attrText}`)
  }

  const result = await callAIJson<PositioningSuggestionsResult>({
    systemPrompt: `You are a wedding venue marketing strategist. Given a venue's review language, search trends, and performance data, generate 3-5 marketing positioning suggestions.

Each suggestion should:
- Identify a specific angle or message the venue should lean into
- Be grounded in actual data (what guests say, what people search for, what converts)
- Include a concrete copy example the venue could use on their website, social media, or advertising

Return JSON matching this structure:
{
  "suggestions": [
    {
      "title": "Short positioning headline (under 60 chars)",
      "rationale": "2-3 sentences explaining why this positioning works, citing specific data points",
      "copy_example": "A sample marketing line or paragraph the venue could use"
    }
  ]
}

Rules:
- Ground every suggestion in the data provided — don't invent themes not reflected in reviews or trends
- Make copy examples sound human and warm, not corporate
- Prioritize suggestions by potential impact (strongest positioning first)
- If search trends show rising interest in a specific wedding type, suggest capitalizing on it
- If reviews consistently praise something, suggest making it a headline feature`,

    userPrompt: contextParts.join('\n\n'),
    maxTokens: 1500,
    temperature: 0.5,
    venueId,
    taskType: 'positioning_suggestions',
  })

  // Validate the response
  if (!result.suggestions || !Array.isArray(result.suggestions)) {
    return { suggestions: [] }
  }

  // Filter out any malformed suggestions
  const validSuggestions = result.suggestions.filter(
    (s) => s.title && s.rationale && s.copy_example
  )

  return { suggestions: validSuggestions }
}

/**
 * Mark a previously logged NLQ as helpful or not helpful.
 * Used to improve future responses through feedback tracking.
 */
export async function markQueryHelpful(
  queryId: string,
  helpful: boolean
): Promise<void> {
  const supabase = createServiceClient()

  const { error } = await supabase
    .from('natural_language_queries')
    .update({ helpful })
    .eq('id', queryId)

  if (error) throw error
}
