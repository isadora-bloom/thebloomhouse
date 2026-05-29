/**
 * Origin-replay orchestrator — Phase 1.1 / ORIGIN-INGESTION-SPEC.md §4 & §6.
 *
 * The single entry point for "replay every origin through `linkSignal`",
 * invoked by the Phase-2 wipe + reimport. Doctrine (N3): reconstruction
 * IS the live origin path replayed over history — no adapter reads a
 * derived mirror. The Backwards Tracer's mirror-reading adapter sweep
 * was retired in Phase 1.1; what remains is this set of origin replays
 * plus the Tracer's post-replay coalesce/agent/decay/validate stages.
 *
 * Coverage matrix (where each origin's replay lives):
 *   - Gmail / email        → email/historical-backfill.ts (drainGmailBackfill)
 *                            → processIncomingEmail → linkSignal      [existing live path]
 *   - CSV (HoneyBook/Knot/  → crm-import → linkSignalBatch            [existing live path]
 *     WeddingWire/Zola)
 *   - Calendly             → replayCalendlyFromQa (verbatim webhook payload
 *                            preserved in weddings.calendly_qa)        [this module]
 *   - Reviews              → replayReviews (Google Places + paste; previously
 *                            never reached the spine)                  [this module]
 *   - Web pixel (UTM)      → stitchVisitsToCouple (bound at calculator submit;
 *                            backfillStitchAll is a no-op until the anon→identity
 *                            carry-forward is wired — see web-visit-stitch.ts)
 *
 * Gmail + CSV are NOT re-invoked here (they have their own entry points and
 * importing them would couple this orchestrator to the email/crm subsystems).
 * This module runs the replays that had no prior origin entry point.
 */

import type { SupabaseClient } from '@supabase/supabase-js'
import { replayCalendlyFromQa } from './calendly-replay'
import { replayReviews } from './reviews'
import { backfillStitchAll } from './web-visit-stitch'

export interface ReplayAllArgs {
  supabase: SupabaseClient
  venueId: string
}

export interface ReplayAllResult {
  calendly: { processed: number; linked: number }
  reviews: { processed: number; linked: number }
  webVisits: { stitched: number }
}

/**
 * Run the origin replays that this module owns (Calendly Q&A, reviews,
 * web-visit stitch). Gmail + CSV replays run via their existing entry
 * points (historical-backfill / crm-import) per the coverage matrix.
 * Idempotent — every replay dedups on its signal's external_id.
 */
export async function replayAllOrigins(args: ReplayAllArgs): Promise<ReplayAllResult> {
  const { supabase, venueId } = args

  // Fail-soft per replay: one source erroring must not abort the others.
  const calendly = await replayCalendlyFromQa({ supabase, venueId }).catch((e) => {
    console.error(`[replay] calendly failed: ${(e as Error).message}`)
    return { processed: 0, linked: 0 }
  })
  const reviews = await replayReviews({ supabase, venueId }).catch((e) => {
    console.error(`[replay] reviews failed: ${(e as Error).message}`)
    return { processed: 0, linked: 0 }
  })
  const webVisits = await backfillStitchAll({ supabase, venueId }).catch((e) => {
    console.error(`[replay] web-visit stitch failed: ${(e as Error).message}`)
    return { stitched: 0 }
  })

  return { calendly, reviews, webVisits }
}

export { replayCalendlyFromQa } from './calendly-replay'
export { replayReviews } from './reviews'
export { stitchVisitsToCouple, backfillStitchAll } from './web-visit-stitch'
