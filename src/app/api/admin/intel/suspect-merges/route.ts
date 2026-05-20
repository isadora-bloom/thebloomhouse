/**
 * Suspect merges endpoint - cleanup diagnostic.
 *
 * GET ?venueId=X[&limit=N]
 *   Returns suspect couple_merge_events for the venue: substring-name
 *   merges, legacy Levenshtein-rule merges, low-tier name-only merges.
 *   Operator confirms or rejects via the existing /api/admin/identity/
 *   resolve action='reject' path.
 *
 * Read-only; non-destructive.
 *
 * Auth: same pattern as the other admin/intel endpoints.
 */

import { NextRequest, NextResponse } from 'next/server'
import { createServiceClient } from '@/lib/supabase/service'
import {
  getPlatformAuth,
  unauthorized,
  badRequest,
  notFound,
} from '@/lib/api/auth-helpers'
import { findSuspectMerges } from '@/lib/services/identity/suspect-merges'

export const maxDuration = 60

export async function GET(req: NextRequest) {
  const url = new URL(req.url)
  const venueIdParam = url.searchParams.get('venueId')

  const cronAuth =
    req.headers.get('authorization') === `Bearer ${process.env.CRON_SECRET}`

  let venueId: string | null = null
  if (cronAuth) {
    if (!venueIdParam) {
      return badRequest('CRON_SECRET path requires venueId param')
    }
    venueId = venueIdParam
  } else {
    const auth = await getPlatformAuth()
    if (!auth) return unauthorized()
    if (!auth.venueId) return badRequest('caller has no resolved venue')
    venueId = auth.venueId
  }

  const limitRaw = url.searchParams.get('limit')
  const limit =
    limitRaw && !Number.isNaN(Number(limitRaw))
      ? Math.min(Math.max(Number(limitRaw), 1), 500)
      : 200

  const supabase = createServiceClient()

  const { data: venueRow } = await supabase
    .from('venues')
    .select('id, name')
    .eq('id', venueId)
    .maybeSingle()
  if (!venueRow) return notFound('venue')

  try {
    const suspects = await findSuspectMerges(supabase, venueId, { limit })
    return NextResponse.json({
      ok: true,
      venueName: venueRow.name,
      suspects,
    })
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    console.error('[suspect-merges] error:', message)
    return NextResponse.json({ ok: false, error: message }, { status: 500 })
  }
}
