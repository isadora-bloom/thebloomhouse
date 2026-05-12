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
  // Voice / SMS engagement signals (per-channel). Inbound = couple-side
  // engagement that should bump heat. Outbound = venue-side activity and
  // scores 0 (or low for legacy call_outbound above). Wave 28 wires these
  // through openphone.ts persistRow + zoom.ts syncMeetings.
  //
  // Direction filter at read time (recalculateHeatScore reads
  // direction='inbound' only) is the load-bearing guard — the per-channel
  // point values listed here are the design intent if a future caller
  // ever fires an outbound row with one of these types.
  sms_received: 8,                    // Inbound SMS — significant engagement, more than passive page view
  sms_sent: 0,                        // Outbound SMS — venue activity, doesn't bump couple heat
  call_inbound: 12,                   // Couple called us — strong engagement
  call_inbound_with_transcript: 18,   // Connected call with transcript text — even stronger (real conversation)
  voicemail_received: 5,              // Voicemail FROM couple — moderate signal
  zoom_meeting_completed: 25,         // Meeting actually happened — closer to tour_completed
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
  overridden?: boolean
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
 * Read the current heat score from the wedding_heat view (migration 316).
 *
 * STRUCTURAL CHANGE (2026-05-12, IDENTITY-RESOLUTION-AUDIT F1 fix):
 * Heat is no longer a stored column. The previous implementation
 * computed the decayed-sum + Phase B contribution + cohort damping in
 * TS and wrote it back to weddings.heat_score / temperature_tier.
 * Every engagement-event writer that forgot to call this function
 * left the column stale at 0. The Wave 28 voice-events backfill was
 * the bug that triggered the audit (Justin & Sandy at Rixey: 14
 * engagement_events with points=8 each but heat_score=0 because the
 * backfill never called recalc).
 *
 * Post-fix: weddings.heat_score and weddings.temperature_tier have
 * been dropped (migration 316). Heat is computed at read time by the
 * wedding_heat view, which inlines the same 0.98^days decay + Phase B
 * contribution + operator-override short-circuit. Cohort damping is
 * NOT in the view (too expensive at read time at venue scale); the
 * heat-narration insight that needs damping still calls
 * applyCohortDamping in TS against the view's heat_score.
 *
 * This function is preserved (does not throw, returns the same shape)
 * so existing callers continue to work. It now reads from the view
 * instead of computing+writing. The cohort damping computation that
 * used to apply here is left to the narration layer.
 *
 * Callers that previously relied on the side effects (lead_score_history
 * row insert) need to be reviewed: applyDailyDecay still writes those
 * snapshots when it runs, and markAsBooked / markAsLost still snapshot
 * on state transitions. Per-email snapshots are gone; the view itself
 * is the canonical source so the audit never depended on them anyway.
 */
