/**
 * /api/settings/digest-preferences (T4-H).
 *
 * GET — caller's preferences for current venue (created on first read
 *        with defaults via getOrCreateDefault)
 * PATCH — partial update of mutable fields
 */

import { NextRequest, NextResponse } from 'next/server'
import { createServiceClient } from '@/lib/supabase/service'
import { getPlatformAuth } from '@/lib/api/auth-helpers'
import { getOrCreateDefault, updatePreferences, type DigestPreferences } from '@/lib/services/digest-preferences'

const MUTABLE_FIELDS: Array<keyof DigestPreferences> = [
  'cadence',
  'send_time_local',
  'send_dow',
  'include_lead_conversion',
  'include_pricing',
  'include_source_attribution',
  'include_anomalies',
  'include_macro_correlations',
  'include_self_knowledge',
  'channel_email',
  'channel_in_app',
]

export async function GET() {
  const auth = await getPlatformAuth()
  if (!auth) return NextResponse.json({ error: 'unauthorized' }, { status: 401 })
  const supabase = createServiceClient()
  try {
    const prefs = await getOrCreateDefault(supabase, auth.userId, auth.venueId)
    return NextResponse.json(prefs)
  } catch (err) {
    return NextResponse.json({ error: err instanceof Error ? err.message : 'load_failed' }, { status: 500 })
  }
}

export async function PATCH(request: NextRequest) {
  const auth = await getPlatformAuth()
  if (!auth) return NextResponse.json({ error: 'unauthorized' }, { status: 401 })

  let body: Record<string, unknown>
  try {
    body = await request.json()
  } catch {
    return NextResponse.json({ error: 'invalid_json' }, { status: 400 })
  }

  // Whitelist the patch — only mutable fields, ignore anything else.
  const patch: Partial<DigestPreferences> = {}
  for (const k of MUTABLE_FIELDS) {
    if (k in body) (patch as Record<string, unknown>)[k] = body[k]
  }
  if (Object.keys(patch).length === 0) {
    return NextResponse.json({ error: 'no_mutable_fields' }, { status: 400 })
  }

  // Validate cadence + send_dow + send_time_local before write.
  if (patch.cadence !== undefined && !['off', 'daily', 'weekly', 'biweekly'].includes(patch.cadence as string)) {
    return NextResponse.json({ error: 'invalid_cadence' }, { status: 400 })
  }
  if (patch.send_dow !== undefined) {
    const d = Number(patch.send_dow)
    if (!Number.isInteger(d) || d < 0 || d > 6) {
      return NextResponse.json({ error: 'invalid_send_dow' }, { status: 400 })
    }
  }
  if (patch.send_time_local !== undefined && typeof patch.send_time_local !== 'string') {
    return NextResponse.json({ error: 'invalid_send_time_local' }, { status: 400 })
  }

  const supabase = createServiceClient()
  try {
    // Ensure row exists first.
    await getOrCreateDefault(supabase, auth.userId, auth.venueId)
    const updated = await updatePreferences(supabase, {
      userId: auth.userId,
      venueId: auth.venueId,
      patch,
    })
    return NextResponse.json(updated)
  } catch (err) {
    return NextResponse.json({ error: err instanceof Error ? err.message : 'update_failed' }, { status: 500 })
  }
}
