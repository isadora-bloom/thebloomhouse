/**
 * Identity Report endpoint — Tier 8 §C.5 (Q6/29/30/36).
 *
 * GET ?venueId=X
 *   Returns the full IdentityReport payload: couples summary, merge
 *   confidence distribution, top/bottom merges, 90-day completeness,
 *   borderline pending decisions. No LLM call.
 *
 * Auth: mirrors /api/admin/intel/cohort-funnel + /couple-attribution.
 */

import { NextRequest, NextResponse } from 'next/server'
import { createServiceClient } from '@/lib/supabase/service'
import {
  getPlatformAuth,
  unauthorized,
  badRequest,
  notFound,
} from '@/lib/api/auth-helpers'
import { buildIdentityReport } from '@/lib/services/identity/identity-report'

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

  const supabase = createServiceClient()

  const { data: venueRow } = await supabase
    .from('venues')
    .select('id, name')
    .eq('id', venueId)
    .maybeSingle()
  if (!venueRow) return notFound('venue')

  try {
    const report = await buildIdentityReport(supabase, venueId)
    return NextResponse.json({ ok: true, venueName: venueRow.name, report })
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    console.error('[identity-report] route error:', message)
    return NextResponse.json({ ok: false, error: message }, { status: 500 })
  }
}
