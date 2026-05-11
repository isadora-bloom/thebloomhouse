/**
 * Wave 17 — resolve a disagreement finding.
 *
 * POST /api/admin/intel/disagreements/{id}/resolve
 *   body: { note: string }
 *
 * Auth: getPlatformAuth (coordinator UI). Demo forbidden.
 * Venue-scope enforced: the finding must belong to caller's venue.
 *
 * Wave 17 NEVER auto-resolves. This route is the operator-explicit
 * resolution path: operator confirms the disagreement is understood
 * and writes a note explaining what they did (e.g. "Updated HoneyBook
 * source column to Instagram").
 */

import { NextRequest, NextResponse } from 'next/server'
import {
  getPlatformAuth,
  unauthorized,
  forbidden,
  badRequest,
  notFound,
} from '@/lib/api/auth-helpers'
import { createServiceClient } from '@/lib/supabase/service'

export const maxDuration = 30

interface PostBody {
  note?: string
}

export async function POST(
  req: NextRequest,
  context: { params: Promise<{ id: string }> },
) {
  const { id } = await context.params
  if (!id || typeof id !== 'string') {
    return badRequest('finding id required in path')
  }
  const auth = await getPlatformAuth()
  if (!auth) return unauthorized()
  if (auth.isDemo) return forbidden('demo cannot resolve disagreements')
  if (!auth.venueId) return badRequest('caller has no resolved venue')

  let body: PostBody = {}
  try {
    body = (await req.json()) as PostBody
  } catch {
    body = {}
  }
  const note = typeof body.note === 'string' ? body.note.trim() : ''
  if (!note) return badRequest('resolution note required')
  if (note.length > 1000) return badRequest('note too long (max 1000 chars)')

  const supabase = createServiceClient()
  const { data: existing, error: selErr } = await supabase
    .from('disagreement_findings')
    .select('id, venue_id, status')
    .eq('id', id)
    .maybeSingle()
  if (selErr) {
    return NextResponse.json({ ok: false, error: selErr.message }, { status: 500 })
  }
  if (!existing) return notFound('disagreement finding')
  if (existing.venue_id !== auth.venueId) {
    return forbidden('finding belongs to a different venue')
  }
  const { error: updErr } = await supabase
    .from('disagreement_findings')
    .update({
      status: 'resolved',
      resolution_note: note,
      resolved_at: new Date().toISOString(),
      resolved_by: auth.userId,
    })
    .eq('id', id)
  if (updErr) {
    return NextResponse.json({ ok: false, error: updErr.message }, { status: 500 })
  }
  return NextResponse.json({ ok: true })
}
