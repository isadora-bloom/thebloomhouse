// ---------------------------------------------------------------------------
// lifecycle/sweep.ts — Wave 11 daily sweep + soft-judge processor.
// ---------------------------------------------------------------------------
//
// Anchor docs (~/.claude memory/):
//   - bloom-constitution.md
//   - bloom-wave4-identity-reconstruction.md (sweep + cron pattern —
//     50 weddings per tick, 280s soft deadline)
//   - feedback_deep_fix_vs_bandaid.md (LLM only for soft transitions —
//     the sweep runs deterministic refresh for ALL active weddings and
//     enqueues soft-judge jobs ONLY for stuck patterns)
//
// TWO PHASES
// ----------
// Phase 1 — runLifecycleSweep(): for each active (non-terminal)
//   wedding, call applyLifecycleTransition. Most calls are no-ops
//   (idempotent). When a transition does fire it's deterministic.
//   Stuck patterns get queued into lifecycle_transition_jobs for
//   Phase 2.
//
// Phase 2 — processLifecycleJudgeQueue(): drain the
//   lifecycle_transition_jobs queue. For each, call the Haiku judge,
//   then call applyLifecycleTransition with forcedKind='llm_judged'
//   (or 'auto_stuck' if the judge held).
//
// TODO (reconciliation stream): register cron jobs in vercel.json +
//   src/app/api/cron/route.ts:
//
//     'lifecycle_sweep'         — daily at 04:00 UTC (after tour
//                                 outcome classifier finishes)
//     'lifecycle_judge_drain'   — every 30 minutes
//
// We do NOT touch those files here — they are in Wave 9's zone.
// ---------------------------------------------------------------------------

import type { SupabaseClient } from '@supabase/supabase-js'
import { createServiceClient } from '@/lib/supabase/service'
import {
  applyLifecycleTransition,
  type ApplyLifecycleTransitionResult,
} from './transition'
import {
  computeLifecycleStage,
  STUCK_THRESHOLDS,
  type LifecycleStage,
} from './state-machine'
import { callAIJson } from '@/lib/ai/client'
import {
  LIFECYCLE_TRANSITION_PROMPT_VERSION,
  LIFECYCLE_TRANSITION_SYSTEM_PROMPT,
  buildLifecycleJudgeUserPrompt,
  type LifecycleJudgeInput,
  type LifecycleJudgeOutput,
} from '@/config/prompts/lifecycle-transition'

// ---------------------------------------------------------------------------
// Tunables
// ---------------------------------------------------------------------------

const SWEEP_PAGE_SIZE = 50
const SWEEP_SOFT_DEADLINE_MS = 280_000

const JUDGE_BATCH_SIZE = 20
const JUDGE_SOFT_DEADLINE_MS = 280_000
const JUDGE_CONFIDENCE_FLOOR = 70

const ALL_STAGES: ReadonlySet<LifecycleStage> = new Set([
  'pre_touch',
  'first_touch',
  'nurture',
  'tour_scheduled',
  'tour_completed',
  'proposal_active',
  'booked',
  'planning_active',
  'day_of',
  'post_event',
  'long_tail',
  'lost',
  'cancelled',
])

// ---------------------------------------------------------------------------
// Phase 1 — sweep
// ---------------------------------------------------------------------------

export interface LifecycleSweepResult {
  venues_processed: number
  weddings_scanned: number
  transitions_applied: number
  soft_judge_enqueued: number
  errors: string[]
  per_venue: Array<{
    venue_id: string
    scanned: number
    transitions: number
    enqueued: number
  }>
}

export interface RunLifecycleSweepArgs {
  /** When set, only sweep this venue. Default = all active venues. */
  venueId?: string
  /** Optional supabase override. */
  supabase?: SupabaseClient
  /** Override "now" for tests. */
  now?: Date
}

