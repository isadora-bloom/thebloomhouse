/**
 * Wave 5D — venue thesis generate endpoint.
 *
 * Anchor docs:
 *   - bloom-constitution.md (Wave 5D onboarding bootstrap)
 *   - bloom-wave4-5-6-master-plan.md (Wave 5D spec)
 *
 * Auth (mirrors /api/admin/intel/cohort-rollup):
 *   - Authorization: Bearer ${CRON_SECRET} → ops path. venueId required
 *     in body.
 *   - else getPlatformAuth (coordinator UI). venueId comes from auth;
 *     any explicit body.venueId is ignored.
 *
 * POST body:
 *   { venueId?: string, force?: boolean, windowDays?: number }
 *
 * Behaviour:
 *   - force=false (default) AND a thesis exists AND last_generated_at
 *     is within the last 7 days AND couples_at_generation hasn't grown
 *     by ≥25% → return cached thesis, do NOT spend LLM.
 *   - force=true OR no thesis OR stale OR cohort grew → run
 *     generateVenueThesis (one Sonnet call), upsert, return the fresh
 *     thesis.
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
  generateVenueThesis,
  getStoredVenueThesis,
  VENUE_THESIS_PROMPT_VERSION,
} from '@/lib/services/intel/onboarding/generate-thesis'

// One thesis is one Sonnet call over the cohort aggregate. Pad for the
// evidence-load latency.
export const maxDuration = 300

const CACHE_WINDOW_MS = 7 * 24 * 60 * 60 * 1000 // 7 days
const COHORT_GROWTH_THRESHOLD = 0.25
const DEFAULT_WINDOW_DAYS = 365
const MIN_WINDOW_DAYS = 30
const MAX_WINDOW_DAYS = 1825

interface PostBody {
  venueId?: string
  force?: boolean
  windowDays?: number
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
  if (auth.isDemo) return forbidden('demo cannot run venue thesis generation')
  if (!auth.venueId) return badRequest('caller has no resolved venue')
  return { ctx: { isCron: false, venueId: auth.venueId } }
}

function clampWindowDays(raw: unknown): number {
  const n = typeof raw === 'number' ? raw : Number(raw)
  if (!Number.isFinite(n) || n <= 0) return DEFAULT_WINDOW_DAYS
  return Math.max(MIN_WINDOW_DAYS, Math.min(MAX_WINDOW_DAYS, Math.floor(n)))
}

function isFresh(lastGeneratedAt: string): boolean {
  const last = Date.parse(lastGeneratedAt)
  if (!Number.isFinite(last)) return false
  return Date.now() - last < CACHE_WINDOW_MS
}

async function cohortGrew(
  venueId: string,
  baseline: number,
): Promise<boolean> {
  if (baseline <= 0) return true
  const supabase = createServiceClient()
  const { count } = await supabase
    .from('couple_identity_profile')
    .select('wedding_id', { count: 'exact', head: true })
    .eq('venue_id', venueId)
  const current = count ?? 0
  return (current - baseline) / baseline >= COHORT_GROWTH_THRESHOLD
}

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
  const { data: venueRow } = await supabase
    .from('venues')
    .select('id, name')
    .eq('id', venueId)
    .maybeSingle()
  if (!venueRow) return notFound('venue')

  // Cache-hit path.
  if (!force) {
    const stored = await getStoredVenueThesis(venueId, { supabase })
    if (stored && isFresh(stored.lastGeneratedAt)) {
      const grew = await cohortGrew(venueId, stored.couplesAtGeneration)
      if (!grew) {
        return NextResponse.json({
          ok: true,
          cached: true,
          venueId,
          thesis: stored.thesis,
          couplesAtGeneration: stored.couplesAtGeneration,
          generationCount: stored.generationCount,
          promptVersion: stored.promptVersion,
          lastGeneratedAt: stored.lastGeneratedAt,
          cumulativeCostCents: stored.costCents,
        })
      }
    }
  }

  // Run a fresh generation.
  let result
  try {
    result = await generateVenueThesis(venueId, { supabase, windowDays })
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    console.error('[venue-thesis-generate] route error:', message)
    return NextResponse.json(
      {
        ok: false,
        error: message,
        promptVersion: VENUE_THESIS_PROMPT_VERSION,
      },
      { status: 500 },
    )
  }

  return NextResponse.json({
    ok: true,
    cached: false,
    venueId,
    thesis: result.thesis,
    couplesAtGeneration: result.cohortSize,
    promptVersion: result.promptVersion,
    costCents: result.costCents,
    inputTokens: result.inputTokens,
    outputTokens: result.outputTokens,
  })
}
