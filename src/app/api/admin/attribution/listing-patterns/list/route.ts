/**
 * Wave 23 — Operator pattern-curation endpoint (list).
 *
 * GET ?platform=X[&includeDisabled=true]
 *
 * Returns the current patterns for one platform — venue-scoped rows
 * for the caller's venue PLUS globals (venue_id IS NULL). Mirrors the
 * detector's load semantics so what the coordinator sees here is
 * exactly what the detector will evaluate against.
 *
 * Auth:
 *   - Authorization: Bearer ${CRON_SECRET} → ops path; venueId in
 *     query required.
 *   - else getPlatformAuth (coordinator UI). venueId taken from auth.
 *
 * Anchor docs:
 *   - listing-platform-detector.ts (consumer — same load shape)
 */

import { NextRequest, NextResponse } from 'next/server'
import { createServiceClient } from '@/lib/supabase/service'
import {
  getPlatformAuth,
  unauthorized,
  forbidden,
  badRequest,
} from '@/lib/api/auth-helpers'

export const maxDuration = 30

const PLATFORM_VALUES = [
  'the_knot',
  'weddingwire',
  'hctg',
  'brides_com',
  'zola',
  'junebug',
  'carats_cake',
  'style_me_pretty',
  'other',
] as const

interface AuthCtx {
  isCron: boolean
  venueId: string
}

async function resolveAuth(
  req: NextRequest,
  requestedVenueId: string | null,
): Promise<{ ctx: AuthCtx } | NextResponse> {
  const cronAuth = req.headers.get('authorization') === `Bearer ${process.env.CRON_SECRET}`
  if (cronAuth) {
    if (!requestedVenueId) {
      return badRequest('CRON_SECRET path requires venueId query param')
    }
    return { ctx: { isCron: true, venueId: requestedVenueId } }
  }
  const auth = await getPlatformAuth()
  if (!auth) return unauthorized()
  if (auth.isDemo) {
    if (!auth.venueId) return badRequest('demo session has no venue')
    return { ctx: { isCron: false, venueId: auth.venueId } }
  }
  if (!auth.venueId) return badRequest('caller has no resolved venue')
  if (requestedVenueId && requestedVenueId !== auth.venueId) {
    return forbidden('venue does not belong to caller')
  }
  return { ctx: { isCron: false, venueId: auth.venueId } }
}

export async function GET(req: NextRequest) {
  const url = new URL(req.url)
  const platform = url.searchParams.get('platform')
  const requestedVenueId = url.searchParams.get('venueId')
  const includeDisabled = url.searchParams.get('includeDisabled') === 'true'

  if (!platform) return badRequest('platform query param required')
  if (!(PLATFORM_VALUES as readonly string[]).includes(platform)) {
    return badRequest(`platform must be one of: ${PLATFORM_VALUES.join(', ')}`)
  }

  const authResolved = await resolveAuth(req, requestedVenueId)
  if (authResolved instanceof NextResponse) return authResolved
  const { venueId } = authResolved.ctx

  const sb = createServiceClient()

  let query = sb
    .from('listing_platform_patterns')
    .select('id, venue_id, platform, platform_canonical, pattern_type, pattern_value, weight, source, enabled, created_at')
    .eq('platform', platform)
    .or(`venue_id.is.null,venue_id.eq.${venueId}`)
    .order('weight', { ascending: false })

  if (!includeDisabled) {
    query = query.eq('enabled', true)
  }

  const { data, error } = await query
  if (error) {
    return NextResponse.json(
      { ok: false, error: `query failed: ${error.message}` },
      { status: 500 },
    )
  }

  const patterns = data ?? []
  // Split for the UI: globals (venue_id NULL) live above venue-scoped
  // patterns in the typical coordinator workflow.
  const globals = patterns.filter((p) => p.venue_id === null)
  const venueScoped = patterns.filter((p) => p.venue_id !== null)

  return NextResponse.json({
    ok: true,
    platform,
    venueId,
    totalCount: patterns.length,
    globals,
    venueScoped,
  })
}
