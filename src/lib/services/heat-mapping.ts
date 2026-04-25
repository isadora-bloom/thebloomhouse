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
import { createNotification } from '@/lib/services/admin-notifications'

// Graduated cooling-warning milestones before auto-lost. Each stage fires
// at most once per wedding — dedup is by admin_notifications (venue_id,
// wedding_id, type), not a column on weddings, so no schema change. Mark-
// read leaves the row in place (still deduped); deleting the notification
// row is the escape hatch to re-fire a warning.
const COOLING_WARNING_DAYS = [14, 21, 27] as const
const DEFAULT_LOST_AUTO_MARK_DAYS = 30

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
  // Classifier-derived heat signals (F6). Fire alongside the regular
  // reply event so an ordinary reply with strong signals scores more
  // than a flat "thanks" reply. Points stay small so a flurry of
  // signal-bearing replies can't saturate score on their own.
  tour_requested: 15,
  high_commitment_signal: 10,
  family_mentioned: 5,
  high_specificity: 5,
  // Sustained engagement: 5+ inbound emails on a thread. Fires once per
  // wedding from signal-inference.ts. Small points because engagement
  // count is already partially captured via email_reply_received per-reply.
  sustained_engagement: 5,
  tour_scheduled: 20,
  tour_completed: 25,
  // Already-booked Calendly event types — small additive bumps because
  // a wedding at this stage is already at +50 from contract_signed; we
  // don't want walkthroughs or planning calls to over-saturate heat.
  final_walkthrough: 5,
  pre_wedding_event: 3,
  planning_meeting: 3,
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
// Idempotency
// ---------------------------------------------------------------------------

/**
 * Event types that should fire AT MOST ONCE per wedding regardless of
 * how many emails / signals come in. Repeat firings used to compound
 * (Knot inquiry + Calendly booking both fired initial_inquiry, then
 * mergePeople consolidated → wedding ended up with 2× initial_inquiry,
 * +80 base points, distorted heat). Listed here, dedup runs at insert.
 */
const ONE_PER_WEDDING_EVENTS = new Set([
  'initial_inquiry',
  'sustained_engagement',
  'high_commitment_signal',
  'high_specificity',
  'family_mentioned',
])

/**
 * Decide whether to skip inserting an event because it would duplicate
 * one already on the wedding. Two rules:
 *   1. ONE_PER_WEDDING_EVENTS: skip if ANY row of this event_type
 *      already exists on the wedding.
 *   2. Per-interaction events: skip if a row with the same
 *      (event_type, occurred_at) already exists. Backfills running
 *      twice would otherwise insert exact duplicates.
 *
 * Returns { skip: true, reason } when a duplicate is detected.
 */
async function shouldSkipDuplicate(
  supabase: ReturnType<typeof createServiceClient>,
  weddingId: string,
  eventType: string,
  occurredAt: string | null
): Promise<{ skip: boolean; reason?: string }> {
  if (ONE_PER_WEDDING_EVENTS.has(eventType)) {
    const { data } = await supabase
      .from('engagement_events')
      .select('id')
      .eq('wedding_id', weddingId)
      .eq('event_type', eventType)
      .limit(1)
    if (data && data.length > 0) return { skip: true, reason: 'one-per-wedding' }
    return { skip: false }
  }
  // Per-interaction events — exact (type, time) match means a re-run.
  if (occurredAt) {
    const { data } = await supabase
      .from('engagement_events')
      .select('id')
      .eq('wedding_id', weddingId)
      .eq('event_type', eventType)
      .eq('occurred_at', occurredAt)
      .limit(1)
    if (data && data.length > 0) return { skip: true, reason: 'same (type, occurred_at)' }
  }
  return { skip: false }
}

// ---------------------------------------------------------------------------
// Exported: recordEngagementEvent
// ---------------------------------------------------------------------------

/**
 * Record an engagement event for a wedding lead. Inserts the event,
 * recalculates the heat score, and updates the wedding record.
 *
 * Idempotent: skips insertion if the event would duplicate an existing
 * one on this wedding (one-per-wedding event types, or same
 * event_type+occurred_at). The caller never has to dedup.
 */
