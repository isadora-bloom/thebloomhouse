/**
 * Bloom House — Wave 13 tour-prep brief generator.
 *
 * Anchor docs:
 *   - bloom-constitution.md (forensic identity reconstruction is the
 *     thesis; voice-shape output never echoes sensitive evidence_quote)
 *   - bloom-wave4-identity-reconstruction.md (Phase 3 read surfaces; the
 *     forensic profile is the substrate every Sage brief reads from)
 *
 * What this service does
 * ----------------------
 * Given a tourId, loads:
 *   - the tour row (scheduled_at, tour_type, attendees, notes, source)
 *   - the wedding shell + couple_identity_profile (Wave 4)
 *   - couple_intel summary (Wave 5A — persona, brief, sensitivity flags)
 *   - venue_intel summary (Wave 5B — top 3 emerging themes, conversion
 *     signals)
 *   - most-recent ~10 interactions
 *   - a best-effort calendar-evidence notes pull
 * Fires ONE Sonnet call (~$0.02), parses + validates, and upserts into
 * tour_prep_briefs (unique on tour_id).
 *
 * Idempotent at the upsert layer.
 */

import type { SupabaseClient } from '@supabase/supabase-js'
import { createServiceClient } from '@/lib/supabase/service'
import { callAI } from '@/lib/ai/client'
import {
  TOUR_PREP_BRIEF_PROMPT_VERSION,
  buildTourPrepSystemPrompt,
  buildTourPrepUserPrompt,
  validateTourPrepOutput,
  type TourPrepBriefOutput,
  type TourPrepEvidence,
  type TourPrepInteractionEvidence,
  type TourPrepCoupleIntelSummary,
  type TourPrepVenueIntelSummary,
  type TourPrepWeddingShell,
} from '@/config/prompts/tour-prep-brief'
import type { CoupleIdentityProfile } from '@/config/prompts/identity-reconstruction'
import type { CoupleIntelOutput } from '@/config/prompts/couple-intel-derive'
import { getVenueClimateContext } from '@/lib/services/intel/climate-context'
import { getVenueReviewsContext } from '@/lib/services/intel/reviews-context'

export {
  TOUR_PREP_BRIEF_PROMPT_VERSION,
  type TourPrepBriefOutput,
} from '@/config/prompts/tour-prep-brief'

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface GenerateTourPrepBriefArgs {
  tourId: string
  supabase?: SupabaseClient
  correlationId?: string
}

export interface GenerateTourPrepBriefResult {
  ok: true
  briefRowId: string
  tourId: string
  venueId: string
  weddingId: string | null
  brief: TourPrepBriefOutput
  costCents: number
  promptVersion: string
  inputTokens: number
  outputTokens: number
}

export interface SkipTourPrepBriefResult {
  ok: false
  reason: string
}

const MAX_INTERACTIONS = 10
const MAX_INTERACTION_BODY_CHARS = 1500

// ---------------------------------------------------------------------------
// Loaders
// ---------------------------------------------------------------------------

interface TourRow {
  id: string
  venue_id: string
  wedding_id: string | null
  scheduled_at: string | null
  tour_type: string | null
  source: string | null
  notes: string | null
}

async function loadTour(
  supabase: SupabaseClient,
  tourId: string,
): Promise<TourRow | null> {
  const { data, error } = await supabase
    .from('tours')
    .select('id, venue_id, wedding_id, scheduled_at, tour_type, source, notes')
    .eq('id', tourId)
    .maybeSingle()
  if (error) {
    throw new Error(`prep-brief.loadTour failed: ${error.message}`)
  }
  return (data as TourRow | null) ?? null
}

