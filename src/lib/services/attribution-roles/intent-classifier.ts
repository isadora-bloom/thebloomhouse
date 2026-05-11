/**
 * Wave 16 — Inquiry intent classifier (broadcast vs targeted vs validation).
 *
 * Anchor docs:
 *   - bloom-constitution.md (forensic identity reconstruction; same
 *     evidence-chain rigor applied to inquiry intent)
 *   - bloom-may9-llm-vs-template.md (deterministic where signals are
 *     clear; Haiku judge only for ambiguous 40-59 templateScore band)
 *   - feedback_self_reported_sources_not_truth.md (disagreement is the
 *     gold — Wave 16 produces another disagreement axis: stated
 *     channel vs ACTUAL intent of the inquiry)
 *   - feedback_deep_fix_vs_bandaid.md (layer fix not rule — intent
 *     classification is a NEW orthogonal dimension on attribution_
 *     events, not a tweak to Wave 7B's role classifier)
 *
 * What this service does
 * ----------------------
 * For one attribution_events row on a broadcast-capable platform
 * (theknot, weddingwire — for now), classify the INTENT of the
 * inquiry as one of:
 *   - targeted: couple actively chose this venue
 *   - broadcast: platform's "similar venues" button auto-distributed
 *     the inquiry; couple didn't actively pick us
 *   - validation: couple discovered the venue elsewhere; this is the
 *     intake form
 *   - unknown: not classifiable (non-broadcast-capable platform, or
 *     deferred due to insufficient data)
 *
 * Orthogonal to Wave 7B's role classifier
 * ---------------------------------------
 * Wave 7B classifies CHANNEL ROLE (acquisition vs validation vs
 * conversion vs mixed). Wave 16 classifies INQUIRY INTENT (targeted
 * vs broadcast vs validation). They live on different columns and
 * are computed independently — neither overwrites the other.
 *
 * The CAC-strategy combinations that matter:
 *   - role=acquisition + intent=targeted = real Knot acquisition.
 *     FULL CAC weight.
 *   - role=acquisition + intent=broadcast = Knot pushed us; couple
 *     did not actively choose. Should NOT carry full CAC weight.
 *   - role=validation + intent=*       = couple found us elsewhere;
 *     intent dimension is informational only for this case.
 *
 * Important: when Wave 7B has already classified the role as
 * 'validation', we DO NOT override the intent dimension to 'validation'
 * automatically. The two columns are independent — Wave 7B's
 * validation refers to channel role, Wave 16's validation refers to
 * inquiry intent. Coordinator reading both columns sees the full
 * picture; over-coupling them in code hides the signal.
 *
 * Algorithm
 * ---------
 * 1. Gate: only run for broadcast-capable platforms (theknot,
 *    weddingwire). Other platforms → 'unknown' (skipped; no DB write
 *    unless force=true).
 *
 * 2. Load: attribution_event + linked wedding + linked interactions.
 *    The inquiry interaction is the inbound message closest to
 *    wedding.inquiry_date.
 *
 * 3. Template detection: run knot-template-detector against the
 *    inquiry interaction → templateScore (0-100) + matchedPatterns.
 *
 * 4. Post-inquiry engagement signals: count interactions + tour
 *    bookings within 14 days after the inquiry.
 *
 * 5. Multi-venue timing cluster (Wedgewood-scale, not Rixey-scale):
 *    look for OTHER venues' attribution_events with the same couple
 *    (via wedding email match) within ±5 min of decided_at. At
 *    single-venue scale this always returns 0 — we flag the
 *    "single-venue mode, cannot timing-cluster" signal.
 *
 * 6. Forensic rules:
 *      templateScore >= 60 AND no_post_inquiry_engagement → 'broadcast'
 *      templateScore >= 60 AND post_inquiry_engagement_present → 'targeted'
 *      templateScore < 40 → 'targeted'
 *      templateScore 40-59 → defer to Haiku judge
 *
 * 7. Haiku judge for ambiguous 40-59 band only.
 *
 * Idempotent: re-running on unchanged data produces the same intent.
 * Pure: never writes to the DB. The caller (sweep / bulk endpoint /
 * single classify) handles persistence.
 */

