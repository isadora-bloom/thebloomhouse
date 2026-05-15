/**
 * POST /api/admin/identity/resolve
 *
 * Operator action on a candidate_match. Three outcomes:
 *
 *   action='confirm'   the two records ARE the same identity. We
 *                      flip the candidate's resolution to 'confirmed'
 *                      and cascade: a fragment becomes promoted_to_couple_id,
 *                      an orphan touchpoint gets re-parented to the
 *                      matched couple.
 *
 *   action='reject'    the records are NOT the same. Flip resolution
 *                      to 'rejected'; leave fragment / orphan touchpoint
 *                      where they are. The matcher won't re-propose the
 *                      same pair within the dedup window.
 *
 *   action='defer'     skip for now; flip resolution to 'deferred' so
 *                      the row drops out of the queue but stays
 *                      queryable.
 *
 * Anchor: IDENTITY-FIRST-ARCHITECTURE.md §4 (operator-confirmed
 * candidate matches collapse fragments into the couples graph) and
 * Appendix B stop #5 (a confirmed match must visibly update the
 * journey ribbon).
 *
 * Body
 * ----
 *   { match_id: string, action: 'confirm' | 'reject' | 'defer',
 *     note?: string }
 *
 * Returns
 * -------
 *   200 { ok: true, cascaded: { touchpoints_reparented, fragments_promoted } }
 *   400 invalid input
 *   401 / 403 auth
 *   404 match not found / not in caller's venue
 *   500 internal
 */

import { NextRequest, NextResponse } from 'next/server'
import { getPlatformAuth } from '@/lib/api/auth-helpers'
import { createServiceClient } from '@/lib/supabase/service'
import { invalidateCouplesCache } from '@/lib/services/identity/forwards-linker'
import { recordFragmentMatchReturned } from '@/lib/services/identity/progression'

interface ResolveBody {
  match_id?: string
  action?: 'confirm' | 'reject' | 'defer'
  note?: string
}

