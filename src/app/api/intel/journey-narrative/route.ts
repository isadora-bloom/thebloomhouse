import { NextRequest, NextResponse } from 'next/server'
import { getPlatformAuth } from '@/lib/api/auth-helpers'
import { createServiceClient } from '@/lib/supabase/service'
import { generateOrFetch } from '@/lib/services/brain/journey-narrative'
import { loadCoupleKeyForWedding } from '@/lib/intel/readers/couple-key'
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
 *
 * W64: both verbs used to prove the caller owned the wedding by reading
 * `weddings` and comparing venue_id in JavaScript. The narrative is a
 * per-couple fact, so the scope check is now a per-couple read: one
 * `couples` lookup on `source_wedding_id`, filtered by the venue auth
 * already resolved. Same guarantee, on the spine, and it hands back the
 * couple id so the response can say which identity it spoke about.
 * A wedding with no couple mirrored onto the spine is out of scope here
 * rather than "not found" — nothing on the spine can describe it yet.
 */

/** One place for the scope check both verbs run. Returns the couple when
 *  the caller's venue owns it, or the response to send back when not. */
async function scopeToCouple(weddingId: string, venueId: string | null) {
  if (!venueId) {
    return { couple: null, deny: NextResponse.json({ error: 'caller has no resolved venue' }, { status: 400 }) }
  }
  const couple = await loadCoupleKeyForWedding(createServiceClient(), venueId, weddingId)
  if (!couple) {
    return {
      couple: null,
      deny: NextResponse.json({ error: 'couple not in venue scope' }, { status: 404 }),
    }
  }
  return { couple, deny: null }
}

export async function GET(req: NextRequest) {
  // GAP-12: API-layer plan_tier enforcement BEFORE any DB reads.
  const plan = await requirePlan(req, 'pre_opening')
  if (!plan.ok) return NextResponse.json(planErrorBody(plan), { status: plan.status })

  const auth = await getPlatformAuth()
  if (!auth) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  const weddingId = req.nextUrl.searchParams.get('wedding_id')
  if (!weddingId) return NextResponse.json({ error: 'wedding_id required' }, { status: 400 })

  const { deny } = await scopeToCouple(weddingId, auth.venueId)
  if (deny) return deny

  const supabase = createServiceClient()

  // Tier-C #129 — journey narrative pulls full wedding history
  // (interactions + touchpoints + drafts). Tier-1 read.
  if (!auth.isDemo) {
    const { logRead } = await import('@/lib/services/activity-logger')
    void logRead({
      venueId: auth.venueId,
      weddingId,
      userId: auth.userId,
      resource: 'journey_narrative',
      mode: 'bulk_read',
      rowCount: 1,
    })
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
  const plan = await requirePlan(req, 'pre_opening')
  if (!plan.ok) return NextResponse.json(planErrorBody(plan), { status: plan.status })

  const auth = await getPlatformAuth()
  if (!auth) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const body = await req.json().catch(() => null) as
    | { wedding_id?: string; force?: boolean; pin?: boolean }
    | null
  if (!body || !body.wedding_id) {
    return NextResponse.json({ error: 'wedding_id required' }, { status: 400 })
  }

  const { deny } = await scopeToCouple(body.wedding_id, auth.venueId)
  if (deny) return deny

  const supabase = createServiceClient()

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
