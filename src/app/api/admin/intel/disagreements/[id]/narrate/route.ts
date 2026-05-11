/**
 * Wave 17 — force-narrate one disagreement finding.
 *
 * POST /api/admin/intel/disagreements/{id}/narrate
 *
 * Auth: getPlatformAuth (coordinator UI). Demo forbidden.
 *
 * Use case: the operator wants a fresh narration on a finding whose
 * cached paragraph feels stale, or the narrator failed earlier and the
 * cache is empty. Calls the Haiku narrator inline.
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
import { narrateDisagreements } from '@/lib/services/disagreement/narrate'

export const maxDuration = 60

export async function POST(
  _req: NextRequest,
  context: { params: Promise<{ id: string }> },
) {
  const { id } = await context.params
  if (!id || typeof id !== 'string') {
    return badRequest('finding id required in path')
  }
  const auth = await getPlatformAuth()
  if (!auth) return unauthorized()
  if (auth.isDemo) return forbidden('demo cannot narrate disagreements')
  if (!auth.venueId) return badRequest('caller has no resolved venue')

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
  // Force regenerate: clear cache then narrate one row.
  await supabase
    .from('disagreement_findings')
    .update({ narrator_text: null, narrator_generated_at: null })
    .eq('id', id)
  try {
    const result = await narrateDisagreements({ findingId: id })
    return NextResponse.json({ ok: true, result })
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    return NextResponse.json({ ok: false, error: message }, { status: 500 })
  }
}
