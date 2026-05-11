/**
 * Wave 19 — list knowledge_gaps for a venue.
 *
 * GET /api/admin/knowledge-gaps/list?venueId=X&status=open|captured|dismissed&limit=N&offset=N
 *
 * status:
 *   - 'open'      → gap is unanswered, undismissed (default)
 *   - 'captured'  → captured_at IS NOT NULL
 *   - 'dismissed' → dismissed_at IS NOT NULL
 *   - 'all'       → no filter
 *
 * Returns: { ok: true, gaps: KnowledgeGapRow[], totalEstimate: number }
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

const ALLOWED_STATUS = new Set(['open', 'captured', 'dismissed', 'all'])

export async function GET(req: NextRequest) {
  const auth = await getPlatformAuth()
  if (!auth) return unauthorized()

  const url = new URL(req.url)
  const venueId = url.searchParams.get('venueId') ?? auth.venueId
  if (!venueId) return badRequest('venueId required')

  const access = await assertCanAccessVenue(auth, venueId)
  if (!access.ok) return forbidden(access.reason)

  const status = (url.searchParams.get('status') ?? 'open').toLowerCase()
  if (!ALLOWED_STATUS.has(status)) {
    return badRequest(`status must be one of: ${Array.from(ALLOWED_STATUS).join(', ')}`)
  }

  const limitRaw = Number.parseInt(url.searchParams.get('limit') ?? '100', 10)
  const offsetRaw = Number.parseInt(url.searchParams.get('offset') ?? '0', 10)
  const limit = Number.isFinite(limitRaw) ? Math.max(1, Math.min(limitRaw, 500)) : 100
  const offset = Number.isFinite(offsetRaw) ? Math.max(0, offsetRaw) : 0

  const supabase = createServiceClient()
  let q = supabase
    .from('knowledge_gaps')
    .select(
      'id, venue_id, question, category, frequency, status, resolution, resolved_at, created_at, captured_at, captured_id, dismissed_at, dismissed_reason',
      { count: 'exact' },
    )
    .eq('venue_id', venueId)

  if (status === 'open') {
    q = q
      .eq('status', 'open')
      .is('captured_at', null)
      .is('dismissed_at', null)
  } else if (status === 'captured') {
    q = q.not('captured_at', 'is', null)
  } else if (status === 'dismissed') {
    q = q.not('dismissed_at', 'is', null)
  }

  q = q
    .order('frequency', { ascending: false })
    .order('created_at', { ascending: false })
    .range(offset, offset + limit - 1)

  const { data, error, count } = await q
  if (error) {
    return NextResponse.json({ ok: false, error: error.message }, { status: 500 })
  }

  return NextResponse.json({
    ok: true,
    gaps: data ?? [],
    totalEstimate: count ?? null,
    limit,
    offset,
  })
}
