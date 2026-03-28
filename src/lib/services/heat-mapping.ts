/**
 * Bloom House: Heat Mapping Service
 *
 * Lead scoring engine that calculates heat scores for wedding leads based
 * on engagement events. Scores determine temperature tiers (hot/warm/cool/
 * cold/frozen) which drive dashboard UI and prioritization.
 *
 * Features:
 *  - Event-driven scoring with configurable point values per venue
 *  - Time decay (scores cool if no new engagement)
 *  - Score history snapshots for trend analysis
 *  - Leaderboard and distribution views
 *
 * Ported from bloom-agent-main/backend/services/heat_mapping_service.py
 */

import { createServiceClient } from '@/lib/supabase/service'

// ---------------------------------------------------------------------------
// Default point values (used when no venue-specific config exists)
// ---------------------------------------------------------------------------

const DEFAULT_POINTS: Record<string, number> = {
  email_opened: 5,
  replied_quickly: 15, // response within 2 hours
  tour_booked: 25,
  tour_completed: 20,
  proposal_viewed: 20,
  proposal_requested: 15,
  follow_up_response: 10,
  referred_friend: 30,
  social_engagement: 5,
  website_visit: 3,
}

// ---------------------------------------------------------------------------
// Temperature tiers
// ---------------------------------------------------------------------------

function getTier(score: number): string {
  if (score >= 80) return 'hot'
  if (score >= 60) return 'warm'
  if (score >= 40) return 'cool'
  if (score >= 20) return 'cold'
  return 'frozen'
}

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface HeatScoreResult {
  weddingId: string
  newScore: number
  previousScore: number
  temperatureTier: string
  pointsAwarded: number
}

interface LeaderboardEntry {
  weddingId: string
  heatScore: number
  temperatureTier: string
  status: string
  source: string | null
  inquiryDate: string | null
  weddingDate: string | null
}

interface HeatDistribution {
  hot: number
  warm: number
  cool: number
  cold: number
  frozen: number
}

// ---------------------------------------------------------------------------
// Internal: get point value for an event type
// ---------------------------------------------------------------------------

/**
 * Look up point value for an event type. Checks venue-specific config first,
 * falls back to DEFAULT_POINTS.
 */
async function getPointsForEvent(
  venueId: string,
  eventType: string
): Promise<number> {
  const supabase = createServiceClient()

  // Check venue-specific config
  const { data } = await supabase
    .from('heat_score_config')
    .select('points')
    .eq('venue_id', venueId)
    .eq('event_type', eventType)
    .limit(1)

  if (data && data.length > 0) {
    return data[0].points as number
  }

  return DEFAULT_POINTS[eventType] ?? 0
}

// ---------------------------------------------------------------------------
// Exported: recordEngagementEvent
// ---------------------------------------------------------------------------

/**
 * Record an engagement event for a wedding lead. Inserts the event,
 * recalculates the heat score, and updates the wedding record.
 */
export async function recordEngagementEvent(
  venueId: string,
  weddingId: string,
  eventType: string,
  metadata?: Record<string, unknown>
): Promise<HeatScoreResult> {
  const supabase = createServiceClient()

  // Get points for this event type
  const points = await getPointsForEvent(venueId, eventType)

  // Insert engagement event
  await supabase.from('engagement_events').insert({
    venue_id: venueId,
    wedding_id: weddingId,
    event_type: eventType,
    points,
    metadata: metadata ?? {},
  })

  // Recalculate and return
  return recalculateHeatScore(venueId, weddingId)
}

// ---------------------------------------------------------------------------
// Exported: recalculateHeatScore
// ---------------------------------------------------------------------------

/**
 * Recalculate the heat score for a wedding by summing all engagement event
 * points with time decay applied. More recent events count more.
 *
 * Decay formula: points * (0.98 ^ daysAgo)
 * This means an event from 30 days ago retains ~55% of its original value.
 *
 * Updates the wedding record and inserts a lead_score_history snapshot.
 */
export async function recalculateHeatScore(
  venueId: string,
  weddingId: string
): Promise<HeatScoreResult> {
  const supabase = createServiceClient()

  // Get current score before recalculation
  const { data: wedding } = await supabase
    .from('weddings')
    .select('heat_score')
    .eq('id', weddingId)
    .single()

  const previousScore = (wedding?.heat_score as number) ?? 0

  // Fetch all engagement events for this wedding
  const { data: events } = await supabase
    .from('engagement_events')
    .select('points, created_at')
    .eq('venue_id', venueId)
    .eq('wedding_id', weddingId)
    .order('created_at', { ascending: false })

  if (!events || events.length === 0) {
    return {
      weddingId,
      newScore: 0,
      previousScore,
      temperatureTier: getTier(0),
      pointsAwarded: 0,
    }
  }

  // Sum points with time decay
  const now = Date.now()
  const dayMs = 24 * 60 * 60 * 1000
  const decayRate = 0.98

  let totalScore = 0

  for (const event of events) {
    const eventPoints = event.points as number
    const eventDate = new Date(event.created_at as string).getTime()
    const daysAgo = Math.max(0, (now - eventDate) / dayMs)

    // Apply decay: points * (0.98 ^ daysAgo)
    const decayedPoints = eventPoints * Math.pow(decayRate, daysAgo)
    totalScore += decayedPoints
  }

  // Clamp score to 0-100
  const newScore = Math.max(0, Math.min(100, Math.round(totalScore)))
  const temperatureTier = getTier(newScore)

  // Update wedding record
  await supabase
    .from('weddings')
    .update({
      heat_score: newScore,
      temperature_tier: temperatureTier,
      updated_at: new Date().toISOString(),
    })
    .eq('id', weddingId)

  // Insert lead_score_history snapshot
  await supabase.from('lead_score_history').insert({
    venue_id: venueId,
    wedding_id: weddingId,
    score: newScore,
    temperature_tier: temperatureTier,
    calculated_at: new Date().toISOString(),
  })

  return {
    weddingId,
    newScore,
    previousScore,
    temperatureTier,
    pointsAwarded: newScore - previousScore,
  }
}

