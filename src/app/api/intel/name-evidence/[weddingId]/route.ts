/**
 * Couple-scoped name-evidence audit + manual-override API.
 *
 * Wave 2D (2026-05-09) surfaced `people.name_evidence`,
 * `people.platform_handles`, `people.display_handle` and
 * `people.name_confidence` (migration 255).
 *
 * W64 re-keyed it on the couple. The URL segment is still a wedding id,
 * because every link into this panel was written that way, but nothing
 * here reads `weddings` any more: `loadCoupleKeyForWedding` maps the
 * wedding id onto the couple through `couples.source_wedding_id` and IS
 * the tenancy check in the same query. The evidence chain itself is read
 * by `loadCoupleNameEvidence`, which is the one place in the intel layer
 * that knows how to reach the legacy person rows from a couple, and the
 * override write moved to `applyNameOverride`.
 *
 * GET  /api/intel/name-evidence/[weddingId]
 *   One row per partner with the picked display name, confidence chip,
 *   evidence chain (pinned first, then confidence, then recency), and
 *   the per-platform handle map, alongside the couple's own spine handle
 *   map. Most rows have an empty chain; the panel renders a
 *   no-evidence-yet state and still lets the coordinator override.
 *
 * POST /api/intel/name-evidence/[weddingId]
 *   Body: { personId, firstName, lastName }. Coordinator manual
 *   override. See src/lib/services/identity/name-override.ts.
 *
 * Auth: getPlatformAuth — venue-scoped. Demo cannot mutate.
 */

import { NextRequest, NextResponse } from 'next/server'
import { createServiceClient } from '@/lib/supabase/service'
import {
  getPlatformAuth,
  unauthorized,
  forbidden,
  badRequest,
} from '@/lib/api/auth-helpers'
import { logEvent } from '@/lib/observability/logger'
import { loadCoupleKeyForWedding } from '@/lib/intel/readers/couple-key'
import { loadCoupleNameEvidence } from '@/lib/intel/readers/name-evidence'
import { applyNameOverride } from '@/lib/services/identity/name-override'
import { requirePlan, planErrorBody } from '@/lib/auth/require-plan'

// ---------------------------------------------------------------------------
// GET — name evidence + handles for every partner
// ---------------------------------------------------------------------------

export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ weddingId: string }> },
) {
  const plan = await requirePlan(_req, 'pre_opening')
  if (!plan.ok) return NextResponse.json(planErrorBody(plan), { status: plan.status })

  const auth = await getPlatformAuth()
  if (!auth) return unauthorized()
  if (!auth.venueId) return badRequest('caller has no resolved venue')

  const { weddingId } = await params
  if (!weddingId) return badRequest('missing weddingId')

  const supabase = createServiceClient()
  const couple = await loadCoupleKeyForWedding(supabase, auth.venueId, weddingId)
  if (!couple) return forbidden('couple not in venue scope')

  const evidence = await loadCoupleNameEvidence(supabase, auth.venueId, couple.coupleId)
  if (!evidence) return forbidden('couple not in venue scope')

  return NextResponse.json({
    coupleId: evidence.coupleId,
    partners: evidence.partners,
    partnerCount: evidence.partnerCount,
    handles: evidence.handles,
    chainUnavailable: evidence.chainUnavailable,
  })
}

// ---------------------------------------------------------------------------
// POST — coordinator manual override
// ---------------------------------------------------------------------------

interface PostBody {
  personId?: string
  firstName?: string
  lastName?: string
}

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ weddingId: string }> },
) {
  const plan = await requirePlan(req, 'pre_opening')
  if (!plan.ok) return NextResponse.json(planErrorBody(plan), { status: plan.status })

  const auth = await getPlatformAuth()
  if (!auth) return unauthorized()
  if (!auth.venueId) return badRequest('caller has no resolved venue')
  if (auth.isDemo) return forbidden('demo cannot override identity')

  const { weddingId } = await params
  if (!weddingId) return badRequest('missing weddingId')

  const supabase = createServiceClient()
  const couple = await loadCoupleKeyForWedding(supabase, auth.venueId, weddingId)
  if (!couple) return forbidden('couple not in venue scope')

  let body: PostBody
  try {
    body = (await req.json()) as PostBody
  } catch {
    return badRequest('invalid JSON body')
  }
  if (!body.personId) return badRequest('personId is required')
  const first = (body.firstName ?? '').trim().slice(0, 80)
  const last = (body.lastName ?? '').trim().slice(0, 80)
  if (!first && !last) return badRequest('first or last name required')

  const result = await applyNameOverride({
    supabase,
    venueId: auth.venueId,
    weddingId: couple.sourceWeddingId,
    personId: body.personId,
    first: first || null,
    last: last || null,
    userId: auth.userId,
  })
  if (!result.ok) {
    return NextResponse.json({ error: result.error }, { status: result.status })
  }

  // Telemetry — the analytics chain uses this to measure how much manual
  // cleanup a venue needs.
  logEvent({
    level: 'info',
    msg: 'identity.name_override',
    venueId: auth.venueId,
    actor: `user:${auth.userId}`,
    event_type: 'identity.manual_override',
    outcome: 'ok',
    data: {
      couple_id: couple.coupleId,
      wedding_id: couple.sourceWeddingId,
      person_id: body.personId,
    },
  })

  return NextResponse.json({ ok: true })
}
