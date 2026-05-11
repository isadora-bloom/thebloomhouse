/**
 * Wave 15 — list evidence overrides for a wedding.
 *
 * GET /api/admin/identity/evidence/list?weddingId=...&active=true|false|all
 *
 * Returns: { ok: true, overrides: EvidenceOverrideRow[] }
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
  notFound,
} from '@/lib/api/auth-helpers'

export async function GET(req: NextRequest) {
  const auth = await getPlatformAuth()
  if (!auth) return unauthorized()
  if (!auth.venueId) return badRequest('caller has no resolved venue')

  const url = new URL(req.url)
  const weddingId = url.searchParams.get('weddingId')
  const activeParam = url.searchParams.get('active') ?? 'true'

  if (!weddingId) return badRequest('weddingId query param required')

  const supabase = createServiceClient()

  // Verify wedding belongs to the caller's venue.
  const { data: wedding } = await supabase
    .from('weddings')
    .select('venue_id')
    .eq('id', weddingId)
    .maybeSingle()
  if (!wedding) return notFound('wedding')
  if ((wedding as { venue_id: string }).venue_id !== auth.venueId) {
    return forbidden('wedding does not belong to your venue')
  }

  let q = supabase
    .from('evidence_overrides')
    .select(
      'id, evidence_kind, evidence_ref, override_action, correction_value, reason, created_at, updated_at, created_by, active',
    )
    .eq('wedding_id', weddingId)
    .order('created_at', { ascending: false })
    .limit(200)

  if (activeParam === 'true') q = q.eq('active', true)
  else if (activeParam === 'false') q = q.eq('active', false)
  // activeParam === 'all' → no filter

  const { data, error } = await q
  if (error) {
    return NextResponse.json(
      { ok: false, error: error.message },
      { status: 500 },
    )
  }
  return NextResponse.json({ ok: true, overrides: data ?? [] })
}
