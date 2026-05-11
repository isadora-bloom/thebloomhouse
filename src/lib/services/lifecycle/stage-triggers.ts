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
// Wave 13 trigger wiring (2026-05-11). The fan-out targets for
// tour_scheduled / tour_completed / post_event live in Wave 13 service
// modules. Stage-triggers reads enqueue helpers from there; the
// migration 281 queues are the substrate.
import { enqueueTourPrepBrief } from '@/lib/services/tour/prep-brief'
import { enqueuePostTourSage } from '@/lib/services/tour/post-tour-sage'
import { enqueueReviewSolicit } from '@/lib/services/reviews/solicit'
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
      // Wave 13 trigger wiring (2026-05-11). Enqueue the tour-prep brief
      // for the most-recent upcoming tour on this wedding. Daily sweep
      // catches any tours the trigger misses (e.g. Calendly fires after
      // the lifecycle transition).
      fired.push(
        await safeTourPrepEnqueue({
          supabase,
          weddingId,
          venueId,
          triggerSignal: 'lifecycle_tour_scheduled',
        }),
      )
      break
    }

    case 'tour_completed': {
      // Wave 13 trigger wiring (2026-05-11). Enqueue the post-tour Sage
      // follow-up for the most-recent completed tour. Draft lands in
      // `drafts` table for coordinator review (NEVER auto-sent).
      fired.push(
        await safePostTourSageEnqueue({
          supabase,
          weddingId,
          venueId,
          triggerSignal: 'lifecycle_tour_completed',
        }),
      )
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
      // Wave 13 trigger wiring (2026-05-11). post_event_feedback_check
      // cron continues to fire coordinator notifications at T+3d; Wave
      // 13 adds the formal review-solicitation pipeline as a sibling.
      // The enqueue helper carries its own 30d request-window dedupe
      // so re-firing on subsequent transitions is safe.
      // TODO(wave 9): wire stage transitions from email pipeline so a
      // freshly-set post_event triggers this in real time, not just
      // via the daily sweep.
      fired.push(
        await safeReviewSolicitEnqueue({
          supabase,
          weddingId,
          venueId,
          triggerSignal: 'lifecycle_post_event',
        }),
      )
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

// Wave 13 trigger wiring (2026-05-11). Lookup-then-enqueue for tour-
// prep brief — the stage-transition carries the wedding_id but not a
// tour_id, so we resolve the most-recent upcoming tour here. Safe by
// design: a missing tour returns ok:true with detail='skipped:no_tour'.
async function safeTourPrepEnqueue(
  args: SafeEnqueueArgs,
): Promise<FiredTrigger> {
  try {
    const nowIso = new Date().toISOString()
    const { data: tours } = await args.supabase
      .from('tours')
      .select('id, scheduled_at, outcome')
      .eq('wedding_id', args.weddingId)
      .gte('scheduled_at', nowIso)
      .order('scheduled_at', { ascending: true })
      .limit(1)
    if (!tours || tours.length === 0) {
      return {
        name: 'tour_prep_brief',
        ok: true,
        detail: 'skipped: no upcoming tour found',
      }
    }
    const tourId = (tours[0] as { id: string }).id
    const result = await enqueueTourPrepBrief({
      tourId,
      weddingId: args.weddingId,
      venueId: args.venueId,
      triggerSignal: args.triggerSignal,
      supabase: args.supabase,
    })
    if (result.skipped) {
      return {
        name: 'tour_prep_brief',
        ok: true,
        detail: 'skipped: ' + (result.reason ?? 'unknown'),
      }
    }
    return {
      name: 'tour_prep_brief',
      ok: true,
      detail: 'enqueued: ' + (result.jobId ?? ''),
    }
  } catch (err) {
    return {
      name: 'tour_prep_brief',
      ok: false,
      detail: 'threw: ' + (err instanceof Error ? err.message : String(err)),
    }
  }
}

// Wave 13 trigger wiring (2026-05-11). Resolves the most-recent
// completed/no_show/cancelled tour and enqueues a Sage follow-up.
async function safePostTourSageEnqueue(
  args: SafeEnqueueArgs,
): Promise<FiredTrigger> {
  try {
    const { data: tours } = await args.supabase
      .from('tours')
      .select('id, outcome, scheduled_at')
      .eq('wedding_id', args.weddingId)
      .in('outcome', ['completed', 'no_show', 'cancelled'])
      .order('scheduled_at', { ascending: false })
      .limit(1)
    if (!tours || tours.length === 0) {
      return {
        name: 'post_tour_sage_followup',
        ok: true,
        detail: 'skipped: no classified past tour found',
      }
    }
    const tourId = (tours[0] as { id: string }).id
    const result = await enqueuePostTourSage({
      tourId,
      weddingId: args.weddingId,
      venueId: args.venueId,
      triggerSignal: args.triggerSignal,
      supabase: args.supabase,
    })
    if (result.skipped) {
      return {
        name: 'post_tour_sage_followup',
        ok: true,
        detail: 'skipped: ' + (result.reason ?? 'unknown'),
      }
    }
    return {
      name: 'post_tour_sage_followup',
      ok: true,
      detail: 'enqueued: ' + (result.jobId ?? ''),
    }
  } catch (err) {
    return {
      name: 'post_tour_sage_followup',
      ok: false,
      detail: 'threw: ' + (err instanceof Error ? err.message : String(err)),
    }
  }
}

// Wave 13 trigger wiring (2026-05-11). Enqueues review solicitation
// for a wedding that just transitioned into post_event. The enqueue
// helper carries the 30d request-window dedupe so re-firing on
// subsequent transitions is safe.
async function safeReviewSolicitEnqueue(
  args: SafeEnqueueArgs,
): Promise<FiredTrigger> {
  try {
    const result = await enqueueReviewSolicit({
      weddingId: args.weddingId,
      venueId: args.venueId,
      triggerSignal: args.triggerSignal,
      supabase: args.supabase,
    })
    if (result.skipped) {
      return {
        name: 'review_solicitation',
        ok: true,
        detail: 'skipped: ' + (result.reason ?? 'unknown'),
      }
    }
    return {
      name: 'review_solicitation',
      ok: true,
      detail: 'enqueued: ' + (result.jobId ?? ''),
    }
  } catch (err) {
    return {
      name: 'review_solicitation',
      ok: false,
      detail: 'threw: ' + (err instanceof Error ? err.message : String(err)),
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