async function loadWedding(
  supabase: SupabaseClient,
  weddingId: string,
): Promise<TourPrepWeddingShell | null> {
  const { data, error } = await supabase
    .from('weddings')
    .select(
      'inquiry_date, wedding_date, status, source, guest_count_estimate, booking_value, notes',
    )
    .eq('id', weddingId)
    .maybeSingle()
  if (error || !data) return null
  const row = data as {
    inquiry_date: string | null
    wedding_date: string | null
    status: string | null
    source: string | null
    guest_count_estimate: number | null
    booking_value: number | null
    notes: string | null
  }
  const now = Date.now()
  const daysSinceInquiry =
    row.inquiry_date && Number.isFinite(Date.parse(row.inquiry_date))
      ? Math.max(
          0,
          Math.floor((now - Date.parse(row.inquiry_date)) / 86_400_000),
        )
      : null
  return {
    inquiry_date: row.inquiry_date,
    wedding_date: row.wedding_date,
    status: row.status,
    source: row.source,
    guest_count_estimate: row.guest_count_estimate,
    booking_value_cents: row.booking_value,
    notes: row.notes,
    days_since_inquiry: daysSinceInquiry,
    days_since_last_inbound: null, // filled by aggregator below
  }
}

async function loadProfile(
  supabase: SupabaseClient,
  weddingId: string,
): Promise<CoupleIdentityProfile | null> {
  const { data } = await supabase
    .from('couple_identity_profile')
    .select('profile')
    .eq('wedding_id', weddingId)
    .maybeSingle()
  if (!data) return null
  return (data as { profile: CoupleIdentityProfile }).profile
}

async function loadIntel(
  supabase: SupabaseClient,
  weddingId: string,
): Promise<TourPrepCoupleIntelSummary | null> {
  const { data } = await supabase
    .from('couple_intel')
    .select('intel, persona_label, predicted_close_probability_pct')
    .eq('wedding_id', weddingId)
    .maybeSingle()
  if (!data) return null
  const row = data as {
    intel: CoupleIntelOutput
    persona_label: string | null
    predicted_close_probability_pct: number | null
  }
  return {
    persona_label: row.persona_label,
    predicted_close_probability_pct: row.predicted_close_probability_pct,
    coordinator_brief: row.intel?.coordinator_brief ?? null,
    recommended_action: row.intel?.recommended_next_action?.action ?? null,
    sensitivity_flags: row.intel?.sensitivity_flags ?? [],
    stale_signal_alerts: row.intel?.stale_signal_alerts ?? [],
  }
}

interface VenueIntelRollup {
  emerging_themes?: Array<{ theme?: string; trend?: string; summary?: string }>
  conversion_correlations?: Array<{
    signal?: string
    outcome?: string
    lift_pct?: number
    reasoning?: string
  }>
}

async function loadVenueIntel(
  supabase: SupabaseClient,
  venueId: string,
): Promise<TourPrepVenueIntelSummary | null> {
  const { data } = await supabase
    .from('venue_intel')
    .select('rollup')
    .eq('venue_id', venueId)
    .maybeSingle()
  if (!data) return null
  const rollup = (data as { rollup: VenueIntelRollup }).rollup ?? {}
  const themes = (rollup.emerging_themes ?? [])
    .slice(0, 3)
    .map((t) => `${t.theme ?? '(unnamed)'}${t.summary ? ': ' + t.summary : ''}`)
  const signals = (rollup.conversion_correlations ?? [])
    .slice(0, 3)
    .map(
      (c) =>
        `${c.signal ?? '(unnamed)'} → ${c.outcome ?? 'unknown'}${
          c.lift_pct !== undefined ? ` (${c.lift_pct}%)` : ''
        }`,
    )
  if (themes.length === 0 && signals.length === 0) return null
  return { emerging_themes: themes, conversion_signals: signals }
}

async function loadVenueLabel(
  supabase: SupabaseClient,
  venueId: string,
): Promise<string | null> {
  const { data } = await supabase
    .from('venues')
    .select('name')
    .eq('id', venueId)
    .maybeSingle()
  return (data as { name?: string } | null)?.name ?? null
}

interface InteractionRow {
  id: string
  direction: string | null
  from_name: string | null
  subject: string | null
  full_body: string | null
  body_preview: string | null
  timestamp: string | null
}

