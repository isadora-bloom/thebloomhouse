import { NextRequest, NextResponse } from 'next/server'
import { createServiceClient } from '@/lib/supabase/service'
import { getPlatformAuth, unauthorized, forbidden } from '@/lib/api/auth-helpers'

/**
 * GET /api/admin/consumer-requests — list consumer-rights requests
 * scoped to the caller's authority (Tier-C #116/#117/#118).
 *
 *   super_admin → all rows
 *   org_admin   → all rows for venues in their org
 *   anyone else → 403
 *
 * Query params:
 *   status=pending|processing|completed|denied|expired (optional, comma-sep)
 *   limit=N (default 50, max 200)
 */
export async function GET(req: NextRequest) {
  const auth = await getPlatformAuth()
  if (!auth) return unauthorized()
  if (auth.role !== 'super_admin' && auth.role !== 'org_admin') {
    return forbidden('admin only')
  }

  const supabase = createServiceClient()
  const url = new URL(req.url)
  const status = url.searchParams.get('status')
  const limit = Math.min(200, Math.max(1, Number(url.searchParams.get('limit') ?? '50')))

  let query = supabase
    .from('consumer_requests')
    .select(
      'id, venue_id, requester_user_id, requester_email, requester_role, request_type, scope, status, resolution_notes, processed_by, processed_at, created_at, expires_at',
    )
    .order('created_at', { ascending: false })
    .limit(limit)

  if (status) {
    const statuses = status.split(',').map((s) => s.trim()).filter(Boolean)
    if (statuses.length > 0) query = query.in('status', statuses)
  }

  // Org-admin scope: filter to venues in their org via service-role
  // join. RLS on consumer_requests would do this too, but we use the
  // service client so the data stays consistent across read paths.
  if (auth.role === 'org_admin') {
    if (!auth.orgId) return NextResponse.json({ data: [] })
    const { data: orgVenues } = await supabase
      .from('venues')
      .select('id')
      .eq('org_id', auth.orgId)
    const venueIds = (orgVenues ?? []).map((v) => (v as { id: string }).id)
    if (venueIds.length === 0) return NextResponse.json({ data: [] })
    query = query.in('venue_id', venueIds)
  }

  const { data, error } = await query
  if (error) return NextResponse.json({ error: error.message }, { status: 500 })
  return NextResponse.json({ data: data ?? [] })
}
