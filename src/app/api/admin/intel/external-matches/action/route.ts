/**
 * Wave 5C — record a coordinator action on an intel_match.
 *
 * POST body: { matchId: string, actionTaken: string }
 *
 * Auth: getPlatformAuth (coordinator UI only).
 *
 * Common actionTaken values: 'sent_to_couple' | 'added_to_marketing' |
 * 'shared_with_team' | 'investigated' | 'ignored'.
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
import { actionIntelMatch } from '@/lib/services/intel/external-match'

export const maxDuration = 30

interface PostBody {
  matchId?: string
  actionTaken?: string
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
  if (!body.actionTaken || typeof body.actionTaken !== 'string') {
    return badRequest('actionTaken required')
  }
  if (body.actionTaken.length > 200) {
    return badRequest('actionTaken too long (max 200 chars)')
  }

  const auth = await getPlatformAuth()
  if (!auth) return unauthorized()
  if (auth.isDemo) return forbidden('demo cannot action matches')
  if (!auth.venueId) return badRequest('caller has no resolved venue')

  const supabase = createServiceClient()

  // Venue-scope guard.
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
    await actionIntelMatch(body.matchId, body.actionTaken, supabase)
    return NextResponse.json({ ok: true, matchId: body.matchId })
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    return NextResponse.json({ ok: false, error: message }, { status: 500 })
  }
}
