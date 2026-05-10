/**
 * Wave 7C — hypothesis validation endpoint.
 *
 * Anchor docs:
 *   - bloom-constitution.md (Wave 7C closes the discovery loop)
 *   - bloom-wave4-5-6-master-plan.md (Wave 7C spec)
 *
 * Auth (mirrors /api/admin/intel/discoveries/run):
 *   - Authorization: Bearer ${CRON_SECRET} → ops path. The route resolves
 *     the venue from the discovery itself; nothing else is required in
 *     the body.
 *   - else getPlatformAuth (coordinator UI). The discovery must belong
 *     to the caller's venue (403 otherwise).
 *
 * POST /api/admin/intel/discoveries/{id}/validate
 *
 * Body:
 *   { enqueue?: boolean }   // when true, enqueue rather than running inline
 *
 * Behaviour:
 *   - enqueue=true: enqueue a hypothesis_validation_jobs row.
 *   - enqueue=false (default): run runHypothesisValidation inline and
 *     return the run id + interpretation + cost.
 *
 * Cost: ~$0.05-0.15 per inline run (two Sonnet calls).
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
  runHypothesisValidation,
  HYPOTHESIS_VALIDATOR_PROMPT_VERSION,
} from '@/lib/services/intel/validation/run-validation'
import { enqueueHypothesisValidation } from '@/lib/services/intel/validation/enqueue'

// Two Sonnet calls + a query — comfortably inside 300s. Mirrors the
// 7A run endpoint timing budget.
export const maxDuration = 300

interface PostBody {
  /** When true, enqueue rather than running inline. */
  enqueue?: boolean
}

interface AuthContext {
  isCron: boolean
  /** The auth-resolved venueId; null on cron path until we read the discovery. */
  authVenueId: string | null
}

async function resolveAuth(
  req: NextRequest,
): Promise<{ ctx: AuthContext } | NextResponse> {
  const cronAuth =
    req.headers.get('authorization') === `Bearer ${process.env.CRON_SECRET}`
  if (cronAuth) {
    return { ctx: { isCron: true, authVenueId: null } }
  }

  const auth = await getPlatformAuth()
  if (!auth) return unauthorized()
  if (auth.isDemo) return forbidden('demo cannot validate discoveries')
  if (!auth.venueId) return badRequest('caller has no resolved venue')
  return { ctx: { isCron: false, authVenueId: auth.venueId } }
}

export async function POST(
  req: NextRequest,
  context: { params: Promise<{ id: string }> },
) {
  const { id: discoveryId } = await context.params
  if (!discoveryId || typeof discoveryId !== 'string') {
    return badRequest('discovery id required in path')
  }

  let body: PostBody = {}
  try {
    body = (await req.json()) as PostBody
  } catch {
    body = {}
  }

  const authResolved = await resolveAuth(req)
  if (authResolved instanceof NextResponse) return authResolved
  const { isCron, authVenueId } = authResolved.ctx

  const supabase = createServiceClient()

  // Confirm the discovery exists; resolve its venue for both auth-scope
  // checking and downstream enqueue.
  const { data: discoveryRow } = await supabase
    .from('intel_discoveries')
    .select('id, venue_id')
    .eq('id', discoveryId)
    .maybeSingle()
  if (!discoveryRow) return notFound('discovery')
  const discoveryVenueId = (discoveryRow as { venue_id: string }).venue_id

  if (!isCron) {
    if (!authVenueId) {
      return badRequest('caller has no resolved venue')
    }
    if (discoveryVenueId !== authVenueId) {
      return forbidden('discovery belongs to a different venue')
    }
  }

  // Enqueue path — sweep dispatcher will pick it up.
  if (body.enqueue === true) {
    const r = await enqueueHypothesisValidation({
      discoveryId,
      venueId: discoveryVenueId,
      triggerSignal: 'admin_backfill',
      supabase,
    })
    if (r.skipped) {
      return NextResponse.json({ ok: true, enqueued: false, reason: r.reason })
    }
    return NextResponse.json({ ok: true, enqueued: true, jobId: r.jobId })
  }

  // Inline path — runHypothesisValidation.
  try {
    const result = await runHypothesisValidation(
      { discoveryId },
      { supabase },
    )
    return NextResponse.json({
      ok: true,
      runId: result.runId,
      discoveryId: result.discoveryId,
      venueId: result.venueId,
      interpretation: result.interpretation,
      confidence_0_100: result.confidence_0_100,
      testPlan: result.testPlan,
      testResult: result.testResult,
      costCents: result.costCents,
      promptVersion: result.promptVersion,
    })
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    console.error('[hypothesis-validate] route error:', message)
    return NextResponse.json(
      {
        ok: false,
        error: message,
        promptVersion: HYPOTHESIS_VALIDATOR_PROMPT_VERSION,
      },
      { status: 500 },
    )
  }
}
