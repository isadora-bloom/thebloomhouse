/**
 * Wave 19 — list knowledge_captures for a venue.
 *
 * GET /api/admin/knowledge-gaps/captures?venueId=X&active=true|false|all&limit=N&offset=N
 *
 * Returns: { ok: true, captures: KnowledgeCaptureRow[], totalEstimate: number }
 *
 * Auth: getPlatformAuth, venue-scoped.
 */

import { NextRequest, NextResponse } from 'next/server'
import { createServiceClient } from '@/lib/supabase/service'
import {
  getPlatformAuth,
  unauthorized,
  forbidden,
  badRequest,
  assertCanAccessVenue,
} from '@/lib/api/auth-helpers'

export async function GET(req: NextRequest) {
  const auth = await getPlatformAuth()
  if (!auth) return unauthorized()

  const url = new URL(req.url)
  const venueId = url.searchParams.get('venueId') ?? auth.venueId
  if (!venueId) return badRequest('venueId required')

  const access = await assertCanAccessVenue(auth, venueId)
  if (!access.ok) return forbidden(access.reason)

  const activeParam = (url.searchParams.get('active') ?? 'true').toLowerCase()
  const limitRaw = Number.parseInt(url.searchParams.get('limit') ?? '100', 10)
  const offsetRaw = Number.parseInt(url.searchParams.get('offset') ?? '0', 10)
  const limit = Number.isFinite(limitRaw) ? Math.max(1, Math.min(limitRaw, 500)) : 100
  const offset = Number.isFinite(offsetRaw) ? Math.max(0, offsetRaw) : 0

  const supabase = createServiceClient()
  let q = supabase
    .from('knowledge_captures')
    .select(
      'id, venue_id, knowledge_gap_id, question, answer, tags, source_kind, confidence_0_100, applies_until, active, created_at, created_by, updated_at',
      { count: 'exact' },
    )
    .eq('venue_id', venueId)

  if (activeParam === 'true') q = q.eq('active', true)
  else if (activeParam === 'false') q = q.eq('active', false)
  // activeParam === 'all' → no filter

  q = q
    .order('updated_at', { ascending: false })
    .range(offset, offset + limit - 1)

  const { data, error, count } = await q
  if (error) {
    return NextResponse.json({ ok: false, error: error.message }, { status: 500 })
  }
  return NextResponse.json({
    ok: true,
    captures: data ?? [],
    totalEstimate: count ?? null,
    limit,
    offset,
  })
}
