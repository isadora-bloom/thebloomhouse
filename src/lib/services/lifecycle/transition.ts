// ---------------------------------------------------------------------------
// lifecycle/transition.ts — Wave 11 transition writer + stage-trigger hub.
// ---------------------------------------------------------------------------
//
// Anchor docs (~/.claude memory/):
//   - bloom-constitution.md
//   - bloom-wave4-identity-reconstruction.md (mirror pattern: signal →
//     enqueue, never write inline in a load-bearing path)
//   - feedback_deep_fix_vs_bandaid.md (deterministic vs llm_judged)
//
// WHAT THIS DOES
// --------------
// applyLifecycleTransition reads the current weddings.lifecycle_stage,
// calls computeLifecycleStage for the canonical answer, and:
//   - if same → idempotent no-op (returns { applied: false }).
//   - if different → UPDATE weddings.lifecycle_stage +
//     INSERT lifecycle_transitions row + fire stage-triggers.
//
// Never throws — every error path returns a typed result so the email
// pipeline / sweep / cron caller can keep going.
//
// STAGE TRIGGERS
// --------------
// When a stage changes, we fan out to downstream queues. The trigger
// map lives in stage-triggers.ts so transition.ts stays small. We use
// EXISTING job queues (identity_reconstruction_jobs / couple_intel_jobs)
// — Wave 11 does NOT introduce new queues for the downstream effects.
// ---------------------------------------------------------------------------

import type { SupabaseClient } from '@supabase/supabase-js'
import { createServiceClient } from '@/lib/supabase/service'
import {
  computeLifecycleStage,
  type ComputedLifecycleStage,
  type LifecycleStage,
  type LifecycleTransitionKind,
} from './state-machine'
import { fireStageTriggers } from './stage-triggers'

export interface ApplyLifecycleTransitionArgs {
  weddingId: string
  /** Optional supabase override. Defaults to service-role. */
  supabase?: SupabaseClient
  /** Optional override of "now" for testing / replay. */
  now?: Date
  /** Skip firing stage triggers (used by the sweep when batching). */
  skipTriggers?: boolean
  /** Override transition_kind when calling from the soft-judge worker. */
  forcedKind?: LifecycleTransitionKind
  /** Override reasoning string (when caller has richer context, e.g.
   *  the LLM judge already wrote a paragraph). */
  reasoning?: string
  /** Override evidence payload (e.g. the LLM judge response). */
  evidence?: Record<string, unknown>
  /** Override confidence (e.g. LLM judge confidence). */
  confidence_0_100?: number
}

export type ApplyLifecycleTransitionResult =
  | {
      applied: false
      reason: string
      computed?: ComputedLifecycleStage
      from?: LifecycleStage | null
    }
  | {
      applied: true
      from: LifecycleStage | null
      to: LifecycleStage
      transition_id: string
      computed: ComputedLifecycleStage
    }

/**
 * Apply the canonical lifecycle stage to a wedding. Idempotent:
 * re-running on a stable wedding is a no-op.
 *
 * Never throws.
 */
