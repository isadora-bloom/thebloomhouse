import { NextRequest, NextResponse } from 'next/server'
import { refuseDemo, getPlatformAuth } from '@/lib/api/auth-helpers'
import { createServiceClient } from '@/lib/supabase/service'
import { requirePlan, planErrorBody } from '@/lib/auth/require-plan'
import {
  acceptComputedSource,
  loadAttributionEvent,
  revertAttributionEvent,
  venueOrgId,
  type ConflictAction,
} from '@/lib/services/attribution/conflict-resolution'

/**
 * Attribution conflict-resolution endpoint (Phase B / PB.12 fixes #2 + #3).
 *
 *   POST /api/intel/attribution
 *     { action: 'revert',          attribution_event_id }
 *     { action: 'accept_legacy',   attribution_event_id }
 *     { action: 'accept_computed', attribution_event_id }
 *
 * This is a repair surface over the pre-spine `attribution_events`
 * ledger, not a reader. No figure on any page comes from it: channel
 * truth is derived from the couple ribbon by `getSourceAttribution`, and
 * the conflict queue this settles empties as the reimport lands.
 *
 * W64 moved the three write sequences into
 * `src/lib/services/attribution/conflict-resolution.ts`, where the
 * legacy-ledger code belongs and can be read in one piece. What stayed
 * here is what a route is for: plan gate, auth, tenancy, and dispatch.
 *
 * Tenancy: coordinators are venue-scoped; org and super admins may fix a
 * conflict on any venue inside their own org, which is checked against
 * the row's venue rather than assumed. Mirrors /api/agent/post-tour-brief.
 */

interface PostBody {
  action?: ConflictAction
  attribution_event_id?: string
}

export async function POST(req: NextRequest) {
  // GAP-12: API-layer plan_tier enforcement BEFORE any DB reads.
  const plan = await requirePlan(req, 'pre_opening')
  if (!plan.ok) return NextResponse.json(planErrorBody(plan), { status: plan.status })

  const auth = await getPlatformAuth()
  if (!auth) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  // The demo identity is an anonymous visitor. It may look; it may not write.
  const demoRefusal = refuseDemo(auth)
  if (demoRefusal) return demoRefusal

  let body: PostBody
  try {
    body = (await req.json()) as PostBody
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 })
  }
  if (!body.attribution_event_id) {
    return NextResponse.json({ error: 'attribution_event_id required' }, { status: 400 })
  }

  const supabase = createServiceClient()

  const row = await loadAttributionEvent(supabase, body.attribution_event_id)
  if (!row) {
    return NextResponse.json({ error: 'attribution_event not found' }, { status: 404 })
  }

  const isAdmin = auth.role === 'org_admin' || auth.role === 'super_admin'
  if (!isAdmin && row.venue_id !== auth.venueId) {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
  }
  if (isAdmin && auth.orgId) {
    if ((await venueOrgId(supabase, row.venue_id)) !== auth.orgId) {
      return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
    }
  }

  if (body.action === 'revert' || body.action === 'accept_legacy') {
    const result = await revertAttributionEvent(supabase, row, {
      acceptLegacy: body.action === 'accept_legacy',
      userId: auth.userId ?? null,
    })
    if (!result.ok) return NextResponse.json({ error: result.error }, { status: result.status })
    return NextResponse.json({ ok: true })
  }

  if (body.action === 'accept_computed') {
    const result = await acceptComputedSource(supabase, row)
    if (!result.ok) return NextResponse.json({ error: result.error }, { status: result.status })
    return NextResponse.json({ ok: true, new_source: result.newSource })
  }

  return NextResponse.json({ error: 'unknown action' }, { status: 400 })
}
