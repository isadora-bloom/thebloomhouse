/**
 * Bloom House — Wave 13 post-tour Sage follow-up draft generator.
 *
 * Anchor docs:
 *   - bloom-constitution.md (Sage drafts always go to coordinator review;
 *     never auto-sent; sensitive themes are voice-shape only)
 *   - bloom-wave4-identity-reconstruction.md (Phase 3 read surfaces)
 *
 * What this service does
 * ----------------------
 * Given a tourId whose outcome has been classified (Wave 11
 * tour_completed transition), load the tour-prep brief (if it exists)
 * plus the per-couple intel + recent interactions, fire ONE Sonnet
 * call (~$0.02), and write a personalised draft into the existing
 * `drafts` table for coordinator review.
 *
 * The tone branches on tour outcome:
 *   - completed: warm thanks + specific reference + light next-step
 *   - no_show:   rescheduling offer, no guilt-trip
 *   - cancelled: clean acknowledgement + keep-the-door-open
 *
 * Wave 13 NEVER auto-sends. The draft lands as drafts.status='pending'.
 */

import type { SupabaseClient } from '@supabase/supabase-js'
import { createServiceClient } from '@/lib/supabase/service'
import { callAI } from '@/lib/ai/client'
import {
  POST_TOUR_SAGE_PROMPT_VERSION,
  buildPostTourSageSystemPrompt,
  buildPostTourSageUserPrompt,
  validatePostTourSageOutput,
  type PostTourEvidence,
  type PostTourInteractionEvidence,
  type PostTourOutcome,
  type PostTourSageOutput,
} from '@/config/prompts/post-tour-sage'
import {
  getStoredTourPrepBrief,
  type StoredTourPrepBrief,
} from './prep-brief'
import type { CoupleIdentityProfile } from '@/config/prompts/identity-reconstruction'
import { dedupePeopleByName } from '@/lib/utils/couple-name'

export { POST_TOUR_SAGE_PROMPT_VERSION } from '@/config/prompts/post-tour-sage'

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface GeneratePostTourFollowUpArgs {
  tourId: string
  supabase?: SupabaseClient
  correlationId?: string
}

export interface GeneratePostTourFollowUpResult {
  ok: true
  draftId: string
  tourId: string
  venueId: string
  weddingId: string | null
  outcome: PostTourOutcome
  draft: PostTourSageOutput
  costCents: number
  promptVersion: string
  inputTokens: number
  outputTokens: number
}

export interface SkipPostTourFollowUpResult {
  ok: false
  reason: string
}

const MAX_INTERACTIONS = 8
const MAX_INTERACTION_BODY_CHARS = 1200

// ---------------------------------------------------------------------------
// Loaders
// ---------------------------------------------------------------------------

interface TourRow {
  id: string
  venue_id: string
  wedding_id: string | null
  scheduled_at: string | null
  outcome: string | null
  notes: string | null
}

async function loadTour(
  supabase: SupabaseClient,
  tourId: string,
): Promise<TourRow | null> {
  const { data, error } = await supabase
    .from('tours')
    .select('id, venue_id, wedding_id, scheduled_at, outcome, notes')
    .eq('id', tourId)
    .maybeSingle()
  if (error) throw new Error(`post-tour.loadTour failed: ${error.message}`)
  return (data as TourRow | null) ?? null
}

