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
  // Positive engagement
  initial_inquiry: 40,
  email_opened: 2,
  email_clicked: 5,
  email_reply_received: 15,
  email_sent: 0,
  tour_scheduled: 20,
  tour_completed: 25,
  tour_rescheduled: 5,
  call_outbound: 5,
  call_answered: 10,
  call_missed: 0,
  voicemail_left: 3,
  contract_sent: 30,
  contract_viewed: 10,
  contract_signed: 50,
  page_view: 1,
  pricing_page_view: 5,
  gallery_page_view: 3,
  availability_page_view: 5,
  note_added: 2,
  meeting_scheduled: 15,
  // Legacy aliases (preserved for backward compatibility)
  replied_quickly: 15,
  tour_booked: 25,
  proposal_viewed: 20,
  proposal_requested: 15,
  follow_up_response: 10,
  referred_friend: 30,
  social_engagement: 5,
  website_visit: 3,
  // Negative signals
  no_response_week: -10,
  tour_cancelled: -15,
  not_interested_signal: -25,
  daily_decay: -1,
  marked_lost: -100,
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

interface HotLead {
  weddingId: string
  heatScore: number
  temperatureTier: string
  partner1Name: string | null
  partner2Name: string | null
  weddingDate: string | null
  inquiryDate: string | null
  source: string | null
  suggestedAction: string
}

interface ColdLead {
  weddingId: string
  heatScore: number
  temperatureTier: string
  partner1Name: string | null
  partner2Name: string | null
  weddingDate: string | null
  scoreChange: number
  daysSinceEngagement: number
  suggestedReengagementAction: string
}

interface TempSummary {
  hot: { count: number; conversionRate: number }
  warm: { count: number; conversionRate: number }
  cool: { count: number; conversionRate: number }
  cold: { count: number; conversionRate: number }
  frozen: { count: number; conversionRate: number }
  total: number
  bookedTotal: number
}