async function loadRecentInteractions(
  supabase: SupabaseClient,
  weddingId: string,
): Promise<{ rows: TourPrepInteractionEvidence[]; lastInbound: string | null }> {
  const { data } = await supabase
    .from('interactions')
    .select('id, direction, from_name, subject, full_body, body_preview, timestamp')
    .eq('wedding_id', weddingId)
    .order('timestamp', { ascending: false })
    .limit(MAX_INTERACTIONS)
  const rows = (data ?? []) as InteractionRow[]
  let lastInbound: string | null = null
  const evidence: TourPrepInteractionEvidence[] = rows.map((r, idx) => {
    if (!lastInbound && r.direction === 'inbound' && r.timestamp) {
      lastInbound = r.timestamp
    }
    return {
      index: idx + 1,
      direction:
        r.direction === 'outbound' ? ('outbound' as const) : ('inbound' as const),
      from_name: r.from_name,
      subject: r.subject,
      body_excerpt:
        (r.full_body ?? r.body_preview ?? null)?.slice(0, MAX_INTERACTION_BODY_CHARS) ??
        null,
      timestamp: r.timestamp,
    }
  })
  return { rows: evidence, lastInbound }
}

async function loadCalendarEvidenceForTour(
  supabase: SupabaseClient,
  weddingId: string,
  tourScheduledAt: string | null,
): Promise<{ attendees: string | null; notes: string | null }> {
  if (!tourScheduledAt) return { attendees: null, notes: null }
  // external_calendar_events may carry attendees + agenda. Probe a window
  // around the tour. Tolerates absence — many setups don't carry this.
  try {
    const ts = Date.parse(tourScheduledAt)
    if (!Number.isFinite(ts)) return { attendees: null, notes: null }
    const from = new Date(ts - 12 * 60 * 60 * 1000).toISOString()
    const to = new Date(ts + 12 * 60 * 60 * 1000).toISOString()
    const { data } = await supabase
      .from('external_calendar_events')
      .select('title, attendees, description, start_at')
      .eq('wedding_id', weddingId)
      .gte('start_at', from)
      .lte('start_at', to)
      .limit(3)
    if (!data || data.length === 0) return { attendees: null, notes: null }
    const row = data[0] as {
      title: string | null
      attendees: string | null
      description: string | null
    }
    return { attendees: row.attendees, notes: row.description }
  } catch {
    return { attendees: null, notes: null }
  }
}

