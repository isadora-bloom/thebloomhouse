/**
 * Wave 7A — dismiss an intel_discovery.
 *
 * POST body: { discoveryId: string, reason?: string }
 *
 * Auth: getPlatformAuth (coordinator UI only — cron has no business
 * dismissing discoveries).
 *
 * Sets validation_status='dismissed' + dismissed_at + dismissed_by +
 * dismissal_reason. Does NOT delete the row — preserves audit history.
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
import { dismissDiscovery } from '@/lib/services/intel/discovery/engine'

export const maxDuration = 30

interface PostBody {
  discoveryId?: string
  reason?: string
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

  const auth = await getPlatformAuth()
  if (!auth) return unauthorized()
  if (auth.isDemo) return forbidden('demo cannot dismiss discoveries')
  if (!auth.venueId) return badRequest('caller has no resolved venue')

  const supabase = createServiceClient()

  // Venue-scope guard — confirm discovery belongs to caller's venue.
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
    await dismissDiscovery(
      body.discoveryId,
      body.reason ?? null,
      auth.userId,
      supabase,
    )
    return NextResponse.json({ ok: true, discoveryId: body.discoveryId })
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    return NextResponse.json({ ok: false, error: message }, { status: 500 })
  }
}
