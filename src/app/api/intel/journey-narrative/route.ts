import { NextRequest, NextResponse } from 'next/server'
import { getPlatformAuth } from '@/lib/api/auth-helpers'
import { createServiceClient } from '@/lib/supabase/service'
import { generateOrFetch } from '@/lib/services/journey-narrative'
import { requirePlan, planErrorBody } from '@/lib/auth/require-plan'

/**
 * Journey narrative endpoint (Phase C / PC.3).
 *
 *   GET  /api/intel/journey-narrative?wedding_id=UUID
 *     Returns the cached or freshly-generated narrative.
 *
 *   POST /api/intel/journey-narrative
 *     Body: { wedding_id, force?: boolean, pin?: boolean }
 *     force=true regenerates regardless of freshness.
 *     pin=true sets pinned=true on the row so future fetches don't
 *     auto-regenerate.
 */

export async function GET(req: NextRequest) {
  // GAP-12: API-layer plan_tier enforcement BEFORE any DB reads.
  const plan = await requirePlan(req, 'solo')
  if (!plan.ok) return NextResponse.json(planErrorBody(plan), { status: plan.status })

  const auth = await getPlatformAuth()
  if (!auth) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  const weddingId = req.nextUrl.searchParams.get('wedding_id')
  if (!weddingId) return NextResponse.json({ error: 'wedding_id required' }, { status: 400 })

  const supabase = createServiceClient()
  const { data: wed } = await supabase
    .from('weddings')
    .select('id, venue_id')
    .eq('id', weddingId)
    .single()
  const w = wed as { id: string; venue_id: string } | null
  if (!w) return NextResponse.json({ error: 'wedding not found' }, { status: 404 })
  if (w.venue_id !== auth.venueId) {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
  }

  try {
    const narrative = await generateOrFetch(supabase, weddingId)
    if (!narrative) {
      return NextResponse.json({ narrative: null })
    }
    return NextResponse.json({ narrative })
  } catch (err) {
    console.error('[journey-narrative GET]', err)
    return NextResponse.json(
      { error: err instanceof Error ? err.message : 'Failed to generate narrative' },
      { status: 500 },
    )
  }
}

export async function POST(req: NextRequest) {
  // GAP-12: API-layer plan_tier enforcement BEFORE any DB reads.
  const plan = await requirePlan(req, 'solo')
  if (!plan.ok) return NextResponse.json(planErrorBody(plan), { status: plan.status })

  const auth = await getPlatformAuth()
  if (!auth) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const body = await req.json().catch(() => null) as
    | { wedding_id?: string; force?: boolean; pin?: boolean }
    | null
  if (!body || !body.wedding_id) {
    return NextResponse.json({ error: 'wedding_id required' }, { status: 400 })
  }

  const supabase = createServiceClient()
  const { data: wed } = await supabase
    .from('weddings')
    .select('id, venue_id')
    .eq('id', body.wedding_id)
    .single()
  const w = wed as { id: string; venue_id: string } | null
  if (!w) return NextResponse.json({ error: 'wedding not found' }, { status: 404 })
  if (w.venue_id !== auth.venueId) {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
  }

  if (typeof body.pin === 'boolean') {
    // PC.4 fix #10: verify the row exists before reporting success.
    // Otherwise pinning a wedding with no narrative yet returns
    // ok: true and silently does nothing.
    const { data: row } = await supabase
      .from('wedding_journey_narratives')
      .select('id')
      .eq('wedding_id', body.wedding_id)
      .single()
    if (!row) {
      return NextResponse.json(
        { error: 'No narrative exists for this wedding yet. Generate one first.' },
        { status: 404 },
      )
    }
    const { error } = await supabase
      .from('wedding_journey_narratives')
      .update({ pinned: body.pin })
      .eq('wedding_id', body.wedding_id)
    if (error) return NextResponse.json({ error: error.message }, { status: 500 })
    return NextResponse.json({ ok: true, pinned: body.pin })
  }

  try {
    const narrative = await generateOrFetch(supabase, body.wedding_id, body.force === true)
    return NextResponse.json({ narrative })
  } catch (err) {
    console.error('[journey-narrative POST]', err)
    return NextResponse.json(
      { error: err instanceof Error ? err.message : 'Failed to generate narrative' },
      { status: 500 },
    )
  }
}
