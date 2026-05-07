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
import { recordHistogram } from '@/lib/observability/metrics'

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
  // T2-F: HoneyBook lifecycle events. Signed + payment mirror the
  // generic contract_signed (50 pts) — the source-tag is for forensic
  // record, not a different scoring weight. Refund is a sharp negative
  // (the booking effectively collapsed); amendment is informational +5
  // (some movement on the wedding, but not a full new touch).
  honeybook_contract_signed: 50,
  honeybook_payment_received: 50,
  honeybook_refund: -60,
  honeybook_amendment: 5,
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
// T5-Rixey-FFF: cohort-aware tier cap.
//
// Bug 6 root cause: lead detail simultaneously showed
//   "100 Hot — high engagement but volatile trajectory"
//   "Look-alike cohort: 0/10 booked (0%) — comparable leads aren't booking"
// The cohort-match insight knew the lead was structurally unlikely to
// convert; the heat score did not. The two intelligence layers
// disagreed on the same lead, and the coordinator was left to
// reconcile.
//
// Damping is a multiplicative factor on the FINAL heat score AFTER
// all engagement-event sums + Phase B contribution. We do NOT modify
// historical lead_score_history rows — those are observations of
// what the score was at that moment. Future trajectory snapshots
// will reflect the damped value naturally because they read the
// post-damping score from weddings.heat_score.
//
// Tier cap is separate from the score multiplier: even a damped 70
// raw score should not be allowed to display as "Hot" when the
// cohort signal is extreme. The cap clamps the displayed tier
// downward without further mutating the numeric score, so the chart
// continues to show the (damped) numeric value while the badge text
// reflects the structural skepticism.
// ---------------------------------------------------------------------------

const COHORT_DAMPING_THRESHOLD_LOW = 0.10   // < 10% conversion → 0.5x + cap at warm
const COHORT_DAMPING_THRESHOLD_MID = 0.20   // < 20% conversion → 0.7x (no tier cap, but lower)
const COHORT_DAMPING_LOW_MULTIPLIER = 0.5
const COHORT_DAMPING_MID_MULTIPLIER = 0.7
const COHORT_MIN_MEMBERS_FOR_DAMPING = 5    // align with cohort-match MIN_COHORT_SIZE
const COHORT_RECENCY_YEARS = 3              // align with cohort-match RECENCY_CAP_YEARS
const DAY_MS_FOR_COHORT = 86_400_000

/**
 * Lightweight cohort-rate fetch for heat damping. NOT the full
 * cohort-match generator — that one runs an LLM narration, which is
 * far too expensive to call on every recalculateHeatScore. This
 * function reuses the SAME cohort criteria (same venue, terminal
 * status, last 3 years, similar guest_count + season + source) and
 * returns just the booked / total ratio.
 *
 * Returns null when the cohort is too small to be informative; the
 * caller treats null as "no damping signal" and skips damping
 * entirely — better to leave heat scoring alone than to damp on a
 * 1-or-2-member cohort.
 */
