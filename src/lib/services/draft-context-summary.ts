/**
 * Bloom House: Draft Context Summary Service
 *
 * Produces a structured, coordinator-visible summary of which external signals
 * Sage (or the venue's configured AI name) would have considered when drafting
 * a reply. This is the "why Sage said this" hint that surfaces on the Approval
 * Queue so coordinators can see at a glance what intelligence informed a draft.
 *
 * The underlying signals come from the same sources used by
 * `buildSageIntelligenceContext` (sage-intelligence.ts). Where possible we
 * reuse those exported helpers so there is one source of truth for what Sage
 * knows. The difference is shape: this module returns a structured object,
 * not a text block destined for a system prompt.
 */

import { createServiceClient } from '@/lib/supabase/service'
import { getLatestIndicators, calculateDemandScore } from '@/lib/services/economics'
import { detectTrendDeviations } from '@/lib/services/trends'
import { getSeasonalContext } from '@/lib/services/sage-intelligence'

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface DraftContextSummary {
  venueName: string
  region: string | null
  aiName: string
  demandSummary: string | null
  topTrend: string | null
  weatherNote: string | null
  seasonalContext: string | null
  activeAnomaly: string | null
  oneLiner: string
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function outlookLabel(outlook: 'positive' | 'neutral' | 'caution'): string {
  switch (outlook) {
    case 'positive':
      return 'strong'
    case 'caution':
      return 'softer than usual'
    default:
      return 'steady'
  }
}

function joinWithAnd(items: string[]): string {
  if (items.length === 0) return ''
  if (items.length === 1) return items[0]
  if (items.length === 2) return `${items[0]} and ${items[1]}`
  return `${items.slice(0, -1).join(', ')}, and ${items[items.length - 1]}`
}

// ---------------------------------------------------------------------------
// summarizeDraftContext
// ---------------------------------------------------------------------------

/**
 * Pull the same signals `buildSageIntelligenceContext` uses, but return them
 * as a structured summary with a single-sentence explanation suitable for
 * rendering above a draft.
 */
export async function summarizeDraftContext(
  venueId: string
): Promise<DraftContextSummary> {
  const supabase = createServiceClient()

  // --- Venue basics (name, region) ---
  let venueName = 'this venue'
  let region: string | null = null
  try {
    const { data: venue } = await supabase
      .from('venues')
      .select('name, state, city')
      .eq('id', venueId)
      .maybeSingle()

    if (venue?.name) venueName = venue.name as string
    const state = (venue?.state as string | null | undefined)?.trim() || null
    const city = (venue?.city as string | null | undefined)?.trim() || null
    if (state) region = state
    else if (city) region = city
  } catch (err) {
    console.warn('[draft-context] Failed to fetch venue basics:', err)
  }

  // --- AI name (venue_ai_config.ai_name) ---
  let aiName = 'Sage'
  try {
    const { data: cfg } = await supabase
      .from('venue_ai_config')
      .select('ai_name')
      .eq('venue_id', venueId)
      .maybeSingle()
    const raw = (cfg?.ai_name as string | null | undefined)?.trim()
    if (raw) aiName = raw
  } catch (err) {
    console.warn('[draft-context] Failed to fetch ai_name:', err)
  }

  // --- Demand outlook (from economics service) ---
  let demandSummary: string | null = null
  try {
    const indicators = await getLatestIndicators()
    if (Object.keys(indicators).length > 0) {
      const { outlook } = calculateDemandScore(indicators)
      demandSummary = `Demand outlook: ${outlookLabel(outlook)}`
    }
  } catch (err) {
    console.warn('[draft-context] Failed to compute demand outlook:', err)
  }

  // --- Top trend deviation (from trends service) ---
  let topTrend: string | null = null
  try {
    const deviations = await detectTrendDeviations(venueId)
    if (deviations.length > 0) {
      const top = deviations[0]
      const direction = top.direction === 'up' ? 'up' : 'down'
      const regionText = region ? ` in ${region}` : ''
      const pct = Math.abs(top.changePercent)
      topTrend = `Search for "${top.term}" ${direction} ${pct}%${regionText}`
    }
  } catch (err) {
    console.warn('[draft-context] Failed to fetch trend deviations:', err)
  }

  // --- Weather note (next upcoming wedding within 14 days) ---
  let weatherNote: string | null = null
  try {
    const today = new Date().toISOString().split('T')[0]
    const fourteenDays = new Date(Date.now() + 14 * 24 * 60 * 60 * 1000)
      .toISOString()
      .split('T')[0]

    const { data: weather } = await supabase
      .from('weather_data')
      .select('date, high_temp, low_temp, conditions, precipitation')
      .eq('venue_id', venueId)
      .eq('source', 'open_meteo')
      .gte('date', today)
      .lte('date', fourteenDays)
      .order('date', { ascending: true })
      .limit(14)

    if (weather && weather.length > 0) {
      const hasRain = weather.some(
        (w) => (w.precipitation as number | null) != null && (w.precipitation as number) > 0.1
      )
      const rainyDay = weather.find(
        (w) => (w.precipitation as number | null) != null && (w.precipitation as number) > 0.1
      )
      if (hasRain && rainyDay) {
        weatherNote = `Rain in the forecast for ${rainyDay.date as string}`
      } else {
        const first = weather[0]
        const cond = (first.conditions as string | null) ?? null
        if (cond) {
          weatherNote = `14-day outlook: mostly ${cond.toLowerCase()}`
        }
      }
    }
  } catch (err) {
    console.warn('[draft-context] Failed to fetch weather:', err)
  }

  // --- Seasonal context (reuses sage-intelligence helper) ---
  let seasonalContext: string | null = null
  try {
    const seasonal = await getSeasonalContext(venueId)
    const hasContent = seasonal.imagery.length > 0 || seasonal.phrases.length > 0
    if (hasContent) {
      const locationPiece = region ? ` in ${region}` : ''
      seasonalContext = `${capitalize(seasonal.season)}${locationPiece}`
    }
  } catch (err) {
    console.warn('[draft-context] Failed to fetch seasonal context:', err)
  }

  // --- Top active anomaly (unacknowledged, warning+) ---
  let activeAnomaly: string | null = null
  try {
    const { data: alerts } = await supabase
      .from('anomaly_alerts')
      .select('alert_type, metric_name, severity, ai_explanation')
      .eq('venue_id', venueId)
      .eq('acknowledged', false)
      .in('severity', ['warning', 'critical'])
      .order('created_at', { ascending: false })
      .limit(1)

    if (alerts && alerts.length > 0) {
      const a = alerts[0]
      const metric = ((a.metric_name as string | null) ?? 'activity').replace(/_/g, ' ')
      const severity = (a.severity as string | null) ?? 'warning'
      activeAnomaly = `Active ${severity} alert on ${metric}`
    }
  } catch (err) {
    console.warn('[draft-context] Failed to fetch anomaly alerts:', err)
  }

  // --- Compose the one-line explanation ---
  const pieces: string[] = []
  if (demandSummary) pieces.push('regional demand')
  if (topTrend) pieces.push('a search trend shift')
  if (weatherNote) pieces.push('the weather outlook')
  if (seasonalContext) {
    const seasonWord = seasonalContext.split(' ')[0].toLowerCase()
    pieces.push(`${seasonWord} seasonality`)
  }
  if (activeAnomaly) pieces.push('one active alert')

  let oneLiner: string
  if (pieces.length === 0) {
    oneLiner = `${aiName} drafted this reply using ${venueName}'s core voice and knowledge base.`
  } else {
    const regionSuffix = region ? ` in ${region}` : ''
    oneLiner = `${aiName} considered ${joinWithAnd(pieces)} for ${venueName}${regionSuffix}.`
  }

  return {
    venueName,
    region,
    aiName,
    demandSummary,
    topTrend,
    weatherNote,
    seasonalContext,
    activeAnomaly,
    oneLiner,
  }
}

function capitalize(s: string): string {
  if (!s) return s
  return s[0].toUpperCase() + s.slice(1)
}
