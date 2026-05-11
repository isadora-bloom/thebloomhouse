/**
 * Wave 20 — voice-DNA dismiss endpoint.
 *
 * POST /api/admin/voice-dna/[id]/dismiss
 * body: { reason?: string }
 *
 * Constitution: derivations are never hard-deleted. dismiss flips the
 * `dismissed` flag with an audit trail (dismissed_by, dismissed_at,
 * dismiss_reason).
 */

import { NextRequest, NextResponse } from 'next/server'
import { createServiceClient } from '@/lib/supabase/service'
import {
  getPlatformAuth,
  assertCanAccessVenue,
  unauthorized,
  forbidden,
  badRequest,
  notFound,
} from '@/lib/api/auth-helpers'
import { dismissDerivation } from '@/lib/services/voice-dna/apply'

export const maxDuration = 30

interface DismissBody {
  reason?: string
}

export async function POST(
  req: NextRequest,
  context: { params: Promise<{ id: string }> },
) {
  const auth = await getPlatformAuth()
  if (!auth) return unauthorized()
  if (auth.isDemo) return forbidden('demo cannot dismiss voice DNA')

  const { id } = await context.params
  if (!id || typeof id !== 'string') return badRequest('derivation id required')

  let body: DismissBody = {}
  try {
    body = (await req.json()) as DismissBody
  } catch {
    body = {}
  }
  const reason = typeof body.reason === 'string' ? body.reason.slice(0, 500) : undefined

  // Venue-scope gate via derivation row.
  const sb = createServiceClient()
  const { data: row, error: loadErr } = await sb
    .from('voice_dna_derivations')
    .select('id, venue_id')
    .eq('id', id)
    .maybeSingle()
  if (loadErr) {
    return NextResponse.json({ ok: false, error: loadErr.message }, { status: 500 })
  }
  if (!row) return notFound('derivation')
  const venueId = (row as { venue_id: string }).venue_id
  const access = await assertCanAccessVenue(auth, venueId)
  if (!access.ok) return forbidden(access.reason)

  const result = await dismissDerivation({
    derivationId: id,
    reason,
    userId: auth.userId,
    supabase: sb,
  })
  if (!result.ok) {
    const status = result.reason === 'not_found' ? 404
      : result.reason === 'already_applied' || result.reason === 'already_dismissed' ? 409
        : 500
    return NextResponse.json(result, { status })
  }
  return NextResponse.json(result)
}
