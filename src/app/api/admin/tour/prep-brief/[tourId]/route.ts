/**
 * Wave 13 — read stored tour-prep brief for one tour.
 *
 * GET /api/admin/tour/prep-brief/[tourId]
 *
 * Returns the stored brief or 404. No LLM call.
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
import { getStoredTourPrepBrief } from '@/lib/services/tour/prep-brief'

interface Params {
  params: Promise<{ tourId: string }>
}

export async function GET(req: NextRequest, ctx: Params) {
  const { tourId } = await ctx.params
  if (!tourId) return badRequest('tourId required')

  const cronAuth = req.headers.get('authorization') === `Bearer ${process.env.CRON_SECRET}`
  if (!cronAuth) {
    const auth = await getPlatformAuth()
    if (!auth) return unauthorized()
    if (auth.isDemo) return forbidden('demo cannot read tour prep brief')
    if (!auth.venueId) return badRequest('caller has no resolved venue')
    // Venue ownership check
    const supabase = createServiceClient()
    const { data: tour } = await supabase
      .from('tours')
      .select('venue_id')
      .eq('id', tourId)
      .maybeSingle()
    if (!tour) return notFound('tour')
    if ((tour as { venue_id: string }).venue_id !== auth.venueId) {
      return forbidden('tour does not belong to your venue')
    }
  }

  const stored = await getStoredTourPrepBrief(tourId)
  if (!stored) return notFound('tour_prep_brief')

  return NextResponse.json({
    ok: true,
    tourId: stored.tourId,
    venueId: stored.venueId,
    weddingId: stored.weddingId,
    brief: stored.brief,
    promptVersion: stored.promptVersion,
    generatedAt: stored.generatedAt,
    sentToCoordinatorAt: stored.sentToCoordinatorAt,
    viewedAt: stored.viewedAt,
    cumulativeCostCents: stored.costCents,
  })
}
