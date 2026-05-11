/**
 * Wave 13 — paged list of review-solicit requests.
 *
 * GET /api/admin/reviews/solicit/list?venueId=X&status=Y&limit=Z&offset=N
 *
 * Auth: dual.
 * Query params:
 *   - venueId  (required when no coordinator auth pins it; optional
 *               otherwise — defaults to the caller's auth venueId)
 *   - status   (optional, one of queued|sent|review_received|declined|no_response)
 *   - limit    (default 50, max 200)
 *   - offset   (default 0)
 */

import { NextRequest, NextResponse } from 'next/server'
import { createServiceClient } from '@/lib/supabase/service'
import {
  getPlatformAuth,
  unauthorized,
  forbidden,
  badRequest,
} from '@/lib/api/auth-helpers'

const VALID_STATUSES = new Set([
  'queued',
  'sent',
  'review_received',
  'declined',
  'no_response',
])

export async function GET(req: NextRequest) {
  const url = new URL(req.url)
  const cronAuth = req.headers.get('authorization') === `Bearer ${process.env.CRON_SECRET}`
  let venueId = url.searchParams.get('venueId')

  if (!cronAuth) {
    const auth = await getPlatformAuth()
    if (!auth) return unauthorized()
    if (auth.isDemo) return forbidden('demo cannot read review solicitations')
    if (!auth.venueId) return badRequest('caller has no resolved venue')
    // Coordinator path: venueId pinned to the auth context.
    if (venueId && venueId !== auth.venueId) {
      return forbidden('venueId does not match your scope')
    }
    venueId = auth.venueId
  }

  if (!venueId) return badRequest('venueId required')

  const status = url.searchParams.get('status') ?? null
  if (status && !VALID_STATUSES.has(status)) {
    return badRequest(`invalid status: ${status}`)
  }

  const rawLimit = Number(url.searchParams.get('limit') ?? '50')
  const limit = Math.min(200, Math.max(1, Number.isFinite(rawLimit) ? rawLimit : 50))
  const rawOffset = Number(url.searchParams.get('offset') ?? '0')
  const offset = Math.max(0, Number.isFinite(rawOffset) ? rawOffset : 0)

  const supabase = createServiceClient()
  let q = supabase
    .from('review_solicit_requests')
    .select(
      'id, wedding_id, venue_id, status, target_channel, review_link_url, subject, draft_id, review_id, generated_at, sent_at, response_received_at, prompt_version, cost_cents',
      { count: 'exact' },
    )
    .eq('venue_id', venueId)
    .order('generated_at', { ascending: false })
    .range(offset, offset + limit - 1)

  if (status) {
    q = q.eq('status', status)
  }

  const { data, count, error } = await q
  if (error) {
    return NextResponse.json(
      { ok: false, error: error.message },
      { status: 500 },
    )
  }

  return NextResponse.json({
    ok: true,
    venueId,
    status: status ?? null,
    limit,
    offset,
    total: count ?? 0,
    rows: data ?? [],
  })
}
