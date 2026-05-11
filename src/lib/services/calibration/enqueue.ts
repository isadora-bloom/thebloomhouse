/**
 * Wave 18 — Calibration enqueue helper + reconciliation TODO.
 *
 * Anchor: feedback_measure_dont_assume.md
 *
 * Purpose
 * -------
 * Re-exports enqueueMeasureOutcomes so reconciliation-stream wiring
 * into Wave 11's stage-triggers.ts has a single import point.
 *
 * Reconciliation TODO (DO NOT delete this comment)
 * ------------------------------------------------
 * src/lib/services/lifecycle/stage-triggers.ts is shared territory
 * between Waves 11 and 13. Wave 18 needs ONE call inserted into the
 * terminal-state branches:
 *
 *   import { enqueueMeasureOutcomes } from
 *     '@/lib/services/calibration/enqueue'
 *
 *   case 'booked':
 *   case 'lost':
 *   case 'cancelled':
 *   case 'post_event': {
 *     fired.push(
 *       await safeMeasureOutcomesEnqueue({
 *         supabase, weddingId, venueId,
 *         triggerSignal: `lifecycle_${toStage}`,
 *       }),
 *     )
 *     break
 *   }
 *
 * with a corresponding safeMeasureOutcomesEnqueue wrapper modelled on
 * safeCoupleIntelEnqueue. Until that wiring lands, the daily
 * calibration_sweep cron picks up dangling snapshots so measurement
 * still happens, just on a 24h delay.
 *
 * The cron job string is `calibration_sweep` (not yet registered;
 * vercel.json is in the cron-reconciliation stream's zone).
 */

export {
  enqueueMeasureOutcomes,
  type EnqueueMeasureOutcomesArgs,
  type EnqueueMeasureOutcomesResult,
} from './measure-outcomes'
