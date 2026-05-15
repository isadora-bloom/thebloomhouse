/**
 * POST /api/admin/identity/unmerge
 *
 * Operator splits touchpoints off a couple. Anchor:
 * IDENTITY-FIRST-ARCHITECTURE.md §9 ("An identity system without
 * unmerge is a one-way door to corruption. Unmerge is first-class.").
 *
 * Flow (§9 build):
 *   operator selects touchpoints belonging to a different couple,
 *   then chooses a destination for them:
 *     new_couple       — mint a fresh couple, move the touchpoints
 *     existing_couple  — move the touchpoints under target_couple_id
 *     fragment         — demote each touchpoint to a fragment
 *   A free-text reason is REQUIRED (§9 Don't skip #2 — the reasons
 *   feed the calibration loop). The split writes a couple_merge_events
 *   row with event_type='manual_unmerge'.
 *
 * Body
 * ----
 *   {
 *     couple_id: string,            // the couple being split FROM
 *     touchpoint_ids: string[],     // touchpoints to move off it
 *     destination: 'new_couple' | 'existing_couple' | 'fragment',
 *     target_couple_id?: string,    // required when destination=existing_couple
 *     reason: string                // required, non-empty
 *   }
 *
 * Returns
 * -------
 *   200 { ok, moved, destination, new_couple_id? }
 *   400 invalid input | 401/403 auth | 404 couple not found
 */

import { NextRequest, NextResponse } from 'next/server'
import { getPlatformAuth } from '@/lib/api/auth-helpers'
import { createServiceClient } from '@/lib/supabase/service'
import { invalidateCouplesCache } from '@/lib/services/identity/forwards-linker'

interface UnmergeBody {
  couple_id?: string
  touchpoint_ids?: string[]
  destination?: 'new_couple' | 'existing_couple' | 'fragment'
  target_couple_id?: string
  reason?: string
}

