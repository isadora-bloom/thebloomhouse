/**
 * D9 — couple-keyed cohort funnel + timing endpoint (Tier 8 T8.2).
 *
 * GET ?venueId=X[&sinceDays=N]
 *   Returns the full CohortIntel payload: funnel ratios, response-time
 *   distributions, lead time, the conversion curve, text-pattern
 *   trends, YoY volume, weather effects, anomalies. No LLM call — this
 *   is a deterministic aggregation over the identity-first spine, so
 *   there is nothing to cache and nothing to spend.
 *
 * Auth (mirrors /api/admin/intel/cohort-rollup):
 *   - Authorization: Bearer ${CRON_SECRET} → ops path, venueId in query.
 *   - else getPlatformAuth (coordinator UI) — venueId comes from auth;
 *     any explicit query venueId is ignored.
 */

import { NextRequest, NextResponse } from 'next/server'
import { createServiceClient } from '@/lib/supabase/service'
import {
  getPlatformAuth,
  unauthorized,
  badRequest,
  notFound,
} from '@/lib/api/auth-helpers'
import { buildCohortIntel } from '@/lib/services/cohort'

// Deterministic aggregation over a few thousand spine rows — fast, but
// the loader makes several paginated round trips. Pad generously.
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
    // Coordinator path: ignore any explicit venueId, use the auth one.
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
    const intel = await buildCohortIntel(supabase, venueId, { since })
    return NextResponse.json({ ok: true, venueName: venueRow.name, intel })
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    console.error('[cohort-funnel] route error:', message)
    return NextResponse.json({ ok: false, error: message }, { status: 500 })
  }
}
