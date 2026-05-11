/**
 * Wave 14 — alumni cohort generate endpoint.
 *
 * POST /api/admin/intel/alumni/generate
 * Body: { venueId: string }
 *
 * Auth:
 *   - Authorization: Bearer ${CRON_SECRET} → ops path. venueId in body.
 *   - else getPlatformAuth (coordinator UI). Validates the requested
 *     venueId matches the caller's resolved venue.
 *
 * Behaviour:
 *   - Runs one Sonnet call. Replaces prior alumni_cohorts rows for the
 *     venue with the fresh archetypes.
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
  generateAlumniCohorts,
  ALUMNI_COHORT_PROMPT_VERSION,
} from '@/lib/services/intel/alumni/generate'

export const maxDuration = 300

interface PostBody {
  venueId?: string
}

async function resolveAuth(
  req: NextRequest,
  venueId: string | null,
): Promise<{ venueId: string } | NextResponse> {
  const cronAuth = req.headers.get('authorization') === `Bearer ${process.env.CRON_SECRET}`
  if (cronAuth) {
    if (!venueId) return badRequest('CRON_SECRET path requires venueId')
    return { venueId }
  }
  const auth = await getPlatformAuth()
  if (!auth) return unauthorized()
  if (auth.isDemo) return forbidden('demo cannot run alumni cohort generation')
  if (!auth.venueId) return badRequest('caller has no resolved venue')
  if (venueId && venueId !== auth.venueId) {
    return forbidden('cannot generate for another venue')
  }
  // Sanity check that the venue exists.
  const supabase = createServiceClient()
  const { data: v } = await supabase
    .from('venues')
    .select('id')
    .eq('id', auth.venueId)
    .maybeSingle()
  if (!v) return notFound('venue')
  return { venueId: auth.venueId }
}

export async function POST(req: NextRequest) {
  let body: PostBody = {}
  try {
    body = (await req.json()) as PostBody
  } catch {
    body = {}
  }
  const venueId = typeof body.venueId === 'string' ? body.venueId : null

  const authResolved = await resolveAuth(req, venueId)
  if (authResolved instanceof NextResponse) return authResolved

  const supabase = createServiceClient()
  try {
    const result = await generateAlumniCohorts(
      { venueId: authResolved.venueId },
      { supabase },
    )
    return NextResponse.json({
      ok: true,
      venueId: authResolved.venueId,
      promptVersion: result.promptVersion,
      costCents: result.costCents,
      inputTokens: result.inputTokens,
      outputTokens: result.outputTokens,
      bookedCoupleCount: result.bookedCoupleCount,
      archetypesUpserted: result.archetypesUpserted,
      archetypes: result.output.archetypes,
      refusals: result.output.refusals,
    })
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    console.error('[alumni/generate] error:', message)
    return NextResponse.json(
      { ok: false, error: message, promptVersion: ALUMNI_COHORT_PROMPT_VERSION },
      { status: 500 },
    )
  }
}
