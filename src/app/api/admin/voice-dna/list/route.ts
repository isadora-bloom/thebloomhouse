/**
 * Wave 20 — voice-DNA history listing.
 *
 * GET /api/admin/voice-dna/list?venueId=X&limit=20&offset=0
 *
 * Auth: getPlatformAuth (coordinator UI). venueId from auth or
 * super_admin override via ?venueId. assertCanAccessVenue clears.
 */

import { NextRequest, NextResponse } from 'next/server'
import { createServiceClient } from '@/lib/supabase/service'
import {
  getPlatformAuth,
  assertCanAccessVenue,
  unauthorized,
  forbidden,
  badRequest,
} from '@/lib/api/auth-helpers'

const DEFAULT_LIMIT = 20
const MAX_LIMIT = 100

export async function GET(req: NextRequest) {
  const auth = await getPlatformAuth()
  if (!auth) return unauthorized()

  const url = new URL(req.url)
  const queryVenueId = url.searchParams.get('venueId') ?? undefined
  const candidate = queryVenueId && queryVenueId.length > 0 ? queryVenueId : auth.venueId
  if (!candidate) return badRequest('caller has no resolved venue')
  const access = await assertCanAccessVenue(auth, candidate)
  if (!access.ok) return forbidden(access.reason)

  const limitRaw = Number(url.searchParams.get('limit') ?? DEFAULT_LIMIT)
  const offsetRaw = Number(url.searchParams.get('offset') ?? 0)
  const limit = Number.isFinite(limitRaw) && limitRaw > 0
    ? Math.min(Math.floor(limitRaw), MAX_LIMIT)
    : DEFAULT_LIMIT
  const offset = Number.isFinite(offsetRaw) && offsetRaw >= 0
    ? Math.floor(offsetRaw)
    : 0

  const sb = createServiceClient()
  const { data, error, count } = await sb
    .from('voice_dna_derivations')
    .select(
      'id, derived_at, source_summary, derived_banned_phrases, '
      + 'derived_approved_phrases, derived_tone_descriptors, '
      + 'derived_voice_principles, cost_cents, prompt_version, '
      + 'applied, applied_fields, applied_at, dismissed, dismissed_at, '
      + 'dismiss_reason',
      { count: 'exact' },
    )
    .eq('venue_id', candidate)
    .order('derived_at', { ascending: false })
    .range(offset, offset + limit - 1)

  if (error) {
    return NextResponse.json(
      { ok: false, error: error.message },
      { status: 500 },
    )
  }

  return NextResponse.json({
    ok: true,
    venueId: candidate,
    derivations: data ?? [],
    total: count ?? 0,
    limit,
    offset,
  })
}
