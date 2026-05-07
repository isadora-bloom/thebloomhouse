import { NextRequest, NextResponse } from 'next/server'
import { getPlatformAuth } from '@/lib/api/auth-helpers'
import { createServiceClient } from '@/lib/supabase/service'
import { recomputeFirstTouch } from '@/lib/services/identity/candidate-resolver'
import { recalculateHeatScore } from '@/lib/services/heat-mapping'
import { normalizeSource } from '@/lib/services/normalize-source'
import { requirePlan, planErrorBody } from '@/lib/auth/require-plan'

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
  // GAP-12: API-layer plan_tier enforcement BEFORE any DB reads.
  const plan = await requirePlan(req, 'pre_opening')
  if (!plan.ok) return NextResponse.json(planErrorBody(plan), { status: plan.status })

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
  // Org admins + super admins operate across every venue in their
  // org. Coordinators are venue-scoped. Mirrors post-tour-brief.
  const isAdmin = auth.role === 'org_admin' || auth.role === 'super_admin'
  if (!isAdmin && c.venue_id !== auth.venueId) {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
  }
  if (isAdmin && auth.orgId) {
    const { data: candVenue } = await supabase
      .from('venues')
      .select('org_id')
      .eq('id', c.venue_id)
      .single()
    if ((candVenue as { org_id: string | null } | null)?.org_id !== auth.orgId) {
      return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
    }
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
  // Wedding must be in the same venue as the candidate (same row
  // already venue-checked above) — protects against linking a
  // candidate from venue X to a wedding in venue Y even if both
  // belong to the same org.
  if (w.venue_id !== c.venue_id) {
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
        // T5-Rixey-BBB: attribution_events rows are source-class
        // anchors — they exist precisely to mark a discovery touch.
        // signal-class-justified: attribution_events represent source-class discovery
        signal_class: 'source',
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

  // Connective tissue (gap D — 2026-04-30): a manual link is the
  // strongest possible attribution signal (coordinator confirmed),
  // so the wedding's heat should reflect it immediately. Without
  // this, the link is invisible in the inbox heat ranking until
  // the next engagement event or daily decay sweep.
  try {
    await recalculateHeatScore(c.venue_id, w.id)
  } catch (err) {
    console.warn('[candidate link] heat recalc failed:', err)
  }

  return NextResponse.json({ ok: true, attributions_written: rows.length })
}