async function loadVenuePersonality(
  supabase: SupabaseClient,
  venueId: string,
): Promise<{ aiName: string; venueName: string; coordinatorName: string | null }> {
  const [ai, venue, cfg] = await Promise.all([
    supabase
      .from('venue_ai_config')
      .select('ai_name')
      .eq('venue_id', venueId)
      .maybeSingle(),
    supabase
      .from('venues')
      .select('name')
      .eq('id', venueId)
      .maybeSingle(),
    supabase
      .from('venue_config')
      .select('coordinator_name')
      .eq('venue_id', venueId)
      .maybeSingle(),
  ])
  const aiName =
    ((ai.data as { ai_name?: string | null } | null)?.ai_name) ??
    'Sage'
  const venueName =
    ((venue.data as { name?: string } | null)?.name) ?? 'the venue'
  const coordinatorName =
    ((cfg.data as { coordinator_name?: string | null } | null)?.coordinator_name) ?? null
  return { aiName, venueName, coordinatorName }
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

async function loadCoupleDisplayName(
  supabase: SupabaseClient,
  weddingId: string,
): Promise<string | null> {
  const { data } = await supabase
    .from('people')
    .select('first_name, last_name, role')
    .eq('wedding_id', weddingId)
    .in('role', ['partner1', 'partner2', 'bride', 'groom', 'partner'])
  if (!data || data.length === 0) return null
  const deduped = dedupePeopleByName(
    data as Array<{ first_name: string | null; last_name: string | null; role: string }>,
  )
  const names = deduped
    .map((p) => p.first_name ?? '')
    .filter((s) => s.trim().length > 0)
  if (names.length === 0) return null
  return names.slice(0, 2).join(' & ')
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
): Promise<PostTourInteractionEvidence[]> {
  const { data } = await supabase
    .from('interactions')
    .select(
      'id, direction, from_name, subject, full_body, body_preview, timestamp',
    )
    .eq('wedding_id', weddingId)
    .order('timestamp', { ascending: false })
    .limit(MAX_INTERACTIONS)
  return ((data ?? []) as InteractionRow[]).map((r, idx) => ({
    index: idx + 1,
    direction:
      r.direction === 'outbound' ? ('outbound' as const) : ('inbound' as const),
    from_name: r.from_name,
    subject: r.subject,
    body_excerpt:
      (r.full_body ?? r.body_preview ?? null)?.slice(0, MAX_INTERACTION_BODY_CHARS) ?? null,
    timestamp: r.timestamp,
  }))
}

function normaliseOutcome(raw: string | null): PostTourOutcome {
  if (raw === 'completed') return 'completed'
  if (raw === 'no_show') return 'no_show'
  if (raw === 'cancelled') return 'cancelled'
  if (raw === 'pending') return 'pending'
  return 'unknown'
}

function stripJsonFences(text: string): string {
  return text.replace(/```json\n?/g, '').replace(/```\n?/g, '').trim()
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

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Generate a personalised post-tour follow-up draft. Writes into the
 * existing `drafts` table with status='pending', context_type='client',
 * brain_used='post_tour_sage'. The coordinator reviews + sends.
 *
 * Returns the inserted draft id + the generated draft + the cost.
 *
 * Returns { ok:false, reason } when:
 *   - tour not found
 *   - no wedding_id (we have nothing to follow up on)
 *   - outcome is still 'pending' (the classifier hasn't run yet — better
 *     to wait than draft for a tour that may have been cancelled)
 */
export async function generatePostTourFollowUp(
  args: GeneratePostTourFollowUpArgs,
): Promise<GeneratePostTourFollowUpResult | SkipPostTourFollowUpResult> {
  const supabase = args.supabase ?? createServiceClient()
  const tour = await loadTour(supabase, args.tourId)
  if (!tour) return { ok: false, reason: 'tour not found' }
  if (!tour.wedding_id) return { ok: false, reason: 'tour has no wedding_id' }
  const outcome = normaliseOutcome(tour.outcome)
  if (outcome === 'pending' || outcome === 'unknown') {
    return { ok: false, reason: 'tour outcome still pending or unknown' }
  }

  const venueId = tour.venue_id
  const weddingId = tour.wedding_id

  const [
    personality,
    profile,
    storedBrief,
    coupleDisplay,
    interactions,
    venueLabel,
  ]: [
    Awaited<ReturnType<typeof loadVenuePersonality>>,
    CoupleIdentityProfile | null,
    StoredTourPrepBrief | null,
    string | null,
    PostTourInteractionEvidence[],
    string | null,
  ] = await Promise.all([
    loadVenuePersonality(supabase, venueId),
    loadProfile(supabase, weddingId),
    getStoredTourPrepBrief(tour.id, { supabase }),
    loadCoupleDisplayName(supabase, weddingId),
    loadRecentInteractions(supabase, weddingId),
    loadVenueLabel(supabase, venueId),
  ])

  const evidence: PostTourEvidence = {
    weddingId,
    tourId: tour.id,
    venueLabel,
    tourScheduledAt: tour.scheduled_at,
    tourOutcome: outcome,
    tourNotes: tour.notes,
    brief: storedBrief?.brief ?? null,
    profile,
    recentInteractions: interactions,
    aiName: personality.aiName,
    venueName: personality.venueName,
    coordinatorName: personality.coordinatorName,
    coupleDisplayName: coupleDisplay,
  }

  const systemPrompt = buildPostTourSageSystemPrompt(
    outcome,
    personality.aiName,
    personality.venueName,
  )
  const userPrompt = buildPostTourSageUserPrompt(evidence)

  const aiResult = await callAI({
    systemPrompt,
    userPrompt,
    tier: 'sonnet',
    taskType: 'post_tour_sage',
    contentTier: 2,
    promptVersion: POST_TOUR_SAGE_PROMPT_VERSION,
    venueId,
    maxTokens: 1200,
    temperature: 0.4,
    correlationId: args.correlationId,
  })

  const cleaned = stripJsonFences(aiResult.text)
  let parsed: unknown
  try {
    parsed = JSON.parse(cleaned)
  } catch (parseErr) {
    const message = parseErr instanceof Error ? parseErr.message : String(parseErr)
    throw new Error(
      `generatePostTourFollowUp: LLM returned non-JSON. parseError=${message} raw=${cleaned.slice(0, 1500)}`,
    )
  }
  const validation = validatePostTourSageOutput(parsed)
  if (!validation.ok) {
    throw new Error(
      `generatePostTourFollowUp: schema validation failed. error=${validation.error} raw=${cleaned.slice(0, 1500)}`,
    )
  }
  const draft = validation.output
  const costCents = aiResult.cost * 100

  // Insert into the existing drafts table for coordinator review. Never
  // auto-sent (auto_sent=false). context_type='client' so the existing
  // Sage approval UI picks it up alongside other client drafts.
  const { data: inserted, error: insErr } = await supabase
    .from('drafts')
    .insert({
      venue_id: venueId,
      wedding_id: weddingId,
      subject: draft.subject,
      draft_body: draft.body,
      status: 'pending',
      context_type: 'client',
      brain_used: 'post_tour_sage',
      model_used: 'sonnet',
      tokens_used: aiResult.inputTokens + aiResult.outputTokens,
      cost: aiResult.cost,
      confidence_score: 80,
      auto_sent: false,
    })
    .select('id')
    .single()

  if (insErr || !inserted) {
    throw new Error(
      `generatePostTourFollowUp: drafts insert failed: ${insErr?.message ?? 'unknown'}`,
    )
  }

  return {
    ok: true,
    draftId: (inserted as { id: string }).id,
    tourId: tour.id,
    venueId,
    weddingId,
    outcome,
    draft,
    costCents,
    promptVersion: POST_TOUR_SAGE_PROMPT_VERSION,
    inputTokens: aiResult.inputTokens,
    outputTokens: aiResult.outputTokens,
  }
}

// ---------------------------------------------------------------------------
// Enqueue helper (wired by Wave 11 stage-trigger fan-out)
// ---------------------------------------------------------------------------

export interface EnqueuePostTourSageArgs {
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

export async function enqueuePostTourSage(
  args: EnqueuePostTourSageArgs,
): Promise<EnqueueResult> {
  const supabase = args.supabase ?? createServiceClient()
  try {
    const sinceIso = new Date(Date.now() - 48 * 60 * 60 * 1000).toISOString()
    const { data: existing } = await supabase
      .from('post_tour_followup_jobs')
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
      .from('post_tour_followup_jobs')
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
