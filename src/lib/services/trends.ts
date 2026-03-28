/**
 * Bloom House: Google Trends Ingestion Service
 *
 * Fetches search trend data via SerpAPI and stores it in the search_trends table.
 * Detects deviations and uses AI to generate actionable recommendations.
 *
 * Terms tracked:
 *  - Core demand: "wedding venue", "wedding venues", "barn wedding venue",
 *    "outdoor wedding venue", "wedding photographer"
 *  - Leading indicators (3-12 month lag): "engagement ring", "how to propose"
 *  - Dampeners: "divorce lawyer"
 */

import { createServiceClient } from '@/lib/supabase/service'
import { callAIJson } from '@/lib/ai/client'

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const SERPAPI_ENDPOINT = 'https://serpapi.com/search.json'
const THROTTLE_MS = 800

const TREND_TERMS = {
  core: [
    'wedding venue',
    'wedding venues',
    'barn wedding venue',
    'outdoor wedding venue',
    'wedding photographer',
  ],
  leading: ['engagement ring', 'how to propose'],
  dampener: ['divorce lawyer'],
} as const

const ALL_TERMS = [
  ...TREND_TERMS.core,
  ...TREND_TERMS.leading,
  ...TREND_TERMS.dampener,
]

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface TimelinePoint {
  date: string
  values: { value: string; extracted_value: number }[]
}

interface SerpAPITrendsResponse {
  interest_over_time?: {
    timeline_data?: TimelinePoint[]
  }
  error?: string
}

interface TrendDeviation {
  term: string
  category: 'core' | 'leading' | 'dampener'
  recentAvg: number
  priorAvg: number
  changePercent: number
  direction: 'up' | 'down'
}

