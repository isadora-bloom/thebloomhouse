/**
 * Wave 7A — single-discovery detail endpoint.
 *
 * GET /api/admin/intel/discoveries/{id}
 *
 * Auth: getPlatformAuth (coordinator UI only). The endpoint enforces
 * venue-scope: a discovery row from a different venue returns 403.
 */

import { NextRequest, NextResponse } from 'next/server'
import {
  getPlatformAuth,
  unauthorized,
  forbidden,
  badRequest,
  notFound,
} from '@/lib/api/auth-helpers'
import { getDiscovery } from '@/lib/services/intel/discovery/engine'

export const maxDuration = 30

export async function GET(
  _req: NextRequest,
  context: { params: Promise<{ id: string }> },
) {
  const { id } = await context.params
  if (!id || typeof id !== 'string') {
    return badRequest('discovery id required in path')
  }

  const auth = await getPlatformAuth()
  if (!auth) return unauthorized()
  if (!auth.venueId) return badRequest('caller has no resolved venue')

  try {
    const row = await getDiscovery(id)
    if (!row) return notFound('discovery')
    if (row.venue_id !== auth.venueId) {
      return forbidden('discovery belongs to a different venue')
    }
    return NextResponse.json({ ok: true, discovery: row })
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    return NextResponse.json({ ok: false, error: message }, { status: 500 })
  }
}
