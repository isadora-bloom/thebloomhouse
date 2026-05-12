/**
 * POST /api/admin/people/[personId]/sticky-state
 *
 * Sticky-state Pattern 1 (migration 306). Coordinator locks a person-level
 * decision; downstream writers respect it.
 *
 * Body:
 *   {
 *     "field": "name_locked" | "preferred_contact_channel",
 *     "value": boolean | "email" | "sms" | "phone" | null,
 *     "note": string?
 *   }
 *
 * Auth: getPlatformAuth.
 */

import { NextRequest, NextResponse } from 'next/server'
import { getPlatformAuth } from '@/lib/api/auth-helpers'
import { createServiceClient } from '@/lib/supabase/service'

type Field = 'name_locked' | 'preferred_contact_channel'
const FIELDS: ReadonlyArray<Field> = ['name_locked', 'preferred_contact_channel']
const VALID_CHANNELS = ['email', 'sms', 'phone'] as const

interface Body {
  field?: string
  value?: unknown
  note?: string
}

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ personId: string }> },
): Promise<NextResponse> {
  const auth = await getPlatformAuth()
  if (!auth) {
    return NextResponse.json({ error: 'unauthorized' }, { status: 401 })
  }

  const { personId } = await params

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

  const { data: person } = await supabase
    .from('people')
    .select('id, venue_id')
    .eq('id', personId)
    .maybeSingle()
  if (!person) {
    return NextResponse.json({ error: 'not_found' }, { status: 404 })
  }
  if (!auth.isDemo && (person as { venue_id: string }).venue_id !== auth.venueId) {
    return NextResponse.json({ error: 'forbidden' }, { status: 403 })
  }

  const now = new Date().toISOString()
  const patch: Record<string, unknown> = { updated_at: now }

  if (field === 'name_locked') {
    const v = body.value === true
    patch.name_locked_by_operator = v
    patch.name_locked_at = v ? now : null
    patch.name_locked_by = v ? auth.userId : null
  } else if (field === 'preferred_contact_channel') {
    const v = body.value
    if (v === null) {
      patch.preferred_contact_channel = null
      patch.preferred_contact_channel_set_at = null
      patch.preferred_contact_channel_source = null
    } else if (typeof v === 'string' && (VALID_CHANNELS as readonly string[]).includes(v)) {
      patch.preferred_contact_channel = v
      patch.preferred_contact_channel_set_at = now
      patch.preferred_contact_channel_source = 'operator'
    } else {
      return NextResponse.json(
        { error: 'invalid_value', valid: [...VALID_CHANNELS, null] },
        { status: 400 },
      )
    }
  }

  const { error: updErr } = await supabase
    .from('people')
    .update(patch)
    .eq('id', personId)
  if (updErr) {
    return NextResponse.json(
      { error: 'update_failed', detail: updErr.message },
      { status: 500 },
    )
  }

  return NextResponse.json({ ok: true, field, applied: patch })
}