export async function getCohortBookingRate(
  supabase: ReturnType<typeof createServiceClient>,
  venueId: string,
  weddingId: string,
): Promise<{ rate: number; nTotal: number; nBooked: number } | null> {
  // Current lead features.
  const { data: current } = await supabase
    .from('weddings')
    .select('id, guest_count_estimate, source, wedding_date')
    .eq('id', weddingId)
    .eq('venue_id', venueId)
    .maybeSingle()
  if (!current) return null

  const currentRow = current as {
    id: string
    guest_count_estimate: number | null
    source: string | null
    wedding_date: string | null
  }
  const currentSeason = deriveSeasonForDate(currentRow.wedding_date)
  const currentGuestCount = currentRow.guest_count_estimate
  const currentSource = currentRow.source

  // Cohort candidates — same venue, terminal status, last 3 years,
  // not the current row. Mirrors loadClassicalCohortEvidence in
  // cohort-match.ts.
  const cutoff = new Date(Date.now() - COHORT_RECENCY_YEARS * 365 * DAY_MS_FOR_COHORT).toISOString()
  const { data: candidates } = await supabase
    .from('weddings')
    .select('id, status, guest_count_estimate, source, wedding_date')
    .eq('venue_id', venueId)
    .neq('id', weddingId)
    .in('status', ['booked', 'completed', 'lost'])
    .gte('inquiry_date', cutoff)

  if (!candidates || candidates.length < COHORT_MIN_MEMBERS_FOR_DAMPING) {
    return null
  }

  // Score similarity. We use the same weighted dim model as
  // cohort-match (guest_count z-score + season match + source
  // match), and take the top 10 to define the cohort. Keeping the
  // logic identical here means the heat-damping cohort and the
  // displayed cohort-match insight talk about THE SAME 10 weddings.
  // If they ever drift, coordinators will see a heat damping that
  // disagrees with the cohort tile, which is exactly the bug we are
  // fixing.
  const guestCounts = candidates
    .map((c) => (c as { guest_count_estimate: number | null }).guest_count_estimate)
    .filter((v): v is number => v !== null)
  const guestStats = computeMeanStd(guestCounts)

  type Cand = {
    id: string
    status: string
    guest_count_estimate: number | null
    source: string | null
    wedding_date: string | null
  }
  const scored: Array<{ cand: Cand; similarity: number; dimsUsed: number }> = []
  for (const raw of candidates as Cand[]) {
    const candSeason = deriveSeasonForDate(raw.wedding_date)
    let total = 0
    let weight = 0
    let dims = 0

    if (currentGuestCount !== null && raw.guest_count_estimate !== null) {
      const zCurrent = (currentGuestCount - guestStats.mean) / guestStats.std
      const zCand = (raw.guest_count_estimate - guestStats.mean) / guestStats.std
      const sim = Math.exp(-Math.abs(zCurrent - zCand))
      total += sim * 1.0
      weight += 1.0
      dims++
    }
    if (currentSeason !== null && candSeason !== null) {
      total += (currentSeason === candSeason ? 1 : 0) * 0.8
      weight += 0.8
      dims++
    }
    if (currentSource !== null && raw.source !== null) {
      total += (currentSource === raw.source ? 1 : 0) * 0.5
      weight += 0.5
      dims++
    }

    if (dims === 0 || weight === 0) continue
    scored.push({ cand: raw, similarity: total / weight, dimsUsed: dims })
  }

  if (scored.length < COHORT_MIN_MEMBERS_FOR_DAMPING) return null

  const sorted = scored.sort((a, b) => {
    if (b.similarity !== a.similarity) return b.similarity - a.similarity
    return b.dimsUsed - a.dimsUsed
  }).slice(0, 10)

  if (sorted.length < COHORT_MIN_MEMBERS_FOR_DAMPING) return null

  const nBooked = sorted.filter((s) => s.cand.status === 'booked' || s.cand.status === 'completed').length
  const nTotal = sorted.length
  return { rate: nBooked / nTotal, nTotal, nBooked }
}

function deriveSeasonForDate(weddingDate: string | null): 'spring' | 'summer' | 'fall' | 'winter' | null {
  if (!weddingDate) return null
  const m = Number(weddingDate.slice(5, 7))
  if (!m || m < 1 || m > 12) return null
  if (m >= 3 && m <= 5) return 'spring'
  if (m >= 6 && m <= 8) return 'summer'
  if (m >= 9 && m <= 11) return 'fall'
  return 'winter'
}

function computeMeanStd(values: number[]): { mean: number; std: number } {
  const n = values.length
  if (n === 0) return { mean: 0, std: 1 }
  const mean = values.reduce((a, b) => a + b, 0) / n
  if (n < 2) return { mean, std: 1 }
  const v = values.reduce((acc, x) => acc + (x - mean) * (x - mean), 0) / (n - 1)
  return { mean, std: Math.sqrt(v) || 1 }
}

/**
 * Compute the post-damping score and the cohort-capped tier.
 *
 * Returns the input score / tier untouched when no cohort signal is
 * available (cohort < 5 members) or when the cohort booking rate is
 * non-pathological (>= 20%). When the rate is below the mid threshold
 * we apply a multiplicative damping factor on the score; when below
 * the low threshold we additionally cap the displayed tier at "warm"
 * regardless of the post-damping numeric.
 *
 * Caller is expected to forward `cohort` from `getCohortBookingRate`.
 */
