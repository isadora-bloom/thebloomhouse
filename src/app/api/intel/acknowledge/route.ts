import { NextRequest, NextResponse } from 'next/server'
import { getPlatformAuth } from '@/lib/api/auth-helpers'
import { createServiceClient } from '@/lib/supabase/service'

/**
 * Tier-B #64A — generic intel-insight acknowledgment endpoint.
 *
 * POST /api/intel/acknowledge
 *   body: { kind: string, key: string, suppressDays?: number, note?: string }
 *   action: insert-or-update an intel_acknowledgments row keyed on
 *   (venue_id, kind, key). suppressDays default 7, max 365. note
 *   optional, capped at 500 chars.
 *
 * DELETE /api/intel/acknowledge
 *   body: { kind: string, key: string }
 *   action: clear the acknowledgment so the insight re-surfaces.
 *
 * GET /api/intel/acknowledge?kind=forecasts.q3_dropoff
 *   list active (suppress_until > now) acknowledgments for the kind,
 *   for the calling venue. Useful for the render path to short-circuit
 *   without a per-insight DB call.
 */

const MAX_SUPPRESS_DAYS = 365
const MAX_NOTE_LEN = 500

export async function POST(req: NextRequest) {
  const auth = await getPlatformAuth()
  if (!auth) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  if (!auth.venueId || !auth.userId) {
    return NextResponse.json({ error: 'Venue or user not resolved' }, { status: 400 })
  }

  const body = (await req.json().catch(() => null)) as
    | { kind?: string; key?: string; suppressDays?: number; note?: string }
    | null

  if (!body?.kind || !body?.key) {
    return NextResponse.json(
      { error: 'kind and key are required strings' },
      { status: 400 },
    )
  }
  if (typeof body.kind !== 'string' || typeof body.key !== 'string') {
    return NextResponse.json({ error: 'kind and key must be strings' }, { status: 400 })
  }

  const days = Math.max(
    1,
    Math.min(MAX_SUPPRESS_DAYS, Math.round(body.suppressDays ?? 7)),
  )
  const suppressUntil = new Date(Date.now() + days * 24 * 60 * 60 * 1000).toISOString()
  const note = body.note ? body.note.slice(0, MAX_NOTE_LEN) : null

  const supabase = createServiceClient()
  const { error } = await supabase
    .from('intel_acknowledgments')
    .upsert(
      {
        venue_id: auth.venueId,
        insight_kind: body.kind,
        insight_key: body.key,
        acknowledged_at: new Date().toISOString(),
        acknowledged_by: auth.userId,
        suppress_until: suppressUntil,
        note,
      },
      { onConflict: 'venue_id,insight_kind,insight_key' },
    )

  if (error) {
    console.error('[intel/acknowledge POST]', error)
    return NextResponse.json({ error: 'Failed to acknowledge' }, { status: 500 })
  }
  return NextResponse.json({ ok: true, suppressUntil })
}

export async function DELETE(req: NextRequest) {
  const auth = await getPlatformAuth()
  if (!auth) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  if (!auth.venueId) return NextResponse.json({ error: 'Venue not resolved' }, { status: 400 })

  const body = (await req.json().catch(() => null)) as
    | { kind?: string; key?: string }
    | null
  if (!body?.kind || !body?.key) {
    return NextResponse.json({ error: 'kind and key are required' }, { status: 400 })
  }

  const supabase = createServiceClient()
  const { error } = await supabase
    .from('intel_acknowledgments')
    .delete()
    .eq('venue_id', auth.venueId)
    .eq('insight_kind', body.kind)
    .eq('insight_key', body.key)
  if (error) {
    console.error('[intel/acknowledge DELETE]', error)
    return NextResponse.json({ error: 'Failed to clear' }, { status: 500 })
  }
  return NextResponse.json({ ok: true })
}

export async function GET(req: NextRequest) {
  const auth = await getPlatformAuth()
  if (!auth) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  if (!auth.venueId) return NextResponse.json({ error: 'Venue not resolved' }, { status: 400 })

  const kind = req.nextUrl.searchParams.get('kind')
  const supabase = createServiceClient()

  let query = supabase
    .from('intel_acknowledgments')
    .select('insight_kind, insight_key, acknowledged_at, suppress_until, note')
    .eq('venue_id', auth.venueId)
    .gt('suppress_until', new Date().toISOString())
    .order('acknowledged_at', { ascending: false })

  if (kind) query = query.eq('insight_kind', kind)

  const { data, error } = await query
  if (error) {
    console.error('[intel/acknowledge GET]', error)
    return NextResponse.json({ error: 'Failed to load' }, { status: 500 })
  }
  return NextResponse.json({ acknowledgments: data ?? [] })
}
