/**
 * POST /api/admin/identity/handle-merges/:handle/accept
 *
 * Anchors:
 *   - migration 259 (handle_merge_decisions)
 *   - src/lib/services/identity/handle-convergence.ts (proposal generator)
 *   - src/lib/services/identity/merge-people.ts (mergePeople)
 *
 * Coordinator-side accept: re-runs the proposal generator (handles
 * may have shifted since the page loaded), confirms the proposal for
 * :handle still exists, fans out into pairwise mergePeople calls for
 * the people-only records on the proposal, and writes a single
 * decision row to handle_merge_decisions so the proposal does not
 * re-surface.
 *
 * Why re-run the generator
 * ------------------------
 * Stale UI: the coordinator may have left the page open for an hour
 * before clicking accept. Trusting the UI's record list is unsafe —
 * a candidate may have been resolved, a person may have been
 * tombstoned, an orphan signal may have been clustered. We re-fetch
 * to get truth.
 *
 * What gets merged
 * ----------------
 * Only `people` records are merged via mergePeople. Candidate-only
 * proposals (records all on `candidate_identities`) write a decision
 * row but skip mergePeople — the resolver runs cluster-side and the
 * coordinator's "accept" here is the consent signal for the next
 * resolver pass.
 *
 * Mixed proposals (people + candidate) merge the people pairs only
 * and leave candidate consolidation to the resolver. This matches
 * the constitution's handover rule: pre-zero candidates are
 * promoted by the resolver, post-zero people are merged by the
 * resolver-tombstone path.
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
import { mergePeople } from '@/lib/services/identity/merge-people'

export const maxDuration = 60

interface RouteContext {
  params: Promise<{ handle: string }>
}

export async function POST(req: NextRequest, ctx: RouteContext) {
  const auth = await getPlatformAuth()
  if (!auth) return unauthorized()
  if (auth.isDemo) return forbidden('demo cannot accept handle merges')
  if (!auth.venueId) return badRequest('caller has no resolved venue')

  const params = await ctx.params
  const handleRaw = decodeURIComponent(params.handle ?? '').trim().toLowerCase()
  if (!handleRaw) return badRequest('handle path param required')

  const body = (await req.json().catch(() => null)) as { note?: string | null } | null
  const note = body?.note?.toString().trim() || null

  const supabase = createServiceClient()

  // 1. Re-fetch proposals to ensure :handle still has 2+ converging
  // records. Trusting UI state is unsafe across long-open tabs.
  const result = await crossPlatformHandleMerge(supabase, auth.venueId)
  const proposal = result.proposals.find((p) => p.handle === handleRaw)
  if (!proposal) {
    return NextResponse.json(
      {
        ok: false,
        error: 'No live proposal for this handle. It may have been resolved already.',
      },
      { status: 404 },
    )
  }

  // 2. Fan out people-record pairs into mergePeople. Pick the kept
  // record as the FIRST people record by recordId order — stable,
  // deterministic, no preference for one over another. The resolver
  // already prefers older rows for canonicality elsewhere; we mirror
  // that by sorting ascending on recordId (UUIDs are time-prefixed
  // when generated via gen_random_uuid + sort isn't strictly time
  // order, but it's stable across re-decisions which is what we
  // need).
  const peopleRecords = proposal.records
    .filter((r) => r.kind === 'people' && !r.recordId.startsWith('orphan-signal:'))
    .sort((a, b) => a.recordId.localeCompare(b.recordId))

  const mergeIds: string[] = []
  const mergeFailures: { keep: string; merge: string; error: string }[] = []

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
              type: 'cross_platform_handle',
              detail: `shared handle "${proposal.handle}" across [${proposal.platforms.join(', ')}] (score ${proposal.score})`,
              weight: proposal.score,
            },
          ],
          confidence: proposal.score,
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

  // 3. Write the decision row. Idempotent on (venue_id,
  // handle_normalised) — a coordinator who clicks accept twice gets
  // one row updated in place rather than a duplicate.
  const snapshot = {
    handle: proposal.handle,
    score: proposal.score,
    platforms: proposal.platforms,
    mixed: proposal.mixed,
    reasoning: proposal.reasoning,
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
    note,
    updated_at: new Date().toISOString(),
  }

  // Try insert; on unique-constraint conflict, update.
  const { error: insertErr } = await supabase
    .from('handle_merge_decisions')
    .insert(decisionPayload)
  if (insertErr) {
    const { error: updateErr } = await supabase
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
    if (updateErr) {
      return NextResponse.json(
        {
          ok: false,
          error: `merged ${mergeIds.length} pairs, but decision row failed: ${updateErr.message}`,
          merge_ids: mergeIds,
          merge_failures: mergeFailures,
        },
        { status: 500 },
      )
    }
  }

  return NextResponse.json({
    ok: true,
    handle: proposal.handle,
    decision: 'accepted',
    merged_pairs: mergeIds.length,
    merge_ids: mergeIds,
    merge_failures: mergeFailures,
    candidate_only: peopleRecords.length < 2,
  })
}
