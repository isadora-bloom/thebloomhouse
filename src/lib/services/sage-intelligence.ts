/**
 * Bloom House: Sage Intelligence Context Service
 *
 * Connects the intelligence loop (trends, weather, reviews, economics,
 * anomalies) to the Sage AI personality for couple-facing chat.
 *
 * Sage should sound informed about what's happening at the venue and in the
 * market — drawing on real data rather than generic responses. When a couple
 * asks "how popular is this venue?", Sage should know the actual demand
 * trend. When they ask about the space, Sage should use language from real
 * reviews.
 */

import { createServiceClient } from '@/lib/supabase/service'
import { getLatestIndicators, calculateDemandScore } from '@/lib/services/economics'
import { detectTrendDeviations } from '@/lib/services/trends'

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface SeasonalContext {
  season: string
  imagery: string[]
  phrases: string[]
}

export interface ReviewVocabulary {
  [theme: string]: {
    phrases: string[]
    topSentiment: number
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function getCurrentSeason(): string {
  const month = new Date().getMonth() // 0-indexed
  if (month >= 2 && month <= 4) return 'spring'
  if (month >= 5 && month <= 7) return 'summer'
  if (month >= 8 && month <= 10) return 'fall'
  return 'winter'
}

function daysUntil(dateStr: string): number {
  const target = new Date(dateStr)
  const now = new Date()
  return Math.ceil((target.getTime() - now.getTime()) / (1000 * 60 * 60 * 24))
}

// ---------------------------------------------------------------------------
// Exported: getSeasonalContext
// ---------------------------------------------------------------------------

/**
 * Get the current season's imagery and phrases from venue_seasonal_content.
 * Returns the season name, imagery descriptions, and phrases Sage can use.
 */
export async function getSeasonalContext(venueId: string): Promise<SeasonalContext> {
  const season = getCurrentSeason()
  const supabase = createServiceClient()

  const { data, error } = await supabase
    .from('venue_seasonal_content')
    .select('imagery, phrases')
    .eq('venue_id', venueId)
    .eq('season', season)
    .single()

  if (error || !data) {
    return { season, imagery: [], phrases: [] }
  }

  return {
    season,
    imagery: (data.imagery as string[]) ?? [],
    phrases: (data.phrases as string[]) ?? [],
  }
}

// ---------------------------------------------------------------------------
// Exported: getReviewVocabulary
// ---------------------------------------------------------------------------

/**
 * Get approved-for-sage phrases grouped by theme. Sage should use these
 * naturally when discussing the venue — they come from real couple reviews.
 */
export async function getReviewVocabulary(venueId: string): Promise<ReviewVocabulary> {
  const supabase = createServiceClient()

  const { data, error } = await supabase
    .from('review_language')
    .select('phrase, theme, sentiment_score')
    .eq('venue_id', venueId)
    .eq('approved_for_sage', true)
    .order('frequency', { ascending: false })

  if (error || !data || data.length === 0) return {}

  const vocabulary: ReviewVocabulary = {}

  for (const row of data) {
    const theme = row.theme as string
    if (!vocabulary[theme]) {
      vocabulary[theme] = { phrases: [], topSentiment: 0 }
    }
    vocabulary[theme].phrases.push(row.phrase as string)
    // Track the highest sentiment for each theme
    const sentiment = row.sentiment_score as number
    if (sentiment > vocabulary[theme].topSentiment) {
      vocabulary[theme].topSentiment = sentiment
    }
  }

  return vocabulary
}

// ---------------------------------------------------------------------------
// Exported: buildWeatherDisclaimer
// ---------------------------------------------------------------------------

/**
 * If the couple has a wedding date, pull forecast data and generate a brief
 * weather context for Sage. Returns null if no forecast available or the
 * date is too far out (beyond 14 days).
 */
export async function buildWeatherDisclaimer(
  venueId: string,
  eventDate?: string
): Promise<string | null> {
  if (!eventDate) return null

  const days = daysUntil(eventDate)

  // Only provide forecast context within the 14-day window
  if (days < 0 || days > 14) return null

  const supabase = createServiceClient()

  const { data, error } = await supabase
    .from('weather_data')
    .select('date, high_temp, low_temp, precipitation, conditions')
    .eq('venue_id', venueId)
    .eq('date', eventDate)
    .eq('source', 'open_meteo')
    .single()

  if (error || !data) return null

  const high = data.high_temp as number | null
  const low = data.low_temp as number | null
  const precip = data.precipitation as number | null
  const conditions = data.conditions as string | null

  const parts: string[] = []

  if (conditions) {
    parts.push(`The forecast for their wedding date (${eventDate}) shows ${conditions.toLowerCase()}.`)
  }

  if (high != null && low != null) {
    parts.push(`Expected temperatures: high of ${Math.round(high)}°F, low of ${Math.round(low)}°F.`)
  }

  if (precip != null && precip > 0.1) {
    parts.push(`There's some precipitation expected (${precip.toFixed(1)} inches).`)
  } else if (precip != null) {
    parts.push('Little to no precipitation expected.')
  }

  if (parts.length === 0) return null

  // Add a gentle disclaimer — forecasts change
  if (days > 7) {
    parts.push('This forecast is still over a week out and could change.')
  }

  return parts.join(' ')
}

// ---------------------------------------------------------------------------
// Exported: buildSageIntelligenceContext
// ---------------------------------------------------------------------------

/**
 * Gathers current intelligence data and formats it as additional context
 * for Sage's system prompt. Returns a string block that can be appended
 * to Sage's prompt so the AI sounds informed about the venue and market.
 *
 * Includes:
 *  - Current demand outlook (score + description)
 *  - Active trend highlights (top 3 moving terms)
 *  - Upcoming weather for the next 14 days (brief summary)
 *  - Top approved review phrases (for Sage to naturally weave in)
 *  - Any active anomaly alerts the couple might ask about
 */
export async function buildSageIntelligenceContext(venueId: string): Promise<string> {
  const supabase = createServiceClient()
  const sections: string[] = []

  // --- Demand outlook ---
  try {
    const indicators = await getLatestIndicators()
    if (Object.keys(indicators).length > 0) {
      const { score, outlook } = calculateDemandScore(indicators)

      const outlookDescriptions = {
        positive: 'Wedding demand signals are strong right now — couples are actively searching and booking.',
        neutral: 'Wedding demand is steady — the market is tracking at normal levels.',
        caution: 'Wedding demand signals are softer than usual — the market may be cooling slightly.',
      }

      sections.push(
        `DEMAND OUTLOOK (score: ${score}/100, trend: ${outlook}):\n` +
          outlookDescriptions[outlook]
      )
    }
  } catch (err) {
    console.warn('[sage-intel] Failed to fetch demand outlook:', err)
  }

  // --- Trend highlights (top 3 most significant deviations) ---
  try {
    const deviations = await detectTrendDeviations(venueId)

    if (deviations.length > 0) {
      const topThree = deviations.slice(0, 3)
      const trendLines = topThree.map((d) => {
        const arrow = d.direction === 'up' ? 'rising' : 'falling'
        return `- "${d.term}" is ${arrow} ${Math.abs(d.changePercent)}% (${d.category} indicator)`
      })
      sections.push(`TREND HIGHLIGHTS:\n${trendLines.join('\n')}`)
    }
  } catch (err) {
    console.warn('[sage-intel] Failed to fetch trend deviations:', err)
  }

  // --- Weather summary (next 14 days) ---
  try {
    const today = new Date().toISOString().split('T')[0]
    const fourteenDays = new Date(Date.now() + 14 * 24 * 60 * 60 * 1000)
      .toISOString()
      .split('T')[0]

    const { data: weather } = await supabase
      .from('weather_data')
      .select('date, high_temp, low_temp, conditions')
      .eq('venue_id', venueId)
      .eq('source', 'open_meteo')
      .gte('date', today)
      .lte('date', fourteenDays)
      .order('date', { ascending: true })

    if (weather && weather.length > 0) {
      // Summarize: avg highs/lows, dominant conditions
      const highs = weather
        .map((w) => w.high_temp as number | null)
        .filter((v): v is number => v != null)
      const lows = weather
        .map((w) => w.low_temp as number | null)
        .filter((v): v is number => v != null)
      const conditionCounts = new Map<string, number>()

      for (const w of weather) {
        const cond = (w.conditions as string | null) ?? 'Unknown'
        conditionCounts.set(cond, (conditionCounts.get(cond) ?? 0) + 1)
      }

      const avgHigh = highs.length > 0
        ? Math.round(highs.reduce((s, v) => s + v, 0) / highs.length)
        : null
      const avgLow = lows.length > 0
        ? Math.round(lows.reduce((s, v) => s + v, 0) / lows.length)
        : null

      // Most common condition
      const dominantCondition = [...conditionCounts.entries()]
        .sort((a, b) => b[1] - a[1])[0]?.[0] ?? 'Mixed'

      const weatherParts: string[] = []
      weatherParts.push(`Next 14 days: mostly ${dominantCondition.toLowerCase()}.`)
      if (avgHigh != null && avgLow != null) {
        weatherParts.push(`Average highs around ${avgHigh}°F, lows around ${avgLow}°F.`)
      }

      sections.push(`WEATHER OUTLOOK:\n${weatherParts.join(' ')}`)
    }
  } catch (err) {
    console.warn('[sage-intel] Failed to fetch weather summary:', err)
  }

  // --- Review vocabulary (approved phrases for Sage) ---
  try {
    const vocabulary = await getReviewVocabulary(venueId)
    const allThemes = Object.keys(vocabulary)

    if (allThemes.length > 0) {
      const phraseLines: string[] = []

      for (const theme of allThemes) {
        const entry = vocabulary[theme]
        // Take up to 3 phrases per theme
        const topPhrases = entry.phrases.slice(0, 3).map((p) => `"${p}"`)
        phraseLines.push(`- ${theme}: ${topPhrases.join(', ')}`)
      }

      sections.push(
        `REVIEW LANGUAGE (real phrases from couples — weave these in naturally):\n` +
          phraseLines.join('\n')
      )
    }
  } catch (err) {
    console.warn('[sage-intel] Failed to fetch review vocabulary:', err)
  }

  // --- Seasonal context ---
  try {
    const seasonal = await getSeasonalContext(venueId)

    if (seasonal.imagery.length > 0 || seasonal.phrases.length > 0) {
      const seasonParts: string[] = [`Current season: ${seasonal.season}.`]

      if (seasonal.imagery.length > 0) {
        seasonParts.push(`Imagery: ${seasonal.imagery.slice(0, 3).join(', ')}.`)
      }
      if (seasonal.phrases.length > 0) {
        seasonParts.push(
          `Seasonal phrases: ${seasonal.phrases.slice(0, 3).map((p) => `"${p}"`).join(', ')}.`
        )
      }

      sections.push(`SEASONAL CONTEXT:\n${seasonParts.join(' ')}`)
    }
  } catch (err) {
    console.warn('[sage-intel] Failed to fetch seasonal context:', err)
  }

  // --- Active anomaly alerts ---
  try {
    const { data: alerts } = await supabase
      .from('anomaly_alerts')
      .select('alert_type, metric_name, severity, ai_explanation')
      .eq('venue_id', venueId)
      .eq('acknowledged', false)
      .in('severity', ['warning', 'critical'])
      .order('created_at', { ascending: false })
      .limit(3)

    if (alerts && alerts.length > 0) {
      const alertLines = alerts.map((a) => {
        const explanation = a.ai_explanation as string | null
        const metric = (a.metric_name as string).replace(/_/g, ' ')
        const sev = a.severity as string
        if (explanation) {
          return `- [${sev}] ${metric}: ${explanation}`
        }
        return `- [${sev}] Unusual activity in ${metric}`
      })

      sections.push(
        `ACTIVE ALERTS (context if a couple asks about availability or demand):\n` +
          alertLines.join('\n')
      )
    }
  } catch (err) {
    console.warn('[sage-intel] Failed to fetch anomaly alerts:', err)
  }

  // --- Compose the final context block ---
  if (sections.length === 0) {
    return ''
  }

  return [
    '--- VENUE INTELLIGENCE CONTEXT (live data — use naturally, never quote raw numbers to couples) ---',
    '',
    ...sections,
    '',
    '--- END INTELLIGENCE CONTEXT ---',
  ].join('\n')
}
