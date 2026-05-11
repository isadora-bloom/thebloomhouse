/**
 * Wave 9 — GET /api/admin/integrity/remediations
 *
 * Paged history of remediation runs for the admin page.
 *
 * Query params:
 *   venueId      defaults to caller's venue
 *   invariantId  optional filter
 *   limit        default 50, capped 200
 *
 * Returns rows from public.integrity_remediations newest-first.
 */

import { NextRequest, NextResponse } from 'next/server'
import {
  getPlatformAuth,
  unauthorized,
  forbidden,
  badRequest,
} from '@/lib/api/auth-helpers'
import { createServiceClient } from '@/lib/supabase/service'
import { isSupportedInvariantId } from '@/lib/services/data-integrity/remediation'

export async function GET(req: NextRequest) {
  const url = new URL(req.url)
  const requestedVenueId = url.searchParams.get('venueId')
  const invariantId = url.searchParams.get('invariantId')
  const limitParam = url.searchParams.get('limit')
  const limit = Math.min(200, Math.max(1, Number.parseInt(limitParam ?? '50', 10) || 50))

  const cronAuth = req.headers.get('authorization') === `Bearer ${process.env.CRON_SECRET}`
  let venueId: string | null = null
  if (cronAuth) {
    if (!requestedVenueId) return badRequest('CRON_SECRET path requires venueId')
    venueId = requestedVenueId
  } else {
    const auth = await getPlatformAuth()
    if (!auth) return unauthorized()
    if (auth.isDemo) return forbidden('demo cannot read integrity remediations')
    if (!auth.venueId) return badRequest('caller has no resolved venue')
    venueId = requestedVenueId ?? auth.venueId
    if (venueId !== auth.venueId) {
      return forbidden('cannot read remediations for a venue you do not own')
    }
  }

  if (invariantId && !isSupportedInvariantId(invariantId)) {
    return badRequest(`Unsupported invariantId: ${invariantId}`)
  }

  const sb = createServiceClient()
  let query = sb
    .from('integrity_remediations')
    .select(
      'id, venue_id, invariant_id, mode, violations_detected, violations_fixed, ' +
        'violations_skipped, skip_reasons, fix_strategy, sample_before, sample_after, ' +
        'started_at, completed_at, operator_id, errors',
    )
    .eq('venue_id', venueId)
    .order('started_at', { ascending: false })
    .limit(limit)
  if (invariantId) {
    query = query.eq('invariant_id', invariantId)
  }
  const { data, error } = await query
  if (error) {
    return NextResponse.json({ ok: false, error: error.message }, { status: 500 })
  }

  return NextResponse.json({
    ok: true,
    venueId,
    invariantId: invariantId ?? '*',
    rows: data ?? [],
  })
}