export async function runLifecycleSweep(
  args: RunLifecycleSweepArgs = {},
): Promise<LifecycleSweepResult> {
  const supabase = args.supabase ?? createServiceClient()
  const start = Date.now()
  const result: LifecycleSweepResult = {
    venues_processed: 0,
    weddings_scanned: 0,
    transitions_applied: 0,
    soft_judge_enqueued: 0,
    errors: [],
    per_venue: [],
  }

  // Resolve venues.
  let venueIds: string[] = []
  if (args.venueId) {
    venueIds = [args.venueId]
  } else {
    try {
      const { data, error } = await supabase
        .from('venues')
        .select('id')
        .eq('is_active', true)
      if (error) {
        result.errors.push('venues fetch failed: ' + error.message)
        return result
      }
      venueIds = ((data ?? []) as Array<{ id: string }>).map((v) => v.id)
    } catch (err) {
      result.errors.push(
        'venues fetch threw: ' +
          (err instanceof Error ? err.message : String(err)),
      )
      return result
    }
  }

  for (const venueId of venueIds) {
    if (Date.now() - start > SWEEP_SOFT_DEADLINE_MS) {
      result.errors.push('soft deadline reached — stopping mid-venue')
      break
    }
    try {
      const venueRes = await sweepOneVenue({
        supabase,
        venueId,
        now: args.now,
        deadlineMs: start + SWEEP_SOFT_DEADLINE_MS,
      })
      result.venues_processed++
      result.weddings_scanned += venueRes.scanned
      result.transitions_applied += venueRes.transitions
      result.soft_judge_enqueued += venueRes.enqueued
      result.per_venue.push({
        venue_id: venueId,
        scanned: venueRes.scanned,
        transitions: venueRes.transitions,
        enqueued: venueRes.enqueued,
      })
    } catch (err) {
      result.errors.push(
        'venue ' +
          venueId +
          ' threw: ' +
          (err instanceof Error ? err.message : String(err)),
      )
    }
  }

  return result
}

interface SweepOneVenueArgs {
  supabase: SupabaseClient
  venueId: string
  now?: Date
  deadlineMs: number
}

interface SweepOneVenueResult {
  scanned: number
  transitions: number
  enqueued: number
}

async function sweepOneVenue(
  args: SweepOneVenueArgs,
): Promise<SweepOneVenueResult> {
  const { supabase, venueId } = args
  const result: SweepOneVenueResult = {
    scanned: 0,
    transitions: 0,
    enqueued: 0,
  }

  // Page through active (non-terminal) weddings.
  let from = 0
  while (Date.now() < args.deadlineMs) {
    const to = from + SWEEP_PAGE_SIZE - 1
    const { data, error } = await supabase
      .from('weddings')
      .select('id, lifecycle_stage')
      .eq('venue_id', venueId)
      .or('lifecycle_stage.is.null,lifecycle_stage.not.in.(lost,cancelled,long_tail)')
      .order('updated_at', { ascending: false })
      .range(from, to)
    if (error) throw new Error(error.message)
    const rows = (data ?? []) as Array<{
      id: string
      lifecycle_stage: string | null
    }>
    if (rows.length === 0) break

    for (const row of rows) {
      result.scanned++

      const applied = await applyLifecycleTransition({
        weddingId: row.id,
        supabase,
        now: args.now,
      })

      if (applied.applied) {
        result.transitions++
      }

      // Even on a no-op, check whether the wedding is now a stuck
      // candidate. If yes + no recent job, enqueue.
      const computed = applied.applied
        ? applied.computed
        : 'computed' in applied
        ? applied.computed
        : null
      if (computed && computed.soft_judge_candidate && computed.candidate_stage) {
        const enqueued = await enqueueSoftJudgeJob({
          supabase,
          weddingId: row.id,
          venueId,
          currentStage: computed.stage,
          candidateStage: computed.candidate_stage,
          triggerSignal: 'sweep_stuck_pattern',
        })
        if (enqueued) result.enqueued++
      }

      if (Date.now() >= args.deadlineMs) break
    }

    if (rows.length < SWEEP_PAGE_SIZE) break
    from += SWEEP_PAGE_SIZE
  }

  return result
}

// ---------------------------------------------------------------------------
// Phase 2 — judge queue processor
// ---------------------------------------------------------------------------

export interface ProcessJudgeQueueResult {
  scanned: number
  llm_judged: number
  auto_stuck: number
  refused: number
  errors: string[]
}

/**
 * Drain a batch of lifecycle_transition_jobs. For each:
 *   - call Haiku judge
 *   - apply transition (llm_judged) OR record auto_stuck (current
 *     stage holds)
 *   - mark job done / failed
 */