export async function POST(req: NextRequest): Promise<NextResponse> {
  const auth = await getPlatformAuth()
  if (!auth) return NextResponse.json({ error: 'unauthorized' }, { status: 401 })

  const body = (await req.json().catch(() => ({}))) as UnmergeBody
  if (
    !body.couple_id ||
    !Array.isArray(body.touchpoint_ids) ||
    body.touchpoint_ids.length === 0 ||
    !body.destination
  ) {
    return NextResponse.json(
      { error: 'couple_id, touchpoint_ids[], destination required' },
      { status: 400 },
    )
  }
  if (!body.reason || body.reason.trim().length === 0) {
    // §9 Don't skip #2 — reason is required.
    return NextResponse.json(
      { error: 'reason is required for an unmerge' },
      { status: 400 },
    )
  }
  if (body.destination === 'existing_couple' && !body.target_couple_id) {
    return NextResponse.json(
      { error: 'target_couple_id required when destination=existing_couple' },
      { status: 400 },
    )
  }

  const supabase = createServiceClient()

  // Source couple + scope check.
  const { data: source, error: srcErr } = await supabase
    .from('couples')
    .select('id, venue_id, primary_contact_name')
    .eq('id', body.couple_id)
    .maybeSingle()
  if (srcErr || !source) {
    return NextResponse.json({ error: 'couple_not_found' }, { status: 404 })
  }
  const src = source as {
    id: string
    venue_id: string
    primary_contact_name: string | null
  }

  const role = (auth.role ?? 'coordinator') as string
  const isSuperOrOrg =
    auth.isDemo || role === 'super_admin' || role === 'org_admin'
  if (!isSuperOrOrg && src.venue_id !== auth.venueId) {
    return NextResponse.json({ error: 'forbidden' }, { status: 403 })
  }

  // Load the selected touchpoints — must all belong to the source
  // couple + venue. Anything that doesn't is rejected so an operator
  // can't move another couple's touchpoints by id-guessing.
  const { data: tps, error: tpErr } = await supabase
    .from('touchpoints')
    .select('id, channel, signal_tier, action_type, external_id, occurred_at, raw_payload, couple_id')
    .eq('venue_id', src.venue_id)
    .in('id', body.touchpoint_ids)
  if (tpErr) {
    return NextResponse.json(
      { error: 'touchpoint_lookup_failed', detail: tpErr.message },
      { status: 500 },
    )
  }
  const touchpoints = (tps ?? []) as Array<{
    id: string
    channel: string
    signal_tier: string
    action_type: string
    external_id: string
    occurred_at: string
    raw_payload: Record<string, unknown> | null
    couple_id: string | null
  }>
  const mismatched = touchpoints.filter((t) => t.couple_id !== body.couple_id)
  if (mismatched.length > 0 || touchpoints.length !== body.touchpoint_ids.length) {
    return NextResponse.json(
      {
        error:
          'every touchpoint_id must currently belong to couple_id; refusing partial / cross-couple split',
      },
      { status: 400 },
    )
  }

  let moved = 0
  let newCoupleId: string | null = null

  if (body.destination === 'new_couple') {
    // Derive a name from the touchpoints' raw_payload. Fall back to a
    // marker so primary_contact_name (NOT NULL) is satisfied.
    const derivedName =
      touchpoints
        .map(
          (t) =>
            (t.raw_payload as Record<string, unknown> | null)?.primary_name as
              | string
              | undefined,
        )
        .find((n) => n && n.trim().length > 0) ??
      `(Split from ${src.primary_contact_name ?? body.couple_id.slice(0, 8)})`
    const { data: created, error: createErr } = await supabase
      .from('couples')
      .insert({
        venue_id: src.venue_id,
        primary_contact_name: derivedName,
        lifecycle_state: 'channel_scoped',
        channel_scope: touchpoints[0]?.channel ?? null,
      })
      .select('id')
      .single()
    if (createErr || !created) {
      return NextResponse.json(
        { error: 'new_couple_create_failed', detail: createErr?.message },
        { status: 500 },
      )
    }
    newCoupleId = (created as { id: string }).id
    const { error: moveErr, count } = await supabase
      .from('touchpoints')
      .update({ couple_id: newCoupleId }, { count: 'exact' })
      .in('id', body.touchpoint_ids)
    if (moveErr) {
      return NextResponse.json(
        { error: 'move_failed', detail: moveErr.message },
        { status: 500 },
      )
    }
    moved = count ?? body.touchpoint_ids.length
  } else if (body.destination === 'existing_couple') {
    // Verify target couple is in the same venue.
    const { data: target } = await supabase
      .from('couples')
      .select('id, venue_id')
      .eq('id', body.target_couple_id!)
      .maybeSingle()
    if (!target || (target as { venue_id: string }).venue_id !== src.venue_id) {
      return NextResponse.json(
        { error: 'target_couple not found in this venue' },
        { status: 400 },
      )
    }
    const { error: moveErr, count } = await supabase
      .from('touchpoints')
      .update({ couple_id: body.target_couple_id! }, { count: 'exact' })
      .in('id', body.touchpoint_ids)
    if (moveErr) {
      return NextResponse.json(
        { error: 'move_failed', detail: moveErr.message },
        { status: 500 },
      )
    }
    moved = count ?? body.touchpoint_ids.length
  } else {
    // destination = 'fragment'. Demote each touchpoint: mirror it into
    // fragments, then delete the touchpoint. fragments has its own
    // UNIQUE(venue_id, channel, external_id); a 23505 means a fragment
    // already exists for that key, which is fine — we still drop the
    // touchpoint.
    for (const t of touchpoints) {
      await supabase
        .from('fragments')
        .insert({
          venue_id: src.venue_id,
          channel: t.channel,
          identity_hint:
            ((t.raw_payload as Record<string, unknown> | null)?.identity_hint as
              | string
              | undefined) ?? null,
          external_id: t.external_id,
          occurred_at: t.occurred_at,
          raw_payload: t.raw_payload,
        })
        .then(
          () => undefined,
          () => undefined,
        )
      const { error: delErr } = await supabase
        .from('touchpoints')
        .delete()
        .eq('id', t.id)
        .eq('venue_id', src.venue_id)
      if (!delErr) moved += 1
    }
  }

  // Audit trail. §9: manual_unmerge with the required reason.
  await supabase.from('couple_merge_events').insert({
    venue_id: src.venue_id,
    event_type: 'manual_unmerge',
    primary_couple_id: src.id,
    secondary_couple_id: newCoupleId ?? body.target_couple_id ?? null,
    operator_id: auth.userId ?? null,
    rule_triggered: `unmerge:${body.destination}:${moved}_touchpoints`,
    reason: body.reason.trim(),
  })

  invalidateCouplesCache(src.venue_id)

  return NextResponse.json({
    ok: true,
    moved,
    destination: body.destination,
    new_couple_id: newCoupleId,
  })
}
