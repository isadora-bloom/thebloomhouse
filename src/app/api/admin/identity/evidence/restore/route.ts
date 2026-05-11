/**
 * Wave 15 — restore (un-dismiss) an evidence override.
 *
 * POST /api/admin/identity/evidence/restore
 *
 * Body: { overrideId: string }
 *
 * Sets active=false (Constitution: never hard-delete). The next
 * reconstruction will see the evidence again.
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

export async function POST(req: NextRequest) {
  const auth = await getPlatformAuth()
  if (!auth) return unauthorized()
  if (auth.isDemo) return forbidden('demo cannot restore evidence overrides')
  if (!auth.venueId) return badRequest('caller has no resolved venue')

  let body: { overrideId?: string } = {}
  try {
    body = (await req.json()) as { overrideId?: string }
  } catch {
    body = {}
  }
  const overrideId = typeof body.overrideId === 'string' ? body.overrideId : null
  if (!overrideId) return badRequest('overrideId required')

  const supabase = createServiceClient()

  const { data: row } = await supabase
    .from('evidence_overrides')
    .select('venue_id, active')
    .eq('id', overrideId)
    .maybeSingle()
  if (!row) return notFound('evidence_override')
  const r = row as { venue_id: string; active: boolean }
  if (r.venue_id !== auth.venueId) {
    return forbidden('override does not belong to your venue')
  }

  const { error } = await supabase
    .from('evidence_overrides')
    .update({ active: false })
    .eq('id', overrideId)
  if (error) {
    return NextResponse.json(
      { ok: false, error: `restore failed: ${error.message}` },
      { status: 500 },
    )
  }
  return NextResponse.json({ ok: true, overrideId })
}