export async function recordEngagementEvent(
  venueId: string,
  weddingId: string,
  eventType: string,
  metadata?: Record<string, unknown>,
  occurredAt?: string
): Promise<HeatScoreResult> {
  const supabase = createServiceClient()

  const dup = await shouldSkipDuplicate(supabase, weddingId, eventType, occurredAt ?? null)
  if (dup.skip) {
    return recalculateHeatScore(venueId, weddingId)
  }

  const points = await getPointsForEvent(venueId, eventType)
  const row: Record<string, unknown> = {
    venue_id: venueId,
    wedding_id: weddingId,
    event_type: eventType,
    points,
    metadata: metadata ?? {},
  }
  if (occurredAt) row.occurred_at = occurredAt

  await supabase.from('engagement_events').insert(row)

  return recalculateHeatScore(venueId, weddingId)
}

/**
 * Record a batch of engagement events for a wedding and recalculate the
 * heat score exactly once at the end.
 *
 * Use this when a single incoming email fires multiple classifier-derived
 * heat signals (tour_requested + high_commitment_signal + family_mentioned
 * on the same email) — firing recordEngagementEvent four times would
 * re-read every prior engagement_event row three unnecessary times.
 * Returns the final HeatScoreResult after all events land.
 *
 * Silently skips events with unknown event_type (no points config).
 */
