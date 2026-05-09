/**
 * POST /api/admin/identity/handle-merges/:handle/reject
 *
 * Records a coordinator's "this is not a same-person convergence"
 * decision so the proposal does not re-surface on subsequent loads
 * of /admin/identity/handle-merges. The row stays in
 * handle_merge_decisions as audit history and the proposals API
 * filters it out of the live list.
 *
 * No mergePeople invocation — by definition rejection means no merge
 * happens. Caller can flip to accepted later by re-decideing (the
 * unique index on (venue_id, handle_normalised) ensures one row per
 * handle).
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

export const maxDuration = 30

interface RouteContext {
  params: Promise<{ handle: string }>
}

export async function POST(req: NextRequest, ctx: RouteContext) {
  const auth = await getPlatformAuth()
  if (!auth) return unauthorized()
  if (auth.isDemo) return forbidden('demo cannot reject handle merges')
  if (!auth.venueId) return badRequest('caller has no resolved venue')

  const params = await ctx.params
  const handleRaw = decodeURIComponent(params.handle ?? '').trim().toLowerCase()
  if (!handleRaw) return badRequest('handle path param required')

  const body = (await req.json().catch(() => null)) as { note?: string | null } | null
  const note = body?.note?.toString().trim() || null

  const supabase = createServiceClient()

  // Pull current proposal for the snapshot — best-effort. If the
  // proposal no longer exists, we still record the rejection so
  // future re-converging records of the same handle don't re-surface
  // it as a fresh proposal (the decision row is the authoritative
  // sticky for this handle).
  const result = await crossPlatformHandleMerge(supabase, auth.venueId)
  const proposal = result.proposals.find((p) => p.handle === handleRaw) ?? null

  const snapshot = proposal
    ? {
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
    : { handle: handleRaw, note: 'rejected without live proposal context' }

  const decisionPayload = {
    venue_id: auth.venueId,
    handle_normalised: handleRaw,
    decision: 'rejected' as const,
    decided_by: auth.userId,
    decided_at: new Date().toISOString(),
    source_records: snapshot,
    merge_ids: [] as string[],
    note,
    updated_at: new Date().toISOString(),
  }

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
      .eq('handle_normalised', handleRaw)
    if (updateErr) {
      return NextResponse.json(
        { ok: false, error: updateErr.message },
        { status: 500 },
      )
    }
  }

  return NextResponse.json({ ok: true, handle: handleRaw, decision: 'rejected' })
}