import type { SupabaseClient } from '@supabase/supabase-js'
import { createServiceClient } from '@/lib/supabase/service'
import { callAI } from '@/lib/ai/client'
import { detectKnotTemplateSignal } from './knot-template-detector'
import {
  buildInquiryIntentSystemPrompt,
  buildInquiryIntentUserPrompt,
  validateInquiryIntentOutput,
  INQUIRY_INTENT_JUDGE_PROMPT_VERSION,
  type IntentJudgeEvidence,
} from '@/config/prompts/inquiry-intent-judge'

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Platforms whose inquiries we classify on the intent dimension.
 *  Only broadcast-capable platforms (the "Inquire to similar venues"
 *  pattern is specific to Knot + WeddingWire today). Other platforms
 *  default to 'unknown' which is the inert state — they neither claim
 *  broadcast nor targeted. */
const BROADCAST_CAPABLE_PLATFORMS = new Set([
  'the_knot',
  'theknot',
  'theknot.com',
  'weddingwire',
  'wedding_wire',
  'weddingwire.com',
])

/** Window for post-inquiry engagement signal counting. */
const POST_INQUIRY_WINDOW_MS = 14 * 24 * 60 * 60 * 1000

/** Templating-score thresholds. */
const BROADCAST_HARD_THRESHOLD = 60
const TARGETED_HARD_THRESHOLD = 40
/** Multi-venue timing cluster window (mostly informational at Rixey
 *  scale; useful at Wedgewood scale once cross-venue inserts land). */
const TIMING_CLUSTER_WINDOW_MS = 5 * 60 * 1000

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export type IntentClass = 'targeted' | 'broadcast' | 'validation' | 'unknown'

export interface IntentSignals {
  templateScore: number
  matchedPatterns: string[]
  postInquiryEngagementDays: number | null
  postInquiryInteractionCount: number
  postInquiryTourCount: number
  timingClusterDetected: boolean | null
  timingClusterVenues: string[]
  forensic_path:
    | 'gate_skipped_non_broadcast_platform'
    | 'no_wedding_link'
    | 'no_inquiry_interaction'
    | 'low_template_targeted'
    | 'broadcast_no_engagement'
    | 'broadcast_with_engagement_overridden_to_targeted'
    | 'ambiguous_deferred_to_llm'
    | 'llm_judge_committed'
    | 'llm_judge_refused'
  llmJudgeFired: boolean
  llm_judge: {
    reasoning: string
    prompt_version: string
  } | null
}

export interface ClassifyIntentResult {
  intentClass: IntentClass
  confidence_0_100: number
  signals: IntentSignals
  reasoning: string
  cost_cents: number
  prompt_version: string | null
}

export interface ClassifyIntentInput {
  attributionEventId: string
}

export interface ClassifyIntentOptions {
  supabase?: SupabaseClient
  correlationId?: string
  /** Disable LLM judge; deferred cases return 'unknown' + ambiguous_deferred_to_llm. */
  noLLM?: boolean
  /** Force classification even when the platform is not broadcast-capable.
   *  Default false — non-broadcast platforms return 'unknown' with the
   *  gate_skipped_non_broadcast_platform forensic_path. */
  forceNonBroadcastPlatforms?: boolean
}

// ---------------------------------------------------------------------------
// Internal loaders
// ---------------------------------------------------------------------------

interface AttributionEventRow {
  id: string
  venue_id: string
  wedding_id: string | null
  source_platform: string | null
  signal_id: string | null
  decided_at: string
  reverted_at: string | null
  role: string | null
}

interface WeddingRow {
  id: string
  inquiry_date: string | null
}

interface InteractionRow {
  id: string
  wedding_id: string | null
  direction: string | null
  timestamp: string | null
  subject: string | null
  body_preview: string | null
  full_body: string | null
  from_email: string | null
}

