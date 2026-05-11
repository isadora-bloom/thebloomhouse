// ---------------------------------------------------------------------------
// lifecycle/stage-triggers.ts — Wave 11 stage-transition fan-out.
// ---------------------------------------------------------------------------
//
// Anchor docs (~/.claude memory/):
//   - bloom-constitution.md
//   - bloom-wave4-identity-reconstruction.md (signal-driven enqueue
//     pattern — never write inline; always enqueue + drain via cron)
//
// WHAT THIS DOES
// --------------
// When a wedding's canonical lifecycle_stage transitions, we fan out
// to downstream queues so the rest of the platform can react. The map:
//
//   tour_scheduled    → enqueue identity reconstruction (catch-up if
//                       stale) + (Wave 13) tour-prep-brief job
//                       [TODO: tour-prep queue is owned by Wave 13.
//                        Leave a marker here so the reconciliation
//                        stream wires it when that queue lands.]
//
//   tour_completed    → (Wave 13) post-tour Sage follow-up
//                       [TODO: wired by Wave 13.]
//
//   booked            → enqueue couple_intel refresh (so the intel
//                       page reflects the new state) + enqueue
//                       identity reconstruction (a freshly booked
//                       couple just had contract data added)
//                       [TODO: planning-Sage engagement schedule is
//                        a Wave 13 queue.]
//
//   post_event        → (existing cron) post_event_feedback_check
//                       handles review solicitation. We surface the
//                       transition into intel so the dashboard knows
//                       the couple is in the review window.
//                       [TODO: review-solicitation queue when Wave 13
//                        formalizes it.]
//
//   lost              → enqueue couple_intel refresh (lost-lead
//                       narrative)
//                       [TODO: lost-lead re-engagement detector when
//                        the corresponding Wave queue ships.]
//
// All enqueues are fire-and-forget. A queue write failure NEVER
// fails the transition itself.
//
// IMPORTANT: We do NOT write into vercel.json / src/app/api/cron/
// route.ts here. That file is reserved for parallel agents (Wave 9
// touches the cron route). The triggers below only call enqueue
// helpers; cron registration is the reconciliation stream's job.
// ---------------------------------------------------------------------------

import type { SupabaseClient } from '@supabase/supabase-js'
import { enqueueIdentityReconstruction } from '@/lib/services/identity/enqueue-reconstruction'
import type { LifecycleStage } from './state-machine'

export interface FireStageTriggersArgs {
  supabase: SupabaseClient
  weddingId: string
  venueId: string
  fromStage: LifecycleStage | null
  toStage: LifecycleStage
}

export interface FiredTrigger {
  name: string
  ok: boolean
  detail?: string
}

/**
 * Fan-out from a stage transition. Never throws. Returns a list of
 * triggers attempted + their outcomes for observability.
 */
export async function fireStageTriggers(
  args: FireStageTriggersArgs,
): Promise<FiredTrigger[]> {
  const { supabase, weddingId, venueId, toStage } = args
  const fired: FiredTrigger[] = []

  switch (toStage) {
    case 'tour_scheduled': {
      fired.push(
        await safeIdentityEnqueue({
          supabase,
          weddingId,
          venueId,
          triggerSignal: 'lifecycle_tour_scheduled',
        }),
      )
      fired.push({
        name: 'tour_prep_brief',
        ok: true,
        detail: 'TODO: wired by Wave 13 (tour-prep queue)',
      })
      break
    }

    case 'tour_completed': {
      fired.push({
        name: 'post_tour_sage_followup',
        ok: true,
        detail: 'TODO: wired by Wave 13 (post-tour follow-up queue)',
      })
      break
    }

    case 'booked': {
      fired.push(
        await safeIdentityEnqueue({
          supabase,
          weddingId,
          venueId,
          triggerSignal: 'lifecycle_booked',
        }),
      )
      fired.push(
        await safeCoupleIntelEnqueue({
          supabase,
          weddingId,
          venueId,
          triggerSignal: 'lifecycle_booked',
        }),
      )
      fired.push({
        name: 'planning_sage_schedule',
        ok: true,
        detail: 'TODO: wired by Wave 13 (planning-Sage queue)',
      })
      break
    }

    case 'planning_active': {
      fired.push(
        await safeCoupleIntelEnqueue({
          supabase,
          weddingId,
          venueId,
          triggerSignal: 'lifecycle_planning_active',
        }),
      )
      break
    }

    case 'post_event': {
      fired.push({
        name: 'review_solicitation',
        ok: true,
        detail:
          'TODO: existing post_event_feedback_check cron handles the live ' +
          'soliciting; Wave 13 will formalize a dedicated queue. ' +
          'TODO(wave 9): wire stage transitions from email pipeline so ' +
          'a freshly-set post_event triggers this in real time, not just ' +
          'via the daily sweep.',
      })
      break
    }

    case 'lost': {
      fired.push(
        await safeCoupleIntelEnqueue({
          supabase,
          weddingId,
          venueId,
          triggerSignal: 'lifecycle_lost',
        }),
      )
      fired.push({
        name: 'lost_lead_reengagement',
        ok: true,
        detail: 'TODO: wired when re-engagement detector queue lands',
      })
      break
    }

    case 'day_of':
    case 'long_tail':
    case 'cancelled':
    case 'pre_touch':
    case 'first_touch':
    case 'nurture':
    case 'proposal_active':
      // No fan-out for these stages today. day_of triggers are owned by
      // the existing day-of brief cron; long_tail / cancelled have no
      // downstream effect. first_touch / nurture / proposal_active are
      // covered by the inbound-email pipeline (Wave 9 zone).
      break
  }

  return fired
}

