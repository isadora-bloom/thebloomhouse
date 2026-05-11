/**
 * Wave 20 — voice-DNA derive endpoint.
 *
 * Anchor docs:
 *   - bloom-constitution.md (operator authority)
 *   - feedback_deep_fix_vs_bandaid.md (one-derive-all)
 *
 * Auth (mirrors /api/admin/attribution/intent/reclassify):
 *   - Authorization: Bearer ${CRON_SECRET} → ops path, venueId REQUIRED
 *     in body.
 *   - else getPlatformAuth (coordinator UI). venueId taken from auth,
 *     OR explicit venueId in body (super_admin) cleared via
 *     assertCanAccessVenue.
 *
 * POST body:
 *   { venueId?: string, windowDays?: number }
 */

import { NextRequest, NextResponse } from 'next/server'
import { createServiceClient } from '@/lib/supabase/service'
import {
  getPlatformAuth,
  assertCanAccessVenue,
  unauthorized,
  forbidden,
  badRequest,
} from '@/lib/api/auth-helpers'
import { deriveVoiceDNA } from '@/lib/services/voice-dna/derive'

export const maxDuration = 300

interface DeriveBody {
  venueId?: string
  windowDays?: number
}

export async function POST(req: NextRequest) {
  let body: DeriveBody = {}
  try {
    body = (await req.json()) as DeriveBody
  } catch {
    body = {}
  }

  const cronAuth = req.headers.get('authorization') === `Bearer ${process.env.CRON_SECRET}`

  let resolvedVenueId: string
  let actor: string

  if (cronAuth) {
    if (!body.venueId || typeof body.venueId !== 'string') {
      return badRequest('CRON_SECRET path requires venueId in body')
    }
    resolvedVenueId = body.venueId
    actor = 'cron:voice_dna_derive'
  } else {
    const auth = await getPlatformAuth()
    if (!auth) return unauthorized()
    if (auth.isDemo) return forbidden('demo cannot derive voice DNA')
    if (!auth.venueId) return badRequest('caller has no resolved venue')

    const candidate = (typeof body.venueId === 'string' && body.venueId.length > 0)
      ? body.venueId
      : auth.venueId
    const access = await assertCanAccessVenue(auth, candidate)
    if (!access.ok) return forbidden(access.reason)
    resolvedVenueId = candidate
    actor = `user:${auth.userId}`
  }

  const windowDays = (typeof body.windowDays === 'number' && body.windowDays > 0 && body.windowDays <= 1825)
    ? Math.round(body.windowDays)
    : undefined

  const sb = createServiceClient()
  const result = await deriveVoiceDNA({
    venueId: resolvedVenueId,
    supabase: sb,
    windowDays,
    actor,
  })

  if (!result.ok) {
    const status = result.reason === 'gated'
      ? 429
      : result.reason === 'insufficient_evidence'
        ? 422
        : 500
    return NextResponse.json(result, { status })
  }
  return NextResponse.json(result)
}