export async function applyLifecycleTransition(
  args: ApplyLifecycleTransitionArgs,
): Promise<ApplyLifecycleTransitionResult> {
  const supabase = args.supabase ?? createServiceClient()
  const { weddingId } = args

  // 1) Read current stage on the wedding row + venue_id (needed for
  //    audit + trigger fan-out).
  let currentStage: LifecycleStage | null = null
  let venueId: string | null = null
  try {
    const { data, error } = await supabase
      .from('weddings')
      .select('venue_id, lifecycle_stage, lifecycle_transition_count')
      .eq('id', weddingId)
      .maybeSingle()
    if (error) {
      return {
        applied: false,
        reason: 'wedding fetch error: ' + error.message,
      }
    }
    if (!data) {
      return { applied: false, reason: 'wedding not found' }
    }
    venueId = (data as { venue_id: string | null }).venue_id ?? null
    currentStage =
      ((data as { lifecycle_stage: LifecycleStage | null }).lifecycle_stage ??
        null)
  } catch (err) {
    return {
      applied: false,
      reason:
        'wedding fetch threw: ' +
        (err instanceof Error ? err.message : String(err)),
    }
  }

  if (!venueId) {
    return { applied: false, reason: 'venue_id missing' }
  }

  // 2) Compute the canonical answer.
  const computed = await computeLifecycleStage({
    weddingId,
    supabase,
    now: args.now,
  })

  // 3) Same as persisted? No-op.
  if (currentStage === computed.stage) {
    return {
      applied: false,
      reason: 'idempotent: stage unchanged',
      computed,
      from: currentStage,
    }
  }

  const now = args.now ?? new Date()
  const reasoning = args.reasoning ?? computed.reasoning
  const evidence = args.evidence ?? computed.evidence
  const confidence = args.confidence_0_100 ?? computed.confidence_0_100
  const kind: LifecycleTransitionKind =
    args.forcedKind ?? computed.transition_kind

  // 4) Write the audit row FIRST. If the UPDATE fails, the audit
  //    record still surfaces the attempted transition. Mirrors the
  //    wedding-lifecycle-events ordering doctrine in writer.ts.
  let transitionId: string | null = null
  try {
    const { data, error } = await supabase
      .from('lifecycle_transitions')
      .insert({
        wedding_id: weddingId,
        venue_id: venueId,
        from_stage: currentStage,
        to_stage: computed.stage,
        transition_kind: kind,
        evidence,
        reasoning,
        confidence,
        transitioned_at: now.toISOString(),
      })
      .select('id')
      .single()
    if (error || !data) {
      return {
        applied: false,
        reason:
          'audit insert failed: ' + (error?.message ?? 'unknown'),
        computed,
        from: currentStage,
      }
    }
    transitionId = (data as { id: string }).id
  } catch (err) {
    return {
      applied: false,
      reason:
        'audit insert threw: ' +
        (err instanceof Error ? err.message : String(err)),
      computed,
      from: currentStage,
    }
  }

  // 5) Update the wedding row.
  try {
    const { error } = await supabase
      .from('weddings')
      .update({
        lifecycle_stage: computed.stage,
        lifecycle_stage_set_at: now.toISOString(),
        // increment via raw fetch + write is not race-safe across
        // concurrent transitions; the count is best-effort telemetry,
        // so we use the conservative path of "+1 on each successful
        // write". Wave 12 may move to atomic RPC.
        lifecycle_transition_count: await nextTransitionCount(
          supabase,
          weddingId,
        ),
        updated_at: now.toISOString(),
      })
      .eq('id', weddingId)
    if (error) {
      // Audit is recorded; the UPDATE will reconcile on the next
      // sweep call. Return applied:true so the trigger fan-out fires
      // — the audit row is the source of truth for "this transition
      // happened".
      console.warn('[lifecycle] wedding update failed:', error.message)
    }
  } catch (err) {
    console.warn(
      '[lifecycle] wedding update threw:',
      err instanceof Error ? err.message : String(err),
    )
  }

  // 6) Fire downstream stage triggers (fan-out into existing job
  //    queues). Fire-and-forget — never block the transition on a
  //    queue write.
  if (!args.skipTriggers) {
    try {
      await fireStageTriggers({
        supabase,
        weddingId,
        venueId,
        fromStage: currentStage,
        toStage: computed.stage,
      })
    } catch (err) {
      console.warn(
        '[lifecycle] stage trigger fan-out threw:',
        err instanceof Error ? err.message : String(err),
      )
    }
  }

  return {
    applied: true,
    from: currentStage,
    to: computed.stage,
    transition_id: transitionId,
    computed,
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function nextTransitionCount(
  supabase: SupabaseClient,
  weddingId: string,
): Promise<number> {
  try {
    const { data } = await supabase
      .from('weddings')
      .select('lifecycle_transition_count')
      .eq('id', weddingId)
      .maybeSingle()
    const cur =
      ((data as { lifecycle_transition_count?: number } | null)
        ?.lifecycle_transition_count ?? 0)
    return cur + 1
  } catch {
    return 1
  }
}
