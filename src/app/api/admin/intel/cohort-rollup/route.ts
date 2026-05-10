/**
 * Wave 5B — per-venue cohort rollup endpoint.
 *
 * Anchor docs:
 *   - bloom-constitution.md (Wave 5B aggregates the per-couple substrate
 *     into venue-level intel)
 *   - bloom-wave4-5-6-master-plan.md (Wave 5B spec)
 *
 * Auth (mirrors /api/admin/intel/couple-derive):
 *   - Authorization: Bearer ${CRON_SECRET} → ops path. venueId in body.
 *   - else getPlatformAuth (coordinator UI). venueId comes from auth;
 *     any explicit body.venueId is ignored.
 *
 * POST body:
 *   { venueId?: string, windowDays?: number, force?: boolean }
 *
 * Behaviour:
 *   - force=false (default): if rollup exists AND last_refreshed_at is
 *     within the last 7 days, return cached rollup, do NOT spend LLM.
 *   - force=true OR no rollup OR stale: run runCohortRollup (one
 *     Sonnet call), upsert, return the fresh rollup.
 *
 * GET ?venueId=X:
 *   Returns the stored rollup or 404. No LLM call. Used by the
 *   /intel/cohort dashboard + CohortRollupPanel to fetch the canonical
 *   record.
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
import {
  runCohortRollup,
  getStoredVenueIntel,
  COHORT_ROLLUP_PROMPT_VERSION,
} from '@/lib/services/intel/cohort-rollup'

// One rollup is one Sonnet call over ~30-60 anonymised summaries — a
// few minutes worst case. Pad for evidence-load latency.
export const maxDuration = 300

const CACHE_WINDOW_MS = 7 * 24 * 60 * 60 * 1000 // 7 days
const DEFAULT_WINDOW_DAYS = 90
const MIN_WINDOW_DAYS = 7
const MAX_WINDOW_DAYS = 365

interface PostBody {
  venueId?: string
  windowDays?: number
  force?: boolean
}

interface AuthContext {
  isCron: boolean
  venueId: string
}

async function resolveAuth(
  req: NextRequest,
  body: PostBody,
): Promise<{ ctx: AuthContext } | NextResponse> {
  const cronAuth =
    req.headers.get('authorization') === `Bearer ${process.env.CRON_SECRET}`
  if (cronAuth) {
    if (!body.venueId || typeof body.venueId !== 'string') {
      return badRequest('CRON_SECRET path requires venueId in body')
    }
    return { ctx: { isCron: true, venueId: body.venueId } }
  }

  const auth = await getPlatformAuth()
  if (!auth) return unauthorized()
  if (auth.isDemo) return forbidden('demo cannot run cohort rollup')
  if (!auth.venueId) return badRequest('caller has no resolved venue')
  return { ctx: { isCron: false, venueId: auth.venueId } }
}

function clampWindowDays(raw: unknown): number {
  const n = typeof raw === 'number' ? raw : Number(raw)
  if (!Number.isFinite(n) || n <= 0) return DEFAULT_WINDOW_DAYS
  return Math.max(MIN_WINDOW_DAYS, Math.min(MAX_WINDOW_DAYS, Math.floor(n)))
}

function isFresh(stored: { lastRefreshedAt: string }): boolean {
  const last = Date.parse(stored.lastRefreshedAt)
  if (!Number.isFinite(last)) return false
  return Date.now() - last < CACHE_WINDOW_MS
}

// ---------------------------------------------------------------------------
// POST — run (or return cached) cohort rollup
// ---------------------------------------------------------------------------

export async function POST(req: NextRequest) {
  let body: PostBody = {}
  try {
    body = (await req.json()) as PostBody
  } catch {
    body = {}
  }

  const authResolved = await resolveAuth(req, body)
  if (authResolved instanceof NextResponse) return authResolved
  const { venueId } = authResolved.ctx

  const force = body.force === true
  const windowDays = clampWindowDays(body.windowDays)

  const supabase = createServiceClient()

  // Confirm venue exists.
  const { data: venueRow } = await supabase
    .from('venues')
    .select('id, name')
    .eq('id', venueId)
    .maybeSingle()
  if (!venueRow) return notFound('venue')

  // Cache-hit path. We compare against last_refreshed_at + the stored
  // source_window_days. If the caller is asking for a different window,
  // we always re-run (even within the cache window) so the operator
  // gets a window-correct rollup.
  if (!force) {
    const stored = await getStoredVenueIntel(venueId, { supabase })
    if (
      stored &&
      isFresh(stored) &&
      stored.sourceWindowDays === windowDays
    ) {
      return NextResponse.json({
        ok: true,
        cached: true,
        venueId,
        rollup: stored.rollup,
        sourceWindowDays: stored.sourceWindowDays,
        couplesInWindow: stored.couplesInWindow,
        promptVersion: stored.promptVersion,
        lastRefreshedAt: stored.lastRefreshedAt,
        cumulativeCostCents: stored.costCents,
      })
    }
  }

  // Run a fresh rollup.
  let result
  try {
    result = await runCohortRollup(venueId, { supabase, windowDays })
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    console.error('[cohort-rollup] route error:', message)
    return NextResponse.json(
      {
        ok: false,
        error: message,
        promptVersion: COHORT_ROLLUP_PROMPT_VERSION,
      },
      { status: 500 },
    )
  }

  return NextResponse.json({
    ok: true,
    cached: false,
    venueId,
    rollup: result.rollup,
    sourceWindowDays: result.windowDays,
    couplesInWindow: result.couplesInWindow,
    promptVersion: result.promptVersion,
    costCents: result.costCents,
    inputTokens: result.inputTokens,
    outputTokens: result.outputTokens,
  })
}

// ---------------------------------------------------------------------------
// GET — read stored cohort rollup (no LLM call)
// ---------------------------------------------------------------------------

export async function GET(req: NextRequest) {
  const url = new URL(req.url)
  const venueIdParam = url.searchParams.get('venueId')

  // Auth resolution.
  const cronAuth =
    req.headers.get('authorization') === `Bearer ${process.env.CRON_SECRET}`
  let venueId: string | null = null
  if (cronAuth) {
    if (!venueIdParam) return badRequest('CRON_SECRET path requires venueId param')
    venueId = venueIdParam
  } else {
    const auth = await getPlatformAuth()
    if (!auth) return unauthorized()
    if (!auth.venueId) return badRequest('caller has no resolved venue')
    // Coordinator path: ignore any explicit venueId, use the auth one.
    venueId = auth.venueId
  }

  const stored = await getStoredVenueIntel(venueId)
  if (!stored) return notFound('venue_intel')

  return NextResponse.json({
    ok: true,
    venueId: stored.venueId,
    rollup: stored.rollup,
    sourceWindowDays: stored.sourceWindowDays,
    couplesInWindow: stored.couplesInWindow,
    promptVersion: stored.promptVersion,
    lastRefreshedAt: stored.lastRefreshedAt,
    cumulativeCostCents: stored.costCents,
  })
}
