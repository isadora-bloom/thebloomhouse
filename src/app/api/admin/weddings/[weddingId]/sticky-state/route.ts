/**
 * POST /api/admin/weddings/[weddingId]/sticky-state
 *
 * Sticky-state Pattern 1 (migration 306). Coordinator declares a sticky
 * decision about a couple; downstream auto-derive / LLM / sequences
 * respect it.
 *
 * Body:
 *   {
 *     "field": "has_toured_in_person" | "wedding_date_locked" |
 *              "lost_locked" | "day_of_timeline_locked" |
 *              "ceremony_start_confirmed" | "reception_end_confirmed",
 *     "value": boolean | iso8601 | null,
 *     "note": string?            // optional, recorded in lifecycle_events
 *   }
 *
 * Behaviour:
 *   - Boolean fields: value=true stamps the *_locked + *_locked_at +
 *     *_locked_by (or *_confirmed_at + *_confirmed_by for the timeline
 *     fields). value=false clears all three.
 *   - has_toured_in_person: special — stamps the bool + has_toured_in_person_at.
 *     value=false reverts both (rare; for correcting a mistaken stamp).
 *
 * Auth: getPlatformAuth — operator overrides require a named coordinator.
 */

import { NextRequest, NextResponse } from 'next/server'
import { getPlatformAuth } from '@/lib/api/auth-helpers'
import { createServiceClient } from '@/lib/supabase/service'

type Field =
  | 'has_toured_in_person'
  | 'wedding_date_locked'
  | 'lost_locked'
  | 'day_of_timeline_locked'
  | 'ceremony_start_confirmed'
  | 'reception_end_confirmed'

const FIELDS: ReadonlyArray<Field> = [
  'has_toured_in_person',
  'wedding_date_locked',
  'lost_locked',
  'day_of_timeline_locked',
  'ceremony_start_confirmed',
  'reception_end_confirmed',
]

interface Body {
  field?: string
  value?: unknown
  note?: string
}

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ weddingId: string }> },
): Promise<NextResponse> {
  const auth = await getPlatformAuth()
  if (!auth) {
    return NextResponse.json({ error: 'unauthorized' }, { status: 401 })
  }

  const { weddingId } = await params

  let body: Body
  try {
    body = (await request.json()) as Body
  } catch {
    return NextResponse.json({ error: 'invalid_json' }, { status: 400 })
  }

  const field = body.field
  if (!field || !FIELDS.includes(field as Field)) {
    return NextResponse.json(
      { error: 'invalid_field', valid: FIELDS },
      { status: 400 },
    )
  }

  const supabase = createServiceClient()

  const { data: wedding } = await supabase
    .from('weddings')
    .select('id, venue_id')
    .eq('id', weddingId)
    .maybeSingle()
  if (!wedding) {
    return NextResponse.json({ error: 'not_found' }, { status: 404 })
  }
  if (!auth.isDemo && (wedding as { venue_id: string }).venue_id !== auth.venueId) {
    return NextResponse.json({ error: 'forbidden' }, { status: 403 })
  }

  const now = new Date().toISOString()
  const patch: Record<string, unknown> = { updated_at: now }

  if (field === 'has_toured_in_person') {
    const v = body.value === true
    patch.has_toured_in_person = v
    patch.has_toured_in_person_at = v ? now : null
  } else if (field === 'wedding_date_locked') {
    const v = body.value === true
    patch.wedding_date_locked_by_operator = v
    patch.wedding_date_locked_at = v ? now : null
    patch.wedding_date_locked_by = v ? auth.userId : null
  } else if (field === 'lost_locked') {
    const v = body.value === true
    patch.lost_locked_by_operator = v
    patch.lost_locked_at = v ? now : null
    patch.lost_locked_by = v ? auth.userId : null
  } else if (field === 'day_of_timeline_locked') {
    const v = body.value === true
    patch.day_of_timeline_locked = v
    patch.day_of_timeline_locked_at = v ? now : null
    patch.day_of_timeline_locked_by = v ? auth.userId : null
  } else if (field === 'ceremony_start_confirmed') {
    const v = body.value === true
    patch.ceremony_start_confirmed_at = v ? now : null
    patch.ceremony_start_confirmed_by = v ? auth.userId : null
  } else if (field === 'reception_end_confirmed') {
    const v = body.value === true
    patch.reception_end_confirmed_at = v ? now : null
    patch.reception_end_confirmed_by = v ? auth.userId : null
  }

  const { error: updErr } = await supabase
    .from('weddings')
    .update(patch)
    .eq('id', weddingId)
  if (updErr) {
    return NextResponse.json(
      { error: 'update_failed', detail: updErr.message },
      { status: 500 },
    )
  }

  // Audit row. `wedding_lifecycle_events` shape: signal NOT NULL,
  // detected_by NOT NULL CHECK ('ai'|'pipeline'|'coordinator'|'webhook'
  // |'cron'|'backfill'), reason text — verified against migration 246.
  await supabase.from('wedding_lifecycle_events').insert({
    wedding_id: weddingId,
    venue_id: (wedding as { venue_id: string }).venue_id,
    signal: `sticky_state:${field}=${String(body.value)}`,
    detected_by: 'coordinator',
    reason: body.note?.slice(0, 500) ?? null,
  })

  return NextResponse.json({ ok: true, field, applied: patch })
}
