/**
 * Wave 7A — record a coordinator action on an intel_discovery.
 *
 * POST body: { discoveryId: string, actionTaken: string }
 *
 * Auth: getPlatformAuth (coordinator UI only).
 *
 * Common actionTaken values: 'tested' | 'rolled_into_strategy' |
 * 'shared_with_team' | 'investigated' | 'noted'.
 *
 * NOTE: this records that a HUMAN took an action — Wave 7A does NOT
 * auto-execute any recommended_action. Wave 7C designs/runs the test;
 * Wave 7D promotes validated discoveries into Wave 5/6 buckets.
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
import { actionDiscovery } from '@/lib/services/intel/discovery/engine'

export const maxDuration = 30

interface PostBody {
  discoveryId?: string
  actionTaken?: string
}

export async function POST(req: NextRequest) {
  let body: PostBody = {}
  try {
    body = (await req.json()) as PostBody
  } catch {
    body = {}
  }
  if (!body.discoveryId || typeof body.discoveryId !== 'string') {
    return badRequest('discoveryId required')
  }
  if (!body.actionTaken || typeof body.actionTaken !== 'string') {
    return badRequest('actionTaken required')
  }
  if (body.actionTaken.length > 200) {
    return badRequest('actionTaken too long (max 200 chars)')
  }

  const auth = await getPlatformAuth()
  if (!auth) return unauthorized()
  if (auth.isDemo) return forbidden('demo cannot action discoveries')
  if (!auth.venueId) return badRequest('caller has no resolved venue')

  const supabase = createServiceClient()

  // Venue-scope guard.
  const { data: row } = await supabase
    .from('intel_discoveries')
    .select('id, venue_id')
    .eq('id', body.discoveryId)
    .maybeSingle()
  if (!row) return notFound('discovery')
  if ((row as { venue_id: string }).venue_id !== auth.venueId) {
    return forbidden('discovery belongs to a different venue')
  }

  try {
    await actionDiscovery(body.discoveryId, body.actionTaken, supabase)
    return NextResponse.json({ ok: true, discoveryId: body.discoveryId })
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    return NextResponse.json({ ok: false, error: message }, { status: 500 })
  }
}