export async function recalculateHeatScore(
  venueId: string,
  weddingId: string
): Promise<HeatScoreResult> {
  const supabase = createServiceClient()

  const { data: row } = await supabase
    .from('wedding_heat')
    .select('heat_score, temperature_tier, is_overridden')
    .eq('wedding_id', weddingId)
    .eq('venue_id', venueId)
    .maybeSingle()

  const score = (row?.heat_score as number | null | undefined) ?? 0
  const tier = (row?.temperature_tier as string | null | undefined) ?? 'cool'
  const overridden = Boolean((row as { is_overridden?: boolean } | null | undefined)?.is_overridden)

  return {
    weddingId,
    newScore: score,
    previousScore: score,
    temperatureTier: tier,
    pointsAwarded: 0,
    overridden,
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
 * Apply graduated cooling warnings + auto-mark-lost in a single pass
 * over all active inquiries for a venue.
 *
 * Pre-migration-316: this function also wrote a "heat decay" pass that
 * multiplied weddings.heat_score by 0.98 every day. Post-316 that's a
 * no-op: heat is a view (migration 316 / wedding_heat) and the 0.98^days
 * decay is intrinsic to the view's formula, so no daily catch-up runs.
 *
 * The decayedCount return value is preserved for caller compatibility
 * but is now structurally always 0 (decay is implicit; nothing to
 * count). The cron caller surfaces it as informational only.
 *
 * Per wedding:
 *   1. Compute silentDays = now - last inbound interaction (or inquiry_date
 *      if no interactions yet). This is the "days since we last heard from
 *      them" number that drives 2 + 3.
 *   2. Fire graduated cooling-warning notifications at 14 / 21 / 27 days.
 *      Each stage fires at most once per wedding — dedup is by admin_
 *      notifications (venue_id, wedding_id, type), so notifications are
 *      skipped on subsequent days. Coordinators can clear the notification
 *      row to re-trigger a warning if they want.
 *   3. When silentDays reaches venue_config.lost_auto_mark_days (default
 *      30, venue-configurable to 0 for disabled), call markAsLost with
 *      reason='auto: no response after N days'. This writes the lost_deals
 *      row, the engagement_event, the score snapshot — same lifecycle as a
 *      manual mark-lost.
 *
 * Designed to be called by a daily cron job (e.g. 6:00 AM).
 */
export async function applyDailyDecay(venueId: string): Promise<DecaySummary> {
  const supabase = createServiceClient()
  const now = new Date()

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
  // silentDays when no inbound interaction exists yet. We no longer
  // need heat_score / temperature_tier here (migration 316 dropped
  // them); the cooling-warning + auto-lost branches read silentDays
  // only.
  const { data: weddings } = await supabase
    .from('weddings')
    .select('id, inquiry_date, status')
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

  // decayedCount is preserved in DecaySummary for caller compatibility
  // but is structurally always 0 post-316: heat decay is intrinsic to
  // the wedding_heat view (0.98^days inside the SUM). No daily catch-up
  // pass is needed.
  const decayedCount = 0
  let warningsFired = 0
  let autoLostCount = 0

  // Tier-B #83: parallelize per-wedding work. Each wedding's
  // warnings / auto-lost processing is independent, so the previous
  // serial loop produced O(N) sequential round trips. Now
  // Promise.allSettled runs the writes concurrently and isolates
  // per-wedding failures.
  const parallelStartedAt = Date.now()
  const concurrencySize = weddings.length
  const results = await Promise.allSettled(
    weddings.map(async (wedding) => {
      const weddingId = wedding.id as string

      const lastActivity =
        latestByWedding.get(weddingId) ?? (wedding.inquiry_date as string | null)
      const silentDays = lastActivity
        ? Math.floor((now.getTime() - new Date(lastActivity).getTime()) / (1000 * 60 * 60 * 24))
        : 0

      // Branch 1: graduated cooling warnings
      const fired = firedByWedding.get(weddingId) ?? new Set<string>()
      for (const stage of COOLING_WARNING_DAYS) {
        const type = `cooling_warning_${stage}d`
        if (silentDays >= stage && !fired.has(type)) {
          await createNotification({
            venueId,
            weddingId,
            type,
            title: `Couple cooling, ${stage} days silent`,
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

      // Branch 2: auto-mark-lost
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
 *
 * Reads heat_score / temperature_tier from the wedding_heat view
 * (migration 316). The columns no longer exist on the weddings table.
 */
export async function getLeaderboard(
  venueId: string,
  limit = 25
): Promise<LeaderboardEntry[]> {
  const supabase = createServiceClient()

  // Pull the active inquiries + their heat_score from the view in
  // parallel. We then join in memory and sort by score. PostgREST
  // doesn't expose ORDER BY across an aggregated view at supabase-js
  // level without RPC, and the venue's inquiry count is small enough
  // (typically < 200) that in-memory sort is the right tradeoff for
  // simplicity.
  const [weddingsRes, heatRes] = await Promise.all([
    supabase
      .from('weddings')
      .select('id, status, source, inquiry_date, wedding_date')
      .eq('venue_id', venueId)
      .eq('status', 'inquiry'),
    supabase
      .from('wedding_heat')
      .select('wedding_id, heat_score, temperature_tier')
      .eq('venue_id', venueId)
      .gt('heat_score', 0),
  ])

  if (weddingsRes.error) {
    console.error('[heat-mapping] Failed to fetch leaderboard weddings:', weddingsRes.error.message)
    return []
  }
  if (heatRes.error) {
    console.error('[heat-mapping] Failed to fetch leaderboard heat:', heatRes.error.message)
    return []
  }

  const heatByWedding = new Map<string, { heat_score: number; temperature_tier: string }>()
  for (const h of heatRes.data ?? []) {
    heatByWedding.set(h.wedding_id as string, {
      heat_score: h.heat_score as number,
      temperature_tier: h.temperature_tier as string,
    })
  }

  const rows: LeaderboardEntry[] = []
  for (const w of weddingsRes.data ?? []) {
    const heat = heatByWedding.get(w.id as string)
    if (!heat) continue
    rows.push({
      weddingId: w.id as string,
      heatScore: heat.heat_score,
      temperatureTier: heat.temperature_tier,
      status: w.status as string,
      source: w.source as string | null,
      inquiryDate: w.inquiry_date as string | null,
      weddingDate: w.wedding_date as string | null,
    })
  }

  rows.sort((a, b) => b.heatScore - a.heatScore)
  return rows.slice(0, limit)
}

// ---------------------------------------------------------------------------
// Exported: getHeatDistribution
// ---------------------------------------------------------------------------

/**
 * Get the count of weddings per temperature tier. Used for the dashboard
 * heat distribution chart.
 *
 * Reads temperature_tier from the wedding_heat view (migration 316). We
 * also need to filter to status='inquiry' which lives on weddings, so
 * the call is a two-query join in memory. The view returns one row per
 * wedding so the in-memory map is venue-bounded (typically < 500 rows).
 */
export async function getHeatDistribution(venueId: string): Promise<HeatDistribution> {
  const supabase = createServiceClient()

  const distribution: HeatDistribution = {
    hot: 0,
    warm: 0,
    cool: 0,
    cold: 0,
    frozen: 0,
  }

  const [inquiriesRes, heatRes] = await Promise.all([
    supabase
      .from('weddings')
      .select('id')
      .eq('venue_id', venueId)
      .eq('status', 'inquiry'),
    supabase
      .from('wedding_heat')
      .select('wedding_id, temperature_tier')
      .eq('venue_id', venueId),
  ])

  if (inquiriesRes.error || heatRes.error) {
    return distribution
  }

  const inquiryIds = new Set<string>((inquiriesRes.data ?? []).map((r) => r.id as string))
  for (const row of heatRes.data ?? []) {
    if (!inquiryIds.has(row.wedding_id as string)) continue
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
 *
 * Reads heat_score / temperature_tier from the wedding_heat view (migration
 * 316). Filters active inquiries against the weddings table, then joins the
 * view in memory for the score threshold + sort.
 */
export async function getHotLeads(
  venueId: string,
  minScore = 75
): Promise<HotLead[]> {
  const supabase = createServiceClient()

  // Pull active inquiries + heat scores in parallel; join + filter in
  // memory by score threshold. Same pattern as getLeaderboard.
  const [weddingsRes, heatRes] = await Promise.all([
    supabase
      .from('weddings')
      .select('id, status, source, inquiry_date, wedding_date')
      .eq('venue_id', venueId)
      .eq('status', 'inquiry'),
    supabase
      .from('wedding_heat')
      .select('wedding_id, heat_score, temperature_tier')
      .eq('venue_id', venueId)
      .gte('heat_score', minScore),
  ])

  if (weddingsRes.error || heatRes.error) return []
  if (!weddingsRes.data || weddingsRes.data.length === 0) return []
  if (!heatRes.data || heatRes.data.length === 0) return []

  const heatByWedding = new Map<string, { heat_score: number; temperature_tier: string }>()
  for (const h of heatRes.data) {
    heatByWedding.set(h.wedding_id as string, {
      heat_score: h.heat_score as number,
      temperature_tier: h.temperature_tier as string,
    })
  }

  // Filter the weddings to those that survived the heat threshold AND
  // are status='inquiry'. Then re-shape into the same row layout the
  // old query produced so the partner-name / event-suggestion logic
  // below stays unchanged.
  const weddings = weddingsRes.data
    .filter((w) => heatByWedding.has(w.id as string))
    .map((w) => {
      const heat = heatByWedding.get(w.id as string)!
      return {
        id: w.id,
        heat_score: heat.heat_score,
        temperature_tier: heat.temperature_tier,
        status: w.status,
        source: w.source,
        inquiry_date: w.inquiry_date,
        wedding_date: w.wedding_date,
      }
    })
    .sort((a, b) => (b.heat_score as number) - (a.heat_score as number))

  if (weddings.length === 0) return []

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

  // Get all active inquiries + their current heat. wedding_heat view
  // (migration 316) replaces the dropped weddings.heat_score column.
  const [weddingsRes, heatRes] = await Promise.all([
    supabase
      .from('weddings')
      .select('id, wedding_date')
      .eq('venue_id', venueId)
      .eq('status', 'inquiry'),
    supabase
      .from('wedding_heat')
      .select('wedding_id, heat_score, temperature_tier')
      .eq('venue_id', venueId)
      .gt('heat_score', 0),
  ])

  if (weddingsRes.error || heatRes.error) return []
  if (!weddingsRes.data || weddingsRes.data.length === 0) return []

  const heatByWedding = new Map<string, { heat_score: number; temperature_tier: string }>()
  for (const h of heatRes.data ?? []) {
    heatByWedding.set(h.wedding_id as string, {
      heat_score: h.heat_score as number,
      temperature_tier: h.temperature_tier as string,
    })
  }

  const weddings = weddingsRes.data
    .filter((w) => heatByWedding.has(w.id as string))
    .map((w) => {
      const heat = heatByWedding.get(w.id as string)!
      return {
        id: w.id,
        heat_score: heat.heat_score,
        temperature_tier: heat.temperature_tier,
        wedding_date: w.wedding_date,
      }
    })

  if (weddings.length === 0) return []

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

  // Update wedding status. Migration 316 dropped heat_score / temperature_tier
  // (heat is now a view). The contract_signed engagement_event below is what
  // actually carries the score into wedding_heat: +50 points, fresh
  // occurred_at = today, decay factor 1.0 = +50 immediately. The booked status
  // change drives the lifecycle; heat is implicit.
  await supabase
    .from('weddings')
    .update({
      status: 'booked',
      booked_at: now,
      notes: notes ? notes : undefined,
      updated_at: now,
    })
    .eq('id', weddingId)

  // Record engagement event. Direction: 'inbound' = couple committed
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
        lost_at: now,
        lost_reason: reason ?? null,
        updated_at: now,
      })
      .eq('id', weddingId),

    // Record engagement event. Direction: 'inbound' for the audit row.
    // The wedding-state observation belongs alongside the inbound
    // couple-side timeline. The -100 points cancel out accumulated
    // engagement when wedding_heat re-aggregates (migration 316 made
    // heat a view, so the -100 here is no longer redundant with a
    // weddings.heat_score=0 write). Keeping direction='inbound' avoids
    // a phantom outbound event in the timeline that the couple never
    // actually triggered. INV-13.
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

  // Get all weddings (both active and completed) plus their heat tier
  // from the wedding_heat view (migration 316). Conversion rates are
  // computed against the booked/total ratio per tier.
  const [weddingsRes, heatRes] = await Promise.all([
    supabase
      .from('weddings')
      .select('id, status')
      .eq('venue_id', venueId),
    supabase
      .from('wedding_heat')
      .select('wedding_id, temperature_tier')
      .eq('venue_id', venueId),
  ])

  const allWeddingsRaw = weddingsRes.data ?? []
  const heatRows = heatRes.data ?? []

  if (allWeddingsRaw.length === 0) {
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

  const tierByWedding = new Map<string, string>()
  for (const h of heatRows) {
    tierByWedding.set(h.wedding_id as string, (h.temperature_tier as string) ?? 'cool')
  }

  const allWeddings = allWeddingsRaw.map((w) => ({
    id: w.id,
    status: w.status,
    temperature_tier: tierByWedding.get(w.id as string) ?? 'cool',
  }))

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
