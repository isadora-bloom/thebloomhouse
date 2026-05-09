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

interface DecisionRow {
  handle_normalised: string
  decision: 'accepted' | 'rejected' | 'deferred'
  decided_by: string | null
  decided_at: string
  note: string | null
  merge_ids: string[] | null
}

export async function GET() {
  const auth = await getPlatformAuth()
  if (!auth) return unauthorized()
  if (auth.isDemo) return forbidden('demo cannot run handle convergence')
  if (!auth.venueId) return badRequest('caller has no resolved venue')

  const supabase = createServiceClient()
  try {
    const [result, { data: decisions }] = await Promise.all([
      crossPlatformHandleMerge(supabase, auth.venueId),
      supabase
        .from('handle_merge_decisions')
        .select('handle_normalised, decision, decided_by, decided_at, note, merge_ids')
        .eq('venue_id', auth.venueId),
    ])

    // Build a decision map for fast lookup, then split proposals into
    // (a) live (no decision yet, or deferred) and (b) audit (accepted /
    // rejected). The UI renders both sections — the live list to act
    // on, the audit list as history.
    const byHandle = new Map<string, DecisionRow>()
    for (const d of (decisions ?? []) as DecisionRow[]) {
      byHandle.set(d.handle_normalised, d)
    }

    interface AnnotatedProposal {
      // re-export shape from handle-convergence with decision metadata
      handle: string
      score: number
      mixed: boolean
      platforms: string[]
      reasoning: string[]
      records: unknown[]
      decision: DecisionRow['decision'] | null
      decided_at: string | null
      decided_by: string | null
      note: string | null
    }

    const live: AnnotatedProposal[] = []
    const audit: AnnotatedProposal[] = []

    for (const p of result.proposals) {
      const decision = byHandle.get(p.handle) ?? null
      const annotated: AnnotatedProposal = {
        handle: p.handle,
        score: p.score,
        mixed: p.mixed,
        platforms: p.platforms,
        reasoning: p.reasoning,
        records: p.records,
        decision: decision?.decision ?? null,
        decided_at: decision?.decided_at ?? null,
        decided_by: decision?.decided_by ?? null,
        note: decision?.note ?? null,
      }
      if (!decision || decision.decision === 'deferred') {
        live.push(annotated)
      } else {
        // accepted or rejected — keep in audit only
        audit.push(annotated)
      }
    }

    // Live: undecided first (most recent activity / highest confidence
    // first), deferred sunk to the bottom.
    live.sort((a, b) => {
      const aDeferred = a.decision === 'deferred' ? 1 : 0
      const bDeferred = b.decision === 'deferred' ? 1 : 0
      if (aDeferred !== bDeferred) return aDeferred - bDeferred
      if (b.score !== a.score) return b.score - a.score
      return a.handle.localeCompare(b.handle)
    })

    // Audit: most-recently decided first.
    audit.sort((a, b) => {
      const da = a.decided_at ? Date.parse(a.decided_at) : 0
      const db = b.decided_at ? Date.parse(b.decided_at) : 0
      return db - da
    })

    return NextResponse.json({
      ok: true,
      venueId: result.venueId,
      handlesInspected: result.handlesInspected,
      proposalsFound: result.proposalsFound,
      live,
      audit,
      // Backwards-compat: the legacy `proposals` field used to carry
      // every proposal regardless of decision state. Keep emitting it
      // (= live + audit) so existing consumers don't break, but the
      // new UI uses live/audit directly.
      proposals: [...live, ...audit],
    })
  } catch (err) {
    return NextResponse.json(
      { ok: false, error: err instanceof Error ? err.message : 'unknown error' },
      { status: 500 },
    )
  }
}