export async function POST(req: NextRequest): Promise<NextResponse> {
  const auth = await getPlatformAuth()
  if (!auth) return NextResponse.json({ error: 'unauthorized' }, { status: 401 })

  const body = (await req.json().catch(() => ({}))) as ResolveBody
  if (!body.match_id || !body.action) {
    return NextResponse.json(
      { error: 'match_id + action required' },
      { status: 400 },
    )
  }
  if (!['confirm', 'reject', 'defer'].includes(body.action)) {
    return NextResponse.json({ error: 'invalid action' }, { status: 400 })
  }

  const supabase = createServiceClient()

  const { data: match, error: matchErr } = await supabase
    .from('candidate_matches')
    .select(
      'id, venue_id, primary_record_id, primary_record_type, secondary_record_id, secondary_record_type, confidence_tier, resolution',
    )
    .eq('id', body.match_id)
    .maybeSingle()
  if (matchErr || !match) {
    return NextResponse.json({ error: 'not_found' }, { status: 404 })
  }
  const m = match as {
    id: string
    venue_id: string
    primary_record_id: string
    primary_record_type: string
    secondary_record_id: string
    secondary_record_type: string
    confidence_tier: string
    resolution: string | null
  }

  const role = (auth.role ?? 'coordinator') as string
  const isSuperOrOrg =
    auth.isDemo || role === 'super_admin' || role === 'org_admin'
  if (!isSuperOrOrg && m.venue_id !== auth.venueId) {
    return NextResponse.json({ error: 'forbidden' }, { status: 403 })
  }

  if (m.resolution) {
    return NextResponse.json(
      { error: 'already_resolved', resolution: m.resolution },
      { status: 409 },
    )
  }

  // candidate_matches.resolution CHECK allows: confirmed / rejected /
  // not_sure. Operator 'defer' maps to 'not_sure' (Doctrine §5 Don't
  // skip #3: not-sure is a first-class option).
  const resolution =
    body.action === 'confirm'
      ? 'confirmed'
      : body.action === 'reject'
        ? 'rejected'
        : 'not_sure'

  // Compute cascade plan. Pattern: one side is 'couple' (the established
  // identity), the other is 'fragment' or 'touchpoint'. We re-parent
  // the latter under the couple.
  let coupleId: string | null = null
  let fragmentId: string | null = null
  let touchpointId: string | null = null
  if (m.primary_record_type === 'couple') coupleId = m.primary_record_id
  if (m.secondary_record_type === 'couple') coupleId = m.secondary_record_id
  if (m.primary_record_type === 'fragment') fragmentId = m.primary_record_id
  if (m.secondary_record_type === 'fragment') fragmentId = m.secondary_record_id
  if (m.primary_record_type === 'touchpoint') touchpointId = m.primary_record_id
  if (m.secondary_record_type === 'touchpoint') touchpointId = m.secondary_record_id

  const cascaded = { touchpoints_reparented: 0, fragments_promoted: 0 }

  if (resolution === 'confirmed' && coupleId) {
    // 1. Re-parent orphan touchpoint, if present. confidence_tier
    //    CHECK only permits high/medium/low — an operator confirm is
    //    the strongest signal there is, so 'high'.
    if (touchpointId) {
      const { error } = await supabase
        .from('touchpoints')
        .update({ couple_id: coupleId, confidence_tier: 'high' })
        .eq('id', touchpointId)
        .eq('venue_id', m.venue_id)
      if (!error) cascaded.touchpoints_reparented += 1
    }
    // 2. Promote fragment to couple.
    if (fragmentId) {
      const { error } = await supabase
        .from('fragments')
        .update({ promoted_to_couple_id: coupleId })
        .eq('id', fragmentId)
        .eq('venue_id', m.venue_id)
      if (!error) cascaded.fragments_promoted += 1
    }
  }

  // 3. Update the candidate_matches row. There's no operator_note
  //    column on the schema; append the note to matcher_reason instead
  //    so the calibration loop sees it.
  const updatePayload: Record<string, unknown> = {
    resolution,
    resolved_at: new Date().toISOString(),
    resolved_by_user_id: auth.userId ?? null,
  }
  if (body.note) {
    const { data: existing } = await supabase
      .from('candidate_matches')
      .select('matcher_reason')
      .eq('id', m.id)
      .maybeSingle()
    const prior = (existing as { matcher_reason: string | null } | null)
      ?.matcher_reason ?? ''
    updatePayload.matcher_reason = `${prior} | operator: ${body.note}`.slice(0, 2000)
  }
  await supabase
    .from('candidate_matches')
    .update(updatePayload)
    .eq('id', m.id)

  // 4. Audit trail via couple_merge_events. The table keys on
  //    primary_couple_id / secondary_couple_id and a required
  //    event_type enum (migration 346) — there is no couple_id
  //    column. candidate_confirmed / candidate_rejected are the two
  //    enum values that fit an operator resolution.
  if (coupleId && (resolution === 'confirmed' || resolution === 'rejected')) {
    const tierForLog =
      m.confidence_tier === 'high' ||
      m.confidence_tier === 'medium' ||
      m.confidence_tier === 'low'
        ? m.confidence_tier
        : null
    await supabase.from('couple_merge_events').insert({
      venue_id: m.venue_id,
      event_type: resolution === 'confirmed' ? 'candidate_confirmed' : 'candidate_rejected',
      primary_couple_id: coupleId,
      operator_id: auth.userId ?? null,
      rule_triggered: `candidate_match:${m.id}`,
      confidence_tier: tierForLog,
      reason: body.note
        ? `operator ${resolution}: ${body.note}`
        : `operator ${resolution} of ${m.confidence_tier} candidate_match`,
    })
  }

  // 5. The operator confirming a candidate IS a progression event
  //    (§3 enumeration: 'fragment_match_returned'). The clock bumps so
  //    a resurrected couple doesn't immediately re-decay.
  if (resolution === 'confirmed' && coupleId) {
    await recordFragmentMatchReturned({
      supabase,
      coupleId,
      touchpointId: touchpointId,
    })
  }

  // 5. Invalidate the per-venue couples cache so the next linker call
  //    sees the new attach.
  invalidateCouplesCache(m.venue_id)

  return NextResponse.json({
    ok: true,
    resolution,
    cascaded,
  })
}