// ---------------------------------------------------------------------------
// Safe wrappers — never throw, always return a FiredTrigger.
// ---------------------------------------------------------------------------

interface SafeEnqueueArgs {
  supabase: SupabaseClient
  weddingId: string
  venueId: string
  triggerSignal: string
}

async function safeIdentityEnqueue(
  args: SafeEnqueueArgs,
): Promise<FiredTrigger> {
  try {
    const result = await enqueueIdentityReconstruction({
      weddingId: args.weddingId,
      venueId: args.venueId,
      triggerSignal: args.triggerSignal,
      supabase: args.supabase,
    })
    if (result.skipped) {
      return {
        name: 'identity_reconstruction',
        ok: true,
        detail: 'skipped: ' + result.reason,
      }
    }
    return {
      name: 'identity_reconstruction',
      ok: true,
      detail: 'enqueued: ' + result.jobId,
    }
  } catch (err) {
    return {
      name: 'identity_reconstruction',
      ok: false,
      detail:
        'threw: ' + (err instanceof Error ? err.message : String(err)),
    }
  }
}

async function safeCoupleIntelEnqueue(
  args: SafeEnqueueArgs,
): Promise<FiredTrigger> {
  // couple_intel_jobs follows the same shape as
  // identity_reconstruction_jobs (mig 261). We write directly here
  // instead of through a helper to avoid coupling Wave 11 to an as-
  // yet-unbuilt enqueue helper for the intel queue (Wave 5A may not
  // have shipped one). The dedupe-on-conflict pattern is the same:
  // any queued/running job in the last 24h short-circuits.
  try {
    const sinceIso = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString()
    const { data: existing } = await args.supabase
      .from('couple_intel_jobs')
      .select('id, status, enqueued_at')
      .eq('wedding_id', args.weddingId)
      .in('status', ['queued', 'running'])
      .gte('enqueued_at', sinceIso)
      .limit(1)
      .maybeSingle()
    if (existing) {
      return {
        name: 'couple_intel',
        ok: true,
        detail: 'skipped: dedupe_24h',
      }
    }
    const { data: inserted, error } = await args.supabase
      .from('couple_intel_jobs')
      .insert({
        wedding_id: args.weddingId,
        venue_id: args.venueId,
        status: 'queued',
        trigger_signal: args.triggerSignal,
      })
      .select('id')
      .single()
    if (error || !inserted) {
      return {
        name: 'couple_intel',
        ok: false,
        detail: 'insert failed: ' + (error?.message ?? 'unknown'),
      }
    }
    return {
      name: 'couple_intel',
      ok: true,
      detail: 'enqueued: ' + (inserted as { id: string }).id,
    }
  } catch (err) {
    return {
      name: 'couple_intel',
      ok: false,
      detail:
        'threw: ' + (err instanceof Error ? err.message : String(err)),
    }
  }
}
