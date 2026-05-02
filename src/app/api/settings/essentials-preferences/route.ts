/**
 * /api/settings/essentials-preferences (T4-D).
 *
 * GET   — caller's preferences (created with defaults on first read)
 * PATCH — partial update of default_level + surface_overrides
 */

import { NextRequest, NextResponse } from 'next/server'
import { createServiceClient } from '@/lib/supabase/service'
import { getPlatformAuth } from '@/lib/api/auth-helpers'
import { ESSENTIALS_LEVELS, type EssentialsLevel } from '@/lib/hooks/use-essentials-level'

interface PrefsRow {
  id: string
  user_id: string
  venue_id: string
  default_level: EssentialsLevel
  surface_overrides: Record<string, EssentialsLevel>
}

async function getOrCreate(supabase: ReturnType<typeof createServiceClient>, userId: string, venueId: string): Promise<PrefsRow> {
  const { data: existing } = await supabase
    .from('essentials_preferences')
    .select('*')
    .eq('user_id', userId)
    .eq('venue_id', venueId)
    .maybeSingle()
  if (existing) return existing as PrefsRow

  const { data: inserted, error } = await supabase
    .from('essentials_preferences')
    .insert({ user_id: userId, venue_id: venueId, default_level: 'recommended', surface_overrides: {} })
    .select('*')
    .single()
  if (inserted) return inserted as PrefsRow

  // Race: re-fetch.
  if (error?.code === '23505') {
    const { data: refetch } = await supabase
      .from('essentials_preferences')
      .select('*')
      .eq('user_id', userId)
      .eq('venue_id', venueId)
      .single()
    if (refetch) return refetch as PrefsRow
  }
  throw new Error(error?.message ?? 'failed to get-or-create essentials_preferences')
}

export async function GET() {
  const auth = await getPlatformAuth()
  if (!auth) return NextResponse.json({ error: 'unauthorized' }, { status: 401 })
  const supabase = createServiceClient()
  try {
    const prefs = await getOrCreate(supabase, auth.userId, auth.venueId)
    return NextResponse.json(prefs)
  } catch (err) {
    return NextResponse.json({ error: err instanceof Error ? err.message : 'load_failed' }, { status: 500 })
  }
}

export async function PATCH(request: NextRequest) {
  const auth = await getPlatformAuth()
  if (!auth) return NextResponse.json({ error: 'unauthorized' }, { status: 401 })

  let body: { default_level?: string; surface_overrides?: Record<string, string> }
  try {
    body = await request.json()
  } catch {
    return NextResponse.json({ error: 'invalid_json' }, { status: 400 })
  }

  const patch: Partial<PrefsRow> = {}
  if (body.default_level !== undefined) {
    if (!ESSENTIALS_LEVELS.includes(body.default_level as EssentialsLevel)) {
      return NextResponse.json({ error: 'invalid_default_level' }, { status: 400 })
    }
    patch.default_level = body.default_level as EssentialsLevel
  }
  if (body.surface_overrides !== undefined) {
    if (typeof body.surface_overrides !== 'object' || body.surface_overrides === null) {
      return NextResponse.json({ error: 'invalid_surface_overrides' }, { status: 400 })
    }
    const cleaned: Record<string, EssentialsLevel> = {}
    for (const [k, v] of Object.entries(body.surface_overrides)) {
      if (typeof k !== 'string' || k.length > 120) continue
      if (!ESSENTIALS_LEVELS.includes(v as EssentialsLevel)) continue
      cleaned[k] = v as EssentialsLevel
    }
    patch.surface_overrides = cleaned
  }

  if (Object.keys(patch).length === 0) {
    return NextResponse.json({ error: 'no_mutable_fields' }, { status: 400 })
  }

  const supabase = createServiceClient()
  try {
    await getOrCreate(supabase, auth.userId, auth.venueId)
    const { data, error } = await supabase
      .from('essentials_preferences')
      .update(patch)
      .eq('user_id', auth.userId)
      .eq('venue_id', auth.venueId)
      .select('*')
      .single()
    if (error || !data) throw new Error(error?.message ?? 'update_failed')
    return NextResponse.json(data)
  } catch (err) {
    return NextResponse.json({ error: err instanceof Error ? err.message : 'update_failed' }, { status: 500 })
  }
}
