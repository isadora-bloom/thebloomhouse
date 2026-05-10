/**
 * Wave 5B — cohort rollup bulk endpoint.
 *
 * Anchor docs:
 *   - bloom-constitution.md (Wave 5B per-venue aggregator)
 *   - bloom-wave4-5-6-master-plan.md (Wave 5B spec)
 *
 * Auth:
 *   - Authorization: Bearer ${CRON_SECRET} → ops path. Iterates ALL
 *     venues that have at least one couple_identity_profile row.
 *   - else getPlatformAuth (admin-only, no per-venue scoping). The
 *     coordinator UI cannot kick this — it's for the multi-venue
 *     onboarding sweep + manual reconciliation only.
 *
 * POST body:
 *   {
 *     limit?: number,
 *     mode?: 'enqueue' | 'sync',
 *     force?: boolean,
 *     windowDays?: number
 *   }
 *
 * mode='enqueue' (recommended):
 *   - Iterates venues; for each, calls enqueueCohortRollup (24h dedupe
 *     per venue). Cron sweep picks them up over time.
 *
 * mode='sync' (small targeted batches; bounded by maxDuration):
 *   - Calls runCohortRollup inline per venue.
 *   - Honours force: when false, skips venues whose last_refreshed_at
 *     is within 7d AND whose source_window_days matches the request.
 *   - Returns succeeded / failed counts plus aggregate cost.
 */

import { NextRequest, NextResponse } from 'next/server'
import { createServiceClient } from '@/lib/supabase/service'
import {
  getPlatformAuth,
  unauthorized,
  forbidden,
  badRequest,
} from '@/lib/api/auth-helpers'
import {
  runCohortRollup,
  getStoredVenueIntel,
} from '@/lib/services/intel/cohort-rollup'
import { enqueueCohortRollup } from '@/lib/services/intel/enqueue-cohort-rollup'

export const maxDuration = 300

const DEFAULT_LIMIT = 50
const MAX_LIMIT = 200
const SYNC_TIMEBOX_MS = 280_000
const SYNC_FRESH_WINDOW_MS = 7 * 24 * 60 * 60 * 1000
const DEFAULT_WINDOW_DAYS = 90
const MIN_WINDOW_DAYS = 7
const MAX_WINDOW_DAYS = 365

interface BulkBody {
  limit?: number
  mode?: 'enqueue' | 'sync'
  force?: boolean
  windowDays?: number
}

interface AuthContext {
  isCron: boolean
}

async function resolveAuth(
  req: NextRequest,
): Promise<{ ctx: AuthContext } | NextResponse> {
  const cronAuth =
    req.headers.get('authorization') === `Bearer ${process.env.CRON_SECRET}`
  if (cronAuth) {
    return { ctx: { isCron: true } }
  }
  const auth = await getPlatformAuth()
  if (!auth) return unauthorized()
  if (auth.isDemo) return forbidden('demo cannot run bulk cohort rollup')
  // Admin / org-admin only — bulk is multi-venue and bypasses per-
  // venue scoping. Coordinators should hit /api/admin/intel/cohort-
  // rollup for their own venue.
  if (!['org_admin', 'super_admin'].includes(auth.role)) {
    return forbidden('bulk cohort rollup requires org_admin or super_admin')
  }
  return { ctx: { isCron: false } }
}

function clampLimit(raw: unknown): number {
  const n = typeof raw === 'number' ? raw : Number(raw)
  if (!Number.isFinite(n) || n <= 0) return DEFAULT_LIMIT
  return Math.min(Math.floor(n), MAX_LIMIT)
}

function clampWindowDays(raw: unknown): number {
  const n = typeof raw === 'number' ? raw : Number(raw)
  if (!Number.isFinite(n) || n <= 0) return DEFAULT_WINDOW_DAYS
  return Math.max(MIN_WINDOW_DAYS, Math.min(MAX_WINDOW_DAYS, Math.floor(n)))
}

interface VenueIdRow {
  venue_id: string
}

export async function POST(req: NextRequest) {
  let body: BulkBody = {}
  try {
    body = (await req.json()) as BulkBody
  } catch {
    body = {}
  }

  const authResolved = await resolveAuth(req)
  if (authResolved instanceof NextResponse) return authResolved

  const limit = clampLimit(body.limit ?? DEFAULT_LIMIT)
  const mode: 'enqueue' | 'sync' = body.mode === 'sync' ? 'sync' : 'enqueue'
  const force = body.force === true
  const windowDays = clampWindowDays(body.windowDays)

  const supabase = createServiceClient()

  // Distinct venue ids across the couple_identity_profile table — every
  // venue with at least one reconstructed couple is a candidate.
  // PostgREST doesn't expose DISTINCT directly; we fetch a generous
  // window and dedupe in JS.
  const { data: rawRows, error: pageErr } = await supabase
    .from('couple_identity_profile')
    .select('venue_id')
    .limit(2000)

  if (pageErr) {
    return NextResponse.json(
      { ok: false, error: `venue page fetch failed: ${pageErr.message}` },
      { status: 500 },
    )
  }

  const seen = new Set<string>()
  const venueIds: string[] = []
  for (const row of (rawRows ?? []) as VenueIdRow[]) {
    if (!row.venue_id) continue
    if (seen.has(row.venue_id)) continue
    seen.add(row.venue_id)
    venueIds.push(row.venue_id)
    if (venueIds.length >= limit) break
  }

  const startedAt = Date.now()
  const result = {
    ok: true,
    mode,
    limit,
    windowDays,
    totalVenues: venueIds.length,
    processed: 0,
    enqueued: 0,
    succeeded: 0,
    failed: 0,
    skipped_dedupe: 0,
    skipped_fresh: 0,
    timeboxed: false,
    costCents: 0,
    failures: [] as Array<{ venueId: string; error: string }>,
  }

  if (mode === 'enqueue') {
    for (const venueId of venueIds) {
      result.processed += 1
      const r = await enqueueCohortRollup({
        venueId,
        triggerSignal: 'manual_bulk',
        supabase,
      })
      if (r.skipped) {
        if (r.reason === 'dedupe_24h') result.skipped_dedupe += 1
        else result.failed += 1
      } else {
        result.enqueued += 1
      }
    }
  } else {
    for (const venueId of venueIds) {
      if (Date.now() - startedAt >= SYNC_TIMEBOX_MS) {
        result.timeboxed = true
        break
      }
      result.processed += 1

      if (!force) {
        const stored = await getStoredVenueIntel(venueId, { supabase })
        if (stored && stored.sourceWindowDays === windowDays) {
          const last = Date.parse(stored.lastRefreshedAt)
          if (Number.isFinite(last) && Date.now() - last < SYNC_FRESH_WINDOW_MS) {
            result.skipped_fresh += 1
            continue
          }
        }
      }

      try {
        const out = await runCohortRollup(venueId, { supabase, windowDays })
        result.succeeded += 1
        result.costCents += out.costCents
      } catch (err) {
        result.failed += 1
        result.failures.push({
          venueId,
          error: err instanceof Error ? err.message : String(err),
        })
      }
    }
  }

  result.costCents = Math.round(result.costCents * 10_000) / 10_000

  return NextResponse.json(result)
}
