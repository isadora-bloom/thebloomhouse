/**
 * Wave 7D — manually apply discovery feedback (operator override).
 *
 * Anchor docs:
 *   - bloom-constitution.md (Wave 7D closes the discovery loop)
 *   - bloom-wave4-5-6-master-plan.md (Wave 7D spec)
 *
 * Auth (mirrors Wave 7C /validate):
 *   - Authorization: Bearer ${CRON_SECRET} → ops path. The route
 *     resolves the venue from the discovery itself.
 *   - else getPlatformAuth (coordinator UI). The discovery must belong
 *     to the caller's venue (403 otherwise).
 *
 * POST /api/admin/intel/discoveries/{id}/apply-feedback
 *
 * Body:
 *   { force?: boolean }   // when true, re-fire even if feedback_applied_at set
 *
 * Behaviour:
 *   - Calls applyDiscoveryFeedback. Only acts when validation_status='validated'.
 *   - Returns the actionsApplied count + per-action errors.
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
import { applyDiscoveryFeedback } from '@/lib/services/intel/discovery/feedback-loop'

// Feedback writes are cheap (DB writes only — no LLM calls). 60s ceiling
// is plenty.
export const maxDuration = 60

interface PostBody {
  force?: boolean
}

interface AuthContext {
  isCron: boolean
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
  if (auth.isDemo) return forbidden('demo cannot apply discovery feedback')
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
  const force = body.force === true

  const authResolved = await resolveAuth(req)
  if (authResolved instanceof NextResponse) return authResolved
  const { isCron, authVenueId } = authResolved.ctx

  const supabase = createServiceClient()

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

  try {
    const result = await applyDiscoveryFeedback({
      discoveryId,
      supabase,
      force,
    })
    return NextResponse.json({
      ok: true,
      discoveryId,
      venueId: discoveryVenueId,
      actionsApplied: result.actionsApplied,
      errors: result.errors,
    })
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    console.error('[apply-feedback] route error:', message)
    return NextResponse.json({ ok: false, error: message }, { status: 500 })
  }
}
