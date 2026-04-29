import { NextRequest, NextResponse } from 'next/server'
import { getPlatformAuth } from '@/lib/api/auth-helpers'
import { createServiceClient } from '@/lib/supabase/service'
import { recomputeFirstTouch } from '@/lib/services/candidate-resolver'
import { normalizeSource } from '@/lib/services/normalize-source'

/**
 * Manual candidate-to-wedding link from the coordinator review queue
 * (Phase B / PB.12 fix #4).
 *
 *   POST /api/intel/candidates/link
 *     Body: { candidate_identity_id, wedding_id }
 *
 * Writes attribution_events (tier=tier_2_coordinator, decided_by=coordinator)
 * for every signal attached to the candidate, marks the candidate
 * resolved, and recomputes first-touch on the wedding.
 *
 * Idempotent — if the candidate is already resolved to the same
 * wedding, returns ok without writing duplicates.
 */

interface Body {
  candidate_identity_id: string
  wedding_id: string
}

export async function POST(req: NextRequest) {
  const auth = await getPlatformAuth()
  if (!auth) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  let body: Body
  try {
    body = await req.json()
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 })
  }
  if (!body.candidate_identity_id || !body.wedding_id) {
    return NextResponse.json({ error: 'candidate_identity_id and wedding_id required' }, { status: 400 })
  }

  const supabase = createServiceClient()

  const { data: cand, error: candErr } = await supabase
    .from('candidate_identities')
    .select('id, venue_id, source_platform, resolved_wedding_id')
    .eq('id', body.candidate_identity_id)
    .single()
  if (candErr || !cand) {
    return NextResponse.json({ error: 'candidate not found' }, { status: 404 })
  }
  const c = cand as { id: string; venue_id: string; source_platform: string; resolved_wedding_id: string | null }
  if (c.venue_id !== auth.venueId) {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
  }
  if (c.resolved_wedding_id === body.wedding_id) {
    return NextResponse.json({ ok: true, already_linked: true })
  }

  const { data: wed, error: wedErr } = await supabase
    .from('weddings')
    .select('id, venue_id, source, inquiry_date')
    .eq('id', body.wedding_id)
    .single()
  if (wedErr || !wed) {
    return NextResponse.json({ error: 'wedding not found' }, { status: 404 })
  }
  const w = wed as { id: string; venue_id: string; source: string | null; inquiry_date: string | null }
  if (w.venue_id !== auth.venueId) {
    return NextResponse.json({ error: 'Forbidden (wedding venue mismatch)' }, { status: 403 })
  }

  // Pull all signals attached to this candidate.
  const { data: sigs } = await supabase
    .from('tangential_signals')
    .select('id, signal_date, source_platform')
    .eq('candidate_identity_id', c.id)
    .order('signal_date', { ascending: true })
  const signals = (sigs ?? []) as Array<{ id: string; signal_date: string | null; source_platform: string | null }>
  if (signals.length === 0) {
    return NextResponse.json({ error: 'candidate has no signals to attribute' }, { status: 400 })
  }

  // Conflict detection — same logic the resolver uses.
  const legacyNorm = w.source ? normalizeSource(w.source) : null
  const computedNorm = normalizeSource(c.source_platform)
  const conflictFlag =
    legacyNorm && computedNorm && legacyNorm !== computedNorm && legacyNorm !== 'other' && computedNorm !== 'other'
      ? `legacy=${legacyNorm} computed=${computedNorm}`
      : null

  const inquiryTs = w.inquiry_date ? new Date(w.inquiry_date).getTime() : null
  const rows = signals
    .filter((s) => s.signal_date)
    .map((s) => {
      const sigTs = new Date(s.signal_date!).getTime()
      const bucket = inquiryTs !== null && sigTs >= inquiryTs ? 'nurture' : 'attribution'
      return {
        venue_id: c.venue_id,
        candidate_identity_id: c.id,
        wedding_id: w.id,
        signal_id: s.id,
        source_platform: s.source_platform ?? c.source_platform,
        confidence: 100,
        tier: 'tier_2_coordinator',
        decided_by: 'coordinator',
        reasoning: 'Manually linked from candidate review queue',
        is_first_touch: false,
        bucket,
        conflict_with_legacy_source: bucket === 'attribution' ? conflictFlag : null,
      }
    })

  if (rows.length > 0) {
    const { error: insErr } = await supabase.from('attribution_events').insert(rows)
    if (insErr) return NextResponse.json({ error: insErr.message }, { status: 500 })
  }

  await supabase
    .from('candidate_identities')
    .update({
      resolved_wedding_id: w.id,
      resolved_at: new Date().toISOString(),
      resolved_by: 'coordinator',
      resolved_confidence: 100,
      review_status: 'reviewed',
    })
    .eq('id', c.id)

  const ft = await recomputeFirstTouch(supabase, w.id)
  if (ft.error) return NextResponse.json({ error: ft.error }, { status: 500 })

  return NextResponse.json({ ok: true, attributions_written: rows.length })
}
