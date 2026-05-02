/**
 * POST /api/settings/essentials-preferences/log (T4-D).
 *
 * Slider-action telemetry. Coordinator dismisses a card / expands a
 * detail / changes the slider — fire-and-forget log row that the
 * suggestion engine queries to recommend default-level adjustments.
 */

import { NextRequest, NextResponse } from 'next/server'
import { createServiceClient } from '@/lib/supabase/service'
import { getPlatformAuth } from '@/lib/api/auth-helpers'
import { ESSENTIALS_LEVELS, type EssentialsLevel } from '@/lib/hooks/use-essentials-level'

const VALID_ACTIONS = new Set(['dismissed_card', 'expanded_card', 'changed_level', 'reset_to_default'])

export async function POST(request: NextRequest) {
  const auth = await getPlatformAuth()
  if (!auth) return NextResponse.json({ error: 'unauthorized' }, { status: 401 })

  let body: { surface?: string; level_at_action?: string; action?: string; metadata?: Record<string, unknown> }
  try {
    body = await request.json()
  } catch {
    return NextResponse.json({ error: 'invalid_json' }, { status: 400 })
  }
  if (!body.surface || typeof body.surface !== 'string' || body.surface.length > 120) {
    return NextResponse.json({ error: 'invalid_surface' }, { status: 400 })
  }
  if (!body.level_at_action || !ESSENTIALS_LEVELS.includes(body.level_at_action as EssentialsLevel)) {
    return NextResponse.json({ error: 'invalid_level_at_action' }, { status: 400 })
  }
  if (!body.action || !VALID_ACTIONS.has(body.action)) {
    return NextResponse.json({ error: 'invalid_action' }, { status: 400 })
  }

  const supabase = createServiceClient()
  const { error } = await supabase.from('essentials_action_log').insert({
    user_id: auth.userId,
    venue_id: auth.venueId,
    surface: body.surface,
    level_at_action: body.level_at_action,
    action: body.action,
    metadata: body.metadata ?? {},
  })
  if (error) return NextResponse.json({ error: error.message }, { status: 500 })
  return NextResponse.json({ ok: true })
}
