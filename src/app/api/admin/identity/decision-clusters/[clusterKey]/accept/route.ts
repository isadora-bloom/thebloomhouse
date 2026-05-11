/**
 * POST /api/admin/identity/decision-clusters/:clusterKey/accept
 *
 * Wave 10 — accept ALL handles in a person cluster atomically.
 *
 * Anchors:
 *   - migration 277 (identity_decision_clusters)
 *   - src/lib/services/identity/decision-clustering/cluster-proposals.ts
 *   - src/app/api/admin/identity/handle-merges/[handle]/accept (per-handle accept)
 *   - src/lib/services/identity/merge-people.ts (mergePeople primitive)
 *
 * Why this exists
 * ---------------
 * "Jamie B" had 4 separate handle proposals. Accepting one collapsed
 * the others into the canonical Jamie B. Wave 10's cluster-accept
 * collapses ALL of Jamie B's handles atomically — one operator
 * decision, N underlying handle merges.
 *
 * Algorithm
 * ---------
 *   1. Re-run proposal generator + clusterer (with LLM bridge enabled)
 *      to guard against staleness — operator may have left the page
 *      open for an hour.
 *   2. Locate the cluster whose clusterKey matches the URL param.
 *   3. For each handle in the cluster, do what the per-handle accept
 *      route does: fan out into pairwise mergePeople, write a row
 *      to handle_merge_decisions.
 *   4. Write one row to identity_decision_clusters summarising the
 *      atomic operation.
 *   5. Return per-handle summary so the UI can show progress.
 *
 * Auth: getPlatformAuth + auth.venueId. Demo mode rejected.
 */

import { NextRequest, NextResponse } from 'next/server'
import { createServiceClient } from '@/lib/supabase/service'
import {
  getPlatformAuth,
  unauthorized,
  forbidden,
  badRequest,
} from '@/lib/api/auth-helpers'
import { crossPlatformHandleMerge } from '@/lib/services/identity/handle-convergence'
import {
  clusterProposalsByPerson,
  type PersonCluster,
} from '@/lib/services/identity/decision-clustering/cluster-proposals'
import { mergePeople } from '@/lib/services/identity/merge-people'

export const maxDuration = 120

interface RouteContext {
  params: Promise<{ clusterKey: string }>
}

interface HandleAcceptResult {
  handle: string
  decisionId: string | null
  mergeIds: string[]
  mergeFailures: { keep: string; merge: string; error: string }[]
  candidateOnly: boolean
  error?: string
}

