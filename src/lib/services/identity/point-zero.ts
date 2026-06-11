/**
 * D4 Point-Zero + write-time touchpoint direction (migration 381).
 *
 * Anchor: CANONICAL-RECONCILIATION-SPECS.md D4 + D5 / Canonical Product
 * Definition v1.0 §3.3 + §5 / CONSOLIDATION-PLAN-PHASED.md v2.1 §1.8.
 *
 * Point-Zero is the first event at which a couple is known by BOTH a name
 * AND a reachable identifier (email or phone — direct or relay; a handle
 * alone does not qualify). It is mid-funnel: NOT the booked wedding (the
 * Tier-8 redefinition is retired) and NOT first contact. `point_zero_at`
 * is set once and immutable after first set.
 *
 * `stampTouchpointAndPointZero` is called by the forwards-linker after a
 * touchpoint lands on a couple (attach or mint). It:
 *   1. establishes point_zero_at when the couple has none and this signal
 *      qualifies (set-once, race-safe via the IS NULL filter);
 *   2. on establishment, re-stamps the couple's earlier touchpoints
 *      'pre_zero' (the fragment-era history);
 *   3. stamps THIS touchpoint's zero_phase relative to point_zero_at
 *      (the establishing touchpoint itself is post_zero — it is the first
 *      known-couple signal; everything before it is discovery), and its
 *      direction (write-time, per the D5 ban on read-time inference).
 *
 * Best-effort by contract: this function NEVER throws. The legacy write
 * and the attach already succeeded by the time it runs; a stamping
 * failure is logged (writeOrLog / logEvent) and must not poison the
 * pipeline. Phase-2's chronological replay re-derives everything from
 * scratch, so interim gaps self-heal at the wipe.
 */

import type { SupabaseClient } from '@supabase/supabase-js'
import { writeOrLog } from '@/lib/db/write-or-log'
import { logEvent } from '@/lib/observability/logger'
import type { NormalizedSignal } from './sources/types'

/** Venue-side action types — the same exclusion set the progression
 * writer uses (progression.ts) plus the SMS builder's explicit outbound. */
const OUTBOUND_ACTION_TYPES = new Set([
  'venue_sent',
  'outbound',
  'auto_send',
  'sms_outbound',
])

/**
 * Write-time direction for a signal. Explicit `raw_payload.direction`
 * wins; else the outbound action-type list; else inbound (couple-side
 * is the default for every ingestion channel — venue-side paths all
 * stamp themselves explicitly).
 */
export function signalDirection(signal: NormalizedSignal): 'inbound' | 'outbound' {
  const raw =
    typeof signal.raw_payload?.direction === 'string'
      ? (signal.raw_payload.direction as string).toLowerCase()
      : null
  if (raw === 'inbound' || raw === 'outbound') return raw
  if (OUTBOUND_ACTION_TYPES.has(signal.action_type.toLowerCase())) return 'outbound'
  return 'inbound'
}

/**
 * D4 establishment rule: a name (primary or extracted partner name)
 * AND a reachable identifier (email or phone — direct or relay both
 * qualify; an Instagram handle alone does not).
 */
export function signalQualifiesForPointZero(signal: NormalizedSignal): boolean {
  const hasName = Boolean(
    (signal.primary_name ?? '').trim() || (signal.partner_name ?? '').trim(),
  )
  if (!hasName) return false
  const hasReachable = Boolean(
    (signal.primary_email ?? '').trim() ||
      (signal.partner_email ?? '').trim() ||
      (signal.primary_phone ?? '').trim() ||
      (signal.partner_phone ?? '').trim(),
  )
  return hasReachable
}

export interface StampArgs {
  supabase: SupabaseClient
  venueId: string
  coupleId: string
  touchpointId: string
  signal: NormalizedSignal
}

export interface StampResult {
  established: boolean
  zeroPhase: 'pre_zero' | 'post_zero' | null
  direction: 'inbound' | 'outbound'
}

/**
 * Stamp the touchpoint (direction + zero_phase) and establish the
 * couple's Point-Zero when this signal qualifies. Never throws.
 */
export async function stampTouchpointAndPointZero(
  args: StampArgs,
): Promise<StampResult> {
  const { supabase, venueId, coupleId, touchpointId, signal } = args
  const direction = signalDirection(signal)
  const result: StampResult = { established: false, zeroPhase: null, direction }

  try {
    // Current point_zero state (single indexed read).
    const { data: couple, error: readErr } = await supabase
      .from('couples')
      .select('point_zero_at')
      .eq('id', coupleId)
      .eq('venue_id', venueId)
      .maybeSingle()
    if (readErr) {
      logEvent({
        level: 'warn',
        msg: 'point_zero.read_failed',
        data: { venue_id: venueId, couple_id: coupleId, error: readErr.message },
      })
      return result
    }

    let pointZeroAt: string | null =
      (couple as { point_zero_at: string | null } | null)?.point_zero_at ?? null

    // Establish: set-once, race-safe via the IS NULL filter. Only
    // couple-side inbound signals can establish Point-Zero (a venue
    // outbound proves the venue knows the address, not that the couple
    // surfaced an identity).
    if (
      pointZeroAt === null &&
      direction === 'inbound' &&
      signalQualifiesForPointZero(signal)
    ) {
      const { data: updated } = await supabase
        .from('couples')
        .update({
          point_zero_at: signal.occurred_at,
          point_zero_touchpoint_id: touchpointId,
        })
        .eq('id', coupleId)
        .eq('venue_id', venueId)
        .is('point_zero_at', null)
        .select('id')
      if (updated && (updated as unknown[]).length > 0) {
        result.established = true
        pointZeroAt = signal.occurred_at
        // Re-stamp the couple's earlier touchpoints as pre_zero (the
        // fragment-era / pre-identity history is discovery).
        await writeOrLog(
          supabase
            .from('touchpoints')
            .update({ zero_phase: 'pre_zero' })
            .eq('couple_id', coupleId)
            .eq('venue_id', venueId)
            .lt('occurred_at', signal.occurred_at)
            .neq('id', touchpointId),
          { op: 'touchpoints.pre_zero_restamp', venueId },
        )
      } else {
        // Lost a set-once race — re-read so this touchpoint still gets
        // the right phase relative to the winner's point_zero_at.
        const { data: again } = await supabase
          .from('couples')
          .select('point_zero_at')
          .eq('id', coupleId)
          .eq('venue_id', venueId)
          .maybeSingle()
        pointZeroAt =
          (again as { point_zero_at: string | null } | null)?.point_zero_at ?? null
      }
    }

    // Phase for THIS touchpoint. No point-zero (couple known by name/handle
    // only) → still pre_zero territory. The establishing touchpoint itself
    // is post_zero (occurred_at === point_zero_at is not <).
    const zeroPhase: 'pre_zero' | 'post_zero' =
      pointZeroAt === null || Date.parse(signal.occurred_at) < Date.parse(pointZeroAt)
        ? 'pre_zero'
        : 'post_zero'
    result.zeroPhase = zeroPhase

    await writeOrLog(
      supabase
        .from('touchpoints')
        .update({ direction, zero_phase: zeroPhase })
        .eq('id', touchpointId)
        .eq('venue_id', venueId),
      { op: 'touchpoints.direction_zero_phase_stamp', venueId },
    )
    return result
  } catch (err) {
    logEvent({
      level: 'warn',
      msg: 'point_zero.stamp_failed',
      data: {
        venue_id: venueId,
        couple_id: coupleId,
        touchpoint_id: touchpointId,
        error: err instanceof Error ? err.message : String(err),
      },
    })
    return result
  }
}
