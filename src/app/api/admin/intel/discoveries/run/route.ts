/**
 * Wave 7A — discovery-engine run endpoint.
 *
 * Anchor docs:
 *   - bloom-constitution.md (Wave 7A pattern discovery engine)
 *   - bloom-wave4-5-6-master-plan.md (Wave 7A spec)
 *
 * Auth (mirrors /api/admin/intel/external-matches/scan):
 *   - Authorization: Bearer ${CRON_SECRET} → ops path. venueId required
 *     in body.
 *   - else getPlatformAuth (coordinator UI). venueId comes from auth;
 *     any explicit body.venueId is ignored.
 *
 * POST body:
 *   { venueId?: string, force?: boolean, enqueue?: boolean }
 *
 * Behaviour:
 *   - enqueue=true: enqueue an intel_discovery_jobs row. The sweep
 *     dispatcher will pick it up. Useful when the caller doesn't want
 *     to wait for the LLM round-trip (~30-60s on Sonnet).
 *   - enqueue=false (default): run runDiscoveryEngine inline and return
 *     the discoveries + cost.
 *   - force=true: bypass the cohort-floor refusal (used for tests / first-
 *     run debugging).
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
  runDiscoveryEngine,
  DISCOVERY_ENGINE_PROMPT_VERSION,
} from '@/lib/services/intel/discovery/engine'
import { enqueueDiscoveryRun } from '@/lib/services/intel/discovery/enqueue'

// One discovery run is one Sonnet call with ~3-5k input + ~1-3k output
// tokens — comfortably under a minute even on cold-start. 280s budget
// mirrors Wave 5B/5C/6B endpoints.
export const maxDuration = 300

interface PostBody {
  venueId?: string
  force?: boolean
  /** When true, enqueue rather than running inline. */
  enqueue?: boolean
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
  if (auth.isDemo) return forbidden('demo cannot run discovery engine')
  if (!auth.venueId) return badRequest('caller has no resolved venue')
  return { ctx: { isCron: false, venueId: auth.venueId } }
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

  const supabase = createServiceClient()

  // Confirm venue exists.
  const { data: venueRow } = await supabase
    .from('venues')
    .select('id, name')
    .eq('id', venueId)
    .maybeSingle()
  if (!venueRow) return notFound('venue')

  // Enqueue path — used by callers who don't want to wait for the LLM
  // round-trip. Queue dispatcher picks it up on the next sweep tick.
  if (body.enqueue === true) {
    const r = await enqueueDiscoveryRun({
      venueId,
      triggerSignal: body.force ? 'manual_force' : 'admin_backfill',
      supabase,
    })
    if (r.skipped) {
      return NextResponse.json({ ok: true, enqueued: false, reason: r.reason })
    }
    return NextResponse.json({ ok: true, enqueued: true, jobId: r.jobId })
  }

  // Inline path — run runDiscoveryEngine.
  try {
    const result = await runDiscoveryEngine(
      { venueId, force: body.force === true },
      { supabase },
    )
    return NextResponse.json({
      ok: true,
      venueId,
      discoveries: result.discoveries,
      refusals: result.refusals,
      inserted: result.inserted,
      skipped: result.skipped,
      costCents: result.costCents,
      promptVersion: result.promptVersion,
    })
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    console.error('[discovery-engine-run] route error:', message)
    return NextResponse.json(
      {
        ok: false,
        error: message,
        promptVersion: DISCOVERY_ENGINE_PROMPT_VERSION,
      },
      { status: 500 },
    )
  }
}
