import { NextRequest, NextResponse } from 'next/server'
import { getPlatformAuth } from '@/lib/api/auth-helpers'
import { createServiceClient } from '@/lib/supabase/service'
import { recomputeFirstTouch } from '@/lib/services/candidate-resolver'
import { normalizeSource } from '@/lib/services/normalize-source'

/**
 * Attribution mutation endpoint (Phase B / PB.12 fixes #2 + #3).
 *
 *   POST /api/intel/attribution
 *     Body shapes:
 *       { action: 'revert',  attribution_event_id }
 *         — sets reverted_at on the row, then recomputes is_first_touch
 *           across remaining live rows for that wedding. Without this
 *           recompute, reverting the first-touch row leaves the wedding
 *           with no first-touch until a new signal arrives.
 *       { action: 'accept_computed', attribution_event_id }
 *         — coordinator decides the computed first-touch is correct
 *           when there's a conflict. Overwrites weddings.source with
 *           the normalized computed platform, clears the
 *           conflict_with_legacy_source flag on the row, leaves the
 *           audit trail intact.
 *       { action: 'accept_legacy', attribution_event_id }
 *         — coordinator decides the legacy weddings.source is correct.
 *           Reverts the attribution_event row + recomputes first-touch
 *           the same way 'revert' does, plus clears the conflict flag
 *           on any sibling rows for the same wedding so the queue
 *           item disappears.
 *
 * RLS: writes via service client after auth.venueId check matches the
 * row's venue. The attribution_events table has the venue_id denormalized
 * so the check is a single fetch.
 */

interface RevertBody {
  action: 'revert' | 'accept_legacy'
  attribution_event_id: string
}
interface AcceptComputedBody {
  action: 'accept_computed'
  attribution_event_id: string
}

export async function POST(req: NextRequest) {
  const auth = await getPlatformAuth()
  if (!auth) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  let body: RevertBody | AcceptComputedBody
  try {
    body = await req.json()
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 })
  }
  if (!body.attribution_event_id) {
    return NextResponse.json({ error: 'attribution_event_id required' }, { status: 400 })
  }

  const supabase = createServiceClient()

  // Verify the row belongs to a venue the caller has access to.
  const { data: row, error: rowErr } = await supabase
    .from('attribution_events')
    .select('id, venue_id, wedding_id, source_platform, conflict_with_legacy_source, reverted_at')
    .eq('id', body.attribution_event_id)
    .single()
  if (rowErr || !row) {
    return NextResponse.json({ error: 'attribution_event not found' }, { status: 404 })
  }
  const r = row as {
    id: string
    venue_id: string
    wedding_id: string
    source_platform: string
    conflict_with_legacy_source: string | null
    reverted_at: string | null
  }
  if (r.venue_id !== auth.venueId) {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
  }

  if (body.action === 'revert' || body.action === 'accept_legacy') {
    if (!r.reverted_at) {
      const { error: updErr } = await supabase
        .from('attribution_events')
        .update({
          reverted_at: new Date().toISOString(),
          reverted_by: auth.userId ?? null,
          reverted_reason: body.action === 'accept_legacy' ? 'coordinator: legacy source wins' : 'coordinator: reverted',
        })
        .eq('id', r.id)
      if (updErr) return NextResponse.json({ error: updErr.message }, { status: 500 })
    }

    // Clear conflict flags on sibling live rows for the same wedding —
    // accepting legacy ends the conflict for the wedding entirely.
    if (body.action === 'accept_legacy') {
      await supabase
        .from('attribution_events')
        .update({ conflict_with_legacy_source: null })
        .eq('wedding_id', r.wedding_id)
        .is('reverted_at', null)
    }

    const ft = await recomputeFirstTouch(supabase, r.wedding_id)
    if (ft.error) return NextResponse.json({ error: ft.error }, { status: 500 })
    return NextResponse.json({ ok: true })
  }

  if (body.action === 'accept_computed') {
    const computed = normalizeSource(r.source_platform)
    const { error: wedErr } = await supabase
      .from('weddings')
      .update({ source: computed })
      .eq('id', r.wedding_id)
    if (wedErr) return NextResponse.json({ error: wedErr.message }, { status: 500 })

    // Clear conflict flag on every live attribution row for this
    // wedding — coordinator's decision applies to all sources, not
    // just this one row.
    await supabase
      .from('attribution_events')
      .update({ conflict_with_legacy_source: null })
      .eq('wedding_id', r.wedding_id)
      .is('reverted_at', null)

    return NextResponse.json({ ok: true, new_source: computed })
  }

  return NextResponse.json({ error: 'unknown action' }, { status: 400 })
}