export async function processLifecycleJudgeQueue(
  supabase?: SupabaseClient,
): Promise<ProcessJudgeQueueResult> {
  const sb = supabase ?? createServiceClient()
  const start = Date.now()
  const result: ProcessJudgeQueueResult = {
    scanned: 0,
    llm_judged: 0,
    auto_stuck: 0,
    refused: 0,
    errors: [],
  }

  const { data: jobs, error } = await sb
    .from('lifecycle_transition_jobs')
    .select(
      'id, wedding_id, venue_id, current_stage, candidate_stage, trigger_signal',
    )
    .eq('status', 'queued')
    .order('enqueued_at', { ascending: true })
    .limit(JUDGE_BATCH_SIZE)

  if (error) {
    result.errors.push('queue fetch failed: ' + error.message)
    return result
  }

  for (const job of (jobs ?? []) as Array<{
    id: string
    wedding_id: string
    venue_id: string
    current_stage: string | null
    candidate_stage: string | null
  }>) {
    if (Date.now() - start > JUDGE_SOFT_DEADLINE_MS) {
      result.errors.push('judge soft deadline reached')
      break
    }
    result.scanned++

    // Claim atomically.
    const { data: claimed } = await sb
      .from('lifecycle_transition_jobs')
      .update({ status: 'running', started_at: new Date().toISOString() })
      .eq('id', job.id)
      .eq('status', 'queued')
      .select('id')
      .maybeSingle()
    if (!claimed) continue

    try {
      const outcome = await runJudgeForOne({
        supabase: sb,
        weddingId: job.wedding_id,
        venueId: job.venue_id,
        currentStage: job.current_stage as LifecycleStage | null,
        candidateStage: job.candidate_stage as LifecycleStage | null,
      })
      if (outcome.kind === 'llm_judged') result.llm_judged++
      else if (outcome.kind === 'auto_stuck') result.auto_stuck++
      else result.refused++

      await sb
        .from('lifecycle_transition_jobs')
        .update({
          status: 'done',
          completed_at: new Date().toISOString(),
        })
        .eq('id', job.id)
    } catch (err) {
      result.errors.push(
        'job ' +
          job.id +
          ' threw: ' +
          (err instanceof Error ? err.message : String(err)),
      )
      await sb
        .from('lifecycle_transition_jobs')
        .update({
          status: 'failed',
          completed_at: new Date().toISOString(),
          error_text:
            err instanceof Error ? err.message.slice(0, 500) : String(err),
        })
        .eq('id', job.id)
    }
  }

  return result
}

interface RunJudgeArgs {
  supabase: SupabaseClient
  weddingId: string
  venueId: string
  currentStage: LifecycleStage | null
  candidateStage: LifecycleStage | null
}

type JudgeOutcome =
  | { kind: 'llm_judged'; from: LifecycleStage | null; to: LifecycleStage }
  | { kind: 'auto_stuck'; stage: LifecycleStage }
  | { kind: 'refused'; reason: string }

