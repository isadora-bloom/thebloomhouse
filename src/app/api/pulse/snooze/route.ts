/**
 * /api/pulse/snooze (T4-C).
 *
 * POST   body: { itemKey, action, snoozedUntilIso?, reason? }
 *        → upsert a snooze/dismiss for the caller's venue.
 * DELETE ?itemKey=... → un-snooze (delete the row); item re-surfaces.
 *
 * Auth: getPlatformAuth.
 */

import { NextRequest, NextResponse } from 'next/server'
import { createServiceClient } from '@/lib/supabase/service'
import { getPlatformAuth } from '@/lib/api/auth-helpers'

const VALID_ITEM_KEY = /^(notif|anomaly|insight):[0-9a-f-]{36}$/i

export async function POST(request: NextRequest) {
  const auth = await getPlatformAuth()
  if (!auth) return NextResponse.json({ error: 'unauthorized' }, { status: 401 })

  let body: { itemKey?: string; action?: string; snoozedUntilIso?: string; reason?: string }
  try {
    body = await request.json()
  } catch {
    return NextResponse.json({ error: 'invalid_json' }, { status: 400 })
  }

  if (!body.itemKey || !VALID_ITEM_KEY.test(body.itemKey)) {
    return NextResponse.json({ error: 'invalid_item_key' }, { status: 400 })
  }
  if (body.action !== 'snoozed' && body.action !== 'dismissed') {
    return NextResponse.json({ error: 'action_must_be_snoozed_or_dismissed' }, { status: 400 })
  }

  let snoozedUntil: string | null = null
  if (body.action === 'snoozed') {
    const t = body.snoozedUntilIso ? Date.parse(body.snoozedUntilIso) : NaN
    if (!Number.isFinite(t) || t <= Date.now()) {
      return NextResponse.json({ error: 'snoozed_until_must_be_future_iso' }, { status: 400 })
    }
    if (t - Date.now() > 365 * 86_400_000) {
      return NextResponse.json({ error: 'snoozed_until_too_far' }, { status: 400 })
    }
    snoozedUntil = new Date(t).toISOString()
  }

  const supabase = createServiceClient()
  const { error } = await supabase
    .from('pulse_snoozes')
    .upsert(
      {
        venue_id: auth.venueId,
        user_id: auth.userId,
        item_key: body.itemKey,
        action: body.action,
        snoozed_until: snoozedUntil,
        reason: body.reason?.trim().slice(0, 240) ?? null,
      },
      { onConflict: 'venue_id,item_key' },
    )
  if (error) return NextResponse.json({ error: error.message }, { status: 500 })
  return NextResponse.json({ ok: true })
}

export async function DELETE(request: NextRequest) {
  const auth = await getPlatformAuth()
  if (!auth) return NextResponse.json({ error: 'unauthorized' }, { status: 401 })

  const itemKey = request.nextUrl.searchParams.get('itemKey')
  if (!itemKey || !VALID_ITEM_KEY.test(itemKey)) {
    return NextResponse.json({ error: 'invalid_item_key' }, { status: 400 })
  }

  const supabase = createServiceClient()
  const { error } = await supabase
    .from('pulse_snoozes')
    .delete()
    .eq('venue_id', auth.venueId)
    .eq('item_key', itemKey)
  if (error) return NextResponse.json({ error: error.message }, { status: 500 })
  return NextResponse.json({ ok: true })
}
