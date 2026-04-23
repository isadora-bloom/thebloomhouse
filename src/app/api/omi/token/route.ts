/**
 * /api/omi/token
 *
 * Phase 7 Task 61. Per-venue Omi webhook token management.
 *
 *   GET  → { token: string | null } for the caller's venue
 *   POST → rotates the token: generates a fresh UUID, writes it to
 *          venue_config.omi_webhook_token, returns { token }
 *
 * Requires venue_admin / manager / org_admin / super_admin. Demo sessions
 * get a read-only view (POST is blocked).
 *
 * Pairing flow for the coordinator:
 *   1. POST /api/omi/token → receive `token`
 *   2. Paste `<host>/api/omi/webhook?token=<token>` into the Omi app's
 *      Developer Settings.
 *   3. Omi fires segments → they land on the matched tour.
 *
 * Rotation is destructive: once POSTed, the previous URL stops working
 * immediately. The Settings page confirms before calling this.
 */

import { NextResponse } from 'next/server'
import { getPlatformAuth } from '@/lib/api/auth-helpers'
import { createServiceClient } from '@/lib/supabase/service'
import crypto from 'node:crypto'

const ALLOWED_ROLES = new Set([
  'coordinator',
  'manager',
  'org_admin',
  'super_admin',
])

export async function GET() {
  const auth = await getPlatformAuth()
  if (!auth) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  if (!ALLOWED_ROLES.has(auth.role)) {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
  }

  const service = createServiceClient()
  const { data, error } = await service
    .from('venue_config')
    .select('omi_webhook_token, omi_auto_match_enabled, omi_match_window_hours')
    .eq('venue_id', auth.venueId)
    .maybeSingle()

  if (error) {
    console.error('[api/omi/token] GET error:', error.message)
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }

  return NextResponse.json({
    token: (data?.omi_webhook_token as string | null) ?? null,
    autoMatchEnabled: data?.omi_auto_match_enabled !== false,
    matchWindowHours:
      typeof data?.omi_match_window_hours === 'number'
        ? data.omi_match_window_hours
        : 6,
  })
}

export async function POST() {
  const auth = await getPlatformAuth()
  if (!auth) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  if (!ALLOWED_ROLES.has(auth.role)) {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
  }
  if (auth.isDemo) {
    return NextResponse.json(
      { error: 'Token rotation is disabled in demo mode' },
      { status: 403 }
    )
  }

  const service = createServiceClient()
  const token = crypto.randomUUID()

  // venue_config row exists per venue; update is safe. If missing (newly
  // onboarded venue that skipped config seed) we upsert so the admin
  // isn't blocked.
  const { error: updErr } = await service
    .from('venue_config')
    .upsert(
      {
        venue_id: auth.venueId,
        omi_webhook_token: token,
      },
      { onConflict: 'venue_id' }
    )

  if (updErr) {
    console.error('[api/omi/token] POST error:', updErr.message)
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }

  return NextResponse.json({ token })
}

export async function PATCH(request: Request) {
  const auth = await getPlatformAuth()
  if (!auth) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  if (!ALLOWED_ROLES.has(auth.role)) {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
  }

  const body = await request.json().catch(() => null)
  if (!body || typeof body !== 'object') {
    return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 })
  }

  const update: Record<string, unknown> = { venue_id: auth.venueId }

  if ('autoMatchEnabled' in body) {
    update.omi_auto_match_enabled = Boolean(
      (body as { autoMatchEnabled?: unknown }).autoMatchEnabled
    )
  }
  if ('matchWindowHours' in body) {
    const raw = Number((body as { matchWindowHours?: unknown }).matchWindowHours)
    if (!Number.isFinite(raw) || raw < 3 || raw > 24) {
      return NextResponse.json(
        { error: 'matchWindowHours must be between 3 and 24' },
        { status: 400 }
      )
    }
    update.omi_match_window_hours = Math.round(raw)
  }

  if (Object.keys(update).length === 1) {
    return NextResponse.json({ error: 'No fields to update' }, { status: 400 })
  }

  const service = createServiceClient()
  const { error: upErr } = await service
    .from('venue_config')
    .upsert(update, { onConflict: 'venue_id' })

  if (upErr) {
    console.error('[api/omi/token] PATCH error:', upErr.message)
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }

  return NextResponse.json({ success: true })
}