function stripJsonFences(text: string): string {
  return text.replace(/```json\n?/g, '').replace(/```\n?/g, '').trim()
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Generate (or regenerate) the tour-prep brief for one tour. One Sonnet
 * call. Upserts into tour_prep_briefs on (tour_id) unique. The brief
 * goes to the coordinator for read; this service NEVER sends an email.
 *
 * Returns either { ok: true, briefRowId, brief, cost } or { ok: false,
 * reason } — the latter when the tour has no schedule, no venue, or is
 * already in the past.
 */
export async function generateTourPrepBrief(
  args: GenerateTourPrepBriefArgs,
): Promise<GenerateTourPrepBriefResult | SkipTourPrepBriefResult> {
  const supabase = args.supabase ?? createServiceClient()
  const tour = await loadTour(supabase, args.tourId)
  if (!tour) {
    return { ok: false, reason: 'tour not found' }
  }
  if (!tour.scheduled_at) {
    return { ok: false, reason: 'tour has no scheduled_at' }
  }
  const ts = Date.parse(tour.scheduled_at)
  if (!Number.isFinite(ts)) {
    return { ok: false, reason: 'tour scheduled_at unparseable' }
  }
  const now = Date.now()
  if (ts < now - 24 * 60 * 60 * 1000) {
    // Past tours don't need a prep brief.
    return { ok: false, reason: 'tour is more than 24h in the past' }
  }
  const hoursUntil = Math.max(0, Math.floor((ts - now) / 3_600_000))

  const venueId = tour.venue_id
  const weddingId = tour.wedding_id

  const [venueLabel, calendarEv] = await Promise.all([
    loadVenueLabel(supabase, venueId),
    weddingId ? loadCalendarEvidenceForTour(supabase, weddingId, tour.scheduled_at) : Promise.resolve({ attendees: null, notes: null }),
  ])

  let wedding: TourPrepWeddingShell | null = null
  let profile: CoupleIdentityProfile | null = null
  let intel: TourPrepCoupleIntelSummary | null = null
  let interactions: TourPrepInteractionEvidence[] = []
  let lastInboundIso: string | null = null

  if (weddingId) {
    const [w, p, i, iv] = await Promise.all([
      loadWedding(supabase, weddingId),
      loadProfile(supabase, weddingId),
      loadIntel(supabase, weddingId),
      loadRecentInteractions(supabase, weddingId),
    ])
    wedding = w
    profile = p
    intel = i
    interactions = iv.rows
    lastInboundIso = iv.lastInbound
    if (wedding && lastInboundIso) {
      const parsed = Date.parse(lastInboundIso)
      if (Number.isFinite(parsed)) {
        wedding.days_since_last_inbound = Math.max(
          0,
          Math.floor((now - parsed) / 86_400_000),
        )
      }
    }
  }

  const venueIntel = await loadVenueIntel(supabase, venueId)

  // TIER 6++ (2026-05-14). Climate context for the tour's specific
  // month + hour. Lets the briefer call out "forecast is X°F vs
  // typical Y°F for this hour" without re-narrating from scratch.
  let climateContextBlock: string | null = null
  if (tour.scheduled_at) {
    const scheduledDate = new Date(tour.scheduled_at)
    if (!isNaN(scheduledDate.getTime())) {
      const climate = await getVenueClimateContext(venueId, {
        date: tour.scheduled_at,
        hour: scheduledDate.getHours(),
      })
      if (climate.available) climateContextBlock = climate.promptBlock
    }
  }

  // TIER 7d (2026-05-14). Reviews profile so the briefer can call out
  // top themes ("guests rave about the gardens — point them out") and
  // register-match phrases.
  let reviewsContextBlock: string | null = null
  try {
    const reviews = await getVenueReviewsContext(venueId)
    if (reviews.available) reviewsContextBlock = reviews.promptBlock
  } catch {
    // Reviews context is enrichment, never blocks a tour brief.
  }

  const evidence: TourPrepEvidence = {
    weddingId,
    tourId: tour.id,
    venueLabel,
    wedding,
    profile,
    intel,
    venueIntel,
    tour: {
      tour_id: tour.id,
      scheduled_at: tour.scheduled_at,
      tour_type: tour.tour_type,
      attendees: calendarEv.attendees,
      source: tour.source,
      hours_until_tour: hoursUntil,
      calendar_notes: calendarEv.notes ?? tour.notes,
    },
    recentInteractions: interactions,
    climateContextBlock,
    reviewsContextBlock,
  }

  const systemPrompt = buildTourPrepSystemPrompt()
  const userPrompt = buildTourPrepUserPrompt(evidence)

  const aiResult = await callAI({
    systemPrompt,
    userPrompt,
    tier: 'sonnet',
    taskType: 'tour_prep_brief',
    contentTier: 2,
    promptVersion: TOUR_PREP_BRIEF_PROMPT_VERSION,
    venueId,
    maxTokens: 2400,
    temperature: 0.3,
    correlationId: args.correlationId,
  })

  const cleaned = stripJsonFences(aiResult.text)
  let parsed: unknown
  try {
    parsed = JSON.parse(cleaned)
  } catch (parseErr) {
    const message = parseErr instanceof Error ? parseErr.message : String(parseErr)
    throw new Error(
      `generateTourPrepBrief: LLM returned non-JSON. parseError=${message} raw=${cleaned.slice(0, 1500)}`,
    )
  }
  const validation = validateTourPrepOutput(parsed)
  if (!validation.ok) {
    throw new Error(
      `generateTourPrepBrief: schema validation failed. error=${validation.error} raw=${cleaned.slice(0, 1500)}`,
    )
  }
  const brief = validation.brief
  const costCents = aiResult.cost * 100

  const upsertRow = {
    tour_id: tour.id,
    wedding_id: weddingId,
    venue_id: venueId,
    brief_jsonb: brief,
    generated_at: new Date().toISOString(),
    prompt_version: TOUR_PREP_BRIEF_PROMPT_VERSION,
    cost_cents: costCents,
  }

  const { data: upserted, error: upErr } = await supabase
    .from('tour_prep_briefs')
    .upsert(upsertRow, { onConflict: 'tour_id' })
    .select('id')
    .single()

  if (upErr || !upserted) {
    throw new Error(
      `generateTourPrepBrief: upsert failed: ${upErr?.message ?? 'unknown'}`,
    )
  }

  return {
    ok: true,
    briefRowId: (upserted as { id: string }).id,
    tourId: tour.id,
    venueId,
    weddingId,
    brief,
    costCents,
    promptVersion: TOUR_PREP_BRIEF_PROMPT_VERSION,
    inputTokens: aiResult.inputTokens,
    outputTokens: aiResult.outputTokens,
  }
}

// ---------------------------------------------------------------------------
// Enqueue helper
// ---------------------------------------------------------------------------

export interface EnqueueTourPrepBriefArgs {
  tourId: string
  weddingId: string | null
  venueId: string
  triggerSignal: string
  supabase?: SupabaseClient
}

export interface EnqueueResult {
  jobId: string | null
  skipped: boolean
  reason?: string
}

/**
 * Enqueue a tour-prep-brief job. Dedupes against any queued/running job
 * for the same tour in the last 48h.
 *
 * Never throws — failures return { skipped:true, reason }.
 */
export async function enqueueTourPrepBrief(
  args: EnqueueTourPrepBriefArgs,
): Promise<EnqueueResult> {
  const supabase = args.supabase ?? createServiceClient()
  try {
    const sinceIso = new Date(Date.now() - 48 * 60 * 60 * 1000).toISOString()
    const { data: existing } = await supabase
      .from('tour_prep_jobs')
      .select('id')
      .eq('tour_id', args.tourId)
      .in('status', ['queued', 'running'])
      .gte('enqueued_at', sinceIso)
      .limit(1)
      .maybeSingle()
    if (existing) {
      return {
        jobId: (existing as { id: string }).id,
        skipped: true,
        reason: 'dedupe_48h',
      }
    }
    const { data: inserted, error } = await supabase
      .from('tour_prep_jobs')
      .insert({
        tour_id: args.tourId,
        wedding_id: args.weddingId,
        venue_id: args.venueId,
        status: 'queued',
        trigger_signal: args.triggerSignal,
      })
      .select('id')
      .single()
    if (error || !inserted) {
      return { jobId: null, skipped: true, reason: 'insert_failed: ' + (error?.message ?? 'unknown') }
    }
    return { jobId: (inserted as { id: string }).id, skipped: false }
  } catch (err) {
    return {
      jobId: null,
      skipped: true,
      reason: 'threw: ' + (err instanceof Error ? err.message : String(err)),
    }
  }
}

/**
 * Read the stored brief for a tour. Returns null when no row exists.
 */
export interface StoredTourPrepBrief {
  id: string
  tourId: string
  venueId: string
  weddingId: string | null
  brief: TourPrepBriefOutput
  generatedAt: string
  viewedAt: string | null
  sentToCoordinatorAt: string | null
  promptVersion: string | null
  costCents: number
}

export async function getStoredTourPrepBrief(
  tourId: string,
  options: { supabase?: SupabaseClient } = {},
): Promise<StoredTourPrepBrief | null> {
  const supabase = options.supabase ?? createServiceClient()
  const { data, error } = await supabase
    .from('tour_prep_briefs')
    .select(
      'id, tour_id, venue_id, wedding_id, brief_jsonb, generated_at, viewed_at, sent_to_coordinator_at, prompt_version, cost_cents',
    )
    .eq('tour_id', tourId)
    .maybeSingle()
  if (error) {
    console.warn('[prep-brief] getStoredTourPrepBrief failed:', error.message)
    return null
  }
  if (!data) return null
  const row = data as {
    id: string
    tour_id: string
    venue_id: string
    wedding_id: string | null
    brief_jsonb: TourPrepBriefOutput
    generated_at: string
    viewed_at: string | null
    sent_to_coordinator_at: string | null
    prompt_version: string | null
    cost_cents: number | string
  }
  return {
    id: row.id,
    tourId: row.tour_id,
    venueId: row.venue_id,
    weddingId: row.wedding_id,
    brief: row.brief_jsonb,
    generatedAt: row.generated_at,
    viewedAt: row.viewed_at,
    sentToCoordinatorAt: row.sent_to_coordinator_at,
    promptVersion: row.prompt_version,
    costCents: Number(row.cost_cents) || 0,
  }
}
