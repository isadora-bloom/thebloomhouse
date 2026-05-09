import { NextRequest, NextResponse } from 'next/server'
import { getPlatformAuth } from '@/lib/api/auth-helpers'
import { requirePlan, planErrorBody } from '@/lib/auth/require-plan'
import { createServiceClient } from '@/lib/supabase/service'
import {
  getSourceRegistryEntry,
  SOURCE_REGISTRY,
} from '@/config/source-registry'

/**
 * GET /api/intel/sources/track
 *   Returns every tracked_sources row for the caller's venue, plus the
 *   curated registry so the page can render both halves in one fetch.
 *
 * POST /api/intel/sources/track
 *   Body: { source_key: string, expected_cadence_days?: number }
 *   Upserts a tracked_sources row (graveyard=false). Creates if
 *   missing, un-graveyards + updates cadence if previously tracked.
 *
 * DELETE /api/intel/sources/track?source_key=KEY
 *   Soft-untrack: flips graveyard=true. Row is preserved for audit /
 *   re-opt-in.
 */

interface TrackedRow {
  id: string
  venue_id: string
  source_key: string
  expected_cadence_days: number
  last_reminded_at: string | null
  last_dismissed_at: string | null
  graveyard: boolean
  created_at: string
  updated_at: string
}

export async function GET(request: NextRequest) {
  const plan = await requirePlan(request, 'pre_opening')
  if (!plan.ok) return NextResponse.json(planErrorBody(plan), { status: plan.status })

  const auth = await getPlatformAuth()
  if (!auth) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const sb = createServiceClient()
  const { data, error } = await sb
    .from('tracked_sources')
    .select(
      'id, venue_id, source_key, expected_cadence_days, last_reminded_at, last_dismissed_at, graveyard, created_at, updated_at',
    )
    .eq('venue_id', auth.venueId)
    .order('created_at', { ascending: true })

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 })
  }

  return NextResponse.json({
    tracked: (data ?? []) as TrackedRow[],
    registry: SOURCE_REGISTRY,
  })
}

export async function POST(request: NextRequest) {
  const plan = await requirePlan(request, 'pre_opening')
  if (!plan.ok) return NextResponse.json(planErrorBody(plan), { status: plan.status })

  const auth = await getPlatformAuth()
  if (!auth) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  let body: { source_key?: string; expected_cadence_days?: number }
  try {
    body = await request.json()
  } catch {
    return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 })
  }

  const sourceKey = (body.source_key ?? '').trim()
  if (!sourceKey) {
    return NextResponse.json({ error: 'source_key is required' }, { status: 400 })
  }

  const registryEntry = getSourceRegistryEntry(sourceKey)
  const cadence =
    typeof body.expected_cadence_days === 'number' && body.expected_cadence_days > 0
      ? Math.min(365, Math.round(body.expected_cadence_days))
      : registryEntry?.defaultCadenceDays ?? 30

  const sb = createServiceClient()

  // Upsert manually (avoid relying on PostgREST upsert semantics on the
  // partial unique index — the table's UNIQUE is on (venue_id, source_key)
  // unconditionally, so we do select-then-insert / update.
  const { data: existing } = await sb
    .from('tracked_sources')
    .select('id, graveyard, expected_cadence_days')
    .eq('venue_id', auth.venueId)
    .eq('source_key', sourceKey)
    .maybeSingle()

  if (existing) {
    const { error } = await sb
      .from('tracked_sources')
      .update({
        graveyard: false,
        expected_cadence_days: cadence,
      })
      .eq('id', (existing as { id: string }).id)
    if (error) return NextResponse.json({ error: error.message }, { status: 500 })
    return NextResponse.json({ ok: true, action: 'updated', source_key: sourceKey })
  }

  const { error } = await sb.from('tracked_sources').insert({
    venue_id: auth.venueId,
    source_key: sourceKey,
    expected_cadence_days: cadence,
    graveyard: false,
  })
  if (error) return NextResponse.json({ error: error.message }, { status: 500 })

  return NextResponse.json({ ok: true, action: 'inserted', source_key: sourceKey })
}

export async function DELETE(request: NextRequest) {
  const plan = await requirePlan(request, 'pre_opening')
  if (!plan.ok) return NextResponse.json(planErrorBody(plan), { status: plan.status })

  const auth = await getPlatformAuth()
  if (!auth) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const sourceKey = request.nextUrl.searchParams.get('source_key')?.trim()
  if (!sourceKey) {
    return NextResponse.json({ error: 'source_key is required' }, { status: 400 })
  }

  const sb = createServiceClient()
  const { error } = await sb
    .from('tracked_sources')
    .update({ graveyard: true })
    .eq('venue_id', auth.venueId)
    .eq('source_key', sourceKey)

  if (error) return NextResponse.json({ error: error.message }, { status: 500 })
  return NextResponse.json({ ok: true, action: 'untracked', source_key: sourceKey })
}