interface TrendRecommendation {
  recommendation_type: string
  title: string
  body: string
  priority: number
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function getTermCategory(term: string): 'core' | 'leading' | 'dampener' {
  if ((TREND_TERMS.leading as readonly string[]).includes(term)) return 'leading'
  if ((TREND_TERMS.dampener as readonly string[]).includes(term)) return 'dampener'
  return 'core'
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/**
 * Fetch Google Trends data for a single term in a geo region via SerpAPI.
 * Returns parsed timeline data or an empty array if the key is missing or the request fails.
 */
async function fetchSerpAPITrends(
  term: string,
  geo: string,
  apiKey: string
): Promise<{ week: string; interest: number }[]> {
  const params = new URLSearchParams({
    engine: 'google_trends',
    q: term,
    geo,
    date: 'today 3-m',
    api_key: apiKey,
  })

  const url = `${SERPAPI_ENDPOINT}?${params.toString()}`

  let response: Response
  try {
    response = await fetch(url)
  } catch (err) {
    console.error(`[trends] Network error fetching "${term}" for geo ${geo}:`, err)
    return []
  }

  if (!response.ok) {
    console.error(`[trends] SerpAPI returned ${response.status} for "${term}"`)
    return []
  }

  let body: SerpAPITrendsResponse
  try {
    body = (await response.json()) as SerpAPITrendsResponse
  } catch {
    console.error(`[trends] Failed to parse SerpAPI response for "${term}"`)
    return []
  }

  if (body.error) {
    console.error(`[trends] SerpAPI error for "${term}":`, body.error)
    return []
  }

  const timeline = body.interest_over_time?.timeline_data
  if (!timeline || timeline.length === 0) return []

  return timeline.map((point) => {
    // The date string can be "Mar 2 – 8, 2026" — grab the first date portion
    const rawDate = point.date.split('–')[0].trim()
    // Parse to a stable ISO date for the week start
    const parsed = new Date(rawDate)
    const week = isNaN(parsed.getTime())
      ? point.date
      : parsed.toISOString().split('T')[0]

    const interest = point.values?.[0]?.extracted_value ?? 0
    return { week, interest }
  })
}

// ---------------------------------------------------------------------------
// Core functions
// ---------------------------------------------------------------------------

/**
 * Fetch Google Trends data for a single venue's metro area and upsert into search_trends.
 * Returns the count of rows upserted.
 */
export async function fetchTrendsForVenue(venueId: string): Promise<number> {
  const apiKey = process.env.SERPAPI_KEY
  if (!apiKey) {
    console.warn('[trends] SERPAPI_KEY not configured — skipping trend fetch')
    return 0
  }

  const supabase = createServiceClient()

  // Look up the venue's metro geo code
  const { data: venue, error: venueError } = await supabase
    .from('venues')
    .select('id, google_trends_metro')
    .eq('id', venueId)
    .single()

  if (venueError || !venue) {
    console.error(`[trends] Venue ${venueId} not found:`, venueError?.message)
    return 0
  }

  const metro = venue.google_trends_metro as string | null
  if (!metro) {
    console.warn(`[trends] Venue ${venueId} has no google_trends_metro set — skipping`)
    return 0
  }

  let totalUpserted = 0

  for (let i = 0; i < ALL_TERMS.length; i++) {
    const term = ALL_TERMS[i]

    // Throttle between requests
    if (i > 0) await sleep(THROTTLE_MS)

    const points = await fetchSerpAPITrends(term, metro, apiKey)
    if (points.length === 0) continue

    // Build upsert rows
    const rows = points.map((p) => ({
      venue_id: venueId,
      metro,
      term,
      week: p.week,
      interest: p.interest,
    }))

    // Upsert — if (metro, term, week) already exists, update interest
    const { error: upsertError, count } = await supabase
      .from('search_trends')
      .upsert(rows, { onConflict: 'metro,term,week', ignoreDuplicates: false })
      .select('id')

    if (upsertError) {
      console.error(`[trends] Upsert error for "${term}":`, upsertError.message)
    } else {
      totalUpserted += count ?? rows.length
    }
  }

  console.log(`[trends] Fetched ${totalUpserted} data points for venue ${venueId}`)
  return totalUpserted
}

/**
 * Fetch trends for every venue that has a google_trends_metro configured.
 * Returns a map of venueId -> count of rows upserted.
 */
export async function fetchAllVenueTrends(): Promise<Record<string, number>> {
  const apiKey = process.env.SERPAPI_KEY
  if (!apiKey) {
    console.warn('[trends] SERPAPI_KEY not configured — skipping all venue trend fetch')
    return {}
  }

  const supabase = createServiceClient()

  const { data: venues, error } = await supabase
    .from('venues')
    .select('id')
    .not('google_trends_metro', 'is', null)

  if (error || !venues || venues.length === 0) {
    console.warn('[trends] No venues with google_trends_metro found')
    return {}
  }

  const results: Record<string, number> = {}

  for (const venue of venues) {
    const id = venue.id as string
    results[id] = await fetchTrendsForVenue(id)
  }

  return results
}

/**
 * Compare the last 4 weeks of trend data to the prior 4 weeks for a venue.
 * Returns terms with greater than 20% deviation.
 */
export async function detectTrendDeviations(
  venueId: string
): Promise<TrendDeviation[]> {
  const supabase = createServiceClient()

  // Get the venue's metro
  const { data: venue } = await supabase
    .from('venues')
    .select('google_trends_metro')
    .eq('id', venueId)
    .single()

  const metro = venue?.google_trends_metro as string | null
  if (!metro) return []

  // Fetch the last 8 weeks of data for this metro
  const eightWeeksAgo = new Date(Date.now() - 8 * 7 * 24 * 60 * 60 * 1000)
    .toISOString()
    .split('T')[0]

  const { data: rows } = await supabase
    .from('search_trends')
    .select('term, week, interest')
    .eq('metro', metro)
    .gte('week', eightWeeksAgo)
    .order('week', { ascending: true })

  if (!rows || rows.length === 0) return []

  // Group by term
  const byTerm = new Map<string, { week: string; interest: number }[]>()
  for (const row of rows) {
    const term = row.term as string
    if (!byTerm.has(term)) byTerm.set(term, [])
    byTerm.get(term)!.push({
      week: row.week as string,
      interest: row.interest as number,
    })
  }

  const deviations: TrendDeviation[] = []

  for (const [term, points] of byTerm) {
    // Sort by week ascending
    points.sort((a, b) => a.week.localeCompare(b.week))

    if (points.length < 4) continue

    // Split into recent 4 and prior (everything before the last 4)
    const recent = points.slice(-4)
    const prior = points.slice(0, -4)

    if (prior.length === 0) continue

    const recentAvg = recent.reduce((s, p) => s + p.interest, 0) / recent.length
    const priorAvg = prior.reduce((s, p) => s + p.interest, 0) / prior.length

    // Avoid division by zero
    if (priorAvg === 0) continue

    const changePercent = ((recentAvg - priorAvg) / priorAvg) * 100

    if (Math.abs(changePercent) > 20) {
      deviations.push({
        term,
        category: getTermCategory(term),
        recentAvg: Math.round(recentAvg * 10) / 10,
        priorAvg: Math.round(priorAvg * 10) / 10,
        changePercent: Math.round(changePercent * 10) / 10,
        direction: changePercent > 0 ? 'up' : 'down',
      })
    }
  }

  // Sort by absolute change descending
  deviations.sort((a, b) => Math.abs(b.changePercent) - Math.abs(a.changePercent))

  return deviations
}

/**
 * Use AI to generate actionable recommendations from detected trend deviations.
 * Inserts recommendations into the trend_recommendations table.
 * Returns the number of recommendations generated.
 */
export async function generateTrendRecommendations(
  venueId: string
): Promise<number> {
  const deviations = await detectTrendDeviations(venueId)

  if (deviations.length === 0) {
    console.log(`[trends] No significant deviations for venue ${venueId} — no recommendations`)
    return 0
  }

  const recommendations = await callAIJson<TrendRecommendation[]>({
    systemPrompt: `You are a wedding venue market intelligence analyst. Given Google Trends
deviation data for a venue's metro area, generate 1-3 concise, actionable recommendations
the venue team can act on this week.

Term categories:
- "core" terms reflect direct wedding demand
- "leading" terms (engagement ring, how to propose) predict demand 3-12 months out
- "dampener" terms (divorce lawyer) may signal market softening

Return a JSON array of objects with these fields:
- recommendation_type: one of "pricing", "marketing", "staffing", "content", "outreach"
- title: short headline (under 80 chars)
- body: 2-3 sentence explanation with specific actions
- priority: 1 (urgent), 2 (important), 3 (informational)

Consider:
- Rising core terms → increase ad spend, adjust pricing up, staff up for tours
- Falling core terms → run promotions, double down on content marketing
- Rising leading indicators → prepare for future demand surge, lock in vendor partnerships
- Rising dampeners → diversify event types, focus retention of existing bookings`,

    userPrompt: `Trend deviations detected for this venue's metro area:

${deviations.map((d) => `- "${d.term}" (${d.category}): ${d.direction} ${Math.abs(d.changePercent)}% (recent avg: ${d.recentAvg}, prior avg: ${d.priorAvg})`).join('\n')}

Generate recommendations based on these deviations.`,

    maxTokens: 1000,
    temperature: 0.4,
    venueId,
    taskType: 'trend_recommendations',
  })

  if (!Array.isArray(recommendations) || recommendations.length === 0) {
    console.warn('[trends] AI returned no valid recommendations')
    return 0
  }

  const supabase = createServiceClient()

  const rows = recommendations.map((rec) => ({
    venue_id: venueId,
    recommendation_type: rec.recommendation_type,
    title: rec.title,
    body: rec.body,
    data_source: 'google_trends',
    supporting_data: { deviations },
    priority: rec.priority,
    status: 'pending',
  }))

  const { error } = await supabase
    .from('trend_recommendations')
    .insert(rows)

  if (error) {
    console.error('[trends] Failed to insert recommendations:', error.message)
    return 0
  }

  console.log(`[trends] Generated ${rows.length} recommendations for venue ${venueId}`)
  return rows.length
}
