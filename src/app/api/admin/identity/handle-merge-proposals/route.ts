/**
 * Cross-platform handle convergence proposals (Wave 2C — Tenant 2).
 *
 * Anchor docs:
 *   - IDENTITY-TRUTH-AUDIT.md Q-C (Tenant 2 / cross-platform identity)
 *   - bloom-constitution.md (forensic identity reconstruction)
 *   - lib/services/identity/handle-convergence.ts (the algorithm)
 *
 * Why this endpoint exists
 * ------------------------
 * The constitution's Tenant 2 promise — that "rosaliehoyle on Pinterest
 * AND Knot AND r.hoyle@gmail.com claiming Rosalie Hoyle" merges into
 * one forensic record — was previously the most-undelivered promise of
 * the codebase (per the truth audit). The chokepoint stores per-
 * platform handles in `people.platform_handles`. The clusterer stores
 * per-platform usernames in `candidate_identities.username` and
 * `tangential_signals.extracted_identity.username`. Nothing builds
 * cross-platform same-handle merge candidates.
 *
 * This endpoint runs the matcher (`crossPlatformHandleMerge`) and
 * returns the proposal list. The matcher is READ-ONLY: no merges
 * happen automatically. The coordinator UI surfaces the proposals,
 * orders by score, and the coordinator picks which to apply via the
 * existing merge machinery (mergePeople for people-people merges,
 * resolveVenueCandidates for candidate-promotion).
 *
 * Method: GET
 * Auth: getPlatformAuth + auth.venueId
 *
 * Returns:
 *   {
 *     ok: true,
 *     venueId: string,
 *     handlesInspected: number,
 *     proposalsFound: number,
 *     proposals: HandleMergeProposal[],   // sorted score desc
 *   }
 *
 * Performance: pure SQL aggregation. One SELECT on people, one on
 * candidate_identities, one on tangential_signals. Per Rixey scale
 * (~600 weddings, ~2k candidates, ~8k tangential signals) the
 * payload is well under 1 MB and computes in <2s.
 */

import { NextResponse } from 'next/server'
import { createServiceClient } from '@/lib/supabase/service'
import {
  getPlatformAuth,
  unauthorized,
  forbidden,
  badRequest,
} from '@/lib/api/auth-helpers'
import { crossPlatformHandleMerge } from '@/lib/services/identity/handle-convergence'

export const maxDuration = 60

export async function GET() {
  const auth = await getPlatformAuth()
  if (!auth) return unauthorized()
  if (auth.isDemo) return forbidden('demo cannot run handle convergence')
  if (!auth.venueId) return badRequest('caller has no resolved venue')

  const supabase = createServiceClient()
  try {
    const result = await crossPlatformHandleMerge(supabase, auth.venueId)
    return NextResponse.json({
      ok: true,
      ...result,
    })
  } catch (err) {
    return NextResponse.json(
      { ok: false, error: err instanceof Error ? err.message : 'unknown error' },
      { status: 500 },
    )
  }
}
