/**
 * GET /api/admin/mint-wedding-stats
 *
 * Soak dashboard for the mintWedding chokepoint. Reads
 * mint_wedding_telemetry (mig 320) and returns aggregates over the last
 * 24h / 7d / 30d windows so the operator can watch:
 *
 *   - Total mints per window.
 *   - Distribution across source (which entry paths are exercising the
 *     chokepoint?).
 *   - Distribution across resolved_via (is the match chain firing,
 *     or are we creating fresh rows for couples who already exist?).
 *   - Error rate.
 *   - p50 / p95 latency in ms.
 *
 * Use this to decide when it's safe to migrate email/pipeline.ts (the
 * deferred hot-path direct INSERT) onto mintWedding. Healthy soak signal:
 *   - Volume > 50 successful mints across the 7 already-migrated sites.
 *   - Error rate < 1%.
 *   - p95 latency stable (no upward drift over the window).
 *   - resolved_via distribution roughly matches expected (most via
 *     email_exact / phone, some created_new for fresh leads).
 *
 * Auth: getPlatformAuth() — operator-only. Returns 401 otherwise.
 *
 * Query params:
 *   ?venue=<uuid>   scope to one venue. Default: all venues the caller
 *                   has access to (or all if super_admin / demo).
 */

import { NextRequest, NextResponse } from 'next/server'
import { getPlatformAuth } from '@/lib/api/auth-helpers'
import { createServiceClient } from '@/lib/supabase/service'

interface WindowStats {
  total: number
  errors: number
  error_rate: number
  by_source: Record<string, number>
  by_resolved_via: Record<string, number>
  new_weddings: number
  attached_to_existing: number
  latency_p50_ms: number | null
  latency_p95_ms: number | null
}

interface RecentError {
  id: string
  source: string
  reason: string | null
  error_message: string | null
  created_at: string
  venue_id: string | null
}

function percentile(sorted: number[], p: number): number | null {
  if (sorted.length === 0) return null
  const idx = Math.min(sorted.length - 1, Math.floor(sorted.length * p))
  return sorted[idx]
}

async function loadWindow(
  supabase: ReturnType<typeof createServiceClient>,
  venueId: string | null,
  sinceIso: string,
): Promise<WindowStats> {
  let query = supabase
    .from('mint_wedding_telemetry')
    .select('source, resolved_via, errored, is_new_wedding, latency_ms')
    .gte('created_at', sinceIso)
    .limit(50000)

  if (venueId) query = query.eq('venue_id', venueId)

  const { data } = await query
  const rows = (data ?? []) as Array<{
    source: string
    resolved_via: string | null
    errored: boolean
    is_new_wedding: boolean | null
    latency_ms: number | null
  }>

  const total = rows.length
  const errors = rows.filter((r) => r.errored).length
  const bySource: Record<string, number> = {}
  const byResolvedVia: Record<string, number> = {}
  let newWeddings = 0
  let attached = 0
  const latencies: number[] = []

  for (const r of rows) {
    bySource[r.source] = (bySource[r.source] ?? 0) + 1
    if (r.resolved_via) {
      byResolvedVia[r.resolved_via] = (byResolvedVia[r.resolved_via] ?? 0) + 1
    }
    if (r.is_new_wedding === true) newWeddings++
    else if (r.is_new_wedding === false) attached++
    if (typeof r.latency_ms === 'number' && r.latency_ms >= 0) {
      latencies.push(r.latency_ms)
    }
  }

  latencies.sort((a, b) => a - b)

  return {
    total,
    errors,
    error_rate: total > 0 ? errors / total : 0,
    by_source: bySource,
    by_resolved_via: byResolvedVia,
    new_weddings: newWeddings,
    attached_to_existing: attached,
    latency_p50_ms: percentile(latencies, 0.5),
    latency_p95_ms: percentile(latencies, 0.95),
  }
}

export async function GET(req: NextRequest): Promise<NextResponse> {
  const auth = await getPlatformAuth()
  if (!auth) return NextResponse.json({ error: 'unauthorized' }, { status: 401 })

  const venueId = req.nextUrl.searchParams.get('venue')
  // Scope: if caller is not super_admin and not demo, force-scope to their venue.
  const scopedVenue = !auth.isDemo && auth.venueId ? auth.venueId : venueId

  const supabase = createServiceClient()

  const now = Date.now()
  const day = 86_400_000
  const since24h = new Date(now - 1 * day).toISOString()
  const since7d = new Date(now - 7 * day).toISOString()
  const since30d = new Date(now - 30 * day).toISOString()

  const [last24h, last7d, last30d] = await Promise.all([
    loadWindow(supabase, scopedVenue, since24h),
    loadWindow(supabase, scopedVenue, since7d),
    loadWindow(supabase, scopedVenue, since30d),
  ])

  // Recent errors — the 20 most recent error rows in the last 7d so the
  // operator can read why mints are failing.
  let errorQuery = supabase
    .from('mint_wedding_telemetry')
    .select('id, source, reason, error_message, created_at, venue_id')
    .eq('errored', true)
    .gte('created_at', since7d)
    .order('created_at', { ascending: false })
    .limit(20)
  if (scopedVenue) errorQuery = errorQuery.eq('venue_id', scopedVenue)
  const { data: errorData } = await errorQuery
  const recentErrors = (errorData ?? []) as RecentError[]

  // Soak-readiness verdict — heuristic for the operator
  const soakReady =
    last7d.total >= 50 &&
    last7d.error_rate < 0.01 &&
    (last7d.latency_p95_ms ?? 0) < 2000

  return NextResponse.json({
    scope: { venue_id: scopedVenue, super_admin: auth.isDemo },
    last_24h: last24h,
    last_7d: last7d,
    last_30d: last30d,
    recent_errors: recentErrors,
    soak_ready_for_pipeline_migration: soakReady,
    soak_ready_criteria: {
      min_volume_7d: 50,
      max_error_rate_7d: 0.01,
      max_latency_p95_ms_7d: 2000,
    },
  })
}
