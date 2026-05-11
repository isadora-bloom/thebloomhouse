/**
 * Wave 12 — couple timeline summary endpoint.
 *
 * GET /api/admin/timeline/wedding/[weddingId]/summary
 *
 * Returns just counts by kind (for the header chip row). Same auth as
 * the parent endpoint; rebuilds the timeline server-side and returns
 * the countsByKind histogram plus the wedding scope snapshot.
 *
 * Anchor: src/lib/services/timeline/build-timeline.ts (Wave 12).
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
import { buildCoupleTimeline } from '@/lib/services/timeline/build-timeline'

export const maxDuration = 30

interface RouteCtx {
  params: Promise<{ weddingId: string }>
}

async function resolveAuth(
  req: NextRequest,
  weddingId: string,
): Promise<NextResponse | { venueId: string }> {
  const cronAuth =
    req.headers.get('authorization') === `Bearer ${process.env.CRON_SECRET}`
  if (cronAuth) {
    const supabase = createServiceClient()
    const { data: wedding } = await supabase
      .from('weddings')
      .select('venue_id, merged_into_id')
      .eq('id', weddingId)
      .maybeSingle()
    if (!wedding) return notFound('wedding')
    const w = wedding as { venue_id: string; merged_into_id: string | null }
    if (w.merged_into_id) {
      return badRequest('wedding is tombstoned (merged_into_id set)')
    }
    return { venueId: w.venue_id }
  }

  const auth = await getPlatformAuth()
  if (!auth) return unauthorized()
  if (!auth.venueId) return badRequest('caller has no resolved venue')

  const supabase = createServiceClient()
  const { data: wedding } = await supabase
    .from('weddings')
    .select('venue_id, merged_into_id')
    .eq('id', weddingId)
    .maybeSingle()
  if (!wedding) return notFound('wedding')
  const w = wedding as { venue_id: string; merged_into_id: string | null }
  if (auth.role !== 'super_admin' && w.venue_id !== auth.venueId) {
    return forbidden('wedding does not belong to your venue')
  }
  if (w.merged_into_id) {
    return badRequest('wedding is tombstoned (merged_into_id set)')
  }
  return { venueId: w.venue_id }
}

export async function GET(req: NextRequest, ctx: RouteCtx) {
  const { weddingId } = await ctx.params
  if (!weddingId) return badRequest('weddingId required')

  const authResolved = await resolveAuth(req, weddingId)
  if (authResolved instanceof NextResponse) return authResolved

  const supabase = createServiceClient()
  try {
    const result = await buildCoupleTimeline({ weddingId, supabase })
    return NextResponse.json({
      ok: true,
      weddingId,
      scope: result.scope,
      countsByKind: result.countsByKind,
      totalEvents: result.totalEvents,
      truncated: result.truncated,
    })
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    console.error('[timeline summary] failed:', msg)
    return NextResponse.json({ ok: false, error: msg }, { status: 500 })
  }
}
