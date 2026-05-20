/**
 * Lifecycle audit endpoint - Tier 8 cleanup.
 *
 * GET ?venueId=X
 *   Returns the lifecycle drift list + duplicate-couple groups for the
 *   venue. Read-only diagnostic; no writes.
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
import { runLifecycleAudit } from '@/lib/services/identity/lifecycle-audit'

export const maxDuration = 120

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
    const report = await runLifecycleAudit(supabase, venueId)
    return NextResponse.json({ ok: true, venueName: venueRow.name, report })
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    console.error('[lifecycle-audit] error:', message)
    return NextResponse.json({ ok: false, error: message }, { status: 500 })
  }
}
