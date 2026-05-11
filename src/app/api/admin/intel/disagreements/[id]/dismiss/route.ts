/**
 * Wave 17 — dismiss a disagreement finding.
 *
 * POST /api/admin/intel/disagreements/{id}/dismiss
 *   body: { reason: string }
 *
 * Auth: getPlatformAuth (coordinator UI). Demo forbidden.
 *
 * Dismissal vs resolution:
 *   - Resolve = operator confirms the gap and took action (HoneyBook
 *     updated, couple re-contacted, etc.)
 *   - Dismiss = operator confirms the gap is NOT real / not worth
 *     pursuing (false-positive detector, edge case, expected drift).
 *     Reason is mandatory so the detector tuning gets feedback.
 *
 * Wave 17 NEVER auto-dismisses. Operator decides.
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
  reason?: string
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
  if (auth.isDemo) return forbidden('demo cannot dismiss disagreements')
  if (!auth.venueId) return badRequest('caller has no resolved venue')

  let body: PostBody = {}
  try {
    body = (await req.json()) as PostBody
  } catch {
    body = {}
  }
  const reason = typeof body.reason === 'string' ? body.reason.trim() : ''
  if (!reason) return badRequest('dismissal reason required')
  if (reason.length > 1000) return badRequest('reason too long (max 1000 chars)')

  const supabase = createServiceClient()
  const { data: existing, error: selErr } = await supabase
    .from('disagreement_findings')
    .select('id, venue_id')
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
      status: 'dismissed',
      resolution_note: reason,
      dismissed_at: new Date().toISOString(),
      dismissed_by: auth.userId,
    })
    .eq('id', id)
  if (updErr) {
    return NextResponse.json({ ok: false, error: updErr.message }, { status: 500 })
  }
  return NextResponse.json({ ok: true })
}