interface TourRow {
  id: string
  scheduled_at: string | null
  created_at: string | null
}

interface VenueRow {
  id: string
  name: string | null
  state: string | null
}

function isBroadcastPlatform(platform: string | null): boolean {
  if (!platform) return false
  return BROADCAST_CAPABLE_PLATFORMS.has(platform.toLowerCase())
}

async function loadAttributionEvent(
  sb: SupabaseClient,
  id: string,
): Promise<AttributionEventRow | null> {
  const { data, error } = await sb
    .from('attribution_events')
    .select(
      'id, venue_id, wedding_id, source_platform, signal_id, decided_at, reverted_at, role',
    )
    .eq('id', id)
    .maybeSingle()
  if (error) throw new Error(`intent.loadAttributionEvent: ${error.message}`)
  return (data as AttributionEventRow | null) ?? null
}

async function loadWedding(
  sb: SupabaseClient,
  weddingId: string,
): Promise<WeddingRow | null> {
  const { data, error } = await sb
    .from('weddings')
    .select('id, inquiry_date')
    .eq('id', weddingId)
    .maybeSingle()
  if (error) throw new Error(`intent.loadWedding: ${error.message}`)
  return (data as WeddingRow | null) ?? null
}

async function loadVenue(
  sb: SupabaseClient,
  venueId: string,
): Promise<VenueRow | null> {
  // Venues may or may not have a state column in current Bloom schema;
  // we select defensively.
  const { data, error } = await sb
    .from('venues')
    .select('id, name')
    .eq('id', venueId)
    .maybeSingle()
  if (error) return null
  if (!data) return null
  const v = data as { id: string; name: string | null }
  return { id: v.id, name: v.name, state: null }
}

/**
 * Find the inquiry interaction for this attribution_event. Strategy:
 *   - Prefer the inbound interaction on the wedding closest in time to
 *     wedding.inquiry_date (within ±7 days).
 *   - Filter to the platform's email pattern when available (Knot's
 *     member.theknot.com / WeddingWire's authsolic relay) so we don't
 *     accidentally pick an inbound from a different channel.
 *   - Fallback: any inbound interaction for the wedding ordered by
 *     timestamp ASC. The first inbound is generally the inquiry.
 */
async function loadInquiryInteraction(
  sb: SupabaseClient,
  weddingId: string,
  platform: string | null,
  inquiryDate: string | null,
): Promise<InteractionRow | null> {
  // Build a platform-filter pattern. Conservative: when unknown, fall
  // back to wedding-scoped search.
  const fromLike = (() => {
    const p = (platform ?? '').toLowerCase()
    if (p.includes('knot')) return '%theknot%'
    if (p.includes('weddingwire') || p.includes('wedding_wire'))
      return '%weddingwire%'
    return null
  })()

  let query = sb
    .from('interactions')
    .select(
      'id, wedding_id, direction, timestamp, subject, body_preview, full_body, from_email',
    )
    .eq('wedding_id', weddingId)
    .eq('direction', 'inbound')
    .order('timestamp', { ascending: true })
    .limit(20)

  if (fromLike) {
    query = query.ilike('from_email', fromLike)
  }

  const { data, error } = await query
  if (error) {
    console.warn('[intent.loadInquiryInteraction] query failed:', error.message)
    return null
  }
  const rows = (data ?? []) as InteractionRow[]
  if (rows.length === 0) {
    // No platform-matching inbound exists for this wedding. We do NOT
    // fall back to any-inbound here — running the broadcast detector
    // against a web-form submission when the AE says theknot would
    // produce noise (we'd be detecting absence of Knot patterns on
    // a body that was never supposed to contain them). Better to
    // return null → 'unknown' (no_inquiry_interaction path).
    return null
  }

  // Pick closest to inquiry_date if provided, else first inbound.
  if (inquiryDate) {
    const target = Date.parse(inquiryDate)
    if (Number.isFinite(target)) {
      let best = rows[0]!
      let bestDelta = Infinity
      for (const r of rows) {
        const t = r.timestamp ? Date.parse(r.timestamp) : NaN
        if (!Number.isFinite(t)) continue
        const delta = Math.abs(t - target)
        if (delta < bestDelta) {
          bestDelta = delta
          best = r
        }
      }
      return best
    }
  }
  return rows[0]!
}