export async function recordEngagementEventsBatch(
  venueId: string,
  weddingId: string,
  events: Array<{ eventType: string; metadata?: Record<string, unknown>; occurredAt?: string }>,
  occurredAt?: string
): Promise<HeatScoreResult> {
  if (events.length === 0) {
    // Still return a current-state result so callers don't have to branch.
    return recalculateHeatScore(venueId, weddingId)
  }

  const supabase = createServiceClient()
  // Build candidate rows + filter out duplicates BEFORE the insert.
  // Same dedup rules as recordEngagementEvent. Also dedup within the
  // batch itself — caller could pass two of the same event type for
  // the same wedding; only insert once.
  const candidates: Array<{ row: Record<string, unknown>; eventType: string; occurredAt: string | null }> = []
  for (const e of events) {
    const points = await getPointsForEvent(venueId, e.eventType)
    const eventOccurredAt = e.occurredAt ?? occurredAt ?? null
    const row: Record<string, unknown> = {
      venue_id: venueId,
      wedding_id: weddingId,
      event_type: e.eventType,
      points,
      metadata: e.metadata ?? {},
    }
    if (eventOccurredAt) row.occurred_at = eventOccurredAt
    candidates.push({ row, eventType: e.eventType, occurredAt: eventOccurredAt })
  }

  // Within-batch dedup: drop later occurrences of one-per-wedding types
  // and exact (type, time) collisions before hitting the DB.
  const seenOnceTypes = new Set<string>()
  const seenInteractionKeys = new Set<string>()
  const filtered: typeof candidates = []
  for (const c of candidates) {
    if (ONE_PER_WEDDING_EVENTS.has(c.eventType)) {
      if (seenOnceTypes.has(c.eventType)) continue
      seenOnceTypes.add(c.eventType)
    } else if (c.occurredAt) {
      const key = `${c.eventType}@${c.occurredAt}`
      if (seenInteractionKeys.has(key)) continue
      seenInteractionKeys.add(key)
    }
    filtered.push(c)
  }

  // DB-level dedup: skip rows whose duplicate already exists.
  const toInsert: Record<string, unknown>[] = []
  for (const c of filtered) {
    const dup = await shouldSkipDuplicate(supabase, weddingId, c.eventType, c.occurredAt)
    if (!dup.skip) toInsert.push(c.row)
  }

  if (toInsert.length > 0) {
    await supabase.from('engagement_events').insert(toInsert)
  }

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

  // Fetch all engagement events for this wedding. Decay keys off
  // occurred_at (the real event timestamp — email date, tour date),
  // not created_at (row insert time), so historical backfill from
  // onboarding ages correctly instead of counting everything as
  // "today". Fallback to created_at for any legacy rows pre-089.
  const { data: events } = await supabase
    .from('engagement_events')
    .select('points, occurred_at, created_at')
    .eq('venue_id', venueId)
    .eq('wedding_id', weddingId)
    .order('occurred_at', { ascending: false })

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
    const tsSource = (event.occurred_at ?? event.created_at) as string
    const eventDate = new Date(tsSource).getTime()
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
 * Summary returned from applyDailyDecay so the cron caller and the
 * /api/agent/heat handler can surface meaningful counts.
 */
export interface DecaySummary {
  decayedCount: number
  warningsFired: number
  autoLostCount: number
}

/**
 * Apply daily decay + graduated cooling warnings + auto-mark-lost in a
 * single pass over all active inquiries for a venue.
 *
 * Three pieces of lifecycle logic collapse into this one service so there's
 * one cron, one read of each wedding, and no drift between decay (days
 * since last engagement) and auto-lost (days since last engagement). Prior
 * sketches had separate "decay" and "lost sweep" cron paths that read
 * different timestamps and could disagree by a day.
 *
 * Per wedding:
 *   1. Decay heat score by 0.98 (existing behaviour).
 *   2. Compute silentDays = now - last inbound interaction (or inquiry_date
 *      if no interactions yet). This is the "days since we last heard from
 *      them" number that drives 3 + 4.
 *   3. Fire graduated cooling-warning notifications at 14 / 21 / 27 days.
 *      Each stage fires at most once per wedding — dedup is by admin_
 *      notifications (venue_id, wedding_id, type), so notifications are
 *      skipped on subsequent days. Coordinators can clear the notification
 *      row to re-trigger a warning if they want.
 *   4. When silentDays reaches venue_config.lost_auto_mark_days (default
 *      30, venue-configurable to 0 for disabled), call markAsLost with
 *      reason='auto: no response after N days'. This writes the lost_deals
 *      row, the engagement_event, the score snapshot — same lifecycle as a
 *      manual mark-lost.
 *
 * Designed to be called by a daily cron job (e.g. 6:00 AM).
 */
export async function applyDailyDecay(venueId: string): Promise<DecaySummary> {
  const supabase = createServiceClient()
  const decayMultiplier = 0.98
  const now = new Date()
  const nowIso = now.toISOString()

  // Read per-venue auto-lost threshold. 0 disables auto-lost entirely;
  // negative/null falls back to the default. Graduated warnings still
  // fire regardless of this setting — coordinators can suppress them by
  // marking notifications read.
  const { data: cfg } = await supabase
    .from('venue_config')
    .select('lost_auto_mark_days')
    .eq('venue_id', venueId)
    .maybeSingle()
  const lostAutoMarkDays =
    cfg && typeof cfg.lost_auto_mark_days === 'number' && cfg.lost_auto_mark_days >= 0
      ? (cfg.lost_auto_mark_days as number)
      : DEFAULT_LOST_AUTO_MARK_DAYS

  // Pull every active inquiry once. inquiry_date is the floor for
  // silentDays when no inbound interaction exists yet. heat_score filters
  // out already-frozen rows for the decay branch but not for warnings /
  // auto-lost — a frozen wedding at score 0 with no response for 30 days
  // still needs to transition to status='lost'.
  const { data: weddings } = await supabase
    .from('weddings')
    .select('id, heat_score, temperature_tier, inquiry_date, status')
    .eq('venue_id', venueId)
    .eq('status', 'inquiry')

  if (!weddings || weddings.length === 0) {
    return { decayedCount: 0, warningsFired: 0, autoLostCount: 0 }
  }

  // Pre-fetch the latest inbound interaction timestamp per wedding in one
  // query instead of N queries inside the loop. Same with prior warning
  // notifications. Both use inner object maps keyed by wedding_id.
  const weddingIds = weddings.map((w) => w.id as string)

  const { data: lastInbounds } = await supabase
    .from('interactions')
    .select('wedding_id, timestamp')
    .in('wedding_id', weddingIds)
    .eq('direction', 'inbound')
    .order('timestamp', { ascending: false })
  const latestByWedding = new Map<string, string>()
  for (const row of lastInbounds ?? []) {
    const wId = row.wedding_id as string
    if (!latestByWedding.has(wId)) {
      latestByWedding.set(wId, row.timestamp as string)
    }
  }

  const warningTypes = COOLING_WARNING_DAYS.map((d) => `cooling_warning_${d}d`)
  const { data: priorWarnings } = await supabase
    .from('admin_notifications')
    .select('wedding_id, type')
    .eq('venue_id', venueId)
    .in('type', warningTypes)
    .in('wedding_id', weddingIds)
  const firedByWedding = new Map<string, Set<string>>()
  for (const row of priorWarnings ?? []) {
    const wId = row.wedding_id as string
    if (!firedByWedding.has(wId)) firedByWedding.set(wId, new Set())
    firedByWedding.get(wId)!.add(row.type as string)
  }

  let decayedCount = 0
  let warningsFired = 0
  let autoLostCount = 0

  for (const wedding of weddings) {
    const weddingId = wedding.id as string
    const oldScore = (wedding.heat_score as number) ?? 0
    const oldTier = (wedding.temperature_tier as string) ?? 'cool'

    // Silence floor: last inbound, else inquiry_date.
    const lastActivity = latestByWedding.get(weddingId) ?? (wedding.inquiry_date as string | null)
    const silentDays = lastActivity
      ? Math.floor((now.getTime() - new Date(lastActivity).getTime()) / (1000 * 60 * 60 * 24))
      : 0

    // --- Branch 1: heat decay ---
    if (oldScore > 0) {
      const newScore = Math.max(0, Math.round(oldScore * decayMultiplier))
      if (newScore !== oldScore) {
        const newTier = getTier(newScore)

        await supabase
          .from('weddings')
          .update({
            heat_score: newScore,
            temperature_tier: newTier,
            updated_at: nowIso,
          })
          .eq('id', weddingId)

        if (newTier !== oldTier) {
          await supabase.from('lead_score_history').insert({
            venue_id: venueId,
            wedding_id: weddingId,
            score: newScore,
            temperature_tier: newTier,
            calculated_at: nowIso,
          })
        }

        decayedCount++
      }
    }

    // --- Branch 2: graduated cooling warnings ---
    // Fire the highest un-fired stage the wedding has crossed. Earlier
    // stages that were skipped (e.g. a wedding created silent-from-day-0
    // or cron was down during the 14d window) fire together with the
    // current one so coordinators still see the full progression.
    const fired = firedByWedding.get(weddingId) ?? new Set<string>()
    for (const stage of COOLING_WARNING_DAYS) {
      const type = `cooling_warning_${stage}d`
      if (silentDays >= stage && !fired.has(type)) {
        await createNotification({
          venueId,
          weddingId,
          type,
          title: `Couple cooling — ${stage} days silent`,
          body: `No inbound response in ${silentDays} days. ${
            stage === 14
              ? 'Consider a gentle check-in.'
              : stage === 21
              ? 'This lead is slipping — a follow-up now may save it.'
              : 'Last chance before auto-lost. Send a final outreach or mark lost intentionally.'
          }`,
        })
        fired.add(type)
        warningsFired++
      }
    }

    // --- Branch 3: auto-mark-lost ---
    // Setting lost_auto_mark_days=0 disables this branch entirely.
    if (lostAutoMarkDays > 0 && silentDays >= lostAutoMarkDays) {
      try {
        await markAsLost(weddingId, `auto: no response after ${silentDays} days`)
        autoLostCount++
      } catch (err) {
        console.error(`[heat-mapping] auto-mark-lost failed for ${weddingId}:`, err)
      }
    }
  }

  console.log(
    `[heat-mapping] venue=${venueId} decayed=${decayedCount} ` +
      `warnings=${warningsFired} auto_lost=${autoLostCount}`
  )

  return { decayedCount, warningsFired, autoLostCount }
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

  // Get most recent engagement event per wedding for action suggestions.
  // Order by occurred_at (real event time) so backfilled history doesn't
  // look "fresh" just because it was inserted today.
  const { data: recentEvents } = await supabase
    .from('engagement_events')
    .select('wedding_id, event_type, occurred_at')
    .in('wedding_id', weddingIds)
    .order('occurred_at', { ascending: false })

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

  // Get last engagement event dates per wedding. Uses occurred_at so
  // "days since last engagement" reflects the real email date, not
  // the row insert — important for backfilled history.
  const { data: lastEvents } = await supabase
    .from('engagement_events')
    .select('wedding_id, occurred_at')
    .in('wedding_id', weddingIds)
    .order('occurred_at', { ascending: false })

  const lastEngagementMap = new Map<string, string>()
  for (const e of lastEvents ?? []) {
    const wid = e.wedding_id as string
    if (!lastEngagementMap.has(wid)) {
      lastEngagementMap.set(wid, e.occurred_at as string)
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
