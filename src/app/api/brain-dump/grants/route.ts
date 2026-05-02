/**
 * /api/brain-dump/grants — list + revoke graduated brain-dump
 * pattern grants (T4-E).
 *
 * GET    — list active grants for the caller's venue
 * DELETE — revoke a grant by id (?id=<uuid>)
 */

import { NextRequest, NextResponse } from 'next/server'
import { createServiceClient } from '@/lib/supabase/service'
import { getPlatformAuth } from '@/lib/api/auth-helpers'
import { revokePatternGrant, grantPattern } from '@/lib/services/brain-dump-graduation'

export async function GET() {
  const auth = await getPlatformAuth()
  if (!auth) return NextResponse.json({ error: 'unauthorized' }, { status: 401 })

  const supabase = createServiceClient()
  const { data, error } = await supabase
    .from('brain_dump_pattern_grants')
    .select('id, pattern_signature, description, intent, routed_table, routed_action, granted_at, granted_by, hit_count, last_used_at, revoked_at')
    .eq('venue_id', auth.venueId)
    .order('granted_at', { ascending: false })
  if (error) return NextResponse.json({ error: error.message }, { status: 500 })
  return NextResponse.json({ grants: data ?? [] })
}

export async function DELETE(request: NextRequest) {
  const auth = await getPlatformAuth()
  if (!auth) return NextResponse.json({ error: 'unauthorized' }, { status: 401 })

  const id = request.nextUrl.searchParams.get('id')
  if (!id || !/^[0-9a-f-]{36}$/i.test(id)) {
    return NextResponse.json({ error: 'invalid_id' }, { status: 400 })
  }

  const supabase = createServiceClient()
  // Ownership check: grant must belong to caller's venue.
  const { data: existing } = await supabase
    .from('brain_dump_pattern_grants')
    .select('venue_id')
    .eq('id', id)
    .maybeSingle()
  if (!existing) return NextResponse.json({ error: 'grant_not_found' }, { status: 404 })
  if (existing.venue_id !== auth.venueId) {
    return NextResponse.json({ error: 'forbidden' }, { status: 403 })
  }

  const result = await revokePatternGrant(supabase, { grantId: id, revokedBy: auth.userId })
  if (!result.ok) return NextResponse.json({ error: result.error }, { status: 500 })
  return NextResponse.json({ ok: true })
}

/**
 * POST — coordinator accepts a graduation offer. Body must carry the
 * signature + intent + a one-line description. Idempotent on
 * (venue_id, signature) where revoked_at IS NULL.
 */
export async function POST(request: NextRequest) {
  const auth = await getPlatformAuth()
  if (!auth) return NextResponse.json({ error: 'unauthorized' }, { status: 401 })

  let body: { signature?: string; intent?: string; description?: string; routedTable?: string; routedAction?: string }
  try {
    body = await request.json()
  } catch {
    return NextResponse.json({ error: 'invalid_json' }, { status: 400 })
  }
  if (!body.signature || !/^[0-9a-f]{8}$/i.test(body.signature)) {
    return NextResponse.json({ error: 'invalid_signature' }, { status: 400 })
  }
  if (!body.intent || body.intent.trim().length === 0) {
    return NextResponse.json({ error: 'intent_required' }, { status: 400 })
  }
  if (!body.description || body.description.trim().length < 4) {
    return NextResponse.json({ error: 'description_required' }, { status: 400 })
  }

  const supabase = createServiceClient()
  const result = await grantPattern(supabase, {
    venueId: auth.venueId,
    signature: body.signature,
    description: body.description.trim(),
    intent: body.intent.trim(),
    routedTable: body.routedTable ?? null,
    routedAction: body.routedAction ?? null,
    grantedBy: auth.userId,
  })
  if (!result.ok) return NextResponse.json({ error: result.error }, { status: 500 })
  return NextResponse.json({ ok: true, id: result.id })
}