async function runJudgeForOne(args: RunJudgeArgs): Promise<JudgeOutcome> {
  const { supabase, weddingId, venueId } = args

  // Recompute current stage as the source of truth. The job carries
  // current_stage at enqueue time but that may be stale.
  const computed = await computeLifecycleStage({
    weddingId,
    supabase,
  })
  if (!computed.soft_judge_candidate || !computed.candidate_stage) {
    return { kind: 'refused', reason: 'no longer stuck on recompute' }
  }
  const fromStage = computed.stage
  const candidateStage = computed.candidate_stage

  // Build judge input — pull recent interactions + persona.
  const judgeInput = await buildJudgeInput({
    supabase,
    weddingId,
    currentStage: fromStage,
    candidateStage,
    computedEvidence: computed.evidence,
  })

  const userPrompt = buildLifecycleJudgeUserPrompt(judgeInput)

  let judgeOutput: LifecycleJudgeOutput
  try {
    judgeOutput = await callAIJson<LifecycleJudgeOutput>({
      systemPrompt: LIFECYCLE_TRANSITION_SYSTEM_PROMPT,
      userPrompt,
      maxTokens: 400,
      temperature: 0.1,
      tier: 'haiku',
      taskType: 'lifecycle_transition_judge',
      contentTier: 2,
      promptVersion: LIFECYCLE_TRANSITION_PROMPT_VERSION,
      venueId,
    })
  } catch (err) {
    throw new Error(
      'judge call failed: ' +
        (err instanceof Error ? err.message : String(err)),
    )
  }

  const recStage = String(judgeOutput?.recommended_stage ?? '')
  const conf =
    typeof judgeOutput?.confidence_0_100 === 'number'
      ? judgeOutput.confidence_0_100
      : 0
  const refusal =
    typeof judgeOutput?.refusal_if_ambiguous === 'string'
      ? judgeOutput.refusal_if_ambiguous
      : null

  if (refusal || conf < JUDGE_CONFIDENCE_FLOOR) {
    // Record auto_stuck so the next sweep doesn't immediately re-enqueue.
    await supabase.from('lifecycle_transitions').insert({
      wedding_id: weddingId,
      venue_id: venueId,
      from_stage: fromStage,
      to_stage: fromStage, // holding
      transition_kind: 'auto_stuck',
      evidence: {
        ...computed.evidence,
        judge_response: judgeOutput,
        held_reason: refusal ?? 'low_confidence',
      },
      reasoning:
        refusal ??
        ('low confidence (' + conf + ') — held in ' + fromStage),
      confidence: conf,
    })
    return { kind: 'auto_stuck', stage: fromStage }
  }

  if (!ALL_STAGES.has(recStage as LifecycleStage)) {
    throw new Error('judge returned invalid stage: ' + recStage)
  }
  const toStage = recStage as LifecycleStage

  if (toStage === fromStage) {
    // Judge agreed to hold — same as low-confidence path.
    await supabase.from('lifecycle_transitions').insert({
      wedding_id: weddingId,
      venue_id: venueId,
      from_stage: fromStage,
      to_stage: fromStage,
      transition_kind: 'auto_stuck',
      evidence: {
        ...computed.evidence,
        judge_response: judgeOutput,
        held_reason: 'judge_agreed_hold',
      },
      reasoning: judgeOutput?.reasoning ?? 'judge held current stage',
      confidence: conf,
    })
    return { kind: 'auto_stuck', stage: fromStage }
  }

  // Judge moved them. Apply via the writer with forcedKind='llm_judged'.
  const applied = await applyLifecycleTransition({
    weddingId,
    supabase,
    forcedKind: 'llm_judged',
    reasoning: judgeOutput?.reasoning ?? 'llm judged transition',
    evidence: {
      ...computed.evidence,
      judge_response: judgeOutput,
    },
    confidence_0_100: conf,
  })

  // If the writer's recompute disagrees with the judge (rare — race
  // between sweep + judge), let the writer's deterministic answer win.
  // We've already recorded the judge attempt in the audit row above by
  // the time the writer fires; no extra work needed.

  return {
    kind: 'llm_judged',
    from: fromStage,
    to: judgmentToAppliedStage(applied, toStage),
  }
}

function judgmentToAppliedStage(
  applied: ApplyLifecycleTransitionResult,
  fallback: LifecycleStage,
): LifecycleStage {
  if (applied.applied) return applied.to
  return fallback
}

// ---------------------------------------------------------------------------
// Build judge input — collect recent interactions + persona blurb.
// ---------------------------------------------------------------------------

interface BuildJudgeInputArgs {
  supabase: SupabaseClient
  weddingId: string
  currentStage: LifecycleStage
  candidateStage: LifecycleStage
  computedEvidence: Record<string, unknown>
}

