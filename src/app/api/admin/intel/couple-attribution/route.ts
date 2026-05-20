/**
 * D3 — couple-keyed source attribution endpoint (Tier 8 T8.2).
 *
 * GET ?venueId=X[&sinceDays=N]
 *   Returns the full AttributionResult payload: per-channel × per-model
 *   rollup, per-couple ribbons, content-mention conversion lift, and
 *   model explainers for the surface. No LLM call — deterministic
 *   aggregation over the identity-first spine.
 *
 * Auth: mirrors the D9 cohort-funnel endpoint.
 *   - Authorization: Bearer ${CRON_SECRET} → ops path, venueId in query.
 *   - else getPlatformAuth (coordinator UI) — venueId from auth; any
 *     explicit query venueId is ignored.
 */

import { NextRequest, NextResponse } from 'next/server'
import { createServiceClient } from '@/lib/supabase/service'
import {
  getPlatformAuth,
  unauthorized,
  badRequest,
  notFound,
} from '@/lib/api/auth-helpers'
import { buildCoupleAttribution } from '@/lib/services/attribution/couple-attribution'

// Same loader as D9 (paginated spine read) — pad generously.
export const maxDuration = 120

const MAX_SINCE_DAYS = 365 * 6

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

  // Optional occurred_at lower bound — caps the load for huge venues.
  let since: string | null = null
  const sinceDaysRaw = url.searchParams.get('sinceDays')
  if (sinceDaysRaw) {
    const n = Number(sinceDaysRaw)
    if (Number.isFinite(n) && n > 0) {
      const days = Math.min(Math.floor(n), MAX_SINCE_DAYS)
      since = new Date(Date.now() - days * 24 * 3600_000).toISOString()
    }
  }

  const supabase = createServiceClient()

  const { data: venueRow } = await supabase
    .from('venues')
    .select('id, name')
    .eq('id', venueId)
    .maybeSingle()
  if (!venueRow) return notFound('venue')

  try {
    const intel = await buildCoupleAttribution(supabase, venueId, { since })
    return NextResponse.json({ ok: true, venueName: venueRow.name, intel })
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    console.error('[couple-attribution] route error:', message)
    return NextResponse.json({ ok: false, error: message }, { status: 500 })
  }
}
