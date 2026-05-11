/**
 * GET /api/admin/identity/decision-clusters
 *
 * Wave 10 — person-keyed identity decision UX.
 *
 * Anchors:
 *   - src/lib/services/identity/decision-clustering/cluster-proposals.ts
 *   - migration 277 (identity_decision_clusters)
 *   - bloom-constitution.md (forensic identity reconstruction)
 *
 * Returns:
 *   {
 *     ok: true,
 *     venueId: string,
 *     pending: PersonCluster[]    — current pending clusters
 *     history: ClusterHistoryRow[] — last 20 cluster decisions, recency desc
 *     llmJudgeInvocations: number
 *   }
 *
 * The GET endpoint runs the clusterer WITHOUT the LLM bridge (the
 * cheap, deterministic path — list view should never spend LLM budget
 * on every page load). LLM bridges happen on the cluster-accept side
 * where the operator has explicitly opted into spending budget on a
 * deeper read.
 *
 * Auth: getPlatformAuth + auth.venueId. Demo mode rejected.
 */

import { NextResponse } from 'next/server'
import { createServiceClient } from '@/lib/supabase/service'
import {
  getPlatformAuth,
  unauthorized,
  forbidden,
  badRequest,
} from '@/lib/api/auth-helpers'
import {
  clusterProposalsByPerson,
  type PersonCluster,
} from '@/lib/services/identity/decision-clustering/cluster-proposals'
import { crossPlatformHandleMerge } from '@/lib/services/identity/handle-convergence'

export const maxDuration = 60

interface DecisionRow {
  handle_normalised: string
  decision: 'accepted' | 'rejected' | 'deferred'
}

interface ClusterDecisionRow {
  id: string
  cluster_key: string
  canonical_person_id: string | null
  handles_involved: unknown
  total_records: number
  aggregate_score: number
  decision: 'accepted' | 'rejected' | 'deferred'
  decision_note: string | null
  decided_at: string
  decided_by: string | null
}

export async function GET(req: Request) {
  const auth = await getPlatformAuth()
  if (!auth) return unauthorized()
  if (auth.isDemo) return forbidden('demo cannot run handle decision clusters')
  if (!auth.venueId) return badRequest('caller has no resolved venue')

  // Honour ?venueId override only for super_admin / org_admin (mirrors
  // handle-merge-proposals semantics — we keep it simple here and just
  // use auth.venueId). Future: assertCanAccessVenue.
  const url = new URL(req.url)
  const requestedVenueId = url.searchParams.get('venueId')?.trim()
  const venueId = requestedVenueId && auth.role === 'super_admin'
    ? requestedVenueId
    : auth.venueId

  const supabase = createServiceClient()
  try {
    // 1. Run the raw proposal generator so we know which handles are
    // live (no decision yet OR deferred). Filter out
    // accepted/rejected handles before clustering — those are
    // finalised at the per-handle layer.
    const result = await crossPlatformHandleMerge(supabase, venueId)
    const { data: handleDecisions } = await supabase
      .from('handle_merge_decisions')
      .select('handle_normalised, decision')
      .eq('venue_id', venueId)
    const decidedHandles = new Map<string, DecisionRow['decision']>()
    for (const d of ((handleDecisions ?? []) as DecisionRow[])) {
      decidedHandles.set(d.handle_normalised, d.decision)
    }
    // Live proposals = no decision OR deferred (deferred stays
    // surfaced; accepted/rejected are filtered out).
    const liveProposals = result.proposals.filter((p) => {
      const d = decidedHandles.get(p.handle)
      return !d || d === 'deferred'
    })

    // 2. Cluster.
    const clusterResult = await clusterProposalsByPerson({
      proposals: liveProposals,
      supabase,
      venueId,
      enableLLMJudge: false,
    })

    // 3. Pull cluster decision history (last 20 for the venue).
    const { data: historyRows } = await supabase
      .from('identity_decision_clusters')
      .select(
        'id, cluster_key, canonical_person_id, handles_involved, total_records, aggregate_score, decision, decision_note, decided_at, decided_by',
      )
      .eq('venue_id', venueId)
      .order('decided_at', { ascending: false })
      .limit(20)

    const history = ((historyRows ?? []) as ClusterDecisionRow[]).map((row) => ({
      id: row.id,
      clusterKey: row.cluster_key,
      canonicalPersonId: row.canonical_person_id,
      handlesInvolved: row.handles_involved,
      totalRecords: row.total_records,
      aggregateScore: Number(row.aggregate_score),
      decision: row.decision,
      decisionNote: row.decision_note,
      decidedAt: row.decided_at,
      decidedBy: row.decided_by,
    }))

    // 4. Filter out clusters whose key has already been decided (so a
    // cluster doesn't re-surface immediately after an accept/reject).
    // History is the audit trail; pending is the actionable queue.
    const decidedClusterKeys = new Set<string>()
    for (const h of history) {
      // Only the most-recent decision per cluster_key matters for
      // pending filtering. History is recency-desc, so the first
      // occurrence is the latest.
      if (!decidedClusterKeys.has(h.clusterKey)) {
        if (h.decision === 'accepted' || h.decision === 'rejected') {
          decidedClusterKeys.add(h.clusterKey)
        }
      }
    }
    const pending: PersonCluster[] = clusterResult.clusters.filter(
      (c) => !decidedClusterKeys.has(c.clusterKey),
    )

    return NextResponse.json({
      ok: true,
      venueId,
      pending,
      history,
      llmJudgeInvocations: clusterResult.llmJudgeInvocations,
      // Diagnostics for the page header.
      stats: {
        proposalsLive: liveProposals.length,
        proposalsTotal: result.proposals.length,
        clustersBuilt: clusterResult.clusters.length,
        clustersPending: pending.length,
      },
    })
  } catch (err) {
    return NextResponse.json(
      { ok: false, error: err instanceof Error ? err.message : 'unknown error' },
      { status: 500 },
    )
  }
}