/**
 * Count post-inquiry interactions + tour bookings within the
 * POST_INQUIRY_WINDOW_MS window. Used to detect "couple actively
 * engaged after this inquiry".
 *
 * We count:
 *   - Any interaction (inbound OR outbound) other than the inquiry
 *     itself within 14 days after inquiry_date
 *   - Any tour with scheduled_at within 14 days after inquiry_date
 *
 * We also compute "days silent after inquiry" — the gap between
 * inquiry_date and the next interaction (NULL if no later interaction
 * exists OR the inquiry is too recent to have 14 full days of data).
 */
async function loadPostInquiryEngagement(
  sb: SupabaseClient,
  weddingId: string,
  inquiryAtIso: string,
  inquiryInteractionId: string | null,
): Promise<{
  interactionCount: number
  tourCount: number
  daysSilent: number | null
}> {
  const inquiryAt = Date.parse(inquiryAtIso)
  if (!Number.isFinite(inquiryAt)) {
    return { interactionCount: 0, tourCount: 0, daysSilent: null }
  }
  const horizonIso = new Date(inquiryAt + POST_INQUIRY_WINDOW_MS).toISOString()

  let intQuery = sb
    .from('interactions')
    .select('id', { count: 'exact', head: true })
    .eq('wedding_id', weddingId)
    .gt('timestamp', inquiryAtIso)
    .lte('timestamp', horizonIso)
  if (inquiryInteractionId) intQuery = intQuery.neq('id', inquiryInteractionId)
  const { count: interactionCount } = await intQuery

  const { count: tourCount } = await sb
    .from('tours')
    .select('id', { count: 'exact', head: true })
    .eq('wedding_id', weddingId)
    .gt('scheduled_at', inquiryAtIso)
    .lte('scheduled_at', horizonIso)

  // Days silent: gap to next interaction in any direction.
  const { data: nextInteractionRows } = await sb
    .from('interactions')
    .select('timestamp')
    .eq('wedding_id', weddingId)
    .gt('timestamp', inquiryAtIso)
    .order('timestamp', { ascending: true })
    .limit(1)
  const next = (nextInteractionRows ?? [])[0] as { timestamp: string } | undefined

  let daysSilent: number | null = null
  if (next?.timestamp) {
    const nextAt = Date.parse(next.timestamp)
    if (Number.isFinite(nextAt)) {
      daysSilent = Math.round((nextAt - inquiryAt) / (24 * 60 * 60 * 1000))
    }
  } else {
    // No subsequent interaction. If the inquiry is more than 14 days
    // old, we can confidently say "silent for >= 14 days". Otherwise
    // null (inquiry too recent to decide).
    const ageMs = Date.now() - inquiryAt
    if (ageMs >= POST_INQUIRY_WINDOW_MS) {
      daysSilent = 14
    }
  }

  return {
    interactionCount: interactionCount ?? 0,
    tourCount: tourCount ?? 0,
    daysSilent,
  }
}

/**
 * Multi-venue timing cluster check. At Wedgewood scale we look for
 * OTHER venues' attribution_events on the same couple within ±5 min
 * of this event's decided_at — strong evidence Knot's algorithm
 * blasted the inquiry to all of them.
 *
 * For single-venue Rixey this always returns 0 with
 * clusterDetected=null (cannot determine). We flag the absence rather
 * than treating it as evidence either way.
 */
