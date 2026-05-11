/**
 * Shared decision-helper for the reject / defer cluster routes.
 *
 * Both routes share the same behaviour:
 *   - Re-fetch + re-cluster (with LLM bridge enabled — same as accept)
 *   - Locate the cluster by clusterKey
 *   - For each handle in the cluster, write a handle_merge_decisions
 *     row with decision='rejected' or 'deferred' (no mergePeople; no
 *     mutations to people / weddings)
 *   - Write one identity_decision_clusters audit row
 *
 * The accept route stays its own file because it has the additional
 * mergePeople fan-out logic that doesn't apply here.
 */

import { NextResponse } from 'next/server'
import { createServiceClient } from '@/lib/supabase/service'
import { crossPlatformHandleMerge } from '@/lib/services/identity/handle-convergence'
import {
  clusterProposalsByPerson,
  type PersonCluster,
} from '@/lib/services/identity/decision-clustering/cluster-proposals'

export interface DecideClusterArgs {
  venueId: string
  userId: string
  clusterKey: string
  decision: 'rejected' | 'deferred'
  note: string | null
}

export async function decideCluster(args: DecideClusterArgs) {
  const { venueId, userId, clusterKey, decision, note } = args
  const supabase = createServiceClient()

  // 1. Re-fetch + re-cluster.
  const result = await crossPlatformHandleMerge(supabase, venueId)
  const clusterResult = await clusterProposalsByPerson({
    proposals: result.proposals,
    supabase,
    venueId,
    enableLLMJudge: true,
  })

  const cluster: PersonCluster | undefined = clusterResult.clusters.find(
    (c) => c.clusterKey === clusterKey,
  )
  if (!cluster) {
    return NextResponse.json(
      {
        ok: false,
        error:
          'Cluster no longer exists — proposals may have been resolved since the page loaded.',
      },
      { status: 404 },
    )
  }

  // 2. Write a handle_merge_decisions row per handle in the cluster.
  const handleResults: Array<{
    handle: string
    decisionId: string | null
    error?: string
  }> = []

  for (const ch of cluster.handles) {
    const proposal = result.proposals.find((p) => p.handle === ch.handle)
    const snapshot = proposal
      ? {
          handle: proposal.handle,
          score: proposal.score,
          platforms: proposal.platforms,
          mixed: proposal.mixed,
          reasoning: proposal.reasoning,
          cluster_key: cluster.clusterKey,
          records: proposal.records.map((r) => ({
            kind: r.kind,
            recordId: r.recordId,
            platform: r.platform,
            firstName: r.firstName,
            lastName: r.lastName,
            email: r.email,
          })),
        }
      : { handle: ch.handle, cluster_key: cluster.clusterKey, note: 'proposal disappeared during re-fetch' }

    const decisionPayload = {
      venue_id: venueId,
      handle_normalised: ch.handle,
      decision,
      decided_by: userId,
      decided_at: new Date().toISOString(),
      source_records: snapshot,
      merge_ids: [] as string[],
      note: note ? `[cluster ${cluster.clusterKey}] ${note}` : `[cluster ${cluster.clusterKey}]`,
      updated_at: new Date().toISOString(),
    }
    let decisionId: string | null = null
    const { data: inserted, error: insertErr } = await supabase
      .from('handle_merge_decisions')
      .insert(decisionPayload)
      .select('id')
      .maybeSingle()
    if (insertErr) {
      const { data: updated } = await supabase
        .from('handle_merge_decisions')
        .update({
          decision: decisionPayload.decision,
          decided_by: decisionPayload.decided_by,
          decided_at: decisionPayload.decided_at,
          source_records: decisionPayload.source_records,
          merge_ids: decisionPayload.merge_ids,
          note: decisionPayload.note,
          updated_at: decisionPayload.updated_at,
        })
        .eq('venue_id', venueId)
        .eq('handle_normalised', ch.handle)
        .select('id')
        .maybeSingle()
      decisionId = (updated?.id as string | undefined) ?? null
    } else {
      decisionId = (inserted?.id as string | undefined) ?? null
    }
    handleResults.push({ handle: ch.handle, decisionId })
  }

  // 3. Cluster audit row.
  const handlesInvolved = cluster.handles.map((h) => ({
    handle: h.handle,
    platforms: h.platforms,
    score: h.score,
    recordCount: h.recordCount,
    reasoning: h.reasoning,
    mixed: h.mixed,
  }))
  const appliedHandleMerges = handleResults.map((r) => ({
    handle: r.handle,
    decisionId: r.decisionId,
    mergeIds: [] as string[],
  }))

  const { error: clusterInsertErr } = await supabase
    .from('identity_decision_clusters')
    .insert({
      venue_id: venueId,
      cluster_key: cluster.clusterKey,
      canonical_person_id: cluster.canonicalPersonId,
      handles_involved: handlesInvolved,
      total_records: cluster.totalRecords,
      aggregate_score: cluster.aggregateScore,
      decision,
      decision_note: note,
      applied_handle_merges: appliedHandleMerges,
      decided_at: new Date().toISOString(),
      decided_by: userId,
    })
  if (clusterInsertErr) {
    return NextResponse.json(
      {
        ok: false,
        error: `cluster audit row failed: ${clusterInsertErr.message}`,
        partialResults: handleResults,
      },
      { status: 500 },
    )
  }

  return NextResponse.json({
    ok: true,
    clusterKey: cluster.clusterKey,
    canonicalPersonId: cluster.canonicalPersonId,
    displayName: cluster.displayName,
    decision,
    handlesDecided: handleResults.length,
    handleResults,
  })
}
