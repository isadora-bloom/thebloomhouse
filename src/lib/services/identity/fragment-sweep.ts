/**
 * Fragment sweep — promote the pre-identity pool onto a couple.
 *
 * Wave 3 (HANDLE-IDENTITY-SPEC.md §2, last bullet). When a signal
 * attaches to or mints a couple and carries handles, every unpromoted
 * fragment in the venue with the same `(platform, handle)` belongs to
 * that couple. Same platform, same normalised handle, no judge, no
 * score. That is the whole rule.
 *
 * This replaces the old "new person, check the signal pool" scan in
 * `identity/enqueue.ts`, which walked `tangential_signals` and matched
 * on first name, because fragments are where the pool lives now.
 *
 * Ownership note (2026-09-09): W22 owns this module in wave 3 and its
 * linker calls it inline on every handle-carrying attach. W24 wrote
 * this copy against the agreed signature
 * `sweepFragmentsForCouple(supabase, venueId, coupleId)` so its own
 * caller compiles. If both land, take W22's implementation; the
 * signature is the contract.
 *
 * Writer discipline: the touchpoint insert goes through
 * `insertTouchpoint` in `tracer.ts`, which is the cascade chokepoint
 * for touchpoints. Nothing here inserts a guarded table directly.
 */

import type { SupabaseClient } from '@supabase/supabase-js'
import { handlesIntersect } from './handles'
import { insertTouchpoint } from './tracer'
import type { HandlePlatform, NormalizedSignal } from './sources/types'

export interface FragmentSweepResult {
  /** Unpromoted fragments in the venue that carried any handle. */
  examined: number
  /** Fragments promoted onto the couple by an exact handle match. */
  promoted: number
  /** Touchpoints written as part of the promotion. */
  touchpointsWritten: number
  errors: string[]
}

interface FragmentRow {
  id: string
  channel: string
  external_id: string
  identity_hint: string | null
  occurred_at: string
  raw_payload: Record<string, unknown> | null
  handles: Partial<Record<HandlePlatform, string>> | null
}

/** A fragment carries everything a touchpoint needs except the couple. */
function fragmentToSignal(f: FragmentRow): NormalizedSignal {
  return {
    external_id: f.external_id,
    channel: f.channel,
    action_type:
      typeof f.raw_payload?.action_type === 'string'
        ? (f.raw_payload.action_type as string)
        : 'fragment_promoted',
    occurred_at: f.occurred_at,
    signal_tier: 'low',
    identity_hint: f.identity_hint,
    handles: f.handles ?? null,
    raw_payload: {
      ...(f.raw_payload ?? {}),
      promoted_from_fragment_id: f.id,
      promotion_rule: 'handle_exact',
    },
  }
}

/**
 * Promote every unpromoted fragment in the venue that shares a
 * platform handle with this couple. Idempotent: a fragment already
 * carrying `promoted_to_couple_id` is skipped, and the touchpoint
 * insert is a no-op on the existing (venue, channel, external_id).
 */
export async function sweepFragmentsForCouple(
  supabase: SupabaseClient,
  venueId: string,
  coupleId: string,
): Promise<FragmentSweepResult> {
  const out: FragmentSweepResult = {
    examined: 0,
    promoted: 0,
    touchpointsWritten: 0,
    errors: [],
  }

  const { data: couple, error: coupleErr } = await supabase
    .from('couples')
    .select('id, handles')
    .eq('id', coupleId)
    .maybeSingle()
  if (coupleErr) {
    out.errors.push(`couple read: ${coupleErr.message}`)
    return out
  }
  const coupleHandles = (couple?.handles ?? null) as Partial<Record<HandlePlatform, string>> | null
  if (!coupleHandles || Object.keys(coupleHandles).length === 0) return out

  const { data: frags, error: fragErr } = await supabase
    .from('fragments')
    .select('id, channel, external_id, identity_hint, occurred_at, raw_payload, handles')
    .eq('venue_id', venueId)
    .is('promoted_to_couple_id', null)
  if (fragErr) {
    out.errors.push(`fragments read: ${fragErr.message}`)
    return out
  }

  for (const raw of (frags ?? []) as FragmentRow[]) {
    const fragHandles = (raw.handles ?? null) as Partial<Record<HandlePlatform, string>> | null
    if (!fragHandles || Object.keys(fragHandles).length === 0) continue
    out.examined++
    const platform = handlesIntersect(coupleHandles, fragHandles)
    if (!platform) continue

    const tp = await insertTouchpoint(supabase, venueId, coupleId, fragmentToSignal(raw))
    if (tp.inserted) out.touchpointsWritten++

    const { error: updErr } = await supabase
      .from('fragments')
      .update({
        promoted_to_couple_id: coupleId,
        promoted_at: new Date().toISOString(),
      })
      .eq('id', raw.id)
      .is('promoted_to_couple_id', null)
    if (updErr) {
      out.errors.push(`fragment ${raw.id}: ${updErr.message}`)
      continue
    }
    out.promoted++
  }

  return out
}
