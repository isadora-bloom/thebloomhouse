/**
 * Wave 5C — dismiss an intel_match.
 *
 * POST body: { matchId: string, reason?: string }
 *
 * Auth: getPlatformAuth (coordinator UI only — cron has no business
 * dismissing matches).
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
import { dismissIntelMatch } from '@/lib/services/intel/external-match'

export const maxDuration = 30

interface PostBody {
  matchId?: string
  reason?: string
}

export async function POST(req: NextRequest) {
  let body: PostBody = {}
  try {
    body = (await req.json()) as PostBody
  } catch {
    body = {}
  }
  if (!body.matchId || typeof body.matchId !== 'string') {
    return badRequest('matchId required')
  }

  const auth = await getPlatformAuth()
  if (!auth) return unauthorized()
  if (auth.isDemo) return forbidden('demo cannot dismiss matches')
  if (!auth.venueId) return badRequest('caller has no resolved venue')

  const supabase = createServiceClient()

  // Venue-scope guard — confirm match belongs to caller's venue.
  const { data: match } = await supabase
    .from('intel_matches')
    .select('id, venue_id')
    .eq('id', body.matchId)
    .maybeSingle()
  if (!match) return notFound('match')
  if ((match as { venue_id: string }).venue_id !== auth.venueId) {
    return forbidden('match belongs to a different venue')
  }

  try {
    await dismissIntelMatch(
      body.matchId,
      body.reason ?? null,
      auth.userId,
      supabase,
    )
    return NextResponse.json({ ok: true, matchId: body.matchId })
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    return NextResponse.json({ ok: false, error: message }, { status: 500 })
  }
}
