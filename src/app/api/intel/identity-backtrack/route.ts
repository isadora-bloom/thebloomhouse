/**
 * Identity-backtrack coordinator API (Stream T5-Rixey-CCC, 2026-05-02).
 *
 * GET /api/intel/identity-backtrack
 *   Returns the medium-confidence review queue for the venue:
 *     {
 *       items: BacktrackReviewItem[],
 *       summary?: BacktrackSummary,  // present when ?run=1
 *     }
 *
 *   Query params:
 *     ?run=1 — execute the backtrack runner before returning the queue.
 *              Coordinator-triggered "scan now" button. Otherwise the
 *              queue is read-only (relies on cron).
 *
 * POST /api/intel/identity-backtrack
 *   Body shapes:
 *     { action: 'link', candidateId, weddingId, reason? }
 *       Coordinator confirms a medium-confidence link.
 *     { action: 'reject', candidateId }
 *       Coordinator dismisses a candidate from the queue.
 *     { action: 'run' }
 *       Trigger a venue-wide backtrack scan (returns BacktrackSummary).
 *
 * Auth: getPlatformAuth — coordinator-only.
 */

import { NextRequest, NextResponse } from 'next/server'
import { createServiceClient } from '@/lib/supabase/service'
import { getPlatformAuth } from '@/lib/api/auth-helpers'
import {
  listPendingBacktrackReview,
  runBacktrackForVenue,
  applyBacktrackLink,
  rejectBacktrackCandidate,
} from '@/lib/services/identity-backtrack'
import { requirePlan, planErrorBody } from '@/lib/auth/require-plan'

export async function GET(request: NextRequest) {
  // GAP-12: API-layer plan_tier enforcement BEFORE any DB reads.
  const plan = await requirePlan(request, 'pre_opening')
  if (!plan.ok) return NextResponse.json(planErrorBody(plan), { status: plan.status })

  const auth = await getPlatformAuth()
  if (!auth) return NextResponse.json({ error: 'unauthorized' }, { status: 401 })

  const url = new URL(request.url)
  const shouldRun = url.searchParams.get('run') === '1'
  const supabase = createServiceClient()

  let summary = null
  if (shouldRun) {
    summary = await runBacktrackForVenue(supabase, auth.venueId)
  }

  const items = await listPendingBacktrackReview(supabase, auth.venueId)
  return NextResponse.json({ items, summary })
}

interface PostBody {
  action: 'link' | 'reject' | 'run'
  candidateId?: string
  weddingId?: string
  reason?: string
}

export async function POST(request: NextRequest) {
  // GAP-12: API-layer plan_tier enforcement BEFORE any DB reads.
  const plan = await requirePlan(request, 'pre_opening')
  if (!plan.ok) return NextResponse.json(planErrorBody(plan), { status: plan.status })

  const auth = await getPlatformAuth()
  if (!auth) return NextResponse.json({ error: 'unauthorized' }, { status: 401 })

  let body: PostBody
  try {
    body = (await request.json()) as PostBody
  } catch {
    return NextResponse.json({ error: 'invalid_json' }, { status: 400 })
  }

  const supabase = createServiceClient()

  if (body.action === 'run') {
    const summary = await runBacktrackForVenue(supabase, auth.venueId)
    return NextResponse.json({ ok: true, summary })
  }

  if (body.action === 'link') {
    if (!body.candidateId || !body.weddingId) {
      return NextResponse.json({ error: 'missing candidateId or weddingId' }, { status: 400 })
    }
    const r = await applyBacktrackLink(supabase, {
      venueId: auth.venueId,
      candidateId: body.candidateId,
      weddingId: body.weddingId,
      coordinatorUserId: auth.userId ?? null,
      reason: body.reason ?? null,
    })
    if (!r.ok) return NextResponse.json({ error: r.error }, { status: 400 })
    return NextResponse.json({ ok: true, signalsLinked: r.signalsLinked })
  }

  if (body.action === 'reject') {
    if (!body.candidateId) {
      return NextResponse.json({ error: 'missing candidateId' }, { status: 400 })
    }
    const r = await rejectBacktrackCandidate(supabase, {
      venueId: auth.venueId,
      candidateId: body.candidateId,
    })
    if (!r.ok) return NextResponse.json({ error: r.error }, { status: 400 })
    return NextResponse.json({ ok: true })
  }

  return NextResponse.json({ error: `unknown action: ${body.action}` }, { status: 400 })
}