async function buildJudgeInput(
  args: BuildJudgeInputArgs,
): Promise<LifecycleJudgeInput> {
  const { supabase, weddingId, currentStage, candidateStage } = args

  // Recent interactions (last 6, both directions).
  const interactions: LifecycleJudgeInput['recent_interactions'] = []
  try {
    const { data } = await supabase
      .from('interactions')
      .select('direction, timestamp, subject, body_preview')
      .eq('wedding_id', weddingId)
      .order('timestamp', { ascending: false })
      .limit(6)
    const now = Date.now()
    for (const r of (data ?? []) as Array<{
      direction: string | null
      timestamp: string | null
      subject: string | null
      body_preview: string | null
    }>) {
      const ts = r.timestamp ? Date.parse(r.timestamp) : NaN
      if (!Number.isFinite(ts)) continue
      const days = (now - ts) / (24 * 60 * 60 * 1000)
      interactions.push({
        direction: (r.direction === 'outbound' ? 'outbound' : 'inbound'),
        days_ago: days,
        subject: r.subject,
        body_excerpt: r.body_preview,
      })
    }
  } catch {
    // ignore
  }

  // Persona (couple_intel.persona). Tolerant if the row doesn't exist.
  let personaLabel: string | null = null
  let personaDescription: string | null = null
  try {
    const { data } = await supabase
      .from('couple_intel')
      .select('persona')
      .eq('wedding_id', weddingId)
      .maybeSingle()
    const persona = (data as { persona: unknown } | null)?.persona as
      | { label?: string; description?: string }
      | null
      | undefined
    if (persona && typeof persona === 'object') {
      personaLabel = typeof persona.label === 'string' ? persona.label : null
      personaDescription =
        typeof persona.description === 'string' ? persona.description : null
    }
  } catch {
    // ignore — persona is optional
  }

  // Stuck threshold for the prompt's days_in_current_stage signal.
  const stuckDays =
    candidateStage === 'lost' && currentStage === 'proposal_active'
      ? STUCK_THRESHOLDS.proposal_silent_days
      : candidateStage === 'planning_active' && currentStage === 'booked'
      ? STUCK_THRESHOLDS.booked_no_planning_days
      : currentStage === 'post_event'
      ? STUCK_THRESHOLDS.post_event_no_review_days
      : 14

  // Days in current stage — pull lifecycle_stage_set_at if present;
  // otherwise approximate from updated_at.
  let daysInStage = stuckDays
  try {
    const { data } = await supabase
      .from('weddings')
      .select('lifecycle_stage_set_at, updated_at')
      .eq('id', weddingId)
      .maybeSingle()
    const ts =
      ((data as { lifecycle_stage_set_at: string | null } | null)
        ?.lifecycle_stage_set_at) ??
      ((data as { updated_at: string | null } | null)?.updated_at ?? null)
    if (ts) {
      const ms = Date.parse(ts)
      if (Number.isFinite(ms)) {
        daysInStage = (Date.now() - ms) / (24 * 60 * 60 * 1000)
      }
    }
  } catch {
    // keep default
  }

  return {
    current_stage: currentStage,
    candidate_stage: candidateStage,
    days_in_current_stage: daysInStage,
    stuck_threshold_days: stuckDays,
    persona_label: personaLabel,
    persona_description: personaDescription,
    recent_interactions: interactions,
    signals: {
      computed_evidence_rule: args.computedEvidence?.rule ?? null,
      event_date: args.computedEvidence?.wedding_date ?? null,
      booked_at: args.computedEvidence?.booked_at ?? null,
    },
  }
}

// ---------------------------------------------------------------------------
// Enqueue helper for soft-judge jobs (used by Phase 1 sweep).
// ---------------------------------------------------------------------------

interface EnqueueSoftJudgeArgs {
  supabase: SupabaseClient
  weddingId: string
  venueId: string
  currentStage: LifecycleStage
  candidateStage: LifecycleStage
  triggerSignal: string
}

async function enqueueSoftJudgeJob(
  args: EnqueueSoftJudgeArgs,
): Promise<boolean> {
  try {
    const sinceIso = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString()
    const { data: existing } = await args.supabase
      .from('lifecycle_transition_jobs')
      .select('id')
      .eq('wedding_id', args.weddingId)
      .in('status', ['queued', 'running'])
      .gte('enqueued_at', sinceIso)
      .limit(1)
      .maybeSingle()
    if (existing) return false

    const { error } = await args.supabase
      .from('lifecycle_transition_jobs')
      .insert({
        wedding_id: args.weddingId,
        venue_id: args.venueId,
        status: 'queued',
        current_stage: args.currentStage,
        candidate_stage: args.candidateStage,
        trigger_signal: args.triggerSignal,
      })
    return !error
  } catch {
    return false
  }
}