async function loadTimingCluster(
  sb: SupabaseClient,
  attributionEventId: string,
  venueId: string,
  decidedAtIso: string,
  candidateIdentityIdMatch: string | null,
): Promise<{ clusterDetected: boolean | null; venueIds: string[] }> {
  // If we don't have a candidate_identity_id we can't reliably link
  // to other venues' events. Treat as cannot-determine.
  if (!candidateIdentityIdMatch) {
    return { clusterDetected: null, venueIds: [] }
  }
  const t = Date.parse(decidedAtIso)
  if (!Number.isFinite(t)) {
    return { clusterDetected: null, venueIds: [] }
  }
  const windowStart = new Date(t - TIMING_CLUSTER_WINDOW_MS).toISOString()
  const windowEnd = new Date(t + TIMING_CLUSTER_WINDOW_MS).toISOString()

  // Look for other venue attribution_events with the same candidate_identity_id
  // — which won't span venues without explicit cross-linking. So at
  // single-venue scale this naturally finds 0. Reserved for the day
  // candidate_identities span venues.
  const { data } = await sb
    .from('attribution_events')
    .select('id, venue_id')
    .eq('candidate_identity_id', candidateIdentityIdMatch)
    .neq('id', attributionEventId)
    .neq('venue_id', venueId)
    .gte('decided_at', windowStart)
    .lte('decided_at', windowEnd)
    .limit(20)

  const otherVenues = new Set<string>()
  for (const row of (data ?? []) as Array<{ id: string; venue_id: string }>) {
    otherVenues.add(row.venue_id)
  }
  if (otherVenues.size === 0) {
    // Cannot determine — we don't see cross-venue clusters at single-
    // venue scale. Flag null instead of false to avoid false negatives.
    return { clusterDetected: null, venueIds: [] }
  }
  return { clusterDetected: true, venueIds: Array.from(otherVenues) }
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

function stripPlatformChromeForJudge(body: string): string {
  // Identical strip approach to the detector's stripPlatformChrome,
  // duplicated here to keep the detector function private. We feed the
  // stripped body to the Haiku judge.
  let s = body
  s = s.replace(/The Knot Pro Network[\s\S]*?={5,}/i, '')
  s = s.replace(/={5,}/g, '')
  s = s.replace(/New (Lead|Message)( for| from| to)[^\n]*\n/gi, '')
  s = s.replace(/Reply:?\s*https?:\/\/email\.partner\.theknot\.com[^\s]*/gi, '')
  s = s.replace(/By replying, you agree[\s\S]*$/gi, '')
  s = s.replace(/WeddingPro\s*-{5,}[\s\S]*$/i, '')
  s = s.replace(/View Read Receipts![\s\S]*$/i, '')
  s = s.replace(/New Lead Information:[\s\S]*$/i, '')
  s = s.replace(/-{5,}/g, '')
  return s.replace(/\n{3,}/g, '\n\n').trim()
}

export async function classifyInquiryIntent(
  input: ClassifyIntentInput,
  options: ClassifyIntentOptions = {},
): Promise<ClassifyIntentResult> {
  const sb = options.supabase ?? createServiceClient()
  const event = await loadAttributionEvent(sb, input.attributionEventId)
  if (!event) {
    throw new Error(`intent.classify: attribution_event ${input.attributionEventId} not found`)
  }
  if (event.reverted_at) {
    return buildSkipResult('gate_skipped_non_broadcast_platform', 'attribution_event reverted')
  }

  // Gate 1 — broadcast-capable platform.
  if (!options.forceNonBroadcastPlatforms && !isBroadcastPlatform(event.source_platform)) {
    return {
      intentClass: 'unknown',
      confidence_0_100: 100,
      reasoning: `source_platform '${event.source_platform ?? '(none)'}' is not broadcast-capable; intent dimension does not apply`,
      signals: emptySignals('gate_skipped_non_broadcast_platform'),
      cost_cents: 0,
      prompt_version: null,
    }
  }

  // Gate 2 — wedding link required to load inquiry body + post-inquiry engagement.
  if (!event.wedding_id) {
    return {
      intentClass: 'unknown',
      confidence_0_100: 0,
      reasoning: 'attribution_event has no wedding_id — cannot load inquiry interaction',
      signals: emptySignals('no_wedding_link'),
      cost_cents: 0,
      prompt_version: null,
    }
  }

  const wedding = await loadWedding(sb, event.wedding_id)
  const inquiryAtIso = wedding?.inquiry_date ?? event.decided_at
  const inquiryInteraction = await loadInquiryInteraction(
    sb,
    event.wedding_id,
    event.source_platform,
    inquiryAtIso,
  )
  if (!inquiryInteraction) {
    return {
      intentClass: 'unknown',
      confidence_0_100: 0,
      reasoning: 'no inbound interaction found for wedding — cannot run template detector',
      signals: emptySignals('no_inquiry_interaction'),
      cost_cents: 0,
      prompt_version: null,
    }
  }

  // Load venue for context (name → personalisation deficit).
  const venue = await loadVenue(sb, event.venue_id)

  // Template detection
  const detection = await detectKnotTemplateSignal({
    venueId: event.venue_id,
    interaction: {
      body: inquiryInteraction.full_body,
      body_preview: inquiryInteraction.body_preview,
      subject: inquiryInteraction.subject,
      venueName: venue?.name ?? null,
    },
    supabase: sb,
  })

  // Post-inquiry engagement
  const engagement = await loadPostInquiryEngagement(
    sb,
    event.wedding_id,
    inquiryAtIso,
    inquiryInteraction.id,
  )

  // Timing cluster (mostly informational at Rixey)
  const { data: aeRow } = await sb
    .from('attribution_events')
    .select('candidate_identity_id')
    .eq('id', event.id)
    .maybeSingle()
  const candidateIdentityIdMatch = (aeRow as { candidate_identity_id: string | null } | null)
    ?.candidate_identity_id ?? null
  const cluster = await loadTimingCluster(
    sb,
    event.id,
    event.venue_id,
    event.decided_at,
    candidateIdentityIdMatch,
  )

  const baseSignals: IntentSignals = {
    templateScore: detection.templateScore,
    matchedPatterns: detection.matchedPatterns,
    postInquiryEngagementDays: engagement.daysSilent,
    postInquiryInteractionCount: engagement.interactionCount,
    postInquiryTourCount: engagement.tourCount,
    timingClusterDetected: cluster.clusterDetected,
    timingClusterVenues: cluster.venueIds,
    forensic_path: 'low_template_targeted',
    llmJudgeFired: false,
    llm_judge: null,
  }

  // Forensic rules
  const engagementPresent =
    engagement.interactionCount > 0 || engagement.tourCount > 0

  if (detection.templateScore >= BROADCAST_HARD_THRESHOLD) {
    if (!engagementPresent) {
      return {
        intentClass: 'broadcast',
        confidence_0_100: detection.templateScore >= 80 ? 92 : 80,
        reasoning:
          `templateScore=${detection.templateScore} (>= ${BROADCAST_HARD_THRESHOLD}) ` +
          `with no post-inquiry engagement in 14 days — Knot/WW broadcast distribution, couple did not actively choose.`,
        signals: { ...baseSignals, forensic_path: 'broadcast_no_engagement' },
        cost_cents: 0,
        prompt_version: null,
      }
    }
    // Template-broadcast appearance but couple DID engage post-inquiry.
    // Engagement wins — couple chose us.
    return {
      intentClass: 'targeted',
      confidence_0_100: 75,
      reasoning:
        `templateScore=${detection.templateScore} suggested broadcast but ` +
        `${engagement.interactionCount} post-inquiry interactions + ${engagement.tourCount} tour booking(s) ` +
        `show the couple actively chose this venue. Engagement overrides template appearance.`,
      signals: {
        ...baseSignals,
        forensic_path: 'broadcast_with_engagement_overridden_to_targeted',
      },
      cost_cents: 0,
      prompt_version: null,
    }
  }

  if (detection.templateScore < TARGETED_HARD_THRESHOLD) {
    return {
      intentClass: 'targeted',
      confidence_0_100: 85,
      reasoning:
        `templateScore=${detection.templateScore} (< ${TARGETED_HARD_THRESHOLD}) — ` +
        `inquiry shows personalisation, couple actively chose this venue.`,
      signals: { ...baseSignals, forensic_path: 'low_template_targeted' },
      cost_cents: 0,
      prompt_version: null,
    }
  }

  // Ambiguous 40-59 band — defer to Haiku judge unless noLLM is set.
  if (options.noLLM) {
    return {
      intentClass: 'unknown',
      confidence_0_100: 40,
      reasoning:
        `templateScore=${detection.templateScore} sits in ambiguous 40-59 band; noLLM=true so deferred to coordinator review.`,
      signals: { ...baseSignals, forensic_path: 'ambiguous_deferred_to_llm' },
      cost_cents: 0,
      prompt_version: null,
    }
  }

  // ---- Haiku judge ----
  const judgeEvidence: IntentJudgeEvidence = {
    attribution_event_id: event.id,
    source_platform: event.source_platform ?? 'unknown',
    inquiry_decided_at: event.decided_at,
    inquiry_body_stripped: stripPlatformChromeForJudge(
      inquiryInteraction.full_body ?? inquiryInteraction.body_preview ?? '',
    ),
    inquiry_subject: inquiryInteraction.subject,
    template_score_0_100: detection.templateScore,
    matched_patterns: detection.matchedPatterns,
    personalisation_deficit_0_30: detection.components.personalisationDeficit,
    post_inquiry_interaction_count: engagement.interactionCount,
    post_inquiry_tour_count: engagement.tourCount,
    post_inquiry_days_silent: engagement.daysSilent,
    venue_name: venue?.name ?? null,
    venue_state: venue?.state ?? null,
  }

  const systemPrompt = buildInquiryIntentSystemPrompt()
  const userPrompt = buildInquiryIntentUserPrompt(judgeEvidence)

  const aiResult = await callAI({
    systemPrompt,
    userPrompt,
    tier: 'haiku',
    taskType: 'inquiry_intent_judge',
    contentTier: 2,
    promptVersion: INQUIRY_INTENT_JUDGE_PROMPT_VERSION,
    venueId: event.venue_id,
    maxTokens: 500,
    temperature: 0.2,
    correlationId: options.correlationId,
  })

  const cleaned = stripJsonFences(aiResult.text)
  let parsed: unknown
  try {
    parsed = JSON.parse(cleaned)
  } catch (parseErr) {
    return {
      intentClass: 'unknown',
      confidence_0_100: 0,
      reasoning: `Haiku judge returned non-JSON; deferred to coordinator review. parseError=${
        parseErr instanceof Error ? parseErr.message : String(parseErr)
      }`,
      signals: {
        ...baseSignals,
        forensic_path: 'llm_judge_refused',
        llmJudgeFired: true,
        llm_judge: {
          reasoning: `non_json_response: ${cleaned.slice(0, 200)}`,
          prompt_version: INQUIRY_INTENT_JUDGE_PROMPT_VERSION,
        },
      },
      cost_cents: aiResult.cost * 100,
      prompt_version: INQUIRY_INTENT_JUDGE_PROMPT_VERSION,
    }
  }

  const validation = validateInquiryIntentOutput(parsed)
  if (!validation.ok) {
    return {
      intentClass: 'unknown',
      confidence_0_100: 0,
      reasoning: `Haiku judge schema invalid; deferred. error=${validation.error}`,
      signals: {
        ...baseSignals,
        forensic_path: 'llm_judge_refused',
        llmJudgeFired: true,
        llm_judge: {
          reasoning: `schema_invalid: ${validation.error}`,
          prompt_version: INQUIRY_INTENT_JUDGE_PROMPT_VERSION,
        },
      },
      cost_cents: aiResult.cost * 100,
      prompt_version: INQUIRY_INTENT_JUDGE_PROMPT_VERSION,
    }
  }

  const out = validation.output
  if (out.intent_class === null) {
    return {
      intentClass: 'unknown',
      confidence_0_100: 0,
      reasoning: `Haiku judge refused: ${out.refusal ?? 'no reason given'}`,
      signals: {
        ...baseSignals,
        forensic_path: 'llm_judge_refused',
        llmJudgeFired: true,
        llm_judge: {
          reasoning: out.refusal ?? '(no reason)',
          prompt_version: INQUIRY_INTENT_JUDGE_PROMPT_VERSION,
        },
      },
      cost_cents: aiResult.cost * 100,
      prompt_version: INQUIRY_INTENT_JUDGE_PROMPT_VERSION,
    }
  }

  return {
    intentClass: out.intent_class as IntentClass,
    confidence_0_100: out.confidence_0_100,
    reasoning: out.reasoning,
    signals: {
      ...baseSignals,
      forensic_path: 'llm_judge_committed',
      llmJudgeFired: true,
      llm_judge: {
        reasoning: out.reasoning,
        prompt_version: INQUIRY_INTENT_JUDGE_PROMPT_VERSION,
      },
    },
    cost_cents: aiResult.cost * 100,
    prompt_version: INQUIRY_INTENT_JUDGE_PROMPT_VERSION,
  }
}

// ---------------------------------------------------------------------------
// Persistence
// ---------------------------------------------------------------------------

export async function classifyAndPersistInquiryIntent(
  input: ClassifyIntentInput,
  options: ClassifyIntentOptions = {},
): Promise<ClassifyIntentResult> {
  const sb = options.supabase ?? createServiceClient()
  const result = await classifyInquiryIntent(input, { ...options, supabase: sb })

  // Wave 22: stamp prompt_version_classified_under when the intent
  // judge fired so the reclassify sweep can find rows that ran under
  // bias-suspect v1 prompts. We don't overwrite an existing
  // prompt_version_classified_under written by Wave 7B's
  // classifyAndPersistAttributionEvent (the role-judge stamp takes
  // precedence per the audit framing). Only stamp when the column
  // is currently null.
  const updatePayload: Record<string, unknown> = {
    intent_class: result.intentClass,
    intent_class_confidence_0_100: result.confidence_0_100,
    intent_classified_at: new Date().toISOString(),
    intent_class_signals: result.signals,
  }
  if (result.prompt_version) {
    const { data: existing } = await sb
      .from('attribution_events')
      .select('prompt_version_classified_under')
      .eq('id', input.attributionEventId)
      .maybeSingle()
    const existingVersion = (existing as { prompt_version_classified_under: string | null } | null)
      ?.prompt_version_classified_under
    if (!existingVersion) {
      updatePayload.prompt_version_classified_under = result.prompt_version
    }
  }

  const { error } = await sb
    .from('attribution_events')
    .update(updatePayload)
    .eq('id', input.attributionEventId)
  if (error) {
    throw new Error(
      `classifyAndPersistInquiryIntent: update failed for ${input.attributionEventId}: ${error.message}`,
    )
  }
  return result
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function emptySignals(path: IntentSignals['forensic_path']): IntentSignals {
  return {
    templateScore: 0,
    matchedPatterns: [],
    postInquiryEngagementDays: null,
    postInquiryInteractionCount: 0,
    postInquiryTourCount: 0,
    timingClusterDetected: null,
    timingClusterVenues: [],
    forensic_path: path,
    llmJudgeFired: false,
    llm_judge: null,
  }
}

function buildSkipResult(
  path: IntentSignals['forensic_path'],
  reason: string,
): ClassifyIntentResult {
  return {
    intentClass: 'unknown',
    confidence_0_100: 100,
    reasoning: reason,
    signals: emptySignals(path),
    cost_cents: 0,
    prompt_version: null,
  }
}

function stripJsonFences(text: string): string {
  return text.replace(/```json\n?/g, '').replace(/```\n?/g, '').trim()
}
