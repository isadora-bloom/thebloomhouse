/**
 * Wave 7D — read the audit log of feedback writes for a discovery.
 *
 * GET /api/admin/intel/discoveries/{id}/feedback-actions
 *
 * Auth: getPlatformAuth (coordinator UI). The discovery must belong to
 * the caller's venue (403 otherwise).
 *
 * Returns:
 *   {
 *     ok: true,
 *     discoveryId,
 *     venueId,
 *     actions: [{
 *       id, target_system, action_type, payload, written_at, error
 *     }]
 *   }
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
import { listDiscoveryFeedbackActions } from '@/lib/services/intel/discovery/feedback-loop'

export const maxDuration = 30

export async function GET(
  _req: NextRequest,
  context: { params: Promise<{ id: string }> },
) {
  const { id: discoveryId } = await context.params
  if (!discoveryId || typeof discoveryId !== 'string') {
    return badRequest('discovery id required in path')
  }

  const auth = await getPlatformAuth()
  if (!auth) return unauthorized()
  if (!auth.venueId) return badRequest('caller has no resolved venue')

  const supabase = createServiceClient()

  const { data: discoveryRow } = await supabase
    .from('intel_discoveries')
    .select('id, venue_id')
    .eq('id', discoveryId)
    .maybeSingle()
  if (!discoveryRow) return notFound('discovery')
  const discoveryVenueId = (discoveryRow as { venue_id: string }).venue_id

  if (auth.role !== 'super_admin' && discoveryVenueId !== auth.venueId) {
    return forbidden('discovery belongs to a different venue')
  }

  try {
    const actions = await listDiscoveryFeedbackActions(discoveryId, supabase)
    return NextResponse.json({
      ok: true,
      discoveryId,
      venueId: discoveryVenueId,
      actions,
    })
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    return NextResponse.json({ ok: false, error: message }, { status: 500 })
  }
}
