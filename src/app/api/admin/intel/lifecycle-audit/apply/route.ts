/**
 * Lifecycle audit - apply a single row.
 *
 * POST { coupleId, newState }
 *   Updates couples.lifecycle_state to the supplied newState. Single-
 *   couple write per request so the operator confirms each row.
 *
 * Auth: platform-auth required. Verifies the couple belongs to the
 * caller's venue before writing.
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

export async function POST(req: NextRequest) {
  const auth = await getPlatformAuth()
  if (!auth) return unauthorized()
  if (!auth.venueId) return badRequest('caller has no resolved venue')

  const body = (await req.json().catch(() => ({}))) as {
    coupleId?: string
    newState?: string
  }
  if (!body.coupleId || typeof body.coupleId !== 'string') {
    return badRequest('coupleId required')
  }
  if (!body.newState || !ALLOWED_STATES.has(body.newState)) {
    return badRequest(
      `newState must be one of ${[...ALLOWED_STATES].join(', ')}`,
    )
  }

  const supabase = createServiceClient()

  // Verify the couple is in the caller's venue.
  const { data: couple, error: lookupErr } = await supabase
    .from('couples')
    .select('id, venue_id, lifecycle_state')
    .eq('id', body.coupleId)
    .maybeSingle()
  if (lookupErr) {
    return NextResponse.json(
      { ok: false, error: lookupErr.message },
      { status: 500 },
    )
  }
  if (!couple) {
    return NextResponse.json(
      { ok: false, error: 'couple not found' },
      { status: 404 },
    )
  }
  if (couple.venue_id !== auth.venueId) {
    return NextResponse.json(
      { ok: false, error: 'couple belongs to a different venue' },
      { status: 403 },
    )
  }

  const oldState = (couple.lifecycle_state as string | null) ?? null

  const { error: updateErr } = await supabase
    .from('couples')
    .update({ lifecycle_state: body.newState })
    .eq('id', body.coupleId)
  if (updateErr) {
    return NextResponse.json(
      { ok: false, error: updateErr.message },
      { status: 500 },
    )
  }

  // Audit log row to couple_merge_events so the change is recoverable.
  try {
    await supabase.from('couple_merge_events').insert({
      venue_id: auth.venueId,
      event_type: 'manual_merge',
      primary_couple_id: body.coupleId,
      secondary_couple_id: null,
      operator_id: auth.userId,
      rule_triggered: 'lifecycle_audit_apply',
      confidence_tier: 'high',
      reason: `lifecycle_state ${oldState ?? '(null)'} -> ${body.newState}`,
    })
  } catch {
    // Audit row is best-effort; do not fail the apply.
  }

  return NextResponse.json({
    ok: true,
    coupleId: body.coupleId,
    oldState,
    newState: body.newState,
  })
}
