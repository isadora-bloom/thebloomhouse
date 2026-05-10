/**
 * Wave 5D — cross-venue overlap endpoint.
 *
 * Anchor docs:
 *   - bloom-constitution.md (Wave 5D — at Wedgewood scale, cross-venue
 *     cohort overlap detection enables learning across boundaries
 *     without leaking specifics)
 *   - bloom-wave4-5-6-master-plan.md (Wave 5D spec)
 *   - bloom-data-integrity-sweep.md (aggregate ≠ disclose)
 *
 * GET ?venueId=X
 *   Returns the stored cross_venue_overlap rows for this anchor, sorted
 *   by confidence desc. No computation. RLS scopes to anchor=this venue
 *   so the venue NEVER sees rows where it is the peer being compared
 *   into another anchor's view.
 *
 * POST { anchorVenueId? }
 *   Recomputes overlap for the anchor venue against every peer with a
 *   populated venue_thesis. AGGREGATE-ONLY comparison — peer's couple-
 *   level rows are never read.
 */

import { NextRequest, NextResponse } from 'next/server'
import {
  getPlatformAuth,
  unauthorized,
  forbidden,
  badRequest,
  notFound,
} from '@/lib/api/auth-helpers'
import { createServiceClient } from '@/lib/supabase/service'
import {
  computeCrossVenueOverlap,
  listStoredOverlaps,
} from '@/lib/services/intel/onboarding/cross-venue-overlap'

// Bounded — comparison is in-process intersection logic over already-
// stored aggregates. No LLM. 60s is plenty.
export const maxDuration = 60

interface PostBody {
  anchorVenueId?: string
}

interface AuthContext {
  isCron: boolean
  anchorVenueId: string
}

async function resolveAuth(
  req: NextRequest,
  body: PostBody,
): Promise<{ ctx: AuthContext } | NextResponse> {
  const cronAuth =
    req.headers.get('authorization') === `Bearer ${process.env.CRON_SECRET}`
  if (cronAuth) {
    if (!body.anchorVenueId || typeof body.anchorVenueId !== 'string') {
      return badRequest('CRON_SECRET path requires anchorVenueId in body')
    }
    return { ctx: { isCron: true, anchorVenueId: body.anchorVenueId } }
  }

  const auth = await getPlatformAuth()
  if (!auth) return unauthorized()
  if (auth.isDemo) return forbidden('demo cannot run cross-venue overlap')
  if (!auth.venueId) return badRequest('caller has no resolved venue')
  return { ctx: { isCron: false, anchorVenueId: auth.venueId } }
}

export async function POST(req: NextRequest) {
  let body: PostBody = {}
  try {
    body = (await req.json()) as PostBody
  } catch {
    body = {}
  }

  const authResolved = await resolveAuth(req, body)
  if (authResolved instanceof NextResponse) return authResolved
  const { anchorVenueId } = authResolved.ctx

  const supabase = createServiceClient()
  const { data: venueRow } = await supabase
    .from('venues')
    .select('id, name')
    .eq('id', anchorVenueId)
    .maybeSingle()
  if (!venueRow) return notFound('venue')

  try {
    const result = await computeCrossVenueOverlap(
      { anchorVenueId },
      { supabase },
    )
    return NextResponse.json({
      ok: true,
      anchorVenueId,
      peersConsidered: result.peersConsidered,
      stored: result.stored,
      overlaps: result.overlaps,
    })
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    console.error('[cross-venue-overlap] route error:', message)
    return NextResponse.json({ ok: false, error: message }, { status: 500 })
  }
}

export async function GET(req: NextRequest) {
  const url = new URL(req.url)
  const venueIdParam = url.searchParams.get('venueId')

  const cronAuth =
    req.headers.get('authorization') === `Bearer ${process.env.CRON_SECRET}`
  let anchorVenueId: string | null = null
  if (cronAuth) {
    if (!venueIdParam) return badRequest('CRON_SECRET path requires venueId param')
    anchorVenueId = venueIdParam
  } else {
    const auth = await getPlatformAuth()
    if (!auth) return unauthorized()
    if (!auth.venueId) return badRequest('caller has no resolved venue')
    anchorVenueId = auth.venueId
  }

  const overlaps = await listStoredOverlaps(anchorVenueId)
  return NextResponse.json({
    ok: true,
    anchorVenueId,
    overlaps,
  })
}
