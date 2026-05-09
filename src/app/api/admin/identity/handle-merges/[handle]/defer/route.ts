/**
 * POST /api/admin/identity/handle-merges/:handle/defer
 *
 * Records a coordinator's "I'm not sure yet" decision. Unlike reject,
 * deferred proposals stay surfaced on /admin/identity/handle-merges
 * (sunk to the bottom) so the coordinator can come back later. The
 * decision row exists so the UI can render the deferred badge and
 * the timestamp/note context across page loads.
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
  if (auth.isDemo) return forbidden('demo cannot defer handle merges')
  if (!auth.venueId) return badRequest('caller has no resolved venue')

  const params = await ctx.params
  const handleRaw = decodeURIComponent(params.handle ?? '').trim().toLowerCase()
  if (!handleRaw) return badRequest('handle path param required')

  const body = (await req.json().catch(() => null)) as { note?: string | null } | null
  const note = body?.note?.toString().trim() || null

  const supabase = createServiceClient()

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
    : { handle: handleRaw, note: 'deferred without live proposal context' }

  const decisionPayload = {
    venue_id: auth.venueId,
    handle_normalised: handleRaw,
    decision: 'deferred' as const,
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

  return NextResponse.json({ ok: true, handle: handleRaw, decision: 'deferred' })
}
