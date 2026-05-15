/**
 * Ghost resurrection.
 *
 * Anchor: IDENTITY-FIRST-ARCHITECTURE.md §9 ("Resurrection dispute
 * flow"). A Ghost couple is one past the decay window. When a fresh
 * high-tier signal lands on a Ghost, that's a resurrection: the couple
 * came back. We restore them to 'resolved' and record the event.
 *
 * The dispute affordance (§9): the operator can later say "that
 * wasn't them" (recycled email, different couple same name, phone
 * reassigned). A rejected resurrection flips the couple back to
 * 'ghost' and blacklists the triggering identifier for that couple,
 * so the same identifier never re-resurrects the same Ghost (§9
 * Don't skip #3).
 *
 * What counts as a resurrection
 * -----------------------------
 * Only a high-tier match. Medium / low matches go to the candidate
 * review queue as normal; they don't silently un-Ghost a couple.
 * Booked couples never decay so they're never Ghosts; agents are a
 * separate class. So the resurrection check only ever fires for a
 * couple whose lifecycle_state is currently 'ghost'.
 */

import type { SupabaseClient } from '@supabase/supabase-js'
import { normalizeEmail, normalizePhone } from './resolver'
import type { NormalizedSignal } from './sources/types'

export interface ResurrectionResult {
  resurrected: boolean
  blocked_by_blacklist: boolean
}

/**
 * Pull the identifiers a signal carries, normalised, for blacklist
 * lookup. Email + phone only — those are the recyclable identifiers
 * §9 calls out.
 */
function signalIdentifiers(
  signal: NormalizedSignal,
): Array<{ value: string; kind: 'email' | 'phone' }> {
  const out: Array<{ value: string; kind: 'email' | 'phone' }> = []
  for (const e of [signal.primary_email, signal.partner_email]) {
    const n = normalizeEmail(e)
    if (n) out.push({ value: n, kind: 'email' })
  }
  for (const p of [signal.primary_phone, signal.partner_phone]) {
    const n = normalizePhone(p)
    if (n) out.push({ value: n, kind: 'phone' })
  }
  return out
}

/**
 * Called after a high-tier touchpoint attaches to a couple. If the
 * couple is a Ghost, resurrect it — unless one of the signal's
 * identifiers is blacklisted against this couple, in which case the
 * attach stands but the lifecycle flip is suppressed.
 *
 * Fire-and-forget safe: never throws. Returns a flag the caller can
 * fold into telemetry.
 */
export async function maybeResurrectGhost(args: {
  supabase: SupabaseClient
  venueId: string
  coupleId: string
  signal: NormalizedSignal
}): Promise<ResurrectionResult> {
  const { supabase, venueId, coupleId, signal } = args
  try {
    const { data: couple } = await supabase
      .from('couples')
      .select('id, lifecycle_state')
      .eq('id', coupleId)
      .maybeSingle()
    const state = (couple as { lifecycle_state: string } | null)?.lifecycle_state
    if (state !== 'ghost') {
      return { resurrected: false, blocked_by_blacklist: false }
    }

    // Blacklist check: has any identifier on this signal been
    // disputed for this couple before?
    const identifiers = signalIdentifiers(signal)
    if (identifiers.length > 0) {
      const { data: blocked } = await supabase
        .from('resurrection_blacklist')
        .select('identifier')
        .eq('venue_id', venueId)
        .eq('couple_id', coupleId)
        .in(
          'identifier',
          identifiers.map((i) => i.value),
        )
        .limit(1)
      if (((blocked ?? []) as unknown[]).length > 0) {
        return { resurrected: false, blocked_by_blacklist: true }
      }
    }

    // Resurrect. ghost -> resolved. The progression-event writer in
    // route-by-tier already bumped last_progression_at, so the
    // couple won't immediately re-decay.
    await supabase
      .from('couples')
      .update({ lifecycle_state: 'resolved' })
      .eq('id', coupleId)
      .eq('lifecycle_state', 'ghost')

    await supabase.from('couple_merge_events').insert({
      venue_id: venueId,
      event_type: 'resurrection',
      primary_couple_id: coupleId,
      rule_triggered: `linker_high_tier:${signal.channel}:${signal.external_id}`,
      reason: `Ghost resurrected by high-tier ${signal.channel} ${signal.action_type}`,
    })

    return { resurrected: true, blocked_by_blacklist: false }
  } catch {
    // Resurrection telemetry is best-effort; the touchpoint attach
    // (the load-bearing write) already succeeded upstream.
    return { resurrected: false, blocked_by_blacklist: false }
  }
}

/**
 * Operator disputes a resurrection. Flips the couple back to 'ghost',
 * blacklists every identifier the operator names, and records a
 * resurrection_rejected audit event.
 */
export async function rejectResurrection(args: {
  supabase: SupabaseClient
  venueId: string
  coupleId: string
  identifiers: Array<{ value: string; kind: 'email' | 'phone' | 'other' }>
  reason: string
  operatorId: string | null
}): Promise<{ ok: boolean }> {
  const { supabase, venueId, coupleId, identifiers, reason, operatorId } = args
  try {
    // Flip back to ghost.
    await supabase
      .from('couples')
      .update({ lifecycle_state: 'ghost' })
      .eq('id', coupleId)
      .eq('venue_id', venueId)
      .in('lifecycle_state', ['resolved', 'channel_scoped'])

    // Blacklist each identifier. ON CONFLICT DO NOTHING via the
    // unique index — re-rejecting the same triple is a no-op.
    for (const id of identifiers) {
      if (!id.value) continue
      await supabase
        .from('resurrection_blacklist')
        .insert({
          venue_id: venueId,
          couple_id: coupleId,
          identifier: id.value,
          identifier_kind: id.kind,
          reason,
          operator_id: operatorId,
        })
        .then(
          () => undefined,
          () => undefined,
        )
    }

    await supabase.from('couple_merge_events').insert({
      venue_id: venueId,
      event_type: 'resurrection_rejected',
      primary_couple_id: coupleId,
      operator_id: operatorId,
      reason,
    })

    return { ok: true }
  } catch {
    return { ok: false }
  }
}
