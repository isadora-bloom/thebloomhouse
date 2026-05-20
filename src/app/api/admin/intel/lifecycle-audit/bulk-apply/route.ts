/**
 * Lifecycle audit - bulk apply.
 *
 * POST { coupleIds: string[], newState: string }
 *   Updates couples.lifecycle_state to `newState` for every couple
 *   in the list. Verifies each couple belongs to the caller's venue
 *   before writing; one audit row per couple in couple_merge_events.
 *
 * Bounded: max 500 ids per request so the operator's "Apply all"
 * for a large drift bucket still completes within maxDuration.
 */

import { NextRequest, NextResponse } from 'next/server'
import { createServiceClient } from '@/lib/supabase/service'
import {
  getPlatformAuth,
  unauthorized,
  badRequest,
} from '@/lib/api/auth-helpers'

const ALLOWED_STATES = new Set([
  'channel_scoped',
  'resolved',
  'booked',
  'completed',
  'ghost',
])

export const maxDuration = 120

export async function POST(req: NextRequest) {
  const auth = await getPlatformAuth()
  if (!auth) return unauthorized()
  if (!auth.venueId) return badRequest('caller has no resolved venue')

  const body = (await req.json().catch(() => ({}))) as {
    coupleIds?: string[]
    newState?: string
  }
  if (!Array.isArray(body.coupleIds) || body.coupleIds.length === 0) {
    return badRequest('coupleIds array required')
  }
  if (body.coupleIds.length > 500) {
    return badRequest('max 500 coupleIds per request')
  }
  if (!body.newState || !ALLOWED_STATES.has(body.newState)) {
    return badRequest(
      `newState must be one of ${[...ALLOWED_STATES].join(', ')}`,
    )
  }

  const supabase = createServiceClient()

  // Verify every couple belongs to the caller's venue. Read in one
  // bulk query rather than per-id.
  const { data: couples, error: lookupErr } = await supabase
    .from('couples')
    .select('id, venue_id, lifecycle_state')
    .in('id', body.coupleIds)
  if (lookupErr) {
    return NextResponse.json(
      { ok: false, error: lookupErr.message },
      { status: 500 },
    )
  }
  const eligible = (couples ?? []).filter(
    (c) => (c as { venue_id: string }).venue_id === auth.venueId,
  ) as Array<{ id: string; venue_id: string; lifecycle_state: string | null }>
  if (eligible.length === 0) {
    return NextResponse.json({
      ok: true,
      updated: 0,
      skipped: body.coupleIds.length,
      reason: 'no couples in caller venue',
    })
  }

  const eligibleIds = eligible.map((c) => c.id)
  const { error: updateErr, count } = await supabase
    .from('couples')
    .update({ lifecycle_state: body.newState }, { count: 'exact' })
    .in('id', eligibleIds)
  if (updateErr) {
    return NextResponse.json(
      { ok: false, error: updateErr.message },
      { status: 500 },
    )
  }

  // Audit rows - best-effort. One per couple so the change is
  // recoverable per-row through couple_merge_events.
  try {
    const auditRows = eligible.map((c) => ({
      venue_id: auth.venueId,
      event_type: 'manual_merge',
      primary_couple_id: c.id,
      secondary_couple_id: null,
      operator_id: auth.userId,
      rule_triggered: 'lifecycle_audit_bulk_apply',
      confidence_tier: 'high',
      reason: `lifecycle_state ${c.lifecycle_state ?? '(null)'} -> ${body.newState}`,
    }))
    await supabase.from('couple_merge_events').insert(auditRows)
  } catch {
    // Audit insert is best-effort; do not fail the apply.
  }

  return NextResponse.json({
    ok: true,
    updated: count ?? eligible.length,
    skipped: body.coupleIds.length - eligible.length,
    newState: body.newState,
  })
}
