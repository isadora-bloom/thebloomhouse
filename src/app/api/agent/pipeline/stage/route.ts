/**
 * POST /api/agent/pipeline/stage
 *
 * A card moved on the pipeline board. Body: { weddingId, stage } where
 * `stage` is an operator stage key (`tour_booked`, `proposal_out`, ...).
 *
 * The board used to write `weddings.status` straight from the browser
 * with the coordinator's own key: no audit row, no machine stage, and no
 * check that the row belonged to the venue beyond whatever RLS happened
 * to allow. The write now runs server-side through
 * `src/lib/services/pipeline/board-stage.ts`, which records the
 * transition before it changes anything.
 *
 * Demo sessions are refused. A demo visitor is an anonymous stranger with
 * a cookie, and this mutates a real venue's pipeline.
 */

import { NextRequest, NextResponse } from 'next/server'
import { getPlatformAuth, refuseDemo, unauthorized } from '@/lib/api/auth-helpers'
import { resolveScopeVenueIds } from '@/lib/api/resolve-platform-scope'
import { createServiceClient } from '@/lib/supabase/service'
import { setBoardStage } from '@/lib/services/pipeline/board-stage'

export async function POST(req: NextRequest) {
  const auth = await getPlatformAuth()
  if (!auth) return unauthorized()
  const refused = refuseDemo(auth)
  if (refused) return refused

  let body: { weddingId?: string; stage?: string; venueId?: string; note?: string }
  try {
    body = (await req.json()) as typeof body
  } catch {
    return NextResponse.json({ ok: false, error: 'invalid_json' }, { status: 400 })
  }
  if (!body.weddingId || !body.stage) {
    return NextResponse.json(
      { ok: false, error: 'weddingId and stage are required' },
      { status: 400 },
    )
  }

  // A group or org scope shows more than one venue's cards, so the body
  // may name a venue other than the session's own. It is checked against
  // the scope rather than trusted: without this, one venue could move
  // another venue's card by editing a request.
  const scopeVenueIds = await resolveScopeVenueIds()
  const venueId =
    body.venueId && scopeVenueIds.includes(body.venueId) ? body.venueId : auth.venueId
  if (body.venueId && venueId !== body.venueId) {
    return NextResponse.json({ ok: false, error: 'forbidden_venue' }, { status: 403 })
  }

  const result = await setBoardStage(createServiceClient(), {
    venueId,
    weddingId: body.weddingId,
    stage: body.stage,
    actorId: auth.userId,
    note: body.note ?? null,
  })

  if (!result.ok) {
    return NextResponse.json(
      { ok: false, error: result.error },
      { status: result.status },
    )
  }
  return NextResponse.json(result)
}