export async function POST(req: NextRequest, ctx: RouteContext) {
  const auth = await getPlatformAuth()
  if (!auth) return unauthorized()
  if (auth.isDemo) return forbidden('demo cannot accept decision clusters')
  if (!auth.venueId) return badRequest('caller has no resolved venue')

  const params = await ctx.params
  const clusterKey = decodeURIComponent(params.clusterKey ?? '').trim()
  if (!clusterKey) return badRequest('clusterKey path param required')

  const body = (await req.json().catch(() => null)) as { note?: string | null } | null
  const note = body?.note?.toString().trim() || null

  const supabase = createServiceClient()

  // 1. Re-run the proposal generator + clusterer. LLM bridge enabled
  // because the operator opted in by clicking accept on a specific
  // cluster — we want the strongest read on whether the bridges hold.
  const result = await crossPlatformHandleMerge(supabase, auth.venueId)
  const clusterResult = await clusterProposalsByPerson({
    proposals: result.proposals,
    supabase,
    venueId: auth.venueId,
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

  // 2. Per-handle accept fan-out. Reuses the same logic as the
  // per-handle accept route inline (we don't refactor the existing
  // route per the build doctrine — Wave 10 builds atop without
  // touching the existing entry point).
  const handleResults: HandleAcceptResult[] = []

  for (const ch of cluster.handles) {
    const proposal = result.proposals.find((p) => p.handle === ch.handle)
    if (!proposal) {
      handleResults.push({
        handle: ch.handle,
        decisionId: null,
        mergeIds: [],
        mergeFailures: [],
        candidateOnly: true,
        error: 'proposal disappeared during re-fetch',
      })
      continue
    }

    // Pairwise mergePeople over the people records.
    const peopleRecords = proposal.records
      .filter((r) => r.kind === 'people' && !r.recordId.startsWith('orphan-signal:'))
      .sort((a, b) => a.recordId.localeCompare(b.recordId))

    const mergeIds: string[] = []
    const mergeFailures: HandleAcceptResult['mergeFailures'] = []

    if (peopleRecords.length >= 2) {
      const keepId = peopleRecords[0].recordId
      for (let i = 1; i < peopleRecords.length; i += 1) {
        const mergeId = peopleRecords[i].recordId
        try {
          const merged = await mergePeople({
            supabase,
            venueId: auth.venueId,
            keepPersonId: keepId,
            mergePersonId: mergeId,
            tier: 'medium',
            signals: [
              {
                type: 'cluster_accept_handle',
                detail: `cluster ${cluster.clusterKey} — handle "${proposal.handle}" across [${proposal.platforms.join(', ')}] (score ${proposal.score})`,
                weight: cluster.aggregateScore,
              },
            ],
            confidence: cluster.aggregateScore,
            mergedBy: auth.userId,
          })
          mergeIds.push(merged.mergeId)
        } catch (err) {
          mergeFailures.push({
            keep: keepId,
            merge: mergeId,
            error: err instanceof Error ? err.message : 'unknown',
          })
        }
      }
    }

    // Write handle_merge_decisions row (per-handle audit, same shape
    // as the per-handle accept endpoint produces).
    const snapshot = {
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
    const decisionPayload = {
      venue_id: auth.venueId,
      handle_normalised: proposal.handle,
      decision: 'accepted' as const,
      decided_by: auth.userId,
      decided_at: new Date().toISOString(),
      source_records: snapshot,
      merge_ids: mergeIds,
      note: note ? `[cluster ${cluster.clusterKey}] ${note}` : `[cluster ${cluster.clusterKey}]`,
      updated_at: new Date().toISOString(),
    }
    let decisionId: string | null = null
    const { data: insertedDecision, error: insertErr } = await supabase
      .from('handle_merge_decisions')
      .insert(decisionPayload)
      .select('id')
      .maybeSingle()
    if (insertErr) {
      // Likely unique-constraint conflict — update in place.
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
        .eq('venue_id', auth.venueId)
        .eq('handle_normalised', proposal.handle)
        .select('id')
        .maybeSingle()
      decisionId = (updated?.id as string | undefined) ?? null
    } else {
      decisionId = (insertedDecision?.id as string | undefined) ?? null
    }

    handleResults.push({
      handle: proposal.handle,
      decisionId,
      mergeIds,
      mergeFailures,
      candidateOnly: peopleRecords.length < 2,
    })
  }

  // 3. Write the single cluster decision audit row.
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
    mergeIds: r.mergeIds,
    candidateOnly: r.candidateOnly,
  }))

  const { error: clusterInsertErr } = await supabase
    .from('identity_decision_clusters')
    .insert({
      venue_id: auth.venueId,
      cluster_key: cluster.clusterKey,
      canonical_person_id: cluster.canonicalPersonId,
      handles_involved: handlesInvolved,
      total_records: cluster.totalRecords,
      aggregate_score: cluster.aggregateScore,
      decision: 'accepted',
      decision_note: note,
      applied_handle_merges: appliedHandleMerges,
      decided_at: new Date().toISOString(),
      decided_by: auth.userId,
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

  const totalMergeIds = handleResults.reduce((s, r) => s + r.mergeIds.length, 0)
  const totalFailures = handleResults.reduce((s, r) => s + r.mergeFailures.length, 0)

  return NextResponse.json({
    ok: true,
    clusterKey: cluster.clusterKey,
    canonicalPersonId: cluster.canonicalPersonId,
    displayName: cluster.displayName,
    decision: 'accepted',
    handlesAccepted: handleResults.length,
    peopleMerged: totalMergeIds,
    errors: totalFailures,
    handleResults,
    llmBridged: cluster.llmBridged,
    llmConfidence: cluster.llmConfidence,
  })
}