interface ScoreChange {
  score: number
  temperatureTier: string
  calculatedAt: string
  eventType: string | null
  pointsAwarded: number | null
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

// ---------------------------------------------------------------------------
// Exported: getHotLeads
// ---------------------------------------------------------------------------

/**
 * Get hot leads with suggested next actions. Returns active inquiries with
 * score >= minScore, sorted by score descending. Each entry includes partner
 * names and a contextual suggested action.
 */
export async function getHotLeads(
  venueId: string,
  minScore = 75
): Promise<HotLead[]> {
  const supabase = createServiceClient()

  // Get weddings above threshold
  const { data: weddings, error } = await supabase
    .from('weddings')
    .select('id, heat_score, temperature_tier, status, source, inquiry_date, wedding_date')
    .eq('venue_id', venueId)
    .eq('status', 'inquiry')
    .gte('heat_score', minScore)
    .order('heat_score', { ascending: false })

  if (error || !weddings || weddings.length === 0) return []

  // Fetch partner names for each wedding
  const weddingIds = weddings.map((w) => w.id as string)
  const { data: people } = await supabase
    .from('people')
    .select('wedding_id, first_name, last_name, role')
    .in('wedding_id', weddingIds)
    .in('role', ['partner1', 'partner2'])

  const partnerMap = new Map<string, { partner1: string | null; partner2: string | null }>()
  for (const p of people ?? []) {
    const wid = p.wedding_id as string
    if (!partnerMap.has(wid)) partnerMap.set(wid, { partner1: null, partner2: null })
    const entry = partnerMap.get(wid)!
    const name = [p.first_name, p.last_name].filter(Boolean).join(' ') || null
    if (p.role === 'partner1') entry.partner1 = name
    else if (p.role === 'partner2') entry.partner2 = name
  }

  // Get most recent engagement event per wedding for action suggestions
  const { data: recentEvents } = await supabase
    .from('engagement_events')
    .select('wedding_id, event_type, created_at')
    .in('wedding_id', weddingIds)
    .order('created_at', { ascending: false })

  const latestEventMap = new Map<string, string>()
  for (const e of recentEvents ?? []) {
    const wid = e.wedding_id as string
    if (!latestEventMap.has(wid)) {
      latestEventMap.set(wid, e.event_type as string)
    }
  }

  return weddings.map((w) => {
    const wid = w.id as string
    const partners = partnerMap.get(wid)
    const latestEvent = latestEventMap.get(wid)

    return {
      weddingId: wid,
      heatScore: w.heat_score as number,
      temperatureTier: w.temperature_tier as string,
      partner1Name: partners?.partner1 ?? null,
      partner2Name: partners?.partner2 ?? null,
      weddingDate: w.wedding_date as string | null,
      inquiryDate: w.inquiry_date as string | null,
      source: w.source as string | null,
      suggestedAction: suggestNextAction(latestEvent, w.heat_score as number),
    }
  })
}

// ---------------------------------------------------------------------------
// Exported: getLeadsGoingCold
// ---------------------------------------------------------------------------

/**
 * Get leads with a negative score trend over the past N days. Sorted by
 * severity (biggest drops first). Each includes a suggested re-engagement
 * action.
 */
export async function getLeadsGoingCold(
  venueId: string,
  days = 7
): Promise<ColdLead[]> {
  const supabase = createServiceClient()
  const cutoff = new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString()

  // Get all active inquiries
  const { data: weddings } = await supabase
    .from('weddings')
    .select('id, heat_score, temperature_tier, wedding_date')
    .eq('venue_id', venueId)
    .eq('status', 'inquiry')
    .gt('heat_score', 0)

  if (!weddings || weddings.length === 0) return []

  const weddingIds = weddings.map((w) => w.id as string)

  // Get score history from the past N days
  const { data: history } = await supabase
    .from('lead_score_history')
    .select('wedding_id, score, calculated_at')
    .in('wedding_id', weddingIds)
    .gte('calculated_at', cutoff)
    .order('calculated_at', { ascending: true })

  // Calculate score delta per wedding (earliest score in window vs current)
  const earliestScoreMap = new Map<string, number>()
  for (const h of history ?? []) {
    const wid = h.wedding_id as string
    if (!earliestScoreMap.has(wid)) {
      earliestScoreMap.set(wid, h.score as number)
    }
  }

  // Get last engagement event dates per wedding
  const { data: lastEvents } = await supabase
    .from('engagement_events')
    .select('wedding_id, created_at')
    .in('wedding_id', weddingIds)
    .order('created_at', { ascending: false })

  const lastEngagementMap = new Map<string, string>()
  for (const e of lastEvents ?? []) {
    const wid = e.wedding_id as string
    if (!lastEngagementMap.has(wid)) {
      lastEngagementMap.set(wid, e.created_at as string)
    }
  }

  // Fetch partner names
  const { data: people } = await supabase
    .from('people')
    .select('wedding_id, first_name, last_name, role')
    .in('wedding_id', weddingIds)
    .in('role', ['partner1', 'partner2'])

  const partnerMap = new Map<string, { partner1: string | null; partner2: string | null }>()
  for (const p of people ?? []) {
    const wid = p.wedding_id as string
    if (!partnerMap.has(wid)) partnerMap.set(wid, { partner1: null, partner2: null })
    const entry = partnerMap.get(wid)!
    const name = [p.first_name, p.last_name].filter(Boolean).join(' ') || null
    if (p.role === 'partner1') entry.partner1 = name
    else if (p.role === 'partner2') entry.partner2 = name
  }

  // Build cold lead entries
  const coldLeads: ColdLead[] = []

  for (const w of weddings) {
    const wid = w.id as string
    const currentScore = w.heat_score as number
    const earliestScore = earliestScoreMap.get(wid)

    // Only include if we have history and score went down
    if (earliestScore === undefined) continue
    const scoreChange = currentScore - earliestScore
    if (scoreChange >= 0) continue

    const lastEngagementDate = lastEngagementMap.get(wid)
    const daysSinceEngagement = lastEngagementDate
      ? Math.floor((Date.now() - new Date(lastEngagementDate).getTime()) / (24 * 60 * 60 * 1000))
      : days

    const partners = partnerMap.get(wid)

    coldLeads.push({
      weddingId: wid,
      heatScore: currentScore,
      temperatureTier: w.temperature_tier as string,
      partner1Name: partners?.partner1 ?? null,
      partner2Name: partners?.partner2 ?? null,
      weddingDate: w.wedding_date as string | null,
      scoreChange,
      daysSinceEngagement,
      suggestedReengagementAction: suggestReengagementAction(daysSinceEngagement, currentScore),
    })
  }

  // Sort by severity (biggest drops first)
  coldLeads.sort((a, b) => a.scoreChange - b.scoreChange)

  return coldLeads
}

// ---------------------------------------------------------------------------
// Exported: markAsBooked
// ---------------------------------------------------------------------------

/**
 * Mark a wedding as booked. Updates status, records engagement event,
 * and inserts a history snapshot.
 */
export async function markAsBooked(
  weddingId: string,
  notes?: string
): Promise<void> {
  const supabase = createServiceClient()

  // Get venue_id from wedding
  const { data: wedding } = await supabase
    .from('weddings')
    .select('venue_id')
    .eq('id', weddingId)
    .single()

  if (!wedding) {
    throw new Error(`Wedding ${weddingId} not found`)
  }

  const venueId = wedding.venue_id as string
  const now = new Date().toISOString()

  // Update wedding status
  await supabase
    .from('weddings')
    .update({
      status: 'booked',
      heat_score: 100,
      temperature_tier: 'hot',
      booked_at: now,
      notes: notes ? notes : undefined,
      updated_at: now,
    })
    .eq('id', weddingId)

  // Record engagement event
  await supabase.from('engagement_events').insert({
    venue_id: venueId,
    wedding_id: weddingId,
    event_type: 'contract_signed',
    points: DEFAULT_POINTS.contract_signed,
    metadata: { action: 'marked_booked', notes: notes ?? null },
  })

  // Insert score history snapshot
  await supabase.from('lead_score_history').insert({
    venue_id: venueId,
    wedding_id: weddingId,
    score: 100,
    temperature_tier: 'hot',
    calculated_at: now,
  })

  console.log(`[heat-mapping] Wedding ${weddingId} marked as booked`)
}

// ---------------------------------------------------------------------------
// Exported: markAsLost
// ---------------------------------------------------------------------------

/**
 * Mark a wedding as lost. Sets score to 0, records the reason and competitor
 * info, and inserts a lost_deals record.
 */
export async function markAsLost(
  weddingId: string,
  reason?: string,
  lostTo?: string
): Promise<void> {
  const supabase = createServiceClient()

  // Get wedding info
  const { data: wedding } = await supabase
    .from('weddings')
    .select('venue_id, status')
    .eq('id', weddingId)
    .single()

  if (!wedding) {
    throw new Error(`Wedding ${weddingId} not found`)
  }

  const venueId = wedding.venue_id as string
  const now = new Date().toISOString()
  const previousStage = (wedding.status as string) || 'inquiry'

  // Update wedding status
  await supabase
    .from('weddings')
    .update({
      status: 'lost',
      heat_score: 0,
      temperature_tier: 'frozen',
      lost_at: now,
      lost_reason: reason ?? null,
      updated_at: now,
    })
    .eq('id', weddingId)

  // Record engagement event
  await supabase.from('engagement_events').insert({
    venue_id: venueId,
    wedding_id: weddingId,
    event_type: 'marked_lost',
    points: DEFAULT_POINTS.marked_lost,
    metadata: { reason: reason ?? null, lost_to: lostTo ?? null },
  })

  // Insert lost_deals record
  await supabase.from('lost_deals').insert({
    venue_id: venueId,
    wedding_id: weddingId,
    lost_at_stage: previousStage,
    reason_category: lostTo ? 'competitor' : 'other',
    reason_detail: reason ?? null,
    competitor_name: lostTo ?? null,
    lost_at: now,
  })

  // Insert score history snapshot
  await supabase.from('lead_score_history').insert({
    venue_id: venueId,
    wedding_id: weddingId,
    score: 0,
    temperature_tier: 'frozen',
    calculated_at: now,
  })

  console.log(`[heat-mapping] Wedding ${weddingId} marked as lost (reason: ${reason ?? 'none'})`)
}

// ---------------------------------------------------------------------------
// Exported: getTemperatureSummary
// ---------------------------------------------------------------------------

/**
 * Get temperature tier summary with conversion rates. For each tier, returns
 * the count of active leads and the historical conversion rate (booked / total
 * that ever reached that tier).
 */
export async function getTemperatureSummary(venueId: string): Promise<TempSummary> {
  const supabase = createServiceClient()

  // Get all weddings (both active and completed) to calculate conversion rates
  const { data: allWeddings } = await supabase
    .from('weddings')
    .select('id, heat_score, temperature_tier, status')
    .eq('venue_id', venueId)

  if (!allWeddings || allWeddings.length === 0) {
    return {
      hot: { count: 0, conversionRate: 0 },
      warm: { count: 0, conversionRate: 0 },
      cool: { count: 0, conversionRate: 0 },
      cold: { count: 0, conversionRate: 0 },
      frozen: { count: 0, conversionRate: 0 },
      total: 0,
      bookedTotal: 0,
    }
  }

  // Count active inquiries per tier
  const activeCounts: Record<string, number> = { hot: 0, warm: 0, cool: 0, cold: 0, frozen: 0 }
  // Count total weddings that ever reached each tier (using score history)
  const totalPerTier: Record<string, number> = { hot: 0, warm: 0, cool: 0, cold: 0, frozen: 0 }
  const bookedPerTier: Record<string, number> = { hot: 0, warm: 0, cool: 0, cold: 0, frozen: 0 }

  let bookedTotal = 0

  for (const w of allWeddings) {
    const tier = w.temperature_tier as string
    const status = w.status as string

    if (status === 'inquiry' && tier in activeCounts) {
      activeCounts[tier]++
    }

    if (tier in totalPerTier) {
      totalPerTier[tier]++
    }

    if (status === 'booked') {
      bookedTotal++
      if (tier in bookedPerTier) {
        bookedPerTier[tier]++
      }
    }
  }

  const calcRate = (tier: string) =>
    totalPerTier[tier] > 0
      ? Math.round((bookedPerTier[tier] / totalPerTier[tier]) * 100)
      : 0

  return {
    hot: { count: activeCounts.hot, conversionRate: calcRate('hot') },
    warm: { count: activeCounts.warm, conversionRate: calcRate('warm') },
    cool: { count: activeCounts.cool, conversionRate: calcRate('cool') },
    cold: { count: activeCounts.cold, conversionRate: calcRate('cold') },
    frozen: { count: activeCounts.frozen, conversionRate: calcRate('frozen') },
    total: allWeddings.filter((w) => (w.status as string) === 'inquiry').length,
    bookedTotal,
  }
}

// ---------------------------------------------------------------------------
// Exported: getScoreHistory
// ---------------------------------------------------------------------------

/**
 * Get score history for a wedding. Returns recent score changes with
 * event descriptions, most recent first.
 */
export async function getScoreHistory(
  weddingId: string,
  limit = 20
): Promise<ScoreChange[]> {
  const supabase = createServiceClient()

  // Get score history
  const { data: history } = await supabase
    .from('lead_score_history')
    .select('score, temperature_tier, calculated_at')
    .eq('wedding_id', weddingId)
    .order('calculated_at', { ascending: false })
    .limit(limit)

  if (!history || history.length === 0) return []

  // Get engagement events in a matching time window to correlate
  const oldestEntry = history[history.length - 1]
  const { data: events } = await supabase
    .from('engagement_events')
    .select('event_type, points, created_at')
    .eq('wedding_id', weddingId)
    .gte('created_at', oldestEntry.calculated_at as string)
    .order('created_at', { ascending: false })

  // Build a map of event timestamps (rounded to seconds) to event info
  const eventMap = new Map<number, { eventType: string; points: number }>()
  for (const e of events ?? []) {
    const ts = Math.floor(new Date(e.created_at as string).getTime() / 1000)
    if (!eventMap.has(ts)) {
      eventMap.set(ts, {
        eventType: e.event_type as string,
        points: e.points as number,
      })
    }
  }

  return history.map((h, index) => {
    const ts = Math.floor(new Date(h.calculated_at as string).getTime() / 1000)
    const matchedEvent = eventMap.get(ts)

    // Calculate points awarded as diff from next (older) entry
    const prevScore = index < history.length - 1 ? (history[index + 1].score as number) : 0
    const pointsAwarded = (h.score as number) - prevScore

    return {
      score: h.score as number,
      temperatureTier: h.temperature_tier as string,
      calculatedAt: h.calculated_at as string,
      eventType: matchedEvent?.eventType ?? null,
      pointsAwarded,
    }
  })
}

// ---------------------------------------------------------------------------
// Internal: action suggestion helpers
// ---------------------------------------------------------------------------

/**
 * Suggest the next best action based on the most recent event and current score.
 */
function suggestNextAction(latestEvent: string | undefined, score: number): string {
  if (!latestEvent) {
    return 'Send initial follow-up email'
  }

  switch (latestEvent) {
    case 'initial_inquiry':
      return 'Send personalized welcome response within 2 hours'
    case 'email_reply_received':
      return 'Reply and offer to schedule a tour'
    case 'tour_scheduled':
      return 'Send tour confirmation with directions and what to expect'
    case 'tour_completed':
      return 'Send follow-up with proposal and availability'
    case 'contract_sent':
      return 'Check in — ask if they have questions about the contract'
    case 'contract_viewed':
      return 'Call to discuss any questions about the contract'
    case 'email_opened':
    case 'email_clicked':
      return 'They are engaged — send a timely follow-up'
    case 'pricing_page_view':
    case 'availability_page_view':
      return 'They are researching — reach out with relevant info'
    case 'meeting_scheduled':
      return 'Prepare personalized talking points for the meeting'
    default:
      if (score >= 90) return 'High interest — push for contract'
      if (score >= 70) return 'Strong lead — schedule a call or tour'
      return 'Follow up with a personalized touch'
  }
}

/**
 * Suggest a re-engagement action based on how long since last engagement.
 */
function suggestReengagementAction(daysSinceEngagement: number, score: number): string {
  if (daysSinceEngagement >= 21) {
    return 'Final check-in — personal note from venue owner or coordinator'
  }
  if (daysSinceEngagement >= 14) {
    return 'Share a recent wedding story or seasonal availability update'
  }
  if (daysSinceEngagement >= 7) {
    return 'Friendly check-in — ask if they have any new questions'
  }
  if (score < 30) {
    return 'Consider a special offer or exclusive tour time'
  }
  return 'Send a gentle follow-up with new venue content'
}