// ---------------------------------------------------------------------------
// Exported: applyDailyDecay
// ---------------------------------------------------------------------------

/**
 * Apply daily decay to all active wedding heat scores for a venue.
 *
 * Decay rate: multiply by 0.98 daily, so scores gradually cool if no new
 * engagement. Only applies to weddings with status='inquiry' and heat_score > 0.
 *
 * Designed to be called by a daily cron job (e.g. 6:00 AM).
 */
export async function applyDailyDecay(venueId: string): Promise<number> {
  const supabase = createServiceClient()
  const decayMultiplier = 0.98

  // Get all active inquiries with a positive heat score
  const { data: weddings } = await supabase
    .from('weddings')
    .select('id, heat_score, temperature_tier')
    .eq('venue_id', venueId)
    .eq('status', 'inquiry')
    .gt('heat_score', 0)

  if (!weddings || weddings.length === 0) return 0

  let decayedCount = 0

  for (const wedding of weddings) {
    const oldScore = wedding.heat_score as number
    const newScore = Math.max(0, Math.round(oldScore * decayMultiplier))

    // Skip if score didn't actually change (already at 0 or 1)
    if (newScore === oldScore) continue

    const newTier = getTier(newScore)

    await supabase
      .from('weddings')
      .update({
        heat_score: newScore,
        temperature_tier: newTier,
        updated_at: new Date().toISOString(),
      })
      .eq('id', wedding.id)

    // Only log history if temperature tier changed
    const oldTier = wedding.temperature_tier as string
    if (newTier !== oldTier) {
      await supabase.from('lead_score_history').insert({
        venue_id: venueId,
        wedding_id: wedding.id,
        score: newScore,
        temperature_tier: newTier,
        calculated_at: new Date().toISOString(),
      })
    }

    decayedCount++
  }

  console.log(
    `[heat-mapping] Applied daily decay to ${decayedCount} weddings for venue ${venueId}`
  )

  return decayedCount
}

// ---------------------------------------------------------------------------
// Exported: getLeaderboard
// ---------------------------------------------------------------------------

/**
 * Get weddings sorted by heat score (highest first). Used for the leads
 * dashboard to show the hottest leads at the top.
 */
export async function getLeaderboard(
  venueId: string,
  limit = 25
): Promise<LeaderboardEntry[]> {
  const supabase = createServiceClient()

  const { data, error } = await supabase
    .from('weddings')
    .select('id, heat_score, temperature_tier, status, source, inquiry_date, wedding_date')
    .eq('venue_id', venueId)
    .eq('status', 'inquiry')
    .gt('heat_score', 0)
    .order('heat_score', { ascending: false })
    .limit(limit)

  if (error) {
    console.error('[heat-mapping] Failed to fetch leaderboard:', error.message)
    return []
  }

  return (data ?? []).map((w) => ({
    weddingId: w.id as string,
    heatScore: w.heat_score as number,
    temperatureTier: w.temperature_tier as string,
    status: w.status as string,
    source: w.source as string | null,
    inquiryDate: w.inquiry_date as string | null,
    weddingDate: w.wedding_date as string | null,
  }))
}

// ---------------------------------------------------------------------------
// Exported: getHeatDistribution
// ---------------------------------------------------------------------------

/**
 * Get the count of weddings per temperature tier. Used for the dashboard
 * heat distribution chart.
 */
export async function getHeatDistribution(venueId: string): Promise<HeatDistribution> {
  const supabase = createServiceClient()

  const { data, error } = await supabase
    .from('weddings')
    .select('temperature_tier')
    .eq('venue_id', venueId)
    .eq('status', 'inquiry')

  if (error || !data) {
    return { hot: 0, warm: 0, cool: 0, cold: 0, frozen: 0 }
  }

  const distribution: HeatDistribution = {
    hot: 0,
    warm: 0,
    cool: 0,
    cold: 0,
    frozen: 0,
  }

  for (const row of data) {
    const tier = row.temperature_tier as string
    if (tier in distribution) {
      distribution[tier as keyof HeatDistribution]++
    }
  }

  return distribution
}
