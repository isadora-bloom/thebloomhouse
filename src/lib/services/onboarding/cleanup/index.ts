/**
 * Onboarding data-cleanup pipeline (T5-W5).
 *
 * Six Rixey-derived repair steps, run in dependency order, that must
 * complete after a fresh venue's Gmail backfill and before the
 * readiness gate. Previously founder-CLI only (scripts/onboard-data-
 * cleanup.ts spawning six sibling scripts as child processes against
 * production). Extracted into library functions here so a coordinator
 * can preview (dry-run) then apply from the onboarding project UI —
 * POST /api/onboarding/project/cleanup — with no terminal.
 *
 * Step order matters (each step's inputs depend on the previous step's
 * corrections):
 *   1. Direction reclassification — everything else depends on
 *      direction + from_email being right.
 *   2. Recover scheduling-event datetimes from metadata.
 *   3. Re-align booking vs tour timestamps (requires step 1).
 *   4. Repair touchpoint sources (requires step 1).
 *   5. Recompute attribution buckets (requires step 3's inquiry_date
 *      corrections).
 *   6. Recompute heat scores (after every other correction).
 *
 * The CLI wrapper scripts/onboard-data-cleanup.ts and its six sibling
 * scripts stay in place as thin wrappers around these functions —
 * same behaviour, same output, logic lives here once.
 */

import type { SupabaseClient } from '@supabase/supabase-js'
import type { CleanupStepResult, CleanupStepFn } from './types'
import { reclassifyDirectionFromGmail } from './reclassify-direction'
import { backfillSchedulingEventDates } from './scheduling-event-dates'
import { backfillBookingVsTourTimestamps } from './booking-vs-tour-timestamps'
import { backfillTouchpointSources } from './touchpoint-sources'
import { recomputeAttributionBuckets } from './attribution-buckets'
import { recomputeHeatAfterCleanup } from './heat-recompute'

export type { CleanupStepResult } from './types'

export interface CleanupStepDef {
  id: string
  name: string
  rationale: string
  run: CleanupStepFn
}

export const CLEANUP_STEPS: CleanupStepDef[] = [
  {
    id: 'reclassify_direction',
    name: '1. Reclassify direction from Gmail labels',
    rationale: 'Direction + from_email must be correct before any downstream step can trust them.',
    run: reclassifyDirectionFromGmail,
  },
  {
    id: 'scheduling_event_dates',
    name: '2. Recover scheduling-event datetimes from metadata',
    rationale: 'Tour event timestamps recovered from metadata.event_datetime / subject / sibling rows.',
    run: backfillSchedulingEventDates,
  },
  {
    id: 'booking_vs_tour_timestamps',
    name: '3. Re-align booking vs tour timestamps',
    rationale: 'Inquiry / tour_booked land at the booking moment (email arrival); tour_conducted lands at the tour itself.',
    run: backfillBookingVsTourTimestamps,
  },
  {
    id: 'touchpoint_sources',
    name: '4. Repair touchpoint sources',
    rationale: "Touchpoint source matches the actual channel (inferred from interaction.from_email), not the wedding's legacy first-touch.",
    run: backfillTouchpointSources,
  },
  {
    id: 'attribution_buckets',
    name: '5. Recompute attribution buckets',
    rationale: "After step 3 corrected inquiry_date, bucket / is_first_touch on existing attribution_events may be stale. Re-derive against current inquiry dates.",
    run: recomputeAttributionBuckets,
  },
  {
    id: 'heat_recompute',
    name: '6. Recompute heat scores',
    rationale: 'Heat may be inflated from now-deleted false-positive engagement events. Reset everything.',
    run: recomputeHeatAfterCleanup,
  },
]

export interface CleanupPipelineResult {
  venueId: string
  apply: boolean
  steps: CleanupStepResult[]
  /** True if every step that ran completed without a hard failure. Skipped steps don't count against this. */
  allOk: boolean
}

/**
 * Run every cleanup step in order. Does NOT abort on a step reporting
 * ok=false (soft per-row errors) or skipped=true (e.g. no Gmail
 * connections yet) — later steps are independent enough to still be
 * useful, and the coordinator sees exactly which step needs attention
 * in the per-step breakdown. This differs from the CLI orchestrator,
 * which aborts the whole run on a non-zero exit code; the UI's dry-run
 * preview should show the full picture rather than stopping early.
 */
export async function runCleanupPipeline(
  sb: SupabaseClient,
  venueId: string,
  apply: boolean,
): Promise<CleanupPipelineResult> {
  const steps: CleanupStepResult[] = []
  for (const step of CLEANUP_STEPS) {
    try {
      const result = await step.run(sb, venueId, apply)
      steps.push(result)
    } catch (err) {
      steps.push({
        id: step.id,
        name: step.name,
        ok: false,
        skipped: false,
        counts: {},
        samples: [],
        errors: [err instanceof Error ? err.message : String(err)],
      })
    }
  }
  const allOk = steps.every((s) => s.skipped || s.ok)
  return { venueId, apply, steps, allOk }
}