export function applyCohortDamping(
  rawScore: number,
  cohort: { rate: number; nTotal: number; nBooked: number } | null,
): { dampedScore: number; cappedTier: string; multiplier: number } {
  const rawTier = getTier(rawScore)
  if (!cohort || cohort.nTotal < COHORT_MIN_MEMBERS_FOR_DAMPING) {
    return { dampedScore: rawScore, cappedTier: rawTier, multiplier: 1.0 }
  }

  let multiplier = 1.0
  if (cohort.rate < COHORT_DAMPING_THRESHOLD_LOW) {
    multiplier = COHORT_DAMPING_LOW_MULTIPLIER
  } else if (cohort.rate < COHORT_DAMPING_THRESHOLD_MID) {
    multiplier = COHORT_DAMPING_MID_MULTIPLIER
  }
  const dampedScore = Math.round(rawScore * multiplier)
  let cappedTier = getTier(dampedScore)

  // Tier cap at "warm" when the cohort signal is extreme (< 10%).
  // Even a damped numeric of 80+ should NOT display as "Hot" when
  // 9 of 10 comparable leads went elsewhere; the cohort information
  // is too strong a counter-signal. The numeric stays as computed so
  // the trajectory chart shows the actual damped value.
  if (cohort.rate < COHORT_DAMPING_THRESHOLD_LOW) {
    if (cappedTier === 'hot') cappedTier = 'warm'
  }
  return { dampedScore, cappedTier, multiplier }
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
// Idempotency — DB-enforced fire-once invariant
// ---------------------------------------------------------------------------

/**
 * Event types that fire AT MOST ONCE per wedding. Listed in CLAUDE.md
 * Heat scoring section. Migration 159 added a partial UNIQUE INDEX
 * (uq_engagement_events_fire_once) on (venue_id, wedding_id, event_type)
 * filtered to these types — Postgres enforces the invariant atomically
 * at INSERT time. The pre-fix SELECT-then-INSERT shouldSkipDuplicate
 * pattern had a race window where two concurrent pipeline runs (Knot
 * inquiry + Calendly booking landing in the same poll cycle) could both
 * pass the SELECT and both INSERT, double-counting heat points.
 *
 * Reopen-bypass: when a wedding is re-engaged after lost_at, the same
 * event_type can fire again (e.g. fresh tour_requested after a couple
 * comes back two months later). A pure DB unique constraint can't
 * express the cross-table check, so the bypass lives in the INSERT
 * path: on 23505 unique_violation, if weddings.lost_at is more recent
 * than the existing event's created_at, DELETE the stale event and
 * retry the INSERT. See insertEngagementEventReopenAware.
 */
const FIRE_ONCE_EVENTS = new Set([
  'initial_inquiry',
  'tour_completed',
  'tour_requested',
  'high_commitment_signal',
  'family_mentioned',
  'high_specificity',
  'tour_cancelled',
  'not_interested_signal',
])

/**
 * Insert one engagement_event row with reopen-aware retry on the
 * fire-once unique constraint (uq_engagement_events_fire_once,
 * migration 159).
 *
 * Returns true if the row landed (either first try or after reopen
 * retry); false if the unique violation was for a non-reopen case
 * (the existing fire-once event is still valid for a wedding that
 * has not been lost since).
 *
 * Non-23505 errors are logged and swallowed so the surrounding heat
 * recompute still runs — caller already passes through to
 * recalculateHeatScore which is the load-bearing step.
 */
async function insertEngagementEventReopenAware(
  supabase: ReturnType<typeof createServiceClient>,
  row: Record<string, unknown>,
): Promise<boolean> {
  const { error } = await supabase.from('engagement_events').insert(row)
  if (!error) return true

  // Postgres unique_violation. The supabase-js error shape exposes the
  // SQLSTATE in error.code.
  const code = (error as { code?: string }).code
  if (code !== '23505') {
    console.error('[heat-mapping] engagement_events insert failed:', error.message)
    return false
  }

  const eventType = row.event_type as string
  const weddingId = row.wedding_id as string | undefined
  if (!FIRE_ONCE_EVENTS.has(eventType) || !weddingId) {
    // Unique violation but not on the fire-once index — caller's batch
    // re-fired the same row twice in the same call, just no-op.
    return false
  }

  // Reopen check: was the wedding marked lost more recently than the
  // existing event's created_at? If yes, delete the stale event and
  // retry. If no, the fire-once invariant holds — no insert.
  const { data: wedding } = await supabase
    .from('weddings')
    .select('lost_at')
    .eq('id', weddingId)
    .maybeSingle()
  const lostAt = (wedding?.lost_at as string | null) ?? null
  if (!lostAt) return false  // never lost → no reopen, invariant holds

  const { data: existing } = await supabase
    .from('engagement_events')
    .select('id, created_at')
    .eq('wedding_id', weddingId)
    .eq('event_type', eventType)
    .order('created_at', { ascending: true })
    .limit(1)
  const existingRow = ((existing ?? [])[0] ?? null) as { id: string; created_at: string } | null
  if (!existingRow) return false  // race resolved — caller can retry on next pass

  if (Date.parse(existingRow.created_at) >= Date.parse(lostAt)) {
    // Existing event is post-reopen; this is a true duplicate.
    return false
  }

  // Reopen-bypass: delete the pre-loss event, retry.
  const { error: delError } = await supabase
    .from('engagement_events')
    .delete()
    .eq('id', existingRow.id)
  if (delError) {
    console.error('[heat-mapping] reopen-bypass delete failed:', delError.message)
    return false
  }

  const { error: retryError } = await supabase.from('engagement_events').insert(row)
  if (retryError) {
    console.error('[heat-mapping] reopen-bypass retry insert failed:', retryError.message)
    return false
  }
  return true
}

// ---------------------------------------------------------------------------
// Exported: recordEngagementEvent
// ---------------------------------------------------------------------------

/**
 * Record an engagement event for a wedding lead. Inserts the event,
 * recalculates the heat score, and updates the wedding record.
 *
 * Idempotent: the fire-once-per-wedding invariant is now enforced by
 * the DB unique index uq_engagement_events_fire_once (migration 159)
 * with reopen-aware retry inside insertEngagementEventReopenAware.
 * Non-fire-once event types can have multiple rows; the caller
 * doesn't have to dedup.
 */
export async function recordEngagementEvent(
  venueId: string,
  weddingId: string,
  eventType: string,
  direction: 'inbound' | 'outbound',
  metadata?: Record<string, unknown>,
  occurredAt?: string,
  correlationId?: string | null
): Promise<HeatScoreResult> {
  const supabase = createServiceClient()

  const points = await getPointsForEvent(venueId, eventType)
  const row: Record<string, unknown> = {
    venue_id: venueId,
    wedding_id: weddingId,
    event_type: eventType,
    direction,
    points,
    metadata: metadata ?? {},
  }
  if (occurredAt) row.occurred_at = occurredAt
  if (correlationId) row.correlation_id = correlationId

  await insertEngagementEventReopenAware(supabase, row)

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
  direction: 'inbound' | 'outbound',
  occurredAt?: string,
  correlationId?: string | null
): Promise<HeatScoreResult> {
  if (events.length === 0) {
    // Still return a current-state result so callers don't have to branch.
    return recalculateHeatScore(venueId, weddingId)
  }

  const supabase = createServiceClient()
  // Build candidate rows. The fire-once invariant is enforced by the
  // DB unique index (migration 159) with reopen-aware retry, so we
  // don't pre-dedup against the DB. Within-batch dedup of fire-once
  // types still helps — calling insertEngagementEventReopenAware
  // twice for the same row in the same batch would just race against
  // ourselves on the unique index.
  const candidates: Array<{ row: Record<string, unknown>; eventType: string; occurredAt: string | null }> = []
  for (const e of events) {
    const points = await getPointsForEvent(venueId, e.eventType)
    const eventOccurredAt = e.occurredAt ?? occurredAt ?? null
    const row: Record<string, unknown> = {
      venue_id: venueId,
      wedding_id: weddingId,
      event_type: e.eventType,
      direction,
      points,
      metadata: e.metadata ?? {},
    }
    if (eventOccurredAt) row.occurred_at = eventOccurredAt
    // T5-eta.3: stamp every event in the batch with the request-scoped
    // correlation id so a coordinator can chase the full lineage of
    // one inbound email across api_costs / drafts / interactions /
    // engagement_events / notifications / intelligence_insights.
    if (correlationId) row.correlation_id = correlationId
    candidates.push({ row, eventType: e.eventType, occurredAt: eventOccurredAt })
  }

  // Within-batch dedup of fire-once types — the DB index will reject
  // duplicates anyway, but we save a round-trip + spurious 23505 retry
  // by collapsing here.
  const seenOnceTypes = new Set<string>()
  const filtered: typeof candidates = []
  for (const c of candidates) {
    if (FIRE_ONCE_EVENTS.has(c.eventType)) {
      if (seenOnceTypes.has(c.eventType)) continue
      seenOnceTypes.add(c.eventType)
    }
    filtered.push(c)
  }

  // Insert one at a time so the reopen-aware retry runs per row.
  // Heat batches are small (typically 1-4 rows) so the per-row cost
  // is negligible vs the correctness gain.
  for (const c of filtered) {
    await insertEngagementEventReopenAware(supabase, c.row)
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
  //
  // Filter direction='inbound' per Playbook INV-14: heat scores
  // increment only on couple-side actions. Schema defense (CHECK +
  // NOT NULL on engagement_events.direction, migration 116) plus
  // this read-side filter (INV-16) is belt-and-braces — even a
  // future caller that forgot to gate at write time wouldn't
  // accidentally inflate heat with a venue-originated event.
  const { data: events } = await supabase
    .from('engagement_events')
    .select('points, occurred_at, created_at')
    .eq('venue_id', venueId)
    .eq('wedding_id', weddingId)
    .eq('direction', 'inbound')
    .order('occurred_at', { ascending: false })

  // PD.1 fix #2 (2026-04-30): no early-return when engagement_events
  // is empty. A wedding with deep platform-signal engagement but no
  // email/portal activity yet is a real case post-Phase B — Knot
  // candidates can resolve to a wedding before any inbound email
  // arrives. Returning 0 here would discard the entire Phase B
  // contribution computed below.

  // Sum points with time decay
  const now = Date.now()
  const dayMs = 24 * 60 * 60 * 1000
  const decayRate = 0.98

  let totalScore = 0

  for (const event of events ?? []) {
    const eventPoints = event.points as number
    const tsSource = (event.occurred_at ?? event.created_at) as string
    const eventDate = new Date(tsSource).getTime()
    const daysAgo = Math.max(0, (now - eventDate) / dayMs)

    // Apply decay: points * (0.98 ^ daysAgo)
    const decayedPoints = eventPoints * Math.pow(decayRate, daysAgo)
    totalScore += decayedPoints
  }

  // Phase D / D1.1 (2026-04-30): platform-signal contribution.
  // engagement_events captures behavior from inquiry onwards;
  // Phase B captures the PRE-inquiry signal trail. The two
  // sources don't overlap, so the contribution is genuinely
  // additive — and a lead who deeply engaged on Knot before
  // emailing is hotter than one who showed up cold.
  //
  // Per candidate: funnel_depth * 2 points, time-decayed from
  // last_seen via the same 0.98/day rate. Plus +5 cross-platform
  // bonus when 2+ distinct platforms resolved here. Plus AI-tier
  // bonus capped separately (PD.1 fix #7) so a wedding with many
  // AI-tier matches doesn't crowd out funnel evidence under the
  // overall +20 cap.
  const { data: phaseBCandidates } = await supabase
    .from('candidate_identities')
    .select('source_platform, funnel_depth, last_seen')
    .eq('resolved_wedding_id', weddingId)
    .is('deleted_at', null)
  let phaseBContribution = 0
  const platformsSeen = new Set<string>()
  for (const c of (phaseBCandidates ?? []) as Array<{ source_platform: string; funnel_depth: number; last_seen: string | null }>) {
    platformsSeen.add(c.source_platform)
    const lastSeenTs = c.last_seen ? new Date(c.last_seen).getTime() : now
    const daysAgo = Math.max(0, (now - lastSeenTs) / dayMs)
    const base = (c.funnel_depth ?? 0) * 2
    phaseBContribution += base * Math.pow(decayRate, daysAgo)
  }
  if (platformsSeen.size >= 2) {
    phaseBContribution += 5
  }
  const { count: aiTierCount } = await supabase
    .from('attribution_events')
    .select('id', { count: 'exact', head: true })
    .eq('wedding_id', weddingId)
    .in('tier', ['tier_2_ai', 'tier_2_wide_ai'])
    .is('reverted_at', null)
  // AI bonus capped at +6 (max 2 matches contribute) so heavy AI
  // attribution can't dominate the 20-point Phase B headroom.
  if (typeof aiTierCount === 'number' && aiTierCount > 0) {
    phaseBContribution += Math.min(6, aiTierCount * 3)
  }
  totalScore += Math.min(20, phaseBContribution)

  // Clamp score to 0-100
  const rawScore = Math.max(0, Math.min(100, Math.round(totalScore)))

  // T5-Rixey-FFF Bug 6: cohort-aware damping. Pull the lookalike
  // cohort booking rate; when comparable leads aren't booking, damp
  // the heat score and (if the rate is extreme) cap the displayed
  // tier. We damp on the FINAL score, not on individual events, so
  // historical lead_score_history rows retain their original (raw)
  // observation values — the trajectory chart for this wedding will
  // show the damping kick in from this snapshot forward, which is
  // factually accurate (the cohort signal arrived now).
  let cohort: { rate: number; nTotal: number; nBooked: number } | null = null
  try {
    cohort = await getCohortBookingRate(supabase, venueId, weddingId)
  } catch (err) {
    // Cohort lookup is enrichment, not critical. Heat scoring still
    // runs with raw score on lookup failure.
    console.warn('[heat-mapping] cohort rate lookup failed:', (err as Error).message)
  }

  const damping = applyCohortDamping(rawScore, cohort)
  const newScore = damping.dampedScore
  const temperatureTier = damping.cappedTier

  // Observability: when damping fired, emit a structured event so
  // operators can audit which weddings were re-rated by the cohort
  // signal. Stays a console line (no DB write) because heat
  // recompute runs on every email and we don't want to flood
  // intelligence_insights with informational rows. The data is
  // sufficient to reconstruct the decision: venue, wedding, raw vs
  // damped score, the cohort rate / size, and the resulting tier
  // cap (if any).
  if (damping.multiplier !== 1.0 || damping.cappedTier !== getTier(rawScore)) {
    console.log(
      JSON.stringify({
        event: 'heat_score_cohort_damped',
        venue_id: venueId,
        wedding_id: weddingId,
        raw_score: rawScore,
        damped_score: newScore,
        multiplier: damping.multiplier,
        raw_tier: getTier(rawScore),
        capped_tier: damping.cappedTier,
        cohort_rate: cohort?.rate ?? null,
        cohort_n_total: cohort?.nTotal ?? null,
        cohort_n_booked: cohort?.nBooked ?? null,
      })
    )
  }

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

  // Tier-B #83: parallelize per-wedding work. Each wedding's decay /
  // warnings / auto-lost processing is independent, so the previous
  // serial `for…await` loop produced O(N) sequential round trips for
  // a venue with N active inquiries. Now Promise.all over the whole
  // list runs the writes concurrently. Concurrency is naturally
  // capped by Supabase's pool (10-15 simultaneous connections via
  // PgBouncer), and Promise.allSettled isolates per-wedding failures
  // so one bad row doesn't poison the whole sweep.
  //
  // Counts are mutated inside the per-wedding closure under the
  // single-threaded JS event loop — no atomic-counter races.
  //
  // Round-5 follow-up: surface latency + concurrency to metered_events
  // so we can detect Supabase pool back-pressure (queueing showing up
  // as P99 latency growth without P50 movement). Histogram dimensions
  // include venueId + concurrency size for ad-hoc filtering.
  const parallelStartedAt = Date.now()
  const concurrencySize = weddings.length
  const results = await Promise.allSettled(
    weddings.map(async (wedding) => {
      const weddingId = wedding.id as string
      const oldScore = (wedding.heat_score as number) ?? 0
      const oldTier = (wedding.temperature_tier as string) ?? 'cool'

      const lastActivity =
        latestByWedding.get(weddingId) ?? (wedding.inquiry_date as string | null)
      const silentDays = lastActivity
        ? Math.floor((now.getTime() - new Date(lastActivity).getTime()) / (1000 * 60 * 60 * 24))
        : 0

      // Branch 1: heat decay
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

      // Branch 2: graduated cooling warnings
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
                ? 'This lead is slipping. A follow-up now may save it.'
                : 'Last chance before auto-lost. Send a final outreach or mark lost intentionally.'
            }`,
          })
          fired.add(type)
          warningsFired++
        }
      }

      // Branch 3: auto-mark-lost
      if (lostAutoMarkDays > 0 && silentDays >= lostAutoMarkDays) {
        try {
          await markAsLost(weddingId, `auto: no response after ${silentDays} days`)
          autoLostCount++
        } catch (err) {
          console.error(`[heat-mapping] auto-mark-lost failed for ${weddingId}:`, err)
        }
      }
    }),
  )

  const failures = results.filter((r) => r.status === 'rejected')
  if (failures.length > 0) {
    console.error(
      `[heat-mapping] ${failures.length} of ${weddings.length} wedding decays failed`,
    )
  }

  // Round-5 follow-up: emit per-batch latency histogram. Watch for
  // P99 climbing while P50 stays flat — signals PgBouncer queueing.
  void recordHistogram('heat_decay.batch_latency_ms', Date.now() - parallelStartedAt, {
    venueId,
    dimension: {
      concurrency: concurrencySize,
      decayed: decayedCount,
      auto_lost: autoLostCount,
      failures: failures.length,
    },
  })

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

  // Record engagement event. Direction: 'inbound' — couple committed
  // (signed contract, paid). Per INV-13 every engagement_event has
  // explicit direction at write time.
  await supabase.from('engagement_events').insert({
    venue_id: venueId,
    wedding_id: weddingId,
    event_type: 'contract_signed',
    direction: 'inbound',
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

  // Round-5 follow-up: parallelize the 4 writes. The UPDATE and 3
  // INSERTs all depend on the SELECT above but not on each other —
  // engagement_events / lost_deals / lead_score_history each capture
  // an independent facet of the marked-lost transition. Running them
  // concurrently turns a 5-round-trip call into 2 (1 read + 1 batched
  // parallel writes). At venue scale (50+ auto-marks per cron tick
  // via applyDailyDecay), that's 250 → 100 sequential operations.
  await Promise.all([
    supabase
      .from('weddings')
      .update({
        status: 'lost',
        heat_score: 0,
        temperature_tier: 'frozen',
        lost_at: now,
        lost_reason: reason ?? null,
        updated_at: now,
      })
      .eq('id', weddingId),

    // Record engagement event. Direction: 'inbound' for the audit row —
    // the wedding-state observation belongs alongside the inbound
    // couple-side timeline. The -100 points here are nominal: the UPDATE
    // sibling sets weddings.heat_score = 0 directly, so this row is
    // mostly an audit trail and recalculateHeatScore re-runs only
    // matter if heat is later recomputed against this dataset. Keeping
    // direction='inbound' avoids a phantom outbound event in the
    // timeline that the couple never actually triggered. INV-13.
    supabase.from('engagement_events').insert({
      venue_id: venueId,
      wedding_id: weddingId,
      event_type: 'marked_lost',
      direction: 'inbound',
      points: DEFAULT_POINTS.marked_lost,
      metadata: { reason: reason ?? null, lost_to: lostTo ?? null },
    }),

    // Insert lost_deals record
    // signal-class-justified: lost-deals are structurally always outcome
    supabase.from('lost_deals').insert({
      venue_id: venueId,
      wedding_id: weddingId,
      lost_at_stage: previousStage,
      reason_category: lostTo ? 'competitor' : 'other',
      reason_detail: reason ?? null,
      competitor_name: lostTo ?? null,
      lost_at: now,
      signal_class: 'outcome',
    }),

    // Insert score history snapshot
    supabase.from('lead_score_history').insert({
      venue_id: venueId,
      wedding_id: weddingId,
      score: 0,
      temperature_tier: 'frozen',
      calculated_at: now,
    }),
  ])

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

  // Get engagement events in a matching time window to correlate.
  // T5-Rixey-LL: window on occurred_at (real event time) not created_at
  // (insertion time). Backfilled events have occurred_at = real signal
  // time and created_at = import day; the heat-history correlator must
  // match on the event-time so reconstructed timelines are accurate.
  const oldestEntry = history[history.length - 1]
  const { data: events } = await supabase
    .from('engagement_events')
    .select('event_type, points, occurred_at')
    .eq('wedding_id', weddingId)
    .gte('occurred_at', oldestEntry.calculated_at as string)
    .order('occurred_at', { ascending: false })

  // Build a map of event timestamps (rounded to seconds) to event info
  const eventMap = new Map<number, { eventType: string; points: number }>()
  for (const e of events ?? []) {
    const ts = Math.floor(new Date(e.occurred_at as string).getTime() / 1000)
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
    // T2-F: HoneyBook lifecycle. Signed + payment land at booked status —
    // recommend the next post-booking touch. Refund is a state collapse —
    // surface to coordinator. Amendment is informational — no action.
    case 'honeybook_contract_signed':
      return 'Booked via HoneyBook — kick off planning onboarding'
    case 'honeybook_payment_received':
      return 'Payment cleared — confirm next planning step'
    case 'honeybook_refund':
      return 'Refund issued via HoneyBook — call the couple before changing wedding state'
    case 'honeybook_amendment':
      return 'Contract amended via HoneyBook — review the change with the couple'
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
