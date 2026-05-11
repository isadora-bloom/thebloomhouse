/**
 * Wave 17 — mark a disagreement finding as 'investigating'.
 *
 * POST /api/admin/intel/disagreements/{id}/investigate
 *   body: { note?: string }
 *
 * Status semantics:
 *   - active        → default state when detected
 *   - investigating → operator has read it, wants to come back to it
 *   - resolved      → operator confirmed and took action
 *   - dismissed     → operator confirmed it's not real
 *
 * Investigating is a soft-park: doesn't clear from the dashboard, but
 * filters into a different bucket so coordinators can split "fresh
 * to triage" from "I'm working on it".
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
  if (auth.isDemo) return forbidden('demo cannot update disagreements')
  if (!auth.venueId) return badRequest('caller has no resolved venue')

  let body: PostBody = {}
  try {
    body = (await req.json()) as PostBody
  } catch {
    body = {}
  }
  const note = typeof body.note === 'string' ? body.note.trim().slice(0, 1000) : null

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
  const update: Record<string, unknown> = {
    status: 'investigating',
  }
  if (note) update.resolution_note = note
  const { error: updErr } = await supabase
    .from('disagreement_findings')
    .update(update)
    .eq('id', id)
  if (updErr) {
    return NextResponse.json({ ok: false, error: updErr.message }, { status: 500 })
  }
  return NextResponse.json({ ok: true })
}
